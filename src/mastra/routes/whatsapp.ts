import type { Mastra } from '@mastra/core';
import { RequestContext } from '@mastra/core/request-context';
import { registerApiRoute } from '@mastra/core/server';
import { waitUntil } from '@neon/functions';
import type { Context } from 'hono';
import { getCredits } from '../../lib/credits';
import { db, upsertUserByPhone } from '../../lib/db';
import { findDevRoute, forwardToDev, verifyDevForward } from '../../lib/devroutes';
import { phoneFromWhatsApp, sendWhatsApp, verifyTwilioSignature } from '../../lib/whatsapp';
import { onboardingReply } from './onboarding';

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

// Twilio retries webhooks it thinks failed; skip MessageSids we've already handled.
const seenMessageSids = new Set<string>();
// One agent turn at a time per phone so the thread doesn't interleave.
const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, job: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(job);
  queues.set(key, next);
  next.finally(() => queues.get(key) === next && queues.delete(key)).catch(() => {});
  return next;
}

/** Runs one user message through the concierge and returns the reply text. */
export async function handleIncomingMessage(mastra: Mastra, phone: string, text: string, name?: string) {
  const user = await upsertUserByPhone(phone, name);
  // Until mail/calendar are connected and analysed, every message gets the setup link.
  const onboarding = await onboardingReply(user);
  if (onboarding) return onboarding;

  const requestContext = new RequestContext();
  requestContext.set('userId', user.id);
  requestContext.set('phone', phone);

  const result = await mastra.getAgent('concierge').generate(text, {
    memory: { thread: `wa:${phone}`, resource: user.id },
    requestContext,
  });
  return result.text;
}

