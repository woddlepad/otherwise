# Event search (discovery) — plan

Status: **P0 built and tested locally** (2026-10-04 ~13:15 PT); cancellation policies + interest matching added. Submissions close 16:30 PT.

## 0. What exists now

| File | Role |
|---|---|
| `src/lib/events/exa.ts` | `searchUrls` (Exa search, URLs only) + `loadPages` (`/contents` with per-page `summary.schema`, batches of 10 in parallel) |
| `src/lib/events/cache.ts` | Postgres caches: `exa_search_cache` (query → URLs, 12 h) and `exa_page_cache` (URL → events for a date window, 24 h, hit if the cached window covers the requested one; empty pages cached too). `DISCOVERY_NO_CACHE=1` / `--no-cache` bypasses |
| `src/lib/events/normalize.ts` | dates in user tz, window filter, junk/placeholder filtering (articles, "today" stamps), cross-site dedupe |
| `src/lib/events/plan.ts` | LLM query planning (+ narrows the window for "Friday"), template fallback |
| `src/lib/events/score.ts` | one batched LLM rating (confidence, reason, **matches** = which interests), calendar check, `policy.decide()` |
| `src/lib/events/cancellation.ts` | **refund/cancellation policy** per venue domain (Exa site search → LLM classify → `venue_policies` cache), and the gate `allowsBookingUnasked` |
| `src/lib/events/discover.ts` | orchestration: `findCandidates`, `finalizePicks` (shortlist → policy → gate), `discover` |
| `src/lib/events/store.ts`, `notify.ts` | events/suggestions/discovery_runs; morning WhatsApp message (also written into the concierge thread) |
| `src/mastra/agents/scout.ts` | planning/rating/classifying agent, `DISCOVERY_MODEL` (default `neon/claude-sonnet-5`) |
| `src/mastra/tools/events.ts` | `find-events` tool on the concierge (cache first, else live search) |
| `src/mastra/workflows/discover.ts` | `discover-events`: find-and-rate → notify top 3 |
| `src/mastra/routes/discover.ts` | `POST /cron/discover` (Neon trigger or `CRON_SECRET`), `POST /dev/discover` (X-Dev-Token) |
| `scripts/discover.ts` | tuning CLI (`--hint`, `--fast`, `--no-llm`, `--user <phone>`) |

### Classification (`src/lib/events/classify.ts`)
- `category`: one of music, film, comedy, theatre, dance, talk, tech_meetup, art, food_drink, nightlife, sports, workshop, festival,
  family, other. Assigned by Exa's per-page extractor, so it costs no gateway tokens; keyword fallback when missing. Stored in `events.category`.
- `tags`: 2–6 lowercase genre/format words ("jazz", "vocal", "35mm", "horror", "stand-up"). Stored in `events.tags`, merged across duplicates.
- Derived in code (`attrs`): `timeOfDay` (morning/afternoon/evening/late), `weekend` (Fri evening–Sun), `priceBand` (free/$/$$/$$$ from the
  search-price estimate), `ageLimit` (21+/18+).
- Used for: the rating prompt (category, tags, time of day per line), the dislikes filter (whole-word match on title/category/tags),
  the `find-events` `categories` filter (also filters the stored-event cache), the morning top 3 (`diversify`: at most one per category
  while others exist), the WhatsApp line ("Kurt Elling · Music") and `Pick.category/tags`.
- `AGGREGATORS` (listing/reseller domains) lives here too and is shared by dedupe ranking and the cancellation lookup.

### Caching
Cold run: ~$0.08 Exa and ~36 s for search+extraction; warm: $0 and ~0.1 s. The 14-day morning run fills the page cache, so a later
"anything on Friday?" chat request reuses those pages even when the LLM words its queries differently. Venue policies are cached separately (7 days).

