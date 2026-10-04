import { db } from '../db';
import { STATUSES, normaliseStatus, type EventStatus } from './classify';
import { getExa } from './exa';
import { canonicalOrNull, isAggregatorUrl, isGenericPage, looksBookable, parsePrice } from './normalize';
import type { StoredEvent } from './types';

/**
 * Live status re-check for the shortlist (PLAN §8.2): Exa /contents on each event's booking (or detail) page with
 * `maxAgeHours: 1` and a small schema (one call per page, in parallel). Extraction status can be a day old; this one is ≤1 h.
 * Never throws. Pages behind bot walls (Ticketmaster etc.) come back empty: the event keeps its old values.
 */

const MAX_EVENTS = 10;

const STATUS_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          n: { type: 'integer', description: 'number of the listed event this item is about' },
          status: { type: 'string', enum: [...STATUSES], description: 'ticket availability for THIS event/showtime; unknown if the page does not say' },
          price: { type: 'string', description: 'ticket price as written on the page; empty if not shown' },
          bookingUrl: {
            type: 'string',
            description: 'direct Buy tickets / Register / RSVP link for this exact event or showtime; empty if none (never a venue home, calendar or season page)',
          },
          onSaleAt: { type: 'string', description: 'ISO date-time when sales open, only if not yet on sale' },
          dates: {
            type: 'array',
            items: { type: 'string' },
            description: 'every date-time the page shows for this event, as local ISO 8601 incl. year (e.g. 2026-10-08T19:30); [] if none shown',
          },
        },
        required: ['n', 'status', 'dates'],
      },
    },
  },
  required: ['items'],
};

type Item = { n: number; status?: string; price?: string; bookingUrl?: string; onSaleAt?: string; dates?: string[] };

export type StatusCheck = {
  checked: boolean;                 // the page answered for this event
  previous: EventStatus;
  status: EventStatus;              // after the check (unchanged when the page said nothing)
  startConfirmed: boolean | null;   // false = the page shows another date/time: don't suggest
  bookingUrlChanged: boolean;
  priceText: string | null;
  error?: string;
};

function query(events: { e: StoredEvent; n: number }[]) {
  const list = events.map(({ e, n }) => `${n}) "${e.title}"${e.venue ? ` at ${e.venue}` : ''}, expected ${e.startLocal.replace('T', ' ')}`).join('\n');
  return `For each of these events, if this page is about it: its number, ticket availability for that showtime, price as written, direct Buy/Register/RSVP link, on-sale date if not yet on sale, and every date-time the page lists for it. Leave out events the page does not mention.\n${list}`;
}

/**
 * Does the page show the event on its stored day? Computed in code from the dates the page lists (the summariser's
 * own yes/no was unreliable). null = page lists no dates; only a different *day* counts as false.
 */
function confirmsStart(e: StoredEvent, dates: string[] | undefined): boolean | null {
  const days = (dates ?? []).map(d => String(d).trim().slice(0, 10)).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (!days.length) return null;
  return days.includes(e.startLocal.slice(0, 10));
}

/** A link the booking agent can open for this event: http(s), no placeholder host, no aggregator/reseller, no season/calendar page. */
function usableLink(raw: string | undefined): string | null {
  const u = canonicalOrNull(raw?.trim() || null);
  if (!u || isAggregatorUrl(u) || isGenericPage(u)) return null;
  try {
    if (new URL(u).pathname.replace(/\/+$/, '') === '') return null; // a site's home page is not an event link
  } catch {
    return null;
  }
  return u;
}

/** Does `fresh` improve on `current`? Only event-specific ticket/RSVP links replace a known one. */
function better(fresh: string, current: string | null) {
  if (fresh === current) return false;
  if (!current || isAggregatorUrl(current) || isGenericPage(current)) return true;
  return looksBookable(fresh) && !looksBookable(current);
}

const isUuid = (id: string) => /^[0-9a-f-]{36}$/.test(id);

/**
 * Re-checks status / price / booking link for up to 10 events (call it on the shortlist only).
 * Returns updated copies (same order) and what each check found; also writes the result to `events`.
 */
