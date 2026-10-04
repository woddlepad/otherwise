import type { PolicyKind } from './cancellation';

/**
 * Ticket platforms: which platform a URL belongs to, and what that platform says about cancelling / refunding.
 *
 * Precedence when deciding an event's cancellation policy (most specific wins):
 *   1. the event page itself (organiser-set policy on Eventbrite, Luma, Tixr, Partiful, ...),
 *   2. the order confirmation email,
 *   3. the venue's own ticket policy / FAQ,
 *   4. the platform default below (last resort; deliberately conservative).
 *
 * `defaultKind` is only set where the platform documents a general rule (typically "all sales final, refunds only
 * when the event is cancelled/moved"); where organisers set the policy per event it is null and perEventPolicy=true.
 * URLs were checked against the platforms' own help centres / purchase policies on 2026-10-04; anything that could
 * not be verified is null rather than guessed.
 */

export type CancelMethod = 'online_self_service' | 'email' | 'phone' | 'box_office' | 'not_possible' | 'unknown';

export type PlatformId =
  | 'eventbrite' | 'ticketmaster' | 'livenation' | 'axs' | 'dice' | 'luma' | 'tixr' | 'seetickets' | 'ticketweb'
  | 'etix' | 'universe' | 'veezi' | 'eventim' | 'partiful' | 'posh' | 'resident_advisor' | 'meetup';

export type Platform = { id: PlatformId; name: string };

export type PlatformCancellation = {
  perEventPolicy: boolean;            // true when organisers set the refund policy per event (then the event page must be read)
  defaultKind: PolicyKind | null;     // conservative platform-wide default when nothing event-specific is known; null = no safe default
  defaultMethod: CancelMethod;        // how a buyer requests cancellation/refund on this platform
  orderManagementUrl: string | null;  // where a logged-in buyer sees/manages orders
  policyUrl: string | null;           // the platform's official buyer refund/cancellation help page
  notes: string;                      // one line
};

const NAMES: Record<PlatformId, string> = {
  eventbrite: 'Eventbrite',
  ticketmaster: 'Ticketmaster',
  livenation: 'Live Nation',
  axs: 'AXS',
  dice: 'DICE',
  luma: 'Luma',
  tixr: 'Tixr',
  seetickets: 'See Tickets',
  ticketweb: 'TicketWeb',
  etix: 'Etix',
  universe: 'Universe',
  veezi: 'Veezi',
  eventim: 'Eventim',
  partiful: 'Partiful',
  posh: 'Posh',
  resident_advisor: 'Resident Advisor',
  meetup: 'Meetup',
};

// Country-code style suffixes: .com, .de, .co.uk, .com.au, ...
const CC = String.raw`(?:com|net|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})`;

/** Ordered: first match wins. Patterns match the full hostname (lower-case, no trailing dot, any subdomain). */
const HOST_RULES: Array<[RegExp, PlatformId]> = [
  [new RegExp(String.raw`(^|\.)eventbrite\.${CC}$`), 'eventbrite'],
  [new RegExp(String.raw`(^|\.)ticketmaster\.${CC}$`), 'ticketmaster'],
  [new RegExp(String.raw`(^|\.)livenation\.${CC}$`), 'livenation'], // incl. web-a.origin.livenation.com
  [new RegExp(String.raw`(^|\.)axs\.${CC}$`), 'axs'],
  [/(^|\.)dice\.fm$/, 'dice'],
  [/(^|\.)(lu\.ma|luma\.com)$/, 'luma'],
  [/(^|\.)tixr\.com$/, 'tixr'],
  // See Tickets US now redirects to eventim.us, whose purchase terms are the "Eventim/See Tickets" terms.
  [new RegExp(String.raw`(^|\.)seetickets\.${CC}$`), 'seetickets'],
  [/(^|\.)eventim\.us$/, 'seetickets'],
  [new RegExp(String.raw`(^|\.)ticketweb\.${CC}$`), 'ticketweb'],
  [/(^|\.)etix\.com$/, 'etix'],
  [/(^|\.)universe\.com$/, 'universe'],
  // Cinema booking pages live on ticketing.<region>.veezi.com; veezi.com / www / help are the vendor's own site.
  [/^(?!(www|help)\.veezi\.com$)[a-z0-9.-]+\.veezi\.com$/, 'veezi'],
  [new RegExp(String.raw`(^|\.)eventim\.${CC}$`), 'eventim'],
  [/(^|\.)partiful\.com$/, 'partiful'],
  [/(^|\.)posh\.vip$/, 'posh'],
  [/(^|\.)(ra\.co|residentadvisor\.net)$/, 'resident_advisor'],
  [/(^|\.)meetup\.com$/, 'meetup'],
];