export const whatsappWebhook = registerApiRoute('/webhooks/whatsapp', {
  method: 'POST',
  requiresAuth: false,
  handler: async c => {
    const mastra = c.get('mastra');
    const rawBody = await c.req.text();
    const params = Object.fromEntries(new URLSearchParams(rawBody));
    // Forwarded by production to this dev worktree (see src/lib/devroutes.ts), or straight from Twilio.
    const forwarded = c.req.header('X-Dev-Forward');
    if (forwarded) {
      if (!verifyDevForward(forwarded, rawBody)) return c.text('invalid forward signature', 403);
    } else {
      const url = process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL.replace(/\/$/, '')}/webhooks/whatsapp` : c.req.url;
      if (!verifyTwilioSignature(c.req.header('X-Twilio-Signature'), url, params)) {
        return c.text('invalid signature', 403);
      }
    }

    const { MessageSid, From, Body, ProfileName } = params;
    if (!From || seenMessageSids.has(MessageSid)) return c.body(EMPTY_TWIML, 200, { 'Content-Type': 'text/xml' });
    seenMessageSids.add(MessageSid);

    const phone = phoneFromWhatsApp(From);
    const turn = () => enqueue(phone, async () => {
      try {
        const reply = await handleIncomingMessage(mastra, phone, Body ?? '', ProfileName);
        if (reply.trim()) await sendWhatsApp(phone, reply);
      } catch (err) {
        mastra.getLogger().error('whatsapp turn failed', { phone, err: String(err) });
        await sendWhatsApp(phone, 'Sorry, something broke on my side. Try again in a minute 🙏').catch(() => {});
      }
    });
    const route = forwarded ? null : await findDevRoute(phone);
    if (route) console.log('[devroutes] forwarding', { phone, worktree: route.worktree, targetUrl: route.targetUrl });
    // Answer Twilio right away (15s timeout) and reply out-of-band once the agent is done.
    // waitUntil keeps the Neon Function alive past the response; it's a no-op under `mastra dev`.
    waitUntil(route
      ? forwardToDev(route, rawBody).catch(async err => {
          mastra.getLogger().warn('dev forward failed, answering from prod', { phone, err: String(err) });
          await sendWhatsApp(phone, `⚠️ Dev worktree "${route.worktree}" is unreachable, so production is answering.`).catch(() => {});
          await turn();
        })
      : turn());

    return c.body(EMPTY_TWIML, 200, { 'Content-Type': 'text/xml' });
  },
});

/** Dev-only routes: gone in production, and behind X-Dev-Token whenever DEV_CHAT_TOKEN is set. */
export function devGuard(c: Context) {
  if (process.env.NODE_ENV === 'production') return c.text('not found', 404);
  // The server is reachable through a public tunnel; without this anyone could chat as any phone number.
  if (process.env.DEV_CHAT_TOKEN && c.req.header('X-Dev-Token') !== process.env.DEV_CHAT_TOKEN) {
    return c.text('missing or wrong X-Dev-Token', 401);
  }
  return null;
}

/** Local testing without Twilio: POST {"phone":"+4915...","text":"hi"} → {"reply":"..."} */
export const devChat = registerApiRoute('/dev/chat', {
  method: 'POST',
  requiresAuth: false,
  handler: async c => {
    const denied = devGuard(c);
    if (denied) return denied;
    const { phone, text, name } = await c.req.json<{ phone: string; text: string; name?: string }>();
    const reply = await enqueue(phone, () => handleIncomingMessage(c.get('mastra'), phone, text, name));
    return c.json({ reply });
  },
});

/**
 * What the app sent a phone, oldest first (the chat tools in plugins/worktrees poll this):
 * GET /dev/outbox?phone=+1555...&since=<iso, exclusive>&limit=50. Without `since`, the latest `limit` messages.
 * `now` is the database clock, so callers can use it as the next `since` without clock skew.
 */
export const devOutbox = registerApiRoute('/dev/outbox', {
  method: 'GET',
  requiresAuth: false,
  handler: async c => {
    const denied = devGuard(c);
    if (denied) return denied;
    const phone = c.req.query('phone');
    if (!phone) return c.json({ error: 'phone required' }, 400);
    const since = c.req.query('since') || null;
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 500);
    const { rows: messages } = await db.query(
      `SELECT * FROM (
         SELECT id::text, created_at AS at, body, media_url AS "mediaUrl", status, error FROM outbound_messages
         WHERE phone = $1 AND ($2::timestamptz IS NULL OR created_at > $2::timestamptz)
         ORDER BY created_at ${since ? 'ASC' : 'DESC'}, id ${since ? 'ASC' : 'DESC'} LIMIT $3
       ) m ORDER BY at, id::bigint`,
      [phone, since, limit],
    );
    const { rows } = await db.query(`SELECT now() AS now, (SELECT onboarding_status FROM users WHERE phone = $1) AS status`, [phone]);
    return c.json({ now: rows[0].now, onboardingStatus: rows[0].status ?? null, messages });
  },
});

/**
 * Start a test user from scratch: POST {"phone":"+1555..."} deletes the user (everything user-owned cascades),
 * its outbox and its chat thread. Worktree databases are copies of production, so only +1555 test numbers
 * unless {"force": true}.
 */
export const devResetUser = registerApiRoute('/dev/reset-user', {
  method: 'POST',
  requiresAuth: false,
  handler: async c => {
    const denied = devGuard(c);
    if (denied) return denied;
    const { phone, force } = await c.req.json<{ phone?: string; force?: boolean }>();
    if (!phone) return c.json({ error: 'phone required' }, 400);
    if (!phone.startsWith('+1555') && !force) {
      return c.json({ error: `${phone} is not a +1555 test number; pass force: true to reset a real user` }, 400);
    }
    const mastra = c.get('mastra');
    // Behind the phone's queue, so a turn still running doesn't write into the fresh state.
    const result = await enqueue(phone, async () => {
      const client = await db.connect();
      let userId: string | null = null;
      let outbox = 0;
      try {
        await client.query('BEGIN');
        const { rows } = await client.query<{ id: string }>(`SELECT id FROM users WHERE phone = $1`, [phone]);
        userId = rows[0]?.id ?? null;
        if (userId) {
          // The only reference to a user's bookings that doesn't go away with the user (an email we couldn't match to a user).
          await client.query(
            `UPDATE inbound_emails SET booking_id = NULL WHERE user_id IS NULL AND booking_id IN (SELECT id FROM bookings WHERE user_id = $1)`,
            [userId],
          );
          await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
        }
        outbox = (await client.query(`DELETE FROM outbound_messages WHERE phone = $1`, [phone])).rowCount ?? 0;
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      const memory = await mastra.getAgent('concierge').getMemory();
      const threadId = `wa:${phone}`;
      const hadThread = Boolean(memory && (await memory.getThreadById({ threadId })));
      if (hadThread) await memory!.deleteThread(threadId);
      return { phone, deletedUserId: userId, outboxDeleted: outbox, threadDeleted: hadThread };
    });
    return c.json(result);
  },
});

/**
 * A test user's bookings and the money side of them: GET /dev/bookings?phone=+1555… → bookings (newest first),
 * credit holds and credit ledger rows, and current credits. The worktrees plugin's chat_bookings tool reads this.
 */
export const devBookings = registerApiRoute('/dev/bookings', {
  method: 'GET',
  requiresAuth: false,
  handler: async c => {
    const denied = devGuard(c);
    if (denied) return denied;
    const phone = c.req.query('phone');
    if (!phone) return c.json({ error: 'phone required' }, 400);
    const { rows: users } = await db.query<{ id: string }>(`SELECT id FROM users WHERE phone = $1`, [phone]);
    const userId = users[0]?.id;
    if (!userId) return c.json({ phone, userId: null, credits: null, bookings: [], holds: [], ledger: [] });
    const [bookings, holds, ledger] = await Promise.all([
      db.query(
        `SELECT b.id, e.title AS event, b.showtime, b.qty, b.status, b.approved_cents AS "approvedCents", b.total_cents AS "totalCents",
                b.order_ref AS "orderRef", b.ticket_url AS "ticketUrl", b.hold_ref AS "holdRef", b.live_view_url AS "liveViewUrl",
                b.suspended_step AS "suspendedStep", b.error, b.created_at AS "createdAt", b.updated_at AS "updatedAt"
         FROM bookings b JOIN events e ON e.id = b.event_id WHERE b.user_id = $1 ORDER BY b.created_at DESC LIMIT 50`,
        [userId],
      ),
      db.query(
        `SELECT ref, booking_id AS "bookingId", amount_cents AS "amountCents", captured_cents AS "capturedCents", status, note,
                created_at AS "createdAt", settled_at AS "settledAt"
         FROM credit_holds WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [userId],
      ),
      db.query(
        `SELECT kind, amount_cents AS "amountCents", booking_id AS "bookingId", ref, note, created_at AS "createdAt"
         FROM credit_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [userId],
      ),
    ]);
    return c.json({ phone, userId, credits: await getCredits(userId), bookings: bookings.rows, holds: holds.rows, ledger: ledger.rows });
  },
});
