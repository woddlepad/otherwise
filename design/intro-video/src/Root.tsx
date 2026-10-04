import React from 'react';
import {Composition} from 'remotion';
import {Intro} from './Intro';
import {FPS, TOTAL} from './timeline';
import './fonts';
import {DemoCompositions} from './demo/compositions';

export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="OtherwiseIntro" component={Intro} durationInFrames={TOTAL} fps={FPS} width={1920} height={1080} defaultProps={{}} />
    <DemoCompositions />
  </>
);
