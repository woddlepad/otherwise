import type { Mastra } from '@mastra/core';
import { RequestContext } from '@mastra/core/request-context';
import { registerApiRoute } from '@mastra/core/server';
import { waitUntil } from '@neon/functions';
import { upsertUserByPhone } from '../../lib/db';
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
    const params = Object.fromEntries(
      Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]),
    );
    const url = process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL.replace(/\/$/, '')}/webhooks/whatsapp` : c.req.url;
    if (!verifyTwilioSignature(c.req.header('X-Twilio-Signature'), url, params)) {
      return c.text('invalid signature', 403);
    }

    const { MessageSid, From, Body, ProfileName } = params;
    if (!From || seenMessageSids.has(MessageSid)) return c.body(EMPTY_TWIML, 200, { 'Content-Type': 'text/xml' });
    seenMessageSids.add(MessageSid);

    const phone = phoneFromWhatsApp(From);
    // Answer Twilio right away (15s timeout) and reply out-of-band once the agent is done.
    // waitUntil keeps the Neon Function alive past the response; it's a no-op under `mastra dev`.
    waitUntil(enqueue(phone, async () => {
      try {
        const reply = await handleIncomingMessage(mastra, phone, Body ?? '', ProfileName);
        if (reply.trim()) await sendWhatsApp(phone, reply);
      } catch (err) {
        mastra.getLogger().error('whatsapp turn failed', { phone, err: String(err) });
        await sendWhatsApp(phone, 'Sorry, something broke on my side. Try again in a minute 🙏').catch(() => {});
      }
    }));

    return c.body(EMPTY_TWIML, 200, { 'Content-Type': 'text/xml' });
  },
});

/** Local testing without Twilio: POST {"phone":"+4915...","text":"hi"} → {"reply":"..."} */
export const devChat = registerApiRoute('/dev/chat', {
  method: 'POST',
  requiresAuth: false,
  handler: async c => {
    if (process.env.NODE_ENV === 'production') return c.text('not found', 404);
    // The server is reachable through a public tunnel; without this anyone could chat as any phone number.
    if (process.env.DEV_CHAT_TOKEN && c.req.header('X-Dev-Token') !== process.env.DEV_CHAT_TOKEN) {
      return c.text('missing or wrong X-Dev-Token', 401);
    }
    const { phone, text, name } = await c.req.json<{ phone: string; text: string; name?: string }>();
    const reply = await enqueue(phone, () => handleIncomingMessage(c.get('mastra'), phone, text, name));
    return c.json({ reply });
  },
});
