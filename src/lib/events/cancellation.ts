import Exa from 'exa-js';
import { z } from 'zod';
import { scout } from '../../mastra/agents/scout';
import { db } from '../db';
import { AGGREGATORS } from './classify';
import { formatLocal } from './time';
import { detectPlatform, platformCancellation, type CancelMethod, type PlatformId } from './platforms';
import type { EventPagePolicy } from './status';
import type { StoredEvent } from './types';

/**
 * Cancellation / refund policy per event (PLAN §9). The agent may book before the user confirms ("surprise" bookings),
 * so it must know whether and until when it can undo a booking. Precedence: what THIS event's page says (ticket
 * platforms show the organiser's policy per event; read during the live re-check, status.ts) > the venue's or ticket
 * shop's general policy (FAQ / ticket-policy page, looked up once per domain and cached) > the ticket platform's
 * default (platforms.ts) > unknown.
 */

export type PolicyKind = 'free_event' | 'free_cancellation' | 'refund_with_fee' | 'exchange_or_credit_only' | 'no_refunds' | 'unknown';

export type { CancelMethod, PlatformId };
export const CANCEL_METHODS = ['online_self_service', 'email', 'phone', 'box_office', 'not_possible', 'unknown'] as const satisfies readonly CancelMethod[];

export type PolicyScope = 'event' | 'venue' | 'platform' | 'none';
export type PolicySource = 'event_page' | 'venue_policy' | 'platform_default' | 'confirmation_email' | 'none';

/** A venue / ticket-shop domain's general policy (venue_policies), or one event page's classified text. */
export type DomainPolicy = {
  kind: PolicyKind;
  method: CancelMethod;              // how a booking is cancelled; only online_self_service / email can be done by the agent
  contact: string | null;            // URL / email / phone to cancel through
  transferable: boolean | null;      // tickets may be passed to someone else; null = not stated
  hoursBeforeStart: number | null;   // latest cancellation for a refund/credit; null = not stated
  fee: string | null;
  quote: string | null;              // verbatim policy text
  sourceUrl: string | null;
  domain: string;
};

export type CancellationPolicy = DomainPolicy & {
  scope: PolicyScope;                // whose policy this is: this event's, the venue's, the platform's default, or none known
  source: PolicySource;
  cancellationUrl: string | null;    // verified cancel/manage link from the event page, else the platform's order page
  policyUrl: string | null;          // page stating the policy: event page link, else venue policy page, else platform policy
  platform: PlatformId | null;       // ticket platform selling this event, if known
};

export type CancellationInfo = CancellationPolicy & {
  cancelBy: string | null;           // ISO instant: last moment to cancel under this policy
  checkedAt: string | null;          // ISO: when this result was worked out (reused for 24 h)
  summary: string;                   // one line for WhatsApp / the agent
};

const CACHE_DAYS = 7;
const EVENT_REUSE_HOURS = 24;        // a stored per-event result is reused this long
const MIN_HOURS_TO_DECIDE = 12;      // a surprise booking must leave the user at least this long to say "no thanks"
const DEFAULT_DEADLINE_HOURS = 24;   // free cancellation without a stated deadline: assume it ends a day before

// Ticket platforms where the policy is set per event by the organiser and shown on the event page.
const PER_EVENT = /eventbrite\.|lu\.ma|luma\.com|dice\.fm|universe\.com|tixr\.com|seetickets|ticketweb|withfriends|partiful/;

const POLICY_PAGE = /faq|polic|terms|ticket-?info|refund|help|support|plan-your-visit|box-?office/i;

let exa: Exa | undefined;
const getExa = () => (exa ??= new Exa(process.env.EXA_API_KEY));

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '').replace(/^tickets?\./, '');
  } catch {
    return '';
  }
};

const quoteSchema = {
  type: 'object',
  properties: {
    quote: {
      type: 'string',
      description:
        'the general ticket policy: exact sentence(s) about refunds, cancellation, exchanges or "all sales final", verbatim, ' +
        'including the sentence before it for context. Empty if the page only mentions refunds for shows the venue cancelled.',
    },
  },
  required: ['quote'],
};
const QUOTE_QUERY = 'What can a ticket buyer do if they cannot attend: refund, exchange, credit, transfer, deadline, fees?';

