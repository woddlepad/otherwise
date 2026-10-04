// Builds a city's onboarding starter deck ahead of time (docs/onboarding/PLAN.md), then prints what's in it.
//   npx tsx scripts/starter-deck.ts Berlin
//   npx tsx scripts/starter-deck.ts "San Francisco" --tz America/Los_Angeles
//   npx tsx scripts/starter-deck.ts Berlin --show        # print the current deck, don't rebuild (no Exa cost)
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { db } from '../src/lib/db';
import { ensureStarterDeck, isPhoto, userCity } from '../src/lib/events/starter';
import { formatLocal } from '../src/lib/events/time';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { tz: { type: 'string' }, show: { type: 'boolean', default: false } },
});
const city = positionals.join(' ').trim();
if (!city) throw new Error('usage: npx tsx scripts/starter-deck.ts <city> [--tz Area/City] [--show]');
const timezone = args.tz ?? userCity({ phone: '', city, timezone: process.env.DEFAULT_TIMEZONE ?? null }).timezone;

const t0 = Date.now();
const deck = args.show
  ? (await db.query(`SELECT status, event_ids FROM starter_decks WHERE city_key = lower($1)`, [city])).rows.map(r => ({ status: r.status, eventIds: r.event_ids }))[0]
  : await ensureStarterDeck(city, timezone, { force: true, wait: true });
if (!deck) throw new Error(`no deck for ${city}`);
const { rows } = await db.query(
  `SELECT e.title, e.category, e.tags, e.venue, e.starts_at, e.status, e.details FROM events e
   WHERE e.id = ANY($1::uuid[]) ORDER BY array_position($1::uuid[], e.id)`,
  [deck.eventIds],
);
const upcoming = rows.filter(r => new Date(r.starts_at) > new Date());
const byCat = new Map<string, number>();
for (const r of upcoming) byCat.set(r.category, (byCat.get(r.category) ?? 0) + 1);
for (const r of upcoming) {
  console.log(
    `${formatLocal(new Date(r.starts_at), timezone).padEnd(18)} ${r.category.padEnd(11)} ${r.title.slice(0, 55).padEnd(55)} ` +
      `@ ${(r.venue ?? '?').slice(0, 30)} · ${r.status} · ${r.details.priceText ?? (r.details.priceMinCents === 0 ? 'free' : 'price ?')}` +
      `${isPhoto(r.details.image) ? ' · 📷' : ''}`,
  );
}
console.log(
  `\n${city} (${timezone}): status ${deck.status}, ${deck.eventIds.length} events in the deck, ${upcoming.length} upcoming, ` +
    `${upcoming.filter(r => isPhoto(r.details.image)).length} with an image, ${Date.now() - t0} ms` +
    `\ncategories: ${[...byCat].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}`,
);
await db.end();
