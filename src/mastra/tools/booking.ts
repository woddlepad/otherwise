import type { Mastra } from '@mastra/core';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { createBooking, eur, loadBooking, showtimeLabel, updateBooking, userBookings, type Booking } from '../../lib/booking/store';
import { db } from '../../lib/db';
import { DEFAULT_TIMEZONE } from '../../lib/events/discover';
import { notBookable } from '../../lib/events/handoff';
import { loadEvent } from '../../lib/events/store';
import { resumeBooking, startBooking } from '../workflows/book';

function userIdFrom(requestContext: { get(key: string): unknown } | undefined): string {
  const userId = requestContext?.get('userId');
  if (typeof userId !== 'string') throw new Error('userId missing from request context');
  return userId;
}

const view = (b: Booking) => ({
  bookingId: b.id,
  event: b.title,
  when: showtimeLabel(b),
  qty: b.qty,
  status: b.status,
  total: b.totalCents !== null ? eur(b.totalCents) : null,
  // While a re-approval is pending this is still the earlier amount, so only show it once settled.
  approved: b.approvedCents !== null && !['awaiting_approval', 'needs_human'].includes(b.status) ? eur(b.approvedCents) : null,
  ticketUrl: b.ticketUrl,
  orderNumber: b.orderRef,
  liveViewUrl: b.status === 'needs_human' ? b.liveViewUrl : null,
  error: b.status === 'failed' ? b.error : null,
});

async function ownBooking(bookingId: string, userId: string) {
  const b = await loadBooking(bookingId);
  return b && b.userId === userId ? b : null;
}

/** The event behind pick #n of the list the user saw last (find-events or the morning message). */
async function eventForPick(userId: string, n: number) {
  const { rows } = await db.query<{ event_id: string }>(
    `SELECT event_id FROM suggestions WHERE user_id = $1 AND pick_n = $2
       AND picked_at = (SELECT max(picked_at) FROM suggestions WHERE user_id = $1)`,
    [userId, n],
  );
  return rows[0]?.event_id ?? null;
}

export const bookEventTool = createTool({
  id: 'book-event',
  description:
    'Book tickets for an event from find-events (by eventId, or the pick number the user answered with). Starts the booking in the ' +
    'background and returns at once: it checks price and credits, asks the user on WhatsApp when the price is above their auto-book ' +
    'limit, clicks through the ticket site, pays from their credits and sends the tickets, all by itself. Asking again for the same ' +
    'event and showtime returns the existing booking.',
  inputSchema: z.object({
    eventId: z.string().optional().describe('eventId from find-events'),
    pick: z.number().int().min(1).optional().describe('or: the number of the pick in the last list the user saw'),
    qty: z.number().int().min(1).max(10).default(1).describe('number of tickets'),
    showtime: z.string().optional().describe('only when the event has several: "HH:MM", or "YYYY-MM-DDTHH:MM" local time'),
  }),
  execute: async ({ eventId, pick, qty, showtime }, { requestContext, mastra }) => {
    const userId = userIdFrom(requestContext);
    const id = eventId ?? (pick ? await eventForPick(userId, pick) : null);
    if (!id) return { error: pick ? `no pick #${pick} in the last list` : 'pass eventId or pick' };
    const { rows } = await db.query<{ timezone: string | null }>(`SELECT timezone FROM users WHERE id = $1`, [userId]);
    const tz = rows[0]?.timezone || DEFAULT_TIMEZONE;
    const loaded = await loadEvent(id, tz);
    if (!loaded) return { error: `unknown eventId ${id}: use an eventId from find-events` };
    const event = loaded.event;
    const blocked = notBookable(event);
    if (blocked) return { error: `can't book this one: ${blocked}` };
    if (!event.bookingUrl && !event.url) return { error: 'no page to book this event on' };

    const day = event.startLocal.slice(0, 10);
    const local = !showtime ? event.startLocal
      : /^\d{1,2}:\d{2}$/.test(showtime) ? `${day}T${showtime.padStart(5, '0')}`
      : /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(showtime) ? showtime.slice(0, 16).replace(' ', 'T')
      : null;
    if (!local) return { error: 'showtime must be "HH:MM" or "YYYY-MM-DDTHH:MM"' };

    const booking = await createBooking(userId, id, qty, local);
    const b = (await loadBooking(booking.id))!;
    if (!booking.startable) {
      return { ...view(b), note: b.status === 'booked' ? 'already booked' : 'this booking is already in progress' };
    }
    await startBooking(mastra as Mastra, b.id, userId);
    return {
      ...view(b),
      status: 'started',
      note: 'Running in the background. It messages the user itself (approval questions, login links, tickets): just tell them you are on it.',
    };
  },
});

export const confirmBookingTool = createTool({
  id: 'confirm-booking',
  description:
    'The user said yes to a booking question (price approval or re-approval), or "done" after finishing a login/captcha in the ' +
    'live browser link. Continues that booking in the background.',
  inputSchema: z.object({ bookingId: z.string() }),
  execute: async ({ bookingId }, { requestContext, mastra }) => {
    const b = await ownBooking(bookingId, userIdFrom(requestContext));
    if (!b) return { error: 'unknown bookingId' };
    if (b.status !== 'awaiting_approval' && b.status !== 'needs_human') return { ...view(b), note: 'nothing to confirm right now' };
    // Claim it first, so a second "yes" can't resume twice.
    if (!(await updateBooking(b.id, { status: 'booking' }, [b.status]))) return { ...view(b), note: 'already continuing' };
    await resumeBooking(mastra as Mastra, b, b.status === 'needs_human' ? { done: true } : { approved: true });
    return { ...view(b), status: 'booking', note: 'Continuing in the background; it will message the user.' };
  },
});

export const cancelBookingTool = createTool({
  id: 'cancel-booking',
  description:
    'The user said no to a booking question, or wants to stop a booking that is waiting for them. Booked tickets can\'t be cancelled with this.',
  inputSchema: z.object({ bookingId: z.string() }),
  execute: async ({ bookingId }, { requestContext, mastra }) => {
    const b = await ownBooking(bookingId, userIdFrom(requestContext));
    if (!b) return { error: 'unknown bookingId' };
    if (b.status === 'booked') return { ...view(b), note: "already booked: I can't cancel tickets yet, the user has to do that on the ticket site" };
    if (b.status !== 'awaiting_approval' && b.status !== 'needs_human') {
      return { ...view(b), note: b.status === 'booking' || b.status === 'pending' ? 'checkout is running and can\'t be stopped half-way' : 'nothing to cancel' };
    }
    if (!(await updateBooking(b.id, { status: 'booking' }, [b.status]))) return { ...view(b), note: 'already continuing' };
    await resumeBooking(mastra as Mastra, b, b.status === 'needs_human' ? { done: false } : { approved: false });
    return { ...view(b), status: 'cancelling' };
  },
});

export const bookingStatusTool = createTool({
  id: 'booking-status',
  description: "The user's bookings, newest first (or one by bookingId): status, total, tickets link, and what it is waiting for.",
  inputSchema: z.object({ bookingId: z.string().optional() }),
  execute: async ({ bookingId }, { requestContext }) => {
    const userId = userIdFrom(requestContext);
    if (bookingId) {
      const b = await ownBooking(bookingId, userId);
      return b ? view(b) : { error: 'unknown bookingId' };
    }
    return { bookings: (await userBookings(userId, { limit: 8 })).map(view) };
  },
});
