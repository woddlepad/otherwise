import { db } from '../db';
import { getTaste } from '../taste';
import { attachCancellation, normaliseMethod, type CancelMethod, type CancellationInfo, type PolicyKind } from './cancellation';
import { DEAD_STATUSES, type EventCategory, type EventStatus } from './classify';
import { DEFAULT_TIMEZONE } from './discover';
import { refreshStatus } from './status';
import { loadEvent, saveCancellation } from './store';
import type { StoredEvent } from './types';

/**
 * Booking handoff v1 (PLAN §8.10): everything the booking agent needs to buy tickets for one suggested event.
 * Contract for the booking side: re-read price + cancellation on the checkout page; abort and ask if worse than this.
 */

export type BookingHandoff = {
  version: 1;
  eventId: string;
  suggestionId: string | null;
  userId: string;
  title: string;
  category: EventCategory;
  tags: string[];
  startsAt: string;            // ISO UTC
  startLocal: string;          // "2026-10-08T19:30" in `timezone`
  timezone: string;
  hasTime: boolean;
  venue: {
    id: string | null;
    name: string | null;
    address: string | null;
    city: string | null;
    lat: number | null;
    lng: number | null;
    distanceKm: number | null;
  };
  online: boolean;
  bookingUrl: string | null;   // open this; null → start from detailUrl
  detailUrl: string;
  sourcePageUrl: string;
  priceEstimate: { text: string | null; minCents: number | null; currency: string | null }; // never charge on this
  status: EventStatus;
  statusCheckedAt: string;
  cancellation: {
    kind: PolicyKind;
    cancelBy: string | null;
    hoursBeforeStart: number | null;
    fee: string | null;
    method: CancelMethod;
    contact: string | null;
    transferable: boolean | null;
    quote: string | null;
    sourceUrl: string | null;
    summary: string;
  };
  ticketsWanted: number;       // taste.usualTicketCount ?? 1
  decision: { action: 'book' | 'ask' | 'skip'; reason: string; confidence: number };
  bookable: { ok: boolean; reason: string };
};

export class HandoffNotFound extends Error {}

const STALE_MS = 3_600_000;

/** Why the booking agent can't buy anything for this event (null = it can try). */
export function notBookable(e: StoredEvent, now = new Date()): string | null {
  if (DEAD_STATUSES.includes(e.status)) return e.status.replace(/_/g, ' ');
  const end = e.hasTime ? e.startsAt : new Date(e.startsAt.getTime() + 86_399_000);
  if (end < now) return 'event is in the past';
  if (e.online && !e.bookingUrl) return 'online event without a registration link';
  if (e.status === 'free_entry') return 'free entry, nothing to book';
  if (e.status === 'door_only') return 'tickets at the door only';
  return null;
}

/** details.cancellation as saved by saveCancellation; older rows lack method/contact/transferable. */
function storedCancellation(raw: unknown): CancellationInfo | null {
  if (!raw || typeof raw !== 'object' || !('kind' in raw)) return null;
  const c = raw as Partial<CancellationInfo>;
  return {
    kind: c.kind as PolicyKind,
    hoursBeforeStart: c.hoursBeforeStart ?? null,
    fee: c.fee ?? null,
    quote: c.quote ?? null,
    sourceUrl: c.sourceUrl ?? null,
    domain: c.domain ?? '',
    method: normaliseMethod(c.method),
    contact: c.contact ?? null,
    transferable: c.transferable ?? null,
    cancelBy: c.cancelBy ?? null,
    summary: c.summary ?? '',
  };
}

/**
 * The handoff for one user + event. `refresh` (default true): re-check status/price/bookingUrl when the last check
 * is older than 1 h, and look up the cancellation policy when the event has none (or one from before part B).
 * Throws HandoffNotFound for an unknown user or event.
 */
