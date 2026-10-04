import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { SNAPSHOT, execute, liveViewUrl } from '../../mastra/tools/browser';
import { modelFor } from '../model';
import { parsePrice } from '../events/normalize';
import { redact } from './payment';

/**
 * The checkout sub-agent: an LLM that clicks through a ticket site in the user's Kernel browser up to the payment page,
 * then stops and reports what the page shows. Its tools can't pay: there is no free-form Playwright, clicks on pay
 * buttons (and on any submit button of a form with card fields) are refused in the page, and card or password fields
 * can't be filled. Code verifies its report (src/lib/booking/payment.ts fills the card).
 */

const model = () => modelFor(process.env.BOOKING_MODEL || process.env.DISCOVERY_MODEL || 'neon/claude-sonnet-5');
const MAX_STEPS = 30;

export const OUTCOMES = ['payment_page', 'reserved', 'needs_human', 'unavailable', 'error'] as const;

const reportSchema = z.object({
  outcome: z.enum(OUTCOMES).describe(
    'payment_page = stopped on the page asking for card details; reserved = a free booking is confirmed; ' +
      'needs_human = login, sign-up, captcha, verification or anything only the user can do; ' +
      'unavailable = sold out / showtime or quantity not available; error = the site is broken or you are stuck',
  ),
  reason: z.string().describe('one sentence: what you see / why'),
  totalText: z.string().optional().describe('payment_page: the final total to pay exactly as the page writes it, e.g. "€21.40"'),
  qty: z.number().int().optional().describe('payment_page / reserved: number of tickets in the order summary'),
  cardNumberRef: z.string().optional().describe('payment_page: ref of the card number field'),
  expiryRef: z.string().optional().describe('payment_page: ref of a combined MM/YY expiry field'),
  expMonthRef: z.string().optional().describe('payment_page: ref of the expiry month field, if separate'),
  expYearRef: z.string().optional().describe('payment_page: ref of the expiry year field, if separate'),
  cvcRef: z.string().optional().describe('payment_page: ref of the CVC / security code field'),
  cardNameRef: z.string().optional().describe('payment_page: ref of the name-on-card field, if any'),
  payRef: z.string().optional().describe('payment_page: ref of the button that submits the payment'),
  orderNumber: z.string().optional().describe('reserved: order / confirmation number'),
  ticketUrl: z.string().optional().describe('reserved: link to the tickets or the confirmation page'),
});
export type CheckoutReport = z.infer<typeof reportSchema>;

const ref = z.string().regex(/^\d+$/).describe('the [N] number from the last snapshot');

// Buttons the agent may never press. Free events may still confirm an order ("Place order" for €0).
const ALWAYS_BLOCKED = String.raw`\b(pay|pay now|bezahlen|zahlungspflichtig|submit payment|authori[sz]e payment)\b`;
const PAID_BLOCKED = String.raw`\b(place order|complete (order|purchase|booking)|purchase|buy now|confirm (and|&) pay|confirm (order|purchase|booking))\b`;
const PAYMENT_FIELD = String.raw`cc-|card|cvc|cvv|csc|security code|expir|iban`;

/** Page code: the element behind a ref and what it is (returns early when it isn't there). */
const describeRef = (r: string) => `
const el = page.locator('[data-ref="${r}"]');
if (await el.count() !== 1) return { missing: 'No element [${r}] on this page: take a fresh snapshot.' };
const info = await el.evaluate(e => {
  const form = e.closest('form');
  const cardForm = !!form && !!form.querySelector('input[autocomplete^="cc-"], input[name*="card" i], input[id*="card" i], input[name*="cvc" i], input[name*="cvv" i]');
  const text = (e.innerText || e.value || e.getAttribute('aria-label') || e.title || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
  const attrs = [e.getAttribute('autocomplete'), e.getAttribute('name'), e.id, e.getAttribute('placeholder'), e.getAttribute('aria-label')].filter(Boolean).join(' ');
  return { tag: e.tagName.toLowerCase(), type: (e.getAttribute('type') || '').toLowerCase(), text, attrs, cardForm };
});`;

const SETTLE = `await page.waitForLoadState('domcontentloaded').catch(() => {});
await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});`;

export type CheckoutTask = {
  userId: string;
  browser: string;               // Kernel browser name (user's)
  startUrl: string;
  resume: boolean;               // after the user finished something in the live view: continue from the current page
  free: boolean;
  title: string;
  when: string;                  // "Thu 8 Oct, 21:00"
  venue: string | null;
  qty: number;
  attendee: { name: string; email: string };
};

