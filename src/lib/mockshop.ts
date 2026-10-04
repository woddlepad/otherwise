import { createHmac, timingSafeEqual } from 'node:crypto';
import { publicUrl } from './connections';
import { db } from './db';
import type { PageEvents } from './events/exa';
import { utcToLocal, zonedToUtc } from './events/time';
import type { DiscoveryContext } from './events/types';

/**
 * "Ticketeria", a small fake Berlin ticket shop for testing the booking flow end to end (routes in
 * src/mastra/routes/mockshop.ts). Everything mock is behind MOCK_SHOP=1: the shop's pages, and its events
 * showing up in discovery (findCandidates) as one more extracted listing page.
 *
 * Variants: free-rsvp (no payment), paid (listed price is the total), fees-at-checkout (a service fee
 * appears only on the payment page), login-required (checkout needs a shop account: any email + password "demo").
 */

export const mockShopEnabled = () => process.env.MOCK_SHOP === '1';

export const SHOP_NAME = 'Ticketeria';
export const SHOP_TZ = 'Europe/Berlin';
export const SHOP_PATH = '/mock/shop';
export const MEMBER_PASSWORD = 'demo';

export type Variant = 'free-rsvp' | 'paid' | 'fees-at-checkout' | 'login-required';
export type TicketType = { id: string; name: string; priceCents: number };

export type MockEvent = {
  slug: string;
  title: string;
  blurb: string;
  category: string;
  tags: string[];
  venue: string;
  address: string;
  weekday: number;             // 0 = Sunday: the show runs weekly, next date is always within 7 days
  times: string[];             // local showtimes, "HH:MM"
  ticketTypes: TicketType[];   // first = standard, its price is the listed one
  feeCents?: number;           // per ticket, fees-at-checkout only
  variant: Variant;
};

const types = (standard: number, reduced?: number): TicketType[] =>
  standard === 0
    ? [{ id: 'free', name: 'Free RSVP', priceCents: 0 }]
    : [
        { id: 'standard', name: 'Standard', priceCents: standard },
        ...(reduced ? [{ id: 'reduced', name: 'Reduced (students, with ID)', priceCents: reduced }] : []),
      ];

export const CATALOGUE: MockEvent[] = [
  {
    slug: 'quiet-hours-trio',
    title: 'Quiet Hours Trio · late-night jazz',
    blurb: 'Piano, upright bass and brushes in a 60-seat cellar. Ballads, Monk and a few originals; two sets.',
    category: 'music',
    tags: ['jazz', 'trio', 'small venue'],
    venue: 'Kellerklang',
    address: 'Weserstraße 58, 12045 Berlin',
    weekday: 2,
    times: ['21:00'],
    ticketTypes: types(1400, 1000),
    variant: 'paid',
  },
  {
    slug: 'nocturne-small-city',
    title: 'Nocturne for a Small City (OmU) + director Q&A',
    blurb: 'Indie drama shot over one winter in Görlitz. Original with English subtitles; the director stays for a Q&A after the 18:30 show.',
    category: 'film',
    tags: ['indie', 'arthouse', 'q&a'],
    venue: 'Kino Lichtspalt',
    address: 'Lausitzer Platz 13, 10997 Berlin',
    weekday: 3,
    times: ['18:30', '21:00'],
    ticketTypes: types(1750, 1300),
    feeCents: 390,
    variant: 'fees-at-checkout',
  },
  {
    slug: 'sonnenallee-big-band',
    title: 'Sonnenallee Big Band plays Ellington',
    blurb: 'Seventeen players, the Far East Suite and a few deep cuts. Seated, bar open from 19:00.',
    category: 'music',
    tags: ['jazz', 'big band'],
    venue: 'Saal Neukölln',
    address: 'Karl-Marx-Straße 141, 12043 Berlin',
    weekday: 4,
    times: ['20:00'],
    ticketTypes: types(2600, 1900),
    variant: 'paid',
  },
  {
    slug: 'the-salt-year-preview',
    title: "Members' preview: The Salt Year (OmU)",
    blurb: 'Lichtspalt film club preview of the Baltic-coast indie before its release. Sign in with your Ticketeria account to book.',
    category: 'film',
    tags: ['indie', 'preview', 'film club'],
    venue: 'Kino Lichtspalt',
    address: 'Lausitzer Platz 13, 10997 Berlin',
    weekday: 5,
    times: ['20:15'],
    ticketTypes: types(900),
    variant: 'login-required',
  },
  {
    slug: 'indie-film-club-shorts',
    title: 'Indie Film Club Berlin: shorts night & meetup',
    blurb: 'Five local shorts, then drinks with the filmmakers. Free, but RSVP so we know how many chairs to put out.',
    category: 'film',
    tags: ['indie', 'shorts', 'meetup'],
    venue: 'Werkstatt Wedding',
    address: 'Gerichtstraße 23, 13347 Berlin',
    weekday: 6,
    times: ['19:30'],
    ticketTypes: types(0),
    variant: 'free-rsvp',
  },
  {
    slug: 'cities-after-cars',
    title: 'Cities After Cars: talk & discussion',
    blurb: 'Urbanist Mira Okafor on what Berlin could do with 20% of its parking space. Followed by an open discussion.',
    category: 'talk',
    tags: ['urbanism', 'talk'],
    venue: 'Haus der Ideen',
    address: 'Linienstraße 40, 10119 Berlin',
    weekday: 0,
    times: ['19:00'],
    ticketTypes: types(800, 500),
    variant: 'paid',
  },
];