/** Raw policy text for a venue domain (site search) or a per-event platform page. */
async function fetchPolicyText(domain: string, eventUrl: string) {
  const parse = (s: unknown) => {
    try {
      return (JSON.parse(String(s)).quote as string) || '';
    } catch {
      return '';
    }
  };
  if (PER_EVENT.test(domain)) {
    const r = await getExa().getContents([eventUrl], { maxAgeHours: 72, summary: { query: QUOTE_QUERY, schema: quoteSchema } });
    return r.results.map(x => ({ url: x.url, quote: parse((x as { summary?: unknown }).summary) })).filter(x => x.quote);
  }
  const r = await getExa().search('ticket refund, exchange and cancellation policy for ticket buyers', {
    type: 'auto',
    numResults: 3,
    includeDomains: [domain],
    contents: { summary: { query: QUOTE_QUERY, schema: quoteSchema } },
  });
  return r.results.map(x => ({ url: x.url, quote: parse((x as { summary?: unknown }).summary) })).filter(x => x.quote);
}

const classifySchema = z.object({
  policies: z.array(
    z.object({
      domain: z.string(),
      kind: z.enum(['free_cancellation', 'refund_with_fee', 'exchange_or_credit_only', 'no_refunds', 'unknown']),
      hoursBeforeStart: z.number().nullable().describe('latest cancellation for refund/credit in hours before start; null if not stated'),
      fee: z.string().nullable(),
      quote: z.string().nullable().describe('the single most relevant sentence, verbatim from the texts'),
      sourceUrl: z.string().nullable(),
      method: z
        .enum(CANCEL_METHODS)
        .describe('how a buyer cancels: online_self_service (account/order page), email, phone, box_office (in person), not_possible, unknown'),
      contact: z.string().nullable().describe('the URL, email address or phone number to cancel through, verbatim; null if not stated'),
      transferable: z.boolean().nullable().describe('true if tickets may be transferred to another person, false if explicitly not; null if not stated'),
    }),
  ),
});

/** One LLM call classifies all fetched policy texts; conservative: anything ambiguous is "unknown" or stricter. */
async function classify(texts: { domain: string; snippets: { url: string; quote: string }[] }[]): Promise<DomainPolicy[]> {
  if (!texts.length) return [];
  const prompt = `For each ticket seller below, classify what a buyer of a regular single ticket can do if they cancel.
- free_cancellation: full refund on request (possibly until a deadline)
- refund_with_fee: refund minus a fee
- exchange_or_credit_only: no money back, but exchange / account credit / transfer to another show
- no_refunds: all sales final, at most transferable to another person
- unknown: the texts don't say, or only talk about memberships, cancelled shows, or other products
Be conservative: if texts conflict, pick the stricter one. Ignore refunds for performances the venue cancels or
reschedules, and one-off notices about particular screenings/shows (technical problems, a single sold-out night):
only the general policy for normal tickets counts.
Also give the cancellation method (how the buyer requests it), the contact (URL/email/phone) if stated, and whether
tickets are transferable to another person (null if not stated).

${texts.map(t => `## ${t.domain}\n${t.snippets.map(s => `[${s.url}] ${s.quote.slice(0, 600)}`).join('\n')}`).join('\n\n')}`;
  const res = await scout.generate(prompt, {
    structuredOutput: { schema: classifySchema, errorStrategy: 'strict', jsonPromptInjection: true },
  });
  return (res.object?.policies ?? []).map(p => ({ ...p, method: p.method ?? 'unknown', domain: p.domain.replace(/^www\./, '') }));
}

async function cached(domains: string[]) {
  if (!domains.length) return new Map<string, DomainPolicy>();
  const { rows } = await db.query(
    `SELECT domain, kind, hours_before_start, fee, quote, source_url, method, contact, transferable FROM venue_policies
     WHERE domain = ANY($1) AND checked_at > now() - make_interval(days => $2)
       AND method IS NOT NULL`, // rows from before method/transferable existed are looked up once more (then upserted)
    [domains, CACHE_DAYS],
  );
  return new Map(
    rows.map(r => [
      r.domain,
      {
        domain: r.domain,
        kind: r.kind,
        hoursBeforeStart: r.hours_before_start,
        fee: r.fee,
        quote: r.quote,
        sourceUrl: r.source_url,
        method: normaliseMethod(r.method), // rows from before part B have none: unknown
        contact: r.contact ?? null,
        transferable: r.transferable ?? null,
      } satisfies DomainPolicy,
    ]),
  );
}

