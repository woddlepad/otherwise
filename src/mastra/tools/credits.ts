import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { CreditError, MAX_TOPUP_CENTS, MIN_TOPUP_CENTS, createTopUpCheckout, creditHistory, getCredits, redeemCode, walletUrl } from '../../lib/credits';
import { db } from '../../lib/db';

function userIdFrom(requestContext: { get(key: string): unknown } | undefined): string {
  const userId = requestContext?.get('userId');
  if (typeof userId !== 'string') throw new Error('userId missing from request context');
  return userId;
}

const euros = (cents: number) => Math.round(cents) / 100;

export const getCreditsTool = createTool({
  id: 'get-credits',
  description: "The user's prepaid credits in EUR: available (spendable now), reserved for bookings in progress, and recent changes.",
  inputSchema: z.object({}),
  execute: async (_input, { requestContext }) => {
    const userId = userIdFrom(requestContext);
    const c = await getCredits(userId);
    const history = await creditHistory(userId, 5);
    return {
      available: euros(c.availableCents),
      reserved: euros(c.heldCents),
      recent: history.map(h => ({ kind: h.kind, amount: euros(h.amount_cents), note: h.note, at: h.created_at.toISOString().slice(0, 10) })),
    };
  },
});

export const topUpLink = createTool({
  id: 'top-up-link',
  description:
    `Link for the user to add credits by card. With an amount (${MIN_TOPUP_CENTS / 100}–${MAX_TOPUP_CENTS / 100} EUR) it goes ` +
    'straight to payment; without, to their wallet page (packs, custom amount, discount codes, history). Credits are never paid back to the card.',
  inputSchema: z.object({ amount: z.number().positive().optional().describe('EUR, only if the user named an amount') }),
  execute: async ({ amount }, { requestContext }) => {
    const userId = userIdFrom(requestContext);
    try {
      if (amount) return { url: await createTopUpCheckout(userId, Math.round(amount * 100)) };
    } catch (err) {
      if (err instanceof CreditError) return { error: err.message };
      throw err;
    }
    const { rows } = await db.query(`SELECT onboarding_token FROM users WHERE id = $1`, [userId]);
    return { url: walletUrl(rows[0].onboarding_token) };
  },
});

export const redeemCodeTool = createTool({
  id: 'redeem-code',
  description: 'Redeem a discount code the user sent for free credits. Pass the code exactly as they wrote it.',
  inputSchema: z.object({ code: z.string() }),
  execute: async ({ code }, { requestContext }) => {
    const r = await redeemCode(userIdFrom(requestContext), code);
    return r.ok ? { ok: true, added: euros(r.amountCents), available: euros(r.credits.availableCents) } : r;
  },
});
