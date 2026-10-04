import { randomBytes } from 'node:crypto';
import type { Mastra } from '@mastra/core';
import { registerApiRoute } from '@mastra/core/server';
import { db, type User } from '../../lib/db';
import { waitUntil } from '@neon/functions';
import {
  PROVIDER_TOOLKITS,
  activeAccounts,
  connectLink,
  connectedProviders,
  isComposioConfigured,
  isProvider,
  publicUrl,
  waitForToolkit,
  type Toolkit,
} from '../../lib/connections';
import { sendWhatsApp } from '../../lib/whatsapp';
import { renderExpired, renderOnboard, renderOnboardDone } from '../../ui/onboard';
import { seedStarterSuggestions, userCity } from '../../lib/events/starter';

// ---------- used by the WhatsApp route ----------

/** Reply for users who haven't finished onboarding; null once they're ready. */
export async function onboardingReply(user: User): Promise<string | null> {
  if (user.onboarding_status === 'ready') return null;
  if (user.onboarding_status === 'analyzing') {
    return "Still reading your calendar and inbox, I'll message you the moment I'm done ⏳";
  }
  const token = user.onboarding_token ?? randomBytes(24).toString('base64url');
  await db.query(`UPDATE users SET onboarding_token = $2, onboarding_status = 'link_sent' WHERE id = $1`, [user.id, token]);
  const link = publicUrl(`/onboard?t=${token}`);
  if (user.onboarding_status === 'link_sent') return `Here's your setup link again 👉 ${link}`;
  // First link: have the starter deck ready by the time they open it (city guessed from the phone prefix).
  waitUntil(seedStarterSuggestions(user.id).catch(err => console.warn('[starter] seeding failed:', String(err).slice(0, 200))));
  return [
    `Hey${user.name ? ` ${user.name}` : ''} 👋 I'm your event concierge.`,
    `I find things you'll love (films, gigs, talks, ...) and book them within your budget, sometimes as a surprise 🎁`,
    ``,
    `Two minutes of setup: connect your mail + calendar so I learn your taste and when you're free, and set a budget:`,
    `👉 ${link}`,
  ].join('\n');
}

// ---------- web page ----------

async function userByToken(token: string | undefined) {
  if (!token) return null;
  const { rows } = await db.query(
    `SELECT u.id, u.phone, u.name, u.city, u.timezone, u.interests, u.onboarding_status, b.monthly_limit_cents, b.auto_approve_cents, b.currency
     FROM users u JOIN budgets b ON b.user_id = u.id WHERE u.onboarding_token = $1`,
    [token],
  );
  return rows[0] ?? null;
}

export const onboardPage = registerApiRoute('/onboard', {
  method: 'GET',
  requiresAuth: false,
  handler: async c => {
    const token = c.req.query('t');
    const user = await userByToken(token);
    if (!user) return c.html(renderExpired(), 404);

    const connected = await connectedProviders(user.id, true);
    const { rows: [swipes] } = await db.query(
      `SELECT count(*) FILTER (WHERE reaction = 'like')::int AS liked, count(*) FILTER (WHERE reaction = 'dislike')::int AS disliked
       FROM suggestions WHERE user_id = $1 AND source = 'starter'`,
      [user.id],
    );
    return c.html(
      renderOnboard({
        token: token!,
        name: user.name,
        city: userCity(user).city,   // prefilled: guessed from the phone number until they type one
        interests: user.interests,
        status: user.onboarding_status,
        currency: user.currency,
        monthlyCents: user.monthly_limit_cents,
        autoCents: user.auto_approve_cents,
        connected: (['google', 'microsoft'] as const).filter(p => connected.includes(p)),
        canConnect: isComposioConfigured(),
        error: c.req.query('error'),
        liked: swipes?.liked ?? 0,
        disliked: swipes?.disliked ?? 0,
      }),
    );
  },
});

/**
 * Connects every toolkit a provider needs, one Composio connect page at a time: each page returns
 * here with `done` extended, and we send the user on to the next missing toolkit, then back to /onboard.
 */
