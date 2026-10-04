import type { PageEvents } from './exa';
import { AGGREGATORS, deriveAttributes, normaliseCategory, normaliseStatus, normaliseTags } from './classify';
import { utcToLocal, zonedToUtc } from './time';
import type { Candidate, DiscoveryContext } from './types';

const CURRENCY: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP' };

/** "$20–60" → 2000 USD, "Tickets: €15,50" → 1550 EUR, "Free" → 0. Display/ranking only, never charged. */
export function parsePrice(text: string | null | undefined): { cents: number | null; currency: string | null } {
  if (!text) return { cents: null, currency: null };
  if (/\bfree\b|no cover|kostenlos|eintritt frei/i.test(text)) return { cents: 0, currency: null };
  const m = text.match(/([$€£])\s*(\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s*(€|EUR|USD|GBP)/i);
  if (!m) return { cents: null, currency: null };
  const amount = Number((m[2] ?? m[3]).replace(',', '.'));
  const sym = (m[1] ?? m[4]).toUpperCase();
  return { cents: Math.round(amount * 100), currency: CURRENCY[sym] ?? sym };
}

// "Dennis Mitcheltree Quartet In San Francisco at Mr. Tipple's | Bandsintown" → "dennis mitcheltree quartet"
const normTitle = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/\s[|–—-]\s|\s(?:at|in|@)\s|:\s/)[0]
    .replace(/\b(tickets?|live|in concert|presents?)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 6)
    .join(' ');

const normVenue = (s: string | null) => (s ? s.toLowerCase().split(/[,(]/)[0].replace(/[^a-z0-9]+/g, ' ').trim() : '');

function canonicalUrl(raw: string | null | undefined, pageUrl: string) {
  if (!raw || !/^https?:\/\//.test(raw)) return pageUrl;
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$)/.test(k)) u.searchParams.delete(k);
    u.hash = '';
    return u.toString();
  } catch {
    return pageUrl;
  }
}


/** Placeholder strings Exa's extractor sometimes writes instead of leaving a field empty. */
const clean = (s: string | null | undefined) => {
  const t = s?.trim();
  return !t || /^(null|none|n\/a|tbd|tba|tickets?|unknown|-)$/i.test(t) ? null : t;
};

