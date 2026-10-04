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
