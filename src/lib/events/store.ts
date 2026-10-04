import { db } from '../db';
import { deriveAttributes, type EventCategory } from './classify';
import type { Candidate, ScoredEvent, StoredEvent } from './types';

/** Upserts events by dedupe key; search-time prices go to details (events.price_cents is page-verified only). */
export async function storeEvents(cands: Candidate[]): Promise<StoredEvent[]> {
  const stored: StoredEvent[] = [];
  for (const c of cands) {
    const sourceUrl = c.url === c.pageUrl || c.pageKind === 'listing' ? `${c.url}#t=${c.startLocal}` : c.url;
    const details = {
      priceText: c.priceText,
      priceMinCents: c.priceMinCents,
      priceCurrency: c.currency,
      pageUrl: c.pageUrl,
      pageKind: c.pageKind,
      eventUrl: c.url,
      startLocal: c.startLocal,
      hasTime: c.hasTime,
      query: c.query,
    };
    try {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO events (source_url, title, venue, city, starts_at, currency, details, dedupe_key, category, tags, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
         ON CONFLICT (dedupe_key) DO UPDATE SET
           last_seen_at = now(),
           details = events.details || jsonb_strip_nulls(EXCLUDED.details),
           category = CASE WHEN EXCLUDED.category <> 'other' THEN EXCLUDED.category ELSE events.category END,
           tags = (SELECT array_agg(DISTINCT t) FROM unnest(events.tags || EXCLUDED.tags) t)
         RETURNING id`,
        [sourceUrl, c.title, c.venue, c.city, c.startsAt, c.currency, details, c.dedupeKey, c.category, c.tags],
      );
      stored.push({ ...c, id: rows[0].id });
    } catch (err) {
      // Same URL+time already stored under a different key (title spelled differently): reuse that row.
      const { rows } = await db.query<{ id: string }>(`SELECT id FROM events WHERE source_url = $1`, [sourceUrl]);
      if (rows[0]) stored.push({ ...c, id: rows[0].id });
      else console.warn('[events] store failed', c.title, String(err).slice(0, 200));
    }
  }
  return stored;
}

/** Event ids already suggested to this user (any status): the daily run never repeats itself. */
export async function alreadySuggested(userId: string, eventIds: string[]): Promise<Set<string>> {
  if (!eventIds.length) return new Set();
  const { rows } = await db.query<{ event_id: string }>(
    `SELECT event_id FROM suggestions WHERE user_id = $1 AND event_id = ANY($2::uuid[])`,
    [userId, eventIds],
  );
  return new Set(rows.map(r => r.event_id));
}

export async function saveSuggestions(userId: string, events: ScoredEvent[]) {
  const ids: Record<string, string> = {};
  for (const e of events) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO suggestions (user_id, event_id, score, reason, confidence, decision, decision_reason)
       VALUES ($1, $2, $3, $4, $3, $5, $6)
       ON CONFLICT (user_id, event_id) DO UPDATE SET score = EXCLUDED.score, reason = EXCLUDED.reason,
         confidence = EXCLUDED.confidence, decision = EXCLUDED.decision, decision_reason = EXCLUDED.decision_reason
       RETURNING id`,
      [userId, e.id, e.confidence, e.reason, e.decision.action, e.decision.reason],
    );
    ids[e.id] = rows[0].id;
  }
  return ids;
}

/** Fresh stored events for a city/window: lets the chat tool answer from cache before searching again. */
export async function recentEvents(
  city: string,
  from: Date,
  to: Date,
  tz: string,
  opts: { categories?: EventCategory[]; seenWithinHours?: number } = {},
): Promise<StoredEvent[]> {
  const { rows } = await db.query(
    `SELECT id, title, venue, city, starts_at, details, dedupe_key, source_url, category, tags FROM events
     WHERE lower(city) = lower($1) AND starts_at BETWEEN $2 AND $3 AND last_seen_at > now() - make_interval(hours => $4)
       AND ($5::text[] IS NULL OR category = ANY($5))
     ORDER BY starts_at LIMIT 200`,
    [city, from, to, opts.seenWithinHours ?? 24, opts.categories?.length ? opts.categories : null],
  );
  return rows.map(r => ({
    id: r.id,
    title: r.title,
    startsAt: new Date(r.starts_at),
    startLocal: r.details.startLocal ?? '',
    hasTime: r.details.hasTime ?? true,
    venue: r.venue,
    city: r.city,
    url: r.details.eventUrl ?? r.source_url,
    pageUrl: r.details.pageUrl ?? r.source_url,
    pageKind: r.details.pageKind ?? 'listing',
    priceText: r.details.priceText ?? null,
    priceMinCents: r.details.priceMinCents ?? null,
    currency: r.details.priceCurrency ?? null,
    query: r.details.query ?? '',
    dedupeKey: r.dedupe_key,
    category: (r.category ?? 'other') as EventCategory,
    tags: r.tags ?? [],
    attrs: deriveAttributes(
      {
        startsAt: new Date(r.starts_at),
        hasTime: r.details.hasTime ?? true,
        priceMinCents: r.details.priceMinCents ?? null,
        title: r.title,
        tags: r.tags ?? [],
      },
      tz,
    ),
  }));
}

/**
 * Starts a run record. For trigger 'daily' this is also the idempotency claim: returns null if this user
 * already had a daily run on `localDay` (Neon may redeliver a scheduled trigger).
 */
export async function startRun(userId: string, trigger: 'daily' | 'chat' | 'manual', localDay: string) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO discovery_runs (user_id, trigger, local_day) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING RETURNING id`,
    [userId, trigger, localDay],
  );
  return rows[0]?.id ?? null;
}

export async function finishRun(runId: string, stats: { queries: string[]; candidates: number; suggested: number; costDollars: number }) {
  await db.query(
    `UPDATE discovery_runs SET queries = $2, candidates = $3, suggested = $4, cost_dollars = $5 WHERE id = $1`,
    [runId, stats.queries, stats.candidates, stats.suggested, stats.costDollars],
  );
}

/** Stores the looked-up cancellation policy on each event (details.cancellation) for the booking flow. */
export async function saveCancellation(events: ScoredEvent[]) {
  for (const e of events) {
    if (!e.cancellation || !/^[0-9a-f-]{36}$/.test(e.id)) continue; // tuning script uses fake ids
    await db.query(`UPDATE events SET details = details || jsonb_build_object('cancellation', $2::jsonb) WHERE id = $1`, [
      e.id,
      JSON.stringify(e.cancellation),
    ]);
  }
}
