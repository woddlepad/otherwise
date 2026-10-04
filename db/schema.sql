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