async function remember(p: DomainPolicy) {
  await db.query(
    `INSERT INTO venue_policies (domain, kind, hours_before_start, fee, quote, source_url, method, contact, transferable, checked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (domain) DO UPDATE SET kind = $2, hours_before_start = $3, fee = $4, quote = $5, source_url = $6,
       method = $7, contact = $8, transferable = $9, checked_at = now()`,
    [p.domain, p.kind, p.hoursBeforeStart, p.fee, p.quote, p.sourceUrl, p.method, p.contact, p.transferable],
  );
}

export function normaliseMethod(raw: unknown): CancelMethod {
  return typeof raw === 'string' && (CANCEL_METHODS as readonly string[]).includes(raw) ? (raw as CancelMethod) : 'unknown';
}

const METHOD_LABEL: Record<CancelMethod, string | null> = {
  online_self_service: 'cancel online',
  email: 'cancel by email',
  phone: 'cancel by phone',
  box_office: 'cancel at the box office',
  not_possible: null,
  unknown: null,
};

const LABEL: Record<PolicyKind, string> = {
  free_event: 'Free entry',
  free_cancellation: 'Free cancellation',
  refund_with_fee: 'Refund minus a fee',
  exchange_or_credit_only: 'No refunds, exchange/credit only',
  no_refunds: 'No refunds (all sales final)',
  unknown: 'Cancellation policy unknown',
};

// Whose policy it is, for the user: a venue's general terms or a platform default may not match this organiser's.
const WHOSE: Record<PolicyScope, string> = { event: '', venue: ' (venue policy)', platform: ' (platform default)', none: '' };

function describe(p: CancellationPolicy, startsAt: Date, tz: string, checkedAt = new Date().toISOString()): CancellationInfo {
  const cancelBy = p.hoursBeforeStart !== null && p.hoursBeforeStart >= 0 ? new Date(startsAt.getTime() - p.hoursBeforeStart * 3_600_000) : null;
  const until = cancelBy && p.kind !== 'no_refunds' && p.kind !== 'unknown' ? ` until ${formatLocal(cancelBy, tz)}` : '';
  const fee = p.fee && p.kind !== 'free_cancellation' ? ` (${p.fee})` : '';
  const how = p.kind !== 'free_event' && p.kind !== 'no_refunds' && METHOD_LABEL[p.method] ? ` · ${METHOD_LABEL[p.method]}${p.contact ? ` ${p.contact}` : ''}` : '';
  const transfer = p.transferable ? ' · transferable' : '';
  const whose = p.kind !== 'free_event' && p.kind !== 'unknown' ? WHOSE[p.scope] : '';
  return { ...p, cancelBy: cancelBy?.toISOString() ?? null, checkedAt, summary: `${LABEL[p.kind]}${until}${fee}${whose}${how}${transfer}` };
}

const EMPTY: Omit<DomainPolicy, 'domain'> = {
  kind: 'unknown',
  hoursBeforeStart: null,
  fee: null,
  quote: null,
  sourceUrl: null,
  method: 'unknown',
  contact: null,
  transferable: null,
};

const SCOPES: readonly PolicyScope[] = ['event', 'venue', 'platform', 'none'];
const SOURCES: readonly PolicySource[] = ['event_page', 'venue_policy', 'platform_default', 'confirmation_email', 'none'];
const KINDS: readonly PolicyKind[] = ['free_event', 'free_cancellation', 'refund_with_fee', 'exchange_or_credit_only', 'no_refunds', 'unknown'];

