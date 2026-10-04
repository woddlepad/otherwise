import { randomBytes } from 'node:crypto';
import { registerApiRoute } from '@mastra/core/server';
import {
  CreditError,
  MAX_TOPUP_CENTS,
  MIN_TOPUP_CENTS,
  TOPUP_PACKS_CENTS,
  adjustCredits,
  captureHold,
  createTopUpCheckout,
  creditHistory,
  fulfillCheckout,
  getCredits,
  holdCredits,
  redeemCode,
  refundHold,
  releaseHold,
  stripe,
  walletUrl,
} from '../../lib/credits';
import { db, upsertUserByPhone } from '../../lib/db';
import { sendWhatsApp } from '../../lib/whatsapp';
import { renderExpired } from '../../ui/onboard';
import { messagePage } from '../../ui/shell';
import { eur, renderWallet } from '../../ui/wallet';

const KIND_LABEL: Record<string, string> = {
  topup: 'Top-up',
  promo: 'Discount code',
  adjust: 'Adjustment',
  spend: 'Booking',
  refund: 'Refund',
};

async function userByToken(token: string | undefined) {
  if (!token) return null;
  const { rows } = await db.query<{ id: string; name: string | null; onboarding_status: string }>(
    `SELECT id, name, onboarding_status FROM users WHERE onboarding_token = $1`,
    [token],
  );
  return rows[0] ?? null;
}

async function notifyCredited(userId: string, text: string) {
  const { rows } = await db.query(`SELECT phone FROM users WHERE id = $1`, [userId]);
  const { availableCents } = await getCredits(userId);
  await sendWhatsApp(rows[0].phone, `${text} You now have ${eur(availableCents)} in credits.`).catch(() => {});
}

/** Shared by the success page and the webhook; only the call that actually credits sends the WhatsApp. */
async function fulfillAndNotify(sessionId: string) {
  const r = await fulfillCheckout(sessionId);
  if (r.status === 'credited') await notifyCredited(r.userId!, `💳 ${eur(r.amountCents)} added, thanks!`);
  return r;
}

export const walletPage = registerApiRoute('/wallet', {
  method: 'GET',
  requiresAuth: false,
  handler: async c => {
    const token = c.req.query('t');
    const user = await userByToken(token);
    if (!user) return c.html(renderExpired(), 404);
    const credits = await getCredits(user.id);
    const history = await creditHistory(user.id);
    return c.html(
      renderWallet({
        token: token!,
        ready: user.onboarding_status === 'ready',
        availableCents: credits.availableCents,
        heldCents: credits.heldCents,
        packsCents: TOPUP_PACKS_CENTS,
        minTopUpCents: MIN_TOPUP_CENTS,
        maxTopUpCents: MAX_TOPUP_CENTS,
        msg: c.req.query('msg'),
        ok: c.req.query('ok') === '1',
        history: history.map(h => ({ label: KIND_LABEL[h.kind] ?? h.kind, note: h.note, amountCents: h.amount_cents, at: h.created_at })),
      }),
    );
  },
});

export const billingCheckout = registerApiRoute('/billing/checkout', {
  method: 'POST',
  requiresAuth: false,
  handler: async c => {
    const form = await c.req.parseBody();
    const token = String(form.t ?? '');
    const user = await userByToken(token);
    if (!user) return c.text('bad request', 400);
    try {
      return c.redirect(await createTopUpCheckout(user.id, Math.round(Number(form.amount) * 100)), 303);
    } catch (err) {
      c.get('mastra').getLogger().error('stripe checkout failed', { userId: user.id, err: String(err) });
      const msg = err instanceof CreditError ? err.message : 'Could not start the payment, try again?';
      return c.redirect(`/wallet?t=${encodeURIComponent(token)}&msg=${encodeURIComponent(msg)}`, 303);
    }
  },
});

