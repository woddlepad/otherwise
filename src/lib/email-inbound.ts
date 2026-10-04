import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { scout } from '../mastra/agents/scout';
import {
  agentmail,
  agentmailEnv,
  hostOf,
  domainOf,
  inboundMode,
  isAgentMailConfigured,
  onInboxCreated,
  ownInboxIds,
  readMessage,
  sameSite,
  type MailLink,
} from './agentmail';
import { db } from './db';
import { DEFAULT_TIMEZONE } from './events/discover';
import { sendWhatsApp } from './whatsapp';

/**
 * Inbound mail for the agent inboxes: signup tracking, one handler for webhook and WebSocket deliveries,
 * LLM classification, confirmation → WhatsApp, and the confirmation read API for the booking side.
 */

// ---------- Signups ----------

export type SignupRecord = { id: string; createdAt: Date };

/** Remember that `email` was typed into a form for this event/page, so its mail can be matched to the event. */
export async function recordSignup(
  userId: string,
  s: { eventId?: string | null; url?: string | null; email: string; kind: 'agent' | 'user'; reason?: string },
): Promise<SignupRecord> {
  const eventId = s.eventId && /^[0-9a-f-]{36}$/i.test(s.eventId) ? s.eventId : null;
  let url = s.url ?? null;
  if (!url && eventId) {
    const { rows } = await db.query<{ url: string | null }>(
      `SELECT COALESCE(booking_url, source_url) AS url FROM events WHERE id = $1`,
      [eventId],
    );
    url = rows[0]?.url ?? null;
  }
  const { rows } = await db.query<{ id: string; created_at: Date }>(
    `INSERT INTO email_signups (user_id, event_id, url, site_domain, email, email_kind, reason)
     VALUES ($1, (SELECT id FROM events WHERE id = $2::uuid), $3, $4, $5, $6, $7) RETURNING id, created_at`,
    [userId, eventId, url, hostOf(url), s.email, s.kind, s.reason ?? null],
  );
  return { id: rows[0].id, createdAt: rows[0].created_at };
}

