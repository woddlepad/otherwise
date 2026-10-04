import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AgentMailClient, AgentMailError } from 'agentmail';
import { db } from './db';

/**
 * The agent's own email inboxes (AgentMail), one per user, created lazily. See docs/agentmail.md.
 *
 * Environments: worktree databases are copies of production, so every inbox is tagged with the environment that
 * created it (client_id `${AGENTMAIL_ENV}.user-<id>`, metadata.env, users.agentmail_env) and each environment only
 * uses, subscribes to and processes its own inboxes.
 */

let client: AgentMailClient | undefined;
export function agentmail() {
  if (!process.env.AGENTMAIL_API_KEY) throw new Error('AGENTMAIL_API_KEY is not set');
  client ??= new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY });
  return client;
}

export function isAgentMailConfigured() {
  return Boolean(process.env.AGENTMAIL_API_KEY);
}

/** prod on Neon Functions, wt-<name> in a dev worktree, dev otherwise. */
export function agentmailEnv() {
  if (process.env.AGENTMAIL_ENV) return process.env.AGENTMAIL_ENV;
  if (process.env.WORKTREE_NAME) return `wt-${process.env.WORKTREE_NAME}`;
  return process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
}

/** How inbound mail arrives: a Svix-signed webhook (production) or a WebSocket subscription (dev, no public URL needed). */
export function inboundMode(): 'webhook' | 'websocket' {
  const mode = process.env.AGENTMAIL_INBOUND;
  if (mode === 'webhook' || mode === 'websocket') return mode;
  return agentmailEnv() === 'prod' ? 'webhook' : 'websocket';
}

// ---------- Inboxes ----------

export type UserInbox = { inboxId: string; email: string };

const inboxListeners = new Set<(inboxId: string) => void>();
/** Called with every inbox ensureInbox creates (the WebSocket subscriber adds it to its subscription). */
export function onInboxCreated(listener: (inboxId: string) => void) {
  inboxListeners.add(listener);
  return () => inboxListeners.delete(listener);
}

function firstNameSlug(name: string | null) {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  const slug = first
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 20);
  return slug || 'guest';
}

const shortId = () => BigInt(`0x${randomBytes(5).toString('hex')}`).toString(36).slice(0, 6).padStart(6, '0');

/** The user's inbox in this environment, if it exists (never creates one). */
export async function getUserInbox(userId: string): Promise<UserInbox | null> {
  const { rows } = await db.query<{ agentmail_inbox_id: string | null; agentmail_email: string | null; agentmail_env: string | null }>(
    `SELECT agentmail_inbox_id, agentmail_email, agentmail_env FROM users WHERE id = $1`,
    [userId],
  );
  const r = rows[0];
  if (!r?.agentmail_inbox_id || r.agentmail_env !== agentmailEnv()) return null;
  return { inboxId: r.agentmail_inbox_id, email: r.agentmail_email ?? r.agentmail_inbox_id };
}

/**
 * The user's agent inbox, created on first use: `<firstname>-<shortid>@agentmail.to` (AGENTMAIL_DOMAIN to override).
 * Idempotent: AgentMail returns the existing inbox for a repeated client_id, so concurrent calls get the same one.
 */
