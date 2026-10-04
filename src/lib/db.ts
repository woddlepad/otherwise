import { attachDatabasePool } from '@neon/functions';
import pg from 'pg';

export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
// Neon drops idle clients (scale-to-zero, pooler reclaim); without a listener that crashes the process.
attachDatabasePool(db);

export type User = {
  id: string;
  phone: string;
  name: string | null;
  city: string | null;
  interests: string | null;
  onboarding_status: 'new' | 'link_sent' | 'analyzing' | 'ready';
  onboarding_token: string | null;
};

export async function upsertUserByPhone(phone: string, name?: string): Promise<User> {
  const { rows } = await db.query<User>(
    `INSERT INTO users (phone, name) VALUES ($1, $2)
     ON CONFLICT (phone) DO UPDATE SET name = COALESCE(users.name, EXCLUDED.name)
     RETURNING id, phone, name, city, interests, onboarding_status, onboarding_token`,
    [phone, name ?? null],
  );
  await db.query(`INSERT INTO budgets (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [rows[0].id]);
  return rows[0];
}

export type BudgetStatus = {
  currency: string;
  monthlyLimitCents: number;
  perEventCapCents: number;
  autoApproveCents: number;
  spentCents: number;
  heldCents: number;
  remainingCents: number;
  creditsAvailableCents: number;                     // prepaid credits not reserved by a hold
};

/**
 * Remaining = limit − spent (bookings minus refunds) − open holds this calendar month, from the
 * credit tables (src/lib/credits.ts). Separately: how many prepaid credits are free to spend.
 */
export async function getBudgetStatus(userId: string): Promise<BudgetStatus> {
  const { rows } = await db.query(
    `SELECT b.currency, b.monthly_limit_cents, b.per_event_cap_cents, b.auto_approve_cents,
       (SELECT GREATEST(-COALESCE(SUM(amount_cents), 0), 0) FROM credit_ledger
         WHERE user_id = b.user_id AND kind IN ('spend','refund') AND created_at >= date_trunc('month', now()))::int AS spent,
       (SELECT COALESCE(SUM(amount_cents), 0) FROM credit_holds WHERE user_id = b.user_id AND status = 'open')::int AS held,
       ((SELECT COALESCE(SUM(amount_cents), 0) FROM credit_ledger WHERE user_id = b.user_id)
        - (SELECT COALESCE(SUM(amount_cents), 0) FROM credit_holds WHERE user_id = b.user_id AND status = 'open'))::int AS credits
     FROM budgets b
     WHERE b.user_id = $1`,
    [userId],
  );
  const r = rows[0];
  if (!r) throw new Error(`no budget row for user ${userId}`);
  return {
    currency: r.currency,
    monthlyLimitCents: r.monthly_limit_cents,
    perEventCapCents: r.per_event_cap_cents,
    autoApproveCents: r.auto_approve_cents,
    spentCents: r.spent,
    heldCents: r.held,
    remainingCents: r.monthly_limit_cents - r.spent - r.held,
    creditsAvailableCents: r.credits,
  };
}
