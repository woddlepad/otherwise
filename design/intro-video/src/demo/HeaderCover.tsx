import React from 'react';
import {Img, interpolate, staticFile, useCurrentFrame} from 'remotion';
import {C} from '../theme';

export type ScreenRect = {x: number; y: number; w: number; h: number};

export type HeaderCoverProps = {
  /** Patch position in screen pixels (1179 x 2556 space). Measure it on the recording. */
  rect: ScreenRect;
  /** Header background to match the recording (WhatsApp iOS light: #F6F6F6; dark: #1C1C1E). */
  background?: string;
  /** Image under public/ for the round avatar. */
  avatar?: string;
  avatarBackground?: string;
  avatarSize?: number;
  name?: string;
  subtitle?: string;
  nameColor?: string;
  subtitleColor?: string;
  nameSize?: number;
  subtitleSize?: number;
  fontFamily?: string;
  /** Visible from this frame (fades in over `fade` frames). Omit to show from the start. */
  from?: number;
  /** Hidden after this frame (fades out over `fade` frames). Omit to keep it. */
  to?: number;
  fade?: number;
  /** Soften the patch edges so it blends into the real header. */
  feather?: number;
};

/**
 * A WhatsApp-style header patch: round avatar + bold name (+ optional subtitle), drawn in screen pixels.
 * Put it in IPhone14Pro's `overlay` to cover the Twilio sandbox avatar and number.
 */
export const HeaderCover: React.FC<HeaderCoverProps> = ({
  rect,
  background = '#F6F6F6',
  avatar = 'capy-head.webp',
  avatarBackground = C.tint,
  avatarSize,
  name = 'Otherwise',
  subtitle,
  nameColor = '#000',
  subtitleColor = '#8A8A8E',
  nameSize = 50,
  subtitleSize = 36,
  fontFamily = '-apple-system, "SF Pro Text", "Host Grotesk", system-ui, sans-serif',
  from,
  to,
  fade = 6,
  feather = 0,
}) => {
  const f = useCurrentFrame();
  const fadeIn = from === undefined ? 1 : interpolate(f, [from, from + fade], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const fadeOut = to === undefined ? 1 : interpolate(f, [to - fade, to], [1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const opacity = Math.min(fadeIn, fadeOut);
  if (opacity <= 0) return null;
  const av = avatarSize ?? Math.round(Math.min(rect.h * 0.86, 108));
  const mask = feather
    ? `linear-gradient(90deg, transparent 0, #000 ${feather}px, #000 calc(100% - ${feather}px), transparent 100%)`
    : undefined;
  return (
    <div
      style={{
        position: 'absolute',
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        background,
        opacity,
        display: 'flex',
        alignItems: 'center',
        gap: Math.round(av * 0.28),
        fontFamily,
        WebkitMaskImage: mask,
        maskImage: mask,
      }}
    >
      <div
        style={{
          width: av,
          height: av,
          flex: 'none',
          borderRadius: '50%',
          overflow: 'hidden',
          background: avatarBackground,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Img src={staticFile(avatar)} style={{width: '92%', height: '92%', objectFit: 'contain', transform: 'translateY(6%)'}} />
      </div>
      <div style={{display: 'flex', flexDirection: 'column', justifyContent: 'center', minWidth: 0, lineHeight: 1.18}}>
        <div style={{fontSize: nameSize, fontWeight: 600, color: nameColor, letterSpacing: '-.01em', whiteSpace: 'nowrap'}}>{name}</div>
        {subtitle ? <div style={{fontSize: subtitleSize, color: subtitleColor, whiteSpace: 'nowrap'}}>{subtitle}</div> : null}
      </div>
    </div>
  );
};
