# Agent inboxes (AgentMail)

The concierge signs users up for events. For signups where it is safe, it uses its own email inbox for that user
(AgentMail, one inbox per user), reads verification mails itself, and sends the confirmation details to the user on
WhatsApp. Nothing is forwarded to the user's own inbox.

## Flow

1. **Which address?** `chooseSignupEmail` (`src/lib/policy.ts`) decides this in code. The LLM only reports what the
   form says. The agent inbox is used only when the signup is **free**, the ticket is **not tied to a name or ID**, and
   **no existing login** is needed. Everything else gets the user's real email: paid tickets, unknown price, unknown
   name-binding or login, the stored preference `users.signup_email_pref = 'always_user'`, or an inbox that can't be
   created (for example because the plan limit is reached). If no user email is on file, `email` is null and the
   concierge asks for it.
2. **Concierge tools** (`src/mastra/tools/email.ts`):
   - `signup-email` is called before any form that asks for an email. It applies the policy, creates the inbox lazily
     (`ensureInbox`), records a pending signup (`email_signups`: user, event id and URL, site domain, address, kind)
     and returns the address to type.
   - `wait-for-email` waits during a signup for a code or "verify your email" link (`waitForEmail` polls the API).
   - `set-signup-email-preference` turns "always use my email" on or off. `update-profile` can now also save `email`.
