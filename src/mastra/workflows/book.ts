import type { Mastra } from '@mastra/core';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { waitUntil } from '@neon/functions';
import { z } from 'zod';
import { checkoutRefsSchema, runCheckout, verifyPaymentPage, type VerifiedPayment } from '../../lib/booking/checkout';
import { cardConfigured, fillCardAndPay, PaymentUnclear, readConfirmation } from '../../lib/booking/payment';
import { eur, loadBooking, showtimeLabel, updateBooking, type Booking } from '../../lib/booking/store';
import { CreditError, captureHold, getCredits, holdCredits, releaseHold, resizeHold, walletUrl } from '../../lib/credits';
import { db, getBudgetStatus } from '../../lib/db';
import { parsePrice } from '../../lib/events/normalize';
import { approveBooking } from '../../lib/policy';
import { tellUser } from '../../lib/thread';
import { browserName, closeBrowser } from '../tools/browser';

/**
 * Books one event for a user (docs/booking/PLAN.md). Money rules live here in code, not in a prompt:
 *   approve → hold credits → checkout (sub-agent, stops at payment) → verify total → pay (code fills the card) → settle.
 * Suspends for the user at three points: approval (estimate above auto-approve), re-approval (checkout total above
 * what's held and above auto-approve) and needs_human (login/captcha: they finish it in the Kernel live view).
 * The concierge's confirm-booking / cancel-booking tools resume it. Any failure: booking failed, hold released, user told.
 */

class BookingError extends Error {
  constructor(message: string, readonly opts: { keepHold?: boolean; userMessage?: string } = {}) {
    super(message);
  }
}

const base = z.object({ bookingId: z.string(), userId: z.string() });
const result = z.object({ bookingId: z.string(), status: z.string() });
const yesNo = z.object({ approved: z.boolean() });
const approvedOut = base.extend({ estimateCents: z.number().nullable(), free: z.boolean() });
const heldOut = approvedOut.extend({ holdRef: z.string().nullable() });

async function mustLoad(id: string) {
  const b = await loadBooking(id);
  if (!b) throw new BookingError(`booking ${id} not found`);
  return b;
}

const isFreeEvent = (b: Booking) => b.eventStatus === 'free_rsvp' || b.eventStatus === 'free_entry' || b.priceCents === 0;
const label = (b: Booking) => `${b.qty}× ${b.title} (${showtimeLabel(b)}${b.venue ? ` @ ${b.venue}` : ''})`;

async function topUpMessage(b: Booking, neededCents: number) {
  const { availableCents } = await getCredits(b.userId);
  const { rows } = await db.query<{ onboarding_token: string | null }>(`SELECT onboarding_token FROM users WHERE id = $1`, [b.userId]);
  const link = rows[0]?.onboarding_token ? ` Top up here: ${walletUrl(rows[0].onboarding_token)}` : '';
  return `💳 ${label(b)} needs about ${eur(neededCents)}, but you have ${eur(availableCents)} in credits.${link} Then ask me again.`;
}

/** Ends a booking that went wrong: failed, hold released (unless a payment may have happened), browser closed, user told. */
async function failBooking(mastra: Mastra, bookingId: string, err: unknown) {
  const e = err instanceof BookingError ? err : new BookingError(err instanceof Error ? err.message : String(err));
  mastra.getLogger().error('booking failed', { bookingId, err: e.message });
  const b = await loadBooking(bookingId);
  if (!b) return;
  await updateBooking(bookingId, { status: 'failed', error: e.message.slice(0, 500), suspended_step: null });
  if (b.holdRef && !e.opts.keepHold) await releaseHold(b.holdRef).catch(() => {});
  await closeBrowser(browserName(b.userId)).catch(() => {});
  const why = e.message.replace(/[.\s]+$/, '');
  const text =
    e.opts.userMessage ??
    (e.opts.keepHold
      ? `⚠️ Something went wrong right after paying for ${label(b)}: ${why}. I'm keeping the credits reserved until it's checked.`
      : `😕 I couldn't book ${label(b)}: ${why}. Nothing was charged.`);
  await tellUser(mastra, b.userId, text, `booking ${b.id} failed`).catch(() => {});
}

