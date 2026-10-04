import { db, getBudgetStatus } from '../db';
import { allowsBookingUnasked, attachCancellation } from './cancellation';
import type { EventCategory } from './classify';
import { getTaste } from '../taste';
import { loadPages, searchUrls, type PageEvents } from './exa';
import { toCandidates } from './normalize';
import { planQueries } from './plan';
import { scoreEvents } from './score';
import { alreadySuggested, finishRun, saveCancellation, saveSuggestions, startRun, storeEvents } from './store';
import { isoDay, zonedToUtc } from './time';
import type { Candidate, DiscoveryContext, PlannedQuery, ScoredEvent, Window } from './types';

const DAY = 86_400_000;
export const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'America/Los_Angeles';
export const DEFAULT_CITY = process.env.DEFAULT_CITY || 'San Francisco';

export function defaultWindow(days = 14, now = new Date()): Window {
  return { from: now, to: new Date(now.getTime() + days * DAY) };
}

/** Loads city, timezone and taste for a user. Missing city/timezone fall back to DEFAULT_CITY/DEFAULT_TIMEZONE. */
export async function loadContext(
  userId: string,
  opts: { window?: Window; hint?: string; categories?: EventCategory[] } = {},
): Promise<DiscoveryContext> {
  const { rows } = await db.query(`SELECT city, timezone, interests FROM users WHERE id = $1`, [userId]);
  const u = rows[0];
  if (!u) throw new Error(`unknown user ${userId}`);
  const timezone = u.timezone || DEFAULT_TIMEZONE;
  return {
    userId,
    city: u.city || DEFAULT_CITY,
    timezone,
    country: timezone.startsWith('America/') ? 'US' : undefined,
    window: opts.window ?? defaultWindow(),
    taste: await getTaste(userId),
    interests: u.interests,
    hint: opts.hint,
    categories: opts.categories,
  };
}

/** plan → search URLs (cached) → extract pages (cached, batched) → normalise/dedupe. No LLM scoring. */
export async function findCandidates(
  ctx: DiscoveryContext,
  opts: { queries?: PlannedQuery[]; maxQueries?: number; numResults?: number; extraUrls?: string[] } = {},
) {
  const plan = opts.queries ? { queries: opts.queries } : await planQueries(ctx, opts.maxQueries ?? 6);
  const queries = [...plan.queries];
  // Favourite venues' own calendars are the most reliable source; make sure the daily run always reads them.
  if (!ctx.hint && !opts.queries) {
    const month = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: ctx.timezone }).format(ctx.window.from);
    for (const venue of (ctx.taste.profile?.favoriteVenues ?? []).slice(0, 3)) {
      if (!queries.some(q => q.query.toLowerCase().includes(venue.toLowerCase().split(' ')[0]))) {
        queries.push({ query: `${venue} ${ctx.city} upcoming events calendar ${month}`, why: `favourite venue ${venue}` });
      }
    }
  }
  // "Friday evening" → only Friday. Never widen the caller's window, only narrow it.
  if (plan.window) {
    const from = zonedToUtc(plan.window.from, ctx.timezone);
    const to = zonedToUtc(plan.window.to, ctx.timezone);
    if (from && to && to >= from) {
      ctx.window = {
        from: new Date(Math.max(from.getTime(), ctx.window.from.getTime())),
        to: new Date(Math.min(to.getTime() + 86_399_000, ctx.window.to.getTime())),
      };
    }
  }
  let costDollars = 0;
  const items: { url: string; query: string }[] = (opts.extraUrls ?? []).map(url => ({ url, query: 'venue calendar' }));
  let cachedQueries = 0;
  const results = await Promise.allSettled(queries.map(q => searchUrls(q.query, ctx, opts.numResults ?? 8)));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      items.push(...r.value.results.map(x => ({ url: x.url, query: queries[i].query })));
      costDollars += r.value.costDollars;
      if (r.value.cached) cachedQueries++;
    } else {
      console.warn(`[events] search failed for "${queries[i].query}":`, String(r.reason).slice(0, 200));
    }
  });

  const loaded = await loadPages(items, ctx);
  costDollars += loaded.costDollars;
  const pages: PageEvents[] = loaded.pages;
  const cache = { queries: cachedQueries, pages: loaded.cachedPages, failedPages: loaded.failed.length };

  const candidates = toCandidates(pages, ctx);
  return { queries, pages, candidates, costDollars, window: ctx.window, cache };
}

/**
 * Shortlist → look up each event's cancellation policy → only keep "book" (book without asking) where the user
 * can still back out for free; everything else becomes "ask". Saves the policy on the event for the booking flow.
 */
export async function finalizePicks(scored: ScoredEvent[], timezone: string, limit: number) {
  const shortlist = scored.filter(e => e.decision.action !== 'skip').slice(0, limit);
  const withPolicy = await attachCancellation(shortlist, timezone);
  for (const e of withPolicy) {
    if (e.decision.action === 'book') {
      const gate = allowsBookingUnasked(e.cancellation, e.startsAt);
      if (!gate.ok) e.decision = { action: 'ask', reason: gate.reason };
    }
  }
  await saveCancellation(withPolicy).catch(err => console.warn('[events] saving policies failed:', String(err).slice(0, 200)));
  return withPolicy;
}

export type DiscoverResult = {
  queries: PlannedQuery[];
  candidates: Candidate[];
  events: ScoredEvent[];     // rated, best first; already-suggested ones removed when `fresh` is set
  costDollars: number;
  skipped?: 'already-ran-today';
};

/**
 * Full discovery for one user: find, store, rate, decide, record suggestions.
 * `fresh: true` (daily run) drops events this user has been offered before.
 */
export async function discover(
  userId: string,
  opts: {
    trigger?: 'daily' | 'chat' | 'manual';
    window?: Window;
    hint?: string;
    categories?: EventCategory[];
    fresh?: boolean;
    limit?: number;
  } = {},
): Promise<DiscoverResult> {
  const ctx = await loadContext(userId, opts);
  const trigger = opts.trigger ?? 'manual';
  const runId = await startRun(userId, trigger, isoDay(new Date(), ctx.timezone));
  if (!runId) return { queries: [], candidates: [], events: [], costDollars: 0, skipped: 'already-ran-today' };

  const found = await findCandidates(ctx, { maxQueries: opts.hint ? 4 : 6 });
  let stored = await storeEvents(found.candidates);
  if (opts.fresh) {
    const seen = await alreadySuggested(userId, stored.map(e => e.id));
    stored = stored.filter(e => !seen.has(e.id));
  }
  const budget = await getBudgetStatus(userId).catch(() => null);
  const scored = await scoreEvents(stored, ctx, budget);
  const keep = await finalizePicks(scored, ctx.timezone, opts.limit ?? 10);
  await saveSuggestions(userId, keep);
  await finishRun(runId, {
    queries: found.queries.map(q => q.query),
    candidates: found.candidates.length,
    suggested: keep.length,
    costDollars: found.costDollars,
  });
  return { queries: found.queries, candidates: found.candidates, events: keep, costDollars: found.costDollars };
}
