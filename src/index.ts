// Neon Function entry (see neon.ts): serves the whole Mastra server, i.e. the agent API under /api,
// plus the custom routes (WhatsApp webhook, onboarding + OAuth, /health). `mastra dev` doesn't use this file.
import { type HonoBindings, type HonoVariables, MastraServer } from '@mastra/hono';
import { Hono } from 'hono';
import { mastra } from './mastra';

const app = new Hono<{ Bindings: HonoBindings; Variables: HonoVariables }>();
await new MastraServer({ app, mastra }).init();

export default app;
