import { registerApiRoute } from '@mastra/core/server';
import { db } from '../../lib/db';
import { HandoffNotFound, getBookingHandoff } from '../../lib/events/handoff';

/**
 * Booking handoff v1 (PLAN §8.10) for a booking agent running as a separate service:
 *   GET /events/:eventId/handoff?userId=…   (or ?phone=+1555…; &refresh=false skips the live re-check)
 * Not under /api as PLAN §8.10 first said: Mastra reserves /api/* for its built-in routes and refuses to start.
 * Auth: header X-Dev-Token = DEV_CHAT_TOKEN when that is set (same as /dev/discover).
 */
export const eventHandoff = registerApiRoute('/events/:eventId/handoff', {
  method: 'GET',
  requiresAuth: false,
  handler: async c => {
    if (process.env.NODE_ENV === 'production' && !process.env.DEV_CHAT_TOKEN) return c.text('not found', 404);
    if (process.env.DEV_CHAT_TOKEN && c.req.header('X-Dev-Token') !== process.env.DEV_CHAT_TOKEN) {
      return c.text('missing or wrong X-Dev-Token', 401);
    }
    const eventId = c.req.param('eventId');
    let userId = c.req.query('userId') ?? null;
    const phone = c.req.query('phone');
    if (!userId && phone) {
      const { rows } = await db.query<{ id: string }>(`SELECT id FROM users WHERE phone = $1`, [phone]);
      userId = rows[0]?.id ?? null;
      if (!userId) return c.json({ error: 'unknown user' }, 404);
    }
    if (!userId) return c.json({ error: 'userId or phone required' }, 400);
    if (!/^[0-9a-f-]{36}$/i.test(userId)) return c.json({ error: 'unknown user' }, 404);
    try {
      return c.json(await getBookingHandoff(userId, eventId, { refresh: c.req.query('refresh') !== 'false' }));
    } catch (err) {
      if (err instanceof HandoffNotFound) return c.json({ error: err.message }, 404);
      throw err;
    }
  },
});
