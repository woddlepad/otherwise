# Event search: codebase integration points + Neon platform notes

Snapshot 2026-10-04 ~18:45 UTC. Another session owns onboarding / booking code; event search should live in
new files and touch shared files only to register things.

## Existing code we plug into (read-only for us)

| What | Where | Signature / notes |
|---|---|---|
| DB pool | `src/lib/db.ts` | `db` (pg.Pool, `attachDatabasePool` for Neon). `getBudgetStatus(userId) → BudgetStatus` (`remainingCents`, `autoApproveCents`, `perEventCapCents`, `currency`) |
| User | `users` table | `id, phone, name, city, interests, timezone, email, onboarding_status ('new'\|'link_sent'\|'analyzing'\|'ready')` |
| Taste | `src/lib/taste.ts` | `getTaste(userId) → StoredTaste {profile: TasteProfile\|null, summary, notes[], autoBookConfidence, askConfidence}`; `tasteForPrompt(stored)` → compact prompt text. `TasteProfile.likes[] {category, specifics[], evidence, strength}`, `dislikes[]`, `favoriteVenues[]`, `typicalTicketPrice`, `currency`, `usualCompany`, `usualTicketCount`, `preferredTimes`, `homeArea`, `openQuestions[]` |
| Decision | `src/lib/policy.ts` | `decide({confidence, totalCents, calendarFree, budget, autoBookConfidence, askConfidence}) → {action:'book'\|'ask'\|'skip', reason}`. Pure code; LLM only supplies confidence. |
| Calendar | `src/lib/calendar.ts` | `getBusy(userId, from: Date, to: Date) → {title,start,end}[]` (empty = free). Google + Microsoft via OAuth `connections`. Throws/returns [] if none connected. |
| WhatsApp | `src/lib/whatsapp.ts` | `sendWhatsApp(phone, text, mediaUrl?)`; dry-run logs when Twilio unset. Plain text, splits >1500 chars. |
| Exa tools (generic) | `src/mastra/tools/web.ts` | `webSearch` (`web-search`), `readPage` (`read-page`), lazy `new Exa(EXA_API_KEY)`. Generic web tools for the concierge — keep; event search adds its own specialised path. |
| Concierge | `src/mastra/agents/concierge.ts` | tools object — add `findEvents` here (1 import + 1 key). Gets `userId`, `phone` from `requestContext`. |
| Analyst agent | `src/mastra/agents/analyst.ts` | no tools/memory; used with `generate(prompt, { structuredOutput: { schema } })` → `result.object` (see `workflows/onboard.ts`). Good pattern for query planning / extraction / scoring. |
| Mastra instance | `src/mastra/index.ts` | `agents`, `workflows: { onboardUser }`, `server.apiRoutes` — register `discoverEvents` + a trigger route here. |
| Tool userId helper | `src/mastra/tools/taste.ts` | `userIdFrom(requestContext)` (not exported — copy or export). |
| Neon entry | `src/index.ts` + `neon.ts` | Hono app wrapping Mastra (`@mastra/hono`); `neon.ts` passes env through (EXA_API_KEY already listed), `aiGateway: true`. |
| Webhook pattern | `src/mastra/routes/whatsapp.ts` | `registerApiRoute(path, {method, requiresAuth:false, handler})`, `c.get('mastra')`, `waitUntil(...)` from `@neon/functions` for post-response work. |

### Tables event search writes
- `events (id, source_url UNIQUE NOT NULL, title, venue, city, starts_at timestamptz, price_cents, currency, details jsonb, embedding vector(1536), created_at)`
  - `price_cents` is meant to be **page-verified only** → keep search-time price estimates in `details` (e.g. `details.priceText`, `details.priceMinCents`).
  - `source_url` is UNIQUE: calendar pages list many showtimes on one URL → key each event by its own ticket/detail URL, else `pageUrl#<slug(title)>-<startsAt>`.
  - `embedding vector(1536)` **does not match** Neon AI Gateway embedding models (1024-dim). Either skip embeddings (text-key dedupe) or migrate the column to `vector(1024)`.
