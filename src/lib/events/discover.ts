import { db, getBudgetStatus } from '../db';
import { allowsBookingUnasked, attachCancellation } from './cancellation';
import { DEAD_STATUSES, type EventCategory } from './classify';
import { geocodeUserHome, geocodeVenues, haversineKm } from './geocode';
import { getTaste } from '../taste';
import { mockShopPage, rememberMockPolicy } from '../mockshop';
import { loadPages, searchUrls, type PageEvents } from './exa';
import { toCandidates } from './normalize';
import { planQueries } from './plan';
import { scoreEvents } from './score';
import { alreadySuggested, finishRun, saveCancellation, saveSuggestions, startRun, storeEvents, withCoords } from './store';
import { refreshStatus } from './status';
import { formatLocal, isoDay, zonedToUtc } from './time';
import { normVenueName } from './venues';
import type { Decision } from '../policy';
import type { Candidate, DiscoveryContext, PlannedQuery, ScoredEvent, StoredEvent, Window } from './types';

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
  const { rows } = await db.query(`SELECT city, timezone, interests, max_travel_km FROM users WHERE id = $1`, [userId]);
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
    maxTravelKm: u.max_travel_km ?? null,
  };
}

/**
 * Drops events that can't be attended (sold out, cancelled, postponed) and, if the user set users.max_travel_km,
 * events farther than that from home (unknown distance is kept).
 */
export function dropUnreachable<T extends StoredEvent>(events: T[], maxTravelKm?: number | null): T[] {
  return events.filter(
    e =>
      !DEAD_STATUSES.includes(e.status) &&
      !(maxTravelKm && !e.online && e.distanceKm !== null && e.distanceKm > maxTravelKm),
  );
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
  // MOCK_SHOP=1: the test ticket shop's events join as one more listing page (src/lib/mockshop.ts).
  const mock = mockShopPage(ctx);
  if (mock) {
    pages.push(mock);
    await rememberMockPolicy().catch(err => console.warn('[events] mock shop policy:', String(err).slice(0, 200)));
  }
  const cache = { queries: cachedQueries, pages: loaded.cachedPages, failedPages: loaded.failed.length };

  const candidates = toCandidates(pages, ctx);
  return { queries, pages, candidates, costDollars, window: ctx.window, cache };
}

/**
 * Keys under which two picks are the same show: "Ray Lau" listed twice (same title + start, venue spelled two ways),
 * or one show under several titles ("SF Jazz w/Kurt Elling" / "Kurt Elling & Yellowjackets …": same venue + start time).
 */
function samePickKeys(e: StoredEvent): string[] {
  const title = e.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // "THE FACULTY (1998) on 35mm film" → "the faculty": the same film twice at one venue on one day is one pick
  const core = e.title.toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]|\s(on|in)\s(35|70)mm.*$|[~|–—-].*$/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  const venue = e.venue ? normVenueName(e.venue) : '';
  const t = e.startsAt.getTime();
  return [
    `t|${title}|${t}`,
    ...(venue && e.hasTime ? [`v|${venue}|${t}`] : []),
    ...(venue && core ? [`d|${venue}|${e.startLocal.slice(0, 10)}|${core}`] : []),
  ];
}

const words = (t: string) =>
  new Set(t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(w => w.length >= 4 && !/^(with|live|night|show|film|music|presents?|featuring|tour)$/.test(w)));

/** One show listed under two venue names ("Miner Auditorium" in "SFJAZZ Center"): same day, venues ≤300 m apart, a shared name word. */
function sameShowNearby(a: StoredEvent, b: StoredEvent) {
  if (a.startLocal.slice(0, 10) !== b.startLocal.slice(0, 10)) return false;
  if (a.venueLat === null || a.venueLng === null || b.venueLat === null || b.venueLng === null) return false;
  if (haversineKm({ lat: a.venueLat, lng: a.venueLng }, { lat: b.venueLat, lng: b.venueLng }) > 0.3) return false;
  const wa = words(a.title);
  return [...words(b.title)].some(w => wa.has(w));
}

