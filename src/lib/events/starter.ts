import { waitUntil } from '@neon/functions';
import { db } from '../db';
import { DEAD_STATUSES, diversify, type EventCategory } from './classify';
import { DEFAULT_CITY, DEFAULT_TIMEZONE, defaultWindow, dropUnreachable, findCandidates } from './discover';
import { storeEvents } from './store';
import { formatLocal, utcToLocal } from './time';
import type { DiscoveryContext, PlannedQuery, StoredEvent, Window } from './types';

/**
 * Onboarding starter deck (docs/onboarding/PLAN.md): real upcoming events in the user's city to swipe during setup.
 * One pool per city (`starter_decks`, rebuilt after 24 h, no LLM), ~12 cards per user as `suggestions` with
 * source 'starter'. Swipes are taste signals for the onboarding analysis, not booking decisions.
 */

const DECK_HOURS = 24;
const STALE_MINUTES = 10;     // a 'building' row older than this counts as failed; also the retry pause after a failure
const POOL_SIZE = 36;         // events kept per city
const CARDS = 12;             // cards per user

export type DeckStatus = 'ready' | 'building' | 'failed' | 'empty';
export type Deck = { city: string; status: 'ready' | 'building' | 'failed'; eventIds: string[]; builtAt: Date | null };
export type Card = {
  suggestionId: string;
  title: string;
  category: EventCategory;
  tags: string[];
  when: string;               // "Sat 11 Oct · 20:00", date only when the page gave no time
  venue: string | null;
  price: string | null;
  url: string;
  image: string | null;
};

/** About 8 broad queries across categories: the deck should show range, not taste. */
export function STARTER_QUERIES(city: string, month: string): PlannedQuery[] {
  return [
    { query: `upcoming live music concerts in ${city} in ${month}, venue calendar with dates and tickets`, why: 'concerts' },
    { query: `stand-up comedy shows in ${city} in ${month} with dates and tickets`, why: 'stand-up' },
    { query: `independent cinema screenings and film events in ${city} in ${month}, showtimes and tickets`, why: 'cinema' },
    { query: `theatre and dance performances in ${city} in ${month}, schedule with dates and tickets`, why: 'theatre' },
    { query: `art exhibition openings and gallery events in ${city} in ${month}`, why: 'exhibitions' },
    { query: `club nights, DJ sets and parties in ${city} in ${month} with tickets`, why: 'club nights' },
    { query: `talks, author readings and lectures in ${city} in ${month} with registration`, why: 'talks' },
    { query: `food markets, tastings and pop-up events in ${city} in ${month}`, why: 'markets/food' },
  ];
}

/** Where a new user probably is, by phone prefix (longest match). Also gives known cities their timezone. */
const PLACES: { prefix: string; city: string; timezone: string; country: string }[] = [
  { prefix: '+1', city: 'San Francisco', timezone: 'America/Los_Angeles', country: 'US' },
  { prefix: '+49', city: 'Berlin', timezone: 'Europe/Berlin', country: 'DE' },
  { prefix: '+44', city: 'London', timezone: 'Europe/London', country: 'GB' },
  { prefix: '+33', city: 'Paris', timezone: 'Europe/Paris', country: 'FR' },
  { prefix: '+31', city: 'Amsterdam', timezone: 'Europe/Amsterdam', country: 'NL' },
  { prefix: '+32', city: 'Brussels', timezone: 'Europe/Brussels', country: 'BE' },
  { prefix: '+34', city: 'Madrid', timezone: 'Europe/Madrid', country: 'ES' },
  { prefix: '+39', city: 'Milan', timezone: 'Europe/Rome', country: 'IT' },
  { prefix: '+41', city: 'Zurich', timezone: 'Europe/Zurich', country: 'CH' },
  { prefix: '+43', city: 'Vienna', timezone: 'Europe/Vienna', country: 'AT' },
  { prefix: '+45', city: 'Copenhagen', timezone: 'Europe/Copenhagen', country: 'DK' },
  { prefix: '+46', city: 'Stockholm', timezone: 'Europe/Stockholm', country: 'SE' },
  { prefix: '+47', city: 'Oslo', timezone: 'Europe/Oslo', country: 'NO' },
  { prefix: '+48', city: 'Warsaw', timezone: 'Europe/Warsaw', country: 'PL' },
  { prefix: '+351', city: 'Lisbon', timezone: 'Europe/Lisbon', country: 'PT' },
  { prefix: '+353', city: 'Dublin', timezone: 'Europe/Dublin', country: 'IE' },
  { prefix: '+420', city: 'Prague', timezone: 'Europe/Prague', country: 'CZ' },
  { prefix: '+61', city: 'Sydney', timezone: 'Australia/Sydney', country: 'AU' },
  { prefix: '+65', city: 'Singapore', timezone: 'Asia/Singapore', country: 'SG' },
  { prefix: '+81', city: 'Tokyo', timezone: 'Asia/Tokyo', country: 'JP' },
];