### Cancellation policy rule (the agent books before the user confirms)
- Policies live on the venue's/ticket shop's FAQ or policy page, not on the event page → looked up **once per domain**, cached 7 days.
  Per-event platforms (Eventbrite, Luma, DICE, …) are read from the event page. Aggregators (Bandsintown, Songkick, …) → `unknown`.
- Kinds: `free_event`, `free_cancellation`, `refund_with_fee`, `exchange_or_credit_only`, `no_refunds`, `unknown`, plus deadline (hours before start),
  fee, verbatim quote, source URL. Stored on `events.details.cancellation` and returned in picks (`cancellation`, `cancelBy`).
- **Book unasked only if** the event is free, or it has free cancellation whose deadline is ≥12 h away (no stated deadline → assume 24 h before start),
  **and** the rating names at least one matching interest, **and** `policy.decide()` says book (confidence, price, budget, calendar).
  Everything else becomes "ask". A "free cancellation" reading is only accepted from a policy-type page (one-off notices about cancelled shows were misread).
- Checked 2026-10-04: SFJAZZ = exchange/credit only until 48 h, $25 fee · Black Cat = all sales final · Roxie = no refunds/exchange only.
  So in SF most paid shows will be "ask", which is the safe default.

Reference notes: [exa.md](exa.md) · [mastra.md](mastra.md) · [codebase-and-neon.md](codebase-and-neon.md) · [structured-event-apis.md](structured-event-apis.md)

## 1. What it must do (demo story)

1. **Proactive:** each morning the agent finds 3 events the user will probably love in the next 14 days, scores them against the
   taste profile and calendar, and sends them on WhatsApp ("1/2/3 to book"). If it is very sure and the price is under the auto-book
   limit, it books without asking (handoff to the booking flow).
2. **On demand:** "anything fun this weekend?" or "jazz on Friday?" in chat → a ranked list within ~10 s, from the same pipeline.
3. **Explainable:** every suggestion has a one-line *why* ("you've seen Kurt Elling twice") and a source link.

Out of scope here: checkout, price verification, ledger (the booking flow owns those). We hand over `event_id` + estimated price.

## 2. Pipeline

```
taste profile + city + tz + window
        │
  ① plan queries ── LLM (neon/claude-sonnet-5, structuredOutput) → 4–8 queries, "describe the ideal page"
        │            + venue-calendar URLs from taste.favoriteVenues (P1)
  ② search ──────── exa.search(q, { type:'auto', numResults:8,
        │              contents:{ summary:{ schema: PageEvents }, maxAgeHours:72 } })   foreach, concurrency 4
        │            → per page: { pageKind:'single'|'listing', events:[{title, startsAt, venue, priceText, url}] }
  ③ normalise ───── code: parse dates in user tz, drop past / out-of-window / no-date, canonical URL,
        │            dedupe key = url  ||  venue+startMinute+normTitle
  ④ store ───────── upsert `events` (estimate price in details), skip events already suggested to this user
        │
  ⑤ score ───────── ONE batched LLM call: taste + notes + candidates (compact) → {eventId, confidence 0–1, reason}
        │            hard filters in code first: dislikes keywords, calendar busy (getBusy), > per-event cap
  ⑥ decide ──────── policy.decide() per event → book | ask | skip
  ⑦ deliver ─────── write `suggestions`; daily: WhatsApp top 3 (ask) / hand "book" ones to booking flow;
                     chat: return list to the concierge (it phrases the message)
```

Why this shape:
- **Extraction happens at Exa, per page** (`summary.schema`). It handles both single event pages and venue calendars (the SF test
  returned both). It costs no Neon gateway tokens (200k TPM limit) and ~$1/1k pages. `outputSchema` (cross-result synthesis) is capped
  at 10 properties and drops items on calendar pages (exa.md §2). Fallback: `text` + our own extractor (Haiku / gpt-5-mini) if summaries
  turn out sloppy.
