import { db } from '../db';
import { isMockShopUrl } from '../mockshop';
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
          policyText: {
            type: 'string',
            description:
              'the refund / cancellation / exchange policy for buyers of THIS event, copied word for word from the page; ' +
              'empty if the page states none (do not infer one). Not refunds for shows the organiser cancels.',
          },
          deadlineText: { type: 'string', description: 'the refund/cancellation deadline exactly as written (e.g. "up to 7 days before event"); empty if none' },
          cancellationUrl: {
            type: 'string',
            description: 'a link shown on the page for cancelling or managing an order/registration; empty if the page shows none. Never the event page itself.',
          },
          policyUrl: { type: 'string', description: 'a link shown on the page to the refund / ticket policy; empty if none' },
        },
        required: ['n', 'status', 'dates'],
      },
    },
  },
  required: ['items'],
};

type Item = {
  n: number;
  status?: string;
  price?: string;
  bookingUrl?: string;
  onSaleAt?: string;
  dates?: string[];
  policyText?: string;
  deadlineText?: string;
  cancellationUrl?: string;
  policyUrl?: string;
};

/**
 * Refund/cancellation policy as stated on this event's own page (PLAN §9). Links are kept only if they are among
 * the page's links or literally in its text (Exa's summariser invents URLs), and never the event's own pages.
 */
export type EventPagePolicy = {
  pageUrl: string;
  policyText: string;               // verbatim; '' = the page states none
  deadlineText: string | null;
  cancellationUrl: string | null;
  policyUrl: string | null;
  rejected: string[];               // invented / unverifiable links and quotes, for logs
  checkedAt: string;                // ISO
};

export type StatusCheck = {
  checked: boolean;                 // the page answered for this event
  previous: EventStatus;
  status: EventStatus;              // after the check (unchanged when the page said nothing)
  startConfirmed: boolean | null;   // false = the page shows another date/time: don't suggest
  bookingUrlChanged: boolean;
  priceText: string | null;
  policy: EventPagePolicy | null;   // null = page not read, or an aggregator page (its terms aren't the seller's)
  error?: string;
};