/** Runs the sub-agent once; returns its report (code still has to verify a payment_page report). */
export async function runCheckout(task: CheckoutTask): Promise<CheckoutReport & { liveViewUrl?: string }> {
  let report: CheckoutReport | null = null;
  const run = async (code: string, timeout = 45): Promise<Record<string, unknown>> => {
    const res = await execute(task.browser, code, timeout);
    return res.success ? ((res.result ?? {}) as Record<string, unknown>) : { error: redact(String(res.error ?? 'failed')) };
  };
  const look = async () => redact(await run(SNAPSHOT, 30));

  const tools = {
    snapshot: createTool({
      id: 'snapshot',
      description: 'The current page: title, URL, visible text and numbered interactive elements [N].',
      inputSchema: z.object({}),
      execute: async () => look(),
    }),
    open: createTool({
      id: 'open',
      description: 'Go to a URL, then return the page snapshot.',
      inputSchema: z.object({ url: z.string().url() }),
      execute: async ({ url }) => {
        const nav = await run(`await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded', timeout: 30000 });\n${SETTLE}`);
        return { nav, page: await look() };
      },
    }),
    click: createTool({
      id: 'click',
      description: 'Click element [N] (links, buttons, radio buttons, checkboxes), then return the new snapshot. Pay buttons are refused.',
      inputSchema: z.object({ ref }),
      execute: async ({ ref: r }) => {
        const res = await run(`${describeRef(r)}
if (new RegExp(${JSON.stringify(ALWAYS_BLOCKED)}, 'i').test(info.text) ${task.free ? '' : `|| new RegExp(${JSON.stringify(PAID_BLOCKED)}, 'i').test(info.text)`}
    || (info.cardForm && (info.tag === 'button' || info.type === 'submit')))
  return { refused: 'This submits a payment. Stop here and report outcome payment_page.' };
await el.click({ timeout: 10000 });
${SETTLE}
return { clicked: info.text };`);
        return { ...res, page: await look() };
      },
    }),
    fill: createTool({
      id: 'fill',
      description: 'Type a value into text field [N] (replaces its content). Card and password fields are refused.',
      inputSchema: z.object({ ref, value: z.string().max(200) }),
      execute: async ({ ref: r, value }) => {
        const res = await run(`${describeRef(r)}
if (info.type === 'password') return { refused: "Passwords are the user's. Report outcome needs_human." };
if (new RegExp(${JSON.stringify(PAYMENT_FIELD)}, 'i').test(info.attrs)) return { refused: 'Payment fields are filled by the system. Report outcome payment_page.' };
await el.fill(${JSON.stringify(value)}, { timeout: 10000 });
return { filled: true };`);
        return { ...res, page: await look() };
      },
    }),
    select: createTool({
      id: 'select',
      description: 'Choose an option (by its visible label or value) in dropdown [N], then return the new snapshot.',
      inputSchema: z.object({ ref, option: z.string().max(200) }),
      execute: async ({ ref: r, option }) => {
        const res = await run(`${describeRef(r)}
if (new RegExp(${JSON.stringify(PAYMENT_FIELD)}, 'i').test(info.attrs)) return { refused: 'Payment fields are filled by the system. Report outcome payment_page.' };
await el.selectOption({ label: ${JSON.stringify(option)} }, { timeout: 5000 }).catch(() => el.selectOption(${JSON.stringify(option)}, { timeout: 5000 }));
${SETTLE}
return { selected: ${JSON.stringify(option)} };`);
        return { ...res, page: await look() };
      },
    }),
    report: createTool({
      id: 'report',
      description: 'Finish: report the outcome. Call exactly once, as your last action.',
      inputSchema: reportSchema,
      execute: async input => {
        report = input;
        return { ok: true };
      },
    }),
  };

  const agent = new Agent({
    id: 'checkout',
    name: 'Checkout',
    model,
    instructions: `You complete a ticket checkout on a website in a cloud browser, for a user who asked for these tickets.
Work with the tools: read the snapshot, act on elements by their [N] ref, check the new snapshot after each step.

Goal: get to the point where only payment is left, then STOP and call report.
- Choose the right showtime, the standard / regular adult ticket type (unless told otherwise) and the exact quantity.
- Fill attendee details with the name and email given below; tick required terms checkboxes.
- When a page asks for card details: do not touch it. Call report with outcome "payment_page", the final total exactly as the
  page shows it (incl. fees), the quantity in the order summary, and the refs of the card number, expiry (or month + year),
  CVC, name-on-card fields and the pay button. The system fills the card and pays after checking the total.
- A free event that needs no payment: complete the reservation, then report "reserved" with the order number and ticket link.
- A login, sign-up, captcha, phone/email verification or anything else only the user can do: report "needs_human" right away.
  Never guess or invent passwords and never create accounts.
- Sold out, showtime or quantity not available: report "unavailable". Stuck or broken site: report "error".
Never invent what the page says. Keep going without asking questions: nobody reads your text, only the report.`,
    tools,
  });

  const prompt = `${task.resume ? `The user just finished something in the browser (e.g. signed in). Continue from the current page: take a snapshot first.` : `Start by opening ${task.startUrl}`}

Event: ${task.title}
Showtime: ${task.when}${task.venue ? ` at ${task.venue}` : ''}
Tickets: ${task.qty}
Attendee: ${task.attendee.name}, ${task.attendee.email}
${task.free ? 'The event should be free.' : 'This is a paid event: stop at the payment page.'}
Event page: ${task.startUrl}`;

  await agent.generate(prompt, { maxSteps: MAX_STEPS });
  const result = report as CheckoutReport | null;
  if (!result) return { outcome: 'error', reason: 'the checkout agent ended without a report' };
  if (result.outcome === 'needs_human') return { ...result, liveViewUrl: await liveViewUrl(task.browser) };
  return result;
}

