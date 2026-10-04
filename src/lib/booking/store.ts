import { db } from '../db';
import { DEFAULT_TIMEZONE } from '../events/discover';
import { formatLocal, zonedToUtc } from '../events/time';

/**
 * Bookings (table `bookings`): one row per user + event + showtime. Status follows the workflow
 * (src/mastra/workflows/book.ts):
 *   pending → awaiting_approval ⇄ booking ⇄ needs_human → booked | failed | cancelled
 * A failed or cancelled row is reused (reset to pending) when the user asks again.
 */

export type BookingStatus = 'pending' | 'awaiting_approval' | 'booking' | 'needs_human' | 'booked' | 'failed' | 'cancelled';
export const OPEN_STATUSES: BookingStatus[] = ['pending', 'awaiting_approval', 'booking', 'needs_human'];

export type Booking = {
  id: string;
  userId: string;
  eventId: string;
  qty: number;
  status: BookingStatus;
  showtime: string;               // local "2026-10-08T20:30" in the user's timezone
  workflowRunId: string | null;
  suspendedStep: string | null;
  holdRef: string | null;
  approvedCents: number | null;
  totalCents: number | null;
  ticketUrl: string | null;
  orderRef: string | null;
  liveViewUrl: string | null;
  payAttemptedAt: Date | null;
  error: string | null;
  updatedAt: Date;
  // event + user, joined
  title: string;
  venue: string | null;
  address: string | null;
  bookingUrl: string | null;
  eventUrl: string;
  eventStatus: string;
  priceCents: number | null;     // per ticket, the estimate from the event page (never charged on its own)
  currency: string | null;
  timezone: string;
  phone: string;
  userName: string | null;
  userEmail: string | null;
};

const SELECT = `
  SELECT b.id, b.user_id AS "userId", b.event_id AS "eventId", b.qty, b.status, b.showtime, b.workflow_run_id AS "workflowRunId",
         b.suspended_step AS "suspendedStep", b.hold_ref AS "holdRef", b.approved_cents AS "approvedCents",
         b.total_cents AS "totalCents", b.ticket_url AS "ticketUrl", b.order_ref AS "orderRef", b.live_view_url AS "liveViewUrl",
         b.pay_attempted_at AS "payAttemptedAt", b.error, b.updated_at AS "updatedAt",
         e.title, e.venue, e.address, e.booking_url AS "bookingUrl", coalesce(e.details->>'eventUrl', e.source_url) AS "eventUrl",
         e.status AS "eventStatus", (e.details->>'priceMinCents')::int AS "priceCents", e.details->>'priceCurrency' AS currency,
         coalesce(u.timezone, '${DEFAULT_TIMEZONE}') AS timezone, u.phone, u.name AS "userName", u.email AS "userEmail"
  FROM bookings b JOIN events e ON e.id = b.event_id JOIN users u ON u.id = b.user_id`;

export async function loadBooking(id: string): Promise<Booking | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await db.query<Booking>(`${SELECT} WHERE b.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function userBookings(userId: string, opts: { open?: boolean; limit?: number } = {}): Promise<Booking[]> {
  const { rows } = await db.query<Booking>(
    `${SELECT} WHERE b.user_id = $1 AND ($2::text[] IS NULL OR b.status = ANY($2)) ORDER BY b.updated_at DESC LIMIT $3`,
    [userId, opts.open ? OPEN_STATUSES : null, opts.limit ?? 10],
  );
  return rows;
}

type Patch = Partial<{
  status: BookingStatus;
  workflow_run_id: string | null;
  suspended_step: string | null;
  hold_ref: string | null;
  approved_cents: number | null;
  total_cents: number | null;
  ticket_url: string | null;
  order_ref: string | null;
  live_view_url: string | null;
  pay_attempted_at: Date | null;
  error: string | null;
}>;

/** Updates columns; with `onlyFrom`, only if the booking is in one of those states (false if it wasn't). */
export async function updateBooking(id: string, patch: Patch, onlyFrom?: BookingStatus[]) {
  const keys = Object.keys(patch) as (keyof Patch)[];
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  const { rowCount } = await db.query(
    `UPDATE bookings SET ${[...sets, 'updated_at = now()'].join(', ')}
     WHERE id = $1 ${onlyFrom ? `AND status = ANY($${keys.length + 2})` : ''}`,
    [id, ...keys.map(k => patch[k]), ...(onlyFrom ? [onlyFrom] : [])],
  );
  return rowCount === 1;
}

/**
 * The booking for user + event + showtime: a new one, or the existing one. A failed or cancelled booking starts over
 * with the new qty, so asking again after a top-up works. `startable`: no workflow run owns it yet.
 */
export async function createBooking(userId: string, eventId: string, qty: number, showtime: string) {
  const key = `${userId}|${eventId}|${showtime}`;
  const { rows } = await db.query<{ id: string; status: BookingStatus; startable: boolean }>(
    `INSERT INTO bookings (user_id, event_id, qty, showtime, idempotency_key) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (idempotency_key) DO UPDATE SET
       qty = CASE WHEN bookings.status IN ('failed','cancelled') THEN EXCLUDED.qty ELSE bookings.qty END,
       status = CASE WHEN bookings.status IN ('failed','cancelled') THEN 'pending' ELSE bookings.status END,
       error = CASE WHEN bookings.status IN ('failed','cancelled') THEN NULL ELSE bookings.error END,
       pay_attempted_at = CASE WHEN bookings.status IN ('failed','cancelled') THEN NULL ELSE bookings.pay_attempted_at END,
       workflow_run_id = CASE WHEN bookings.status IN ('failed','cancelled') THEN NULL ELSE bookings.workflow_run_id END,
       updated_at = now()
     RETURNING id, status, workflow_run_id IS NULL AS startable`,
    [userId, eventId, qty, showtime, key],
  );
  return rows[0];
}

export const eur = (cents: number) => `€${(cents / 100).toFixed(2)}`;

/** "Thu 8 Oct, 21:00" for a booking's showtime. */
export const showtimeLabel = (b: Pick<Booking, 'showtime' | 'timezone'>) => {
  const at = zonedToUtc(b.showtime, b.timezone);
  return at ? formatLocal(at, b.timezone) : b.showtime.replace('T', ' ');
};

/** Open bookings for the concierge's prompt, so "yes" / "done" can be matched to the right one. */
export async function openBookingsForPrompt(userId: string) {
  const open = await userBookings(userId, { open: true, limit: 5 });
  if (!open.length) return 'None.';
  return open
    .map(b => {
      const waiting =
        b.status === 'awaiting_approval' ? 'waiting for their yes/no'
        : b.status === 'needs_human' ? 'waiting for them to finish on the live browser and say "done"'
        : 'in progress, nothing to do';
      return `- booking ${b.id}: ${b.qty}× ${b.title} (${showtimeLabel(b)}), ${b.status}: ${waiting}`;
    })
    .join('\n');
}
