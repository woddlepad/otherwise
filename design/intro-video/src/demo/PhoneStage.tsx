import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {C, FONT} from '../theme';
import {RiseWords} from '../RiseWords';
import {IPhone14Pro, IPHONE} from './IPhone14Pro';
import {HeaderCover, type HeaderCoverProps} from './HeaderCover';
import {FakeWhatsApp, WA} from './FakeWhatsApp';
import {StageBackground} from './StageBackground';
import {clamp, inOut, lerp, mix, sp} from './anim';

/**
 * A camera move onto a region of the phone screen.
 * Ramps in over `ramp` frames from `start`, holds, and ramps back out so that it is at rest again at `end`.
 * `x`/`y` are in SCREEN pixels (1179 x 2556); that point travels to `targetX`/`targetY` in stage px (default: frame centre).
 * Later zooms override earlier ones, so to pan straight from one region to another, let the earlier zoom's `end`
 * run past the later one's `start + ramp`.
 */
export type PhoneZoom = {
  start: number;
  end: number;
  x: number;
  y: number;
  scale: number;
  ramp?: number;
  targetX?: number;
  targetY?: number;
};

export type PhoneStageProps = {
  /** Headline lines; words rise in one by one, like the intro's "And texts you on WhatsApp." */
  headline: string[];
  sub?: string;
  /** Recording for the screen (path under public/). Without it, the placeholder WhatsApp chat is shown. */
  src?: string;
  startFrom?: number;
  endAt?: number;
  playbackRate?: number;
  /** Header patch over the Twilio avatar + number (screen px). `null` to turn it off. */
  header?: HeaderCoverProps | null;
  zooms?: PhoneZoom[];
  /** Device height in px. Defaults: 940 (16:9), 1240 (9:16). */
  phoneHeight?: number;
  /** Device centre x in px (16:9 default 1330). */
  phoneCenterX?: number;
  finish?: 'space-black' | 'deep-purple';
  /** Frame the phone starts rising. The caption follows a few frames later. */
  enterAt?: number;
  captionAt?: number;
};

export const PHONE_STAGE_DEFAULTS: PhoneStageProps = {
  headline: ['A minute later,', 'it texts you first.'],
  sub: 'It has a read on your taste, and it is already looking at this week.',
  header: {
    rect: {x: 150, y: 168, w: 700, h: 126},
    background: WA.bar,
    name: 'Otherwise',
    subtitle: 'online',
  },
  zooms: [{start: 150, end: 285, x: 470, y: 1660, scale: 2.3, ramp: 26}],
  enterAt: 0,
  captionAt: 10,
};

const layoutFor = (W: number, H: number, p: PhoneStageProps) => {
  const vertical = H > W;
  if (vertical) {
    const h = p.phoneHeight ?? 1240;
    const w = (h * IPHONE.bodyW) / IPHONE.bodyH;
    const cx = p.phoneCenterX ?? W / 2;
    return {vertical, h, w, left: cx - w / 2, top: H - h - 150, captionLeft: 96, captionTop: 150, captionWidth: W - 192, size: 92};
  }
  const h = p.phoneHeight ?? 940;
  const w = (h * IPHONE.bodyW) / IPHONE.bodyH;
  const cx = p.phoneCenterX ?? 1330;
  return {vertical, h, w, left: cx - w / 2, top: (H - h) / 2, captionLeft: 150, captionTop: 0, captionWidth: cx - w / 2 - 150 - 90, size: 104};
};

export const PhoneStage: React.FC<PhoneStageProps> = (props) => {
  const {headline, sub, src, startFrom, endAt, playbackRate, header, zooms = [], finish, enterAt = 0, captionAt = enterAt + 10} = props;
  const f = useCurrentFrame();
  const {width: W, height: H, fps} = useVideoConfig();
  const L = layoutFor(W, H, props);
  const s = L.h / IPHONE.bodyH;

  // entry: the phone rises on a soft spring, then floats a hair
  const rise = sp(f, fps, enterAt, {damping: 17, stiffness: 70, mass: 1.1});
  const enterY = (1 - rise) * 260;
  const enterRot = (1 - rise) * 4;
  const float = Math.sin((f / fps) * 0.9) * 3;

  // camera: sequentially blend from rest into each zoom
  let k = 1;
  let tx = 0;
  let ty = 0;
  let zoomed = 0;
  for (const z of zooms) {
    const ramp = z.ramp ?? 24;
    const p = interpolate(f, [z.start, z.start + ramp, z.end - ramp, z.end], [0, 1, 1, 0], {...clamp, easing: inOut});
    if (p <= 0) continue;
    const px = L.left + (IPHONE.bezel + z.x) * s;
    const py = L.top + (IPHONE.bezel + z.y) * s;
    const zk = z.scale;
    const ztx = (z.targetX ?? W / 2) - zk * px;
    const zty = (z.targetY ?? H / 2) - zk * py;
    k = mix(p, k, zk);
    tx = mix(p, tx, ztx);
    ty = mix(p, ty, zty);
    zoomed = Math.max(zoomed, p);
  }

  const words = headline.map((line) => line.split(' ').filter(Boolean));
  const lineCount = words.length;
  const subIn = lerp(f, [captionAt + 8 + lineCount * 6, captionAt + 30 + lineCount * 6], [0, 1]);
  const captionOut = Math.min(1, zoomed * 1.6);

  return (
    <AbsoluteFill style={{fontFamily: FONT, color: C.ink, fontFeatureSettings: '"tnum" 1', overflow: 'hidden'}}>
      <StageBackground focus={L.vertical ? {x: 0.5, y: 0.66} : {x: (L.left + L.w / 2) / W, y: 0.45}} />

      {/* caption */}
      <div
        style={{
          position: 'absolute',
          left: L.captionLeft,
          top: L.vertical ? L.captionTop : 0,
          bottom: L.vertical ? undefined : 0,
          width: L.captionWidth,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          opacity: 1 - captionOut,
          transform: `translateX(${-captionOut * 70}px)`,
          filter: captionOut > 0 ? `blur(${captionOut * 4}px)` : undefined,
        }}
      >
        <RiseWords
          start={captionAt}
          stagger={3}
          lines={words}
          style={{fontSize: L.size, fontWeight: 600, lineHeight: 1, letterSpacing: '-.04em'}}
        />
        {sub ? (
          <div
            style={{
              marginTop: L.vertical ? 34 : 44,
              maxWidth: L.vertical ? 860 : 640,
              fontSize: L.vertical ? 38 : 34,
              lineHeight: 1.38,
              fontWeight: 400,
              color: C.muted,
              letterSpacing: '-.005em',
              opacity: subIn,
              transform: `translateY(${(1 - subIn) * 16}px)`,
            }}
          >
            {sub}
          </div>
        ) : null}
      </div>

      {/* camera */}
      <AbsoluteFill style={{transform: `translate(${tx}px, ${ty}px) scale(${k})`, transformOrigin: '0 0'}}>
        <div
          style={{
            position: 'absolute',
            left: L.left,
            top: L.top,
            opacity: interpolate(rise, [0, 0.35], [0, 1], clamp),
            transform: `translateY(${enterY + float}px) rotate(${enterRot}deg)`,
            transformOrigin: '50% 100%',
          }}
        >
          <IPhone14Pro
            height={L.h}
            src={src}
            startFrom={startFrom}
            endAt={endAt}
            playbackRate={playbackRate}
            finish={finish}
            screenBackground={src ? '#000' : WA.wallpaper}
            overlay={header ? <HeaderCover {...header} /> : undefined}
          >
            <FakeWhatsApp />
          </IPhone14Pro>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