export const cityKey = (city: string) => city.trim().toLowerCase().replace(/\s+/g, ' ');

export function guessFromPhone(phone: string | null | undefined): { city: string; timezone: string } {
  const p = [...PLACES].sort((a, b) => b.prefix.length - a.prefix.length).find(x => phone?.startsWith(x.prefix));
  return p ? { city: p.city, timezone: p.timezone } : { city: DEFAULT_CITY, timezone: DEFAULT_TIMEZONE };
}

/** The user's city (typed, else guessed from the phone) and its timezone (known city > browser > phone guess). */
export function userCity(u: { phone: string; city: string | null; timezone: string | null }) {
  const guess = guessFromPhone(u.phone);
  const city = u.city?.trim() || guess.city;
  const known = PLACES.find(p => cityKey(p.city) === cityKey(city));
  return { city, timezone: known?.timezone ?? u.timezone ?? guess.timezone };
}

const countryFor = (tz: string) => PLACES.find(p => p.timezone === tz)?.country ?? (tz.startsWith('America/') ? 'US' : undefined);

/** "October 2026", or "October–November 2026" when the window spans two months. */
function monthLabel(w: Window, tz: string) {
  const f = (d: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { ...o, timeZone: tz }).format(d);
  const a = f(w.from, { month: 'long' });
  const b = f(w.to, { month: 'long' });
  return a === b ? `${a} ${f(w.to, { year: 'numeric' })}` : `${a}–${b} ${f(w.to, { year: 'numeric' })}`;
}

// ---------- the city deck ----------

async function getDeck(key: string): Promise<Deck | null> {
  const { rows } = await db.query(`SELECT city, status, event_ids, built_at FROM starter_decks WHERE city_key = $1`, [key]);
  const r = rows[0];
  return r ? { city: r.city, status: r.status, eventIds: r.event_ids ?? [], builtAt: r.built_at } : null;
}

/**
 * Takes the build lock for a city: no row yet, a failed or empty build (after a pause), a stale 'building', or a
 * ready deck older than DECK_HOURS (`force`: any deck not being built right now). Keeps the old event_ids meanwhile.
 */
async function claimBuild(key: string, city: string, force: boolean) {
  const { rowCount } = await db.query(
    `INSERT INTO starter_decks (city_key, city, status, started_at) VALUES ($1, $2, 'building', now())
     ON CONFLICT (city_key) DO UPDATE SET status = 'building', started_at = now(), city = EXCLUDED.city
     WHERE ($5 AND starter_decks.status <> 'building')
        OR (starter_decks.started_at < now() - make_interval(mins => $3)
            AND (starter_decks.status IN ('building', 'failed') OR cardinality(starter_decks.event_ids) = 0))
        OR (starter_decks.status = 'ready' AND starter_decks.built_at < now() - make_interval(hours => $4))`,
    [key, city, STALE_MINUTES, DECK_HOURS, force],
  );
  return rowCount === 1;
}

/**
 * The city's deck. Builds it when missing or expired (one build per city at a time). With an older deck still
 * usable (unless `wait: true`), or `wait: false`, the build runs in the background and the current state is returned.
 */
