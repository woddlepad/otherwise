import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getBudgetStatus } from '../../lib/db';
import { defaultWindow, discover, dropUnreachable, finalizePicks, loadContext } from '../../lib/events/discover';
import { geocodeUserHome } from '../../lib/events/geocode';
import { CATEGORIES } from '../../lib/events/classify';
import { toPicks } from '../../lib/events/notify';
import { scoreEvents } from '../../lib/events/score';
import { recentEvents, saveSuggestions } from '../../lib/events/store';
import { zonedToUtc } from '../../lib/events/time';

const CACHE_MIN = 8; // enough fresh stored events in the window → rate those instead of searching the web again

export const findEvents = createTool({
  id: 'find-events',
  description:
    "Find upcoming events in the user's city that fit their taste (and the request), ranked, with a one-line reason each. " +
    'Use for "anything fun this weekend?", "jazz on Friday?", "what should I do tonight". Takes 20–60 s when it has to search the web. ' +
    'Each event has a category (music, film, comedy, …) and tags (genres/formats). Results include eventId, matches (which of their interests it fits), price as an estimate from the web (the real price is ' +
    'checked at booking), cancellation (the venue\'s refund/cancellation policy; mention it for paid events) and decision ' +
    '(book = confident, cheap enough and cancellable for free, so it may be booked unasked; ask = propose it first). ' +
    'Availability was re-checked live: status (on_sale, few_left = mention urgency, waitlist, not_yet_on_sale, free_rsvp, free_entry, door_only, unknown), ' +
    'bookingUrl (the page to buy/RSVP on), address, city and distanceKm from home.',
  inputSchema: z.object({
    request: z.string().describe("the user's request in their words, e.g. \"jazz on Friday evening\""),
    from: z.string().optional().describe('first day to consider, YYYY-MM-DD in the user\'s timezone (default today)'),
    to: z.string().optional().describe('last day to consider, YYYY-MM-DD (default 14 days ahead)'),
    categories: z
      .array(z.enum(CATEGORIES))
      .optional()
      .describe('only these kinds of event, when the request names one (e.g. ["comedy"] for "stand-up tonight"); omit for anything'),
  }),
  execute: async ({ request, from, to, categories }, { requestContext, mastra }) => {
    const userId = requestContext?.get('userId');
    if (typeof userId !== 'string') throw new Error('userId missing from request context');

    const base = defaultWindow();
    const ctx = await loadContext(userId, { hint: request });
    ctx.categories = categories;
    const fromDate = from ? zonedToUtc(from, ctx.timezone) : null;
    const toDate = to ? zonedToUtc(to, ctx.timezone) : null;
    ctx.window = {
      from: fromDate && fromDate > base.from ? fromDate : base.from,
      to: toDate ? new Date(toDate.getTime() + 86_399_000) : base.to,
    };

    // Answer from today's stored events when there are enough; otherwise search the web.
    // Nearby towns count too (venues within 40 km of home); distances fill in for the rating and the picks.
    const home = await geocodeUserHome(userId);
    const cached = dropUnreachable(
      await recentEvents(ctx.city, ctx.window.from, ctx.window.to, ctx.timezone, { categories, home }),
      ctx.maxTravelKm,
    );
    let events;
    if (cached.length >= CACHE_MIN) {
      const budget = await getBudgetStatus(userId).catch(() => null);
      events = await finalizePicks(await scoreEvents(cached, ctx, budget), ctx.timezone, 6);
      await saveSuggestions(userId, events);
    } else {
      events = (await discover(userId, { trigger: 'chat', hint: request, window: ctx.window, categories, limit: 6 })).events;
    }
    mastra?.getLogger().info('find-events', { userId, request, cached: cached.length, returned: events.length });
    return {
      source: cached.length >= CACHE_MIN ? 'stored events from today' : 'fresh web search',
      events: toPicks(events, ctx.timezone),
    };
  },
});