export async function refreshStatus<T extends StoredEvent>(
  events: T[],
  opts: { maxAgeHours?: number; livecrawlTimeout?: number } = {},
): Promise<{ events: T[]; checks: Map<string, StatusCheck>; costDollars: number }> {
  const checks = new Map<string, StatusCheck>();
  const out = events.map(e => ({ ...e }));
  const todo = out.slice(0, MAX_EVENTS);
  for (const e of out) checks.set(e.id, { checked: false, previous: e.status, status: e.status, startConfirmed: null, bookingUrlChanged: false, priceText: e.priceText });
  if (!todo.length || !process.env.EXA_API_KEY) return { events: out, checks, costDollars: 0 };

  // One /contents call per page, in parallel, naming only that page's events (with all ten in one query the
  // summariser mixed them up). Events sharing a page (two showtimes on one calendar) share the call.
  const linkOf = (e: StoredEvent) => (e.bookingUrl ?? e.url).split('#')[0];
  const byUrl = new Map<string, { e: T; n: number }[]>();
  todo.forEach((e, i) => byUrl.set(linkOf(e), [...(byUrl.get(linkOf(e)) ?? []), { e, n: i + 1 }]));
  let costDollars = 0;
  const itemsByUrl = new Map<string, Item[]>();
  const answers = await Promise.allSettled(
    [...byUrl].map(async ([url, evs]) => {
      const res = await getExa().getContents([url], {
        maxAgeHours: opts.maxAgeHours ?? 1,
        livecrawlTimeout: opts.livecrawlTimeout ?? 15_000,
        summary: { query: query(evs), schema: STATUS_SCHEMA },
      });
      costDollars += res.costDollars?.total ?? 0;
      const summary = (res.results[0] as { summary?: unknown } | undefined)?.summary;
      const parsed = JSON.parse(String(summary ?? '{}'));
      if (Array.isArray(parsed?.items)) itemsByUrl.set(url, parsed.items);
    }),
  );
  answers.forEach((a, i) => {
    if (a.status === 'rejected') {
      for (const { e } of [...byUrl.values()][i]) checks.get(e.id)!.error = String(a.reason).slice(0, 120);
    }
  });

  const now = new Date().toISOString();
  for (const [i, e] of todo.entries()) {
    const check = checks.get(e.id)!;
    const items = itemsByUrl.get(linkOf(e));
    // The item for this event's number; a single answer on a page asked about one event is taken as this event.
    const item = items?.find(x => Number(x.n) === i + 1) ?? (items?.length === 1 && byUrl.get(linkOf(e))!.length === 1 ? items[0] : undefined);
    if (!item) {
      check.error ??= items ? 'page does not mention this event' : 'page not readable';
      continue;
    }
    check.checked = true;
    check.startConfirmed = confirmsStart(e, item.dates);
    // Listing sites lag behind the box office ("on sale soon" long after it opened): trust them only over "unknown".
    const status = normaliseStatus(item.status);
    if (status !== 'unknown' && (!isAggregatorUrl(linkOf(e)) || e.status === 'unknown')) {
      e.status = status;
      e.statusCheckedAt = now;
      check.status = status;
    }
    if (item.onSaleAt && !Number.isNaN(new Date(item.onSaleAt).getTime())) e.onSaleAt = new Date(item.onSaleAt).toISOString();
    const link = usableLink(item.bookingUrl);
    if (link && better(link, e.bookingUrl)) {
      e.bookingUrl = link;
      check.bookingUrlChanged = true;
    } else if (isGenericPage(e.bookingUrl) || isAggregatorUrl(e.bookingUrl)) {
      e.bookingUrl = null; // a season page or reseller is no booking link: the booking agent starts from detailUrl
      check.bookingUrlChanged = true;
    }
    const raw = item.price?.trim() || null;
    const price = parsePrice(raw);
    let priceText: string | null = null;
    if (raw && (price.cents !== null || /\d/.test(raw))) {
      priceText = raw;
      e.priceText = priceText;
      check.priceText = priceText;
      if (price.cents !== null) {
        e.priceMinCents = price.cents;
        e.currency = price.currency ?? e.currency;
      }
    }

    if (!isUuid(e.id)) continue; // tuning script uses fake ids
    await db
      .query(
        `UPDATE events SET
           status = $2,
           status_checked_at = CASE WHEN $3 THEN now() ELSE status_checked_at END,
           booking_url = $4,
           on_sale_at = coalesce($5, on_sale_at),
           details = details || jsonb_strip_nulls(jsonb_build_object('priceText', $6::text, 'priceMinCents', $7::int,
                                                                     'priceCurrency', $8::text, 'startConfirmed', $9::boolean))
         WHERE id = $1`,
        [e.id, e.status, status !== 'unknown', e.bookingUrl, e.onSaleAt, priceText,
         priceText ? e.priceMinCents : null, priceText ? e.currency : null, check.startConfirmed],
      )
      .catch(err => console.warn('[events] status save failed', e.title, String(err).slice(0, 160)));
  }
  return { events: out, checks, costDollars };
}
