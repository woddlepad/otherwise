import React from 'react';
import {AbsoluteFill, Img, staticFile, useCurrentFrame} from 'remotion';
import {C} from '../theme';
import {RiseWords} from '../RiseWords';
import {T, inOut, lerp} from '../timeline';

// Scene 1: "Otherwise, you'd have stayed in." The capybara is drawn by SharedCapy so it can walk onto the calendar.
export const Hero: React.FC = () => {
  const f = useCurrentFrame();
  const out = lerp(f, [T.toWeek, T.toWeek + 16], [0, 1], inOut);
  const logoIn = lerp(f, [0, 18], [0, 1]);
  return (
    <AbsoluteFill style={{transform: `translateY(${-out * 280}px)`, opacity: 1 - out, filter: `blur(${out * 6}px)`}}>
      <div
        style={{
          position: 'absolute', left: 150, top: 64, display: 'flex', alignItems: 'center', gap: 14,
          fontWeight: 650, fontSize: 36, letterSpacing: '-.02em', opacity: logoIn, transform: `translateY(${(1 - logoIn) * -10}px)`,
        }}
      >
        <Img src={staticFile('capy-head.webp')} style={{width: 56, height: 56, margin: '-6px 0'}} />
        otherwise
      </div>
      <RiseWords
        start={T.headline}
        stagger={4}
        dur={26}
        lines={[['Otherwise,'], ["you'd", 'have'], ['stayed', 'in.']]}
        style={{
          position: 'absolute', left: 142, top: 236, fontSize: 212, fontWeight: 600, lineHeight: 0.95,
          letterSpacing: '-.045em', color: C.ink,
        }}
      />
    </AbsoluteFill>
  );
};
