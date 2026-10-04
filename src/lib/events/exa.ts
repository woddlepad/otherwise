import Exa from 'exa-js';
import { CATEGORIES, STATUSES } from './classify';
import { getCachedPages, getCachedSearch, putCachedPages, putCachedSearch, queryKey } from './cache';
import { isoDay } from './time';
import type { DiscoveryContext } from './types';

let exa: Exa | undefined;
export function getExa() {
  if (!process.env.EXA_API_KEY) throw new Error('EXA_API_KEY is not set');
  exa ??= new Exa(process.env.EXA_API_KEY);
  return exa;
}

/** What Exa extracts from every result page (one LLM call per page on Exa's side, no gateway tokens). */
const PAGE_EVENTS_SCHEMA = {
  type: 'object',
  properties: {
    pageKind: { type: 'string', enum: ['single_event', 'listing', 'other'] },
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'event or film/act name, without venue or date' },
          start: { type: 'string', description: 'local start as ISO 8601 incl. year, e.g. 2026-10-17T19:00; date only if no time' },
          venueName: { type: 'string', description: 'venue name only, no address' },
          address: { type: 'string', description: 'street address if shown, else empty' },
          city: { type: 'string', description: 'city the venue is in, as on the page' },
          online: { type: 'boolean', description: 'true only for online/livestream events' },
          price: { type: 'string', description: 'as written on the page, e.g. "$20–60"; empty if not shown' },
          url: { type: 'string', description: 'detail page for this event if linked, else empty' },
          bookingUrl: { type: 'string', description: 'direct Buy tickets / Register / RSVP link for this event, else empty' },
          status: { type: 'string', enum: [...STATUSES], description: 'availability as stated; unknown if not stated' },
          onSaleAt: { type: 'string', description: 'ISO date-time sales open, only if not yet on sale' },
          category: { type: 'string', enum: [...CATEGORIES] },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: '2–5 lowercase genre/format words, e.g. ["jazz","vocal"], ["horror","35mm","japanese"], ["stand-up"]',
          },
        },
        required: ['title', 'start'],
      },
    },
  },
  required: ['pageKind', 'events'],
};

export type ExtractedEvent = {
  title: string;
  start: string;
  venueName?: string | null;
  venue?: string | null;             // schema v2 name (name + address mixed), still read from older cache rows
  address?: string | null;
  city?: string | null;
  online?: boolean | null;
  price?: string | null;
  url?: string | null;
  bookingUrl?: string | null;
  status?: string | null;
  onSaleAt?: string | null;
  category?: string | null;
  tags?: string[] | null;
};
export type PageEvents = {
  pageUrl: string;
  pageTitle: string | null;
  pageKind: 'single_event' | 'listing' | 'other';
  events: ExtractedEvent[];
  query: string;
  extractedAt?: string;              // ISO; when Exa extracted the page (cache row time); absent = just now
};

function summaryQuery(ctx: DiscoveryContext) {
  const from = isoDay(ctx.window.from, ctx.timezone);
  const to = isoDay(ctx.window.to, ctx.timezone);
  return `Every event, concert or screening on this page taking place between ${from} and ${to} in or near ${ctx.city}: title, local start date-time, venue name, street address and city, online or not, price as written, detail link, direct booking link, ticket availability (on sale, few left, sold out, …) and on-sale date, category and genre tags. One item per showtime. Skip items whose date is not stated on the page; never fill in today's date as a placeholder.`;
}

function parseSummary(summary: unknown): { pageKind: PageEvents['pageKind']; events: ExtractedEvent[] } | null {
  if (typeof summary !== 'string' || !summary.trim()) return null;
  try {
    const parsed = JSON.parse(summary);
    if (!Array.isArray(parsed?.events)) return null;
    const pageKind = ['single_event', 'listing', 'other'].includes(parsed.pageKind) ? parsed.pageKind : 'listing';
    return { pageKind, events: parsed.events.filter((e: ExtractedEvent) => e?.title && e?.start) };
  } catch {
    return null;
  }
}