/** The user said no (or cancel): cancelled, hold released, browser closed. */
async function cancelBooking(mastra: Mastra, b: Booking) {
  await updateBooking(b.id, { status: 'cancelled', suspended_step: null, live_view_url: null });
  if (b.holdRef) await releaseHold(b.holdRef).catch(() => {});
  await closeBrowser(browserName(b.userId)).catch(() => {});
  await tellUser(mastra, b.userId, `Ok, I won't book ${b.title}. Nothing was charged.`, `booking ${b.id} cancelled`);
  return { bookingId: b.id, status: 'cancelled' };
}

type Bail = (r: z.infer<typeof result>) => unknown;
/** Runs a step body; on error fails the booking and ends the workflow there. */
async function guard<T>(mastra: Mastra, bookingId: string, bail: Bail, fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (err) {
    await failBooking(mastra, bookingId, err);
    return bail({ bookingId, status: 'failed' }) as never;
  }
}

const approve = createStep({
  id: 'approve',
  description: 'Free → go; estimate within auto-approve → go; otherwise ask on WhatsApp and wait. Not enough credits → stop with a top-up link',
  inputSchema: base,
  outputSchema: approvedOut,
  resumeSchema: yesNo,
  suspendSchema: z.object({ question: z.string() }),
  execute: async ({ inputData, resumeData, suspend, bail, mastra }) =>
    guard(mastra, inputData.bookingId, bail, async () => {
      const b = await mustLoad(inputData.bookingId);
      if (['booked', 'failed', 'cancelled'].includes(b.status)) return bail({ bookingId: b.id, status: b.status });
      const free = isFreeEvent(b);
      const estimate = free || b.priceCents === null ? null : b.priceCents * b.qty;
      const out = { ...inputData, estimateCents: estimate, free };
      if (resumeData) {
        if (!resumeData.approved) return bail(await cancelBooking(mastra, b));
        await updateBooking(b.id, { approved_cents: estimate, suspended_step: null, status: 'booking' });
        return out;
      }
      if (!estimate) return out; // free, or no price known yet: the checkout total gets approved instead
      const budget = await getBudgetStatus(b.userId);
      const decision = approveBooking({ totalCents: estimate, budget });
      if (decision.action === 'top_up') {
        throw new BookingError('not enough credits', { userMessage: await topUpMessage(b, estimate) });
      }
      if (decision.action === 'ask') {
        const why = decision.reason === 'above auto-approve amount' ? `more than your auto-book limit of ${eur(budget.autoApproveCents)}` : decision.reason;
        await updateBooking(b.id, { status: 'awaiting_approval', suspended_step: 'approve' });
        await tellUser(
          mastra,
          b.userId,
          `🎟️ ${label(b)} comes to about ${eur(estimate)} (${why}). I'll check the real total at checkout. Shall I book it? Reply yes or no.`,
          `booking ${b.id} is waiting for approval: yes → confirm-booking, no → cancel-booking`,
        );
        return suspend({ question: `book for ${eur(estimate)}?` });
      }
      await updateBooking(b.id, { approved_cents: estimate });
      return out;
    }),
});

const hold = createStep({
  id: 'hold',
  description: 'Reserve credits for the estimated total',
  inputSchema: approvedOut,
  outputSchema: heldOut,
  execute: async ({ inputData, bail, mastra, runId }) =>
    guard(mastra, inputData.bookingId, bail, async () => {
      const b = await mustLoad(inputData.bookingId);
      if (!inputData.free && !cardConfigured()) throw new BookingError('no payment card is set up for bookings');
      let holdRef: string | null = null;
      if (inputData.estimateCents) {
        holdRef = `booking:${runId}`;
        try {
          await holdCredits(b.userId, { ref: holdRef, amountCents: inputData.estimateCents, bookingId: b.id, note: b.title });
        } catch (err) {
          if (!(err instanceof CreditError)) throw err;
          throw new BookingError(err.message, { userMessage: await topUpMessage(b, inputData.estimateCents) });
        }
      }
      await updateBooking(b.id, { status: 'booking', hold_ref: holdRef });
      return { ...inputData, holdRef };
    }),
});