- **Event dates can't be filtered by Exa** (date filters are publish-date). The window goes into the query text plus code filtering in ③.
- **Prices from search are estimates.** They are stored as `details.priceText`/`priceMinCents`; `events.price_cents` stays null until the booking
  flow reads the live page.
- **LLM calls per run: 2** (plan + score), so it's cheap and fast. Everything else is code.

## 3. Interfaces

```ts
// src/lib/events/types.ts
type Candidate = { title; startsAt: string /*ISO+offset*/; venue?; city?; url; pageUrl; priceText?; priceMinCents?; currency?;
                   category?; source: 'exa'|'venue'|'ticketmaster'; raw?: unknown };
type ScoredEvent = { eventId; title; startsAt; venue; url; priceText; confidence; reason; decision: Decision };

// src/lib/events/discover.ts — pure-ish library, used by tool + workflow + script
planQueries(ctx: DiscoveryContext): Promise<string[]>
searchEvents(queries, ctx): Promise<Candidate[]>            // Exa + normalise + dedupe
storeEvents(cands): Promise<StoredEvent[]>                  // upsert events
scoreEvents(userId, events, ctx): Promise<ScoredEvent[]>    // filters + LLM + policy.decide
discover(userId, opts: { window?: {from,to}; hint?: string; limit?: number; notify?: boolean }): Promise<ScoredEvent[]>
```
- `DiscoveryContext` = user (city, tz), `getTaste()`, `getBudgetStatus()`, window, optional `hint` (the chat request, e.g. "jazz Friday").
- **Tool** `find-events` (`src/mastra/tools/events.ts`): input `{ request: string, from?, to? }`. It first checks fresh DB events (<24 h)
  for this window; if fewer than 5, it runs `discover(..., {notify:false})`. Returns ≤6 compact rows `{n, title, when, venue, price, why, url, decision}`.
- **Workflow** `discover-events` (`src/mastra/workflows/discover.ts`): steps = plan → foreach(search, concurrency 4) → store → score →
  deliver. It wraps the same lib functions so Studio shows each step. Input `{ userId, notify: boolean }`.
- **Routes** (`src/mastra/routes/discover.ts`):
  - `POST /cron/discover`: Neon trigger (`x-neon-trigger-invocation-id`) or `Authorization: Bearer $CRON_SECRET`; loops over users with
    `onboarding_status='ready'`, one workflow run each, inside `waitUntil`, returns 202. Idempotent via `discovery_runs(user_id, day)`.
  - `POST /dev/discover {phone|userId}`: manual trigger for demo and debugging (non-prod).
- **Script** `scripts/discover.ts --city "San Francisco" --taste fixtures/jazz-film.json`: runs the pipeline without DB/WhatsApp, for tuning queries.

## 4. Data changes (append to db/schema.sql, coordinate with the other session)

```sql
ALTER TABLE events ADD COLUMN IF NOT EXISTS dedupe_key text UNIQUE;     -- venue+startMinute+normTitle
ALTER TABLE events ADD COLUMN IF NOT EXISTS category  text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS events_city_start ON events (city, starts_at);
CREATE TABLE IF NOT EXISTS discovery_runs (
  user_id uuid REFERENCES users(id) ON DELETE CASCADE, day date, trigger text, run_id text,
  queries text[], candidates int, suggested int, created_at timestamptz DEFAULT now(), PRIMARY KEY (user_id, day, trigger));
```
`events.details` holds `{ priceText, priceMinCents, pageUrl, pageKind, query, exaRequestId }`. Embeddings: **skip for now** (text dedupe key).
The `vector(1536)` column stays unused.

## 5. Build order

