import { createHmac, timingSafeEqual } from 'node:crypto';
import { db } from './db';

// Production receives every sandbox message (one webhook per Twilio account). A phone routed to a dev
// worktree in `dev_routes` gets its raw webhook body forwarded there, signed with DEV_FORWARD_SECRET,
// and the worktree replies through the Twilio REST API itself.

const MAX_SKEW_MS = 5 * 60_000;

export type DevRoute = { worktree: string; targetUrl: string };

/** Only production routes (WHATSAPP_ROUTER=1); a lookup failure must never break the prod webhook. */
export async function findDevRoute(phone: string): Promise<DevRoute | null> {
  if (process.env.WHATSAPP_ROUTER !== '1' || !process.env.DEV_FORWARD_SECRET) return null;
  try {
    const { rows } = await db.query<DevRoute>(
      `SELECT worktree, target_url AS "targetUrl" FROM dev_routes WHERE phone = $1 AND expires_at > now()`,
      [phone],
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

function sign(ts: string, body: string) {
  return createHmac('sha256', process.env.DEV_FORWARD_SECRET!).update(`${ts}.${body}`).digest('hex');
}

/** Throws unless the worktree accepted the forwarded webhook. */
export async function forwardToDev(route: DevRoute, rawBody: string) {
  const ts = String(Date.now());
  const res = await fetch(`${route.targetUrl.replace(/\/$/, '')}/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Dev-Forward': `${ts}.${sign(ts, rawBody)}` },
    body: rawBody,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`worktree ${route.worktree} answered ${res.status}`);
}

/** In a worktree: is this request a fresh forward from production? */
export function verifyDevForward(header: string | undefined, rawBody: string) {
  if (!header || !process.env.DEV_FORWARD_SECRET) return false;
  const [ts, mac] = header.split('.');
  if (!ts || !mac || Math.abs(Date.now() - Number(ts)) > MAX_SKEW_MS) return false;
  const expected = Buffer.from(sign(ts, rawBody), 'hex');
  const given = Buffer.from(mac, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