const paymentSchema = z.object({
  totalCents: z.number(),
  totalText: z.string(),
  pageUrl: z.string(),
  refs: checkoutRefsSchema,
});
const checkedOut = heldOut.extend({
  kind: z.enum(['payment', 'reserved']),
  payment: paymentSchema.nullable(),
  orderNumber: z.string().nullable(),
  ticketUrl: z.string().nullable(),
});

const checkout = createStep({
  id: 'checkout',
  description: "Checkout sub-agent in the user's Kernel browser, up to the payment page (free events: the whole reservation)",
  inputSchema: heldOut,
  outputSchema: checkedOut,
  resumeSchema: z.object({ done: z.boolean() }),
  suspendSchema: z.object({ reason: z.string(), liveViewUrl: z.string().nullable() }),
  execute: async ({ inputData, resumeData, suspend, bail, mastra }) =>
    guard(mastra, inputData.bookingId, bail, async () => {
      const b = await mustLoad(inputData.bookingId);
      if (resumeData && !resumeData.done) return bail(await cancelBooking(mastra, b));
      await updateBooking(b.id, { status: 'booking', suspended_step: null });
      const startUrl = b.bookingUrl ?? b.eventUrl;
      const browser = browserName(b.userId);
      const report = await runCheckout({
        userId: b.userId,
        browser,
        startUrl,
        resume: Boolean(resumeData),
        free: inputData.free,
        title: b.title,
        when: showtimeLabel(b),
        venue: b.venue,
        qty: b.qty,
        attendee: { name: b.userName || 'Guest', email: b.userEmail || process.env.BOOKING_CONTACT_EMAIL || 'tickets@concierge.example' },
      });
      mastra.getLogger().info('booking checkout', { bookingId: b.id, outcome: report.outcome, reason: report.reason });

      if (report.outcome === 'needs_human') {
        const live = report.liveViewUrl ?? null;
        if (!live) throw new BookingError(`the ticket site needs a person (${report.reason}) but there is no live view`);
        await updateBooking(b.id, { status: 'needs_human', live_view_url: live, suspended_step: 'checkout' });
        await tellUser(
          mastra,
          b.userId,
          `🙋 The ticket site needs you for ${b.title}: ${report.reason}\nFinish it in my browser here: ${live}\nThen reply "done" and I'll take it from there (or "cancel").`,
          `booking ${b.id} needs the user in the live browser: "done" → confirm-booking, "cancel" → cancel-booking`,
        );
        return suspend({ reason: report.reason, liveViewUrl: live });
      }
      if (report.outcome === 'reserved') {
        return { ...inputData, kind: 'reserved' as const, payment: null, orderNumber: report.orderNumber ?? null, ticketUrl: report.ticketUrl ?? null };
      }
      if (report.outcome !== 'payment_page') throw new BookingError(report.reason || report.outcome);
      const payment = await verifyPaymentPage(browser, report, b.qty).catch(err => {
        throw new BookingError(err instanceof Error ? err.message : String(err));
      });
      return { ...inputData, kind: 'payment' as const, payment, orderNumber: null, ticketUrl: null };
    }),
});