export const billingSuccess = registerApiRoute('/billing/success', {
  method: 'GET',
  requiresAuth: false,
  handler: async c => {
    const sessionId = c.req.query('session_id');
    if (!sessionId?.startsWith('cs_')) return c.text('bad request', 400);
    const r = await fulfillAndNotify(sessionId);
    if (r.status === 'other-instance') return c.text('this payment belongs to another instance', 404);
    const { rows } = await db.query(`SELECT onboarding_token FROM users WHERE id = $1`, [r.userId]);
    const token = rows[0]?.onboarding_token;
    if (!token) return c.html(messagePage({ title: 'Thanks, Otherwise', heading: 'Thanks.', text: '<p>Your credits are on their way. You can close this tab.</p>' }));
    const msg = r.status === 'unpaid' ? 'Payment is still processing, your credits appear once it clears.' : 'Payment received, credits added ✓';
    return c.redirect(`/wallet?t=${encodeURIComponent(token)}&ok=${r.status === 'unpaid' ? 0 : 1}&msg=${encodeURIComponent(msg)}`, 303);
  },
});

export const billingRedeem = registerApiRoute('/billing/redeem', {
  method: 'POST',
  requiresAuth: false,
  handler: async c => {
    const form = await c.req.parseBody();
    const token = String(form.t ?? '');
    const user = await userByToken(token);
    if (!user) return c.text('bad request', 400);
    const r = await redeemCode(user.id, String(form.code ?? ''));
    const msg = r.ok ? `${eur(r.amountCents)} added 🎁` : r.reason === 'code already used' ? 'You already used that code.' : 'That code doesn\'t exist.';
    return c.redirect(`/wallet?t=${encodeURIComponent(token)}&ok=${r.ok ? 1 : 0}&msg=${encodeURIComponent(msg)}`, 303);
  },
});

/** Stripe → us. Needs the raw body for the signature, so nothing may parse it first. */
export const stripeWebhook = registerApiRoute('/webhooks/stripe', {
  method: 'POST',
  requiresAuth: false,
  handler: async c => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return c.text('webhook secret not configured', 503);
    let event;
    try {
      event = await stripe().webhooks.constructEventAsync(await c.req.text(), c.req.header('stripe-signature') ?? '', secret);
    } catch {
      return c.text('invalid signature', 400);
    }
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const r = await fulfillAndNotify(event.data.object.id);
      c.get('mastra').getLogger().info('stripe checkout', { session: event.data.object.id, ...r });
    }
    return c.json({ received: true });
  },
});

/**
 * Demo/testing: POST {"phone":"+49…","action":"add|deduct|hold|capture|release|refund|redeem|status","amount":12.5,"ref":"…","code":"…"}
 * with X-Dev-Token. hold/capture/release/refund share a `ref` (defaults to "demo"), like a booking would.
 */
export const devCredits = registerApiRoute('/dev/credits', {
  method: 'POST',
  requiresAuth: false,
  handler: async c => {
    if (process.env.NODE_ENV === 'production') return c.text('not found', 404);
    if (process.env.DEV_CHAT_TOKEN && c.req.header('X-Dev-Token') !== process.env.DEV_CHAT_TOKEN) {
      return c.text('missing or wrong X-Dev-Token', 401);
    }
    const body = await c.req.json<{ phone: string; action: string; amount?: number; ref?: string; code?: string }>();
    const user = await upsertUserByPhone(body.phone);
    let token = user.onboarding_token;
    if (!token) {
      token = randomBytes(24).toString('base64url');
      await db.query(`UPDATE users SET onboarding_token = $2 WHERE id = $1`, [user.id, token]);
    }
    const cents = Math.round((body.amount ?? 0) * 100);
    const ref = `${user.id}:${body.ref ?? 'demo'}`;
    const unique = `dev:${Date.now()}`;
    try {
      const result = await (async () => {
        switch (body.action) {
          case 'add': return adjustCredits(user.id, cents, unique, 'Demo credit');
          case 'deduct': return adjustCredits(user.id, -cents, unique, 'Demo debit');
          case 'hold': return holdCredits(user.id, { ref, amountCents: cents, note: body.ref ?? 'Demo booking' });
          case 'capture': return captureHold(ref, cents);
          case 'release': return releaseHold(ref);
          case 'refund': return refundHold(ref);
          case 'redeem': return redeemCode(user.id, body.code ?? '');
          case 'status': return null;
          default: throw new CreditError(`unknown action ${body.action}`);
        }
      })();
      return c.json({ result, credits: await getCredits(user.id), wallet: walletUrl(token) });
    } catch (err) {
      if (!(err instanceof CreditError)) throw err;
      return c.json({ error: err.message, credits: await getCredits(user.id), wallet: walletUrl(token) }, 409);
    }
  },
});
