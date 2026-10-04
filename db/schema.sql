-- App-owned tables. Mastra creates its own mastra_* tables (memory, workflow snapshots, schedules).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone               text UNIQUE NOT NULL,          -- E.164, e.g. +4915112345678
  name                text,
  city                text,
  interests           text,                          -- free text, e.g. "indie films, jazz, no stadiums"
  agentmail_inbox_id  text,
  kernel_profile      text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS budgets (
  user_id              uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  currency             text NOT NULL DEFAULT 'EUR',
  monthly_limit_cents  integer NOT NULL DEFAULT 0,
  per_event_cap_cents  integer NOT NULL DEFAULT 0,
  auto_approve_cents   integer NOT NULL DEFAULT 0,   -- book without asking at or below this
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_url   text UNIQUE NOT NULL,
  title        text NOT NULL,
  venue        text,
  city         text,
  starts_at    timestamptz,
  price_cents  integer,                              -- only from the event page, never search snippets
  currency     text,
  details      jsonb NOT NULL DEFAULT '{}',
  embedding    vector(1536),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS suggestions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  score       real,
  reason      text,
  status      text NOT NULL DEFAULT 'suggested'
              CHECK (status IN ('suggested','approved','declined','expired')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, event_id)
);

CREATE TABLE IF NOT EXISTS bookings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id         uuid NOT NULL REFERENCES events(id),
  qty              integer NOT NULL DEFAULT 1,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','awaiting_approval','booking','needs_human','booked','failed','cancelled')),
  workflow_run_id  text,
  live_view_url    text,
  total_cents      integer,
  ticket_url       text,
  idempotency_key  text UNIQUE NOT NULL,             -- user + event + showtime: one booking at most
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  booking_id    uuid REFERENCES bookings(id),
  kind          text NOT NULL CHECK (kind IN ('hold','charge','release')),  -- charge + release settle a hold: held = holds − charges − releases
  amount_cents  integer NOT NULL CHECK (amount_cents >= 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_user_month ON ledger (user_id, created_at);

CREATE TABLE IF NOT EXISTS inbound_emails (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agentmail_message_id   text UNIQUE NOT NULL,
  user_id                uuid REFERENCES users(id) ON DELETE CASCADE,
  booking_id             uuid REFERENCES bookings(id),
  kind                   text CHECK (kind IN ('otp','confirmation','newsletter','other')),
  subject                text,
  received_at            timestamptz NOT NULL DEFAULT now()
);

-- ---------- Onboarding (WhatsApp hello → web page → OAuth → analysis → "ready") ----------
ALTER TABLE users ADD COLUMN IF NOT EXISTS email             text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone          text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_status text NOT NULL DEFAULT 'new';  -- new | link_sent | analyzing | ready
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_token  text UNIQUE;

-- Mail/calendar connections live in Composio (keyed by users.id), not here.

-- What the agent believes about the user's taste, plus how confident it must be to book unasked.
CREATE TABLE IF NOT EXISTS taste_profiles (
  user_id               uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  profile               jsonb NOT NULL DEFAULT '{}',   -- TasteProfile (src/lib/taste.ts)
  summary               text,
  notes                 text[] NOT NULL DEFAULT '{}',  -- things learned later in chat / from feedback
  auto_book_confidence  real NOT NULL DEFAULT 0.85,    -- ≥ this (and ≤ auto-approve price): book unasked
  ask_confidence        real NOT NULL DEFAULT 0.5,     -- ≥ this: ask; below: skip silently
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feedback (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  suggestion_id  uuid REFERENCES suggestions(id),
  booking_id     uuid REFERENCES bookings(id),
  event_title    text,
  kind           text NOT NULL CHECK (kind IN ('approved','declined','loved','liked','meh','disliked')),
  confidence     real,                                 -- the agent's confidence when it decided
  was_surprise   boolean NOT NULL DEFAULT false,       -- booked without asking
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------- Event search / discovery (src/lib/events) ----------
ALTER TABLE events ADD COLUMN IF NOT EXISTS dedupe_key   text;               -- venue|local start|normalised title
ALTER TABLE events ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS events_dedupe_key ON events (dedupe_key);
CREATE INDEX IF NOT EXISTS events_city_start ON events (lower(city), starts_at);

ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS confidence      real;
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS decision        text;      -- book | ask | skip (policy.decide)
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS decision_reason text;
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS notified_at     timestamptz;

CREATE TABLE IF NOT EXISTS discovery_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trigger       text NOT NULL,                       -- daily | chat | manual
  local_day     date,                                -- the user's local date, for daily idempotency
  queries       text[] NOT NULL DEFAULT '{}',
  candidates    integer NOT NULL DEFAULT 0,
  suggested     integer NOT NULL DEFAULT 0,
  cost_dollars  real,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS discovery_runs_daily ON discovery_runs (user_id, local_day) WHERE trigger = 'daily';

-- ---------- Credits (prepaid wallet, src/lib/credits.ts) ----------
-- Append-only and signed: balance = SUM(amount_cents). `ref` makes every write idempotent
-- (Stripe checkout session id, promo:<CODE>:<user>, spend:<hold>, refund:<booking>, ...).
-- Credits never go back to the card: a cancelled event becomes a `refund` row (credits again).
CREATE TABLE IF NOT EXISTS credit_ledger (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('topup','promo','adjust','spend','refund')),
  amount_cents  integer NOT NULL CHECK (
                  (kind IN ('topup','promo','refund') AND amount_cents > 0) OR
                  (kind = 'spend' AND amount_cents < 0) OR
                  (kind = 'adjust' AND amount_cents <> 0)),
  booking_id    uuid REFERENCES bookings(id),
  ref           text UNIQUE NOT NULL,
  note          text,
  meta          jsonb NOT NULL DEFAULT '{}',          -- e.g. Stripe payment_intent for top-ups
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credit_ledger_user ON credit_ledger (user_id, created_at);

-- Credits reserved while the agent checks out. available = balance − open holds.
-- Capturing writes a `spend` row for the real total; releasing just closes the hold.
CREATE TABLE IF NOT EXISTS credit_holds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  booking_id     uuid REFERENCES bookings(id),
  ref            text UNIQUE NOT NULL,                -- booking idempotency key, or a demo label
  amount_cents   integer NOT NULL CHECK (amount_cents > 0),
  captured_cents integer,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','captured','released')),
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  settled_at     timestamptz
);
CREATE INDEX IF NOT EXISTS credit_holds_open ON credit_holds (user_id) WHERE status = 'open';

ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id text;

-- Refund/cancellation policy per venue or ticket-shop domain (src/lib/events/cancellation.ts), cached ~7 days.
CREATE TABLE IF NOT EXISTS venue_policies (
  domain              text PRIMARY KEY,                  -- e.g. sfjazz.org, blackcatsf.com
  kind                text NOT NULL,                     -- free_cancellation | refund_with_fee | exchange_or_credit_only | no_refunds | unknown
  hours_before_start  real,                              -- latest cancellation for refund/credit; null = not stated
  fee                 text,
  quote               text,                              -- verbatim policy sentence
  source_url          text,
  checked_at          timestamptz NOT NULL DEFAULT now()
);

-- Exa caches (src/lib/events/cache.ts): search query → URLs, page URL → extracted events for a date window.
CREATE TABLE IF NOT EXISTS exa_search_cache (
  key         text PRIMARY KEY,                          -- sha256(normalised query | country | numResults)
  query       text NOT NULL,
  results     jsonb NOT NULL,                            -- [{url, title}]
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS exa_page_cache (
  url          text PRIMARY KEY,
  title        text,
  page_kind    text,
  events       jsonb NOT NULL,                           -- [{title, start, venue, price, url}] as extracted
  window_from  date NOT NULL,                            -- the extraction asked for events in this window (local days)
  window_to    date NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Event classification (src/lib/events/classify.ts) and page-cache schema versioning.
ALTER TABLE events ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'other';  -- music | film | comedy | theatre | …
ALTER TABLE events ADD COLUMN IF NOT EXISTS tags     text[] NOT NULL DEFAULT '{}';   -- lowercase genre/format words
CREATE INDEX IF NOT EXISTS events_category ON events (category, starts_at);
ALTER TABLE exa_page_cache ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1;

-- Dev worktrees (plugins/worktrees): production forwards a phone's inbound WhatsApp messages to the
-- worktree it's routed to. Only read where WHATSAPP_ROUTER=1 (prod); branches carry a harmless copy.
CREATE TABLE IF NOT EXISTS dev_routes (
  phone       text PRIMARY KEY,                       -- E.164
  worktree    text NOT NULL,
  target_url  text NOT NULL,                          -- the worktree's public base URL
  expires_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Event schema v3 (src/lib/events: venues.ts, geocode.ts, store.ts): one row per venue, merged by normalised name
-- per city ("Cobb's Comedy Club" = "Cobbs Comedy Club"), geocoded once with OpenStreetMap Nominatim.
CREATE TABLE IF NOT EXISTS venues (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  norm_name       text NOT NULL,                      -- venues.ts normVenueName()
  address         text,
  city            text,
  domain          text,                               -- venue's own site / ticket shop host (not aggregators)
  lat             double precision,
  lng             double precision,
  geocoded_at     timestamptz,                        -- set on hit and miss, so misses aren't retried every run
  geocode_source  text,                               -- 'nominatim' | 'nominatim:none'
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS venues_norm_city ON venues (norm_name, lower(coalesce(city, '')));

ALTER TABLE events ADD COLUMN IF NOT EXISTS address           text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS online            boolean NOT NULL DEFAULT false;
ALTER TABLE events ADD COLUMN IF NOT EXISTS booking_url       text;            -- direct Buy tickets / Register / RSVP link
ALTER TABLE events ADD COLUMN IF NOT EXISTS status            text NOT NULL DEFAULT 'unknown';  -- classify.ts STATUSES
ALTER TABLE events ADD COLUMN IF NOT EXISTS status_checked_at timestamptz;
ALTER TABLE events ADD COLUMN IF NOT EXISTS on_sale_at        timestamptz;
ALTER TABLE events ADD COLUMN IF NOT EXISTS venue_id          uuid REFERENCES venues(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS events_venue ON events (venue_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS home_lat      double precision;  -- geocoded taste homeArea + city
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_lng      double precision;
ALTER TABLE users ADD COLUMN IF NOT EXISTS max_travel_km real;              -- optional distance filter; null = none

-- Event schema v3 part B (src/lib/events: cancellation.ts, status.ts, handoff.ts): how a booking can be cancelled,
-- and whether tickets can be passed on. Missing method = 'unknown' (blocks booking unasked).
ALTER TABLE venue_policies ADD COLUMN IF NOT EXISTS method       text;     -- online_self_service | email | phone | box_office | not_possible | unknown
ALTER TABLE venue_policies ADD COLUMN IF NOT EXISTS contact      text;     -- URL / email / phone for cancelling
ALTER TABLE venue_policies ADD COLUMN IF NOT EXISTS transferable boolean;  -- tickets may be given to someone else

-- Per-event cancellation (src/lib/events: status.ts, cancellation.ts, platforms.ts; PLAN §9): the policy that applies to
-- THIS event (event page > venue policy > ticket-platform default), with a cancel/manage link. Full object stays in
-- details.cancellation; these columns are for queries and the 24 h reuse check.
ALTER TABLE events ADD COLUMN IF NOT EXISTS cancellation_kind       text;         -- PolicyKind
ALTER TABLE events ADD COLUMN IF NOT EXISTS cancellation_scope      text;         -- event | venue | platform | none
ALTER TABLE events ADD COLUMN IF NOT EXISTS cancellation_source     text;         -- event_page | venue_policy | platform_default | confirmation_email | none
ALTER TABLE events ADD COLUMN IF NOT EXISTS cancellation_url        text;         -- verified cancel/manage-order link (or the platform's order page)
ALTER TABLE events ADD COLUMN IF NOT EXISTS policy_url              text;         -- page stating the policy
ALTER TABLE events ADD COLUMN IF NOT EXISTS cancel_by               timestamptz;  -- last moment to cancel under the policy
ALTER TABLE events ADD COLUMN IF NOT EXISTS cancellation_checked_at timestamptz;

-- Every outgoing WhatsApp message with what happened to it (src/lib/whatsapp.ts), one row per send (not per chunk).
-- Dev worktrees never reach Twilio for test numbers, so this is how the chat tools (plugins/worktrees) read replies.
CREATE TABLE IF NOT EXISTS outbound_messages (
  id          bigserial PRIMARY KEY,
  phone       text NOT NULL,                          -- E.164
  body        text NOT NULL,
  media_url   text,
  status      text NOT NULL,                          -- sent | dry_run | not_allowlisted | failed
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbound_messages_phone ON outbound_messages (phone, created_at);

-- ---------- Agent inboxes (AgentMail, src/lib/agentmail.ts, docs/agentmail.md) ----------
-- One inbox per user, created lazily. AGENTMAIL_ENV that created it (prod, wt-<worktree>, dev): worktree databases
-- are copies of production, so each environment only uses and processes inboxes it created itself.
ALTER TABLE users ADD COLUMN IF NOT EXISTS agentmail_email    text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS agentmail_env      text;
-- Which address the agent types into signup forms (policy.chooseSignupEmail): auto | always_user
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_email_pref  text NOT NULL DEFAULT 'auto';
CREATE INDEX IF NOT EXISTS users_agentmail_inbox ON users (agentmail_inbox_id);

-- An address handed out for one event's signup/checkout, so inbound mail can be matched to the event.
CREATE TABLE IF NOT EXISTS email_signups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id     uuid REFERENCES events(id) ON DELETE SET NULL,
  url          text,                                  -- the page with the form
  site_domain  text,                                  -- e.g. eventbrite.com (no www)
  email        text NOT NULL,
  email_kind   text NOT NULL CHECK (email_kind IN ('agent','user')),
  reason       text,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_signups_user ON email_signups (user_id, created_at);

-- Every email received in an agent inbox (supersedes the unused inbound_emails). message_id dedupes webhook retries
-- and webhook/websocket overlap; claimed_at/processed_at let a delivery whose processing died be picked up again.
CREATE TABLE IF NOT EXISTS agent_emails (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  inbox_id      text NOT NULL,
  message_id    text UNIQUE NOT NULL,
  thread_id     text,
  from_address  text,
  subject       text,
  text          text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  kind          text CHECK (kind IN ('verification','confirmation','marketing','other')),
  signup_id     uuid REFERENCES email_signups(id) ON DELETE SET NULL,
  event_id      uuid REFERENCES events(id) ON DELETE SET NULL,
  extracted     jsonb NOT NULL DEFAULT '{}',          -- links, codes, and for confirmations the booking details
  claimed_at    timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  notified_at   timestamptz                           -- WhatsApp sent (confirmations only)
);
CREATE INDEX IF NOT EXISTS agent_emails_user_event ON agent_emails (user_id, event_id, received_at);

-- Ticket attachments of confirmation emails, served at /tickets/:token (unguessable) so WhatsApp can link to them.
CREATE TABLE IF NOT EXISTS email_attachments (
  token          text PRIMARY KEY,
  email_id       uuid NOT NULL REFERENCES agent_emails(id) ON DELETE CASCADE,
  attachment_id  text NOT NULL,
  filename       text,
  content_type   text,
  size           integer,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------- Booking flow (src/mastra/workflows/book.ts, docs/booking/PLAN.md) ----------
-- One row per user + event + showtime (idempotency_key); a failed or cancelled booking is reused by the next attempt.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS showtime         text;         -- local "2026-10-08T20:30" being booked
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS hold_ref         text;         -- credit_holds.ref of the current attempt
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS approved_cents   integer;      -- total agreed to (auto-approve or the user's "yes")
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS suspended_step   text;         -- workflow step waiting for the user
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS order_ref        text;         -- the shop's order number
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pay_attempted_at timestamptz;  -- set right before the card is submitted: never twice
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS error            text;

-- Numbered picks the user last saw (find-events, morning message), so "book #2" resolves to an event.
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS pick_n    integer;
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS picked_at timestamptz;

-- Mock ticket shop "Ticketeria" (src/mastra/routes/mockshop.ts, only with MOCK_SHOP=1): its orders, to check bookings against.
CREATE TABLE IF NOT EXISTS mock_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no          text UNIQUE NOT NULL,                 -- e.g. TK-7Q4M2X
  cart_id           text UNIQUE NOT NULL,                 -- one order per checkout, so a double submit can't buy twice
  event_slug        text NOT NULL,
  showtime          text NOT NULL,                        -- local "2026-10-08T20:30" (Europe/Berlin)
  qty               integer NOT NULL,
  ticket_type       text NOT NULL,
  unit_price_cents  integer NOT NULL,
  fees_cents        integer NOT NULL DEFAULT 0,
  total_cents       integer NOT NULL,
  attendee_name     text,
  attendee_email    text,
  member_email      text,                                 -- signed-in account (login-required events)
  card_last4        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mock_orders_created ON mock_orders (created_at);

-- Onboarding v2 starter deck (src/lib/events/starter.ts, docs/onboarding/PLAN.md): real upcoming events in the user's
-- city to swipe during setup. Swipes are taste signals for the onboarding analysis, not booking decisions.
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS source     text NOT NULL DEFAULT 'discovery';  -- discovery | starter
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS reaction   text CHECK (reaction IN ('like','dislike'));
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS reacted_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS starter_city text;   -- city_key the starter suggestions were seeded for

-- One deck per city, shared by all users there; the status row doubles as the build lock.
CREATE TABLE IF NOT EXISTS starter_decks (
  city_key    text PRIMARY KEY,                       -- lower-case, single-spaced city name
  city        text NOT NULL,
  status      text NOT NULL CHECK (status IN ('building','ready','failed')),
  started_at  timestamptz NOT NULL DEFAULT now(),     -- a 'building' row older than 10 min counts as failed
  built_at    timestamptz,
  event_ids   uuid[] NOT NULL DEFAULT '{}',           -- the city's pool, best first; each user gets ~12 of them
  cost_dollars real
);

-- Representative page image (og:image) from Exa, for event cards.
ALTER TABLE exa_page_cache ADD COLUMN IF NOT EXISTS image text;
