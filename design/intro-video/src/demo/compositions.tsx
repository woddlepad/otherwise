import React from 'react';
import {Composition, Folder} from 'remotion';
import {PhoneStage, PHONE_STAGE_DEFAULTS, type PhoneStageProps} from './PhoneStage';
import {WebScroll, WEB_SCROLL_DEFAULTS, webScrollDuration, type WebScrollProps} from './WebScroll';

const FPS = 30;

// Demo building blocks, registered from Root.tsx.
export const DemoCompositions: React.FC = () => (
  <Folder name="Demo">
    <Composition
      id="PhoneStage"
      component={PhoneStage as React.FC<PhoneStageProps & Record<string, unknown>>}
      durationInFrames={300}
      fps={FPS}
      width={1920}
      height={1080}
      defaultProps={PHONE_STAGE_DEFAULTS as PhoneStageProps & Record<string, unknown>}
    />
    <Composition
      id="PhoneStageVertical"
      component={PhoneStage as React.FC<PhoneStageProps & Record<string, unknown>>}
      durationInFrames={300}
      fps={FPS}
      width={1080}
      height={1920}
      defaultProps={{...PHONE_STAGE_DEFAULTS, zooms: [{start: 150, end: 285, x: 470, y: 1660, scale: 1.9, ramp: 26, targetY: 1100}]} as PhoneStageProps & Record<string, unknown>}
    />
    <Composition
      id="WebScroll"
      component={WebScroll as React.FC<WebScrollProps & Record<string, unknown>>}
      durationInFrames={webScrollDuration(WEB_SCROLL_DEFAULTS.segments, FPS, WEB_SCROLL_DEFAULTS.crossfade, WEB_SCROLL_DEFAULTS.holdEnd)}
      fps={FPS}
      width={1920}
      height={1080}
      defaultProps={WEB_SCROLL_DEFAULTS as WebScrollProps & Record<string, unknown>}
      calculateMetadata={({props}) => ({durationInFrames: webScrollDuration(props.segments, FPS, props.crossfade, props.holdEnd)})}
    />
  </Folder>
);