export async function ensureStarterDeck(
  city: string,
  timezone: string,
  opts: { wait?: boolean; force?: boolean } = {},
): Promise<Deck> {
  const key = cityKey(city);
  const claimed = await claimBuild(key, city, opts.force ?? false);
  const deck = (await getDeck(key))!;
  if (!claimed) return deck;
  const build = buildDeck(key, city, timezone);
  if (opts.wait === false || (opts.wait === undefined && deck.eventIds.length)) {
    waitUntil(build.catch(err => console.warn('[starter] background build failed:', String(err).slice(0, 200))));
    return deck;
  }
  return build;
}

/** Search (fixed queries, no LLM) → store → pick a varied pool → fill in missing photos. Never throws. */
async function buildDeck(key: string, city: string, timezone: string): Promise<Deck> {
  const t0 = Date.now();
  try {
    const ctx: DiscoveryContext = {
      city,
      timezone,
      country: countryFor(timezone),
      window: defaultWindow(14),
      taste: { profile: null, summary: null, notes: [], autoBookConfidence: 0.85, askConfidence: 0.5 },
    };
    const found = await findCandidates(ctx, { queries: STARTER_QUERIES(city, monthLabel(ctx.window, timezone)) });
    const stored = dropUnreachable(await storeEvents(found.candidates));
    const pool = pickPool(stored, city);
    await fillImages(pool);
    await db.query(
      `UPDATE starter_decks SET status = 'ready', built_at = now(), event_ids = $2, cost_dollars = $3 WHERE city_key = $1`,
      [key, pool.map(e => e.id), found.costDollars],
    );
    console.info(
      `[starter] ${city}: ${found.candidates.length} candidates → ${stored.length} stored → ${pool.length} in the deck ` +
        `(${pool.filter(e => isPhoto(e.image)).length} with a photo), $${found.costDollars.toFixed(3)}, ${Date.now() - t0} ms`,
    );
  } catch (err) {
    console.warn(`[starter] building the ${city} deck failed:`, String(err).slice(0, 300));
    await db.query(`UPDATE starter_decks SET status = 'failed' WHERE city_key = $1`, [key]).catch(() => {});
  }
  return (await getDeck(key))!;
}

const LIVE: readonly string[] = ['on_sale', 'few_left', 'free_rsvp', 'free_entry', 'door_only'];
const titleKey = (t: string) => t.toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

// Cancelled in the title only, a season/month overview ("Konzerthaus Berlin – October 2026 concert"), or a page
// template's placeholder ("slide_title_2").
const NOT_AN_EVENT =
  /^\S*_\S*$|fällt aus|abgesagt|ausverkauft|verschoben|cancell?ed|postponed|sold out|\bseason\b|special events|\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}\b/i;

/**
 * Swipe-worthy first (in person, in the city itself, a real start time, a photo, known availability and price),
 * soonest first, one per title.
 */
function pickPool(events: StoredEvent[], city: string): StoredEvent[] {
  const soon = Date.now() + 2 * 3_600_000;
  const appeal = (e: StoredEvent) =>
    (e.hasTime ? 4 : -2) + (isPhoto(e.image) ? 3 : 0) + (LIVE.includes(e.status) ? 2 : 0) + (e.priceText || e.priceMinCents === 0 ? 1 : 0) +
    (e.venue ? 1 : 0) + (e.url !== e.pageUrl ? 1 : 0) - (e.category === 'other' ? 3 : 0);
  const seen = new Set<string>();
  const ranked = events
    .filter(e => !e.online && e.startsAt.getTime() > soon && cityKey(e.city) === cityKey(city) && !NOT_AN_EVENT.test(e.title))
    .sort((a, b) => appeal(b) - appeal(a) || a.startsAt.getTime() - b.startsAt.getTime())
    // storeEvents can map two candidates onto one row (same dedupe key or source URL): one card per row and per
    // title; at one venue "Tresor Klubnacht | Tresor Berlin" is the same title as "Tresor Klubnacht".
    .filter(e => {
      const t = titleKey(e.title);
      const v = (e.venue ?? '').toLowerCase();
      if (seen.has(e.id) || seen.has(t) || [...seen].some(k => k.startsWith(`${v}|`) && (k.slice(v.length + 1).startsWith(t) || t.startsWith(k.slice(v.length + 1))))) return false;
      seen.add(e.id).add(t).add(`${v}|${t}`);
      return true;
    });
  return diversify(ranked, POOL_SIZE, 6);
}

