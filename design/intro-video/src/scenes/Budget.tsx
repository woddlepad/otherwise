import React from 'react';
import {AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame} from 'remotion';
import {C, CHECK} from '../theme';
import {RiseWords} from '../RiseWords';
import {T, clamp, inOut, lerp, mix, sp} from '../timeline';

// Scene 4: "How it decides". The number wheel (Left for October) and the stream of ideas meeting the decision line.
const WHEEL = {cx: 930, cy: 548, size: 184};
const VALUES = [120, 81, 43, 26]; // what the page's rule leaves after each paid booking ($120 budget, $25 limit)
const STREAM = {left: 1198, width: 616};
const IDEA_H = 146;
const STEP = IDEA_H + 18;
const GUTTER = 50;

type Idea = {d: string; dow: string; h: string; t: string; v: string; price: number; why: string};
const IDEAS: Idea[] = [
  {d: '12', dow: 'Mon', h: '8 pm', t: 'Mirthquake', v: 'Abbey Tavern, comedy', price: 0, why: 'Free, and a strong match.'},
  {d: '13', dow: 'Tue', h: '8 pm', t: 'Zolita', v: 'Rickshaw Stop', price: 35, why: "Clashes with dinner at Lea's."},
  {d: '15', dow: 'Thu', h: '8 pm', t: 'Kelsey Lu', v: 'Great American Music Hall', price: 39, why: 'Over your $25 limit, so it asked.'},
  {d: '16', dow: 'Fri', h: '7:30 pm', t: 'Fort Mason Night Market', v: 'Fort Mason', price: 0, why: 'Free, and a strong match.'},
  {d: '16', dow: 'Fri', h: '8 pm', t: 'Sara Bareilles', v: 'Bill Graham Civic', price: 59, why: 'Not much like what you go to.'},
];
const KELSEY = 2;

const Chip: React.FC<{kind: 'ok' | 'skip' | 'ask'; f: number; at: number}> = ({kind, f, at}) => {
  const p = lerp(f, [at, at + 9], [0, 1]);
  const base: React.CSSProperties = {
    fontSize: 16, fontWeight: 600, padding: '4px 12px', borderRadius: 999, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6,
    opacity: p, transform: `translateY(${(1 - p) * 6}px) scale(${0.96 + p * 0.04})`,
  };
  if (kind === 'ok')
    return (
      <span style={{...base, background: 'rgba(255,255,255,.18)', color: '#fff'}}>
        <span style={{width: 16, height: 16, borderRadius: '50%', background: `${C.cream} ${CHECK} center/16px no-repeat`}} />
        Booked
      </span>
    );
  if (kind === 'skip') return <span style={{...base, background: '#E6EBE4', color: C.muted}}>Skipped</span>;
  return (
    <span style={{...base, background: C.tint, color: C.springDeep}}>
      Asked you
      {[0, 1, 2].map((i) => (
        <i key={i} style={{width: 5, height: 5, borderRadius: '50%', background: 'currentColor', opacity: 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(((f - at) / 30) * Math.PI * 2 - i * 0.9))}} />
      ))}
    </span>
  );
};

