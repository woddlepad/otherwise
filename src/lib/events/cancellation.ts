import Exa from 'exa-js';
import { z } from 'zod';
import { scout } from '../../mastra/agents/scout';
import { db } from '../db';
import { AGGREGATORS } from './classify';
import { formatLocal } from './time';
import type { StoredEvent } from './types';

/**
 * Cancellation / refund policy per event. The agent may book before the user confirms ("surprise" bookings), so it
 * must know whether and until when it can undo a booking. Policies are almost never on the event page itself but on
 * the venue's or ticket shop's FAQ / ticket-policy page, so we look them up once per domain and cache them.
 */

export type PolicyKind = 'free_event' | 'free_cancellation' | 'refund_with_fee' | 'exchange_or_credit_only' | 'no_refunds' | 'unknown';

export const CANCEL_METHODS = ['online_self_service', 'email', 'phone', 'box_office', 'not_possible', 'unknown'] as const;
export type CancelMethod = (typeof CANCEL_METHODS)[number];

export type CancellationPolicy = {
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

export type CancellationInfo = CancellationPolicy & {
  cancelBy: string | null;           // ISO instant: last moment to cancel under this policy
  summary: string;                   // one line for WhatsApp / the agent
};

const CACHE_DAYS = 7;
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
async function classify(texts: { domain: string; snippets: { url: string; quote: string }[] }[]): Promise<CancellationPolicy[]> {
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
  if (!domains.length) return new Map<string, CancellationPolicy>();
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
      } satisfies CancellationPolicy,
    ]),
  );
}

async function remember(p: CancellationPolicy) {
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

function describe(p: CancellationPolicy, startsAt: Date, tz: string): CancellationInfo {
  const cancelBy = p.hoursBeforeStart !== null && p.hoursBeforeStart >= 0 ? new Date(startsAt.getTime() - p.hoursBeforeStart * 3_600_000) : null;
  const until = cancelBy && p.kind !== 'no_refunds' && p.kind !== 'unknown' ? ` until ${formatLocal(cancelBy, tz)}` : '';
  const fee = p.fee && p.kind !== 'free_cancellation' ? ` (${p.fee})` : '';
  const how = p.kind !== 'free_event' && p.kind !== 'no_refunds' && METHOD_LABEL[p.method] ? ` · ${METHOD_LABEL[p.method]}${p.contact ? ` ${p.contact}` : ''}` : '';
  const transfer = p.transferable ? ' · transferable' : '';
  return { ...p, cancelBy: cancelBy?.toISOString() ?? null, summary: `${LABEL[p.kind]}${until}${fee}${how}${transfer}` };
}

const EMPTY: Omit<CancellationPolicy, 'domain'> = {
  kind: 'unknown',
  hoursBeforeStart: null,
  fee: null,
  quote: null,
  sourceUrl: null,
  method: 'unknown',
  contact: null,
  transferable: null,
};

/**
 * Looks up the cancellation policy for each event (cached per domain) and attaches it as `cancellation`.
 * Never throws: on any failure the event gets kind "unknown", which blocks booking unasked.
 */
export async function attachCancellation<T extends StoredEvent>(events: T[], tz: string): Promise<(T & { cancellation: CancellationInfo })[]> {
  const domainOf = (e: StoredEvent) => host(AGGREGATORS.test(host(e.url)) ? e.pageUrl : e.url);
  const isFree = (e: StoredEvent) => e.priceMinCents === 0;
  const needed = [...new Set(events.filter(e => !isFree(e)).map(domainOf).filter(d => d && !AGGREGATORS.test(d)))];

  const policies = await cached(needed).catch(() => new Map<string, CancellationPolicy>());
  const missing = needed.filter(d => !policies.has(d));
  if (missing.length) {
    try {
      const texts = await Promise.all(
        missing.map(async domain => {
          const example = events.find(e => domainOf(e) === domain)!;
          const snippets = await fetchPolicyText(domain, example.url).catch(() => []);
          return { domain, snippets };
        }),
      );
      const found = await classify(texts.filter(t => t.snippets.length));
      for (const domain of missing) {
        let p = found.find(f => f.domain === domain || domain.endsWith(f.domain)) ?? {
          domain,
          kind: 'unknown' as const,
          hoursBeforeStart: null,
          fee: null,
          quote: null,
          sourceUrl: null,
          method: 'unknown' as const,
          contact: null,
          transferable: null,
        };
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

  return events.map(e => {
    const domain = domainOf(e);
    const p: CancellationPolicy = isFree(e)
      ? { ...EMPTY, kind: 'free_event', domain }
      : policies.get(domain) ?? { ...EMPTY, domain };
    return { ...e, cancellation: describe(p, e.startsAt, tz) };
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