/** details.cancellation as saved by saveCancellation (any version; older rows lack method/scope/links) → CancellationInfo. */
export function fromStored(raw: unknown): CancellationInfo | null {
  if (!raw || typeof raw !== 'object' || !('kind' in raw)) return null;
  const c = raw as Partial<CancellationInfo>;
  const kind = KINDS.includes(c.kind as PolicyKind) ? (c.kind as PolicyKind) : 'unknown';
  // Before per-event policies everything was a domain lookup: free entry came from the event, the rest from the venue.
  const legacyScope: PolicyScope = kind === 'free_event' ? 'event' : kind === 'unknown' ? 'none' : 'venue';
  const scope = SCOPES.includes(c.scope as PolicyScope) ? (c.scope as PolicyScope) : legacyScope;
  return {
    kind,
    hoursBeforeStart: c.hoursBeforeStart ?? null,
    fee: c.fee ?? null,
    quote: c.quote ?? null,
    sourceUrl: c.sourceUrl ?? null,
    domain: c.domain ?? '',
    method: normaliseMethod(c.method),
    contact: c.contact ?? null,
    transferable: c.transferable ?? null,
    scope,
    source: SOURCES.includes(c.source as PolicySource)
      ? (c.source as PolicySource)
      : ({ event: 'event_page', venue: 'venue_policy', platform: 'platform_default', none: 'none' } as const)[scope],
    cancellationUrl: c.cancellationUrl ?? null,
    policyUrl: c.policyUrl ?? c.sourceUrl ?? null,
    platform: c.platform ?? null,
    cancelBy: c.cancelBy ?? null,
    checkedAt: c.checkedAt ?? null,
    summary: c.summary ?? LABEL[kind],
  };
}

/** Per-event results checked < 24 h ago (events.cancellation_checked_at); never throws. */
async function storedRecent(ids: string[]): Promise<Map<string, CancellationInfo>> {
  const uuids = ids.filter(id => /^[0-9a-f-]{36}$/.test(id));
  if (!uuids.length) return new Map();
  const { rows } = await db.query<{ id: string; c: unknown }>(
    `SELECT id, details->'cancellation' AS c FROM events
     WHERE id = ANY($1::uuid[]) AND cancellation_checked_at > now() - make_interval(hours => $2) AND details->'cancellation' ? 'scope'`,
    [uuids, EVENT_REUSE_HOURS],
  );
  return new Map(rows.flatMap(r => {
    const c = fromStored(r.c);
    return c ? [[r.id, c] as const] : [];
  }));
}

const eventClassifySchema = z.object({
  events: z.array(
    z.object({
      n: z.number().describe('the event number'),
      kind: z.enum(['free_cancellation', 'refund_with_fee', 'exchange_or_credit_only', 'no_refunds', 'unknown']),
      hoursBeforeStart: z.number().nullable().describe('latest refund/credit in hours before the start ("up to 7 days before" = 168); null if no deadline stated'),
      fee: z.string().nullable(),
      method: z.enum(CANCEL_METHODS).describe('how the buyer cancels, only if the text says; else unknown'),
      contact: z.string().nullable().describe('URL / email / phone to cancel through, verbatim from the text; null if none'),
      askOrganizer: z.boolean().describe('true if the buyer must contact the organiser to request a refund'),
      transferable: z.boolean().nullable().describe('true/false only if the text says so; else null'),
    }),
  ),
});
type EventClass = z.infer<typeof eventClassifySchema>['events'][number];

/** One LLM call for all events whose own page states a policy; conservative like the venue classifier. */
async function classifyEventTexts(items: { n: number; e: StoredEvent; page: EventPagePolicy; platform: string | null }[]) {
  const out = new Map<number, EventClass>();
  if (!items.length) return out;
  const prompt = `Each event below shows a refund/cancellation policy on its own ticket page (set by that event's organiser).
Classify what a buyer of a regular single ticket can do if they cancel:
- free_cancellation: full refund on request, possibly until a deadline ("Refunds up to 7 days before event" = free_cancellation, 168 h)
- refund_with_fee: refund minus a fee the text names
- exchange_or_credit_only: no money back, only exchange / credit
- no_refunds: "No refunds", "All sales final", at most transferable to another person
- unknown: the text doesn't say what a buyer can do
hoursBeforeStart: the refund deadline in hours before the start ("up to 7 days before" → 168, "24 hours before" → 24, "until 1 day before" → 24); null if none.
Be conservative: only what the text says; if unclear pick unknown or the stricter kind. A ticket platform's own service fee being
non-refundable is not a fee here. method: online_self_service only if the text says buyers cancel/refund themselves online
(order page, account); email/phone only with an address/number; otherwise unknown. askOrganizer: the text says to contact the organiser.

${items.map(({ n, e, page, platform }) => `## ${n}) "${e.title}" ${e.startLocal.replace('T', ' ')}${platform ? ` (sold on ${platform})` : ''}\n${page.policyText.slice(0, 600)}${page.deadlineText ? `\n(deadline as written: ${page.deadlineText})` : ''}`).join('\n\n')}`;
  const res = await scout.generate(prompt, {
    structuredOutput: { schema: eventClassifySchema, errorStrategy: 'strict', jsonPromptInjection: true },
  });
  for (const c of res.object?.events ?? []) out.set(Number(c.n), c);
  return out;
}