/** Exa's and pages' og:image is sometimes the site's logo or seal: no use as an event photo. */
export const isPhoto = (src: string | null | undefined): src is string =>
  !!src && /^https:\/\//.test(src) && !/logo|favicon|sprite|placeholder|seal|default[-_]?(og|share|image)|\.svg(\?|$)/i.test(src);

/** og:image of each event's own page, for pool events Exa gave no photo for. Bounded (5 s per page), never throws. */
async function fillImages(events: StoredEvent[]) {
  await Promise.all(
    events
      .filter(e => !isPhoto(e.image) && e.url !== e.pageUrl)
      .map(async e => {
        const image = await ogImage(e.url);
        if (!image) return;
        e.image = image;
        await db.query(`UPDATE events SET details = details || jsonb_build_object('image', $2::text) WHERE id = $1`, [e.id, image]);
      }),
  ).catch(err => console.warn('[starter] images failed:', String(err).slice(0, 200)));
}

/** The page's og:image / twitter:image (absolute URL), from the first 256 KB of its HTML; null if none or not HTML. */
export async function ogImage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; booking-agent/0.1)', Accept: 'text/html' },
    });
    if (!res.ok || !res.body || !/html/i.test(res.headers.get('content-type') ?? '')) return null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let html = '';
    while (html.length < 262_144 && !/<\/head>/i.test(html)) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
    }
    reader.cancel().catch(() => {});
    for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
      const attrs = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1].toLowerCase(), m[2] ?? m[3]]));
      const name = (attrs.property ?? attrs.name ?? '').toLowerCase();
      if (!/^(og:image(:secure_url|:url)?|twitter:image(:src)?)$/.test(name) || !attrs.content) continue;
      const src = new URL(attrs.content.replace(/&amp;/g, '&'), res.url).toString();
      if (isPhoto(src)) return src;
    }
  } catch {
    // timeouts, TLS errors, bad markup: no photo, the UI uses a category picture
  }
  return null;
}

// ---------- the user's cards ----------

type DeckUser = { id: string; phone: string; city: string | null; timezone: string | null; starter_city: string | null };

async function loadUser(userId: string): Promise<DeckUser> {
  const { rows } = await db.query<DeckUser>(`SELECT id, phone, city, timezone, starter_city FROM users WHERE id = $1`, [userId]);
  if (!rows[0]) throw new Error(`unknown user ${userId}`);
  return rows[0];
}

/** Strict round-robin over categories, so two cards in a row are rarely the same kind of thing. */
function interleave<T extends { category: EventCategory }>(events: T[]): T[] {
  const groups = new Map<EventCategory, T[]>();
  for (const e of events) groups.set(e.category, [...(groups.get(e.category) ?? []), e]);
  const out: T[] = [];
  while (out.length < events.length) for (const g of groups.values()) if (g.length) out.push(g.shift()!);
  return out;
}

/**
 * Gives the user ~12 starter cards from their city's deck (building it if needed). Idempotent: does nothing when
 * already seeded for this city; on a city change, unswiped cards of the old city expire. `wait: false` doesn't wait
 * for a deck build (the next call seeds). Returns the deck status as the API reports it.
 */
