import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getBusy } from '../../lib/calendar';
import { recordFeedback } from '../../lib/policy';
import { addTasteNote } from '../../lib/taste';

function userIdFrom(requestContext: { get(key: string): unknown } | undefined): string {
  const userId = requestContext?.get('userId');
  if (typeof userId !== 'string') throw new Error('userId missing from request context');
  return userId;
}

export const checkAvailability = createTool({
  id: 'check-availability',
  description: "Busy blocks in the user's connected calendars between two ISO datetimes. Empty list = free.",
  inputSchema: z.object({
    from: z.string().describe('ISO 8601 datetime with offset'),
    to: z.string().describe('ISO 8601 datetime with offset'),
  }),
  execute: async ({ from, to }, { requestContext }) => {
    const busy = await getBusy(userIdFrom(requestContext), new Date(from), new Date(to));
    return { free: busy.length === 0, busy };
  },
});

export const rememberAboutUser = createTool({
  id: 'remember-about-user',
  description:
    'Save one lasting fact about the user\'s taste or habits learned in chat (e.g. "prefers OV screenings", "never before 19:00 on weekdays"). One short sentence.',
  inputSchema: z.object({ note: z.string().max(200) }),
  execute: async ({ note }, { requestContext }) => {
    await addTasteNote(userIdFrom(requestContext), note);
    return { ok: true };
  },
});

export const logFeedback = createTool({
  id: 'log-feedback',
  description:
    'Record how the user reacted to a suggestion or booking: approved/declined a proposal, or after going: loved/liked/meh/disliked. This tunes how often you book without asking.',
  inputSchema: z.object({
    kind: z.enum(['approved', 'declined', 'loved', 'liked', 'meh', 'disliked']),
    eventTitle: z.string(),
    wasSurprise: z.boolean().describe('true if you had booked it without asking'),
    confidence: z.number().min(0).max(1).optional().describe('your confidence when you proposed/booked it'),
    note: z.string().optional().describe('why, in their words, if they said'),
  }),
  execute: async (input, { requestContext }) => {
    const userId = userIdFrom(requestContext);
    const res = await recordFeedback(userId, input);
    if (input.note) await addTasteNote(userId, `${input.kind} "${input.eventTitle}": ${input.note}`);
    return res;
  },
});
