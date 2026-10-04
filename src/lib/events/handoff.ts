import { db } from '../db';
import { getTaste } from '../taste';
import {
  attachCancellation,
  fromStored,
  type CancelMethod,
  type CancellationInfo,
  type PlatformId,
  type PolicyKind,
  type PolicyScope,
  type PolicySource,
} from './cancellation';
import { DEAD_STATUSES, type EventCategory, type EventStatus } from './classify';
import { DEFAULT_TIMEZONE } from './discover';
import { refreshStatus, type EventPagePolicy } from './status';
import { loadEvent, saveCancellation } from './store';
import type { StoredEvent } from './types';

/**
 * Booking handoff v1.1 (PLAN §8.10, §9): everything the booking agent needs to buy tickets for one suggested event.
 * 1.1 adds per-event cancellation (scope/source/cancellationUrl/policyUrl/platform) and `contract`; all v1 fields stay.
 */

export const HANDOFF_CONTRACT =
  "Re-read price and cancellation on checkout; abort if worse. After purchase, save the order's manage/cancel link from the confirmation email (AgentMail) and report it.";

export type BookingHandoff = {
  version: 1.1;
  contract: string;            // HANDOFF_CONTRACT
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
    scope: PolicyScope;            // event = this event's own page; venue = venue's general terms; platform = platform default
    source: PolicySource;
    cancellationUrl: string | null; // verified cancel/manage link from the event page, else the platform's order page
    policyUrl: string | null;
    platform: PlatformId | null;
  };
  ticketsWanted: number;       // taste.usualTicketCount ?? 1
  decision: { action: 'book' | 'ask' | 'skip'; reason: string; confidence: number };
  bookable: { ok: boolean; reason: string };
};

export class HandoffNotFound extends Error {}

const STALE_MS = 3_600_000;
const CANCELLATION_STALE_MS = 24 * STALE_MS;

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

  let page: EventPagePolicy | null | undefined;
  const recheck = async () => {
    const fresh = await refreshStatus([event]);
    event = fresh.events[0];
    page = fresh.checks.get(event.id)?.policy ?? null;
  };
  if (refresh && Date.now() - new Date(event.statusCheckedAt).getTime() > STALE_MS) await recheck();

  let cancellation = fromStored(loaded.details.cancellation);
  const raw = loaded.details.cancellation as Record<string, unknown> | undefined;
  const policyStale =
    !cancellation || !raw || !('scope' in raw) || !cancellation.checkedAt || Date.now() - new Date(cancellation.checkedAt).getTime() > CANCELLATION_STALE_MS;
  if (refresh && policyStale) {
    try {
      if (page === undefined) await recheck(); // the event page's own policy is read during the re-check
      const [withPolicy] = await attachCancellation([event], tz, new Map([[event.id, page ?? null]]));
      cancellation = withPolicy.cancellation;
      await saveCancellation([withPolicy]);
    } catch (err) {
      console.warn('[handoff] cancellation lookup failed:', String(err).slice(0, 200));
    }
  }
  const policy: CancellationInfo = cancellation ?? fromStored({ kind: 'unknown', summary: 'Cancellation policy unknown' })!;

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
    version: 1.1,
    contract: HANDOFF_CONTRACT,
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
      kind: policy.kind,
      cancelBy: policy.cancelBy,
      hoursBeforeStart: policy.hoursBeforeStart,
      fee: policy.fee,
      method: policy.method,
      contact: policy.contact,
      transferable: policy.transferable,
      quote: policy.quote,
      sourceUrl: policy.sourceUrl,
      summary: policy.summary,
      scope: policy.scope,
      source: policy.source,
      cancellationUrl: policy.cancellationUrl,
      policyUrl: policy.policyUrl,
      platform: policy.platform,
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