export async function getBookingHandoff(userId: string, eventId: string, opts: { refresh?: boolean } = {}): Promise<BookingHandoff> {
  const refresh = opts.refresh ?? true;
  const { rows: users } = await db.query<{ timezone: string | null; home_lat: number | null; home_lng: number | null }>(
    `SELECT timezone, home_lat, home_lng FROM users WHERE id = $1`,
    [userId],
  );
  const user = users[0];
  if (!user) throw new HandoffNotFound(`unknown user ${userId}`);
  const tz = user.timezone || DEFAULT_TIMEZONE;
  const home = user.home_lat !== null && user.home_lng !== null ? { lat: user.home_lat, lng: user.home_lng } : null;

  const loaded = await loadEvent(eventId, tz, home);
  if (!loaded) throw new HandoffNotFound(`unknown event ${eventId}`);
  let event = loaded.event;

  if (refresh && Date.now() - new Date(event.statusCheckedAt).getTime() > STALE_MS) {
    event = (await refreshStatus([event])).events[0];
  }

  let cancellation = storedCancellation(loaded.details.cancellation);
  if (refresh && (!cancellation || !('method' in (loaded.details.cancellation as object)))) {
    try {
      const [withPolicy] = await attachCancellation([event], tz);
      cancellation = withPolicy.cancellation;
      await saveCancellation([withPolicy]);
    } catch (err) {
      console.warn('[handoff] cancellation lookup failed:', String(err).slice(0, 200));
    }
  }
  cancellation ??= {
    kind: 'unknown',
    hoursBeforeStart: null,
    fee: null,
    quote: null,
    sourceUrl: null,
    domain: '',
    method: 'unknown',
    contact: null,
    transferable: null,
    cancelBy: null,
    summary: 'Cancellation policy unknown',
  };

  const [{ rows: sugg }, { rows: venues }, taste] = await Promise.all([
    db.query<{ id: string; decision: string | null; decision_reason: string | null; confidence: number | null }>(
      `SELECT id, decision, decision_reason, confidence FROM suggestions WHERE user_id = $1 AND event_id = $2`,
      [userId, eventId],
    ),
    event.venueId
      ? db.query<{ name: string; address: string | null; city: string | null }>(`SELECT name, address, city FROM venues WHERE id = $1`, [event.venueId])
      : Promise.resolve({ rows: [] as { name: string; address: string | null; city: string | null }[] }),
    getTaste(userId).catch(() => null),
  ]);
  const s = sugg[0];
  const v = venues[0];
  const action = s?.decision === 'book' || s?.decision === 'ask' || s?.decision === 'skip' ? s.decision : 'ask';
  const blocked = notBookable(event);

  return {
    version: 1,
    eventId: event.id,
    suggestionId: s?.id ?? null,
    userId,
    title: event.title,
    category: event.category,
    tags: event.tags,
    startsAt: event.startsAt.toISOString(),
    startLocal: event.startLocal,
    timezone: tz,
    hasTime: event.hasTime,
    venue: {
      id: event.venueId,
      name: v?.name ?? event.venue,
      address: event.address ?? v?.address ?? null,
      city: event.city ?? v?.city ?? null,
      lat: event.venueLat,
      lng: event.venueLng,
      distanceKm: event.distanceKm,
    },
    online: event.online,
    bookingUrl: event.bookingUrl,
    detailUrl: event.url,
    sourcePageUrl: event.pageUrl,
    priceEstimate: { text: event.priceText, minCents: event.priceMinCents, currency: event.currency },
    status: event.status,
    statusCheckedAt: event.statusCheckedAt,
    cancellation: {
      kind: cancellation.kind,
      cancelBy: cancellation.cancelBy,
      hoursBeforeStart: cancellation.hoursBeforeStart,
      fee: cancellation.fee,
      method: cancellation.method,
      contact: cancellation.contact,
      transferable: cancellation.transferable,
      quote: cancellation.quote,
      sourceUrl: cancellation.sourceUrl,
      summary: cancellation.summary,
    },
    ticketsWanted: taste?.profile?.usualTicketCount ?? 1,
    decision: {
      action,
      reason: s?.decision_reason ?? (s ? '' : 'not suggested to this user yet'),
      confidence: s?.confidence ?? 0,
    },
    bookable: blocked ? { ok: false, reason: blocked } : { ok: true, reason: 'ok' },
  };
}
