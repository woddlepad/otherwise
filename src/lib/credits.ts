import type pg from 'pg';
import Stripe from 'stripe';
import { publicUrl } from './connections';
import { db } from './db';

/**
 * Prepaid credits in euro cents. Every change is a row in credit_ledger (balance = sum) with a unique
 * `ref`, so Stripe webhooks, retries and double clicks can't credit or charge twice. Credits never go
 * back to the card: a cancelled event is refunded as credits.
 *
 * Booking flow: holdCredits (reserve before checkout) → captureHold (real total, rest freed) or
 * releaseHold (checkout failed) → refundHold (event cancelled later).
 */

export const CURRENCY = 'EUR';
export const TOPUP_PACKS_CENTS = [1000, 2500, 5000];
export const MIN_TOPUP_CENTS = 500;
export const MAX_TOPUP_CENTS = 50000;

// Hardcoded for now: code → free credits, redeemable once per user.
const PROMO_CODES: Record<string, number> = {
  HACKATHON: 2000,
};

export type CreditKind = 'topup' | 'promo' | 'adjust' | 'spend' | 'refund';
export type Credits = { balanceCents: number; heldCents: number; availableCents: number };
export type Hold = {
  id: string;
  ref: string;
  amount_cents: number;
  captured_cents: number | null;
  status: 'open' | 'captured' | 'released';
};

export class CreditError extends Error {}

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

export async function getCredits(userId: string, q: Queryable = db): Promise<Credits> {
  const { rows } = await q.query(
    `SELECT (SELECT COALESCE(SUM(amount_cents), 0) FROM credit_ledger WHERE user_id = $1)::int AS balance,
            (SELECT COALESCE(SUM(amount_cents), 0) FROM credit_holds WHERE user_id = $1 AND status = 'open')::int AS held`,
    [userId],
  );
  const { balance, held } = rows[0];
  return { balanceCents: balance, heldCents: held, availableCents: balance - held };
}

export async function creditHistory(userId: string, limit = 20) {
  const { rows } = await db.query<{ kind: CreditKind; amount_cents: number; note: string | null; created_at: Date }>(
    `SELECT kind, amount_cents, note, created_at FROM credit_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

/** One transaction per user at a time (row lock on users), so balance checks can't race. */
async function withUserLock<T>(userId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Inserts a ledger row; false if `ref` was already used (nothing changes then). */
async function insertEntry(
  q: Queryable,
  userId: string,
  e: { kind: CreditKind; amountCents: number; ref: string; note?: string; bookingId?: string | null; meta?: object },
): Promise<boolean> {
  const { rowCount } = await q.query(
    `INSERT INTO credit_ledger (user_id, kind, amount_cents, ref, note, booking_id, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (ref) DO NOTHING`,
    [userId, e.kind, e.amountCents, e.ref, e.note ?? null, e.bookingId ?? null, JSON.stringify(e.meta ?? {})],
  );
  return rowCount === 1;
}

/** Manual correction (support, demo). Negative amounts can't take available credits below zero. */
export async function adjustCredits(userId: string, amountCents: number, ref: string, note?: string) {
  if (!Number.isInteger(amountCents) || amountCents === 0) throw new CreditError('amount must be a non-zero number of cents');
  return withUserLock(userId, async client => {
    if (amountCents < 0 && (await getCredits(userId, client)).availableCents + amountCents < 0) {
      throw new CreditError('not enough credits');
    }
    const added = await insertEntry(client, userId, { kind: 'adjust', amountCents, ref, note });
    return { added, credits: await getCredits(userId, client) };
  });
}

export async function redeemCode(userId: string, rawCode: string) {
  const code = rawCode.trim().toUpperCase();
  const amountCents = PROMO_CODES[code];
  if (!amountCents) return { ok: false as const, reason: 'unknown code' };
  const added = await insertEntry(db, userId, { kind: 'promo', amountCents, ref: `promo:${code}:${userId}`, note: `Code ${code}` });
  if (!added) return { ok: false as const, reason: 'code already used' };
  return { ok: true as const, amountCents, credits: await getCredits(userId) };
}

/** Reserves credits before the agent pays. Same `ref` again returns the existing hold. */
export async function holdCredits(
  userId: string,
  h: { ref: string; amountCents: number; bookingId?: string; note?: string },
): Promise<Hold> {
  if (!Number.isInteger(h.amountCents) || h.amountCents <= 0) throw new CreditError('hold amount must be positive cents');
  return withUserLock(userId, async client => {
    const existing = await client.query<Hold>(`SELECT * FROM credit_holds WHERE ref = $1`, [h.ref]);
    if (existing.rows[0]) return existing.rows[0];
    const { availableCents } = await getCredits(userId, client);
    if (availableCents < h.amountCents) {
      throw new CreditError(`not enough credits: ${availableCents / 100} available, ${h.amountCents / 100} needed`);
    }
    const { rows } = await client.query<Hold>(
      `INSERT INTO credit_holds (user_id, ref, amount_cents, booking_id, note) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [userId, h.ref, h.amountCents, h.bookingId ?? null, h.note ?? null],
    );
    return rows[0];
  });
}