export const checkoutRefsSchema = z.object({
  number: z.string(),
  expiry: z.string().optional(),
  expMonth: z.string().optional(),
  expYear: z.string().optional(),
  cvc: z.string(),
  name: z.string().optional(),
  pay: z.string(),
});
export type VerifiedPayment = { totalCents: number; totalText: string; pageUrl: string; refs: z.infer<typeof checkoutRefsSchema> };

/**
 * Checks a payment_page report against the page itself: the fields and the pay button exist where the agent says,
 * the total it read is on the page (and on the pay button, if that shows an amount) and is in euros.
 * Throws with a reason otherwise.
 */
export async function verifyPaymentPage(browser: string, r: CheckoutReport, expectedQty: number): Promise<VerifiedPayment> {
  const refs = {
    number: r.cardNumberRef, expiry: r.expiryRef, expMonth: r.expMonthRef, expYear: r.expYearRef, cvc: r.cvcRef, name: r.cardNameRef, pay: r.payRef,
  };
  if (!refs.number || !refs.cvc || !refs.pay || !(refs.expiry || (refs.expMonth && refs.expYear))) {
    throw new Error('the checkout agent did not find all card fields');
  }
  const given = Object.entries(refs).filter((e): e is [string, string] => typeof e[1] === 'string' && /^\d+$/.test(e[1]));
  const res = await execute(
    browser,
    `const out = {};
for (const [k, r] of ${JSON.stringify(given)}) {
  const el = page.locator('[data-ref="' + r + '"]');
  out[k] = (await el.count()) === 1 ? await el.evaluate(e => ({ tag: e.tagName.toLowerCase(), type: (e.getAttribute('type') || '').toLowerCase(), text: (e.innerText || e.value || '').trim().replace(/\\s+/g, ' ').slice(0, 80) })) : null;
}
return { url: page.url(), text: await page.evaluate(() => document.body.innerText.replace(/\\s+/g, ' ')), els: out };`,
    30,
  );
  if (!res.success) throw new Error(`could not read the payment page: ${redact(String(res.error)).slice(0, 200)}`);
  const page = res.result as { url: string; text: string; els: Record<string, { tag: string; type: string; text: string } | null> };
  for (const k of ['number', 'cvc', 'expiry', 'expMonth', 'expYear', 'name'] as const) {
    if (!refs[k]) continue;
    const el = page.els[k];
    if (!el || !['input', 'select'].includes(el.tag)) throw new Error(`the ${k} field is not where the checkout agent said`);
  }
  const pay = page.els.pay;
  if (!pay || !(pay.tag === 'button' || (pay.tag === 'input' && ['submit', 'button'].includes(pay.type)))) {
    throw new Error('the pay button is not where the checkout agent said');
  }
  const totalText = (r.totalText ?? '').trim();
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  if (!totalText || !norm(page.text).includes(norm(totalText))) throw new Error(`the total "${totalText}" is not on the payment page`);
  const total = parsePrice(totalText);
  if (total.cents === null || total.cents <= 0) throw new Error(`can't read the total "${totalText}"`);
  if (total.currency && total.currency !== 'EUR') throw new Error(`the total is in ${total.currency}, credits are in EUR`);
  const onButton = parsePrice(pay.text);
  if (onButton.cents !== null && onButton.cents !== total.cents) {
    throw new Error(`the pay button says ${pay.text} but the total read was ${totalText}`);
  }
  if (r.qty !== undefined && r.qty !== expectedQty) throw new Error(`the order has ${r.qty} tickets, ${expectedQty} were asked for`);
  return {
    totalCents: total.cents,
    totalText,
    pageUrl: page.url,
    refs: {
      number: refs.number,
      cvc: refs.cvc,
      pay: refs.pay,
      ...(refs.expiry ? { expiry: refs.expiry } : {}),
      ...(refs.expMonth ? { expMonth: refs.expMonth } : {}),
      ...(refs.expYear ? { expYear: refs.expYear } : {}),
      ...(refs.name ? { name: refs.name } : {}),
    },
  };
}