export const Budget: React.FC = () => {
  const f = useCurrentFrame();
  const sheet = lerp(f, [T.toBudget, T.toBudget + 26], [0, 1], inOut);
  const pan = lerp(f, [T.toPhone, T.toPhone + 26], [0, 1], inOut);
  // the track moves one card up: Kelsey Lu reaches the line
  const p = 1 + sp(f, T.step, {damping: 200, stiffness: 90}, 22);
  const fill = lerp(f, [T.booked, T.booked + 15], [0, 1], (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2));
  const roll = sp(f, T.roll, {damping: 15, stiffness: 110, mass: 0.9});
  const coin = lerp(f, [T.coin, T.coin + 24], [0, 1], (t) => t);
  // where the coin starts (the price on the Kelsey Lu card) and lands (the wheel)
  const from = {x: STREAM.left + STREAM.width - 96, y: 540 - 32};
  const to = {x: WHEEL.cx - 40, y: WHEEL.cy - 24};
  const cx = coin < 0.55 ? mix(coin / 0.55, from.x, mix(0.55, from.x, to.x)) : mix((coin - 0.55) / 0.45, mix(0.55, from.x, to.x), to.x);
  const cyMid = mix(0.55, from.y, to.y) - 70;
  const cy = coin < 0.55 ? mix(Math.sin((coin / 0.55) * Math.PI / 2), from.y, cyMid) : mix(1 - Math.cos(((coin - 0.55) / 0.45) * Math.PI / 2), cyMid, to.y);
  const cScale = coin < 0.55 ? mix(coin / 0.55, 1, 1.15) : mix((coin - 0.55) / 0.45, 1.15, 0.6);
  const cOp = f < T.coin ? 0 : coin < 0.75 ? 1 : interpolate(coin, [0.75, 1], [1, 0]);

  return (
    <AbsoluteFill
      style={{
        background: C.paper, overflow: 'hidden',
        transform: `translateY(${(1 - sheet) * 1080}px)`, borderRadius: `${(1 - sheet) * 56}px ${(1 - sheet) * 56}px 0 0`,
      }}
    >
      <AbsoluteFill style={{transform: `translateX(${-pan * 760}px)`, opacity: interpolate(pan, [0, 0.7], [1, 0], clamp)}}>
        <div style={{position: 'absolute', left: 150, top: 318, width: 600}}>
          <RiseWords
            start={T.budgetHead}
            stagger={3}
            lines={[['You', 'set', 'two'], ['numbers.', 'It'], ['follows', 'them.']]}
            style={{fontSize: 92, fontWeight: 600, lineHeight: 1, letterSpacing: '-.04em'}}
          />
          <p style={{margin: '34px 0 0', fontSize: 28, lineHeight: 1.45, color: C.muted, maxWidth: 520, opacity: lerp(f, [T.budgetHead + 18, T.budgetHead + 32], [0, 1])}}>
            Books on its own up to <b style={{color: C.ink, fontWeight: 600}}>$25</b>. Anything above, it texts you first.
          </p>
        </div>

        {/* the wheel */}
        <div style={{position: 'absolute', left: WHEEL.cx - 260, width: 520, top: 0, height: 1080}}>
          <span style={{position: 'absolute', left: 0, right: 0, textAlign: 'center', top: WHEEL.cy - WHEEL.size * 1.45 - 6, fontSize: 24, color: C.muted}}>Left for October</span>
          <div style={{position: 'absolute', left: 0, right: 0, top: WHEEL.cy - WHEEL.size * 1.45, height: WHEEL.size * 2.9, perspective: 1000, fontSize: WHEEL.size, WebkitMaskImage: 'linear-gradient(transparent, #000 22%, #000 78%, transparent)', maskImage: 'linear-gradient(transparent, #000 22%, #000 78%, transparent)'}}>
            {VALUES.map((v, j) => {
              const d = j - roll;
              const a = Math.abs(d);
              return (
                <span
                  key={v}
                  style={{
                    position: 'absolute', left: 0, right: 0, top: '50%', height: '1em', marginTop: '-.5em', textAlign: 'center',
                    fontWeight: 600, letterSpacing: '-.055em', lineHeight: 1, whiteSpace: 'nowrap', color: C.ink,
                    transform: `translateY(${d * 0.95}em) rotateX(${-d * 32}deg) scale(${1 - Math.min(a, 2) * 0.17})`,
                    filter: `blur(${Math.min(a, 2) * 7}px)`, opacity: interpolate(a, [0, 1, 2], [1, 0.32, 0], clamp),
                  }}
                >
                  ${v}
                </span>
              );
            })}
          </div>
          <span style={{position: 'absolute', left: 0, right: 0, textAlign: 'center', top: WHEEL.cy + WHEEL.size * 1.45 + 10, fontSize: 24, color: C.muted}}>of $120</span>
        </div>

        {/* the stream of ideas, with the capybara on the decision line */}
        <div
          style={{
            position: 'absolute', left: STREAM.left, width: STREAM.width, top: 0, height: 1080,
            WebkitMaskImage: 'linear-gradient(transparent 12%, #000 34%, #000 66%, transparent 88%)',
            maskImage: 'linear-gradient(transparent 12%, #000 34%, #000 66%, transparent 88%)',
          }}
        >
          {IDEAS.map((x, i) => {
            const d = i - p;
            const a = Math.abs(d);
            const isK = i === KELSEY;
            const whyOp = i < KELSEY ? 0.9 : isK ? lerp(f, [T.ask, T.ask + 9], [0, 0.9]) : 0;
            // one face of the card: light (white, ink) or dark (spring, white). The booked wipe reveals the dark face
            // from the left, so text changes colour exactly at the edge of the fill.
            const face = (dark: boolean) => (
              <div
                style={{
                  position: 'absolute', inset: 0, display: 'grid', gridTemplateColumns: '92px minmax(0, 1fr) auto', gap: 16, alignItems: 'center',
                  padding: '16px 22px 16px 24px', background: dark ? C.spring : C.surface,
                  color: dark ? '#fff' : i === 1 ? C.muted : C.ink,
                  clipPath: dark && isK ? `inset(0 ${(1 - fill) * 100}% 0 0)` : undefined,
                }}
              >
                <div style={{fontSize: 17, lineHeight: 1.25, whiteSpace: 'nowrap', color: dark ? 'rgba(255,255,255,.85)' : C.muted}}>
                  <b style={{display: 'block', fontSize: 30, fontWeight: 600, color: dark ? 'rgba(255,255,255,.9)' : C.ink, letterSpacing: '-.02em'}}>{x.d}</b>
                  {x.dow} {x.h}
                </div>
                <div style={{minWidth: 0}}>
                  <b style={{display: 'block', fontWeight: 600, fontSize: 26, letterSpacing: '-.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textDecoration: i === 1 ? 'line-through' : 'none', textDecorationThickness: 2, textDecorationColor: 'rgba(90,107,102,.6)'}}>{x.t}</b>
                  <span style={{display: 'block', fontSize: 18.5, opacity: 0.75, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>{x.v}</span>
                  <em style={{display: 'block', fontStyle: 'italic', fontSize: 16.5, marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', opacity: whyOp}}>{x.why}</em>
                </div>
                <div style={{display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8}}>
                  <span style={{fontWeight: 600, fontSize: 26, letterSpacing: '-.02em'}}>{x.price ? `${dark ? '−' : ''}$${x.price}` : 'Free'}</span>
                  {dark && <Chip kind="ok" f={f} at={isK ? T.booked + 8 : -100} />}
                  {!dark && i === 1 && <Chip kind="skip" f={f} at={-100} />}
                  {!dark && isK && f >= T.ask && <Chip kind="ask" f={f} at={T.ask} />}
                </div>
              </div>
            );
            return (
              <div
                key={x.t}
                style={{
                  position: 'absolute', left: GUTTER, right: 0, top: 540 - IDEA_H / 2 + d * STEP, height: IDEA_H,
                  borderRadius: 22, overflow: 'hidden', isolation: 'isolate',
                  boxShadow: `0 1px 0 ${C.line}, 0 16px 32px -26px rgba(28,48,44,.5)`,
                  transform: `scale(${1 - Math.min(a, 3) * 0.035})`, opacity: Math.max(0, 1 - Math.max(0, a - 0.6) * 0.38),
                }}
              >
                {i !== 0 && face(false)}
                {(i === 0 || (isK && fill > 0)) && face(true)}
              </div>
            );
          })}
          <Img src={staticFile('capy-head.webp')} style={{position: 'absolute', left: 0, top: 540 - 25, width: 50, height: 50, filter: 'drop-shadow(0 5px 8px rgba(28,48,44,.25))'}} />
        </div>
      </AbsoluteFill>

      {/* "−$39" flies from the card to the wheel */}
      <span
        style={{
          position: 'absolute', left: cx, top: cy, transform: `translateX(${-pan * 760}px) scale(${cScale})`, opacity: cOp * (1 - pan),
          fontWeight: 700, fontSize: 30, color: C.coral, background: C.surface, padding: '5px 15px', borderRadius: 999,
          boxShadow: '0 10px 26px -10px rgba(28,48,44,.5)', zIndex: 10,
        }}
      >
        −$39
      </span>
    </AbsoluteFill>
  );
};