function query(events: { e: StoredEvent; n: number }[]) {
  const list = events.map(({ e, n }) => `${n}) "${e.title}"${e.venue ? ` at ${e.venue}` : ''}, expected ${e.startLocal.replace('T', ' ')}`).join('\n');
  return `For each of these events, if this page is about it: its number, ticket availability for that showtime, price as written, direct Buy/Register/RSVP link, on-sale date if not yet on sale, every date-time the page lists for it, and the refund/cancellation policy for ticket buyers exactly as written on the page (with its deadline and any link the page shows to cancel/manage an order or to the refund policy; leave these empty if the page shows none, never guess a URL). Leave out events the page does not mention.\n${list}`;
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

const urlKey = (u: string) => u.replace(/^https?:\/\/(www\.)?/i, '').replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase();
const words = (t: string) => t.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();

type Page = { text: string; links: string[] };

/** `raw` if it is a real link on the page (or literally in its text) and not one of the event's own pages. */
function verifiedLink(raw: string | undefined, page: Page, own: string[], rejected: string[], label: string): string | null {
  const t = raw?.trim();
  if (!t) return null;
  const u = canonicalOrNull(t);
  const key = u && urlKey(u);
  if (!u || !key) return (rejected.push(`${label}: not a URL "${t.slice(0, 80)}"`), null);
  if (own.some(o => urlKey(o) === key)) return (rejected.push(`${label}: the event page itself ${u}`), null);
  const onPage = page.links.some(l => urlKey(l) === key) || page.text.includes(t) || page.text.includes(u);
  if (!onPage) return (rejected.push(`${label}: not on the page ${u}`), null);
  return u;
}

/** Is `quote` really on the page? Exact (normalised) match, or ≥80% of its words appear in the page text. */
function quotedFrom(quote: string, page: Page): boolean {
  if (!page.text) return true; // no text came back: can't check, the summary itself is from the page
  const q = words(quote);
  const text = words(page.text);
  if (!q) return false;
  if (text.includes(q)) return true;
  const qs = q.split(' ').filter(w => w.length >= 3);
  const ts = new Set(text.split(' '));
  return qs.length > 0 && qs.filter(w => ts.has(w)).length / qs.length >= 0.8;
}

// A refund-policy line on a ticket page ("Refund Policy\nNo refunds", "Refunds up to 7 days before event").
const POLICY_LINE = /\b(no refunds?|non-?refundable|all sales (are )?final|refunds? (up to|until|available|within|accepted|are available)|full refund|no exchanges?)\b/i;

/** The page's own policy line, read from its text in code (single-event pages only, so it can't be another event's). */
function policyLineFromText(text: string): string {
  const lines = text.split(/\n+/).map(l => l.replace(/^[#>*\-\s]+/, '').trim()).filter(Boolean);
  const hit = lines.find(l => l.length <= 300 && POLICY_LINE.test(l) && !/cancel(l)?ed by|if the (event|show) is (cancel|postpon)/i.test(l));
  return hit ?? '';
}

function pagePolicy(item: Item, page: Page, e: StoredEvent, url: string, now: string, singleEvent: boolean): EventPagePolicy {
  const rejected: string[] = [];
  let policyText = item.policyText?.trim() ?? '';
  let deadlineText = item.deadlineText?.trim() || null;
  if (policyText && !quotedFrom(policyText, page)) {
    rejected.push(`policyText not on the page: "${policyText.slice(0, 80)}"`);
    policyText = '';
  }
  if (!policyText && singleEvent && page.text) {
    policyText = policyLineFromText(page.text); // the summariser missed or paraphrased it
    deadlineText = null;
  }
  const own = [url, e.url, e.pageUrl, ...(e.bookingUrl ? [e.bookingUrl] : [])];
  return {
    pageUrl: url,
    policyText,
    deadlineText: policyText ? deadlineText : null,
    cancellationUrl: verifiedLink(item.cancellationUrl, page, own, rejected, 'cancellationUrl'),
    policyUrl: verifiedLink(item.policyUrl, page, own, rejected, 'policyUrl'),
    rejected,
    checkedAt: now,
  };
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
  // The mock shop's pages are generated from its catalogue: nothing to re-check (and Exa can't vouch for a tunnel URL).
  const todo = out.slice(0, MAX_EVENTS).filter(e => !isMockShopUrl(e.bookingUrl ?? e.url));
  for (const e of out) checks.set(e.id, { checked: false, previous: e.status, status: e.status, startConfirmed: null, bookingUrlChanged: false, priceText: e.priceText, policy: null });
  if (!todo.length || !process.env.EXA_API_KEY) return { events: out, checks, costDollars: 0 };

  // One /contents call per page, in parallel, naming only that page's events (with all ten in one query the
  // summariser mixed them up). Events sharing a page (two showtimes on one calendar) share the call.
  const linkOf = (e: StoredEvent) => (e.bookingUrl ?? e.url).split('#')[0];
  const byUrl = new Map<string, { e: T; n: number }[]>();
  todo.forEach((e, i) => byUrl.set(linkOf(e), [...(byUrl.get(linkOf(e)) ?? []), { e, n: i + 1 }]));
  let costDollars = 0;
  const itemsByUrl = new Map<string, Item[]>();
  const pages = new Map<string, Page>();
  const answers = await Promise.allSettled(
    [...byUrl].map(async ([url, evs]) => {
      const res = await getExa().getContents([url], {
        maxAgeHours: opts.maxAgeHours ?? 1,
        livecrawlTimeout: opts.livecrawlTimeout ?? 15_000,
        summary: { query: query(evs), schema: STATUS_SCHEMA },
        // Page text + links: only to verify the policy quote and the cancel/policy links the summariser returns.
        text: { maxCharacters: 30_000 },
        extras: { links: 200 },
      });
      costDollars += res.costDollars?.total ?? 0;
      const r0 = res.results[0] as { summary?: unknown; text?: string; extras?: { links?: string[] } } | undefined;
      pages.set(url, { text: r0?.text ?? '', links: r0?.extras?.links ?? [] });
      const summary = r0?.summary;
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
    if (!isAggregatorUrl(linkOf(e))) {
      const single = byUrl.get(linkOf(e))!.length === 1;
      check.policy = pagePolicy(item, pages.get(linkOf(e)) ?? { text: '', links: [] }, e, linkOf(e), now, single);
      if (check.policy.rejected.length) console.info(`[events] policy check ${e.title.slice(0, 40)}: rejected ${check.policy.rejected.join('; ')}`);
    }
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