/**
 * Attaches each event's cancellation policy as `cancellation` (PLAN §9). `pages` = what the live re-check read on each
 * event's own page (status.ts `checks[id].policy`). Precedence: event page > venue/shop policy (cached per domain) >
 * platform default > unknown. On per-event platforms (Eventbrite, Luma, …) without policy text on the page the kind
 * stays unknown: a venue's or platform's default could be wrong for that organiser. Per-event results < 24 h old are
 * reused unless the page now shows policy text the stored one lacked.
 * Never throws: on any failure the event gets kind "unknown", which blocks booking unasked.
 */
export async function attachCancellation<T extends StoredEvent>(
  events: T[],
  tz: string,
  pages: Map<string, EventPagePolicy | null> = new Map(),
): Promise<(T & { cancellation: CancellationInfo })[]> {
  const domainOf = (e: StoredEvent) => host(AGGREGATORS.test(host(e.url)) ? e.pageUrl : e.url);
  // Free before anything else: platform defaults describe paid tickets (Partiful/Meetup events are mostly free).
  const isFree = (e: StoredEvent) => e.priceMinCents === 0 || e.status === 'free_entry' || e.status === 'free_rsvp';
  const platformOf = (e: StoredEvent) => detectPlatform(e.bookingUrl) ?? detectPlatform(e.url);
  const perEvent = (e: StoredEvent) => {
    const p = platformOf(e);
    return !!p && platformCancellation(p.id).perEventPolicy;
  };

  const stored = await storedRecent(events.filter(e => !isFree(e)).map(e => e.id)).catch(() => new Map<string, CancellationInfo>());
  const reusable = (e: StoredEvent) => {
    const s = stored.get(e.id);
    return s && (s.source === 'event_page' || !pages.get(e.id)?.policyText) ? s : null;
  };
  const todo = events.filter(e => !isFree(e) && !reusable(e));

  // 1. The event's own page.
  const withText = todo.filter(e => pages.get(e.id)?.policyText).map((e, i) => ({ n: i + 1, e, page: pages.get(e.id)!, platform: platformOf(e)?.name ?? null }));
  const byN = await classifyEventTexts(withText).catch(err => {
    console.warn('[events] event policy classification failed:', String(err).slice(0, 200));
    return new Map<number, EventClass>();
  });
  const eventClass = new Map(withText.flatMap(({ n, e }) => (byN.has(n) ? [[e.id, byN.get(n)!] as const] : [])));
  const hasEventPolicy = (e: StoredEvent) => (eventClass.get(e.id)?.kind ?? 'unknown') !== 'unknown';

  // 2. Venue / ticket-shop domain policy, only where the event page didn't answer and the organiser doesn't set it per event.
  const needed = [
    ...new Set(todo.filter(e => !hasEventPolicy(e) && !perEvent(e)).map(domainOf).filter(d => d && !AGGREGATORS.test(d))),
  ];
  const policies = await cached([...new Set([...needed, ...todo.map(domainOf).filter(Boolean)])]).catch(() => new Map<string, DomainPolicy>());
  const missing = needed.filter(d => !policies.has(d));
  if (missing.length) {
    try {
      const texts = await Promise.all(
        missing.map(async domain => {
          const example = todo.find(e => domainOf(e) === domain)!;
          const snippets = await fetchPolicyText(domain, example.url).catch(() => []);
          return { domain, snippets };
        }),
      );
      const found = await classify(texts.filter(t => t.snippets.length));
      for (const domain of missing) {
        let p: DomainPolicy = found.find(f => f.domain === domain || domain.endsWith(f.domain)) ?? { ...EMPTY, domain };
        // Generous policies must come from a policy-type page, not an event page's one-off notice.
        if (p.kind === 'free_cancellation' && !POLICY_PAGE.test(p.sourceUrl ?? '') && !PER_EVENT.test(domain)) {
          p = { ...p, kind: 'unknown', quote: p.quote && `(not from a policy page) ${p.quote}` };
        }
        policies.set(domain, { ...p, domain });
        await remember({ ...p, domain }).catch(() => {});
      }
    } catch (err) {
      console.warn('[events] cancellation lookup failed:', String(err).slice(0, 200));
    }
  }

  // 3. Precedence.
  const resolve = (e: StoredEvent): CancellationPolicy => {
    const domain = domainOf(e);
    const pl = platformOf(e);
    const pc = pl ? platformCancellation(pl.id) : null;
    const page = pages.get(e.id) ?? null;
    const venue = pc?.perEventPolicy ? undefined : policies.get(domain);
    // cancellationUrl is only ever a verified link or the platform's order page, never the event URL; when it is
    // null, policyUrl is the link to show.
    const links = {
      cancellationUrl: page?.cancellationUrl ?? pc?.orderManagementUrl ?? null,
      policyUrl: page?.policyUrl ?? venue?.sourceUrl ?? pc?.policyUrl ?? null,
      platform: pl?.id ?? null,
    };
    if (isFree(e)) return { ...EMPTY, domain, kind: 'free_event', scope: 'event', source: 'event_page', ...links };
    const ev = eventClass.get(e.id);
    if (ev && ev.kind !== 'unknown' && page?.policyText) {
      const method: CancelMethod =
        ev.method !== 'unknown' ? ev.method
        : ev.askOrganizer ? 'unknown' // "contact the organiser": nothing the agent can do by itself
        : venue && venue.method !== 'unknown' ? venue.method
        : pc?.defaultMethod ?? 'unknown';
      return {
        domain,
        kind: ev.kind,
        hoursBeforeStart: ev.hoursBeforeStart,
        fee: ev.fee,
        quote: page.policyText,
        sourceUrl: page.pageUrl,
        method,
        contact: ev.contact ?? (venue && method === venue.method ? venue.contact : null),
        transferable: ev.transferable ?? venue?.transferable ?? null,
        scope: 'event',
        source: 'event_page',
        ...links,
      };
    }
    if (pc?.perEventPolicy) return { ...EMPTY, domain, scope: 'none', source: 'none', ...links };
    if (venue && venue.kind !== 'unknown') return { ...venue, domain, scope: 'venue', source: 'venue_policy', ...links };
    if (pc?.defaultKind) {
      return { ...EMPTY, domain, kind: pc.defaultKind, method: pc.defaultMethod, sourceUrl: pc.policyUrl, scope: 'platform', source: 'platform_default', ...links };
    }
    return { ...(venue ?? EMPTY), domain, kind: 'unknown', scope: 'none', source: 'none', ...links };
  };

  return events.map(e => {
    const reused = !isFree(e) && reusable(e);
    if (reused) return { ...e, cancellation: describe(reused, e.startsAt, tz, reused.checkedAt ?? undefined) };
    return { ...e, cancellation: describe(resolve(e), e.startsAt, tz) };
  });
}

