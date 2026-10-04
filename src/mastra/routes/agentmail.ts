import { registerApiRoute } from '@mastra/core/server';
import { waitUntil } from '@neon/functions';
import { verifySvix } from '../../lib/agentmail';
import { db } from '../../lib/db';
import { fetchTicketAttachment, getConfirmation, handleInboundEmail } from '../../lib/email-inbound';

/**
 * AgentMail webhook (production; docs/agentmail.md): Svix-signed with AGENTMAIL_WEBHOOK_SECRET.
 * Answers right away and processes in the background; handleInboundEmail dedupes retries by message id and
 * ignores inboxes this environment didn't create.
 */
export const agentmailWebhook = registerApiRoute('/webhooks/agentmail', {
  method: 'POST',
  requiresAuth: false,
  handler: async c => {
    const rawBody = await c.req.text();
    const ok = verifySvix(
      process.env.AGENTMAIL_WEBHOOK_SECRET,
      { id: c.req.header('svix-id'), timestamp: c.req.header('svix-timestamp'), signature: c.req.header('svix-signature') },
      rawBody,
    );
    if (!ok) return c.text('invalid signature', 400);
    let payload: { event_type?: string; message?: unknown };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.text('bad json', 400);
    }
    if (payload.event_type !== 'message.received' || !payload.message) return c.json({ ok: true, ignored: payload.event_type ?? null });
    const mastra = c.get('mastra');
    waitUntil(
      handleInboundEmail(payload.message, 'webhook')
        .then(r => r.status !== 'processed' && console.log('[agentmail] webhook delivery', r))
        .catch(err => mastra.getLogger().error('agentmail inbound failed', { err: String(err) })),
    );
    return c.json({ ok: true });
  },
});

/** A ticket attachment from a confirmation email, by its unguessable token (linked from WhatsApp). */
export const ticketFile = registerApiRoute('/tickets/:token', {
  method: 'GET',
  requiresAuth: false,
  handler: async c => {
    const token = c.req.param('token');
    if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return c.text('not found', 404);
    let file: Awaited<ReturnType<typeof fetchTicketAttachment>>;
    try {
      file = await fetchTicketAttachment(token);
    } catch (err) {
      console.error('[agentmail] ticket download failed', String(err).slice(0, 300));
      return c.text('ticket file unavailable, try again later', 502);
    }
    if (!file) return c.text('not found', 404);
    return c.body(file.body, 200, {
      'Content-Type': file.contentType,
      'Content-Disposition': `inline; filename="${file.filename.replace(/["\\\r\n]/g, '')}"`,
      'Cache-Control': 'private, no-store',
    });
  },
});

/**
 * The confirmation email's details for a user's event (order number, ticket + manage/cancel links), for a booking
 * agent running as a separate service. Same auth as the handoff route:
 *   GET /events/:eventId/confirmation?userId=…  (or ?phone=+1555…)   → 404 until the confirmation has arrived
 */
export const eventConfirmation = registerApiRoute('/events/:eventId/confirmation', {
  method: 'GET',
  requiresAuth: false,
  handler: async c => {
    if (process.env.NODE_ENV === 'production' && !process.env.DEV_CHAT_TOKEN) return c.text('not found', 404);
    if (process.env.DEV_CHAT_TOKEN && c.req.header('X-Dev-Token') !== process.env.DEV_CHAT_TOKEN) {
      return c.text('missing or wrong X-Dev-Token', 401);
    }
    let userId = c.req.query('userId') ?? null;
    const phone = c.req.query('phone');
    if (!userId && phone) {
      const { rows } = await db.query<{ id: string }>(`SELECT id FROM users WHERE phone = $1`, [phone]);
      userId = rows[0]?.id ?? null;
    }
    if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) return c.json({ error: 'unknown user' }, 404);
    const conf = await getConfirmation(userId, c.req.param('eventId'));
    return conf ? c.json(conf) : c.json({ error: 'no confirmation email yet' }, 404);
  },
});
