import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {C} from '../theme';

/**
 * The paper background with a slowly drifting light: a spring-teal glow, a coral one and a cream highlight,
 * all very low contrast (like the landing page's ambient glow). `focus` places the teal glow (0..1 of the frame).
 */
export const StageBackground: React.FC<{focus?: {x: number; y: number}; intensity?: number}> = ({focus = {x: 0.68, y: 0.42}, intensity = 1}) => {
  const f = useCurrentFrame();
  const {width: W, height: H, fps} = useVideoConfig();
  const t = f / fps;
  const big = Math.max(W, H);
  const glow = (x: number, y: number, r: number, color: string) => (
    <div
      style={{
        position: 'absolute',
        left: x - r,
        top: y - r,
        width: r * 2,
        height: r * 2,
        borderRadius: '50%',
        background: `radial-gradient(closest-side, ${color}, rgba(0,0,0,0))`,
      }}
    />
  );
  const a = (n: number) => n * intensity;
  return (
    <AbsoluteFill style={{background: C.paper, overflow: 'hidden'}}>
      {glow(W * focus.x + Math.sin(t * 0.21) * W * 0.04, H * focus.y + Math.cos(t * 0.17) * H * 0.05, big * 0.42, `rgba(34,103,90,${a(0.14)})`)}
      {glow(W * 0.16 + Math.cos(t * 0.13) * W * 0.05, H * 0.92 + Math.sin(t * 0.19) * H * 0.04, big * 0.36, `rgba(196,79,47,${a(0.06)})`)}
      {glow(W * 0.3 + Math.sin(t * 0.11 + 1) * W * 0.05, H * 0.12 + Math.cos(t * 0.15) * H * 0.04, big * 0.34, `rgba(246,235,221,${a(0.55)})`)}
      {glow(W * focus.x + Math.cos(t * 0.09) * W * 0.03, H * 0.98, big * 0.3, `rgba(221,238,232,${a(0.8)})`)}
      {/* a whisper of vignette keeps the eye in the middle */}
      <AbsoluteFill style={{background: 'radial-gradient(ellipse 80% 75% at 50% 50%, rgba(0,0,0,0) 60%, rgba(28,48,44,.05) 100%)'}} />
    </AbsoluteFill>
  );
};
