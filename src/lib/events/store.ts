import { db } from '../db';
import { AGGREGATORS, DEAD_STATUSES, deriveAttributes, normaliseStatus, type EventCategory } from './classify';
import { haversineKm } from './geocode';
import type { CancellationInfo } from './cancellation';
import type { Candidate, ScoredEvent, StoredEvent } from './types';
import { normVenueName, upsertVenue, venueCoords } from './venues';

const SHORTENERS = /^(wfly\.co|bit\.ly|t\.co|tinyurl\.com|linktr\.ee|ow\.ly|buff\.ly|lnkd\.in|goo\.gl|rebrand\.ly)$/i;
const hostOf = (u: string | null) => {
  if (!u) return null;
  try {
    const host = new URL(u).hostname.replace(/^www\./, '');
    return SHORTENERS.test(host) ? null : host;
  } catch {
    return null;
  }
};
const isAggregator = (u: string | null) => {
  if (!u) return false;
  try {
    const x = new URL(u);
    return AGGREGATORS.test(x.hostname + x.pathname);
  } catch {
    return false;
  }
};

/**
 * Upserts each event's venue (venues.ts), then the event by dedupe key; search-time prices go to details
 * (events.price_cents is page-verified only). On conflict the newer known status wins, and a venue's own booking
 * link is never replaced by an aggregator's.
 */
