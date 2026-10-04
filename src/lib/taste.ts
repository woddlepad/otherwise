import { z } from 'zod';
import { db } from './db';

export const tasteProfileSchema = z.object({
  summary: z.string().describe('2–3 sentences, second person: "You love ..."'),
  likes: z
    .array(
      z.object({
        category: z.string().describe('e.g. "films", "live jazz", "stand-up", "tech meetups"'),
        specifics: z.array(z.string()).describe('artists, genres, directors, series, venues'),
        evidence: z.string().describe('what in the data shows this, short'),
        strength: z.number().min(0).max(1),
      }),
    )
    .describe('strongest first'),
  dislikes: z.array(z.string()),
  favoriteVenues: z.array(z.string()),
  typicalTicketPrice: z.number().nullable().describe('per ticket, major currency units'),
  currency: z.string().nullable(),
  usualCompany: z.string().nullable().describe('alone / partner / friends; who, if obvious'),
  usualTicketCount: z.number().int().min(1).nullable(),
  preferredTimes: z.string().nullable().describe('e.g. "weekday evenings after 19:00, weekend afternoons"'),
  homeArea: z.string().nullable(),
  openQuestions: z.array(z.string()).describe('things worth asking the user to sharpen the profile'),
});
export type TasteProfile = z.infer<typeof tasteProfileSchema>;

export type StoredTaste = {
  profile: TasteProfile | null;
  summary: string | null;
  notes: string[];
  autoBookConfidence: number;
  askConfidence: number;
};

export async function getTaste(userId: string): Promise<StoredTaste> {
  const { rows } = await db.query(
    `SELECT profile, summary, notes, auto_book_confidence, ask_confidence FROM taste_profiles WHERE user_id = $1`,
    [userId],
  );
  const r = rows[0];
  return {
    profile: r && Object.keys(r.profile).length ? r.profile : null,
    summary: r?.summary ?? null,
    notes: r?.notes ?? [],
    autoBookConfidence: r?.auto_book_confidence ?? 0.85,
    askConfidence: r?.ask_confidence ?? 0.5,
  };
}

export async function saveTasteProfile(userId: string, profile: TasteProfile) {
  await db.query(
    `INSERT INTO taste_profiles (user_id, profile, summary) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET profile = EXCLUDED.profile, summary = EXCLUDED.summary, updated_at = now()`,
    [userId, profile, profile.summary],
  );
}

export async function addTasteNote(userId: string, note: string) {
  await db.query(
    `INSERT INTO taste_profiles (user_id, notes) VALUES ($1, ARRAY[$2])
     ON CONFLICT (user_id) DO UPDATE SET notes = array_append(taste_profiles.notes, $2), updated_at = now()`,
    [userId, note],
  );
}

/** Compact text block for prompts. */
export function tasteForPrompt(t: StoredTaste) {
  if (!t.profile && !t.notes.length) return 'No taste profile yet.';
  const p = t.profile;
  const lines = [
    p?.summary,
    p?.likes.length && `Likes: ${p.likes.map(l => `${l.category} (${l.specifics.join(', ')}; strength ${l.strength})`).join('; ')}`,
    p?.dislikes.length && `Dislikes: ${p.dislikes.join(', ')}`,
    p?.favoriteVenues.length && `Favourite venues: ${p.favoriteVenues.join(', ')}`,
    p?.typicalTicketPrice != null && `Typical ticket price: ${p.typicalTicketPrice} ${p.currency ?? ''}`,
    p?.usualCompany && `Usually goes: ${p.usualCompany} (${p.usualTicketCount ?? '?'} tickets)`,
    p?.preferredTimes && `Preferred times: ${p.preferredTimes}`,
    t.notes.length && `Learned since:\n- ${t.notes.join('\n- ')}`,
  ];
  return lines.filter(Boolean).join('\n');
}
