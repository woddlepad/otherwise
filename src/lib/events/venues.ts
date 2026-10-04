import { db } from '../db';

/**
 * Venue identity (schema v3). One `venues` row per normalised name per city, so "Cobb's Comedy Club",
 * "Cobbs Comedy Club" and "The Cobb's Comedy Club" share a row (and later its geocode and cancellation policy).
 */

/**
 * Merge key for venue names: "The Cobb's Comedy Club" / "Cobbs Comedy Club" → "cobbscomedyclub";
 * "Balboa Theatre" / "Balboa Theater" → "balboa"; "SF Jazz" / "SFJAZZ Center" → "sfjazz".
 */
export function normVenueName(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/\s*[,|•·]\s*/)[0]
    .replace(/['’‘`´]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const stripped = base.replace(/\b(the|theatre|theater|theatres|theaters|center|centre)\b/g, '').replace(/\s+/g, '');
  return stripped || base.replace(/\s+/g, '');
}

export type VenueInput = { name: string; address?: string | null; city?: string | null; domain?: string | null };

/** "201 Franklin St., 94102" / "201 Franklin Street" → "201 franklin st". */
export function normAddress(address: string): string {
  return address
    .toLowerCase()
    .split(',')[0]
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\bstreet\b/g, 'st')
    .replace(/\bavenue\b/g, 'ave')
    .replace(/\bboulevard\b/g, 'blvd')
    .replace(/\broad\b/g, 'rd')
    .replace(/\bdrive\b/g, 'dr')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Inserts or finds the venue (same street address in the city, else normalised name + city) and returns its id. On conflict, fills address/domain
 * when the row has none; a newly learned address re-arms geocoding if the earlier name-only lookup missed.
 * Returns null on DB errors (callers store the event without a venue).
 */
export async function upsertVenue(v: VenueInput): Promise<string | null> {
  const name = v.name.trim();
  const norm = normVenueName(name);
  if (!norm) return null;
  try {
    // Same street address in the same city = same venue under another name ("Miner Auditorium" at SFJAZZ Center).
    const addr = v.address && /\d/.test(v.address) ? normAddress(v.address) : '';
    if (addr) {
      const { rows: same } = await db.query<{ id: string; address: string }>(
        `SELECT id, address FROM venues WHERE address IS NOT NULL AND lower(coalesce(city, '')) = lower(coalesce($1, ''))`,
        [v.city ?? null],
      );
      const hit = same.find(r => normAddress(r.address) === addr);
      if (hit) {
        await db.query(`UPDATE venues SET domain = coalesce(domain, $2) WHERE id = $1`, [hit.id, v.domain ?? null]);
        return hit.id;
      }
    }
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO venues (name, norm_name, address, city, domain) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (norm_name, lower(coalesce(city, ''))) DO UPDATE SET
         address = coalesce(venues.address, EXCLUDED.address),
         domain = coalesce(venues.domain, EXCLUDED.domain),
         geocoded_at = CASE WHEN venues.address IS NULL AND EXCLUDED.address IS NOT NULL AND venues.lat IS NULL
                            THEN NULL ELSE venues.geocoded_at END
       RETURNING id`,
      [name, norm, v.address ?? null, v.city ?? null, v.domain ?? null],
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    console.warn('[venues] upsert failed', name, String(err).slice(0, 200));
    return null;
  }
}

/** Coordinates for venue ids (only geocoded ones). */
export async function venueCoords(ids: (string | null)[]): Promise<Map<string, { lat: number; lng: number }>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return new Map();
  try {
    const { rows } = await db.query<{ id: string; lat: number; lng: number }>(
      `SELECT id, lat, lng FROM venues WHERE id = ANY($1::uuid[]) AND lat IS NOT NULL`,
      [want],
    );
    return new Map(rows.map(r => [r.id, { lat: r.lat, lng: r.lng }]));
  } catch {
    return new Map();
  }
}