export async function ensureInbox(userId: string): Promise<UserInbox> {
  const existing = await getUserInbox(userId);
  if (existing) return existing;
  const { rows } = await db.query<{ name: string | null }>(`SELECT name FROM users WHERE id = $1`, [userId]);
  if (!rows[0]) throw new Error(`unknown user ${userId}`);
  const env = agentmailEnv();
  // client_id allows only [A-Za-z0-9._~-]: e.g. "wt-agentmail.user-<uuid>", "prod.user-<uuid>".
  const clientId = `${env.replace(/[^A-Za-z0-9_~-]/g, '-')}.user-${userId}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const inbox = await agentmail().inboxes.create({
        username: `${firstNameSlug(rows[0].name)}-${shortId()}`,
        domain: process.env.AGENTMAIL_DOMAIN || undefined,
        displayName: rows[0].name?.trim() || undefined,
        clientId,
        metadata: { env, userId },
      });
      await db.query(`UPDATE users SET agentmail_inbox_id = $2, agentmail_email = $3, agentmail_env = $4 WHERE id = $1`, [
        userId,
        inbox.inboxId,
        inbox.email,
        env,
      ]);
      console.log('[agentmail] inbox ready', { userId, inbox: inbox.inboxId, env });
      for (const listener of inboxListeners) {
        try {
          listener(inbox.inboxId);
        } catch (err) {
          console.error('[agentmail] inbox listener failed', String(err));
        }
      }
      return { inboxId: inbox.inboxId, email: inbox.email };
    } catch (err) {
      lastErr = err;
      // Username taken: try another suffix. Anything else (plan inbox limit, auth) won't get better by retrying.
      if (!(err instanceof AgentMailError && (err.statusCode === 409 || /taken/i.test(err.message)))) break;
    }
  }
  throw lastErr instanceof AgentMailError ? new Error(`AgentMail: ${lastErr.statusCode} ${JSON.stringify(lastErr.body ?? lastErr.message)}`) : lastErr;
}

/** Deletes the user's inbox if this environment created it (test-user resets; frees a plan slot). */
export async function deleteUserInbox(userId: string): Promise<string | null> {
  const inbox = await getUserInbox(userId);
  if (!inbox) return null;
  try {
    await agentmail().inboxes.delete(inbox.inboxId);
  } catch (err) {
    if (!(err instanceof AgentMailError && err.statusCode === 404)) throw err;
  }
  await db.query(`UPDATE users SET agentmail_inbox_id = NULL, agentmail_email = NULL, agentmail_env = NULL WHERE id = $1`, [userId]);
  return inbox.inboxId;
}

/** Inboxes this environment owns, for the WebSocket subscription. */
export async function ownInboxIds(): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT agentmail_inbox_id AS id FROM users WHERE agentmail_inbox_id IS NOT NULL AND agentmail_env = $1`,
    [agentmailEnv()],
  );
  return rows.map(r => r.id);
}