export async function storeEvents(cands: Candidate[]): Promise<StoredEvent[]> {
  const stored: StoredEvent[] = [];
  const venueIds = new Map<string, string | null>();
  for (const c of cands) {
    let venueId: string | null = null;
    if (c.venue && !c.online) {
      const key = `${normVenueName(c.venue)}|${c.city.toLowerCase()}`;
      if (venueIds.has(key)) venueId = venueIds.get(key)!;
      else {
        const link = c.bookingUrl ?? c.url;
        venueId = await upsertVenue({ name: c.venue, address: c.address, city: c.city, domain: isAggregator(link) ? null : hostOf(link) });
        venueIds.set(key, venueId);
      }
    }
    const extra = { venueId, venueLat: null, venueLng: null, distanceKm: null };
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
      image: c.image ?? null,
    };
    try {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO events (source_url, title, venue, city, starts_at, currency, details, dedupe_key, category, tags, last_seen_at,
                             address, online, booking_url, status, status_checked_at, on_sale_at, venue_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), $11, $12, $13, $14, $15, $16, $17)
         ON CONFLICT (dedupe_key) DO UPDATE SET
           last_seen_at = now(),
           venue = coalesce(EXCLUDED.venue, events.venue),
           city = CASE WHEN EXCLUDED.address IS NOT NULL OR events.address IS NULL THEN EXCLUDED.city ELSE events.city END,
           address = coalesce(EXCLUDED.address, events.address),
           online = events.online OR EXCLUDED.online,
           booking_url = CASE WHEN EXCLUDED.booking_url IS NULL THEN events.booking_url
                              WHEN events.booking_url IS NOT NULL AND $18 THEN events.booking_url
                              ELSE EXCLUDED.booking_url END,
           status = CASE WHEN EXCLUDED.status <> 'unknown' AND (events.status = 'unknown'
                              OR EXCLUDED.status_checked_at >= coalesce(events.status_checked_at, '-infinity'))
                         THEN EXCLUDED.status ELSE events.status END,
           status_checked_at = CASE WHEN EXCLUDED.status <> 'unknown' AND (events.status = 'unknown'
                              OR EXCLUDED.status_checked_at >= coalesce(events.status_checked_at, '-infinity'))
                         THEN EXCLUDED.status_checked_at ELSE coalesce(events.status_checked_at, EXCLUDED.status_checked_at) END,
           on_sale_at = coalesce(EXCLUDED.on_sale_at, events.on_sale_at),
           venue_id = coalesce(EXCLUDED.venue_id, events.venue_id),
           details = events.details || jsonb_strip_nulls(EXCLUDED.details),
           category = CASE WHEN EXCLUDED.category <> 'other' THEN EXCLUDED.category ELSE events.category END,
           tags = (SELECT array_agg(DISTINCT t) FROM unnest(events.tags || EXCLUDED.tags) t)
         RETURNING id`,
        [sourceUrl, c.title, c.venue, c.city, c.startsAt, c.currency, details, c.dedupeKey, c.category, c.tags,
         c.address, c.online, c.bookingUrl, c.status, c.statusCheckedAt, c.onSaleAt, venueId, isAggregator(c.bookingUrl)],
      );
      stored.push({ ...c, id: rows[0].id, ...extra });
    } catch (err) {
      // Same URL+time already stored under a different key (title spelled differently): reuse that row.
      const { rows } = await db.query<{ id: string }>(`SELECT id FROM events WHERE source_url = $1`, [sourceUrl]);
      if (rows[0]) stored.push({ ...c, id: rows[0].id, ...extra });
      else console.warn('[events] store failed', c.title, String(err).slice(0, 200));
    }
  }
  return withCoords(stored);
}

/** Fills venueLat/venueLng from the venues table and, given a home, distanceKm. */
export async function withCoords<T extends StoredEvent>(events: T[], home?: { lat: number; lng: number } | null): Promise<T[]> {
  const coords = await venueCoords(events.map(e => e.venueId));
  return events.map(e => {
    const v = e.venueId ? coords.get(e.venueId) : undefined;
    const venueLat = v?.lat ?? e.venueLat ?? null;
    const venueLng = v?.lng ?? e.venueLng ?? null;
    const distanceKm =
      home && venueLat !== null && venueLng !== null ? Math.round(haversineKm(home, { lat: venueLat, lng: venueLng }) * 10) / 10 : e.distanceKm;
    return { ...e, venueLat, venueLng, distanceKm };
  });
}

/**
 * Event ids already suggested to this user (any status): the daily run never repeats itself. Onboarding starter
 * cards don't count unless swiped left: a right swipe is exactly what the daily run should offer to book.
 */
export async function alreadySuggested(userId: string, eventIds: string[]): Promise<Set<string>> {
  if (!eventIds.length) return new Set();
  const { rows } = await db.query<{ event_id: string }>(
    `SELECT event_id FROM suggestions WHERE user_id = $1 AND event_id = ANY($2::uuid[])
       AND NOT (source = 'starter' AND reaction IS DISTINCT FROM 'dislike')`,
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

const EVENT_COLUMNS = `e.id, e.title, e.venue, e.city, e.starts_at, e.details, e.dedupe_key, e.source_url, e.category, e.tags,
            e.address, e.online, e.booking_url, e.status, e.status_checked_at, e.on_sale_at, e.last_seen_at, e.venue_id,
            v.lat AS venue_lat, v.lng AS venue_lng`;

/** An `events` row (EVENT_COLUMNS) → StoredEvent, with distance from `home` when both sides are geocoded. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToEvent(r: any, tz: string, home: { lat: number; lng: number } | null): StoredEvent {
  return {
    id: r.id,
    title: r.title,
    startsAt: new Date(r.starts_at),
    startLocal: r.details.startLocal ?? '',
    hasTime: r.details.hasTime ?? true,
    venue: r.venue,
    address: r.address ?? null,
    city: r.city,
    online: r.online ?? false,
    url: r.details.eventUrl ?? r.source_url,
    bookingUrl: r.booking_url ?? null,
    status: normaliseStatus(r.status),
    statusCheckedAt: new Date(r.status_checked_at ?? r.last_seen_at).toISOString(),
    onSaleAt: r.on_sale_at ? new Date(r.on_sale_at).toISOString() : null,
    venueId: r.venue_id ?? null,
    venueLat: r.venue_lat ?? null,
    venueLng: r.venue_lng ?? null,
    distanceKm:
      home && r.venue_lat !== null && r.venue_lng !== null
        ? Math.round(haversineKm(home, { lat: r.venue_lat, lng: r.venue_lng }) * 10) / 10
        : null,
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
  };
}

/** One stored event by id (null if unknown), plus its raw details jsonb (cancellation, …). */
export async function loadEvent(
  id: string,
  tz: string,
  home: { lat: number; lng: number } | null = null,
): Promise<{ event: StoredEvent; details: Record<string, unknown> } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await db.query(`SELECT ${EVENT_COLUMNS} FROM events e LEFT JOIN venues v ON v.id = e.venue_id WHERE e.id = $1`, [id]);
  return rows[0] ? { event: rowToEvent(rows[0], tz, home), details: rows[0].details ?? {} } : null;
}

/** Venues this close to the user's home (or, without a home, to the middle of the city's geocoded venues) count as "in the city". */
export const NEARBY_KM = 40;

/**
 * Fresh stored events for a city/window: lets the chat tool answer from cache before searching again.
 * "In the city" = events.city matches, or the venue is within NEARBY_KM of `home` (Oakland, Berkeley, Santa Clara
 * venues for an SF user); without a home, within NEARBY_KM of the average position of the city's geocoded venues.
 */
export async function recentEvents(
  city: string,
  from: Date,
  to: Date,
  tz: string,
  opts: { categories?: EventCategory[]; seenWithinHours?: number; home?: { lat: number; lng: number } | null } = {},
): Promise<StoredEvent[]> {
  const home = opts.home ?? null;
  // Sold-out/cancelled/postponed events are never worth suggesting again.
  const { rows } = await db.query(
    `WITH center AS (
       SELECT coalesce($7::float8, (SELECT avg(lat) FROM venues WHERE lower(city) = lower($1) AND lat IS NOT NULL)) AS lat,
              coalesce($8::float8, (SELECT avg(lng) FROM venues WHERE lower(city) = lower($1) AND lat IS NOT NULL)) AS lng
     )
     SELECT ${EVENT_COLUMNS}
     FROM events e LEFT JOIN venues v ON v.id = e.venue_id CROSS JOIN center c
     WHERE (lower(e.city) = lower($1)
            OR (v.lat IS NOT NULL AND c.lat IS NOT NULL
                AND 2 * 6371 * asin(sqrt(power(sin(radians(v.lat - c.lat) / 2), 2)
                    + cos(radians(c.lat)) * cos(radians(v.lat)) * power(sin(radians(v.lng - c.lng) / 2), 2))) <= $9))
       AND e.starts_at BETWEEN $2 AND $3 AND e.last_seen_at > now() - make_interval(hours => $4)
       AND ($5::text[] IS NULL OR e.category = ANY($5)) AND NOT (e.status = ANY($6::text[]))
     ORDER BY e.starts_at LIMIT 200`,
    [city, from, to, opts.seenWithinHours ?? 24, opts.categories?.length ? opts.categories : null, DEAD_STATUSES,
     home?.lat ?? null, home?.lng ?? null, NEARBY_KM],
  );
  return rows.map(r => rowToEvent(r, tz, home));
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

/**
 * Stores each event's cancellation result: the full object in details.cancellation (booking flow) plus the
 * cancellation_* columns (PLAN §9) for queries and the 24 h reuse check.
 */
export async function saveCancellation(events: { id: string; cancellation?: CancellationInfo }[]) {
  for (const e of events) {
    const c = e.cancellation;
    if (!c || !/^[0-9a-f-]{36}$/.test(e.id)) continue; // tuning script uses fake ids
    await db.query(
      `UPDATE events SET details = details || jsonb_build_object('cancellation', $2::jsonb),
         cancellation_kind = $3, cancellation_scope = $4, cancellation_source = $5, cancellation_url = $6, policy_url = $7,
         cancel_by = $8, cancellation_checked_at = coalesce($9::timestamptz, now())
       WHERE id = $1`,
      [e.id, JSON.stringify(c), c.kind, c.scope, c.source, c.cancellationUrl, c.policyUrl, c.cancelBy, c.checkedAt],
    );
  }
}
