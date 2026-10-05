<p align="center">
  <img src="design/homepage/img/capy-soft.webp" alt="The Otherwise capybara, holding a little clock" width="200">
</p>

<h1 align="center">otherwise</h1>

<p align="center"><b>Otherwise, you'd have stayed in.</b></p>

<p align="center">
  <a href="https://otherwise-homepage.vercel.app"><img alt="homepage" src="https://img.shields.io/badge/homepage-otherwise--homepage.vercel.app-22675A"></a>
  <img alt="evenings on the couch: declining" src="https://img.shields.io/badge/evenings%20on%20the%20couch-declining-C44F2F">
  <img alt="FOMO: patched" src="https://img.shields.io/badge/FOMO-patched-22675A">
  <img alt="capybara: unbothered" src="https://img.shields.io/badge/capybara-unbothered-C07848">
  <img alt="budget: respected" src="https://img.shields.io/badge/budget-respected-1C302C">
  <img alt="card numbers seen by the model: 0" src="https://img.shields.io/badge/card%20numbers%20seen%20by%20the%20model-0-1C302C">
  <img alt="talks via WhatsApp" src="https://img.shields.io/badge/talks%20via-WhatsApp-25D366?logo=whatsapp&logoColor=white">
  <img alt="built with Mastra" src="https://img.shields.io/badge/built%20with-Mastra-1C302C">
  <img alt="plus-ones: bring your own" src="https://img.shields.io/badge/plus--ones-bring%20your%20own-C07848">
</p>

A personal agent that finds events you'll like and books them within a budget. You talk to it on WhatsApp.
Stack: Mastra (agent + workflows) · Postgres · Twilio WhatsApp · later Exa, Kernel, AgentMail.

**Status:** WhatsApp onboarding (connect mail + calendar → taste analysis → "ready" message), the concierge
with Exa + Kernel tools, and the confidence/budget policy. Booking workflows come next.

## How onboarding works

1. The user sends the WhatsApp bot any message. It replies with a personal setup link (`/onboard?t=…`).
2. On the setup page they connect **Gmail + Google Calendar** and/or **Outlook** through **Composio**'s hosted connect pages (Composio's own verified OAuth apps, so we don't register Google/Microsoft apps or wait for approval; Google chains Gmail → Calendar automatically). Then they enter city, optional interests, a monthly budget, and a "surprise me up to" amount. Payment is a demo card.
3. Submitting starts the `onboard-user` workflow: it reads ticket/booking emails from the last year plus 6 months of calendar history and the next 30 days, the `analyst` agent turns that into a structured taste profile (`taste_profiles`), and it sends a WhatsApp message: "here's what I picked up … ready to go 🚀".
4. After that, messages go to the concierge, which gets the taste profile in its prompt and can check availability, remember new facts, and log feedback.

**Surprise vs. ask** (`src/lib/policy.ts`, plain code): book unasked only if confidence ≥ `auto_book_confidence` (starts at **0.85**), the price is ≤ the surprise limit, the calendar is free, and the budget allows it. Otherwise it asks, or drops events below 0.5. Feedback moves the bar: approvals and loved surprises lower it, declines and disliked surprises raise it (range 0.6–0.97). So the agent asks a lot at first and surprises more as it learns.

## Keys to set (Philipp)

| Env | Where |
|---|---|
| `NEON_AI_GATEWAY_BASE_URL`, `NEON_AI_GATEWAY_TOKEN` | Neon project → AI Gateway (`neon env pull`). `MODEL=neon/claude-sonnet-5` |
| `PUBLIC_URL` | Base URL for setup links and the Composio return trip (the Neon deploy URL, or the tunnel for dev) |
| `COMPOSIO_API_KEY` | platform.composio.dev → API key. Nothing else to configure: gmail, googlecalendar and outlook use Composio-managed auth |
| `TWILIO_*` | WhatsApp sandbox (below) |
| `EXA_API_KEY`, `KERNEL_API_KEY` | Search + browser tools |

Mail and calendar calls go through Composio's proxy (`src/lib/connections.ts`), so we call the Gmail/Calendar/Graph REST APIs directly and never hold OAuth tokens.

## Shared instance on Sojourner (for the team)

The app runs on Sojourner as systemd services, so it keeps running after anyone's session ends:

- `booking-agent`: `mastra dev` with hot reload. Edits to files on Sojourner go live within seconds.
- `booking-tunnel`: cloudflared quick tunnel to `:4111`. `npm run url` prints the public URL. Studio is at that URL; webhooks are at `/webhooks/whatsapp`, connect links at `/connect/*`.

```bash
npm run url                               # current public URL
npm run logs                              # follow app logs
sudo systemctl restart booking-agent      # after changing .env
```

Don't also run `npm run dev` by hand, because port 4111 is taken. `/dev/chat` needs the header `X-Dev-Token: $DEV_CHAT_TOKEN`.

⚠️ The quick-tunnel URL changes whenever `booking-tunnel` restarts (including reboots). If that happens, update `PUBLIC_URL`
in `.env`, the Twilio sandbox webhook, and the Google/Microsoft redirect URIs. To get a fixed URL instead, put a free ngrok
account's static domain in place: `ngrok config add-authtoken <token>`, then change the service's ExecStart to
`/usr/bin/ngrok http --url=<domain> 4111`.