const tokens = (title: string) =>
  new Set(normTitle(title.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')).split(' ').filter(w => w.length >= 3 && !/^(the|and|with|feat|san|francisco|show|night)$/.test(w)));

/** Same show on another site? Same day, compatible time, and one title's words contain the other's (or overlap ≥60%). */
function sameShow(a: Candidate, b: Candidate) {
  if (a.startLocal.slice(0, 10) !== b.startLocal.slice(0, 10)) return false;
  if (a.hasTime && b.hasTime && a.startLocal !== b.startLocal) return false;
  const ta = tokens(a.title);
  const tb = tokens(b.title);
  if (!ta.size || !tb.size) return false;
  const shared = [...ta].filter(w => tb.has(w)).length;
  return shared === Math.min(ta.size, tb.size) || shared / Math.max(ta.size, tb.size) >= 0.6;
}

/** Which duplicate to keep: real start time, own event page, not an aggregator, known price. */
function rank(c: Candidate) {
  const host = (() => {
    try {
      return new URL(c.url).hostname;
    } catch {
      return '';
    }
  })();
  return (c.hasTime ? 8 : 0) + (AGGREGATORS.test(host) ? 0 : 4) + (c.url !== c.pageUrl ? 2 : 0) + (c.priceMinCents !== null ? 1 : 0);
}

/**
 * Extracted page events → clean candidates inside the window, one per showtime, deduplicated across sites
 * (the same concert usually shows up on the venue site, a ticket shop and two aggregators).
 */
export function toCandidates(pages: PageEvents[], ctx: DiscoveryContext): Candidate[] {
  const all: Candidate[] = [];
  for (const page of pages) {
    // Articles and season overviews: the extractor stamps undated items with today's date (sometimes even a time).
    // Real calendars span several days, so a page whose 3+ events all fall on today is not trusted.
    const today = utcToLocal(new Date(), ctx.timezone).slice(0, 10);
    if (/\/(article|articles|news|blog)\//i.test(page.pageUrl)) continue;
    if (page.events.length >= 3 && page.events.every(e => e.start.startsWith(today))) continue;
    const dateOnly = page.events.filter(e => !/T\d{2}:\d{2}/.test(e.start) || /T00:00/.test(e.start)).map(e => e.start.slice(0, 10));
    const placeholder = dateOnly.length >= 3 && new Set(dateOnly).size === 1 ? dateOnly[0] : null;
    for (const e of page.events) {
      if (placeholder && e.start.slice(0, 10) === placeholder && (!/T\d{2}:\d{2}/.test(e.start) || /T00:00/.test(e.start))) continue;
      const local = e.start.trim();
      // "T00:00" is how the extractor writes "no time given"; a real midnight show is rare enough to lose.
      const hasTime = /T\d{2}:\d{2}/.test(local) && !/T00:00(:00)?$/.test(local);
      const startsAt = /[zZ]|[+-]\d{2}:?\d{2}$/.test(local) ? new Date(local) : zonedToUtc(hasTime ? local : local.slice(0, 10), ctx.timezone);
      if (!startsAt || Number.isNaN(startsAt.getTime())) continue;
      // Date-only events count for the whole day; otherwise they must start inside the window.
      const endOfDay = new Date(startsAt.getTime() + (hasTime ? 0 : 86_399_000));
      if (endOfDay < ctx.window.from || startsAt > ctx.window.to) continue;

      const title = clean(e.title);
      if (!title) continue;
      const venue = clean(e.venueName) ?? clean(e.venue)?.split(',')[0].trim() ?? null;
      const address = clean(e.address);
      const bookingUrl = clean(e.bookingUrl);
      const priceText = clean(e.price);
      const { cents, currency } = parsePrice(priceText);
      const startLocal = hasTime ? utcToLocal(startsAt, ctx.timezone) : local.slice(0, 10);
      const tags = normaliseTags(e.tags);
      const category = normaliseCategory(e.category, `${title} ${venue ?? ''} ${tags.join(' ')} ${page.query}`);
      if (ctx.categories?.length && !ctx.categories.includes(category)) continue;
      all.push({
        title,
        startsAt,
        startLocal,
        hasTime,
        venue,
        address,
        city: clean(e.city) ?? ctx.city,
        online: e.online === true,
        url: canonicalUrl(clean(e.url), page.pageUrl),
        bookingUrl: bookingUrl && /^https?:\/\//.test(bookingUrl) ? canonicalUrl(bookingUrl, page.pageUrl) : null,
        status: normaliseStatus(e.status),
        statusCheckedAt: new Date().toISOString(),
        pageUrl: page.pageUrl,
        pageKind: page.pageKind,
        priceText: cents === null && priceText && !/\d/.test(priceText) ? null : priceText,
        priceMinCents: cents,
        currency,
        query: page.query,
        dedupeKey: `${normVenue(venue)}|${startLocal}|${normTitle(title)}`,
        category,
        tags,
        attrs: deriveAttributes({ startsAt, hasTime, priceMinCents: cents, title, tags }, ctx.timezone),
      });
    }
  }

  // Best version first, then fold every later duplicate into the first one it matches.
  all.sort((a, b) => rank(b) - rank(a));
  const kept: Candidate[] = [];
  for (const c of all) {
    const twin = kept.find(k => sameShow(k, c));
    if (!twin) kept.push(c);
    else {
      twin.venue ??= c.venue;
      twin.address ??= c.address;
      // A venue's own ticket link beats an aggregator's; any stated status beats "unknown".
      if (!twin.bookingUrl || (AGGREGATORS.test(twin.bookingUrl) && c.bookingUrl && !AGGREGATORS.test(c.bookingUrl))) twin.bookingUrl = c.bookingUrl ?? twin.bookingUrl;
      if (twin.status === 'unknown') twin.status = c.status;
      twin.tags = [...new Set([...twin.tags, ...c.tags])].slice(0, 6);
      if (twin.category === 'other') twin.category = c.category;
      if (twin.priceMinCents === null && c.priceMinCents !== null) {
        twin.priceText = c.priceText;
        twin.priceMinCents = c.priceMinCents;
        twin.currency = c.currency;
        twin.attrs = { ...twin.attrs, priceBand: c.attrs.priceBand };
      }
    }
  }
  return kept.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}
