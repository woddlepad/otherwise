import React from 'react';
import {Img, interpolate, staticFile, useCurrentFrame} from 'remotion';
import {T, clamp, inOut, lerp, mix, sp} from '../timeline';
import {CAPY_ON_CARD} from './Week';

// The capybara is one element across scenes 1 and 2: it pops in beside the headline, then walks onto the calendar.
const A = {left: 1268, top: 300, width: 470};

export const SharedCapy: React.FC = () => {
  const f = useCurrentFrame();
  const pop = sp(f, T.capyPop, {damping: 9, stiffness: 120, mass: 0.8});
  const move = sp(f, T.toWeek + 2, {damping: 200, stiffness: 70}, 32);
  // the walk: a small arc up and a tilt while it travels
  const arc = Math.sin(move * Math.PI) * -60;
  const tilt = Math.sin(move * Math.PI) * -5;
  const left = mix(move, A.left, CAPY_ON_CARD.left);
  const top = mix(move, A.top, CAPY_ON_CARD.top) + arc;
  const width = mix(move, A.width, CAPY_ON_CARD.width);
  // after the move it rides along with the card (card parallax during the next transition)
  const ride = lerp(f, [T.toPicks, T.toPicks + 28], [0, -160], inOut);
  // the hop when it speaks, the page's "settle" keyframes
  const h = interpolate(f, [T.hop, T.hop + 8, T.hop + 16, T.hop + 24], [0, 1, 0, 0], clamp);
  const hr = interpolate(f, [T.hop, T.hop + 8, T.hop + 16, T.hop + 24], [0, -3, 1, 0], clamp);
  // the pop: scale up from below with a soft overshoot
  const scale = interpolate(pop, [0, 1], [0.35, 1]);
  const lift = (1 - pop) * 120;
  return (
    <div
      style={{
        position: 'absolute', left, top: top + ride + lift - h * 24, width, height: width,
        transform: `scale(${scale}) rotate(${tilt + hr}deg)`, transformOrigin: '50% 90%',
        opacity: interpolate(pop, [0, 0.25], [0, 1], clamp),
        filter: 'drop-shadow(0 24px 24px rgba(28, 48, 44, .16))',
      }}
    >
      <Img src={staticFile('capy-soft.webp')} style={{width: '100%', height: '100%'}} />
    </div>
  );
};
