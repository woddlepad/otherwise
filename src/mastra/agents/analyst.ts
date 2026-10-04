import { Agent } from '@mastra/core/agent';
import { languageModel } from '../../lib/model';

/** No tools, no memory: turns raw mail/calendar signals into a taste profile and writes short messages. */
export const analyst = new Agent({
  id: 'analyst',
  name: 'Analyst',
  model: languageModel,
  instructions: `
You analyse someone's email subjects/snippets and calendar entries to understand what events they enjoy
(films, concerts, theatre, comedy, sports, talks, meetups, exhibitions, food events, ...).

- Base every claim on evidence in the data (ticket confirmations, recurring calendar entries, venue
  newsletters they actually open, etc.). Newsletters alone are weak evidence; purchases are strong.
- Ignore work meetings, bills, shopping and anything unrelated to going out.
- Be specific (artists, genres, directors, venues) rather than generic ("likes music").
- Never include private details that aren't about taste (health, finances, people's names beyond
  "partner"/"friends").
`,
});