/** When the most recent signup with the agent inbox started (default `since` for waiting on a verification mail). */
export async function lastSignupAt(userId: string): Promise<Date | null> {
  const { rows } = await db.query<{ created_at: Date }>(
    `SELECT created_at FROM email_signups WHERE user_id = $1 AND email_kind = 'agent' ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  return rows[0]?.created_at ?? null;
}

// ---------- Inbound handling ----------

export type InboundAttachment = {
  attachmentId: string;
  filename: string | null;
  contentType: string | null;
  size: number;
  inline: boolean;
};

export type InboundMessage = {
  inboxId: string;
  messageId: string;
  threadId: string | null;
  from: string;
  subject: string | null;
  text: string | null;
  html: string | null;
  labels: string[];
  timestamp: Date;
  attachments: InboundAttachment[];
};

type Raw = Record<string, unknown>;
const pick = <T>(m: Raw, ...keys: string[]) => keys.map(k => m[k]).find(v => v !== undefined && v !== null) as T | undefined;

/** Webhook payloads are snake_case JSON, SDK (WebSocket) events camelCase objects: one shape for both. */
export function normalizeMessage(raw: unknown): InboundMessage {
  const m = (raw ?? {}) as Raw;
  const attachments = (pick<Raw[]>(m, 'attachments') ?? []).map(a => ({
    attachmentId: String(pick(a, 'attachment_id', 'attachmentId')),
    filename: pick<string>(a, 'filename') ?? null,
    contentType: pick<string>(a, 'content_type', 'contentType') ?? null,
    size: Number(pick(a, 'size') ?? 0),
    inline: pick(a, 'content_disposition', 'contentDisposition') === 'inline' || Boolean(pick(a, 'content_id', 'contentId')),
  }));
  return {
    inboxId: String(pick(m, 'inbox_id', 'inboxId')),
    messageId: String(pick(m, 'message_id', 'messageId')),
    threadId: pick<string>(m, 'thread_id', 'threadId') ?? null,
    from: String(pick(m, 'from', 'from_') ?? ''),
    subject: pick<string>(m, 'subject') ?? null,
    text: pick<string>(m, 'text') ?? null,
    html: pick<string>(m, 'html') ?? null,
    labels: pick<string[]>(m, 'labels') ?? [],
    timestamp: new Date(pick<string | Date>(m, 'timestamp', 'created_at', 'createdAt') ?? Date.now()),
    attachments,
  };
}

export const EMAIL_KINDS = ['verification', 'confirmation', 'marketing', 'other'] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

const linkRef = (what: string) => z.number().int().nullable().describe(`number of the ${what} in the LINKS list, null if there is none`);

const classifySchema = z.object({
  kind: z
    .enum(EMAIL_KINDS)
    .describe(
      'verification = asks to confirm the address / contains a one-time code or magic link; confirmation = THE email that confirms a ' +
        'registration, RSVP, order or ticket for a specific event (incl. "you are on the list", e-tickets, order receipts for tickets); ' +
        'marketing = newsletters, promotions, recommendations; other = anything else, incl. reminders, schedule notes and updates about ' +
        'an existing booking, account notices, replies',
    ),
  signupId: z.string().nullable().describe('id of the PENDING SIGNUP this email belongs to, null if none clearly matches'),
  summary: z.string().describe('one short line: what this email is'),
  verificationCode: z.string().nullable().describe('one-time code verbatim, if any'),
  verificationLink: linkRef('link that verifies the address / signs in'),
  booking: z
    .object({
      eventTitle: z.string().nullable(),
      startsAt: z.string().nullable().describe('event start as ISO 8601 with UTC offset, only if the email states date and time; else null'),
      whenText: z.string().nullable().describe('date/time exactly as written in the email'),
      venue: z.string().nullable().describe('venue name'),
      address: z.string().nullable(),
      orderRef: z.string().nullable().describe('order / booking / confirmation number verbatim'),
      ticketCount: z.number().int().nullable(),
      attendeeName: z.string().nullable(),
      ticketLink: linkRef('link to view / download the ticket or QR code'),
      manageLink: linkRef('link to manage / view the order or registration'),
      cancelLink: linkRef('link to cancel the registration or request a refund'),
    })
    .nullable()
    .describe('only for kind=confirmation, else null'),
});
type Classified = z.infer<typeof classifySchema>;

type Candidate = { id: string; title: string | null; url: string | null; siteDomain: string | null; createdAt: Date };

async function pendingSignups(userId: string): Promise<Candidate[]> {
  const { rows } = await db.query(
    `SELECT s.id, e.title, s.url, s.site_domain AS "siteDomain", s.created_at AS "createdAt"
     FROM email_signups s LEFT JOIN events e ON e.id = s.event_id
     WHERE s.user_id = $1 AND s.email_kind = 'agent' AND s.created_at > now() - interval '30 days'
     ORDER BY s.created_at DESC LIMIT 15`,
    [userId],
  );
  return rows;
}

async function classify(m: InboundMessage, text: string, links: MailLink[], candidates: Candidate[]): Promise<Classified> {
  const prompt = `Classify this email that arrived in a personal concierge's inbox (the concierge signs its user up for events) and extract the details.
Use only what the email says; never invent links, codes or numbers. Links are referenced by their number in LINKS.

FROM: ${m.from}
SUBJECT: ${m.subject ?? ''}
DATE: ${m.timestamp.toISOString()}
ATTACHMENTS: ${m.attachments.map(a => `${a.filename ?? 'unnamed'} (${a.contentType ?? '?'})`).join(', ') || 'none'}

BODY:
${text.slice(0, 12_000)}

LINKS:
${links.map((l, i) => `${i + 1}. ${l.label ? `[${l.label}] ` : ''}${l.url.slice(0, 300)}`).join('\n') || 'none'}

PENDING SIGNUPS (registrations the concierge started with this address):
${candidates.map(c => `- id=${c.id} | ${c.title ?? 'unknown event'} | ${c.url ?? ''} | site ${c.siteDomain ?? '?'} | started ${c.createdAt.toISOString()}`).join('\n') || 'none'}`;
  const res = await scout.generate(prompt, {
    structuredOutput: { schema: classifySchema, errorStrategy: 'strict', jsonPromptInjection: true },
  });
  return res.object as Classified;
}

const linkAt = (links: MailLink[], n: number | null | undefined) => (n && links[n - 1] ? links[n - 1].url : null);

/** Ticket-like attachments: PDFs, wallet passes and images that aren't inline logos. */
const isTicketAttachment = (a: InboundAttachment) =>
  /pdf|pkpass|apple\.pkpass/i.test(`${a.contentType} ${a.filename}`) || (/^image\//i.test(a.contentType ?? '') && !a.inline);

function publicBase() {
  return process.env.PUBLIC_URL?.replace(/\/$/, '') ?? null;
}

export type BookingConfirmation = {
  source: 'confirmation_email';
  emailId: string;
  messageId: string;
  receivedAt: string;
  eventId: string | null;
  signupId: string | null;
  from: string | null;
  subject: string | null;
  eventTitle: string | null;
  startsAt: string | null;
  whenText: string | null;
  venue: string | null;
  address: string | null;
  orderRef: string | null;
  ticketCount: number | null;
  ticketUrl: string | null;
  manageUrl: string | null;
  cancelUrl: string | null;
  attachments: { url: string | null; filename: string | null; contentType: string | null }[];
};

function formatWhen(c: { startsAt: string | null; whenText: string | null }, tz: string) {
  if (c.startsAt) {
    const d = new Date(c.startsAt);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    }
  }
  return c.whenText;
}

/** The WhatsApp message for a confirmation: everything the user needs, nothing forwarded to their own inbox. */
export function confirmationText(c: BookingConfirmation, tz: string) {
  const lines = [`🎟️ Confirmed: ${c.eventTitle ?? c.subject ?? 'your registration'}`];
  const when = formatWhen(c, tz);
  if (when) lines.push(`📅 ${when}`);
  if (c.venue || c.address) lines.push(`📍 ${[c.venue, c.address].filter(Boolean).join(', ')}`);
  if (c.orderRef) lines.push(`Order: ${c.orderRef}${c.ticketCount && c.ticketCount > 1 ? ` (${c.ticketCount} tickets)` : ''}`);
  const files = c.attachments.filter(a => a.url);
  if (c.ticketUrl) lines.push(`Ticket: ${c.ticketUrl}`);
  for (const a of files) lines.push(`${a.filename ?? 'Ticket file'}: ${a.url}`);
  if (c.manageUrl) lines.push(`Manage booking: ${c.manageUrl}`);
  if (c.cancelUrl && c.cancelUrl !== c.manageUrl) lines.push(`Cancel: ${c.cancelUrl}`);
  return lines.join('\n');
}

export type InboundResult =
  | { status: 'ignored'; reason: string }
  | { status: 'duplicate' }
  | { status: 'processed'; emailId: string; kind: EmailKind; eventId: string | null; notified: boolean };

/**
 * One entry point for every inbound email (webhook, WebSocket, catch-up). Ignores inboxes this environment didn't
 * create, dedupes by message id, stores, classifies, and for confirmations sends the user a WhatsApp message.
 * Verification mails are only stored: waitForEmail consumes them during a signup.
 */
export async function handleInboundEmail(raw: unknown, source = 'unknown'): Promise<InboundResult> {
  let m = normalizeMessage(raw);
  if (!m.inboxId || !m.messageId || m.messageId === 'undefined') return { status: 'ignored', reason: 'no inbox/message id' };
  if (m.labels.includes('sent')) return { status: 'ignored', reason: 'sent by us' };

  const { rows: users } = await db.query<{ id: string; phone: string; timezone: string | null }>(
    `SELECT id, phone, timezone FROM users WHERE agentmail_inbox_id = $1 AND agentmail_env = $2`,
    [m.inboxId, agentmailEnv()],
  );
  const user = users[0];
  if (!user) return { status: 'ignored', reason: `inbox ${m.inboxId} is not one of ${agentmailEnv()}'s` };

  // Claim: a new row, or one whose earlier processing died more than 2 minutes ago. Anything else is a duplicate delivery.
  const { rows: claimed } = await db.query<{ id: string }>(
    `INSERT INTO agent_emails (user_id, inbox_id, message_id, thread_id, from_address, subject, received_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (message_id) DO UPDATE SET claimed_at = now()
       WHERE agent_emails.processed_at IS NULL AND agent_emails.claimed_at < now() - interval '2 minutes'
     RETURNING id`,
    [user.id, m.inboxId, m.messageId, m.threadId, m.from, m.subject, m.timestamp],
  );
  const emailId = claimed[0]?.id;
  if (!emailId) return { status: 'duplicate' };

  // WebSocket/webhook events carry the body; fetch the full message if this one doesn't.
  if (!m.text && !m.html) {
    const full = await agentmail().inboxes.messages.get(m.inboxId, m.messageId);
    m = normalizeMessage(full);
  }
  const read = readMessage({ ...m, subject: m.subject ?? undefined, text: m.text ?? undefined, html: m.html ?? undefined });
  const candidates = await pendingSignups(user.id);
  const c = await classify(m, read.text, read.links, candidates);

  // Match to a signup: the LLM's pick if it is a real candidate, else the only candidate whose site sent this.
  const fromDomain = domainOf(m.from);
  const linkHosts = read.links.map(l => hostOf(l.url));
  const signup =
    candidates.find(s => s.id === c.signupId) ??
    (() => {
      const bySite = candidates.filter(s => sameSite(s.siteDomain, fromDomain) || linkHosts.some(h => sameSite(s.siteDomain, h)));
      return bySite.length === 1 ? bySite[0] : undefined;
    })();
  const { rows: ev } = signup
    ? await db.query<{ event_id: string | null }>(`SELECT event_id FROM email_signups WHERE id = $1`, [signup.id])
    : { rows: [] as { event_id: string | null }[] };
  const eventId = ev[0]?.event_id ?? null;

  const b = c.kind === 'confirmation' ? c.booking : null;
  const extracted = {
    summary: c.summary,
    source,
    links: read.links.slice(0, 40),
    // Code-like tokens only mean something in verification mails (elsewhere they are discount codes, order numbers, ...).
    codes: c.kind !== 'verification' ? [] : c.verificationCode ? [c.verificationCode, ...read.codes.filter(x => x !== c.verificationCode)] : read.codes,
    verificationLink: linkAt(read.links, c.verificationLink),
    attachments: m.attachments,
    ...(b && {
      booking: {
        eventTitle: b.eventTitle,
        startsAt: b.startsAt && !Number.isNaN(new Date(b.startsAt).getTime()) ? new Date(b.startsAt).toISOString() : null,
        whenText: b.whenText,
        venue: b.venue,
        address: b.address,
        orderRef: b.orderRef,
        ticketCount: b.ticketCount,
        attendeeName: b.attendeeName,
        ticketUrl: linkAt(read.links, b.ticketLink),
        manageUrl: linkAt(read.links, b.manageLink),
        cancelUrl: linkAt(read.links, b.cancelLink),
      },
    }),
  };

  // Ticket files get an unguessable app URL (the AgentMail download link expires).
  if (b) {
    for (const a of m.attachments.filter(isTicketAttachment)) {
      await db.query(
        `INSERT INTO email_attachments (token, email_id, attachment_id, filename, content_type, size) VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomBytes(24).toString('base64url'), emailId, a.attachmentId, a.filename, a.contentType, a.size],
      );
    }
  }

  await db.query(
    `UPDATE agent_emails SET text = $2, kind = $3, signup_id = $4, event_id = $5, extracted = $6, processed_at = now() WHERE id = $1`,
    [emailId, read.text.slice(0, 50_000), c.kind, signup?.id ?? null, eventId, JSON.stringify(extracted)],
  );
  console.log('[agentmail] inbound', { source, messageId: m.messageId, kind: c.kind, signup: signup?.id ?? null, eventId, summary: c.summary });

  let notified = false;
  if (c.kind === 'confirmation') {
    // A second confirmation for the same signup (resend, "updated ticket") is stored but not pushed again.
    const { rows: earlier } = signup
      ? await db.query(`SELECT 1 FROM agent_emails WHERE signup_id = $1 AND id <> $2 AND notified_at IS NOT NULL LIMIT 1`, [signup.id, emailId])
      : { rows: [] };
    if (signup) await db.query(`UPDATE email_signups SET status = 'confirmed' WHERE id = $1`, [signup.id]);
    const conf = await confirmationById(emailId);
    if (conf && eventId && (conf.ticketUrl || conf.attachments[0]?.url)) {
      await db.query(`UPDATE bookings SET ticket_url = $3, updated_at = now() WHERE user_id = $1 AND event_id = $2 AND ticket_url IS NULL`, [
        user.id,
        eventId,
        conf.ticketUrl ?? conf.attachments[0].url,
      ]);
    }
    // At most one WhatsApp per email, even if two deliveries race past the claim.
    const { rowCount } = earlier.length
      ? { rowCount: 0 }
      : await db.query(`UPDATE agent_emails SET notified_at = now() WHERE id = $1 AND notified_at IS NULL`, [emailId]);
    if (conf && rowCount && !earlier.length) {
      await sendWhatsApp(user.phone, confirmationText(conf, user.timezone || DEFAULT_TIMEZONE));
      notified = true;
    }
  }
  return { status: 'processed', emailId, kind: c.kind, eventId, notified };
}

// ---------- Confirmations (read side for the booking agent / handoff) ----------

async function confirmationById(emailId: string): Promise<BookingConfirmation | null> {
  const { rows } = await db.query(
    `SELECT id, message_id, received_at, event_id, signup_id, from_address, subject, extracted FROM agent_emails WHERE id = $1 AND kind = 'confirmation'`,
    [emailId],
  );
  return rows[0] ? toConfirmation(rows[0]) : null;
}

async function toConfirmation(r: Record<string, any>): Promise<BookingConfirmation> {
  const b = r.extracted?.booking ?? {};
  const { rows: files } = await db.query<{ token: string; filename: string | null; content_type: string | null }>(
    `SELECT token, filename, content_type FROM email_attachments WHERE email_id = $1 ORDER BY created_at`,
    [r.id],
  );
  const base = publicBase();
  return {
    source: 'confirmation_email',
    emailId: r.id,
    messageId: r.message_id,
    receivedAt: new Date(r.received_at).toISOString(),
    eventId: r.event_id,
    signupId: r.signup_id,
    from: r.from_address,
    subject: r.subject,
    eventTitle: b.eventTitle ?? null,
    startsAt: b.startsAt ?? null,
    whenText: b.whenText ?? null,
    venue: b.venue ?? null,
    address: b.address ?? null,
    orderRef: b.orderRef ?? null,
    ticketCount: b.ticketCount ?? null,
    ticketUrl: b.ticketUrl ?? null,
    manageUrl: b.manageUrl ?? null,
    cancelUrl: b.cancelUrl ?? null,
    attachments: files.map(f => ({ url: base ? `${base}/tickets/${f.token}` : null, filename: f.filename, contentType: f.content_type })),
  };
}

/**
 * The latest confirmation email for a user's event: order number, ticket and manage/cancel links
 * (`source: 'confirmation_email'`, see BookingHandoff 1.1's contract). null until the confirmation has arrived.
 */
export async function getConfirmation(userId: string, eventId: string): Promise<BookingConfirmation | null> {
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) return null;
  const { rows } = await db.query(
    `SELECT id, message_id, received_at, event_id, signup_id, from_address, subject, extracted FROM agent_emails
     WHERE user_id = $1 AND event_id = $2 AND kind = 'confirmation' ORDER BY received_at DESC LIMIT 1`,
    [userId, eventId],
  );
  return rows[0] ? toConfirmation(rows[0]) : null;
}

/** Bytes of a ticket attachment by its token (for GET /tickets/:token). */
export async function fetchTicketAttachment(token: string) {
  const { rows } = await db.query<{ attachment_id: string; filename: string | null; content_type: string | null; inbox_id: string; message_id: string }>(
    `SELECT a.attachment_id, a.filename, a.content_type, e.inbox_id, e.message_id
     FROM email_attachments a JOIN agent_emails e ON e.id = a.email_id WHERE a.token = $1`,
    [token],
  );
  const a = rows[0];
  if (!a) return null;
  const meta = await agentmail().inboxes.messages.getAttachment(a.inbox_id, a.message_id, a.attachment_id);
  const res = await fetch(meta.downloadUrl, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`attachment download failed: ${res.status}`);
  return {
    body: new Uint8Array(await res.arrayBuffer()),
    contentType: a.content_type ?? meta.contentType ?? 'application/octet-stream',
    filename: a.filename ?? meta.filename ?? 'ticket',
  };
}

// ---------- WebSocket subscriber (dev / worktrees) ----------

type Subscriber = { close(): void };
const g = globalThis as { __agentmailInbound?: Subscriber };

/** Mail that arrived while the subscriber was down: recent messages of inboxes with a recent signup. */
async function catchUp() {
  const { rows } = await db.query<{ inbox: string; since: Date }>(
    `SELECT u.agentmail_inbox_id AS inbox,
       GREATEST(now() - interval '2 days', COALESCE((SELECT max(received_at) FROM agent_emails e WHERE e.inbox_id = u.agentmail_inbox_id), now() - interval '2 days')) AS since
     FROM users u WHERE u.agentmail_env = $1 AND u.agentmail_inbox_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM email_signups s WHERE s.user_id = u.id AND s.created_at > now() - interval '14 days')`,
    [agentmailEnv()],
  );
  for (const { inbox, since } of rows) {
    const list = await agentmail().inboxes.messages.list(inbox, { after: new Date(since.getTime() - 60_000), ascending: true, limit: 50 });
    const ids = list.messages.filter(x => !x.labels.includes('sent')).map(x => x.messageId);
    if (!ids.length) continue;
    const { rows: known } = await db.query<{ message_id: string }>(
      `SELECT message_id FROM agent_emails WHERE message_id = ANY($1) AND processed_at IS NOT NULL`,
      [ids],
    );
    const done = new Set(known.map(k => k.message_id));
    for (const id of ids.filter(i => !done.has(i))) {
      const full = await agentmail().inboxes.messages.get(inbox, id);
      await handleInboundEmail(full, 'catchup').catch(err => console.error('[agentmail] catch-up failed', id, String(err)));
    }
  }
}

/**
 * Starts the WebSocket subscription for this environment's inboxes (only in websocket mode). The SDK reconnects with
 * backoff and re-sends subscriptions; on every (re)open we also resubscribe and catch up on mail missed meanwhile.
 * New inboxes (ensureInbox) are added to the subscription. Idempotent across hot reloads.
 */
export async function startAgentMailInbound(): Promise<void> {
  if (inboundMode() !== 'websocket' || !isAgentMailConfigured()) return;
  g.__agentmailInbound?.close();
  const env = agentmailEnv();
  const inboxes = new Set(await ownInboxIds());
  let closed = false;
  const socket = await agentmail().websockets.connect();
  // Never subscribe with an empty list: no inbox ids means "the whole organisation", including production's inboxes.
  const subscribe = () => {
    if (closed || !inboxes.size) return;
    try {
      socket.sendSubscribe({ type: 'subscribe', inboxIds: [...inboxes], eventTypes: ['message.received'] });
    } catch (err) {
      console.warn('[agentmail] subscribe deferred until reconnect:', String(err));
    }
  };
  const runCatchUp = () => catchUp().catch(err => console.error('[agentmail] catch-up failed', String(err)));
  socket.on('open', () => {
    console.log('[agentmail] websocket reconnected');
    subscribe();
    runCatchUp();
  });
  socket.on('message', event => {
    if (event.type === 'subscribed') console.log('[agentmail] subscribed', { env, inboxes: event.inboxIds?.length ?? 0 });
    else if ('eventType' in event && 'message' in event) {
      // The SDK types say {type: 'event', eventType: 'message.received'}; older docs say type 'message_received'.
      if (event.eventType !== 'message.received') return;
      handleInboundEmail(event.message, 'websocket').catch(err => console.error('[agentmail] inbound failed', String(err)));
    } else if (event.type === 'error') console.error('[agentmail] websocket error event', event);
  });
  socket.on('close', e => !closed && console.warn('[agentmail] websocket closed', e.code, e.reason));
  socket.on('error', err => console.error('[agentmail] websocket error', String(err)));
  const off = onInboxCreated(id => {
    inboxes.add(id);
    subscribe();
  });
  g.__agentmailInbound = {
    close: () => {
      closed = true;
      off();
      socket.close();
    },
  };
  subscribe();
  runCatchUp();
  console.log('[agentmail] websocket inbound started', { env, inboxes: inboxes.size });
}
