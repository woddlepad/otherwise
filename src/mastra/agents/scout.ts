import { Agent } from '@mastra/core/agent';
import { modelFor } from '../../lib/model';

/**
 * No tools, no memory: plans event searches and rates events against a taste profile (src/lib/events).
 * Runs on a faster model than the concierge (DISCOVERY_MODEL, default Sonnet 5): a chat search should answer in seconds.
 */
export const scout = new Agent({
  id: 'scout',
  name: 'Event scout',
  model: () => modelFor(process.env.DISCOVERY_MODEL || 'neon/claude-sonnet-5'),
  instructions: `
You help a personal event concierge. You either write web search queries that find upcoming event pages,
or rate candidate events against one person's taste. Base judgements on the taste profile you are given,
not on general popularity. Be decisive and specific; never invent facts about an event.
`,
});