/** Retries Exa on rate limits and transient errors; the SDK has no retries of its own. */
async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      const retriable = status === undefined || status === 429 || status >= 500;
      if (!retriable || attempt >= tries) throw err;
      await new Promise(r => setTimeout(r, 800 * 2 ** (attempt - 1)));
    }
  }
}

/**
 * One Exa search → result URLs (no contents: extraction happens in loadPages so pages can be cached across
 * queries, runs and users). Cached per normalised query.
 */
export async function searchUrls(query: string, ctx: DiscoveryContext, numResults = 8) {
  const key = queryKey(query, ctx.country, numResults);
  const hit = await getCachedSearch(key);
  if (hit) return { results: hit, cached: true, costDollars: 0 };
  const res = await withRetry(() =>
    getExa().search(query, {
      type: 'auto',
      numResults,
      ...(ctx.country ? { userLocation: ctx.country } : {}),
      contents: false,
    }),
  );
  const results = res.results.map(r => ({ url: r.url, title: r.title ?? null }));
  await putCachedSearch(key, query, results);
  return { results, cached: false, costDollars: res.costDollars?.total ?? 0 };
}

const BATCH = 10; // pages per /contents call; batches run in parallel (each page = one summary LLM call at Exa)

/**
 * URL → events on that page within the window. Served from the page cache when an earlier extraction covered the
 * window; the rest go through /contents with a per-page structured summary, in parallel batches.
 * `maxAgeHours: 24` keeps calendars fresh without live-crawling every time.
 */
export async function loadPages(items: { url: string; query: string }[], ctx: DiscoveryContext) {
  const fromDay = isoDay(ctx.window.from, ctx.timezone);
  const toDay = isoDay(ctx.window.to, ctx.timezone);
  const queryOf = new Map<string, string>();
  for (const it of items) if (!queryOf.has(it.url)) queryOf.set(it.url, it.query);
  const urls = [...queryOf.keys()];

  const cached = await getCachedPages(urls, fromDay, toDay);
  const pages: PageEvents[] = [...cached.values()].map(p => ({ ...p, query: queryOf.get(p.pageUrl) ?? '' }));
  const todo = urls.filter(u => !cached.has(u));
  let costDollars = 0;
  const failed: string[] = [];

  const batches = Array.from({ length: Math.ceil(todo.length / BATCH) }, (_, i) => todo.slice(i * BATCH, (i + 1) * BATCH));
  const results = await Promise.allSettled(
    batches.map(batch =>
      withRetry(() =>
        getExa().getContents(batch, {
          maxAgeHours: 24,
          livecrawlTimeout: 15_000,
          summary: { query: summaryQuery(ctx), schema: PAGE_EVENTS_SCHEMA },
        }),
      ),
    ),
  );
  const fresh: PageEvents[] = [];
  const empties: PageEvents[] = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      failed.push(...batches[i]);
      console.warn('[events] contents batch failed:', String(r.reason).slice(0, 200));
      return;
    }
    costDollars += r.value.costDollars?.total ?? 0;
    const got = new Set<string>();
    for (const x of r.value.results) {
      const parsed = parseSummary((x as { summary?: unknown }).summary);
      if (!parsed) continue;
      got.add(x.url);
      fresh.push({ pageUrl: x.url, pageTitle: x.title ?? null, query: queryOf.get(x.url) ?? '', ...parsed });
    }
    const empty = batches[i].filter(u => !got.has(u));
    failed.push(...empty);
    // Remember "no events here" too, or every run re-fetches the same dead pages (Exa answered, so it isn't transient).
    empties.push(...empty.map(u => ({ pageUrl: u, pageTitle: null, query: '', pageKind: 'other' as const, events: [] })));
  });
  await putCachedPages([...fresh, ...empties], fromDay, toDay);
  return { pages: [...pages, ...fresh], cachedPages: cached.size, failed, costDollars };
}