| # | Piece | Est. | Demo value |
|---|---|---|---|
| P0.1 | `lib/events`: searchEvents (Exa + summary.schema + normalise) + `scripts/discover.ts` with a fixture taste, tuned on SF | 45 min | proves sources |
| P0.2 | planQueries + scoreEvents (2 structured LLM calls) + policy.decide | 40 min | the "smart" part |
| P0.3 | `find-events` tool wired into the concierge (1 import + 1 key) | 20 min | chat demo |
| P0.4 | storeEvents + schema additions + suggestions rows | 30 min | feed/UI + booking handoff |
| P0.5 | `discover-events` workflow + `/dev/discover` → WhatsApp top-3 message | 40 min | proactive demo |
| P1.1 | `/cron/discover` + Neon trigger (`neon.ts` `triggers`) + discovery_runs idempotency | 30 min | "it runs every morning" |
| P1.2 | Favourite-venue calendars: `getContents(maxAgeHours:24, summary.schema)` on venue URLs from the taste profile | 30 min | personal touch |
| P2 | Exa Monitors for "new show announced" at favourite venues; Ticketmaster source; embeddings / "more like this" | — | stretch |

P0 ≈ 3 h. That leaves ~1.5 h buffer for integration, demo prep and the deployed run.

## 6. Decisions to make together

