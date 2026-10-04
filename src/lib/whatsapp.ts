import twilio from 'twilio';
import { db } from './db';

// Twilio rejects message bodies over 1600 characters.
const MAX_BODY = 1500;

let client: ReturnType<typeof twilio> | undefined;
function getClient() {
  client ??= twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return client;
}

export function isTwilioConfigured() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_FROM);
}

/** `whatsapp:+49151...` → `+49151...` */
export function phoneFromWhatsApp(address: string) {
  return address.replace(/^whatsapp:/, '');
}

// Dev worktrees run on a copy of production data, so they may only message these numbers (comma-separated E.164).
const allowlist = process.env.WHATSAPP_ALLOWLIST?.split(',').map(p => p.trim()).filter(Boolean);

export type OutboundStatus = 'sent' | 'dry_run' | 'not_allowlisted' | 'failed';

export async function sendWhatsApp(phone: string, text: string, mediaUrl?: string) {
  if (!isTwilioConfigured() || (allowlist && !allowlist.includes(phone))) {
    console.log(`[whatsapp:${allowlist ? 'not-allowlisted' : 'dry-run'}] → ${phone}: ${text}`);
    await recordOutbound(phone, text, mediaUrl, allowlist ? 'not_allowlisted' : 'dry_run');
    return;
  }
  try {
    const chunks = splitMessage(text);
    for (const [i, body] of chunks.entries()) {
      await getClient().messages.create({
        from: process.env.TWILIO_WHATSAPP_FROM!,
        to: `whatsapp:${phone}`,
        body,
        ...(mediaUrl && i === chunks.length - 1 ? { mediaUrl: [mediaUrl] } : {}),
      });
    }
  } catch (err) {
    await recordOutbound(phone, text, mediaUrl, 'failed', String(err));
    throw err;
  }
  await recordOutbound(phone, text, mediaUrl, 'sent');
}

/** Outbox row for every send (the chat tools read replies from it); a DB problem must never stop a message. */
async function recordOutbound(phone: string, body: string, mediaUrl: string | undefined, status: OutboundStatus, error?: string) {
  try {
    await db.query(`INSERT INTO outbound_messages (phone, body, media_url, status, error) VALUES ($1, $2, $3, $4, $5)`, [
      phone,
      body,
      mediaUrl ?? null,
      status,
      error ?? null,
    ]);
  } catch (err) {
    console.error('[whatsapp] could not record outbound message', { phone, status, err: String(err) });
  }
}

export function verifyTwilioSignature(signature: string | undefined, url: string, params: Record<string, string>) {
  if (process.env.TWILIO_SKIP_SIGNATURE === '1') return true;
  if (!signature || !process.env.TWILIO_AUTH_TOKEN) return false;
  return twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, url, params);
}

function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > MAX_BODY) {
    const cut = Math.max(rest.lastIndexOf('\n', MAX_BODY), rest.lastIndexOf(' ', MAX_BODY));
    const at = cut > MAX_BODY / 2 ? cut : MAX_BODY;
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