/**
 * The gate in code: booking without asking is only allowed if the user can still back out for free.
 * Free events always pass; free cancellation passes if the agent can cancel itself (online or by email) and its deadline leaves ≥12 h to decide (no stated deadline = until start).
 */
export function allowsBookingUnasked(c: CancellationInfo, startsAt: Date, now = new Date()): { ok: boolean; reason: string } {
  if (c.kind === 'free_event') return { ok: true, reason: 'free entry' };
  if (c.kind !== 'free_cancellation') return { ok: false, reason: `${LABEL[c.kind].toLowerCase()}, so I ask first` };
  // The agent must be able to cancel by itself (account page in the browser, or an email from its inbox).
  if (c.method !== 'online_self_service' && c.method !== 'email') {
    const how = METHOD_LABEL[c.method];
    return { ok: false, reason: how ? `free cancellation but I'd have to ${how}, so I ask first` : 'no way for me to cancel it myself is known, so I ask first' };
  }
  const deadline = c.cancelBy ? new Date(c.cancelBy) : new Date(startsAt.getTime() - DEFAULT_DEADLINE_HOURS * 3_600_000);
  const hoursLeft = (deadline.getTime() - now.getTime()) / 3_600_000;
  return hoursLeft >= MIN_HOURS_TO_DECIDE
    ? { ok: true, reason: `free cancellation for another ${Math.floor(hoursLeft)} h` }
    : { ok: false, reason: 'free-cancellation window closes too soon' };
}
