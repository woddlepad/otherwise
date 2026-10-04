---
name: worktrees
description: Use when someone wants a separate dev copy of the booking agent (a git worktree with its own Neon branch, port, tunnel and WhatsApp phone route), or wants to list, start, stop, remove one or change its phone.
---

# Booking-agent worktrees

The server runs on Sojourner and manages worktrees under `/home/atmos/booking-agent-worktrees/<name>`, each on git branch `wt/<name>`:

- `create_worktree` adds the worktree, branches the `production` Neon database to `wt/<name>` (expires after 14 days), writes `.env` from the main checkout with that `DATABASE_URL`, a free `PORT` from 4112, `PUBLIC_URL` and the phone allowlist, hard-links `node_modules`, runs `db:migrate`, then starts the tunnel and `mastra dev` as user units `wt-<name>-tunnel` / `wt-<name>-app`. Logs: `<worktree>/.atmos/{app,tunnel}.log`.
- `set_worktree_phone` routes one WhatsApp number to the worktree: production's webhook forwards that number's inbound messages to the worktree's tunnel (table `dev_routes` in the prod DB, 12h, renewed by `start_worktree`). The worktree may only message numbers in `WHATSAPP_ALLOWLIST` (just that phone; empty means none), because its database is a copy of real users.
- `stop_worktree` drops the route, so the phone goes back to production. `remove_worktree` also deletes the Neon branch and folder but keeps the git branch; it refuses with uncommitted changes unless `force`.
- `list_worktrees` / `open_worktrees` show state: app running/starting/stopped/failed, public URL, route status, git changes and commits ahead of main.

Quick tunnel URLs change on every start; tell people the new URL. Deploy production only from the main checkout.

## Chatting with a worktree's agent

Test a worktree like a WhatsApp user, without a phone. Use `+1555…` numbers (e.g. `+15550100001`): they are never in a worktree's allowlist, so nothing goes to Twilio or a real person.

- `chat_send` posts a Twilio-shaped message to the worktree's real `/webhooks/whatsapp`, signed with its `DEV_FORWARD_SECRET` exactly as production forwards one, then reads the replies from the app's outbox (`outbound_messages`, written by `sendWhatsApp` for every message, via `GET /dev/outbox`). It returns once replies stop for `quietSeconds`; event searches can take 2–3 minutes, so raise `timeoutSeconds` or read late replies with `chat_messages`.
- `chat_onboard` runs the real signup: first message → setup link → the real setup form (`POST /onboard/complete`) with city, interests and budget, skipping the optional mail/calendar connect → the `onboard-user` workflow's "Ready to go" message. It names the step that failed.
- `chat_messages` lists what the app sent a phone (proactive picks, booking updates, late replies).
- `chat_reset` deletes the phone's user, outbox and chat memory (`POST /dev/reset-user`) so the next message starts from scratch. It refuses numbers outside `+1555` unless `force`: worktree databases hold copies of real users.

The worktree must be running (`start_worktree`) and have the chat dev routes; they 404 under `NODE_ENV=production`.
