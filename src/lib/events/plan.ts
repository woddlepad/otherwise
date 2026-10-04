import { z } from 'zod';
import { scout } from '../../mastra/agents/scout';
import { tasteForPrompt } from '../taste';
import { formatLocal } from './time';
import type { DiscoveryContext, PlannedQuery } from './types';

const plannedSchema = z.object({
  queries: z
    .array(
      z.object({
        query: z.string().describe('one natural-language description of the ideal event page'),
        why: z.string().describe('which part of the taste profile this covers, a few words'),
      }),
    )
    .min(1)
    .max(8),
  window: z
    .object({ from: z.string().describe('YYYY-MM-DD'), to: z.string().describe('YYYY-MM-DD, inclusive') })
    .nullable()
    .describe('only if the request names specific days ("Friday", "this weekend"); otherwise null'),
});

function windowText(ctx: DiscoveryContext) {
  return `${formatLocal(ctx.window.from, ctx.timezone, false)} – ${formatLocal(ctx.window.to, ctx.timezone, false)} ${ctx.window.to.getFullYear()}`;
}

/** Turns taste + city + window (+ the chat request) into 4–8 Exa queries. Falls back to templates if the LLM fails. */
export async function planQueries(
  ctx: DiscoveryContext,
  max = 6,
): Promise<{ queries: PlannedQuery[]; window?: { from: string; to: string } }> {
  const prompt = `Write ${ctx.hint ? '2–4' : `${Math.max(4, max - 2)}–${max}`} web search queries that find pages for specific
upcoming events this person would love, in ${ctx.city}, between ${windowText(ctx)}.

How to write a query (the search engine is semantic, not keyword):
- Describe the ideal page, e.g. "event page for a live jazz concert at a small club in San Francisco in October 2026 with date and tickets"
  or "independent cinema showtimes calendar in San Francisco this week, repertory and 35mm screenings".
- Always include the city and the month/year. Prefer pages of single events or venue calendars, not news or listicles.
- Cover their strongest likes first, one query per distinct interest; use specific artists/genres/venues from the profile.
- At most one query that explores something adjacent they'd plausibly enjoy.
${ctx.hint ? `- The person just asked: "${ctx.hint}". All queries must serve that request.
- Today is ${formatLocal(new Date(), ctx.timezone, false)} ${new Date().getFullYear()}. If the request names days, set window to those dates.` : '- Set window to null.'}

Taste profile:
${tasteForPrompt(ctx.taste)}
${ctx.interests ? `Stated interests: ${ctx.interests}` : ''}`;

  if (process.env.DISCOVERY_NO_LLM === '1') return { queries: fallbackQueries(ctx, max) };
  try {
    const res = await scout.generate(prompt, {
      structuredOutput: { schema: plannedSchema, errorStrategy: 'strict', jsonPromptInjection: true },
    });
    const queries = res.object?.queries ?? [];
    if (queries.length) return { queries: queries.slice(0, max), window: res.object.window ?? undefined };
  } catch (err) {
    console.warn('[events] planQueries LLM failed, using templates:', String(err).slice(0, 200));
  }
  return { queries: fallbackQueries(ctx, max) };
}

/** Deterministic queries from the profile; also what the tuning script uses with --no-llm. */
export function fallbackQueries(ctx: DiscoveryContext, max = 6): PlannedQuery[] {
  const month = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: ctx.timezone }).format(ctx.window.from);
  const topics: string[] = [];
  if (ctx.hint) topics.push(ctx.hint);
  for (const like of ctx.taste.profile?.likes ?? []) {
    topics.push(like.specifics.length ? `${like.category} (${like.specifics.slice(0, 3).join(', ')})` : like.category);
  }
  if (!topics.length && ctx.interests) topics.push(...ctx.interests.split(/[,;]/).map(s => s.trim()).filter(Boolean));
  if (!topics.length) topics.push('live music', 'independent film screenings', 'comedy shows');
  const queries = topics.slice(0, max).map(t => ({
    query: `event page for ${t} in ${ctx.city} in ${month} with date, venue and tickets`,
    why: t,
  }));
  for (const venue of ctx.taste.profile?.favoriteVenues ?? []) {
    if (queries.length >= max) break;
    queries.push({ query: `${venue} ${ctx.city} upcoming events calendar ${month}`, why: `favourite venue ${venue}` });
  }
  return queries;
}
