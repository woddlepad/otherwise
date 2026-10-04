import {Easing, interpolate, spring, type SpringConfig} from 'remotion';

// Demo-local motion helpers. Same curves as the intro (src/timeline.ts) but self-contained, so the demo keeps
// building while the intro's timeline is being edited.
export const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
export const ease = Easing.bezier(0.2, 0.8, 0.2, 1); // the page's .fill curve
export const inOut = Easing.bezier(0.65, 0, 0.35, 1); // camera moves: slow out, slow in

export const lerp = (f: number, [a, b]: [number, number], [x, y]: [number, number], easing = ease) =>
  interpolate(f, [a, b], [x, y], {...clamp, easing});

export const sp = (f: number, fps: number, start: number, config: Partial<SpringConfig> = {}, durationInFrames?: number) =>
  spring({frame: f - start, fps, config: {damping: 200, ...config}, durationInFrames});

export const mix = (p: number, a: number, b: number) => a + (b - a) * p;
