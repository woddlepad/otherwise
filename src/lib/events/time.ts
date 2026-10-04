// Timezone helpers without a date library: pages give local wall-clock times ("2026-10-17T19:00"),
// we store UTC instants.

/** Offset of `tz` from UTC at `instant`, in minutes (e.g. -420 for PDT). */
function offsetMinutes(instant: Date, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** "2026-10-17T19:00" (wall clock in `tz`) → UTC Date. Handles DST by re-checking the offset once. */
export function zonedToUtc(local: string, tz: string): Date | null {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00'] = m;
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi);
  let ts = guess - offsetMinutes(new Date(guess), tz) * 60_000;
  ts = guess - offsetMinutes(new Date(ts), tz) * 60_000;
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** UTC Date → "2026-10-17T19:00" in `tz`. */
export function utcToLocal(date: Date, tz: string) {
  const shifted = new Date(date.getTime() + offsetMinutes(date, tz) * 60_000);
  return shifted.toISOString().slice(0, 16);
}

/** "Sat 17 Oct, 19:00" — for prompts and WhatsApp. */
export function formatLocal(date: Date, tz: string, withTime = true) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : {}),
  }).format(date);
}

export const isoDay = (date: Date, tz: string) => utcToLocal(date, tz).slice(0, 10);
