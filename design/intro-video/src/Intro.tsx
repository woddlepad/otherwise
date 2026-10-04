import React from 'react';
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import {C, FONT, GLOBAL_CSS} from './theme';
import {T} from './timeline';
import {Hero} from './scenes/Hero';
import {Week} from './scenes/Week';
import {SharedCapy} from './scenes/SharedCapy';
import {Picks} from './scenes/Picks';
import {Budget} from './scenes/Budget';
import {Phone} from './scenes/Phone';
import {Close} from './scenes/Close';
import {Soundtrack} from './Soundtrack';

export type IntroProps = {stem?: 'vo' | 'music'};

export const Intro: React.FC<IntroProps> = ({stem}) => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{background: C.paper, color: C.ink, fontFamily: FONT, fontFeatureSettings: '"tnum" 1', overflow: 'hidden'}}>
      <style>{GLOBAL_CSS}</style>
      <Soundtrack stem={stem} />
      {f < T.toWeek + 30 && <Hero />}
      {f >= T.toWeek && f < T.toPicks + 30 && <Week />}
      {f < T.toPicks + 30 && <SharedCapy />}
      {f >= T.toPicks && f < T.toBudget + 30 && <Picks />}
      {f >= T.toBudget && f < T.toPhone + 26 && <Budget />}
      {f >= T.toPhone && <Close />}
      {f >= T.toPhone && <Phone />}
    </AbsoluteFill>
  );
};