1. **Extraction:** Exa `summary.schema` per page (recommended) vs `outputSchema` per query vs our own LLM over `text`.
2. **Window & cadence:** next 14 days, daily at 08:00 local (cron is UTC → per-user tz, or a single fixed 15:00 UTC for the demo)?
3. **Demo persona:** whose taste profile and which city? SF (we're there and data is great) vs the user's real city (Berlin in the examples).
4. **How many to send:** top 3 per morning; minimum confidence = `ask_confidence` (0.5)? Never re-suggest an event already sent.
5. **Ownership:** we own `src/lib/events/*`, `tools/events.ts`, `workflows/discover.ts`, `routes/discover.ts`, `scripts/discover.ts`,
   and `docs/event-search/`. Shared edits: `index.ts` (register), `concierge.ts` (tool + 1 instruction line), `schema.sql` (append block),
   `neon.ts` (`CRON_SECRET`, trigger). OK with the other session?
6. **Keys:** `EXA_API_KEY` in `.env`; LLM via Neon gateway (`neon env pull` gives `NEON_AI_GATEWAY_*`). Revert my
   `MODEL=mastra/...` in `.env` so it uses the team default `neon/claude-sonnet-5`?

## 7. Risks

- Exa summary quality on big calendar pages (40+ showtimes): mitigate with `summary.query` focusing on the window, or fall back to text + own extractor.
- Timezone/year inference ("Sat Oct 17"): extractor must output ISO with offset; code assumes the user's tz and the current/next year; drop if ambiguous.
- Neon gateway 200k TPM: scoring prompt must stay compact (≤40 candidates, ~60 tokens each).
- Structured output through `neon/claude-*` is untested: use `errorStrategy:'fallback'` and `jsonPromptInjection:'auto'` if needed.
- Public Mastra API routes on the Neon URL (no auth): don't expose `/dev/*` in production.

## 8. Next: event schema v3 (PLANNING, not built)

Requirements gathered 2026-10-04 ~13:00 PT: precise location, venue identity, richer cancellation policy, a booking URL the
booking agent can open, and the latest availability status.

### 8.1 Per-event extraction (Exa `summary.schema`, per page; bump page-cache version)
| Field | Type | Notes |
|---|---|---|
| title, start, price, category, tags | (as today) | |
| `venueName` | string | name only (today `venue` mixes name + address) |
| `address` | string | street address if shown |
| `city` | string | as on the page; replaces "assume the searched city" (Oakland/Santa Clara were stored as SF) |
| `online` | boolean | livestream/online |
| `url` | string | detail/info page |
| `bookingUrl` | string | direct "Buy tickets / Register / RSVP" link; may differ from `url` (e.g. Roxie film page → Veezi checkout) |
| `status` | enum | `on_sale` · `few_left` · `waitlist` · `sold_out` · `not_yet_on_sale` · `door_only` · `free_rsvp` · `free_entry` · `cancelled` · `postponed` · `unknown` |
| `onSaleAt` | string? | for `not_yet_on_sale` |

Risk: 12+ properties per item; Exa documents no limit for `summary.schema`, but quality may drop. Test on the SF set before adopting;
fallback is a second, small per-page call only for shortlisted events.

### 8.2 Status freshness ("latest status")
- Extraction status is as old as the page cache (≤24 h) + Exa's cache (`maxAgeHours: 24`).
- **Live re-check for the shortlist only** (≤10 events/run): `/contents` on `bookingUrl ?? url` with `maxAgeHours: 1`
  (or `0` = live crawl, +~10 s) and a tiny schema `{status, price, bookingUrl, onSaleAt}`. Store `status`, `status_checked_at`.
- Rules (code): `sold_out` / `cancelled` / `postponed` → drop; `waitlist` → ask only, say "waitlist"; `not_yet_on_sale` → ask, mention `onSaleAt`;
  `few_left` → mention urgency; `unknown` → allowed but never booked unasked.
- Pages behind bot walls (Ticketmaster etc.) won't crawl → status `unknown`; the booking agent checks for real in the browser.

### 8.3 Venues table (new)
`venues(id, name, norm_name, address, city, domain, lat, lng, created_at)`, unique `(norm_name, city)`; `events.venue_id` FK.
- Merges "Cobb's Comedy Club" / "Cobbs Comedy Club" / "Cobb's …, 915 Columbus Ave" into one row.
- Cancellation policy moves from `venue_policies(domain)` onto the venue (keeps per-event override for Eventbrite/Luma/DICE).
- `lat/lng` empty until a geocoder is chosen (Nominatim free 1 req/s, or Google with a key); then distance from the user's home.

### 8.4 Cancellation policy additions
- `cancelMethod`: `online_self_service` · `email` · `phone` · `box_office` · `not_possible` · `unknown`, plus `cancelContact` (URL/email).
- `transferable`: boolean (Black Cat: "no refunds, tickets transferable").
- Gate for booking unasked gains: method must be one the agent can do itself (`online_self_service` or `email` via AgentMail).
- Booking agent must re-read the policy on the actual checkout page and abort if it's worse than what the user was shown.

### 8.5 Booking handoff contract (what event search gives the booking agent)
`getBookingHandoff(eventId)` →
```ts
{ eventId, title, startsAt /*ISO*/, startLocal, timezone,
  venue: { name, address, city }, online,
  bookingUrl /*open this*/, detailUrl, sourcePageUrl,
  priceEstimate: { text, minCents, currency } /*never charge on this*/,
  status, statusCheckedAt,
  cancellation: { kind, cancelBy, fee, method, contact, transferable, quote, sourceUrl },
  ticketsWanted /*taste.usualTicketCount*/, decision: { action, reason }, suggestionId }
```
Also included in every `find-events` pick, so the concierge can pass it on. **Agree this shape with the booking-agent owner.**

### 8.6 Users
`users` exists (phone, name, city, timezone, interests, email, onboarding, agentmail_inbox_id, kernel_profile, stripe_customer_id).
No home location: `homeArea` is only text in `taste_profiles.profile`. For distance, add `users.home_lat/home_lng` (geocode homeArea
once) — only if we do geocoding.

### 8.7 Open questions
1. Geocoding now (which provider) or later?
2. Live status re-check: `maxAgeHours: 1` (cheaper, may be an hour stale) or `0` (live, +~10 s per batch)?
3. Who owns the booking side, so we can agree the handoff shape?
4. Keep `venue_policies` keyed by domain as a fallback after venues exist? (Recommended: yes.)

### 8.8 Build split (when approved; coded by subagents)
- A: extraction v3 + normalise + venues table + store (one subagent, owns exa/normalize/store/schema).
- B: status re-check + gates + handoff function + pick fields (second subagent, after A's types land).
- C: cancellation method/transferable (small, can go with B).

### 8.9 Decided 2026-10-04
- Keep both join tables for now: `suggestions` (one row per user+event: the offer) and `bookings` (attempts: money, tickets).
  Later: add `bookings.suggestion_id` and `feedback.event_id`, and update `suggestions.status` on approve/decline.
- Geocoding: **OpenStreetMap Nominatim** now. Policy: ≤1 request/s, a real `User-Agent` with contact (env `NOMINATIM_USER_AGENT`,
  e.g. "booking-agent/0.1 (ops@example.com)"), cache results forever per venue, attribution "© OpenStreetMap contributors" where shown.
  Geocode each new venue once (`venues.lat/lng`, `geocoded_at`, `geocode_source`), and the user's `homeArea` once (`users.home_lat/lng`).
  Requests are serialised with 1.1 s spacing; a run geocodes at most ~10 new venues, the rest wait for the next run.
  Distance (haversine, code) feeds the rating prompt ("2.1 km from home") and an optional `users.max_travel_km` filter (default none).
- Live status re-check: Exa `/contents` with **`maxAgeHours: 1`** for shortlisted events only.
- Booking handoff: we define it (v1 below); the booking side can ask for changes later.

### 8.10 Booking handoff API (v1)
Code: `src/lib/events/handoff.ts`.
```ts
getBookingHandoff(userId: string, eventId: string, opts?: { refresh?: boolean }): Promise<BookingHandoff>
// refresh (default true): re-check status/price/bookingUrl if statusCheckedAt is older than 1 h

type BookingHandoff = {
  version: 1;
  eventId: string; suggestionId: string | null; userId: string;
  title: string; category: EventCategory; tags: string[];
  startsAt: string;            // ISO UTC
  startLocal: string;          // "2026-10-08T19:30" in `timezone`
  timezone: string; hasTime: boolean;
  venue: { id: string | null; name: string | null; address: string | null; city: string | null;
           lat: number | null; lng: number | null; distanceKm: number | null };
  online: boolean;
  bookingUrl: string | null;   // open this; null → start from detailUrl
  detailUrl: string; sourcePageUrl: string;
  priceEstimate: { text: string | null; minCents: number | null; currency: string | null }; // never charge on this
  status: EventStatus; statusCheckedAt: string;
  cancellation: { kind: PolicyKind; cancelBy: string | null; hoursBeforeStart: number | null; fee: string | null;
                  method: CancelMethod; contact: string | null; transferable: boolean | null;
                  quote: string | null; sourceUrl: string | null; summary: string };
  ticketsWanted: number;       // taste.usualTicketCount ?? 1
  decision: { action: 'book' | 'ask' | 'skip'; reason: string; confidence: number };
  bookable: { ok: boolean; reason: string }; // false for sold_out/cancelled/postponed/past/online-without-link
};
```
Exposed as: the function (same process), `find-events` picks carry `eventId` (+ `bookingUrl`, `status`), and a route
`GET /api/events/:eventId/handoff?userId=…` (auth: `X-Dev-Token` / internal) in case booking runs as a separate service.
Contract for the booking side: re-read price + cancellation on the checkout page; abort and ask if worse than the handoff.

### 8.11 Still open
- Calendar: switch `getBusy` to free/busy endpoints (Google `freeBusy`, Graph `getSchedule`): owned by the other session.

### 8.12 Status 2026-10-04 ~14:15 PT: part A (extraction v3 + venues + geocoding) built
- Extraction: `venueName`, `address`, `city`, `online`, `url`, `bookingUrl`, `status` (`STATUSES` in classify.ts), `onSaleAt`; page cache v3.
  Yield on the same 39 SF pages: v3 83 events vs v2 73. 9 big calendar pages (Roxie/Balboa calendars, Veezi) currently return no summary with either schema.
  `bookingUrl` is rarely extracted: falls back to the event link when it is a ticket/RSVP page (`looksBookable`); `example.com` placeholders dropped.
- `venues` table (`venues.ts`): merged by `normVenueName` + city, and by the same street address in the city. Geocoded with Nominatim (`geocode.ts`, ≤10/run, 1.1 s spacing,
  misses marked `nominatim:none`); `users.home_lat/lng` from taste `homeArea` + city. `distanceKm` goes into the rating prompt; `users.max_travel_km` filters.
- `discover()` drops `DEAD_STATUSES` and too-far events before rating; `recentEvents` excludes dead statuses and takes an optional `home` for distances.
- Next (part B): live status re-check, `handoff.ts`, cancellation method/transferable.

### 8.13 Status 2026-10-04 ~13:40 PT: part B (re-check, gates, handoff, cancellation method) built
- **Live re-check** `status.ts refreshStatus()`: shortlist only (≤10), Exa `/contents` on `bookingUrl ?? url`, `maxAgeHours: 1`, one call per
  page in parallel (one batch with all ten events in the query made the summariser mix events up). The page returns the dates it lists;
  `startConfirmed` is computed in code (page lists dates and none is the event's day → false). Status from aggregator pages only replaces
  `unknown`. Writes `events.status/status_checked_at/booking_url/on_sale_at` and `details.priceText/priceMinCents/startConfirmed`.
  Season/calendar/package pages and resellers are not booking links (dropped on re-check and at extraction; `gotickets` added to AGGREGATORS).
- **Gates** (`discover.ts finalizePicks` → `statusGate`): dead status or date not confirmed → dropped; waitlist / not_yet_on_sale ("on sale from …") /
  unknown → never `book`; free_entry → `ask` "free, no ticket needed"; door_only → `ask` "tickets at the door only"; online without link → never `book`.
  Picks are folded when they share title+start, venue+start time, venue+day+core title, or (same day, venues ≤300 m apart, a shared name word).
- **Cancellation**: `method` (`online_self_service|email|phone|box_office|not_possible|unknown`), `contact`, `transferable` on the policy, in
  `venue_policies` and in the summary ("… · cancel by email info@x"). Booking unasked additionally needs method online_self_service or email.
  Cached policies without `method` (from before) are looked up once more.
- **Handoff** `handoff.ts getBookingHandoff()` = §8.10 v1. `bookable` is also false for `door_only` (nothing to buy online).
  Route: **`GET /events/:eventId/handoff?userId=…|phone=…`** (`X-Dev-Token`), not `/api/…`: Mastra refuses custom routes under `/api`.
- Picks carry `bookingUrl`, `status`, `onSaleAt`, `address`, `city`, `distanceKm`; WhatsApp shows "few left!" / "waitlist only" / "on sale …", km, booking link.
- Chat cache (`recentEvents`): same city **or** venue within 40 km of home (no home: of the city's geocoded venues' centre); `max_travel_km` applied.
- Page cache: pages with zero events expire after 3 h (`EMPTY_PAGE_CACHE_HOURS`).

### 8.14 Known issues (accepted for the demo, 2026-10-04)
- Store collision: two listings with the same source URL + start time can share one `events` row, so a pick's title can differ
  from the handoff's title (seen once: "Kurt Elling & The Yellowjackets" vs "The Music of Weather Report"). Not fixed (user: skip).
- `bookingUrl` is usually null; the booking agent starts from `detailUrl`.
- Handoff route is `GET /events/:eventId/handoff` (not `/api/...` as in §8.10; Mastra reserves `/api`).
- Neon DB not migrated; `neon.ts` daily trigger + env passthrough (`CRON_SECRET`, `DISCOVERY_MODEL`, `NOMINATIM_USER_AGENT`) not added.
- Decided 2026-10-04: **no periodic pulls for the hackathon.** The Neon daily trigger is dropped; for the demo, run discovery
  once per demo user (`POST /dev/discover {"phone":…,"notify":true}` with `X-Dev-Token`, or `scripts/discover.ts --user …`).
  `/cron/discover` stays in the code for later.
