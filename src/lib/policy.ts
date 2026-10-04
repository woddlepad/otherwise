import { db, type BudgetStatus } from './db';

export type Decision = { action: 'book' | 'ask' | 'skip'; reason: string };

/**
 * Whether to book an event unasked ("surprise"), ask first, or drop it.
 * Pure code on purpose: the LLM supplies `confidence`, it never decides about money.
 */
export function decide(input: {
  confidence: number;          // 0–1, how sure the agent is the user will love it
  totalCents: number;          // all tickets + fees
  calendarFree: boolean;
  budget: BudgetStatus;
  autoBookConfidence: number;
  askConfidence: number;
}): Decision {
  const { confidence, totalCents, calendarFree, budget, autoBookConfidence, askConfidence } = input;
  if (!calendarFree) return { action: 'skip', reason: 'calendar conflict' };
  if (totalCents > budget.remainingCents) return { action: 'skip', reason: 'not enough budget left this month' };
  if (confidence < askConfidence) return { action: 'skip', reason: `confidence ${confidence} below ask threshold ${askConfidence}` };
  // Not enough prepaid credits: still worth asking, so the agent can offer a top-up link.
  if (totalCents > budget.creditsAvailableCents) return { action: 'ask', reason: 'not enough credits, needs a top-up' };
  if (budget.perEventCapCents && totalCents > budget.perEventCapCents)
    return { action: 'ask', reason: 'above per-event cap' };
  if (confidence >= autoBookConfidence && totalCents <= budget.autoApproveCents)
    return { action: 'book', reason: `confident (${confidence} ≥ ${autoBookConfidence}) and within auto-book limit` };
  return {
    action: 'ask',
    reason: totalCents > budget.autoApproveCents ? 'above auto-book price' : `not sure enough (${confidence} < ${autoBookConfidence})`,
  };
}

export type FeedbackKind = 'approved' | 'declined' | 'loved' | 'liked' | 'meh' | 'disliked';

// How each kind of feedback moves the auto-book bar. Starts high (0.85) so the agent asks a lot at
// first; approvals and happy surprises lower it, declines and bad surprises raise it.
const STEP: Record<FeedbackKind, number> = {
  approved: -0.02,
  loved: -0.03,
  liked: -0.01,
  declined: +0.02,
  meh: +0.02,
  disliked: +0.05,
};
const MIN_AUTO_BOOK = 0.6;
const MAX_AUTO_BOOK = 0.97;

export async function recordFeedback(
  userId: string,
  f: { kind: FeedbackKind; eventTitle?: string; confidence?: number; wasSurprise?: boolean; note?: string },
) {
  const step = STEP[f.kind] * (f.wasSurprise && f.kind === 'disliked' ? 2 : 1);
  await db.query(
    `INSERT INTO feedback (user_id, kind, event_title, confidence, was_surprise, note) VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, f.kind, f.eventTitle ?? null, f.confidence ?? null, f.wasSurprise ?? false, f.note ?? null],
  );
  await db.query(`INSERT INTO taste_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
  const { rows } = await db.query(
    `UPDATE taste_profiles
       SET auto_book_confidence = LEAST($3::real, GREATEST($2::real, auto_book_confidence + $4::real)), updated_at = now()
     WHERE user_id = $1 RETURNING auto_book_confidence`,
    [userId, MIN_AUTO_BOOK, MAX_AUTO_BOOK, step],
  );
  return { autoBookConfidence: rows[0]?.auto_book_confidence as number | undefined };
}

export type SignupEmailPref = 'auto' | 'always_user';

/** What the agent knows about one signup/checkout form. null = unknown (counts as the conservative answer). */
export type SignupFacts = {
  free: boolean | null;          // no money changes hands
  nameBound: boolean | null;     // ticket tied to a name / ID checked at the door, or personal data the user must own
  loginRequired: boolean | null; // the site needs an existing user account / login
};

export type SignupEmailChoice = { email: string | null; kind: 'agent' | 'user'; reason: string };

/**
 * Which address goes into a signup form. Pure code on purpose (the LLM only reports the facts):
 * the agent's own inbox only for free, anonymous, account-less signups; everything else (paid, unknown price,
 * name-bound, login needed, or the user's "always use my email" preference) uses the user's real address.
 * `agentEmail` is a thunk so the inbox is only created when it is actually used.
 * email null = kind 'user' but no address on file: ask the user for it.
 */
export async function chooseSignupEmail(input: {
  facts: SignupFacts;
  pref: SignupEmailPref;
  userEmail: string | null;
  agentEmail: () => Promise<string>;
}): Promise<SignupEmailChoice> {
  const { facts, pref, userEmail } = input;
  const user = (reason: string): SignupEmailChoice => ({
    email: userEmail,
    kind: 'user',
    reason: userEmail ? reason : `${reason}; no email on file, ask the user for it`,
  });
  if (pref === 'always_user') return user('user prefers their own email');
  if (facts.free !== true) return user(facts.free === false ? 'paid ticket' : 'price unknown, treated as paid');
  if (facts.nameBound !== false) return user(facts.nameBound ? 'ticket is tied to a name/ID' : 'unknown whether the ticket is tied to a name');
  if (facts.loginRequired !== false) return user(facts.loginRequired ? 'site needs the user\'s own account' : 'unknown whether a login is needed');
  try {
    return { email: await input.agentEmail(), kind: 'agent', reason: 'free, not name-bound, no account needed' };
  } catch (err) {
    return user(`agent inbox unavailable (${String(err).slice(0, 120)})`);
  }
}
