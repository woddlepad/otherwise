import React from 'react';
import {AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame} from 'remotion';
import {C} from '../theme';
import {RiseWords} from '../RiseWords';
import {T, clamp, inOut, lerp, mix, sp} from '../timeline';
import {PHONE} from './Phone';

// The phone's ink body (scene 5) grows into the closing card (scene 6): one shared element.
const CARD = {left: 40, top: 40, width: 1840, height: 1000, radius: 36};

export const Close: React.FC = () => {
  const f = useCurrentFrame();
  const pan = lerp(f, [T.toPhone, T.toPhone + 26], [0, 1], inOut);
  const rise = sp(f, T.toPhone + 4, {damping: 200, stiffness: 80}, 28);
  const g = sp(f, T.toClose, {damping: 200, stiffness: 70}, 26);
  const phoneX = PHONE.left + (1 - pan) * 900;
  const phoneY = PHONE.top + (1 - rise) * 120;
  const left = mix(g, phoneX, CARD.left);
  const top = mix(g, phoneY, CARD.top);
  const width = mix(g, PHONE.width, CARD.width);
  const height = mix(g, PHONE.height, CARD.height);
  const radius = mix(g, PHONE.radius, CARD.radius);
  const capy = sp(f, T.closeCapy, {damping: 10, stiffness: 110, mass: 0.8});
  const logo = lerp(f, [T.logo, T.logo + 14], [0, 1]);
  const btn = sp(f, T.button, {damping: 13, stiffness: 160, mass: 0.7});
  const glow = lerp(f, [T.toClose + 6, T.toClose + 30], [0, 1]);
  return (
    <AbsoluteFill style={{pointerEvents: 'none'}}>
      <div
        style={{
          position: 'absolute', left, top, width, height, borderRadius: radius, background: C.ink, color: C.paper, overflow: 'hidden', isolation: 'isolate',
          boxShadow: '0 50px 90px -40px rgba(28,48,44,.55)',
        }}
      >
        {/* the spring glow in the corner (.close-card::before) */}
        <div style={{position: 'absolute', zIndex: -1, right: -90, bottom: -200, width: 900, height: 540, borderRadius: '50%', background: 'radial-gradient(closest-side, rgba(34,103,90,.9), rgba(34,103,90,0))', opacity: glow}} />
        <div style={{position: 'absolute', left: 130, top: 100, display: 'flex', alignItems: 'center', gap: 16, fontWeight: 650, fontSize: 42, letterSpacing: '-.02em', opacity: logo, transform: `translateY(${(1 - logo) * 10}px)`}}>
          <Img src={staticFile('capy-head.webp')} style={{width: 64, height: 64, margin: '-6px 0'}} />
          otherwise
        </div>
        {f >= T.closeHead - 2 && (
          <RiseWords
            start={T.closeHead}
            stagger={2.5}
            lines={[['Next', 'Thursday', 'is'], ['still', 'empty.', 'It'], ["doesn't", 'have', 'to', 'be.']]}
            style={{position: 'absolute', left: 124, top: 262, fontSize: 132, fontWeight: 600, lineHeight: 0.98, letterSpacing: '-.045em'}}
          />
        )}
        <div
          style={{
            position: 'absolute', left: 130, top: 760, display: 'inline-flex', alignItems: 'center', background: C.coral, color: '#fff',
            fontWeight: 600, fontSize: 34, padding: '24px 40px', borderRadius: 999,
            transform: `scale(${interpolate(btn, [0, 1], [0.6, 1])})`, transformOrigin: '0 50%', opacity: interpolate(btn, [0, 0.3], [0, 1], clamp),
          }}
        >
          Start on WhatsApp
        </div>
        <Img
          src={staticFile('capy-soft.webp')}
          style={{
            position: 'absolute', right: 120, bottom: -40, width: 520, height: 520, zIndex: -1,
            filter: 'drop-shadow(0 30px 30px rgba(0,0,0,.3))', transformOrigin: '50% 100%',
            transform: `translateY(${(1 - capy) * 300}px) scale(${interpolate(capy, [0, 1], [0.7, 1])})`,
            opacity: interpolate(capy, [0, 0.2], [0, 1], clamp),
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