export const findMockEvent = (slug: string) => CATALOGUE.find(e => e.slug === slug);
export const isFree = (e: MockEvent) => e.variant === 'free-rsvp';
export const standardPrice = (e: MockEvent) => e.ticketTypes[0].priceCents;

/**
 * Local "YYYY-MM-DDTHH:MM" showtimes on the event's next weekday (Berlin) whose last show hasn't started yet. Weekly
 * rather than "N days from today", so a date found in discovery stays bookable across midnight until the show is over.
 */
export function showtimes(e: MockEvent, now = new Date()): string[] {
  const today = utcToLocal(now, SHOP_TZ).slice(0, 10);
  const noon = Date.parse(`${today}T12:00:00Z`);
  for (let add = (e.weekday - new Date(noon).getUTCDay() + 7) % 7; ; add += 7) {
    const day = new Date(noon + add * 86_400_000).toISOString().slice(0, 10);
    const last = zonedToUtc(`${day}T${e.times.at(-1)}`, SHOP_TZ);
    if (last && last > now) return e.times.map(t => `${day}T${t}`);
  }
}

export const eventUrl = (slug: string) => publicUrl(`${SHOP_PATH}/e/${slug}`);
export const isMockShopUrl = (u: string | null | undefined) => Boolean(u && mockShopEnabled() && u.startsWith(publicUrl(SHOP_PATH)));

export const euro = (cents: number) => `€${(cents / 100).toFixed(2)}`;

/** What an order costs: the listed price × qty, plus the per-ticket fee only fees-at-checkout reveals at payment. */
export function priceOrder(e: MockEvent, typeId: string, qty: number) {
  const type = e.ticketTypes.find(t => t.id === typeId) ?? e.ticketTypes[0];
  const subtotal = type.priceCents * qty;
  const fees = (e.feeCents ?? 0) * qty;
  return { type, subtotal, fees, total: subtotal + fees };
}

// ---------- signed tokens: the cart travels in the URL, the shop login in a cookie ----------

const secret = () => process.env.MOCK_SHOP_SECRET || process.env.DEV_FORWARD_SECRET || 'ticketeria-dev';
const mac = (data: string) => createHmac('sha256', secret()).update(data).digest('base64url');

export function sign(value: object) {
  const data = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${data}.${mac(data)}`;
}

export function verify<T>(token: string | undefined | null): T | null {
  const [data, sig] = (token ?? '').split('.');
  if (!data || !sig) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(mac(data));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString()) as T;
  } catch {
    return null;
  }
}

/** The only card number the shop accepts (the booking flow's test card unless MOCK_SHOP_CARD overrides it). */
export const acceptedCard = () => (process.env.MOCK_SHOP_CARD || process.env.BOOKING_CARD_NUMBER || '').replace(/\D/g, '');

// ---------- discovery ----------

/**
 * The shop's catalogue as one extracted "listing page", so mock events go through the normal normalise → store →
 * rate → pick path (toCandidates applies the window and category filters). Berlin users only: that's where the shop is.
 */
export function mockShopPage(ctx: DiscoveryContext): PageEvents | null {
  if (!mockShopEnabled() || !/^berlin\b/i.test(ctx.city.trim())) return null;
  return {
    pageUrl: publicUrl(SHOP_PATH),
    pageTitle: `${SHOP_NAME} · Berlin`,
    pageKind: 'listing',
    query: 'mock shop',
    events: CATALOGUE.flatMap(e =>
      showtimes(e).map(start => ({
        title: e.title,
        // Shop times are Berlin wall clock; toCandidates reads offset-less times in the user's timezone.
        start: ctx.timezone === SHOP_TZ ? start : (zonedToUtc(start, SHOP_TZ)?.toISOString() ?? start),
        venueName: e.venue,
        address: e.address,
        city: 'Berlin',
        online: false,
        price: isFree(e) ? 'Free (RSVP)' : euro(standardPrice(e)),
        url: eventUrl(e.slug),
        bookingUrl: eventUrl(e.slug),
        status: isFree(e) ? 'free_rsvp' : 'on_sale',
        category: e.category,
        tags: e.tags,
      })),
    ),
  };
}

/** The shop's refund terms, cached like any venue's policy so picks show it without a web lookup. */
export async function rememberMockPolicy() {
  const domain = new URL(publicUrl()).hostname.replace(/^www\./, '');
  await db.query(
    `INSERT INTO venue_policies (domain, kind, hours_before_start, fee, quote, source_url, method, contact, transferable, checked_at)
     VALUES ($1, 'free_cancellation', 24, NULL, $2, $3, 'online_self_service', $3, true, now())
     ON CONFLICT (domain) DO UPDATE SET kind = EXCLUDED.kind, hours_before_start = 24, quote = EXCLUDED.quote,
       source_url = EXCLUDED.source_url, method = EXCLUDED.method, contact = EXCLUDED.contact, transferable = true, checked_at = now()`,
    [domain, 'Tickets can be cancelled free of charge in your Ticketeria order up to 24 hours before the show.', publicUrl(`${SHOP_PATH}/terms`)],
  );
}
