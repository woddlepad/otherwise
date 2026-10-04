import React from 'react';
import {Html5Audio, Sequence, interpolate, staticFile} from 'remotion';
import manifest from '../public/vo/manifest.json';
import {FPS, TOTAL, VO, clamp} from './timeline';

// Voiceover + music, mixed in the composition so Studio previews exactly what renders.
// VO clips are loudness-normalised to -16 LUFS by scripts/vo.mjs; music (public/music/intro.mp3, ~-18 LUFS) ducks
// by 12 dB under every spoken line with 0.3 s ramps, comes back up between lines and fades out over the last second.

type Line = {file: string; seconds: number; speechStart: number; speechEnd: number};
const LINES = VO.map((v) => ({...v, ...(manifest.intro as Record<string, Line>)[v.id]}));

// spoken spans in absolute frames (breaths at the clip ends excluded)
export const SPEECH = LINES.map((l) => ({id: l.id, from: l.at + l.speechStart * FPS, to: l.at + l.speechEnd * FPS}));

const voFrames = (l: Line) => Math.ceil((l.speechEnd + 0.15) * FPS);
const VO_GAIN = 1.06;
const MUSIC_GAIN = 0.95;
const DUCK = 10 ** (-12 / 20); // -12 dB
const RAMP = 0.3 * FPS;

// The music is 21.02 s and the video 24.2 s. It runs 100 bpm (2.4 s bars) and bar 5 (9.6 to 12.0 s) is the tonic bar
// before the phrase repeats, so it plays twice: at music 12.0 s it crossfades back to 9.6 s, which adds exactly one
// bar and keeps the written ending. The start is offset so the music's own resolve lands on the last frame.
const MUSIC_FRAMES = 21.024 * FPS;
const LOOP_FROM = 9.6 * FPS; // 288
const LOOP_TO = 12.0 * FPS; // 360
const XF = 4; // crossfade frames around the downbeat
const MUSIC_START = Math.round(TOTAL - (MUSIC_FRAMES + (LOOP_TO - LOOP_FROM))); // 23: the first second of the file is near-silent anyway

const ease = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, t)));

// in a short gap between two lines (under 1.3 s) the music only comes halfway back up (-6 dB), so it doesn't pump
const SHORT_GAP = 1.3 * FPS;
const HALF = 0.5;

export const musicGain = (abs: number) => {
  let duck = 0;
  SPEECH.forEach((s, i) => {
    const d = abs < s.from ? ease((abs - (s.from - RAMP)) / RAMP) : abs > s.to ? ease(1 - (abs - s.to) / RAMP) : 1;
    duck = Math.max(duck, d);
    const next = SPEECH[i + 1];
    if (next && next.from - s.to < SHORT_GAP && abs > s.to && abs < next.from) duck = Math.max(duck, HALF);
  });
  const fadeOut = interpolate(abs, [TOTAL - FPS, TOTAL - 1], [1, 0], clamp);
  return MUSIC_GAIN * interpolate(duck, [0, 1], [1, DUCK]) * ease(fadeOut);
};

// stem: render only the voiceover or only the music (for checking timing and levels), default both
export const Soundtrack: React.FC<{stem?: 'vo' | 'music'}> = ({stem}) => {
  const aFrom = MUSIC_START;
  const bFrom = MUSIC_START + LOOP_TO - XF / 2;
  return (
    <>
      {stem !== 'vo' && (
        <>
      {/* music, part A: from the top to the end of bar 5 */}
      <Sequence from={aFrom} durationInFrames={LOOP_TO + XF / 2} layout="none" name="Music A">
        <Html5Audio
          src={staticFile('music/intro.mp3')}
          volume={(f) => musicGain(aFrom + f) * Math.cos((Math.PI / 2) * interpolate(f, [LOOP_TO - XF / 2, LOOP_TO + XF / 2], [0, 1], clamp))}
        />
      </Sequence>
      {/* music, part B: bar 5 again, then on to the written ending */}
      <Sequence from={bFrom} durationInFrames={TOTAL - bFrom} layout="none" name="Music B">
        <Html5Audio
          src={staticFile('music/intro.mp3')}
          trimBefore={LOOP_FROM - XF / 2}
          volume={(f) => musicGain(bFrom + f) * Math.sin((Math.PI / 2) * interpolate(f, [0, XF], [0, 1], clamp))}
        />
      </Sequence>
        </>
      )}
      {stem !== 'music' && LINES.map((l) => (
        // each clip stops 0.15 s after its last word (with a 4-frame fade) so trailing breaths don't spill into the next scene
        <Sequence key={l.id} from={l.at} durationInFrames={voFrames(l)} layout="none" name={l.id}>
          <Html5Audio src={staticFile(l.file)} volume={(f) => VO_GAIN * interpolate(f, [voFrames(l) - 4, voFrames(l)], [1, 0], clamp)} />
        </Sequence>
      ))}
    </>
  );
};
