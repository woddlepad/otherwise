# AGENTS.md

## Sharing work: always give a remote URL

The team works remotely and can't open `localhost` or files on this machine. Whenever you show HTML, a design,
or the running app, give a public URL that works from anywhere, check that it loads from outside (`curl` the public
URL, not localhost), and put it in your reply. Screenshots are welcome on top of that, but they don't replace the link.

- **The app** (Mastra on port 4111): `npm run tunnel` (Cloudflare quick tunnel, or ngrok if `NGROK_DOMAIN` is set).
  Check first with `pgrep -af cloudflared`: one may already be running for 4111, so reuse its URL.
- **Static HTML** (for example `design/`): serve the folder on its own port and tunnel that port. Leave the app's tunnel alone.

  ```bash
  cd design && nohup python3 -m http.server 8090 --bind 127.0.0.1 > /tmp/design-server.log 2>&1 &
  nohup cloudflared tunnel --no-autoupdate --url http://localhost:8090 > /tmp/design-tunnel.log 2>&1 &
  grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /tmp/design-tunnel.log | head -1
  ```

Quick tunnel URLs change every time cloudflared restarts, so post the new URL whenever you restart one.
