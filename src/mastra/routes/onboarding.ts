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
  return [
    `Hey${user.name ? ` ${user.name}` : ''} 👋 I'm your event concierge.`,
    `I find things you'll love (films, gigs, talks, ...) and book them within your budget, sometimes as a surprise 🎁`,
    ``,
    `Two minutes of setup: connect your mail + calendar so I learn your taste and when you're free, and set a budget:`,
    `👉 ${link}`,
  ].join('\n');
}

// ---------- web page ----------

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

async function userByToken(token: string | undefined) {
  if (!token) return null;
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.city, u.interests, u.onboarding_status, b.monthly_limit_cents, b.auto_approve_cents, b.currency
     FROM users u JOIN budgets b ON b.user_id = u.id WHERE u.onboarding_token = $1`,
    [token],
  );
  return rows[0] ?? null;
}

export const page = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Event concierge · setup</title>
<style>
  :root{color-scheme:light dark;--fg:#111;--muted:#666;--line:#ddd;--bg:#fff;--accent:#111}
  @media (prefers-color-scheme:dark){:root{--fg:#eee;--muted:#999;--line:#333;--bg:#111;--accent:#eee}}
  body{font:16px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg);max-width:460px;margin:0 auto;padding:28px 18px}
  h1{font-size:22px;font-weight:600;margin:0 0 4px} p{margin:0 0 16px;color:var(--muted)}
  section{border-top:1px solid var(--line);padding:18px 0}
  h2{font-size:15px;font-weight:600;margin:0 0 10px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
  .row{display:flex;gap:10px;flex-wrap:wrap}
  a.btn,button{flex:1;display:block;text-align:center;padding:12px;border-radius:10px;border:1px solid var(--line);
    color:var(--fg);background:none;text-decoration:none;font:inherit;cursor:pointer}
  a.btn.done{border-color:#2a8;color:#2a8} a.btn.off{opacity:.4;pointer-events:none}
  button[type=submit]{background:var(--accent);color:var(--bg);border:0;font-weight:600;margin-top:8px}
  label{display:block;font-size:14px;margin:12px 0 4px}
  input,textarea{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid var(--line);background:none;color:var(--fg);font:inherit}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:10px} .small{font-size:13px;color:var(--muted)}
</style></head><body>${body}</body></html>`;

export const onboardPage = registerApiRoute('/onboard', {
  method: 'GET',
  requiresAuth: false,
  handler: async c => {
    const token = c.req.query('t');
    const user = await userByToken(token);
    if (!user) return c.html(page('<h1>Link expired</h1><p>Send me any message on WhatsApp and I\'ll send a fresh one.</p>'), 404);

    const connected = await connectedProviders(user.id, true);
    const connectBtn = (p: 'google' | 'microsoft', label: string) =>
      connected.includes(p)
        ? `<a class="btn done" href="/connect/${p}/start?t=${esc(token)}">✓ ${label}</a>`
        : `<a class="btn${isComposioConfigured() ? '' : ' off'}" href="/connect/${p}/start?t=${esc(token)}">${label}</a>`;
    const euros = (cents: number) => (cents ? String(cents / 100) : '');
    const error = c.req.query('error');

    return c.html(
      page(`
<h1>Hi${user.name ? ` ${esc(user.name)}` : ''} 👋</h1>
<p>Connect your mail and calendar so I learn what you like and when you're free, then set a budget.</p>
${error ? `<p style="color:#c33">Connecting failed: ${esc(error)}. Try again?</p>` : ''}
<section><h2>1 · Connect</h2>
  <div class="row">${connectBtn('google', 'Gmail + Google Calendar')}${connectBtn('microsoft', 'Outlook + calendar')}</div>
  <p class="small" style="margin-top:8px">Read-only mail. Calendar access lets me check when you're free and add what I book.</p>
</section>
<form method="post" action="/onboard/complete">
<input type="hidden" name="t" value="${esc(token)}"><input type="hidden" name="tz" id="tz">
<section><h2>2 · About you</h2>
  <label>City</label><input name="city" required value="${esc(user.city)}" placeholder="Berlin">
  <label>Anything I should know? <span class="small">(optional)</span></label>
  <textarea name="interests" rows="2" placeholder="indie films, small jazz gigs, no stadiums">${esc(user.interests)}</textarea>
</section>
<section><h2>3 · Budget (${esc(user.currency)})</h2>
  <div class="two">
    <div><label>Per month</label><input name="monthly" type="number" min="0" step="1" required value="${euros(user.monthly_limit_cents)}" placeholder="100"></div>
    <div><label>Surprise me up to</label><input name="auto" type="number" min="0" step="1" required value="${euros(user.auto_approve_cents)}" placeholder="25"></div>
  </div>
  <p class="small" style="margin-top:8px">I only book unasked when I'm really sure you'll love it. Everything else I ask about first.
  Tickets are paid from your prepaid credits: <a href="/wallet?t=${esc(token)}" style="color:inherit">add credits</a>.</p>
  <button type="submit">${user.onboarding_status === 'ready' ? 'Save' : 'Done, analyse me →'}</button>
</section>
</form>
<script>document.getElementById('tz').value=Intl.DateTimeFormat().resolvedOptions().timeZone</script>`),
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
    return c.html(
      page(`<h1>${user.onboarding_status === 'ready' ? 'Saved ✓' : 'Got it ✓'}</h1>
<p>${user.onboarding_status === 'ready' ? 'Your settings are updated.' : "I'm reading your calendar and inbox now. You'll get a WhatsApp message in a minute or two."}</p>
<p>You can close this tab.</p>`),
    );
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
