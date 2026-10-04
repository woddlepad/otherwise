# Booking flow

How the concierge books tickets, and how to test it against the mock shop. Code: `src/mastra/workflows/book.ts`,
`src/lib/booking/*`, `src/mastra/tools/booking.ts`, mock shop `src/lib/mockshop.ts` + `src/mastra/routes/mockshop.ts`.

## Flow

The concierge never books with its browser tools. `book-event` (eventId from find-events or the pick number, qty,
showtime) creates the `bookings` row and starts the `book-event` workflow in the background; the workflow talks to the
user on WhatsApp itself and writes those messages into the concierge thread, so a "yes" or "done" lands with context.
Money rules are code (`approveBooking` in `src/lib/policy.ts`), never the LLM.

1. **approve**: free → go. Estimate (`priceMinCents × qty`) ≤ auto-approve (and within monthly budget and per-event cap)
   → go. Not enough credits → message with the wallet link, booking `failed`. Otherwise WhatsApp "Shall I book it?" and
   suspend (`awaiting_approval`). No price known → go; the checkout total is approved in step 4.
2. **hold**: `holdCredits` for the estimate, ref `booking:<runId>` (a new ref per attempt).
3. **checkout**: an LLM sub-agent (`BOOKING_MODEL`, default Sonnet 5) clicks through the site in the user's Kernel
   browser with restricted tools: snapshot, open, click, fill, select, report. No free-form Playwright; clicks on pay
   buttons (or any submit button of a form with card fields) are refused inside the page; card and password fields
   can't be filled. It stops at the payment page and reports the total as shown and the refs of the card fields and pay
   button. Free events: it completes the reservation. Login / captcha / anything only the user can do → `needs_human`:
   WhatsApp the Kernel live-view link and suspend until the user says "done", then the agent continues from the page.
4. **verify-total**: code re-reads the page: fields and pay button exist where reported, the total text is on the page
   (and matches the amount on the pay button), EUR, right qty. Total ≤ held → go. Higher but within auto-approve →
   `resizeHold`. Otherwise WhatsApp the new total and suspend for re-approval (`awaiting_approval`).
5. **pay**: code types `BOOKING_CARD_*` into the verified fields with Playwright, then clicks pay (two Kernel calls:
   a failure before the click releases the hold, one from the click on keeps it, because the shop may have charged).
   `pay_attempted_at` makes sure a card is never submitted twice for one attempt. A small LLM reads the (redacted)
   result page: confirmed / declined / unclear.
6. **settle**: `captureHold` for the real total (rest freed), booking `booked` with total, order number and ticket
   link, browser closed, WhatsApp confirmation.

Any failure: booking `failed` with `error`, hold released (unless a payment may have happened), browser closed,
user told. "No" or "cancel" while waiting: `cancelled`, hold released. Refunds only ever go to credits.

The card number never reaches the LLM: it is only read in `fillCardAndPay`, everything read back from the browser
goes through `redact()`, and nothing card-related is in step inputs/outputs (workflow snapshots) or logs.

## States

`bookings.status`: `pending → awaiting_approval ⇄ booking ⇄ needs_human → booked | failed | cancelled`.
`suspended_step` says which step waits (`approve`, `checkout`, `verify-total`); `confirm-booking` / `cancel-booking`
claim the row atomically, then resume that step (`{approved}` or `{done}`). The idempotency key is
user + event + showtime: asking again returns the running/booked booking, a failed/cancelled one starts over.
The concierge prompt lists open bookings so "yes" / "done" go to the right one.

## Env

| Var | |
| --- | --- |
| `BOOKING_CARD_NUMBER`, `BOOKING_CARD_EXP` (MM/YY), `BOOKING_CARD_CVC`, `BOOKING_CARD_NAME` | card the workflow pays with; paid bookings fail without it |
| `BOOKING_CONTACT_EMAIL` | attendee email when the user has none (default `tickets@concierge.example`) |
| `BOOKING_MODEL` | checkout sub-agent and confirmation reader (default `DISCOVERY_MODEL`, then `neon/claude-sonnet-5`) |
| `MOCK_SHOP=1` | serve Ticketeria at `/mock/shop` and add its events to discovery for Berlin users; off by default (404) |
| `MOCK_SHOP_CARD` | card number the mock shop accepts (default `BOOKING_CARD_NUMBER`) |

## Mock shop (Ticketeria)

Weekly Berlin events (next date always within 7 days, stable across midnight), each a variant:
`paid` (Quiet Hours Trio €14, Sonnenallee Big Band €26, Cities After Cars €8), `fees-at-checkout` (Nocturne for a
Small City, €17.50 + €3.90 fee per ticket shown only on the payment page, two showtimes), `login-required`
(The Salt Year preview €9: any email + password `demo`; sign-ups are "paused"), `free-rsvp` (Indie Film Club shorts).
Events → event page (showtime, ticket type, qty) → [login] → checkout (name, email, terms) → payment → order page
→ ticket page with a fake QR. Every step is a real form POST + redirect; the cart is a signed token in the URL.
Only the configured card is accepted, anything else is declined (402). Orders: table `mock_orders`.

## E2E test (worktree)

1. In the worktree `.env`: `MOCK_SHOP=1` and the `BOOKING_CARD_*` test values; `npm run db:migrate`;
   `systemctl --user restart wt-<name>-app`. Kernel browsers reach the shop only via `PUBLIC_URL` (the tunnel).
2. With the worktrees plugin tools on a `+1555…` phone: `chat_reset`, `chat_onboard` (Berlin, jazz + indie film,
   monthly 100, auto-approve 20, timezone Europe/Berlin), `chat_send "HACKATHON"` (€20). More credits:
   `POST /dev/credits {"phone":…,"action":"add","amount":60}` with `X-Dev-Token`.
3. `chat_send "anything jazz this week?"` (fresh searches take ~2 min) → Ticketeria events among the picks.
4. Book: Quiet Hours Trio (booked unasked) · Big Band (approval → "yes") · Nocturne 21:00 (re-approval at €21.40 →
   "yes") · The Salt Year (live-view link → sign in as the human, e.g. via Kernel `playwright.execute` on browser
   `user-<userId>` → "done") · shorts night (free, no charge).
5. Check with `chat_bookings` (bookings, holds, ledger), `mock_orders`, `chat_messages`; grep `.atmos/app.log`,
   `outbound_messages`, `mastra_messages` and `mastra_workflow_snapshot` for the card number (must be 0 hits).

## Open

- Real sites: attendee email fallback, 3-D Secure / wallet pages, iframes for card fields (Stripe Elements) aren't handled.
- An "unclear" payment keeps its hold open and the booking `failed`; nothing reconciles it yet.
- Cancelling booked tickets (and refunds to credits) isn't wired to the concierge.
- A booking waiting for approval keeps no hold; one waiting for re-approval or "done" keeps its hold and the Kernel
  browser (15 min idle timeout) — after that the pay step fails safely ("left the payment page") and the user can ask again.
