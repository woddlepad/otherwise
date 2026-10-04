import React from 'react';
import {OffthreadVideo, staticFile} from 'remotion';

/*
 * iPhone 14 Pro, front view, drawn in CSS. Everything below is in SCREEN PIXELS (the 1179 x 2556 display at 460 ppi,
 * i.e. 393 x 852 pt @3x), then the whole device is scaled once to the requested height.
 *
 *   display        1179 x 2556 px, corner radius 55 pt = 165 px
 *   body           71.5 x 147.5 mm = 1295 x 2672 px (3.2 mm = 58 px around the display on every side)
 *   steel band     ~1 mm visible from the front = 18 px, then ~2.2 mm black border = 40 px
 *   body radius    165 + 58 = 223 px (concentric with the display)
 *   Dynamic Island 126 x 37 pt = 378 x 111 px, centred, 11 pt = 33 px below the top of the display
 *   buttons        from the top of the body: action/ring switch 21.5 to 28 mm, volume up 36 to 46 mm,
 *                  volume down 49.5 to 59.5 mm (left); side button 37 to 54.5 mm (right); ~0.5 mm proud
 */
export const IPHONE = {
  screenW: 1179,
  screenH: 2556,
  screenR: 165,
  bezel: 58,
  band: 18,
  bodyW: 1295,
  bodyH: 2672,
  bodyR: 223,
  island: {w: 378, h: 111, top: 33},
} as const;

const MM = IPHONE.bodyH / 147.5; // px per mm (18.1)
const BUTTONS = {
  left: [
    [21.5, 28],
    [36, 46],
    [49.5, 59.5],
  ],
  right: [[37, 54.5]],
} as const;

type Finish = 'space-black' | 'deep-purple';
const FINISH: Record<Finish, {band: string; hi: string; lo: string; mid: string}> = {
  'space-black': {band: '#2b2a2d', hi: '#8a898e', lo: '#0c0c0d', mid: '#3d3c40'},
  'deep-purple': {band: '#4b4352', hi: '#a79bb2', lo: '#1e1a22', mid: '#5d536a'},
};

export type IPhone14ProProps = {
  /** Rendered height of the whole device in px. */
  height: number;
  /** Screen content in screen pixels (1179 x 2556). Ignored when `src` is set. */
  children?: React.ReactNode;
  /** Screen recording (path under public/ or a URL). Fit with object-fit: cover, so 1178x2556, 886x1920 etc. fill the screen. */
  src?: string;
  /** Composition frames to skip at the start of the recording (Remotion trimBefore). */
  startFrom?: number;
  /** Composition frame of the recording at which to stop (Remotion trimAfter). */
  endAt?: number;
  playbackRate?: number;
  muted?: boolean;
  volume?: number;
  /** Drawn above the screen content in screen pixels (1179 x 2556), under the Dynamic Island. */
  overlay?: React.ReactNode;
  finish?: Finish;
  /** Soft drop shadow under the device. */
  shadow?: boolean;
  /** A faint diagonal reflection on the glass. */
  glare?: boolean;
  screenBackground?: string;
  style?: React.CSSProperties;
};

const resolveSrc = (src: string) => (/^(https?:|data:|blob:|\/)/.test(src) ? src : staticFile(src));

