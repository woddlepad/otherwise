import { utcToLocal } from './time';

/**
 * Listing sites, aggregators and resellers: fine for discovering events, but they don't sell the real ticket, so their
 * links rank below a venue's own page and their terms say nothing about the real cancellation policy.
 */
export const AGGREGATORS =
  /bandsintown|songkick|jambase|consequence\.net|concerts50|eventworld|venunite|jazzdatebook|jazznearyou|localgroove|broadwayworld|patchbay|allevents|evvnt|sanfrancisco\.theater|thebolditalic|sanjose\.com|sfstation|concertful|artelize|scenef|filmonfilm|dothebay|funcheap|timeout|ma\.to|stubhub|vividseats|seatgeek|ticketsmarter|gotickets|ticketsinventory|concertfix|eventbrite\.com\/d\//;

/**
 * Event taxonomy. `category` is one fixed value (filters, diversity, UI grouping); `tags` are free lowercase
 * genre/format words ("jazz", "35mm", "horror", "q&a") that carry the detail taste matching needs.
 * Exa's per-page extractor assigns both; `fallbackCategory` covers events it left unclassified.
 */
export const CATEGORIES = [
  'music',
  'film',
  'comedy',
  'theatre',
  'dance',
  'talk',          // lectures, readings, panels, author events
  'tech_meetup',   // meetups, hackathons, demo nights
  'art',           // exhibitions, openings, galleries, museums
  'food_drink',    // tastings, pop-ups, food festivals
  'nightlife',     // club nights, DJ sets, parties
  'sports',
  'workshop',      // classes, hands-on sessions
  'festival',
  'family',
  'other',
] as const;
export type EventCategory = (typeof CATEGORIES)[number];

export const CATEGORY_LABEL: Record<EventCategory, string> = {
  music: 'Music',
  film: 'Film',
  comedy: 'Comedy',
  theatre: 'Theatre',
  dance: 'Dance',
  talk: 'Talk',
  tech_meetup: 'Tech meetup',
  art: 'Art',
  food_drink: 'Food & drink',
  nightlife: 'Nightlife',
  sports: 'Sports',
  workshop: 'Workshop',
  festival: 'Festival',
  family: 'Family',
  other: 'Other',
};

const RULES: [EventCategory, RegExp][] = [
  ['film', /\b(film|cinema|screening|35mm|70mm|4k restoration|movie|theater\b.*\bfilm|imax|documentary)\b/i],
  ['comedy', /\b(comedy|stand-?up|comedian|improv|open mic comedy)\b/i],
  ['music', /\b(jazz|concert|live music|band|quartet|trio|quintet|orchestra|symphony|dj set|album release|tour|choir|recital)\b/i],
  ['theatre', /\b(theatre|theater|play|musical|opera|broadway|drama)\b/i],
  ['dance', /\b(ballet|dance performance|contemporary dance|tango)\b/i],
  ['tech_meetup', /\b(meetup|hackathon|demo night|startup|ai\b|developers?|founders?)\b/i],
  ['talk', /\b(talk|lecture|reading|book launch|panel|in conversation|author)\b/i],
  ['art', /\b(exhibition|gallery|opening reception|museum|art show)\b/i],
  ['food_drink', /\b(tasting|wine|beer|food|dinner|brunch|pop-?up)\b/i],
  ['nightlife', /\b(club night|party|rave|techno|house music)\b/i],
  ['workshop', /\b(workshop|class|course|masterclass)\b/i],
  ['sports', /\b(game|match|vs\.?|marathon|race)\b/i],
];

/** Keyword guess from title/venue/source query when the extractor didn't classify. */
export function fallbackCategory(text: string): EventCategory {
  return RULES.find(([, re]) => re.test(text))?.[0] ?? 'other';
}

export function normaliseCategory(raw: unknown, text: string): EventCategory {
  const c = typeof raw === 'string' ? raw.toLowerCase().trim().replace(/[\s&-]+/g, '_') : '';
  const aliases: Record<string, EventCategory> = { theater: 'theatre', meetup: 'tech_meetup', food: 'food_drink', club: 'nightlife', exhibition: 'art' };
  const cat = (CATEGORIES as readonly string[]).includes(c) ? (c as EventCategory) : aliases[c];
  return cat && cat !== 'other' ? cat : fallbackCategory(text);
}