const verifyTotal = createStep({
  id: 'verify-total',
  description: 'Shown total ≤ held → go; within auto-approve → raise the hold; otherwise ask again and wait',
  inputSchema: checkedOut,
  outputSchema: checkedOut,
  resumeSchema: yesNo,
  suspendSchema: z.object({ question: z.string() }),
  execute: async ({ inputData, resumeData, suspend, bail, mastra, runId }) =>
    guard(mastra, inputData.bookingId, bail, async () => {
      if (inputData.kind === 'reserved' || !inputData.payment) return inputData;
      const b = await mustLoad(inputData.bookingId);
      const shown = inputData.payment.totalCents;
      const { rows } = inputData.holdRef
        ? await db.query<{ amount_cents: number }>(`SELECT amount_cents FROM credit_holds WHERE ref = $1 AND status = 'open'`, [inputData.holdRef])
        : { rows: [] };
      const held = rows[0]?.amount_cents ?? 0;
      if (shown <= held) {
        await updateBooking(b.id, { approved_cents: shown });
        return inputData;
      }

      const raiseHold = async () => {
        try {
          if (inputData.holdRef) await resizeHold(inputData.holdRef, shown);
          else await holdCredits(b.userId, { ref: `booking:${runId}`, amountCents: shown, bookingId: b.id, note: b.title });
        } catch (err) {
          if (!(err instanceof CreditError)) throw err;
          throw new BookingError(err.message, { userMessage: await topUpMessage(b, shown) });
        }
        const holdRef = inputData.holdRef ?? `booking:${runId}`;
        await updateBooking(b.id, { approved_cents: shown, hold_ref: holdRef, status: 'booking', suspended_step: null });
        return { ...inputData, holdRef };
      };

      if (resumeData) {
        if (!resumeData.approved) return bail(await cancelBooking(mastra, b));
        return raiseHold();
      }
      const budget = await getBudgetStatus(b.userId);
      const decision = approveBooking({ totalCents: shown, budget, heldCents: held });
      if (decision.action === 'top_up') throw new BookingError('not enough credits', { userMessage: await topUpMessage(b, shown) });
      if (decision.action === 'book') return raiseHold();
      await updateBooking(b.id, { status: 'awaiting_approval', suspended_step: 'verify-total' });
      const listed = inputData.estimateCents ? ` instead of the ${eur(inputData.estimateCents)} listed (fees added at checkout)` : '';
      await tellUser(
        mastra,
        b.userId,
        `⚠️ At checkout ${label(b)} comes to ${inputData.payment.totalText}${listed}. Still book it? Reply yes or no.`,
        `booking ${b.id} is waiting for re-approval of ${eur(shown)}: yes → confirm-booking, no → cancel-booking`,
      );
      return suspend({ question: `book for ${eur(shown)}?` });
    }),
});

const paid = checkedOut.extend({ chargedCents: z.number() });

const pay = createStep({
  id: 'pay',
  description: 'Code fills the card from env into the verified fields, clicks pay and reads the confirmation',
  inputSchema: checkedOut,
  outputSchema: paid,
  execute: async ({ inputData, bail, mastra }) =>
    guard(mastra, inputData.bookingId, bail, async () => {
      if (inputData.kind === 'reserved' || !inputData.payment) return { ...inputData, chargedCents: 0 };
      const b = await mustLoad(inputData.bookingId);
      // Never submit a card twice for one attempt, even if this step runs again after a crash.
      if (b.payAttemptedAt) throw new BookingError('a payment was already attempted for this booking', { keepHold: true });
      await updateBooking(b.id, { pay_attempted_at: new Date() });
      const payment = inputData.payment as VerifiedPayment;
      let page;
      try {
        page = await fillCardAndPay(browserName(b.userId), payment);
      } catch (err) {
        throw new BookingError(err instanceof Error ? err.message : String(err), { keepHold: err instanceof PaymentUnclear });
      }
      const conf = await readConfirmation(page).catch(() => null);
      mastra.getLogger().info('booking payment', { bookingId: b.id, outcome: conf?.outcome, message: conf?.message, url: page.url });
      if (conf?.outcome === 'declined') throw new BookingError(`the payment was declined (${conf.message})`);
      if (conf?.outcome !== 'confirmed') {
        throw new BookingError(`I can't tell whether the payment went through (${conf?.message ?? page.title})`, { keepHold: true });
      }
      const charged = conf.totalText ? parsePrice(conf.totalText).cents : null;
      const ticketUrl = conf.ticketUrl ? new URL(conf.ticketUrl, page.url).toString() : page.url;
      return { ...inputData, orderNumber: conf.orderNumber, ticketUrl, chargedCents: charged && charged > 0 ? charged : payment.totalCents };
    }),
});

