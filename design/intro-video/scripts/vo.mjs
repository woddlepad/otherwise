// Generates voiceover with ElevenLabs, one clip per script beat.
// Usage: ELEVEN_LABS_API_KEY=... node scripts/vo.mjs [--set demo|intro] [--measure] [id ...]   (no ids = all of the set)
//   --measure re-reads existing clips (speech start/end, loudness) without calling ElevenLabs.
//   --normalize (intro only) loudness-normalizes existing clips to -16 LUFS without calling ElevenLabs.
//   demo (default): the 3-min demo, writes public/vo/<id>.mp3 and top-level entries in public/vo/manifest.json.
//   intro: the 21 s intro video, writes public/vo/intro-*.mp3 and manifest.json's "intro" section.
// Durations are in seconds; "speechStart"/"speechEnd" mark where the voice actually starts and stops in the clip.
import { writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

const VOICE = process.env.VOICE_ID ?? 'NOpBlnGInO9m6vDvFkFC';
const MODEL = process.env.VO_MODEL ?? 'eleven_multilingual_v2';
const KEY = process.env.ELEVEN_LABS_API_KEY;


export const LINES = [
  ['01-hook', "Most weeks have a free evening or two. And most of them end on the sofa. Not because nothing was on, but because finding it, deciding, and buying the ticket is just enough effort to skip it."],
  ['02-what', "Otherwise is an agent that does that part for you. It finds the free evenings in your week, fills them with things you'd actually pick, books them within a budget you set, and tells you on WhatsApp. No app to open."],
  ['03-numbers', "You set two numbers: a monthly budget, and how much it may spend without asking. Under that, it just books. Over it, it texts you first."],
  ['04-signup', "Let's set one up. Signing up takes one phone number. A setup link comes straight back."],
  ['05-onboarding', "It already knows what's on in your city this week. So instead of a questionnaire, you swipe real events. Yes to the indie gig, no to the techno night, yes to stand-up. Every swipe is taste. Then the two numbers, and that's it. Mail and calendar are optional: connected read-only, they tell it more about what you like and when you're free."],
  ['06-hello', "A minute later, it messages you first. It has a read on you, and it's already looking."],
  ['07-booking', "Here it found a film night that fits, under the auto-book limit, so it doesn't ask. It opens a real browser and goes through the checkout like you would. Before paying, it checks the total against the price it promised. The card is filled in by our code, so the AI never sees the number. Then: booked, ticket in your calendar."],
  ['08-settings', "Change your mind any time. Raise the budget, lower the limit, or just text it: nothing on weekdays. Text stop, and it stops."],
  ['09-close', "Otherwise. Because otherwise, you'd have stayed in."],
];

// The intro video: one line per scene, timed against src/timeline.ts.
export const INTRO_LINES = [
  ['intro-1-hero', "Otherwise, you'd have stayed in."],
  ['intro-2-week', "It finds the free evenings in your week, and fills them with things you'd pick."],
  ['intro-3-taste', "It learns your taste from your inbox."],
  ['intro-4-budget', "You set a budget. It books within it, and asks before anything bigger."],
  ['intro-5-whatsapp', "And it tells you on WhatsApp."],
  ['intro-6-close', "Next Thursday doesn't have to be empty."],
];

const args = process.argv.slice(2);
const setIdx = args.indexOf('--set');
const SET = setIdx >= 0 ? args.splice(setIdx, 2)[1] : 'demo';
if (!['demo', 'intro'].includes(SET)) throw new Error(`unknown set ${SET}`);
const lines = SET === 'intro' ? INTRO_LINES : LINES;
// the voice is slow; the intro needs it a touch quicker (ElevenLabs allows 0.7 to 1.2)
const SPEED = Number(process.env.VO_SPEED ?? (SET === 'intro' ? 1.1 : 1));

const dir = new URL('../public/vo/', import.meta.url).pathname;
const manifestPath = dir + 'manifest.json';
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
const MEASURE = args.includes('--measure') || args.includes('--normalize');
const NORMALIZE = args.includes('--normalize');
const only = args.filter((a) => !a.startsWith('--'));
const target = SET === 'intro' ? (manifest.intro ??= {}) : manifest;

if (!KEY && !MEASURE) throw new Error('ELEVEN_LABS_API_KEY missing');
for (const [i, [id, text]] of lines.entries()) {
  if (only.length && !only.includes(id)) continue;
  if (MEASURE) {
    const file = `${dir}${id}.mp3`;
    if (NORMALIZE) normalize(file);
    const sec = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());
    Object.assign(target[id], { seconds: Math.round(sec * 100) / 100 }, speechBounds(file, sec), { lufs: loudness(file) });
    console.log(id, target[id].speechStart, target[id].speechEnd);
    continue;
  }
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      model_id: MODEL,
      previous_text: lines[i - 1]?.[1],
      next_text: lines[i + 1]?.[1],
      voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true, ...(SPEED !== 1 && { speed: SPEED }) },
    }),
  });
  if (!res.ok) throw new Error(`${id}: ${res.status} ${await res.text()}`);
  const file = `${dir}${id}.mp3`;
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const sec = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());
  const round = (x) => Math.round(x * 100) / 100;
  const entry = { file: `vo/${id}.mp3`, seconds: round(sec), text };
  if (SET === 'intro') {
    normalize(file);
    Object.assign(entry, speechBounds(file, sec), { speed: SPEED, lufs: loudness(file) });
  }
  target[id] = entry;
  console.log(id, entry.seconds + 's', entry.speechStart !== undefined ? `(speech ${entry.speechStart}-${entry.speechEnd})` : '');
}
// where the voice starts and stops inside a clip: silence is anything 16 dB under the clip's integrated loudness
// for 80 ms or more (so breaths at the end don't count as speech)
function loudness(file) {
  const log = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  return Number([...log.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].pop()[1]);
}
function speechBounds(file, sec) {
  const floor = Math.round(loudness(file) - 16);
  const log = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', `silencedetect=noise=${floor}dB:d=0.08`, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  return parseSilence(log, sec);
}
// two-pass loudnorm to -16 LUFS / -1.5 dBTP, so every intro line sits at the same level in the mix
function normalize(file) {
  const tmp = file.replace(/\.mp3$/, '.norm.mp3');
  const first = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const m = JSON.parse(first.slice(first.lastIndexOf('{')));
  const af = `loudnorm=I=-16:TP=-1.5:LRA=11:linear=true:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}`;
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-af', af, '-ar', '44100', '-b:a', '128k', tmp]);
  renameSync(tmp, file);
}
function parseSilence(log, sec) {
  const starts = [...log.matchAll(/silence_start: ([\d.]+)/g)].map((m) => +m[1]);
  const ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
  const gaps = starts.map((s0, i) => [s0, ends[i] ?? sec]);
  // leading silence: a gap that starts at 0
  const lead = gaps.length && gaps[0][0] < 0.05 ? gaps[0][1] : 0;
  // trailing silence: the first gap of 0.25 s or more after which only breath or noise (< 0.6 s) remains
  const tail = gaps.find(([a, b]) => b - a >= 0.25 && sec - b < 0.6 && a > lead);
  const r = (x) => Math.round(x * 100) / 100;
  return { speechStart: r(lead), speechEnd: r(tail ? tail[0] : sec) };
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
