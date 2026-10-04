import { z } from 'zod';
import { scout } from '../../mastra/agents/scout';
import { getBusy } from '../calendar';
import type { BudgetStatus } from '../db';
import { decide } from '../policy';
import { tasteForPrompt } from '../taste';
import { CATEGORY_LABEL } from './classify';
import { formatLocal } from './time';
import type { DiscoveryContext, ScoredEvent, StoredEvent } from './types';

const MAX_TO_RATE = 40;           // keeps the prompt small (gateway limit: 200k tokens/minute per account)
const ASSUMED_DURATION_MS = 3 * 3_600_000;

const ratingSchema = z.object({
  ratings: z.array(
    z.object({
      n: z.number().int().describe('the candidate number'),
      confidence: z.number().min(0).max(1).describe('how sure you are they would love going, 0–1'),
      reason: z.string().describe('max 15 words, second person, concrete link to their taste'),
      matches: z.array(z.string()).describe("which of their likes/interests it matches, using the profile's own category words; [] if none"),
    }),
  ),
});

/** Cheap pre-filter before the LLM: drop explicit dislikes. */
function passesHardFilters(e: StoredEvent, ctx: DiscoveryContext) {
  const text = `${e.title} ${e.venue ?? ''} ${e.category} ${e.tags.join(' ')}`.toLowerCase();
  const dislikes = ctx.taste.profile?.dislikes ?? [];
  return !dislikes.some(d => d.length > 2 && new RegExp(`\\b${d.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));
}

function line(n: number, e: StoredEvent, tz: string, city: string) {
  const when = e.hasTime ? formatLocal(e.startsAt, tz) : `${formatLocal(e.startsAt, tz, false)} (time tbc)`;
  const tags = e.tags.length ? ` [${e.tags.join(', ')}]` : '';
  const where = [e.venue ?? '?', e.city && e.city.toLowerCase() !== city.toLowerCase() ? e.city : null, e.distanceKm !== null ? `${e.distanceKm} km from home` : null]
    .filter(Boolean)
    .join(', ');
  const status = e.status !== 'unknown' && e.status !== 'on_sale' ? ` | ${e.status.replace(/_/g, ' ')}` : '';
  return `${n}. ${e.title} | ${CATEGORY_LABEL[e.category]}${tags} | ${when} (${e.attrs.timeOfDay}) | ${where} | ${e.priceText ?? 'price ?'}${status}`;
}

async function rate(events: StoredEvent[], ctx: DiscoveryContext) {
  const prompt = `Rate how much this person would love going to each event. Most candidates are only loosely related;
reserve ≥0.85 for clear matches with their strongest likes or favourite artists/venues, 0.5–0.8 for good fits,
<0.4 for weak ones. Consider their preferred times and usual ticket price too.
${ctx.hint ? `They asked for: "${ctx.hint}". Events that don't fit the request get <0.3.\n` : ''}
Taste profile:
${tasteForPrompt(ctx.taste)}
${ctx.interests ? `Stated interests: ${ctx.interests}` : ''}

Candidates:
${events.map((e, i) => line(i + 1, e, ctx.timezone, ctx.city)).join('\n')}

Return a rating for every candidate number.`;
  const res = await scout.generate(prompt, { structuredOutput: { schema: ratingSchema, errorStrategy: 'strict', jsonPromptInjection: true } });
  return new Map((res.object?.ratings ?? []).map(r => [r.n, r]));
}

/** Without an LLM: keyword overlap with likes. Only used if the rating call fails. */
function fallbackRating(e: StoredEvent, ctx: DiscoveryContext) {
  const text = `${e.title} ${e.venue ?? ''} ${e.query} ${e.category} ${e.tags.join(' ')}`.toLowerCase();
  let best = 0.3;
  for (const like of ctx.taste.profile?.likes ?? []) {
    const words = [like.category, ...like.specifics].join(' ').toLowerCase().split(/\W+/).filter(w => w.length > 3);
    if (words.some(w => text.includes(w))) best = Math.max(best, 0.4 + 0.4 * like.strength);
  }
  const matches = (ctx.taste.profile?.likes ?? [])
    .filter(l => [l.category, ...l.specifics].some(w => w.length > 3 && text.includes(w.toLowerCase())))
    .map(l => l.category);
  return { confidence: Math.round(best * 100) / 100, reason: 'matches your interests', matches };
}

async function busyOverlaps(ctx: DiscoveryContext) {
  if (!ctx.userId) return () => false;
  try {
    const busy = await getBusy(ctx.userId, ctx.window.from, ctx.window.to);
    const blocks = busy.map(b => [new Date(b.start).getTime(), new Date(b.end).getTime()] as const);
    return (e: StoredEvent) => {
      if (!e.hasTime) return false;
      const s = e.startsAt.getTime();
      return blocks.some(([bs, be]) => s < be && s + ASSUMED_DURATION_MS > bs);
    };
  } catch (err) {
    console.warn('[events] calendar check failed, assuming free:', String(err).slice(0, 200));
    return () => false;
  }
}

/**
 * Rates candidates against the taste profile (one LLM call) and applies policy.decide() in code.
 * Returns everything rated, best first; callers pick how many to show.
 */
export async function scoreEvents(events: StoredEvent[], ctx: DiscoveryContext, budget: BudgetStatus | null): Promise<ScoredEvent[]> {
  const pool = events.filter(e => passesHardFilters(e, ctx)).slice(0, MAX_TO_RATE);
  if (!pool.length) return [];

  let ratings: Map<number, { confidence: number; reason: string; matches: string[] }> | null = null;
  try {
    if (process.env.DISCOVERY_NO_LLM !== '1') ratings = await rate(pool, ctx);
  } catch (err) {
    console.warn('[events] rating LLM failed, using keyword fallback:', String(err).slice(0, 200));
  }
  const isBusy = await busyOverlaps(ctx);
  const tickets = ctx.taste.profile?.usualTicketCount ?? 1;

  const scored = pool.map((e, i): ScoredEvent => {
    const r = ratings?.get(i + 1) ?? fallbackRating(e, ctx);
    const calendarFree = !isBusy(e);
    const totalCents = (e.priceMinCents ?? 0) * tickets;
    let decision = budget
      ? decide({
          confidence: r.confidence,
          totalCents,
          calendarFree,
          budget,
          autoBookConfidence: ctx.taste.autoBookConfidence,
          askConfidence: ctx.taste.askConfidence,
        })
      : { action: (r.confidence >= ctx.taste.askConfidence ? 'ask' : 'skip') as 'ask' | 'skip', reason: 'no budget loaded' };
    // A price we haven't seen on the page can't justify booking unasked.
    if (decision.action === 'book' && e.priceMinCents === null) decision = { action: 'ask', reason: 'price not known yet' };
    // Nothing in common with any stated interest: suggest at most, never book unasked.
    if (decision.action === 'book' && !r.matches.length) decision = { action: 'ask', reason: 'no clear match with your interests' };
    return { ...e, confidence: r.confidence, reason: r.reason, matches: r.matches, decision };
  });
  return scored.sort((a, b) => b.confidence - a.confidence);
}
