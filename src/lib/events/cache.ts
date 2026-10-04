import { createHash } from 'node:crypto';
import { db } from '../db';
import type { PageEvents } from './exa';

/**
 * Postgres caches for Exa (the function runtime keeps no memory between requests):
 * - queries: normalised query → result URLs (SEARCH_CACHE_HOURS, default 12)
 * - pages:   URL → events extracted for a date window (PAGE_CACHE_HOURS, default 24; pages without events
 *            EMPTY_PAGE_CACHE_HOURS, default 3); a hit needs the cached
 *            window to cover the requested one, so a 14-day morning run serves every "Friday?" chat request after it.
 * Every function swallows DB errors: a broken cache only makes things slower, never fails a search.
 * DISCOVERY_NO_CACHE=1 bypasses both (for tuning).
 */

const SEARCH_HOURS = Number(process.env.SEARCH_CACHE_HOURS || 12);
const PAGE_HOURS = Number(process.env.PAGE_CACHE_HOURS || 24);
// Pages that came back with no events expire sooner: big calendar pages are sometimes empty only transiently.
const EMPTY_PAGE_HOURS = Number(process.env.EMPTY_PAGE_CACHE_HOURS || 3);
const off = () => process.env.DISCOVERY_NO_CACHE === '1';
// Bump when the extraction schema changes so older cached pages are re-extracted.
const PAGE_SCHEMA_VERSION = 3;

export const queryKey = (query: string, country: string | undefined, numResults: number) =>
  createHash('sha256')
    .update(`${query.toLowerCase().replace(/\s+/g, ' ').trim()}|${country ?? ''}|${numResults}`)
    .digest('hex')
    .slice(0, 32);

export type CachedUrl = { url: string; title: string | null };

export async function getCachedSearch(key: string): Promise<CachedUrl[] | null> {
  if (off()) return null;
  try {
    const { rows } = await db.query(
      `SELECT results FROM exa_search_cache WHERE key = $1 AND created_at > now() - make_interval(hours => $2)`,
      [key, SEARCH_HOURS],
    );
    return rows[0]?.results ?? null;
  } catch {
    return null;
  }
}

export async function putCachedSearch(key: string, query: string, results: CachedUrl[]) {
  if (off()) return;
  await db
    .query(
      `INSERT INTO exa_search_cache (key, query, results, created_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET results = EXCLUDED.results, created_at = now()`,
      [key, query, JSON.stringify(results)],
    )
    .catch(() => {});
}

/** Cached extractions whose window covers [fromDay, toDay] (local YYYY-MM-DD). */
export async function getCachedPages(urls: string[], fromDay: string, toDay: string): Promise<Map<string, Omit<PageEvents, 'query'>>> {
  if (off() || !urls.length) return new Map();
  try {
    const { rows } = await db.query(
      `SELECT url, title, page_kind, events, created_at FROM exa_page_cache
       WHERE url = ANY($1) AND window_from <= $2::date AND window_to >= $3::date
         AND created_at > now() - make_interval(hours => CASE WHEN jsonb_array_length(events) = 0 THEN $6::int ELSE $4::int END)
         AND schema_version = $5`,
      [urls, fromDay, toDay, PAGE_HOURS, PAGE_SCHEMA_VERSION, Math.min(EMPTY_PAGE_HOURS, PAGE_HOURS)],
    );
    return new Map(rows.map(r => [r.url, { pageUrl: r.url, pageTitle: r.title, pageKind: r.page_kind, events: r.events, extractedAt: new Date(r.created_at).toISOString() }]));
  } catch {
    return new Map();
  }
}

export async function putCachedPages(pages: PageEvents[], fromDay: string, toDay: string) {
  if (off()) return;
  for (const p of pages) {
    await db
      .query(
        `INSERT INTO exa_page_cache (url, title, page_kind, events, window_from, window_to, schema_version, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (url) DO UPDATE SET title = $2, page_kind = $3, events = $4, window_from = $5, window_to = $6,
           schema_version = $7, created_at = now()`,
        [p.pageUrl, p.pageTitle, p.pageKind, JSON.stringify(p.events), fromDay, toDay, PAGE_SCHEMA_VERSION],
      )
      .catch(() => {});
  }
}
