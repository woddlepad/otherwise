import { registerApiRoute } from '@mastra/core/server';
import { db } from '../../lib/db';
import { recordSwipe, seedStarterSuggestions, starterDeckFor, userCity } from '../../lib/events/starter';

// Onboarding v2 starter deck API (docs/onboarding/PLAN.md "API"). All endpoints use the onboarding token.

async function userIdByToken(token: unknown): Promise<string | null> {
  if (typeof token !== 'string' || !token) return null;
  const { rows } = await db.query(`SELECT id FROM users WHERE onboarding_token = $1`, [token]);
  return rows[0]?.id ?? null;
}

/** The unswiped starter cards in deck order; status 'building' → the client polls every 3 s. */
export const onboardDeck = registerApiRoute('/onboard/deck', {
  method: 'GET',
  requiresAuth: false,
  handler: async c => {
    const userId = await userIdByToken(c.req.query('t'));
    if (!userId) return c.json({ error: 'unknown token' }, 404);
    return c.json(await starterDeckFor(userId));
  },
});

/** JSON { t, suggestionId, verdict: 'like' | 'dislike' } → { ok, liked, disliked }. */
export const onboardSwipe = registerApiRoute('/onboard/swipe', {
  method: 'POST',
  requiresAuth: false,
  handler: async c => {
    const body = await c.req.json().catch(() => ({}));
    const userId = await userIdByToken(body.t);
    if (!userId) return c.json({ error: 'unknown token' }, 404);
    if (!['like', 'dislike'].includes(body.verdict) || !/^[0-9a-f-]{36}$/i.test(String(body.suggestionId ?? ''))) {
      return c.json({ error: 'need suggestionId and verdict like|dislike' }, 400);
    }
    const counts = await recordSwipe(userId, body.suggestionId, body.verdict);
    if (!counts) return c.json({ error: 'unknown card' }, 404);
    return c.json({ ok: true, ...counts });
  },
});

/** JSON { t, city, interests, tz } → saves as you go; a changed city reseeds the deck (a build runs in the background). */
export const onboardProfile = registerApiRoute('/onboard/profile', {
  method: 'POST',
  requiresAuth: false,
  handler: async c => {
    const body = await c.req.json().catch(() => ({}));
    const userId = await userIdByToken(body.t);
    if (!userId) return c.json({ error: 'unknown token' }, 404);
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const tz = str(body.tz).slice(0, 64);
    const validTz = (() => {
      try {
        return !!tz && !!new Intl.DateTimeFormat('en', { timeZone: tz });
      } catch {
        return false;
      }
    })();
    const { rows } = await db.query(
      `UPDATE users SET city = COALESCE(NULLIF($2, ''), city),
         interests = CASE WHEN $5 THEN NULLIF($3, '') ELSE interests END,
         timezone = COALESCE($4, timezone)
       WHERE id = $1 RETURNING phone, city, timezone`,
      [userId, str(body.city).slice(0, 80), str(body.interests).slice(0, 2000), validTz ? tz : null, typeof body.interests === 'string'],
    );
    // Seeding is a no-op while the city stays the same.
    const deckStatus = await seedStarterSuggestions(userId, { wait: false });
    return c.json({ ok: true, city: userCity(rows[0]).city, deckStatus });
  },
});
