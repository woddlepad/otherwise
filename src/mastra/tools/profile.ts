import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { db, getBudgetStatus } from '../../lib/db';

function userIdFrom(requestContext: { get(key: string): unknown } | undefined): string {
  const userId = requestContext?.get('userId');
  if (typeof userId !== 'string') throw new Error('userId missing from request context');
  return userId;
}

const euros = (cents: number) => Math.round(cents) / 100;

export const getProfile = createTool({
  id: 'get-profile',
  description: "Get the user's saved city, interests and budget status (amounts in major currency units).",
  inputSchema: z.object({}),
  execute: async (_input, { requestContext }) => {
    const userId = userIdFrom(requestContext);
    const { rows } = await db.query(`SELECT name, city, interests FROM users WHERE id = $1`, [userId]);
    const b = await getBudgetStatus(userId);
    return {
      ...rows[0],
      budget: {
        currency: b.currency,
        monthlyLimit: euros(b.monthlyLimitCents),
        perEventCap: euros(b.perEventCapCents),
        autoApproveUpTo: euros(b.autoApproveCents),
        spentThisMonth: euros(b.spentCents),
        onHold: euros(b.heldCents),
        remaining: euros(b.remainingCents),
      },
    };
  },
});

export const updateProfile = createTool({
  id: 'update-profile',
  description:
    "Save the user's name, city, interests or budget rules. Only pass fields the user actually stated. Money in major units (e.g. 25 = €25).",
  inputSchema: z.object({
    name: z.string().optional(),
    city: z.string().optional(),
    interests: z.string().optional().describe('Full replacement free-text list of interests and dislikes'),
    monthlyLimit: z.number().nonnegative().optional(),
    perEventCap: z.number().nonnegative().optional(),
    autoApproveUpTo: z.number().nonnegative().optional().describe('Book without asking at or below this price'),
    currency: z.string().length(3).optional(),
  }),
  execute: async (input, { requestContext }) => {
    const userId = userIdFrom(requestContext);
    const cents = (v?: number) => (v === undefined ? null : Math.round(v * 100));
    await db.query(
      `UPDATE users SET name = COALESCE($2, name), city = COALESCE($3, city), interests = COALESCE($4, interests)
       WHERE id = $1`,
      [userId, input.name ?? null, input.city ?? null, input.interests ?? null],
    );
    await db.query(
      `UPDATE budgets SET
         monthly_limit_cents = COALESCE($2, monthly_limit_cents),
         per_event_cap_cents = COALESCE($3, per_event_cap_cents),
         auto_approve_cents  = COALESCE($4, auto_approve_cents),
         currency            = COALESCE($5, currency),
         updated_at = now()
       WHERE user_id = $1`,
      [userId, cents(input.monthlyLimit), cents(input.perEventCap), cents(input.autoApproveUpTo), input.currency?.toUpperCase() ?? null],
    );
    return { ok: true };
  },
});