export const IPhone14Pro: React.FC<IPhone14ProProps> = ({
  height,
  children,
  src,
  startFrom,
  endAt,
  playbackRate = 1,
  muted = true,
  volume,
  overlay,
  finish = 'space-black',
  shadow = true,
  glare = true,
  screenBackground = '#000',
  style,
}) => {
  const s = height / IPHONE.bodyH;
  const width = IPHONE.bodyW * s;
  const k = FINISH[finish];
  const {screenW, screenH, screenR, bezel, band, bodyW, bodyH, bodyR, island} = IPHONE;

  const button = (side: 'left' | 'right', [a, b]: readonly [number, number], i: number) => (
    <div
      key={`${side}${i}`}
      style={{
        position: 'absolute',
        top: a * MM,
        height: (b - a) * MM,
        [side]: -9,
        width: 20,
        borderRadius: side === 'left' ? '7px 3px 3px 7px' : '3px 7px 7px 3px',
        background:
          side === 'left'
            ? `linear-gradient(90deg, ${k.lo} 0%, ${k.hi} 22%, ${k.mid} 45%, ${k.lo} 100%)`
            : `linear-gradient(270deg, ${k.lo} 0%, ${k.hi} 22%, ${k.mid} 45%, ${k.lo} 100%)`,
        boxShadow: `inset 0 3px 2px -2px rgba(255,255,255,.35), inset 0 -3px 2px -2px rgba(0,0,0,.6)`,
      }}
    />
  );

  return (
    <div style={{position: 'relative', width, height, ...style}}>
      <div style={{position: 'absolute', left: 0, top: 0, width: bodyW, height: bodyH, transform: `scale(${s})`, transformOrigin: '0 0'}}>
        {BUTTONS.left.map((r, i) => button('left', r, i))}
        {BUTTONS.right.map((r, i) => button('right', r, i))}

        {/* stainless band: polished steel, a bright rolled outer edge, darker where it meets the glass */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: bodyR,
            background: `conic-gradient(from 200deg at 50% 50%, ${k.mid}, ${k.hi} 4%, ${k.band} 11%, ${k.lo} 22%, ${k.band} 34%, ${k.mid} 46%, ${k.hi} 52%, ${k.band} 60%, ${k.lo} 74%, ${k.band} 88%, ${k.mid})`,
            boxShadow: [
              'inset 0 0 0 1.5px rgba(0,0,0,.65)', // outer silhouette
              'inset 0 0 0 4px rgba(255,255,255,.17)', // rolled edge catching light
              'inset 0 0 0 7px rgba(255,255,255,.05)',
              'inset 0 0 0 13px rgba(0,0,0,.22)', // turning away toward the glass
              shadow
                ? `0 ${44 / s}px ${80 / s}px -${22 / s}px rgba(16,32,28,.42), 0 ${16 / s}px ${28 / s}px -${10 / s}px rgba(16,32,28,.30), 0 ${3 / s}px ${6 / s}px rgba(16,32,28,.18)`
                : '',
            ]
              .filter(Boolean)
              .join(', '),
          }}
        />
        {/* specular catches on the band: key light top-left, a softer kicker bottom-right */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: bodyR,
            background:
              'radial-gradient(40% 22% at 12% 4%, rgba(255,255,255,.42), rgba(255,255,255,0) 70%), radial-gradient(30% 18% at 92% 97%, rgba(255,255,255,.22), rgba(255,255,255,0) 70%), linear-gradient(180deg, rgba(255,255,255,.08), rgba(255,255,255,0) 30%, rgba(0,0,0,0) 70%, rgba(0,0,0,.18))',
          }}
        />
        {/* the cover glass: black border with a faint lit edge where the glass curves into the band */}
        <div
          style={{
            position: 'absolute',
            inset: band,
            borderRadius: bodyR - band,
            background: '#040405',
            boxShadow: 'inset 0 0 0 2px rgba(255,255,255,.07), inset 0 0 0 5px rgba(0,0,0,.9), inset 0 0 0 7px rgba(255,255,255,.035)',
          }}
        />

        {/* the display */}
        <div
          style={{
            position: 'absolute',
            left: bezel,
            top: bezel,
            width: screenW,
            height: screenH,
            borderRadius: screenR,
            overflow: 'hidden',
            background: screenBackground,
            // keeps <video> (Studio preview) clipped to the radius on the GPU path
            WebkitMaskImage: '-webkit-radial-gradient(white, black)',
            isolation: 'isolate',
          }}
        >
          {src ? (
            <OffthreadVideo
              src={resolveSrc(src)}
              trimBefore={startFrom}
              trimAfter={endAt}
              playbackRate={playbackRate}
              muted={muted}
              volume={volume}
              style={{position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover'}}
            />
          ) : (
            <div style={{position: 'absolute', inset: 0}}>{children}</div>
          )}
          {overlay ? <div style={{position: 'absolute', inset: 0}}>{overlay}</div> : null}

          {/* Dynamic Island (screen recordings don't include it), with the faint camera lens behind */}
          <div
            style={{
              position: 'absolute',
              left: (screenW - island.w) / 2,
              top: island.top,
              width: island.w,
              height: island.h,
              borderRadius: island.h / 2,
              background: '#000',
            }}
          >
            <div
              style={{
                position: 'absolute',
                right: 38,
                top: (island.h - 38) / 2,
                width: 38,
                height: 38,
                borderRadius: '50%',
                background: 'radial-gradient(circle at 38% 36%, #1d2236 0%, #0b0d16 45%, #030304 72%)',
                boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.03)',
              }}
            />
          </div>

          {glare ? (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                pointerEvents: 'none',
                background: 'linear-gradient(118deg, rgba(255,255,255,.07) 0%, rgba(255,255,255,.025) 26%, rgba(255,255,255,0) 42%)',
              }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
};

/** Maps a point in screen pixels to px inside the rendered device box (top-left of the body = 0,0). */
export const screenToDevice = (height: number, x: number, y: number) => {
  const s = height / IPHONE.bodyH;
  return {x: (IPHONE.bezel + x) * s, y: (IPHONE.bezel + y) * s};
};