- `suggestions (user_id, event_id, score real, reason, status 'suggested'|'approved'|'declined'|'expired', UNIQUE(user_id,event_id))`.
- Probably needed (new): a `discovery_runs`/`seen` record per user per day for idempotency of the scheduled run, and maybe `event_queries` for debugging/tuning. Add via a new `ALTER/CREATE … IF NOT EXISTS` block appended to `db/schema.sql` (shared file — coordinate).

## Neon platform (where it deploys)

Docs saved in `refs/docs/neon/`.

### AI Gateway (LLM provider the team chose)
- Mastra model string `neon/<model>`; env `NEON_AI_GATEWAY_BASE_URL` + `NEON_AI_GATEWAY_TOKEN` (injected on Neon Functions; `neon env pull` locally). Code default: `neon/claude-sonnet-5`.
- Models in Mastra 1.74's registry for `neon/`: claude-sonnet-5, claude-opus-5, claude-fable-5/5-1, claude-haiku-4-5, claude-sonnet-4-5/4-6, gemini-3-5-flash(-lite), gemini-3-6-flash, gpt-5.x, … Neon's own catalog also lists `claude-opus-5-5`; **no `claude-sonnet-5-5`**.
- Prices per 1M tokens in/out: Sonnet 5 $2/$10, Haiku 4.5 $1/$5, Opus 5.5 $4/$20.
- Embeddings (`POST /v1/embeddings`): `qwen3-embedding-0-6b` (1024-d, $0.02/1M), `gte-large-en` (1024-d). Not in Mastra's `neon/` registry list. Reaching them may need a direct OpenAI-compatible call.
- **Rate limit: 200k tokens/minute per account** (input+output); 429 on exceed. Matters for batch scoring: keep prompts compact, score in batches, fall back to fewer events.
- Fit: Sonnet 5 for query planning + scoring (judgement); Haiku 4.5 / Gemini Flash for bulk extraction if we do it ourselves.

### Functions runtime
- Node 24, 2 GiB, up to 100 concurrent invocations, **15-min `waitUntil` cap**; isolates get evicted → no in-memory state between requests (dedupe sets, queues, caches must go to Postgres).
- A discovery run (≈6 Exa searches + 2–3 LLM calls) is well under limits; run per user, respond 202 and continue in `waitUntil`.

### Scheduled triggers (daily discovery)
- Neon Function Triggers: five-field **UTC** cron, declared in `neon.ts` `triggers: { <name>: { function: '<slug>', cron: '0 15 * * *', function_path?: '/…' } }` or via `neon triggers create --function-slug … --name … --cron …`.
- Delivery: unauthenticated `POST` to the function's public URL (`/` or `function_path`) with JSON `{ data: { scheduled_at }, trigger, invocation_id }`. Verify with header `x-neon-trigger-invocation-id` (Neon strips client-set `X-Neon-*`). Handler must be idempotent (redelivery possible) → key runs by `(user_id, scheduled_at::date)`.
- Fires even when compute is scaled to zero. Under `mastra dev` there is no trigger → expose the same route for manual runs.
- Docs: `refs/docs/neon/compute_functions_triggers_schedule.md`, `cli_triggers.md`.

## Open questions for the plan
1. Exa extraction (`outputSchema`) vs our own LLM extraction, given the 200k TPM gateway limit (Exa-side extraction costs no gateway tokens).
2. Embedding dedupe now or text-key dedupe only (schema says 1536, gateway gives 1024).
3. Who owns `db/schema.sql` changes; whether discovery may send WhatsApp messages directly or via a shared notifier.
4. Timezone: `users.timezone` (may be null) — needed to turn "Sat Oct 17 7pm" into `timestamptz` and to compute "next 14 days".
