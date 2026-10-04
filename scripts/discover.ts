// Tune event discovery without WhatsApp or the database.
//   npx tsx scripts/discover.ts                              # fixture taste (SF), LLM plan + rating
//   npx tsx scripts/discover.ts --hint "jazz on Friday"      # like a chat request
//   npx tsx scripts/discover.ts --no-llm --days 7            # templates + keyword rating, Exa only
//   npx tsx scripts/discover.ts --user +4915100000000        # real user from the DB, full run incl. storing
// Run with `env -u ANTHROPIC_BASE_URL -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN` inside the coding-agent shell.
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { defaultWindow, discover, dropUnreachable, finalizePicks, findCandidates } from '../src/lib/events/discover';
import { scoreEvents } from '../src/lib/events/score';
import { formatLocal } from '../src/lib/events/time';
import type { Candidate, DiscoveryContext, ScoredEvent, StoredEvent } from '../src/lib/events/types';

const { values: args } = parseArgs({
  options: {
    fixture: { type: 'string', default: 'scripts/fixtures/taste-sf.json' },
    hint: { type: 'string' },
    category: { type: 'string', multiple: true },
    days: { type: 'string', default: '14' },
    'no-llm': { type: 'boolean', default: false },
    'no-cache': { type: 'boolean', default: false },
    fast: { type: 'boolean', default: false },
    user: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});
if (args['no-llm']) process.env.DISCOVERY_NO_LLM = '1';
if (args['no-cache']) process.env.DISCOVERY_NO_CACHE = '1';

function print(events: ScoredEvent[], tz: string) {
  for (const e of events) {
    const when = e.hasTime ? formatLocal(e.startsAt, tz) : `${formatLocal(e.startsAt, tz, false)} (time?)`;
    console.log(
      `${e.confidence.toFixed(2)} ${e.decision.action.padEnd(4)} ${when.padEnd(18)} ${e.title.slice(0, 60)}` +
        `\n     @ ${[e.venue ?? '?', e.address, e.city].filter(Boolean).join(' · ')}${e.online ? ' (online)' : ''} · ${e.priceText ?? 'price ?'}` +
        `${e.distanceKm !== null ? ` · ${e.distanceKm} km` : ''}\n     status ${e.status}${e.onSaleAt ? ` (on sale ${e.onSaleAt})` : ''} (checked ${formatLocal(new Date(e.statusCheckedAt), tz)}) · ` +
        `book ${e.bookingUrl ?? '-'}\n     url ${e.url}\n     ${e.reason} [${e.decision.reason}]` +
        `\n     ${e.category} [${e.tags.join(', ')}] ${e.attrs.timeOfDay}${e.attrs.weekend ? ' weekend' : ''} ${e.attrs.priceBand} · matches: ${e.matches?.join(', ') || '-'}` +
        (e.cancellation
          ? `\n     ↩ ${e.cancellation.summary} [method ${e.cancellation.method}${e.cancellation.contact ? ` ${e.cancellation.contact}` : ''}` +
            `, transferable ${e.cancellation.transferable ?? '?'}]${e.cancellation.quote ? ` — "${e.cancellation.quote.slice(0, 120)}"` : ''}` +
            `\n       scope ${e.cancellation.scope} · source ${e.cancellation.source}${e.cancellation.platform ? ` · platform ${e.cancellation.platform}` : ''}` +
            ` · cancelBy ${e.cancellation.cancelBy ?? '-'} · cancelUrl ${e.cancellation.cancellationUrl ?? '-'} · policyUrl ${e.cancellation.policyUrl ?? '-'}`
          : ''),
    );
  }
}

/** How much of the v3 extraction came through. */
function coverage(cands: Candidate[], city: string) {
  const pct = (f: (c: Candidate) => boolean) => `${Math.round((100 * cands.filter(f).length) / Math.max(1, cands.length))}%`;
  const statuses = new Map<string, number>();
  for (const c of cands) statuses.set(c.status, (statuses.get(c.status) ?? 0) + 1);
  return (
    `v3 fields: bookingUrl ${pct(c => !!c.bookingUrl)} · status≠unknown ${pct(c => c.status !== 'unknown')} · ` +
    `address ${pct(c => !!c.address)} · city≠${city} ${pct(c => c.city.toLowerCase() !== city.toLowerCase())} · online ${pct(c => c.online)}` +
    `\nstatuses: ${[...statuses].map(([k, v]) => `${k} ${v}`).join(' · ')}`
  );
}

const t0 = Date.now();
if (args.user) {
  const { db, upsertUserByPhone } = await import('../src/lib/db');
  const user = await upsertUserByPhone(args.user);
  const res = await discover(user.id, { trigger: 'manual', hint: args.hint, window: defaultWindow(Number(args.days)) });
  console.log(`queries:\n${res.queries.map(q => `  - ${q.query}`).join('\n')}`);
  console.log(`${res.candidates.length} candidates, ${res.events.length} kept, $${res.costDollars.toFixed(3)}, ${Date.now() - t0} ms`);
  const { rows: [u] } = await db.query(`SELECT city FROM users WHERE id = $1`, [user.id]);
  console.log(`${coverage(res.candidates, u?.city || process.env.DEFAULT_CITY || 'San Francisco')}\n`);
  print(res.events, process.env.DEFAULT_TIMEZONE || 'America/Los_Angeles');
  const { getBookingHandoff } = await import('../src/lib/events/handoff');
  for (const e of res.events.slice(0, 3)) {
    console.log(`\nhandoff #${res.events.indexOf(e) + 1}:\n${JSON.stringify(await getBookingHandoff(user.id, e.id), null, 2)}`);
  }
  await db.end();
} else {
  const fx = JSON.parse(await readFile(args.fixture!, 'utf8'));
  const ctx: DiscoveryContext = {
    city: fx.city,
    timezone: fx.timezone,
    country: fx.country ?? (fx.timezone.startsWith('America/') ? 'US' : undefined),
    window: defaultWindow(Number(args.days)),
    taste: fx.taste,
    interests: fx.interests,
    hint: args.hint,
    categories: args.category as DiscoveryContext['categories'],
  };
  const found = await findCandidates(ctx, args.fast ? { maxQueries: 4 } : {});
  const tFound = Date.now() - t0;
  console.log(`queries:\n${found.queries.map(q => `  - ${q.query}  (${q.why})`).join('\n')}`);
  const perPage = found.pages.map(p => `${p.events.length.toString().padStart(3)} ${p.pageKind.padEnd(12)} ${p.pageUrl}`);
  console.log(`\npages (${found.pages.length}):\n${perPage.join('\n')}`);
  console.log(`\nwindow ${formatLocal(found.window.from, ctx.timezone)} → ${formatLocal(found.window.to, ctx.timezone)}`);
  console.log(`cache: ${found.cache.queries}/${found.queries.length} queries, ${found.cache.pages}/${found.pages.length} pages; ${found.cache.failedPages} pages without events`);
  const counts = new Map<string, number>();
  for (const c of found.candidates) counts.set(c.category, (counts.get(c.category) ?? 0) + 1);
  const byCat = [...counts].map(([k, v]) => `${k} ${v}`);
  console.log(`categories: ${byCat.join(' · ')}`);
  console.log(`${found.candidates.length} candidates in window, $${found.costDollars.toFixed(3)}, ${tFound} ms`);
  console.log(coverage(found.candidates, ctx.city));

  const all: StoredEvent[] = found.candidates.map((c, i) => ({ ...c, id: `c${i}`, venueId: null, venueLat: null, venueLng: null, distanceKm: null }));
  const pseudo = dropUnreachable(all);
  if (pseudo.length < all.length) console.log(`dropped ${all.length - pseudo.length} sold out / cancelled / postponed`);
  const scored = await finalizePicks(await scoreEvents(pseudo, ctx, null), ctx.timezone, 8).catch(async err => {
    console.warn('finalizePicks needs the DB for the policy cache:', String(err).slice(0, 120));
    return scoreEvents(pseudo, ctx, null);
  });
  console.log(`rated in ${Date.now() - t0 - tFound} ms\n`);
  if (args.json) console.log(JSON.stringify(scored, null, 2));
  else print(scored.slice(0, 15), ctx.timezone);
}
