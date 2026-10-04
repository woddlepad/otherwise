import React from 'react';
import {C, FONT} from '../theme';

export type BrowserWindowProps = {
  /** Width of the page area in px; the page area is 16:9 (height = width * 9 / 16). */
  width: number;
  url?: string;
  /** Toolbar height in px (default scales with width: 54 at 1600). */
  barHeight?: number;
  radius?: number;
  shadow?: boolean;
  children?: React.ReactNode;
  style?: React.CSSProperties;
};

/** A clean, light, minimal browser frame: three traffic lights and one address pill. No tabs, no bookmarks. */
export const BrowserWindow: React.FC<BrowserWindowProps> = ({width, url = 'otherwise-homepage.vercel.app', barHeight, radius, shadow = true, children, style}) => {
  const u = width / 1600; // design unit
  const bar = barHeight ?? Math.round(54 * u);
  const r = radius ?? Math.round(20 * u);
  const pageH = Math.round((width * 9) / 16);
  const dot = 13 * u;
  return (
    <div
      style={{
        position: 'relative',
        width,
        height: bar + pageH,
        borderRadius: r,
        overflow: 'hidden',
        background: '#FBFCF9',
        fontFamily: FONT,
        boxShadow: shadow
          ? `0 0 0 1px rgba(28,48,44,.16), 0 ${2 * u}px ${5 * u}px rgba(28,48,44,.08), 0 ${26 * u}px ${52 * u}px -${12 * u}px rgba(28,48,44,.26), 0 ${70 * u}px ${130 * u}px -${30 * u}px rgba(28,48,44,.32)`
          : '0 0 0 1px rgba(28,48,44,.10)',
        WebkitMaskImage: '-webkit-radial-gradient(white, black)',
        ...style,
      }}
    >
      {/* toolbar */}
      <div
        style={{
          position: 'relative',
          height: bar,
          background: 'linear-gradient(#FDFDFB, #F5F7F2)',
          boxShadow: `inset 0 -1px 0 ${C.line}, inset 0 1px 0 rgba(255,255,255,.9)`,
        }}
      >
        <div style={{position: 'absolute', left: 20 * u, top: 0, bottom: 0, display: 'flex', alignItems: 'center', gap: 8 * u}}>
          {['#FF5F57', '#FEBC2E', '#28C840'].map((c) => (
            <i key={c} style={{width: dot, height: dot, borderRadius: '50%', background: c, boxShadow: 'inset 0 0 0 0.5px rgba(0,0,0,.14)'}} />
          ))}
        </div>
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            height: 32 * u,
            minWidth: 520 * u,
            padding: `0 ${22 * u}px`,
            borderRadius: 10 * u,
            background: '#ECEFE9',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8 * u,
            fontSize: 15 * u,
            fontWeight: 500,
            color: C.muted,
            letterSpacing: '-.005em',
          }}
        >
          <svg width={11 * u} height={13 * u} viewBox="0 0 11 13" style={{marginTop: -1 * u}}>
            <rect x="0.75" y="5.5" width="9.5" height="7" rx="1.6" fill={C.muted} />
            <path d="M2.8 5.6V3.9a2.7 2.7 0 015.4 0v1.7" fill="none" stroke={C.muted} strokeWidth="1.4" />
          </svg>
          <span>{url}</span>
        </div>
      </div>
      {/* page */}
      <div style={{position: 'relative', width, height: pageH, overflow: 'hidden', background: C.paper}}>{children}</div>
    </div>
  );
};