export const connectStart = registerApiRoute('/connect/:provider/start', {
  method: 'GET',
  requiresAuth: false,
  handler: async c => {
    const provider = c.req.param('provider');
    const token = c.req.query('t');
    const user = await userByToken(token);
    if (!isProvider(provider) || !user || !isComposioConfigured()) return c.text('bad request', 400);
    const back = (extra = '') => c.redirect(`/onboard?t=${encodeURIComponent(token!)}${extra}`);

    const done = (c.req.query('done') ?? '').split(',').filter(Boolean) as Toolkit[];
    const justReturned = done.at(-1);
    if (justReturned && !(await waitForToolkit(user.id, justReturned))) {
      return back(`&error=${encodeURIComponent(`${justReturned} wasn't connected`)}`);
    }
    const active = await activeAccounts(user.id, true);
    // Re-clicking a connected provider reconnects it; otherwise only fill the gaps.
    const reconnect = !justReturned && PROVIDER_TOOLKITS[provider].every(t => active.has(t));
    const next = PROVIDER_TOOLKITS[provider].find(t => !done.includes(t) && (reconnect || !active.has(t)));
    if (!next) return back();

    const callback = publicUrl(`/connect/${provider}/start?t=${encodeURIComponent(token!)}&done=${[...done, next].join(',')}`);
    try {
      return c.redirect(await connectLink(user.id, next, callback));
    } catch (err) {
      c.get('mastra').getLogger().error('composio connect failed', { provider, toolkit: next, err: String(err) });
      return back(`&error=${encodeURIComponent('could not start the connection')}`);
    }
  },
});

export const onboardComplete = registerApiRoute('/onboard/complete', {
  method: 'POST',
  requiresAuth: false,
  handler: async c => {
    const form = await c.req.parseBody();
    const user = await userByToken(String(form.t ?? ''));
    if (!user) return c.text('bad request', 400);
    const cents = (v: unknown) => Math.max(0, Math.round(Number(v) * 100)) || 0;

    await db.query(`UPDATE users SET city = $2, interests = NULLIF($3, ''), timezone = COALESCE(NULLIF($4, ''), timezone) WHERE id = $1`, [
      user.id,
      String(form.city ?? '').trim(),
      String(form.interests ?? '').trim(),
      String(form.tz ?? ''),
    ]);
    await db.query(`UPDATE budgets SET monthly_limit_cents = $2::int, auto_approve_cents = LEAST($3::int, $2::int), updated_at = now() WHERE user_id = $1`, [
      user.id,
      cents(form.monthly),
      cents(form.auto),
    ]);

    // Settings edits after onboarding don't re-run the analysis.
    if (user.onboarding_status !== 'ready') {
      await db.query(`UPDATE users SET onboarding_status = 'analyzing' WHERE id = $1`, [user.id]);
      // waitUntil keeps the Neon Function alive for the analysis; it's a no-op under `mastra dev`.
      waitUntil(runOnboarding(c.get('mastra'), user.id));
    }
    return c.html(renderOnboardDone({ ready: user.onboarding_status === 'ready', token: String(form.t) }));
  },
});

async function runOnboarding(mastra: Mastra, userId: string) {
  try {
    const run = await mastra.getWorkflow('onboardUser').createRun();
    const result = await run.start({ inputData: { userId } });
    if (result.status !== 'success') throw new Error(`workflow ${result.status}`);
  } catch (err) {
    mastra.getLogger().error('onboarding failed', { userId, err: String(err) });
    await db.query(`UPDATE users SET onboarding_status = 'link_sent' WHERE id = $1`, [userId]);
    const { rows } = await db.query(`SELECT phone, onboarding_token FROM users WHERE id = $1`, [userId]);
    await sendWhatsApp(
      rows[0].phone,
      `Hmm, something went wrong while I was reading your data 😕 Mind trying again? ${publicUrl(`/onboard?t=${rows[0].onboarding_token}`)}`,
    ).catch(() => {});
  }
}