/**
 * Availability gates after the live re-check (PLAN §8.2). Returns null to drop the event, else the (possibly
 * downgraded) decision. Never upgrades: 'book' can only become 'ask'.
 */
export function statusGate(e: ScoredEvent, startConfirmed: boolean | null, tz: string): Decision | null {
  if (DEAD_STATUSES.includes(e.status) || startConfirmed === false) return null;
  const ask = (reason: string): Decision => ({ action: 'ask', reason });
  if (e.status === 'free_entry') return ask('free, no ticket needed');
  if (e.status === 'door_only') return ask('tickets at the door only');
  if (e.online && !e.bookingUrl) return e.decision.action === 'book' ? ask('online, no registration link found') : e.decision;
  if (e.decision.action !== 'book') return e.decision;
  if (e.status === 'waitlist') return ask('waitlist only');
  if (e.status === 'not_yet_on_sale') return ask(e.onSaleAt ? `on sale from ${formatLocal(new Date(e.onSaleAt), tz)}` : 'not on sale yet');
  if (e.status === 'unknown') return ask('availability unknown');
  return e.decision;
}

/**
 * Shortlist (≤10, duplicates folded) → live status re-check → drop dead/moved events and downgrade 'book' where
 * availability is unclear → look up each event's cancellation policy → only keep "book" (book without asking)
 * where the user can still back out for free; everything else becomes "ask". Saves the policy on the event.
 */
export async function finalizePicks(scored: ScoredEvent[], timezone: string, limit: number) {
  const seen = new Set<string>();
  const shortlist = scored
    .filter(e => e.decision.action !== 'skip')
    .filter((e, i, all) => {
      const keys = samePickKeys(e);
      if (keys.some(k => seen.has(k))) return false;
      if (all.slice(0, i).some(o => seen.has(samePickKeys(o)[0]) && sameShowNearby(o, e))) return false;
      keys.forEach(k => seen.add(k));
      return true;
    })
    .slice(0, Math.min(10, limit + 2)); // a couple spare: the re-check may drop some
  const fresh = await refreshStatus(shortlist);
  const checks = [...fresh.checks.values()];
  const changed = fresh.events.filter(e => fresh.checks.get(e.id)!.previous !== e.status);
  console.info(
    `[events] re-check: ${checks.filter(c => c.checked).length}/${checks.length} pages answered, ` +
      `${changed.length} status changes${changed.length ? ` (${changed.map(e => `${e.title.slice(0, 30)}: ${fresh.checks.get(e.id)!.previous}→${e.status}`).join('; ')})` : ''}, ` +
      `${checks.filter(c => c.bookingUrlChanged).length} booking links updated` +
      `${fresh.events.filter(e => fresh.checks.get(e.id)!.bookingUrlChanged).map(e => ` (${e.title.slice(0, 30)} → ${e.bookingUrl ?? 'none'})`).join('')}, ` +
      `${checks.filter(c => c.startConfirmed === false).length} dates not confirmed`,
  );
  const gated: ScoredEvent[] = [];
  for (const e of fresh.events) {
    const decision = statusGate(e, fresh.checks.get(e.id)?.startConfirmed ?? null, timezone);
    if (!decision) {
      console.info(`[events] dropped after re-check: ${e.title} (${fresh.checks.get(e.id)?.startConfirmed === false ? 'date not confirmed' : e.status})`);
      continue;
    }
    gated.push({ ...e, decision });
  }
  const withPolicy = await attachCancellation(gated.slice(0, limit), timezone);
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
  // Bounded (≤10 venues, ~1.1 s each) and never throw; new venues not geocoded this run get theirs next run.
  await geocodeVenues(10);
  const home = await geocodeUserHome(userId);
  stored = dropUnreachable(await withCoords(stored, home), ctx.maxTravelKm);
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
