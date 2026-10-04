import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { execute } from '../../mastra/tools/browser';
import { modelFor } from '../model';
import type { VerifiedPayment } from './checkout';

/**
 * Paying is code, never the LLM: the card comes from env (BOOKING_CARD_*), is typed into the fields the checkout agent
 * found (checked by verifyPaymentPage) with Playwright in the user's Kernel browser, and the pay button is clicked.
 * The card number must never reach a prompt, a tool result, a log line or the workflow snapshot: nothing here returns
 * or logs it, and everything read back from the page goes through redact().
 */

export function cardConfigured() {
  return Boolean(process.env.BOOKING_CARD_NUMBER && process.env.BOOKING_CARD_EXP && process.env.BOOKING_CARD_CVC);
}

function card() {
  const number = (process.env.BOOKING_CARD_NUMBER ?? '').replace(/\D/g, '');
  const exp = (process.env.BOOKING_CARD_EXP ?? '').match(/^\s*(\d{1,2})\s*\/\s*(\d{2,4})\s*$/);
  const cvc = (process.env.BOOKING_CARD_CVC ?? '').trim();
  if (!number || !exp || !cvc) throw new Error('the booking card is not configured (BOOKING_CARD_NUMBER / _EXP / _CVC)');
  const month = exp[1].padStart(2, '0');
  const year = exp[2].slice(-2);
  return { number, month, year, cvc, name: process.env.BOOKING_CARD_NAME || 'Concierge Booking' };
}

/** Removes card numbers (the configured one and anything that looks like one) from text or JSON-able values. */
export function redact<T>(value: T): T {
  const configured = (process.env.BOOKING_CARD_NUMBER ?? '').replace(/\D/g, '');
  const scrub = (s: string) => {
    let out = s.replace(/\b(?:\d[ -]?){12,18}\d\b/g, '[card]');
    if (configured.length >= 12) out = out.split(configured).join('[card]');
    return out;
  };
  if (typeof value === 'string') return scrub(value) as T;
  if (value === undefined || value === null || typeof value !== 'object') return value;
  return JSON.parse(scrub(JSON.stringify(value))) as T;
}

export type PayResult = { url: string; title: string; text: string; links: { text: string; href: string }[] };

/** Clicking pay failed half-way: the shop may or may not have charged the card. */
export class PaymentUnclear extends Error {}

/**
 * Fills the card into the verified fields, then (second call) clicks pay and returns the resulting page, redacted.
 * Errors before the click are plain Errors (nothing was paid); errors from the click on are PaymentUnclear.
 */
export async function fillCardAndPay(browser: string, p: VerifiedPayment): Promise<PayResult> {
  const c = card();
  const fields: [string, string][] = [
    [p.refs.number, c.number],
    ...(p.refs.expiry ? [[p.refs.expiry, `${c.month}/${c.year}`] as [string, string]] : []),
    ...(p.refs.expMonth ? [[p.refs.expMonth, c.month] as [string, string]] : []),
    ...(p.refs.expYear ? [[p.refs.expYear, c.year] as [string, string]] : []),
    [p.refs.cvc, c.cvc],
    ...(p.refs.name ? [[p.refs.name, c.name] as [string, string]] : []),
  ];
  const filled = await execute(
    browser,
    `if (page.url() !== ${JSON.stringify(p.pageUrl)}) return { moved: page.url() };
for (const [r, v] of ${JSON.stringify(fields)}) {
  const el = page.locator('[data-ref="' + r + '"]');
  if ((await el.count()) !== 1) return { missing: 'card field' };
  if ((await el.evaluate(e => e.tagName.toLowerCase())) === 'select') {
    await el.selectOption(v).catch(() => el.selectOption({ label: v }).catch(() => el.selectOption({ label: String(Number(v)) })));
  } else {
    await el.fill(v);
  }
}
if ((await page.locator('[data-ref="${p.refs.pay}"]').count()) !== 1) return { missing: 'pay button' };
return { ok: true };`,
    45,
  );
  if (!filled.success) throw new Error(`filling in the card failed: ${redact(String(filled.error ?? '')).slice(0, 200)}`);
  const pre = filled.result as { ok?: boolean; moved?: string; missing?: string };
  if (pre.moved) throw new Error(`the browser left the payment page (now on ${redact(pre.moved)})`);
  if (pre.missing) throw new Error(`the ${pre.missing} disappeared from the payment page`);

  const paid = await execute(
    browser,
    `await Promise.all([page.waitForNavigation({ timeout: 30000 }).catch(() => {}), page.locator('[data-ref="${p.refs.pay}"]').click({ timeout: 10000 })]);
await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
const read = await page.evaluate(() => ({
  text: document.body.innerText.replace(/\\n{3,}/g, '\\n\\n').slice(0, 6000),
  links: [...document.querySelectorAll('a[href]')].slice(0, 40).map(a => ({ text: (a.innerText || '').trim().slice(0, 60), href: a.href })),
}));
return { url: page.url(), title: await page.title(), ...read };`,
    90,
  );
  if (!paid.success) throw new PaymentUnclear(`the browser failed while paying: ${redact(String(paid.error ?? '')).slice(0, 200)}`);
  return redact(paid.result as PayResult);
}

const confirmationSchema = z.object({
  outcome: z.enum(['confirmed', 'declined', 'unclear']).describe('confirmed = the page says the order/booking succeeded; declined = payment refused or error'),
  orderNumber: z.string().nullable().describe('order / booking / confirmation number as shown, null if none'),
  ticketUrl: z.string().nullable().describe('link to the tickets (or the order page), from the links list; null if none'),
  totalText: z.string().nullable().describe('amount charged as shown, null if not shown'),
  message: z.string().describe('what the page says, one short sentence'),
});
export type Confirmation = z.infer<typeof confirmationSchema>;

const reader = new Agent({
  id: 'confirmation-reader',
  name: 'Confirmation reader',
  model: () => modelFor(process.env.BOOKING_MODEL || process.env.DISCOVERY_MODEL || 'neon/claude-sonnet-5'),
  instructions: 'You read the page a ticket shop shows after a payment and say whether the order went through. Never guess.',
});

/** What the page after "pay" says. The text is already redacted. */
export async function readConfirmation(page: PayResult): Promise<Confirmation> {
  const res = await reader.generate(
    `Page after submitting the payment.\nURL: ${page.url}\nTitle: ${page.title}\n\nText:\n${page.text}\n\nLinks:\n${page.links.map(l => `- ${l.text} → ${l.href}`).join('\n')}`,
    { structuredOutput: { schema: confirmationSchema, jsonPromptInjection: true } },
  );
  return res.object;
}
