import { db } from '../db';

/**
 * Geocoding with OpenStreetMap Nominatim (data © OpenStreetMap contributors, ODbL; show that attribution wherever
 * coordinates or maps are shown). Usage policy: ≤1 request/s, a real User-Agent, cache results. So:
 * - every request in this process goes through one promise chain with ≥1.1 s spacing;
 * - each venue is geocoded once (hit or miss: `geocoded_at` is set), a call handles at most `limit` venues;
 * - the user's home area is geocoded once into users.home_lat/home_lng.
 * Nothing here throws: failures are logged and the event simply has no distance.
 */

export type LatLng = { lat: number; lng: number };

const SPACING_MS = 1100;
const USER_AGENT = () => process.env.NOMINATIM_USER_AGENT || 'booking-agent/0.1 (hackathon demo)';

let chain: Promise<unknown> = Promise.resolve();
let lastAt = 0;

/** Runs `fn` after every earlier request, at least SPACING_MS after the previous one finished. */
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = lastAt + SPACING_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      lastAt = Date.now();
    }
  });
  chain = run.catch(() => {});
  return run;
}

/** One Nominatim search. null = no result; throws on HTTP/network errors (so callers don't cache a miss). */
async function nominatim(q: string): Promise<LatLng | null> {
  return throttled(async () => {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT(), Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`nominatim ${res.status}`);
    const rows = (await res.json()) as { lat: string; lon: string }[];
    const hit = rows[0];
    if (!hit) return null;
    const lat = Number(hit.lat);
    const lng = Number(hit.lon);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  });
}

/** Tries the most specific query first, then looser ones; stops at the first hit. */
async function geocodeFirst(queries: string[], budget: { left: number }): Promise<LatLng | null> {
  for (const q of [...new Set(queries.filter(Boolean))]) {
    if (budget.left <= 0) throw new Error('request budget used up');
    budget.left--;
    const hit = await nominatim(q);
    if (hit) return hit;
  }
  return null;
}

const join = (...parts: (string | null | undefined)[]) => parts.map(p => p?.trim()).filter(Boolean).join(', ');

/**
 * Geocodes up to `limit` venues that were never tried (venues with upcoming events first).
 * Returns how many were found / missed. ≤ limit + 5 requests per call (a miss tries looser queries while budget lasts).
 */
export async function geocodeVenues(limit = 10): Promise<{ found: number; missed: number; failed: number }> {
  const out = { found: 0, missed: 0, failed: 0 };
  try {
    const { rows } = await db.query<{ id: string; name: string; address: string | null; city: string | null }>(
      `SELECT v.id, v.name, v.address, v.city FROM venues v
       WHERE v.lat IS NULL AND v.geocoded_at IS NULL
       ORDER BY EXISTS (SELECT 1 FROM events e WHERE e.venue_id = v.id AND e.starts_at > now()) DESC, v.created_at DESC
       LIMIT $1`,
      [limit],
    );
    const budget = { left: limit + 5 };
    for (const v of rows) {
      try {
        const address = v.address?.replace(/\s*\([^)]*\)/g, '').trim() || null;
        const queries = address
          ? [join(v.name, address, v.city), join(address, v.city), join(v.name, v.city)]
          : [join(v.name, v.city)];
        const hit = await geocodeFirst(queries, budget);
        await db.query(
          `UPDATE venues SET lat = $2, lng = $3, geocoded_at = now(), geocode_source = $4 WHERE id = $1`,
          [v.id, hit?.lat ?? null, hit?.lng ?? null, hit ? 'nominatim' : 'nominatim:none'],
        );
        if (hit) out.found++;
        else out.missed++;
      } catch (err) {
        out.failed++;
        console.warn('[geocode] venue failed', v.name, String(err).slice(0, 160));
        if (/budget|429|403/.test(String(err))) break; // rate-limited or out of budget: the rest wait for the next run
      }
    }
  } catch (err) {
    console.warn('[geocode] venues failed', String(err).slice(0, 200));
  }
  return out;
}

/**
 * The user's home (taste_profiles.profile.homeArea + users.city, or just the city) → users.home_lat/home_lng,
 * geocoded once. Returns the stored or new coordinates, or null.
 */
export async function geocodeUserHome(userId: string): Promise<LatLng | null> {
  try {
    const { rows } = await db.query<{ city: string | null; home_lat: number | null; home_lng: number | null; home_area: string | null }>(
      `SELECT u.city, u.home_lat, u.home_lng, t.profile->>'homeArea' AS home_area
       FROM users u LEFT JOIN taste_profiles t ON t.user_id = u.id WHERE u.id = $1`,
      [userId],
    );
    const u = rows[0];
    if (!u) return null;
    if (u.home_lat !== null && u.home_lng !== null) return { lat: u.home_lat, lng: u.home_lng };
    if (!u.home_area && !u.city) return null;
    const area = u.home_area && u.city && u.home_area.toLowerCase().includes(u.city.toLowerCase()) ? u.home_area : join(u.home_area, u.city);
    const hit = await geocodeFirst([area, join(u.city)], { left: 2 });
    if (!hit) return null;
    await db.query(`UPDATE users SET home_lat = $2, home_lng = $3 WHERE id = $1 AND home_lat IS NULL`, [userId, hit.lat, hit.lng]);
    return hit;
  } catch (err) {
    console.warn('[geocode] user home failed', String(err).slice(0, 200));
    return null;
  }
}

/** Great-circle distance in km. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}