async function lockHold(client: pg.PoolClient, ref: string) {
  const { rows } = await client.query<Hold & { user_id: string; booking_id: string | null; note: string | null }>(
    `SELECT * FROM credit_holds WHERE ref = $1 FOR UPDATE`,
    [ref],
  );
  if (!rows[0]) throw new CreditError(`no hold ${ref}`);
  return rows[0];
}

/** Charges the real total (≤ the hold) once the booking is confirmed; the rest becomes available again. */
export async function captureHold(ref: string, totalCents: number) {
  const { rows } = await db.query(`SELECT user_id FROM credit_holds WHERE ref = $1`, [ref]);
  if (!rows[0]) throw new CreditError(`no hold ${ref}`);
  return withUserLock(rows[0].user_id, async client => {
    const hold = await lockHold(client, ref);
    if (hold.status === 'captured') return hold;
    if (hold.status !== 'open') throw new CreditError(`hold ${ref} is ${hold.status}`);
    if (!Number.isInteger(totalCents) || totalCents <= 0 || totalCents > hold.amount_cents) {
      throw new CreditError(`total must be between 0.01 and the held ${hold.amount_cents / 100}`);
    }
    await insertEntry(client, hold.user_id, {
      kind: 'spend',
      amountCents: -totalCents,
      ref: `spend:${ref}`,
      bookingId: hold.booking_id,
      note: hold.note ?? undefined,
    });
    const updated = await client.query<Hold>(
      `UPDATE credit_holds SET status = 'captured', captured_cents = $2, settled_at = now() WHERE ref = $1 RETURNING *`,
      [ref, totalCents],
    );
    return updated.rows[0];
  });
}

export async function releaseHold(ref: string) {
  const { rows } = await db.query<Hold>(
    `UPDATE credit_holds SET status = 'released', settled_at = now() WHERE ref = $1 AND status = 'open' RETURNING *`,
    [ref],
  );
  if (rows[0]) return rows[0];
  const current = await db.query<Hold>(`SELECT * FROM credit_holds WHERE ref = $1`, [ref]);
  if (current.rows[0]?.status === 'released') return current.rows[0];
  throw new CreditError(current.rows[0] ? `hold ${ref} is ${current.rows[0].status}` : `no hold ${ref}`);
}