export function normaliseTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const tags = raw
    .filter((t): t is string => typeof t === 'string')
    .map(t => t.toLowerCase().trim().replace(/\s+/g, ' '))
    .filter(t => t.length > 1 && t.length <= 30);
  return [...new Set(tags)].slice(0, 6);
}

export type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'late' | 'unknown';
export type PriceBand = 'free' | '$' | '$$' | '$$$' | 'unknown';

/** Attributes computed in code (deterministic, so filters and the policy can rely on them). */
export function deriveAttributes(e: { startsAt: Date; hasTime: boolean; priceMinCents: number | null; title: string; tags: string[] }, tz: string) {
  const local = utcToLocal(e.startsAt, tz);
  const hour = Number(local.slice(11, 13));
  const timeOfDay: TimeOfDay = !e.hasTime ? 'unknown' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 22 ? 'evening' : 'late';
  const weekday = new Date(`${local.slice(0, 10)}T12:00:00Z`).getUTCDay();
  const priceBand: PriceBand =
    e.priceMinCents === null ? 'unknown' : e.priceMinCents === 0 ? 'free' : e.priceMinCents < 2500 ? '$' : e.priceMinCents < 7500 ? '$$' : '$$$';
  const ageLimit = /\b21\+|21 and over|ages 21\b/i.test(`${e.title} ${e.tags.join(' ')}`) ? 21 : /\b18\+/i.test(e.title) ? 18 : null;
  return { timeOfDay, weekend: weekday === 0 || weekday === 6 || (weekday === 5 && hour >= 17), priceBand, ageLimit };
}
export type DerivedAttributes = ReturnType<typeof deriveAttributes>;

/**
 * Picks `n` events, best first, but no more than `maxPerCategory` from one category while others are available,
 * so the morning message isn't three horror films.
 */
export function diversify<T extends { category: EventCategory }>(ranked: T[], n: number, maxPerCategory = 1): T[] {
  const out: T[] = [];
  const count = new Map<EventCategory, number>();
  for (const e of ranked) {
    if (out.length >= n) break;
    if ((count.get(e.category) ?? 0) < maxPerCategory) {
      out.push(e);
      count.set(e.category, (count.get(e.category) ?? 0) + 1);
    }
  }
  for (const e of ranked) if (out.length < n && !out.includes(e)) out.push(e);
  return out;
}

/** Ticket availability as stated on the page (schema v3). */
export const STATUSES = [
  'on_sale',          // tickets/registration open
  'few_left',         // "almost sold out", "limited availability", "low tickets"
  'waitlist',         // sold out but a waitlist / standby line exists
  'sold_out',
  'not_yet_on_sale',  // announced, sales open later (see onSaleAt)
  'door_only',        // no advance sales, pay at the door / walk-in
  'free_rsvp',        // free, registration or RSVP required
  'free_entry',       // free, no registration
  'cancelled',
  'postponed',
  'unknown',
] as const;
export type EventStatus = (typeof STATUSES)[number];

/** Tolerant mapping of whatever the extractor (or a page) says to an EventStatus. */
export function normaliseStatus(raw: unknown): EventStatus {
  const s = typeof raw === 'string' ? raw.toLowerCase().trim().replace(/[\s-]+/g, '_') : '';
  if (!s) return 'unknown';
  if ((STATUSES as readonly string[]).includes(s)) return s as EventStatus;
  if (/wait_?list|standby/.test(s)) return 'waitlist';
  if (/sold_?out|no_tickets|unavailable/.test(s)) return 'sold_out';
  if (/cancel/.test(s)) return 'cancelled';
  if (/postpon|reschedul/.test(s)) return 'postponed';
  if (/not_yet|coming_soon|on_sale_(soon|at|on|date)|presale|pre_sale|announced/.test(s)) return 'not_yet_on_sale';
  if (/few|limited|low|almost|selling_fast|last/.test(s)) return 'few_left';
  if (/door|walk_?in|at_the_door/.test(s)) return 'door_only';
  if (/free/.test(s)) return /rsvp|regist|sign_?up/.test(s) ? 'free_rsvp' : 'free_entry';
  if (/rsvp|regist/.test(s)) return 'free_rsvp';
  if (/available|on_?sale|tickets|buy|open/.test(s)) return 'on_sale';
  return 'unknown';
}

/** Statuses that make an event useless to suggest. */
export const DEAD_STATUSES: readonly EventStatus[] = ['sold_out', 'cancelled', 'postponed'];
