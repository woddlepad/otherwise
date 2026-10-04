import type { Mastra } from '@mastra/core';
import { db } from '../db';
import { appendToThread } from '../thread';
import { sendWhatsApp } from '../whatsapp';
import { CATEGORY_LABEL, type EventCategory, type EventStatus } from './classify';
import { formatLocal } from './time';
import type { ScoredEvent } from './types';

export type Pick = {
  n: number;
  eventId: string;
  title: string;
  category: EventCategory;
  tags: string[];
  when: string;
  venue: string | null;
  address: string | null;
  city: string | null;
  distanceKm: number | null;        // from the user's home, when both are geocoded
  price: string | null;
  url: string;
  bookingUrl: string | null;        // direct Buy / Register / RSVP page (open this to book)
  status: EventStatus;              // availability, re-checked live for picks
  onSaleAt: string | null;          // ISO, for not_yet_on_sale
  why: string;
  matches: string[];
  confidence: number;
  decision: 'book' | 'ask' | 'skip';
  decisionReason: string;
  cancellation: string | null;      // e.g. "No refunds, exchange/credit only until Thu 8 Oct, 19:30 ($25 fee)"
  cancelBy: string | null;          // ISO instant, for the booking flow
  cancellationScope: 'event' | 'venue' | 'platform' | 'none' | null; // whose policy `cancellation` is (event page wins)
  cancellationUrl: string | null;   // verified cancel/manage link, or the ticket platform's order page
  policyUrl: string | null;         // page stating the policy
};

export function toPicks(events: ScoredEvent[], tz: string): Pick[] {
  return events.map((e, i) => ({
    n: i + 1,
    eventId: e.id,
    title: e.title,
    category: e.category,
    tags: e.tags,
    when: e.hasTime ? formatLocal(e.startsAt, tz) : `${formatLocal(e.startsAt, tz, false)} (time tbc)`,
    venue: e.venue,
    address: e.address,
    city: e.city,
    distanceKm: e.distanceKm,
    price: e.priceText,
    url: e.url,
    bookingUrl: e.bookingUrl,
    status: e.status,
    onSaleAt: e.onSaleAt,
    why: e.reason,
    matches: e.matches ?? [],
    confidence: e.confidence,
    decision: e.decision.action,
    decisionReason: e.decision.reason,
    cancellation: e.cancellation?.summary ?? null,
    cancelBy: e.cancellation?.cancelBy ?? null,
    cancellationScope: e.cancellation?.scope ?? null,
    cancellationUrl: e.cancellation?.cancellationUrl ?? null,
    policyUrl: e.cancellation?.policyUrl ?? null,
  }));
}

/** The numbers the user last saw, so "book #2" (book-event's `pick`) finds the event. */
export async function rememberPickNumbers(userId: string, picks: Pick[]) {
  if (!picks.length) return;
  await db.query(
    `UPDATE suggestions s SET pick_n = p.n, picked_at = now()
     FROM unnest($2::uuid[], $3::int[]) AS p(event_id, n) WHERE s.user_id = $1 AND s.event_id = p.event_id`,
    [userId, picks.map(p => p.eventId), picks.map(p => p.n)],
  );
}

/** The morning message: plain WhatsApp text, numbered so the user can answer "1", "2" or "3". */
export function picksMessage(picks: Pick[], name?: string | null, tz = process.env.DEFAULT_TIMEZONE || 'America/Los_Angeles') {
  const lines = picks.map(p => {
    const status =
      p.status === 'few_left' ? 'few left!'
      : p.status === 'waitlist' ? 'waitlist only'
      : p.status === 'not_yet_on_sale' ? `on sale ${p.onSaleAt ? formatLocal(new Date(p.onSaleAt), tz) : 'soon'}`
      : null;
    const where = [
      p.when,
      p.venue && `@ ${p.venue.split(',')[0]}`,
      p.distanceKm !== null && p.distanceKm !== undefined && `· ${p.distanceKm.toFixed(1)} km`,
      p.price && `(${p.price.replace(/^tickets?:?\s*/i, '')})`,
      status && `· *${status}*`,
    ]
      .filter(Boolean)
      .join(' ');
    const policy = p.cancellation ? `\n   ↩︎ ${p.cancellation}` : '';
    return `${p.n}. *${p.title}* · ${CATEGORY_LABEL[p.category]}\n   ${where}\n   ${p.why}${policy}\n   ${p.bookingUrl ?? p.url}`;
  });
  const sure = picks.find(p => p.decision === 'book');
  return [
    `Morning${name ? ` ${name.split(' ')[0]}` : ''}! ${picks.length === 1 ? 'One thing' : `${picks.length} things`} I think you'd love 🎟️`,
    '',
    lines.join('\n\n'),
    '',
    sure
      ? `I'm really sure about #${sure.n}. Say "yes" and I'll get tickets, or reply with another number.`
      : 'Reply with a number and I\'ll check tickets, or "none" and I\'ll learn from it.',
  ].join('\n');
}

/**
 * Sends the picks on WhatsApp and also writes the message into the user's concierge thread, so a reply of "2"
 * reaches an agent that knows what #2 was.
 */
export async function sendPicks(mastra: Mastra | undefined, userId: string, picks: Pick[]) {
  const { rows } = await db.query(`SELECT phone, name, timezone FROM users WHERE id = $1`, [userId]);
  const user = rows[0];
  if (!user || !picks.length) return { sent: false };
  picks = picks.map((p, i) => ({ ...p, n: i + 1 }));
  const text = picksMessage(picks, user.name, user.timezone || undefined);
  await sendWhatsApp(user.phone, text);
  await db.query(
    `UPDATE suggestions SET notified_at = now() WHERE user_id = $1 AND event_id = ANY($2::uuid[])`,
    [userId, picks.map(p => p.eventId)],
  );
  await rememberPickNumbers(userId, picks);

  const meta = picks.map(p => `#${p.n} = event ${p.eventId}`).join(', ');
  await appendToThread(mastra, userId, user.phone, `${text}\n\n(internal: ${meta})`);
  return { sent: true };
}
