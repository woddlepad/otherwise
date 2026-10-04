import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { ensureInbox, waitForEmail } from '../../lib/agentmail';
import { db } from '../../lib/db';
import { lastSignupAt, recordSignup } from '../../lib/email-inbound';
import { chooseSignupEmail, type SignupEmailPref } from '../../lib/policy';

function userIdFrom(requestContext: { get(key: string): unknown } | undefined): string {
  const userId = requestContext?.get('userId');
  if (typeof userId !== 'string') throw new Error('userId missing from request context');
  return userId;
}

const FREE_STATUSES = new Set(['free_rsvp', 'free_entry']);

export const signupEmail = createTool({
  id: 'signup-email',
  description:
    'Get the email address to type into a registration / RSVP / checkout form. Call it BEFORE filling any form that asks for an email; ' +
    'never type any other address. Code decides: free, anonymous, account-less signups use the agent\'s own inbox (confirmations ' +
    "then reach you and are sent to the user on WhatsApp); paid, name-bound or login-needing ones use the user's own email. " +
    'Report the facts as you see them on the form/page.',
  inputSchema: z.object({
    eventId: z.string().optional().describe('eventId from find-events, if this is one of those events'),
    url: z.string().optional().describe('URL of the page with the form'),
    free: z.boolean().nullable().describe('true if it costs nothing, false if paid, null if you cannot tell'),
    nameBound: z
      .boolean()
      .describe('true if the ticket is tied to a name/ID checked at entry, or the form needs official personal data; false otherwise'),
    loginRequired: z.boolean().describe('true if the site requires an existing user account / login to continue; false otherwise'),
  }),
  execute: async ({ eventId, url, free, nameBound, loginRequired }, { requestContext }) => {
    const userId = userIdFrom(requestContext);
    const { rows } = await db.query<{ email: string | null; signup_email_pref: SignupEmailPref }>(
      `SELECT email, signup_email_pref FROM users WHERE id = $1`,
      [userId],
    );
    // An event we know is free (free RSVP / free entry / price 0) counts as free even if the page didn't say.
    if (free === null && eventId && /^[0-9a-f-]{36}$/i.test(eventId)) {
      const { rows: ev } = await db.query<{ status: string; price_cents: number | null }>(`SELECT status, price_cents FROM events WHERE id = $1`, [eventId]);
      if (ev[0] && (FREE_STATUSES.has(ev[0].status) || ev[0].price_cents === 0)) free = true;
    }
    const choice = await chooseSignupEmail({
      facts: { free, nameBound, loginRequired },
      pref: rows[0]?.signup_email_pref ?? 'auto',
      userEmail: rows[0]?.email ?? null,
      agentEmail: async () => (await ensureInbox(userId)).email,
    });
    if (!choice.email) {
      return { email: null, kind: choice.kind, reason: choice.reason, next: "Ask the user for their email, save it with update-profile, then call signup-email again." };
    }
    const signup = await recordSignup(userId, { eventId, url, email: choice.email, kind: choice.kind, reason: choice.reason });
    return {
      email: choice.email,
      kind: choice.kind,
      reason: choice.reason,
      signupId: signup.id,
      next:
        choice.kind === 'agent'
          ? 'Type exactly this address. If the site sends a code or verification link, call wait-for-email. After submitting, tell the user the details follow on WhatsApp once the confirmation email arrives.'
          : "This is the user's own address: the confirmation goes to their inbox, not to you. Tell them to look out for it.",
    };
  },
});

export const waitForEmailTool = createTool({
  id: 'wait-for-email',
  description:
    "Wait for an email in the agent's own inbox during a signup (verification code, magic link, \"confirm your email\"). " +
    'Returns the code(s), verification links and text. Only for signups that used the agent inbox (signup-email kind=agent). Waits up to timeoutSeconds.',
  inputSchema: z.object({
    fromDomain: z.string().optional().describe('only mail from this site, e.g. "eventbrite.com"'),
    subjectIncludes: z.string().optional().describe('only mail whose subject contains this text'),
    timeoutSeconds: z.number().int().min(5).max(180).optional().describe('default 90'),
  }),
  execute: async ({ fromDomain, subjectIncludes, timeoutSeconds }, { requestContext }) => {
    const userId = userIdFrom(requestContext);
    const since = (await lastSignupAt(userId)) ?? new Date(Date.now() - 10 * 60_000);
    const mail = await waitForEmail(userId, { since, fromDomain, subjectIncludes, timeoutMs: (timeoutSeconds ?? 90) * 1000 });
    if (!mail) return { found: false, hint: 'Nothing arrived yet. Check the form was submitted, then wait again or ask the user.' };
    return {
      found: true,
      from: mail.from,
      subject: mail.subject,
      receivedAt: mail.receivedAt,
      codes: mail.codes,
      verificationLinks: mail.verificationLinks.slice(0, 5),
      text: mail.text.slice(0, 2500),
    };
  },
});

export const setSignupEmailPreference = createTool({
  id: 'set-signup-email-preference',
  description:
    'Save which email to use for event signups. alwaysUseMyEmail=true when the user says to always use their own email ' +
    "(then every form gets their address); false to go back to the default (the agent's inbox for free, anonymous signups).",
  inputSchema: z.object({ alwaysUseMyEmail: z.boolean() }),
  execute: async ({ alwaysUseMyEmail }, { requestContext }) => {
    const userId = userIdFrom(requestContext);
    await db.query(`UPDATE users SET signup_email_pref = $2 WHERE id = $1`, [userId, alwaysUseMyEmail ? 'always_user' : 'auto']);
    return { ok: true, preference: alwaysUseMyEmail ? 'always_user' : 'auto' };
  },
});