## Run locally

```bash
npm install
cp .env.example .env          # fill in the keys below
npm run db:migrate            # app tables; Mastra creates its own mastra_* tables on boot
npm run dev                   # http://localhost:4111 (Studio + API)
```

Postgres is expected at `DATABASE_URL` (default `booking:booking@localhost:5432/booking_agent`, pgvector enabled).

Chat without WhatsApp:

```bash
curl localhost:4111/dev/chat -H 'content-type: application/json' \
  -d '{"phone":"+4915100000000","text":"Hi, I live in Berlin and love indie films"}'
```

## Hook up WhatsApp (Twilio sandbox, ~10 min)

1. `npm run tunnel` (ngrok with `NGROK_DOMAIN` if set, otherwise a throwaway cloudflared URL, which can't be used with OAuth) and put the URL in `.env` as `PUBLIC_URL`.
2. Twilio console → Messaging → Try it out → **Send a WhatsApp message**. From your phone, send the `join <code>` message to the sandbox number.
3. Sandbox settings → "When a message comes in": `<PUBLIC_URL>/webhooks/whatsapp`, method POST.
4. Put `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_WHATSAPP_FROM` in `.env`, set `TWILIO_SKIP_SIGNATURE=0`, and restart.

Without Twilio credentials, outgoing messages are only logged (`[whatsapp:dry-run]`).
Quick tunnel URLs change on every restart, so update `PUBLIC_URL` and the sandbox webhook each time.

## Credits (Stripe)

Users prepay credits in EUR and the agent pays tickets from them (`src/lib/credits.ts`). Everything is an
append-only row in `credit_ledger` (balance = sum) with a unique `ref`, so webhooks, retries and double clicks
can't credit or charge twice. Credits never go back to the card: a cancelled event is refunded as credits.

- **Top up:** `/wallet?t=<onboarding token>` (packs €10/25/50 or any €5–500) → Stripe Checkout → credits are added
  by the webhook `/webhooks/stripe` *and* by the success page, whichever comes first. In chat, the concierge sends
  a link with `top-up-link`.
- **Discount codes:** hardcoded in `PROMO_CODES` (`HACKATHON` = €20, once per user). Redeem on the wallet page or in
  chat (`redeem-code`).
- **Paying for a booking:** `holdCredits` reserves the amount before checkout → `captureHold(ref, realTotal)` once
  it's booked (the rest is freed) or `releaseHold` if it failed → `refundHold` if the event is cancelled later.
  `policy.decide` asks instead of auto-booking when credits don't cover the price.
- **Demo:** `POST /dev/credits` with `X-Dev-Token`, body `{"phone","action":"add|deduct|hold|capture|release|refund|redeem|status","amount":12.5,"ref":"Kino"}`.
  Stripe test card: 4242 4242 4242 4242, any future date, any CVC.

The Stripe webhook endpoint points at the current tunnel URL, so after a tunnel restart, update it in the Stripe
dashboard (or create a new one and put its secret in `STRIPE_WEBHOOK_SECRET`). Top-ups still work without it,
via the success page.

## Layout

```
db/schema.sql                    users, budgets, events, suggestions, bookings, ledger, inbound_emails
src/lib/db.ts                    pg pool, upsertUserByPhone, getBudgetStatus (limit − charges − open holds)
src/lib/whatsapp.ts              Twilio send (splits long messages), signature check
src/mastra/index.ts              Mastra instance: PostgresStore, routes
src/mastra/agents/concierge.ts   the chat agent; taste profile from Postgres injected into its prompt
src/mastra/tools/profile.ts      get-profile / update-profile (city, interests, budget rules)
src/mastra/routes/whatsapp.ts    POST /webhooks/whatsapp, POST /dev/chat
src/mastra/routes/onboarding.ts  setup page, /connect/:provider/start (Composio links), form submit → onboard-user workflow
src/mastra/workflows/onboard.ts  gather mail+calendar signals → analyst → taste profile → WhatsApp "ready"
src/mastra/agents/analyst.ts     taste analysis + short messages (no tools, no memory)
src/mastra/tools/taste.ts        check-availability, remember-about-user, log-feedback
src/lib/connections.ts           Composio: connect links, active accounts, authenticated proxy to Google/Graph APIs
src/lib/mail.ts, calendar.ts     Gmail/Graph mail signals; events, busy blocks, add-to-calendar
src/lib/taste.ts                 TasteProfile schema + storage
src/lib/policy.ts                decide(): book / ask / skip; recordFeedback() calibration
```

Identity: phone number → `users.id`. The memory thread is `wa:<phone>` and the resource is the user id, and the taste profile lives in `taste_profiles` (shared by the agent, the policy and later the UI).

## Next milestones

- **M2 Discover:** `searchEvents` (Exa), `inspectEvent` (Kernel + Stagehand `extract`), fill `events` / `suggestions`
- **M3 Free booking:** AgentMail inbox per user, `/webhooks/agentmail`, `bookEvent` workflow without payment
- **M4 Paid + budget:** ledger holds and charges, `suspend()` for approval, Stagehand `variables` for card details, `verifyTotal` before Pay
- **M5 UI:** one page with budget form, feed, and Kernel live-view iframe
- **M6 Proactive:** daily `discoverEvents` schedule, auto-book under `auto_approve_cents`
