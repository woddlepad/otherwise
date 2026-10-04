import React from 'react';
import {AbsoluteFill, Freeze, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {C, FONT} from '../theme';
import {BrowserWindow} from './BrowserWindow';
import {StageBackground} from './StageBackground';
import {clamp, inOut, sp} from './anim';

/** A piece of the source recording, in SOURCE seconds, played at `playbackRate`. */
export type WebSegment = {from: number; to: number; playbackRate?: number};

export type WebScrollProps = {
  /** Path under public/. The proxy is 2560x1440 60 fps, 0 to 44.7 s of the source recording. */
  src?: string;
  segments: WebSegment[];
  /** Cross-dissolve length (frames) wherever a segment skips source time. Contiguous segments butt-join. */
  crossfade?: number;
  url?: string;
  /** Page-area width of the browser window in px (16:9 page area). */
  windowWidth?: number;
  /** Total slow push-in over the whole clip (0.04 = 4 %). */
  pushIn?: number;
  /** Window rises in on a spring at the start. */
  enter?: boolean;
  /** Frames to hold the last frame of the last segment (the push-in keeps moving). */
  holdEnd?: number;
};

// The default ~25 s cut (see public/recordings/web-scroll.md for the timestamp map).
export const WEB_SCROLL_DEFAULTS: WebScrollProps = {
  src: 'recordings/web-scroll.mp4',
  segments: [
    {from: 3.9, to: 6.4, playbackRate: 1}, // hero, still
    {from: 6.4, to: 12.6, playbackRate: 1.1}, // scroll to the week, calendar fills, "Plan it around" switching
    {from: 13.0, to: 21.7, playbackRate: 1.15}, // into "Last week", five card swipes, ends on Harvest Fest
    {from: 23.0, to: 29.0, playbackRate: 1.1}, // "You set two numbers": the budget wheel runs $120 -> $81 -> $43
    {from: 29.0, to: 32.0, playbackRate: 1}, // setup steps, "Careful with your inbox and your card", closing card
  ],
  holdEnd: 36,
  crossfade: 8,
  url: 'otherwise-homepage.vercel.app',
  windowWidth: 1600,
  pushIn: 0.03,
  enter: true,
};

export const planSegments = (segments: WebSegment[], fps: number, crossfade = 8) => {
  let cursor = 0;
  return segments.map((seg, i) => {
    const rate = seg.playbackRate ?? 1;
    const duration = Math.max(1, Math.round(((seg.to - seg.from) * fps) / rate));
    const prev = segments[i - 1];
    const fade = i > 0 && Math.abs(seg.from - prev.to) > 0.05 ? crossfade : 0;
    const start = Math.max(0, cursor - fade);
    cursor = start + duration;
    return {...seg, rate, duration, start, fade, end: cursor};
  });
};

export const webScrollDuration = (segments: WebSegment[], fps: number, crossfade = 8, holdEnd = 0) => {
  const plan = planSegments(segments, fps, crossfade);
  return (plan.length ? plan[plan.length - 1].end : 1) + holdEnd;
};

const Piece: React.FC<{src: string; from: number; rate: number; fade: number}> = ({src, from, rate, fade}) => {
  const f = useCurrentFrame();
  const {fps} = useVideoConfig();
  const opacity = fade ? interpolate(f, [0, fade], [0, 1], {...clamp, easing: inOut}) : 1;
  return (
    <AbsoluteFill style={{opacity}}>
      <OffthreadVideo
        src={src}
        trimBefore={Math.round(from * fps)}
        playbackRate={rate}
        muted
        style={{width: '100%', height: '100%', objectFit: 'cover'}}
      />
    </AbsoluteFill>
  );
};

export const WebScroll: React.FC<WebScrollProps> = ({
  src = 'recordings/web-scroll.mp4',
  segments,
  crossfade = 8,
  url,
  windowWidth = 1600,
  pushIn = 0.03,
  enter = true,
  holdEnd = 0,
}) => {
  const f = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const plan = planSegments(segments, fps, crossfade);
  const file = /^(https?:|\/)/.test(src) ? src : staticFile(src);

  const rise = enter ? sp(f, fps, 0, {damping: 200, stiffness: 70}, 30) : 1;
  const push = 1 + pushIn * interpolate(f, [0, durationInFrames], [0, 1], {...clamp, easing: inOut});

  return (
    <AbsoluteFill style={{fontFamily: FONT, color: C.ink, overflow: 'hidden'}}>
      <StageBackground focus={{x: 0.5, y: 0.5}} intensity={0.9} />
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center'}}>
        <div
          style={{
            transform: `translateY(${(1 - rise) * 60}px) scale(${push * (0.97 + 0.03 * rise)})`,
            opacity: interpolate(rise, [0, 0.5], [0, 1], clamp),
            transformOrigin: '50% 45%',
          }}
        >
          <BrowserWindow width={windowWidth} url={url}>
            {plan.map((p, i) => (
              <Sequence key={i} from={p.start} durationInFrames={p.duration} layout="none">
                <Piece src={file} from={p.from} rate={p.rate} fade={p.fade} />
              </Sequence>
            ))}
            {holdEnd > 0 && plan.length ? (
              <Sequence from={plan[plan.length - 1].end} durationInFrames={holdEnd} layout="none">
                <Freeze frame={plan[plan.length - 1].duration - 1}>
                  <Piece src={file} from={plan[plan.length - 1].from} rate={plan[plan.length - 1].rate} fade={0} />
                </Freeze>
              </Sequence>
            ) : null}
          </BrowserWindow>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
