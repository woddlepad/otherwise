import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { CATEGORIES, STATUSES, diversify } from '../../lib/events/classify';
import { discover, loadContext } from '../../lib/events/discover';
import { sendPicks, toPicks } from '../../lib/events/notify';

const PICKS_PER_DAY = 3;

const pickSchema = z.object({
  n: z.number(),
  eventId: z.string(),
  title: z.string(),
  category: z.enum(CATEGORIES),
  tags: z.array(z.string()),
  when: z.string(),
  venue: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  distanceKm: z.number().nullable(),
  price: z.string().nullable(),
  url: z.string(),
  bookingUrl: z.string().nullable(),
  status: z.enum(STATUSES),
  onSaleAt: z.string().nullable(),
  why: z.string(),
  matches: z.array(z.string()),
  confidence: z.number(),
  decision: z.enum(['book', 'ask', 'skip']),
  decisionReason: z.string(),
  cancellation: z.string().nullable(),
  cancelBy: z.string().nullable(),
  cancellationScope: z.enum(['event', 'venue', 'platform', 'none']).nullable(),
  cancellationUrl: z.string().nullable(),
  policyUrl: z.string().nullable(),
});

const input = z.object({
  userId: z.string(),
  trigger: z.enum(['daily', 'manual']).default('manual'),
  notify: z.boolean().default(true),
});

const findAndRate = createStep({
  id: 'find-and-rate',
  description: 'Plan queries from the taste profile, search Exa, store events, rate them and apply the booking policy',
  inputSchema: input,
  outputSchema: z.object({
    userId: z.string(),
    notify: z.boolean(),
    timezone: z.string(),
    skipped: z.string().optional(),
    queries: z.array(z.string()),
    candidates: z.number(),
    costDollars: z.number(),
    picks: z.array(pickSchema),
  }),
  execute: async ({ inputData: { userId, trigger, notify } }) => {
    const { timezone } = await loadContext(userId);
    const res = await discover(userId, { trigger, fresh: true, limit: 10 });
    return {
      userId,
      notify,
      timezone,
      skipped: res.skipped,
      queries: res.queries.map(q => q.query),
      candidates: res.candidates.length,
      costDollars: res.costDollars,
      picks: toPicks(res.events, timezone),
    };
  },
});

const notifyUser = createStep({
  id: 'notify',
  description: 'Send the top picks on WhatsApp (and into the chat thread so a reply of "2" makes sense)',
  inputSchema: findAndRate.outputSchema,
  outputSchema: z.object({ sent: z.boolean(), picks: z.array(pickSchema) }),
  execute: async ({ inputData, mastra }) => {
    // Best first, but at most one per category while there are others (not three horror films).
    const top = diversify(inputData.picks.filter(p => p.decision !== 'skip'), PICKS_PER_DAY);
    if (!inputData.notify || !top.length) return { sent: false, picks: top };
    const res = await sendPicks(mastra, inputData.userId, top);
    return { sent: res.sent, picks: top };
  },
});

/** Daily (or on-demand) discovery for one user: find → rate → WhatsApp the top 3. */
export const discoverEvents = createWorkflow({
  id: 'discover-events',
  inputSchema: input,
  outputSchema: notifyUser.outputSchema,
})
  .then(findAndRate)
  .then(notifyUser)
  .commit();
