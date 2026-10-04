import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { getCalendarEvents } from '../../lib/calendar';
import { db, getBudgetStatus } from '../../lib/db';
import { getMailSignals } from '../../lib/mail';
import { connectedProviders } from '../../lib/connections';
import { saveTasteProfile, tasteProfileSchema } from '../../lib/taste';
import { sendWhatsApp } from '../../lib/whatsapp';

const DAY = 86_400_000;

const gatherSignals = createStep({
  id: 'gather-signals',
  inputSchema: z.object({ userId: z.string() }),
  outputSchema: z.object({ userId: z.string(), signals: z.string(), counts: z.object({ emails: z.number(), events: z.number() }) }),
  execute: async ({ inputData: { userId }, mastra }) => {
    const { rows } = await db.query(`SELECT name, city, interests, timezone FROM users WHERE id = $1`, [userId]);
    const user = rows[0];
    const now = Date.now();
    // A failing provider shouldn't sink onboarding; analyse whatever we got.
    const [emails, events] = await Promise.all([
      getMailSignals(userId).catch(err => (mastra.getLogger().warn('mail fetch failed', { err: String(err) }), [])),
      getCalendarEvents(userId, new Date(now - 180 * DAY), new Date(now + 30 * DAY)).catch(
        err => (mastra.getLogger().warn('calendar fetch failed', { err: String(err) }), []),
      ),
    ]);
    const signals = [
      `User: ${user.name ?? 'unknown'} · city: ${user.city ?? 'unknown'} · timezone: ${user.timezone ?? 'unknown'}`,
      `What they told us: ${user.interests || '(nothing)'}`,
      `\n## Event-related emails (last year, ${emails.length})`,
      ...emails.map(m => `- ${m.date} | ${m.from} | ${m.subject} | ${m.snippet.replace(/\s+/g, ' ').slice(0, 160)}`),
      `\n## Calendar (past 6 months → next 30 days, ${events.length})`,
      ...events.map(e => `- ${e.start.slice(0, 16)} → ${e.end.slice(11, 16)} | ${e.title}${e.location ? ` @ ${e.location}` : ''}`),
    ].join('\n');
    return { userId, signals, counts: { emails: emails.length, events: events.length } };
  },
});

const analyzeTaste = createStep({
  id: 'analyze-taste',
  inputSchema: gatherSignals.outputSchema,
  outputSchema: z.object({ userId: z.string(), profile: tasteProfileSchema }),
  execute: async ({ inputData: { userId, signals }, mastra }) => {
    const result = await mastra.getAgent('analyst').generate(
      `Build this person's taste profile for going out. If the data is thin, say so in the summary, keep strengths low and add open questions.\n\n${signals}`,
      { structuredOutput: { schema: tasteProfileSchema, errorStrategy: 'strict', jsonPromptInjection: true } },
    );
    await saveTasteProfile(userId, result.object);
    return { userId, profile: result.object };
  },
});

const notifyReady = createStep({
  id: 'notify-ready',
  inputSchema: analyzeTaste.outputSchema,
  outputSchema: z.object({ sent: z.boolean() }),
  execute: async ({ inputData: { userId, profile }, mastra }) => {
    const { rows } = await db.query(`SELECT phone, name FROM users WHERE id = $1`, [userId]);
    const { phone, name } = rows[0];
    const budget = await getBudgetStatus(userId);
    const connected = (await connectedProviders(userId)).map(p => (p === 'google' ? 'Google' : 'Outlook'));

    const intro = await mastra.getAgent('analyst').generate(
      `Write a WhatsApp message (max 5 short lines, plain text, 1–2 emoji, no markdown) to ${name ?? 'the user'} saying
setup is done and what you picked up about their taste, so they can correct you. Be concrete and a bit playful.
End with one of the open questions if there is a good one.\n\nProfile:\n${JSON.stringify(profile)}`,
    );
    const money = (c: number) => `${(c / 100).toFixed(0)} ${budget.currency}`;
    const rules =
      `Budget: ${money(budget.monthlyLimitCents)}/month. I'll surprise you with bookings I'm really sure about ` +
      `(up to ${money(budget.autoApproveCents)}) and ask about everything else.`;
    const sources = connected.length ? `\n(Read from: ${connected.join(' + ')})` : '';

    await sendWhatsApp(phone, `${intro.text.trim()}\n\n${rules}${sources}\n\nReady to go 🚀`);
    await db.query(`UPDATE users SET onboarding_status = 'ready' WHERE id = $1`, [userId]);
    return { sent: true };
  },
});

export const onboardUser = createWorkflow({
  id: 'onboard-user',
  inputSchema: z.object({ userId: z.string() }),
  outputSchema: z.object({ sent: z.boolean() }),
})
  .then(gatherSignals)
  .then(analyzeTaste)
  .then(notifyReady)
  .commit();
