import type { Decision } from '../policy';
import type { CancellationInfo } from './cancellation';
import type { DerivedAttributes, EventCategory, EventStatus } from './classify';
import type { StoredTaste } from '../taste';

export type Window = { from: Date; to: Date };

/** Everything the pipeline needs to know about one user's search, loaded once per run. */
export type DiscoveryContext = {
  userId?: string;                 // absent in the tuning script
  city: string;
  timezone: string;                // IANA, e.g. America/Los_Angeles
  country?: string;                // ISO alpha-2, biases Exa results
  window: Window;
  taste: StoredTaste;
  interests?: string | null;       // free text from users.interests
  hint?: string;                   // the user's request in chat, e.g. "jazz on Friday"
  categories?: EventCategory[];    // only these (chat filter); empty/undefined = all
};

export type PlannedQuery = { query: string; why: string };

/** One event as extracted from a web page, before it is stored. */
export type Candidate = {
  title: string;
  startsAt: Date;
  startLocal: string;              // "2026-10-17T19:00" in the user's timezone, as on the page
  hasTime: boolean;
  venue: string | null;            // venue name
  address: string | null;
  city: string;                    // as extracted; falls back to the searched city
  online: boolean;
  url: string;                     // detail page for this event (falls back to the page it was found on)
  bookingUrl: string | null;       // direct ticket/registration link: what the booking agent opens
  status: EventStatus;             // availability as last seen
  statusCheckedAt: string;         // ISO; when `status` was read (page cache age, or the live re-check)
  pageUrl: string;
  pageKind: 'single_event' | 'listing' | 'other';
  priceText: string | null;        // as written on the page: an estimate, never charged against
  priceMinCents: number | null;
  currency: string | null;
  query: string;
  dedupeKey: string;
  category: EventCategory;
  tags: string[];                  // lowercase genre/format words
  attrs: DerivedAttributes;        // timeOfDay, weekend, priceBand, ageLimit
};

export type StoredEvent = Candidate & { id: string };

export type ScoredEvent = StoredEvent & {
  confidence: number;              // 0–1, the LLM's guess that the user will love it
  reason: string;                  // one line, second person
  matches: string[];               // which of the user's interests/likes it matches (empty = none)
  decision: Decision;
  cancellation?: CancellationInfo; // looked up for shortlisted paid events only
};