function hostnameOf(url: string): string | null {
  const s = url.trim();
  if (!s || /\s/.test(s)) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`); // tolerate scheme-less "lu.ma/abc"
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    return host.includes('.') ? host : null;
  } catch {
    return null;
  }
}

/** Detect the ticket platform from any URL (event, checkout or ticket page). null = venue's own site / unknown. */
export function detectPlatform(url: string | null | undefined): Platform | null {
  if (typeof url !== 'string') return null;
  const host = hostnameOf(url);
  if (!host) return null;
  for (const [re, id] of HOST_RULES) if (re.test(host)) return { id, name: NAMES[id] };
  return null;
}

const TM_ORDERS = 'https://www.ticketmaster.com/user/orders';
const TM_REFUND_HELP = 'https://help.ticketmaster.com/hc/en-us/articles/9672441081105-How-do-I-request-a-refund';

const PLATFORM_CANCELLATION: Record<PlatformId, PlatformCancellation> = {
  eventbrite: {
    perEventPolicy: true,
    defaultKind: null,
    defaultMethod: 'online_self_service',
    orderManagementUrl: 'https://www.eventbrite.com/mytickets',
    policyUrl: 'https://www.eventbrite.com/help/en-us/articles/721549/can-i-get-a-refund/',
    notes: 'Organiser sets the refund policy per event (shown on the event page); request a refund from Tickets in the account if enabled, else contact the organiser',
  },
  ticketmaster: {
    perEventPolicy: false,
    defaultKind: 'no_refunds',
    defaultMethod: 'online_self_service',
    orderManagementUrl: TM_ORDERS,
    policyUrl: TM_REFUND_HELP,
    notes: 'All sales final; refunds only if the event organiser allows them (Request Refund button in My Tickets) or the event is cancelled; transfer/resale may be offered',
  },
  livenation: {
    perEventPolicy: false,
    defaultKind: 'no_refunds',
    defaultMethod: 'online_self_service',
    orderManagementUrl: TM_ORDERS,
    policyUrl: TM_REFUND_HELP,
    notes: 'Live Nation tickets are sold through the listed ticket agent (usually Ticketmaster): all sales final unless the organiser allows refunds or the event is cancelled',
  },
  axs: {
    perEventPolicy: false,
    defaultKind: 'no_refunds',
    defaultMethod: 'online_self_service',
    orderManagementUrl: null,
    policyUrl: 'https://support.axs.com/hc/en-us/articles/200747305-Can-I-cancel-or-refund-my-tickets',
    notes: 'All sales final; refunds only if the event/venue approves them ("submit a refund request" link in the AXS account, with a deadline) or the event is cancelled',
  },
  dice: {
    perEventPolicy: false,
    defaultKind: 'no_refunds',
    defaultMethod: 'online_self_service',
    orderManagementUrl: null,
    policyUrl: 'https://dicefm.zendesk.com/hc/en-gb/articles/22366761742097-What-to-do-if-you-can-t-make-a-show',
    notes: 'No refund for change of plans; refunded only if cancelled/rescheduled, organiser instructs it, or the ticket resells via the in-app wait list (if enabled)',
  },
  luma: {
    perEventPolicy: true,
    defaultKind: null,
    defaultMethod: 'online_self_service',
    orderManagementUrl: 'https://luma.com/home',
    policyUrl: 'https://help.luma.com/p/contacting-event-hosts',
    notes: 'Host controls registrations and refunds (Luma support cannot); cancel on the event page, ask the host via Contact the Host for paid refunds',
  },
  tixr: {
    perEventPolicy: true,
    defaultKind: null,
    defaultMethod: 'email',
    orderManagementUrl: null,
    policyUrl: 'https://fansupport.tixr.com/en/articles/11084407-how-to-request-a-refund-for-your-ticket',
    notes: 'Organiser sets policy (Terms section of the event page / PDF ticket); most events are final sale; request by emailing the organiser with the order number',
  },
  seetickets: {
    perEventPolicy: false,
    defaultKind: 'no_refunds',
    defaultMethod: 'email',
    orderManagementUrl: null,
    policyUrl: 'https://misc.seetickets.us/terms/',
    notes: 'US terms: no refunds unless the event is cancelled or moved; fees non-refundable; contact the promoter, else help@seetickets.us (UK site has its own terms)',
  },
  ticketweb: {
    perEventPolicy: false,
    defaultKind: 'no_refunds',
    defaultMethod: 'unknown',
    orderManagementUrl: 'https://www.ticketweb.com/myaccount',
    policyUrl: 'https://info.ticketweb.com/purchase-policy/',
    notes: 'Event providers generally prohibit refunds/exchanges; refunds only for cancelled/postponed events; service fees non-refundable on TicketWeb.com',
  },
  etix: {
    perEventPolicy: true,
    defaultKind: null,
    defaultMethod: 'online_self_service',
    orderManagementUrl: 'https://www.etix.com/ticket/resend',
    policyUrl: 'https://support.etix.com/existing-orders/are-etix-tickets-refundable',
    notes: 'Venue/organiser sets the policy (often non-refundable); request via the Customer Support Form linked in the confirmation email when offered',
  },
  universe: {
    perEventPolicy: true,
    defaultKind: null,
    defaultMethod: 'online_self_service',
    orderManagementUrl: null,
    policyUrl: 'https://support.universe.com/hc/en-us/articles/360002596632-Can-I-get-a-refund',
    notes: 'Host sets the refund policy; for upcoming events accepting refunds use My Tickets > More > Request Refund, else contact the organiser',
  },
  veezi: {
    perEventPolicy: true,
    defaultKind: null,
    defaultMethod: 'box_office',
    orderManagementUrl: null,
    policyUrl: null,
    notes: 'Cinema box-office software: each cinema sets its own policy and processes refunds at its POS; contact the cinema',
  },
  eventim: {
    perEventPolicy: false,
    defaultKind: 'no_refunds',
    defaultMethod: 'online_self_service',
    orderManagementUrl: null,
    policyUrl: 'https://www.eventim.de/helpcenter/',
    notes: 'Binding purchase, no withdrawal right for dated events; refunds only for cancelled/postponed events via the online refund form once the organiser releases it (or ticket insurance)',
  },
  partiful: {
    perEventPolicy: true,
    defaultKind: 'no_refunds',
    defaultMethod: 'email',
    orderManagementUrl: 'https://partiful.com/events',
    policyUrl: 'https://help.partiful.com/en-us/articles/15525401-what-is-your-refund-policy',
    notes: 'Paid tickets final sale unless the listing states another policy (host administers it) or the event is cancelled; no in-product refunds; ticketing@partiful.com',
  },
  posh: {
    perEventPolicy: true,
    defaultKind: null,
    defaultMethod: 'online_self_service',
    orderManagementUrl: null,
    policyUrl: 'https://support.posh.vip/en/articles/10723777-how-to-request-ticket-refunds',
    notes: 'Organiser decides refunds; request via Posh support chat ("I am an Attendee" > Request a refund); Posh fees non-refundable unless cancelled',
  },
  resident_advisor: {
    perEventPolicy: false,
    defaultKind: 'no_refunds',
    defaultMethod: 'online_self_service',
    orderManagementUrl: 'https://ra.co/my-tickets',
    policyUrl: 'https://ra.co/purchase-policy',
    notes: 'Refunds (face value, fees kept) only if cancelled or moved; otherwise resell via RA Ticket Resale from My Tickets (refunded only if it resells)',
  },
  meetup: {
    perEventPolicy: true,
    defaultKind: null,
    defaultMethod: 'online_self_service',
    orderManagementUrl: null,
    policyUrl: 'https://help.meetup.com/hc/en-us/articles/44014195643661-Request-a-refund-for-an-event-fee',
    notes: 'Most events free; organisers set fee refund policy; request via Settings > Payments made > Event fees > Request refund',
  },
};

export function platformCancellation(id: PlatformId): PlatformCancellation {
  return PLATFORM_CANCELLATION[id];
}