// ---------- Reading mail ----------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decodeEntities(s: string) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+|#39);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Readable text from an HTML mail; links become "label (url)" so the LLM and the extractors see them. */
export function htmlToText(html: string) {
  return decodeEntities(
    html
      .replace(/<(head|style|script)[\s\S]*?<\/\1>/gi, '')
      .replace(/<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
        const text = label.replace(/<[^>]+>/g, '').trim();
        return text && text !== href ? `${text} (${href})` : href;
      })
      .replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/table)\b[^>]*>/gi, '\n')
      .replace(/<td\b[^>]*>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type MailLink = { url: string; label: string | null };

const VERIFY_LINK = /verif|confirm|activat|magic|sign[-_ ]?in|log[-_ ]?in|token|validat|bestätig|aktivier/i;

/** Every http(s) link in the mail (deduped, in order), with its anchor text when it came from HTML. */
export function extractLinks(text: string | null, html: string | null): MailLink[] {
  const out = new Map<string, MailLink>();
  const add = (raw: string, label: string | null) => {
    const url = decodeEntities(raw).trim().replace(/[.,;:!?)\]]+$/, '');
    if (!/^https?:\/\//i.test(url) || out.has(url)) return;
    out.set(url, { url, label: label?.replace(/\s+/g, ' ').trim().slice(0, 80) || null });
  };
  for (const m of (html ?? '').matchAll(/<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    add(m[1], decodeEntities(m[2].replace(/<[^>]+>/g, '')));
  }
  for (const m of (text ?? '').matchAll(/https?:\/\/[^\s<>"'\])]+/gi)) add(m[0], null);
  return [...out.values()].slice(0, 80);
}

export function verificationLinks(links: MailLink[]) {
  return links.filter(l => VERIFY_LINK.test(l.url) || (l.label && VERIFY_LINK.test(l.label))).map(l => l.url);
}

/** Likely one-time codes: a 4–8 character token (with a digit) right after "code", "OTP", "PIN", ... */
export function extractCodes(text: string): string[] {
  const codes = new Set<string>();
  const near = /(code|otp|pin|passcode|password|verification|verify|bestätigungscode|token)\b[^\n]{0,40}/gi;
  for (const m of text.matchAll(near)) {
    for (const t of m[0].matchAll(/\b([A-Z0-9]{4,8}|\d{3}[- ]\d{3})\b/g)) {
      const code = t[1];
      if (!/\d/.test(code)) continue;
      if (/^(19|20)\d\d$/.test(code)) continue; // a year
      codes.add(code.replace(/[- ]/g, ''));
    }
  }
  // A 6-digit number alone on its line is almost always the code.
  for (const m of text.matchAll(/^\s*(\d{6})\s*$/gm)) codes.add(m[1]);
  return [...codes].slice(0, 5);
}

export function domainOf(address: string | null | undefined) {
  const m = (address ?? '').match(/@([^>\s]+)>?\s*$/);
  return m ? m[1].toLowerCase() : null;
}

export function hostOf(url: string | null | undefined) {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** a.b.eventbrite.com and mail.eventbrite.com share "eventbrite.com" (good enough for matching senders to sites). */
export function sameSite(a: string | null, b: string | null) {
  if (!a || !b) return false;
  const base = (h: string) => {
    const parts = h.split('.');
    const n = parts.length >= 3 && /^(co|com|org|net|ac|gov)$/.test(parts[parts.length - 2]) ? 3 : 2;
    return parts.slice(-n).join('.');
  };
  return base(a) === base(b);
}

export type ReceivedEmail = {
  messageId: string;
  inboxId: string;
  from: string;
  subject: string | null;
  receivedAt: string;
  text: string;
  links: MailLink[];
  verificationLinks: string[];
  codes: string[];
};

/** Plain text of a message (text part, else converted HTML), plus extracted links and codes. */
export function readMessage(m: { messageId: string; inboxId: string; from: string; subject?: string; timestamp: Date | string; text?: string; html?: string; extractedText?: string }): ReceivedEmail {
  const text = m.text?.trim() || (m.html ? htmlToText(m.html) : '') || m.extractedText || '';
  const links = extractLinks(m.text ?? null, m.html ?? null);
  return {
    messageId: m.messageId,
    inboxId: m.inboxId,
    from: m.from,
    subject: m.subject ?? null,
    receivedAt: new Date(m.timestamp).toISOString(),
    text,
    links,
    verificationLinks: verificationLinks(links),
    codes: extractCodes(`${m.subject ?? ''}\n${text}`),
  };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Waits for a matching email in the user's agent inbox by polling the API (works without webhooks/WebSockets).
 * Returns the first message received after `since` that matches, or null on timeout.
 */
export async function waitForEmail(
  userId: string,
  opts: { since: Date; fromDomain?: string; subjectIncludes?: string; timeoutMs?: number; pollMs?: number },
): Promise<ReceivedEmail | null> {
  const inbox = await getUserInbox(userId);
  if (!inbox) throw new Error('this user has no agent inbox yet (call signup-email first)');
  const deadline = Date.now() + Math.min(opts.timeoutMs ?? 90_000, 300_000);
  const after = new Date(opts.since.getTime() - 15_000); // clock skew between our DB and AgentMail
  const seen = new Set<string>();
  const fromDomain = opts.fromDomain?.toLowerCase().replace(/^www\./, '');
  const subject = opts.subjectIncludes?.toLowerCase();
  do {
    const list = await agentmail().inboxes.messages.list(inbox.inboxId, { after, ascending: true, limit: 50 });
    for (const item of list.messages) {
      if (seen.has(item.messageId)) continue;
      seen.add(item.messageId);
      if (item.labels.includes('sent')) continue;
      if (fromDomain && !sameSite(domainOf(item.from), fromDomain) && !domainOf(item.from)?.endsWith(fromDomain)) continue;
      if (subject && !(item.subject ?? '').toLowerCase().includes(subject)) continue;
      // Already classified by the inbound pipeline as a confirmation or newsletter: not what a signup waits for.
      const { rows: known } = await db.query<{ kind: string | null }>(`SELECT kind FROM agent_emails WHERE message_id = $1`, [item.messageId]);
      if (known[0]?.kind === 'confirmation' || known[0]?.kind === 'marketing') continue;
      const full = await agentmail().inboxes.messages.get(inbox.inboxId, item.messageId);
      return readMessage(full);
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(opts.pollMs ?? 4_000, Math.max(deadline - Date.now(), 0)));
  } while (Date.now() < deadline);
  return null;
}

/** Sends a plain email from an inbox (tests, or replying to a ticket shop). */
export async function sendEmail(fromInboxId: string, msg: { to: string[]; subject: string; text: string; html?: string; idempotencyKey?: string }) {
  return agentmail().inboxes.messages.send(
    fromInboxId,
    { to: msg.to, subject: msg.subject, text: msg.text, html: msg.html },
    msg.idempotencyKey ? { idempotencyKey: msg.idempotencyKey } : undefined,
  );
}

// ---------- Webhook signatures (Svix) ----------

const MAX_SKEW_S = 5 * 60;

/** Svix scheme: base64 HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${body}` with the base64 part of `whsec_...`. */
export function signSvix(secret: string, id: string, timestamp: string, body: string) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
}

export function verifySvix(
  secret: string | undefined,
  headers: { id?: string; timestamp?: string; signature?: string },
  rawBody: string,
  now = Date.now(),
) {
  const { id, timestamp, signature } = headers;
  if (!secret || !id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > MAX_SKEW_S) return false;
  const expected = Buffer.from(signSvix(secret, id, timestamp, rawBody));
  return signature.split(' ').some(part => {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) return false;
    const given = Buffer.from(sig);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