export async function seedStarterSuggestions(userId: string, opts: { wait?: boolean } = {}): Promise<DeckStatus> {
  const u = await loadUser(userId);
  const { city, timezone } = userCity(u);
  const key = cityKey(city);
  if (u.starter_city === key) {
    await replaceJunkCards(userId, key);
    return deckStatusOf(u);
  }
  const deck = await ensureStarterDeck(city, timezone, { wait: opts.wait });
  if (!deck.eventIds.length) return deck.status === 'ready' ? 'empty' : deck.status;

  const picks = interleave(diversify(await pickable(userId, deck.eventIds, false), CARDS, 2));

  // One seeding per user at a time (onboardingReply, the deck poll and a city change can race).
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('starter:' || $1))`, [userId]);
    const { rows: [now] } = await client.query(`SELECT starter_city FROM users WHERE id = $1`, [userId]);
    if (now.starter_city !== key) {
      await client.query(
        `UPDATE suggestions SET status = 'expired' WHERE user_id = $1 AND source = 'starter' AND status = 'suggested' AND reaction IS NULL`,
        [userId],
      );
      for (const e of picks) {
        // clock_timestamp() per row keeps the deck order; an old unswiped card for this event comes back.
        await client.query(
          `INSERT INTO suggestions (user_id, event_id, source, status, created_at) VALUES ($1, $2, 'starter', 'suggested', clock_timestamp())
           ON CONFLICT (user_id, event_id) DO UPDATE SET status = 'suggested', created_at = clock_timestamp()
           WHERE suggestions.source = 'starter' AND suggestions.reaction IS NULL`,
          [userId, e.id],
        );
      }
      await client.query(`UPDATE users SET starter_city = $2 WHERE id = $1`, [userId, key]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return picks.length ? 'ready' : 'empty';
}

/**
 * Pool events the user can still get as cards, in pool order: upcoming, attendable, really an event, and not already
 * theirs (`anyCard`: no suggestion row at all; else only swiped cards and non-starter suggestions count).
 */
async function pickable(userId: string, eventIds: string[], anyCard: boolean) {
  const { rows } = await db.query<{ id: string; category: EventCategory; title: string }>(
    `SELECT e.id, e.category, e.title FROM events e
     WHERE e.id = ANY($1::uuid[]) AND e.starts_at > now() + interval '1 hour' AND NOT (e.status = ANY($2::text[]))
       AND NOT EXISTS (SELECT 1 FROM suggestions s WHERE s.user_id = $3 AND s.event_id = e.id
                       AND ($4 OR s.source <> 'starter' OR s.reaction IS NOT NULL))
     ORDER BY array_position($1::uuid[], e.id)`,
    [eventIds, DEAD_STATUSES, userId, anyCard],
  );
  return rows.filter(r => !NOT_AN_EVENT.test(r.title));
}

/** Expires unswiped cards that turned out not to be events (seeded before a filter existed) and tops the deck back up. */
async function replaceJunkCards(userId: string, key: string) {
  const { rows } = await db.query<{ id: string; title: string }>(
    `SELECT s.id, e.title FROM suggestions s JOIN events e ON e.id = s.event_id
     WHERE s.user_id = $1 AND s.source = 'starter' AND s.status = 'suggested' AND s.reaction IS NULL`,
    [userId],
  );
  const junk = rows.filter(r => NOT_AN_EVENT.test(r.title)).map(r => r.id);
  if (!junk.length) return;
  await db.query(`UPDATE suggestions SET status = 'expired' WHERE id = ANY($1::uuid[])`, [junk]);
  const deck = await getDeck(key);
  const extra = deck ? diversify(await pickable(userId, deck.eventIds, true), junk.length, 2) : [];
  for (const e of extra) {
    await db.query(
      `INSERT INTO suggestions (user_id, event_id, source, status, created_at) VALUES ($1, $2, 'starter', 'suggested', clock_timestamp())
       ON CONFLICT (user_id, event_id) DO NOTHING`,
      [userId, e.id],
    );
  }
}

/** Seeded for the current city: 'ready' if any starter card exists (even all swiped), else 'empty'. */
async function deckStatusOf(u: DeckUser): Promise<DeckStatus> {
  const { rows } = await db.query(
    `SELECT 1 FROM suggestions WHERE user_id = $1 AND source = 'starter' AND (status = 'suggested' OR reaction IS NOT NULL) LIMIT 1`,
    [u.id],
  );
  return rows.length ? 'ready' : 'empty';
}

const SYMBOL: Record<string, string> = { EUR: '€', USD: '$', GBP: '£' };

/** "Free", the page's price text when short, else "from €9" from the parsed minimum; null if unknown. */
function cardPrice(d: { priceText?: string | null; priceMinCents?: number | null; priceCurrency?: string | null }) {
  if (d.priceMinCents === 0) return 'Free';
  if (d.priceText && d.priceText.length <= 24) return d.priceText;
  if (d.priceMinCents) return `from ${SYMBOL[d.priceCurrency ?? ''] ?? ''}${(d.priceMinCents / 100).toFixed(d.priceMinCents % 100 ? 2 : 0)}${SYMBOL[d.priceCurrency ?? ''] ? '' : ` ${d.priceCurrency ?? ''}`.trimEnd()}`;
  return null;
}

/** For `GET /onboard/deck`: seeds when needed (without waiting for a build), then the unswiped cards in deck order. */
export async function starterDeckFor(userId: string): Promise<{ city: string; status: DeckStatus; cards: Card[] }> {
  const status = await seedStarterSuggestions(userId, { wait: false });
  const u = await loadUser(userId);
  const { city, timezone } = userCity(u);
  if (u.starter_city !== cityKey(city)) return { city, status, cards: [] };
  const { rows } = await db.query(
    `SELECT s.id, e.title, e.category, e.tags, e.venue, e.starts_at, e.source_url, e.details
     FROM suggestions s JOIN events e ON e.id = s.event_id
     WHERE s.user_id = $1 AND s.source = 'starter' AND s.status = 'suggested' AND s.reaction IS NULL
       AND (e.starts_at > now() OR (e.details->>'hasTime' = 'false' AND e.starts_at > now() - interval '1 day'))
     ORDER BY s.created_at`,
    [userId],
  );
  const cards = rows.map((r): Card => {
    const d = r.details ?? {};
    const at = new Date(r.starts_at);
    return {
      suggestionId: r.id,
      title: r.title,
      category: r.category,
      tags: (r.tags ?? []).slice(0, 5),
      when: d.hasTime === false ? formatLocal(at, timezone, false) : `${formatLocal(at, timezone, false)} · ${utcToLocal(at, timezone).slice(11, 16)}`,
      venue: r.venue ?? null,
      price: cardPrice(d),
      url: d.eventUrl ?? r.source_url.replace(/#t=.*$/, ''),
      image: isPhoto(d.image) ? d.image : null,
    };
  });
  return { city, status, cards };
}

/** Stores a swipe on a starter card plus a feedback row (taste only: the auto-book threshold doesn't move). */
export async function recordSwipe(userId: string, suggestionId: string, verdict: 'like' | 'dislike') {
  const { rows } = await db.query(
    `UPDATE suggestions s SET reaction = $3, reacted_at = now() FROM events e
     WHERE s.id = $2 AND s.user_id = $1 AND s.source = 'starter' AND e.id = s.event_id
     RETURNING e.title`,
    [userId, suggestionId, verdict],
  );
  if (!rows[0]) return null;
  // A changed mind replaces the earlier swipe's feedback instead of adding a second one.
  await db.query(`DELETE FROM feedback WHERE suggestion_id = $1 AND note = 'onboarding swipe'`, [suggestionId]);
  await db.query(
    `INSERT INTO feedback (user_id, suggestion_id, event_title, kind, note) VALUES ($1, $2, $3, $4, 'onboarding swipe')`,
    [userId, suggestionId, rows[0].title, verdict === 'like' ? 'liked' : 'disliked'],
  );
  const { rows: [n] } = await db.query(
    `SELECT count(*) FILTER (WHERE reaction = 'like')::int AS liked, count(*) FILTER (WHERE reaction = 'dislike')::int AS disliked
     FROM suggestions WHERE user_id = $1 AND source = 'starter'`,
    [userId],
  );
  return n as { liked: number; disliked: number };
}

/** The user's swipes for the onboarding analysis, oldest first. */
export async function starterSwipes(userId: string) {
  const { rows } = await db.query<{ reaction: 'like' | 'dislike'; title: string; category: string; tags: string[]; venue: string | null }>(
    `SELECT s.reaction, e.title, e.category, e.tags, e.venue FROM suggestions s JOIN events e ON e.id = s.event_id
     WHERE s.user_id = $1 AND s.source = 'starter' AND s.reaction IS NOT NULL ORDER BY s.reacted_at`,
    [userId],
  );
  return rows;
}
