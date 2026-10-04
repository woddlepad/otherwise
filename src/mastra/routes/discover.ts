import type { Mastra } from '@mastra/core';
import { registerApiRoute } from '@mastra/core/server';
import { waitUntil } from '@neon/functions';
import { db, upsertUserByPhone } from '../../lib/db';

async function runDiscovery(mastra: Mastra, userId: string, trigger: 'daily' | 'manual', notify: boolean) {
  const run = await mastra.getWorkflow('discoverEvents').createRun();
  const res = await run.start({ inputData: { userId, trigger, notify } });
  if (res.status !== 'success') mastra.getLogger().error('discover-events failed', { userId, status: res.status });
  return res;
}

/**
 * Daily discovery for every onboarded user. Called by a Neon scheduled Function Trigger (UTC cron in neon.ts),
 * or by anything holding CRON_SECRET. Answers 202 at once and works in the background; a user's second daily
 * run on the same local day is a no-op (discovery_runs), so redelivered triggers are harmless.
 */
export const cronDiscover = registerApiRoute('/cron/discover', {
  method: 'POST',
  requiresAuth: false,
  handler: async c => {
    // Neon strips client-sent X-Neon-* headers, so this one can only come from its trigger system.
    const fromNeon = Boolean(c.req.header('x-neon-trigger-invocation-id'));
    const secret = process.env.CRON_SECRET;
    const bearer = secret && c.req.header('Authorization') === `Bearer ${secret}`;
    if (!fromNeon && !bearer) return c.text('forbidden', 403);

    const mastra = c.get('mastra');
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM users WHERE onboarding_status = 'ready'`);
    waitUntil(
      (async () => {
        for (const { id } of rows) {
          await runDiscovery(mastra, id, 'daily', true).catch(err =>
            mastra.getLogger().error('daily discovery failed', { userId: id, err: String(err) }),
          );
        }
      })(),
    );
    return c.json({ accepted: true, users: rows.length }, 202);
  },
});

/** Manual run for the demo / debugging: POST {"phone":"+1415..."} (or userId), optional "notify": false. Waits for the result. */
export const devDiscover = registerApiRoute('/dev/discover', {
  method: 'POST',
  requiresAuth: false,
  handler: async c => {
    if (process.env.NODE_ENV === 'production' && !process.env.DEV_CHAT_TOKEN) return c.text('not found', 404);
    if (process.env.DEV_CHAT_TOKEN && c.req.header('X-Dev-Token') !== process.env.DEV_CHAT_TOKEN) {
      return c.text('missing or wrong X-Dev-Token', 401);
    }
    const body = await c.req.json<{ phone?: string; userId?: string; notify?: boolean }>();
    const userId = body.userId ?? (body.phone ? (await upsertUserByPhone(body.phone)).id : null);
    if (!userId) return c.json({ error: 'phone or userId required' }, 400);
    const res = await runDiscovery(c.get('mastra'), userId, 'manual', body.notify ?? true);
    return c.json(res.status === 'success' ? res.result : { status: res.status, error: String((res as { error?: unknown }).error ?? '') });
  },
});
