import React from 'react';
import {AbsoluteFill, Img, staticFile, useCurrentFrame} from 'remotion';
import {C} from '../theme';
import {RiseWords} from '../RiseWords';
import {T, inOut, lerp, sp} from '../timeline';

// Scene 5: the WhatsApp exchange, as a simple phone (not a WhatsApp clone).
export const PHONE = {left: 1090, top: 96, width: 500, height: 888, radius: 70, bezel: 14};

const Bubble: React.FC<{f: number; at: number; out?: boolean; children: React.ReactNode}> = ({f, at, out, children}) => {
  const p = sp(f, at, {damping: 16, stiffness: 170, mass: 0.7});
  if (f < at) return null;
  return (
    <div
      style={{
        alignSelf: out ? 'flex-end' : 'flex-start', maxWidth: '84%', padding: '14px 19px', fontSize: 26, lineHeight: 1.36,
        borderRadius: out ? '24px 24px 6px 24px' : '24px 24px 24px 6px',
        background: out ? C.spring : C.surface, color: out ? '#fff' : C.ink,
        boxShadow: out ? 'none' : `0 1px 0 ${C.line}, 0 10px 22px -18px rgba(28,48,44,.5)`,
        transform: `translateY(${(1 - p) * 18}px) scale(${0.9 + p * 0.1})`, transformOrigin: out ? '100% 100%' : '0 100%',
        opacity: Math.min(1, p * 2),
      }}
    >
      {children}
    </div>
  );
};

const Typing: React.FC<{f: number; from: number; to: number}> = ({f, from, to}) => {
  if (f < from || f >= to) return null;
  const p = lerp(f, [from, from + 5], [0, 1]);
  return (
    <div style={{alignSelf: 'flex-start', padding: '20px 22px', borderRadius: '24px 24px 24px 6px', background: C.surface, display: 'flex', gap: 7, opacity: p, transform: `scale(${0.9 + p * 0.1})`, transformOrigin: '0 100%', boxShadow: `0 1px 0 ${C.line}`}}>
      {[0, 1, 2].map((i) => (
        <i key={i} style={{width: 10, height: 10, borderRadius: '50%', background: C.muted, opacity: 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(((f - from) / 14) * Math.PI * 2 - i * 1.1))}} />
      ))}
    </div>
  );
};

export const Phone: React.FC = () => {
  const f = useCurrentFrame();
  const pan = lerp(f, [T.toPhone, T.toPhone + 26], [0, 1], inOut);
  const rise = sp(f, T.toPhone + 4, {damping: 200, stiffness: 80}, 28);
  const toClose = lerp(f, [T.toClose, T.toClose + 8], [0, 1]);
  const zoom = lerp(f, [T.toClose, T.toClose + 14], [0, 1]);
  return (
    <AbsoluteFill style={{transform: `translateX(${(1 - pan) * 900}px)`}}>
      <div style={{position: 'absolute', left: 150, top: 380, opacity: 1 - toClose}}>
        <RiseWords
          start={T.toPhone + 10}
          stagger={3}
          lines={[['And', 'texts', 'you'], ['on', 'WhatsApp.']]}
          style={{fontSize: 104, fontWeight: 600, lineHeight: 1, letterSpacing: '-.04em'}}
        />
      </div>
      {/* the screen; its ink body is drawn by Close so it can grow into the closing card */}
      <div
        style={{
          position: 'absolute', left: PHONE.left + PHONE.bezel, top: PHONE.top + PHONE.bezel, width: PHONE.width - PHONE.bezel * 2, height: PHONE.height - PHONE.bezel * 2,
          borderRadius: PHONE.radius - PHONE.bezel, background: '#EAF0EC', overflow: 'hidden', display: 'flex', flexDirection: 'column',
          transform: `translateY(${(1 - rise) * 120}px) scale(${1 + zoom * 0.12})`, opacity: 1 - toClose, zIndex: 30,
        }}
      >
        <div style={{display: 'flex', alignItems: 'center', gap: 14, padding: '52px 24px 18px', background: C.surface, boxShadow: `0 1px 0 ${C.line}`}}>
          <Img src={staticFile('capy-head.webp')} style={{width: 60, height: 60}} />
          <div style={{lineHeight: 1.2}}>
            <div style={{fontSize: 25, fontWeight: 600, letterSpacing: '-.01em'}}>Otherwise</div>
            <div style={{fontSize: 18, color: C.muted}}>{f >= T.typing1 && f < T.msg2 + 4 && !(f >= T.msg1 && f < T.typing2) ? 'typing…' : 'online'}</div>
          </div>
        </div>
        <div style={{flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 14, padding: '20px 20px 28px'}}>
          <div style={{alignSelf: 'center', fontSize: 16, color: C.muted, background: 'rgba(255,255,255,.7)', borderRadius: 999, padding: '4px 12px'}}>Sunday</div>
          <Bubble f={f} at={-100}>
            Found you <b style={{fontWeight: 600}}>three good evenings</b> this week. Wednesday I left free on purpose.
          </Bubble>
          <div style={{alignSelf: 'center', fontSize: 16, color: C.muted, background: 'rgba(255,255,255,.7)', borderRadius: 999, padding: '4px 12px', margin: '8px 0 4px'}}>Today</div>
          <Typing f={f} from={T.typing1} to={T.msg1} />
          <Bubble f={f} at={T.msg1}>
            <b style={{fontWeight: 600}}>Kelsey Lu</b>, Thu 15 Oct, $39. Over your $25 limit, want it?
          </Bubble>
          <Bubble f={f} at={T.reply} out>yes</Bubble>
          <Typing f={f} from={T.typing2} to={T.msg2} />
          <Bubble f={f} at={T.msg2}>
            <span style={{display: 'inline-flex', alignItems: 'center', gap: 10}}>
              <span style={{width: 26, height: 26, flex: 'none', borderRadius: '50%', background: `${C.spring} url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M3 6.2l2 2 4-4.4' fill='none' stroke='white' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center/22px no-repeat`}} />
              Booked, it's in your calendar.
            </span>
          </Bubble>
        </div>
      </div>
    </AbsoluteFill>
  );
};