/** Event cancelled: the captured amount goes back as credits (never to the card). Once per hold. */
export async function refundHold(ref: string, reason = 'Event cancelled') {
  const { rows } = await db.query<Hold & { user_id: string; booking_id: string | null }>(
    `SELECT * FROM credit_holds WHERE ref = $1`,
    [ref],
  );
  const hold = rows[0];
  if (!hold || hold.status !== 'captured' || !hold.captured_cents) throw new CreditError(`nothing to refund for ${ref}`);
  const added = await insertEntry(db, hold.user_id, {
    kind: 'refund',
    amountCents: hold.captured_cents,
    ref: `refund:${ref}`,
    bookingId: hold.booking_id,
    note: reason,
  });
  return { added, amountCents: hold.captured_cents, credits: await getCredits(hold.user_id) };
}

// ---------- Stripe top-ups ----------

let stripeClient: Stripe | undefined;
export function stripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
  return (stripeClient ??= new Stripe(process.env.STRIPE_SECRET_KEY));
}

export function walletUrl(token: string) {
  return publicUrl(`/wallet?t=${encodeURIComponent(token)}`);
}

/** Hosted Stripe Checkout page for a one-off top-up. Credits are added by fulfillCheckout. */
export async function createTopUpCheckout(userId: string, amountCents: number): Promise<string> {
  if (!Number.isInteger(amountCents) || amountCents < MIN_TOPUP_CENTS || amountCents > MAX_TOPUP_CENTS) {
    throw new CreditError(`top-ups are between ${MIN_TOPUP_CENTS / 100} and ${MAX_TOPUP_CENTS / 100} ${CURRENCY}`);
  }
  const { rows } = await db.query(`SELECT phone, name, stripe_customer_id, onboarding_token FROM users WHERE id = $1`, [userId]);
  const user = rows[0];
  if (!user) throw new CreditError('unknown user');

  let customer: string = user.stripe_customer_id;
  if (!customer) {
    customer = (
      await stripe().customers.create({ phone: user.phone, name: user.name ?? undefined, metadata: { user_id: userId } })
    ).id;
    await db.query(`UPDATE users SET stripe_customer_id = $2 WHERE id = $1`, [userId, customer]);
  }

  const back = user.onboarding_token ? walletUrl(user.onboarding_token) : publicUrl('/');
  // origin: dev (tunnel) and Neon share one Stripe account, and every webhook endpoint gets every event.
  const metadata = { user_id: userId, credits_cents: String(amountCents), origin: publicUrl() };
  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    customer,
    client_reference_id: userId,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: CURRENCY.toLowerCase(),
          unit_amount: amountCents,
          product_data: { name: `€${amountCents / 100} booking credits` },
        },
      },
    ],
    metadata,
    payment_intent_data: { metadata },
    success_url: publicUrl(`/billing/success?session_id={CHECKOUT_SESSION_ID}`),
    cancel_url: back,
  });
  return session.url!;
}

/**
 * Adds the credits for a paid Checkout Session. Called by the webhook and by the success page, so it
 * works even when the webhook can't reach us; the session id as `ref` makes the second call a no-op.
 */
export async function fulfillCheckout(sessionId: string) {
  const session = await stripe().checkout.sessions.retrieve(sessionId);
  const userId = session.metadata?.user_id;
  const amountCents = Number(session.metadata?.credits_cents);
  if (!userId || !amountCents) return { status: 'not-a-topup' as const, userId };
  if (session.metadata?.origin && session.metadata.origin !== publicUrl()) return { status: 'other-instance' as const, userId };
  // Sessions created before `origin` existed: unknown user means it's the other instance's.
  if (!(await db.query(`SELECT 1 FROM users WHERE id = $1`, [userId])).rowCount) return { status: 'other-instance' as const, userId };
  if (session.payment_status !== 'paid') return { status: 'unpaid' as const, userId };
  const added = await insertEntry(db, userId, {
    kind: 'topup',
    amountCents,
    ref: `stripe:${session.id}`,
    note: 'Card top-up',
    meta: { payment_intent: session.payment_intent, amount_total: session.amount_total, currency: session.currency },
  });
  return { status: added ? ('credited' as const) : ('already-credited' as const), userId, amountCents };
}