const settle = createStep({
  id: 'settle',
  description: 'Capture the hold for the real total (rest freed), mark booked, WhatsApp the tickets',
  inputSchema: paid,
  outputSchema: result,
  execute: async ({ inputData, bail, mastra }) =>
    guard(mastra, inputData.bookingId, bail, async () => {
      const b = await mustLoad(inputData.bookingId);
      let total = inputData.chargedCents;
      if (inputData.holdRef) {
        if (total > 0) {
          const { rows } = await db.query<{ amount_cents: number }>(`SELECT amount_cents FROM credit_holds WHERE ref = $1`, [inputData.holdRef]);
          // The page after paying showed more than approved and held: charge what's held, flag the difference.
          if (rows[0] && total > rows[0].amount_cents) {
            mastra.getLogger().warn('charged more than held', { bookingId: b.id, charged: total, held: rows[0].amount_cents });
            total = rows[0].amount_cents;
          }
          await captureHold(inputData.holdRef, total).catch(err => {
            throw new BookingError(`booked, but settling the credits failed: ${err instanceof Error ? err.message : err}`, { keepHold: true });
          });
        } else {
          await releaseHold(inputData.holdRef);
        }
      }
      await updateBooking(b.id, {
        status: 'booked',
        total_cents: total,
        ticket_url: inputData.ticketUrl,
        order_ref: inputData.orderNumber,
        suspended_step: null,
        live_view_url: null,
        error: null,
      });
      await closeBrowser(browserName(b.userId)).catch(() => {});
      const { availableCents } = await getCredits(b.userId);
      const money = total ? `${eur(total)} paid from your credits (${eur(availableCents)} left).` : 'Free, nothing charged.';
      await tellUser(
        mastra,
        b.userId,
        `✅ Booked: ${label(b)}.${inputData.orderNumber ? ` Order ${inputData.orderNumber}.` : ''} ${money}${inputData.ticketUrl ? `\nTickets: ${inputData.ticketUrl}` : ''}`,
        `booking ${b.id} booked`,
      );
      return { bookingId: b.id, status: 'booked' };
    }),
});

export const bookEvent = createWorkflow({
  id: 'book-event',
  inputSchema: base,
  outputSchema: result,
})
  .then(approve)
  .then(hold)
  .then(checkout)
  .then(verifyTotal)
  .then(pay)
  .then(settle)
  .commit();

/** A run that ends in a crash the steps didn't catch still fails the booking. */
function settleRun(mastra: Mastra, bookingId: string, run: Promise<{ status: string; error?: unknown }>) {
  waitUntil(
    run
      .then(async r => {
        if (r.status === 'failed') await failBooking(mastra, bookingId, r.error ?? 'the booking workflow failed');
      })
      .catch(err => failBooking(mastra, bookingId, err)),
  );
}

/** Starts the workflow in the background; it messages the user itself. */
export async function startBooking(mastra: Mastra, bookingId: string, userId: string) {
  const run = await mastra.getWorkflow('bookEvent').createRun({ resourceId: userId });
  await updateBooking(bookingId, { workflow_run_id: run.runId, suspended_step: null, hold_ref: null, approved_cents: null });
  settleRun(mastra, bookingId, run.start({ inputData: { bookingId, userId } }) as Promise<{ status: string; error?: unknown }>);
  return run.runId;
}

/** Continues a suspended booking with the user's answer (in the background). */
export async function resumeBooking(mastra: Mastra, b: Booking, resumeData: { approved: boolean } | { done: boolean }) {
  if (!b.workflowRunId || !b.suspendedStep) throw new Error(`booking ${b.id} is not waiting for anything`);
  const run = await mastra.getWorkflow('bookEvent').createRun({ runId: b.workflowRunId, resourceId: b.userId });
  settleRun(mastra, b.id, run.resume({ step: b.suspendedStep, resumeData }) as Promise<{ status: string; error?: unknown }>);
}