3. **Inbound mail** goes through `handleInboundEmail(message)` (`src/lib/email-inbound.ts`). Both webhook and WebSocket
   deliveries end up here. It:
   - ignores inboxes this environment didn't create;
   - dedupes by `message_id` (webhook retries, webhook plus WebSocket overlap). A delivery whose processing died is
     picked up again after 2 minutes;
   - stores the mail in `agent_emails`;
   - classifies it with the scout model as `verification | confirmation | marketing | other`, matches it to a pending
     signup (the LLM's pick from the candidates, else the single candidate whose site sent it or is linked), and
     extracts the details. Links are chosen by number from the links actually in the mail, so the LLM can't invent a URL;
   - for a **confirmation**: marks the signup confirmed, gives each ticket attachment (PDF, wallet pass or image) an
     unguessable `/tickets/:token` URL, fills `bookings.ticket_url` if a booking row exists, and sends one WhatsApp:
     event, date and time, venue, order number, ticket link or file, manage and cancel link. A second confirmation
     for the same signup (a resend) is stored but not pushed again;
   - **verification** and **marketing/other** mails are stored only. `waitForEmail` reads verification mails and skips
     mails already classified as confirmation or marketing.
4. **Read side for booking.** `getConfirmation(userId, eventId)` returns the latest confirmation with
   `source: 'confirmation_email'`: order ref, ticket URL, manage URL, cancel URL and attachment URLs. This is the
   manage/cancel link the BookingHandoff 1.1 contract asks for. Over HTTP it is
   `GET /events/:eventId/confirmation?userId=…|phone=…`, which uses the same `X-Dev-Token` auth as the handoff route.

### For the future book-event workflow (mock-booking)

Call the plain functions directly. No tools are needed:

```ts
const choice = await chooseSignupEmail({ facts: { free, nameBound, loginRequired }, pref, userEmail,
  agentEmail: async () => (await ensureInbox(userId)).email });
const signup = await recordSignup(userId, { eventId, url: bookingUrl, email: choice.email!, kind: choice.kind, reason: choice.reason });
// ...fill the checkout with choice.email; if the site sends a code:
const mail = await waitForEmail(userId, { since: signup.createdAt, fromDomain: 'eventbrite.com', timeoutMs: 120_000 });
// mail.codes / mail.verificationLinks
// later (after the inbound pipeline processed the confirmation):
const conf = await getConfirmation(userId, eventId);  // conf.manageUrl, conf.cancelUrl, conf.orderRef
```

## Environments and isolation

Worktree databases are forks of production, so a copied `users.agentmail_inbox_id` may belong to production. Every inbox
is tagged with the environment that created it:

- `AGENTMAIL_ENV`: `prod` on Neon Functions (set in `neon.ts`), `wt-<WORKTREE_NAME>` in a worktree, `dev` otherwise.
- The inbox gets `client_id = <env>.user-<userId>` (idempotent create; AgentMail allows only `[A-Za-z0-9._~-]`), and
  `metadata.env`. `users.agentmail_env` stores the env as well.
- `ensureInbox` reuses a stored inbox only if its env matches the current one. Otherwise it creates the environment's
  own inbox and overwrites the columns, which only touches that environment's database.
- `handleInboundEmail` only processes inboxes where `agentmail_env` matches the current environment. The prod webhook
  therefore ignores worktree inboxes, and a worktree never processes prod mail.

## Inbound delivery: webhook vs WebSocket

`AGENTMAIL_INBOUND=webhook|websocket` (default: `webhook` when `AGENTMAIL_ENV=prod`, else `websocket`).

- **websocket** (dev and worktrees): no public URL is needed, and no prod forwarding. `startAgentMailInbound()` runs at
  server start (`src/mastra/index.ts`). It subscribes to this environment's inboxes (`message.received` only). It never
  subscribes with an empty list, because that would mean the whole organisation, including prod. When `ensureInbox`
  creates an inbox, it is added to the subscription. The SDK reconnects with backoff and re-sends subscriptions. On
  every (re)open the subscriber also resubscribes and catches up: it lists recent messages of inboxes that had a
  signup in the last 14 days and processes the unseen ones. The subscriber is a singleton across hot reloads.
- **webhook** (production): `POST /webhooks/agentmail`. It verifies the Svix signature (`svix-id`, `svix-timestamp`,
  `svix-signature`, HMAC-SHA256 with `AGENTMAIL_WEBHOOK_SECRET`, 5 min tolerance) and answers 400 on any mismatch. It
  answers 200 right away and processes in `waitUntil`. Events other than `message.received` are acknowledged and
  ignored.

## Env vars

| Var | Where | Meaning |
| --- | --- | --- |
| `AGENTMAIL_API_KEY` | all | API key (already in the passthrough) |
| `AGENTMAIL_WEBHOOK_SECRET` | prod (passthrough) | `whsec_…` signing secret of the prod webhook |
| `AGENTMAIL_ENV` | optional | override the environment tag (`prod` is set by `neon.ts`) |
| `AGENTMAIL_INBOUND` | optional | `webhook` or `websocket` (`webhook` is set by `neon.ts`) |
| `AGENTMAIL_DOMAIN` | optional (passthrough) | custom inbox domain instead of `agentmail.to` |
| `PUBLIC_URL` | all | base for `/tickets/:token` links in WhatsApp |

## One-time production setup (not done yet; do it from the main checkout when deploying)

1. Deploy as usual. `neon.ts` sets `AGENTMAIL_ENV=prod` and `AGENTMAIL_INBOUND=webhook`.
2. Create **one** organisation webhook pointing at production. Don't use `inbox_ids`, which is capped at 10 per
   webhook; prod ignores inboxes it doesn't own anyway:
   ```bash
   curl -X POST https://api.agentmail.to/v0/webhooks -H "Authorization: Bearer $AGENTMAIL_API_KEY" \
     -H 'Content-Type: application/json' \
     -d '{"url":"https://<prod host>/webhooks/agentmail","event_types":["message.received"],"client_id":"prod-inbound"}'
   ```
   The response has `secret` (`whsec_…`).
3. Put that secret in `.env.neon` as `AGENTMAIL_WEBHOOK_SECRET` and redeploy (`npm run deploy:neon`).
4. Check it: sign up a test user for a free event (or send a mail to their inbox). The log shows
   `[agentmail] inbound { source: 'webhook', … }`.

Dev worktrees must **not** create webhooks. They use the WebSocket.

## Limits seen on the current AgentMail account (free plan)

- **3 inboxes** in total (`otherwise@agentmail.to` uses one). One inbox per user needs a paid plan before real users.
  When creation fails, the policy falls back to the user's email and says why.
- 100 sends/day. Each organisation may send **5 spam-flagged messages per day**: test mails with codes or
  "confirm your email" wording sent from `otherwise@` got flagged quickly. This only matters for tests; real ticket
  shops send *to* us.
- `/dev/reset-user` deletes the test user's inbox (only if this environment created it), so tests don't leak inbox slots.
