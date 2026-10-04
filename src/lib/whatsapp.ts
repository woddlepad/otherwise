import twilio from 'twilio';

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

export async function sendWhatsApp(phone: string, text: string, mediaUrl?: string) {
  if (!isTwilioConfigured()) {
    console.log(`[whatsapp:dry-run] → ${phone}: ${text}`);
    return;
  }
  const chunks = splitMessage(text);
  for (const [i, body] of chunks.entries()) {
    await getClient().messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM!,
      to: `whatsapp:${phone}`,
      body,
      ...(mediaUrl && i === chunks.length - 1 ? { mediaUrl: [mediaUrl] } : {}),
    });
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
