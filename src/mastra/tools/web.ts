import { createTool } from '@mastra/core/tools';
import Exa from 'exa-js';
import { z } from 'zod';

let exa: Exa | undefined;
function getExa() {
  if (!process.env.EXA_API_KEY) throw new Error('EXA_API_KEY is not set');
  exa ??= new Exa(process.env.EXA_API_KEY);
  return exa;
}

const clip = (text: string | undefined, max: number) =>
  text && text.length > max ? `${text.slice(0, max)}…` : text;

export const webSearch = createTool({
  id: 'web-search',
  description:
    'Search the web with Exa. Returns titles, URLs, dates and the most relevant passages. Use this first for any question about the world; open a page with read-page or the browser only when you need more.',
  inputSchema: z.object({
    query: z.string().describe('Natural-language description of what you are looking for'),
    numResults: z.number().int().min(1).max(10).optional(),
    includeDomains: z.array(z.string()).optional().describe('Only these domains, e.g. ["eventbrite.com"]'),
    startPublishedDate: z.string().optional().describe('ISO date; only pages published after it (use for news)'),
    category: z.enum(['news', 'company', 'people', 'publication', 'personal site', 'financial report']).optional(),
  }),
  execute: async ({ query, numResults, includeDomains, startPublishedDate, category }) => {
    const res = await getExa().search(query, {
      type: 'auto',
      numResults: numResults ?? 5,
      includeDomains,
      startPublishedDate,
      category,
      contents: { highlights: true },
    });
    return {
      results: res.results.map(r => ({
        title: r.title,
        url: r.url,
        publishedDate: r.publishedDate,
        highlights: r.highlights,
      })),
    };
  },
});

export const readPage = createTool({
  id: 'read-page',
  description:
    'Fetch the readable text of one or more URLs through Exa (fast, no browser). Use it for articles, docs and static pages. For pages that need clicking, logging in or filling forms, use the browser tools.',
  inputSchema: z.object({
    urls: z.array(z.string().url()).min(1).max(5),
    fresh: z.boolean().optional().describe('Bypass the cache, e.g. for prices or availability'),
  }),
  execute: async ({ urls, fresh }) => {
    const res = await getExa().getContents(urls, {
      text: { maxCharacters: 8000 },
      ...(fresh ? { maxAgeHours: 0 } : {}),
    });
    return {
      pages: res.results.map(r => ({ title: r.title, url: r.url, text: clip(r.text, 8000) })),
    };
  },
});
