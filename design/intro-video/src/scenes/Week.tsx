import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {C, CHECK} from '../theme';
import {RiseWords} from '../RiseWords';
import {T, clamp, inOut, lerp, sp} from '../timeline';

// Scene 2: the hero calendar card from otherwise.html, "Live music" pick set, at 1080p scale.
export const CARD = {left: 150, top: 310, width: 1620, padX: 30, padY: 24};
const ROW = 66; // one evening hour
const GRID_H = ROW * 7; // 5 pm to midnight
const GUTTER = 84;
export const CAPY_ON_CARD = {left: CARD.left + CARD.width * 0.965 - 266, top: CARD.top + 62 - 266, width: 266};

const DAYS: [string, number][] = [['Mon', 12], ['Tue', 13], ['Wed', 14], ['Thu', 15], ['Fri', 16], ['Sat', 17], ['Sun', 18]];
// hours are offsets from 5 pm (s = start, d = duration), as on the page
const MINE = [
  {day: 0, s: 1.5, d: 1.5, t: 'Climbing', m: 'Mission Cliffs'},
  {day: 1, s: 2, d: 3.5, t: "Dinner at Lea's", m: 'the Mission'},
  {day: 3, s: 0, d: 1.25, t: 'Call with Sam'},
  {day: 6, s: 0, d: 2, t: "Mom's birthday", m: 'video call'},
];
const PICKS = [
  {day: 3, k: 'booked', s: 3, d: 2.5, t: 'Kelsey Lu', m: 'Great American Music Hall', price: 39, tag: 'You said yes'},
  {day: 4, k: 'booked', s: 2.5, d: 1.75, t: 'Fort Mason Night Market', m: 'Fort Mason, free', price: 0, tag: 'Added for you'},
  {day: 5, k: 'asked', s: 3.5, d: 2.5, t: 'Jessie Ware', m: 'The Warfield, $38', price: 38},
  {day: 6, k: 'booked', s: 3, d: 2.5, t: 'The Wallflowers', m: 'The Fillmore', price: 36, tag: 'You said yes'},
] as const;
const BUDGET = 120;
const ampm = (h: number) => `${h % 12 || 12} ${h % 24 < 12 ? 'am' : 'pm'}`;

const evBase: React.CSSProperties = {
  position: 'absolute', left: 7, right: 7, borderRadius: 8, padding: '8px 11px', fontSize: 17.5, lineHeight: 1.3, overflow: 'hidden',
};
const hatch = 'repeating-linear-gradient(135deg, #E2E8E0 0 3px, #F1F4EF 3px 10px)';

const Tag: React.FC<{children: React.ReactNode}> = ({children}) => (
  <span style={{marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 15, fontWeight: 600, borderRadius: 999, padding: '2px 9px 2px 4px', background: 'rgba(255,255,255,.16)'}}>
    <span style={{width: 16, height: 16, borderRadius: '50%', background: `${C.cream} ${CHECK} center/16px no-repeat`}} />
    {children}
  </span>
);

export const Week: React.FC = () => {
  const f = useCurrentFrame();
  const enter = sp(f, T.toWeek + 4, {damping: 200, stiffness: 70}, 32);
  const leave = lerp(f, [T.toPicks, T.toPicks + 28], [0, 1], inOut);
  const fills = PICKS.map((_, i) => sp(f, T.fill + i * 7, {damping: 15, stiffness: 150, mass: 0.7}));
  const labels = PICKS.map((_, i) => lerp(f, [T.fill + i * 7 + 8, T.fill + i * 7 + 18], [0, 1]));
  const booked = PICKS.reduce((a, p, i) => a + (p.k === 'booked' ? p.price * Math.min(1, labels[i]) : 0), 0);
  const bubble = lerp(f, [T.bubble, T.bubble + 10], [0, 1], outCubicish);
  return (
    <AbsoluteFill style={{transform: `translateY(${-leave * 160}px)`}}>
      <RiseWords
        start={T.weekCaption}
        stagger={3}
        lines={[['It', 'finds', 'the', {t: 'free', color: C.spring}, {t: 'evenings', color: C.spring}], ['in', 'your', 'week.']]}
        style={{position: 'absolute', left: CARD.left, top: 98, fontSize: 64, fontWeight: 600, lineHeight: 1.02, letterSpacing: '-.04em'}}
      />
      {/* the capybara's speech bubble (.say) */}
      <div
        style={{
          position: 'absolute', right: 1920 - (CAPY_ON_CARD.left + 12), bottom: 1080 - CARD.top + 20, maxWidth: 480,
          background: C.surface, borderRadius: '22px 22px 5px 22px', padding: '15px 21px', fontSize: 25, lineHeight: 1.35,
          boxShadow: `0 1px 0 ${C.line}, 0 18px 40px -22px rgba(28,48,44,.45)`,
          opacity: bubble, transform: `translateY(${(1 - bubble) * 8}px) scale(${0.96 + bubble * 0.04})`, transformOrigin: '100% 100%',
        }}
      >
        Found you <b style={{fontWeight: 600}}>three good evenings</b> this week. Wednesday I left free on purpose.
      </div>

      <div
        style={{
          position: 'absolute', left: CARD.left, top: CARD.top, width: CARD.width, background: C.surface, borderRadius: 26,
          padding: `${CARD.padY}px ${CARD.padX}px ${CARD.padY - 4}px`,
          boxShadow: `0 1px 0 ${C.line}, 0 40px 80px -50px rgba(28,48,44,.45)`,
          transform: `translateY(${(1 - enter) * 780}px)`,
        }}
      >
        {/* week bar */}
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 4px 18px'}}>
          <div style={{fontSize: 26, fontWeight: 600, letterSpacing: '-.01em'}}>Your week, 12 to 18 October</div>
          <div style={{display: 'flex', alignItems: 'center', gap: 14, marginRight: 262}}>
            <span style={{fontSize: 20, color: C.muted}}>Plan it around</span>
            <div style={{display: 'inline-flex', padding: 5, gap: 2, borderRadius: 999, background: '#EEF2EC'}}>
              {['Live music', 'Laughs', 'Surprise me'].map((m, i) => (
                <span
                  key={m}
                  style={{
                    padding: '8px 18px', borderRadius: 999, fontSize: 19, fontWeight: 600, color: i === 0 ? C.ink : C.muted,
                    background: i === 0 ? C.surface : 'transparent',
                    boxShadow: i === 0 ? '0 1px 2px rgba(28,48,44,.12), 0 0 0 1px rgba(28,48,44,.06)' : 'none',
                  }}
                >
                  {m}
                </span>
              ))}
            </div>
          </div>
        </div>
        {/* grid */}
        <div style={{display: 'grid', gridTemplateColumns: `${GUTTER}px repeat(7, minmax(0, 1fr))`}}>
          <div />
          {DAYS.map(([d, n]) => (
            <div key={d} style={{padding: '6px 12px 14px', borderLeft: `1px solid ${C.line}`}}>
              <span style={{display: 'block', fontSize: 18, color: C.muted}}>{d}</span>
              <span style={{display: 'block', fontSize: 36, fontWeight: 600, letterSpacing: '-.03em', lineHeight: 1.1}}>{n}</span>
            </div>
          ))}
          <div style={{position: 'relative'}}>
            {[18, 19, 20, 21, 22, 23].map((h, i) => (
              <span key={h} style={{position: 'absolute', right: 14, top: ((i + 1) / 7) * GRID_H, fontSize: 16, color: C.muted, transform: 'translateY(-50%)'}}>
                {ampm(h)}
              </span>
            ))}
          </div>
          {DAYS.map((_, di) => {
            // the scan: each column glows briefly as it is checked for a free evening
            const scan = interpolate(f, [T.scan + di * 3.5, T.scan + di * 3.5 + 5, T.scan + di * 3.5 + 22], [0, 0.8, 0], clamp);
            return (
              <div
                key={di}
                style={{
                  position: 'relative', height: GRID_H, borderLeft: `1px solid ${C.line}`,
                  backgroundImage: `linear-gradient(${C.line} 1px, transparent 1px)`, backgroundSize: `100% ${ROW}px`,
                }}
              >
                <div style={{position: 'absolute', inset: '0 0 0 0', background: C.tint, opacity: scan}} />
                {MINE.filter((e) => e.day === di).map((e) => (
                  <div key={e.t} style={{...evBase, top: e.s * ROW, height: e.d * ROW - 4, background: hatch, color: C.muted}}>
                    <b style={{display: 'block', fontWeight: 600, fontSize: 19}}>{e.t}</b>
                    {e.m && <span style={{display: 'block'}}>{e.m}</span>}
                  </div>
                ))}
                {di === 2 && (
                  <span
                    style={{
                      position: 'absolute', left: 14, right: 14, top: '45%', fontSize: 17, color: C.muted, textAlign: 'center', lineHeight: 1.35,
                      opacity: lerp(f, [T.note, T.note + 12], [0, 1]),
                    }}
                  >
                    Nothing worth leaving the sofa for.
                  </span>
                )}
                {PICKS.map((p, i) =>
                  p.day !== di ? null : (
                    <div
                      key={p.t}
                      style={{
                        ...evBase, top: p.s * ROW, height: p.d * ROW - 4,
                        background: p.k === 'booked' ? C.spring : C.tint, color: p.k === 'booked' ? '#fff' : C.ink,
                        boxShadow: p.k === 'asked' ? `inset 0 0 0 2px ${C.spring}` : 'none',
                        transform: `scaleY(${interpolate(fills[i], [0, 1], [0.2, 1])})`, transformOrigin: 'top',
                        opacity: interpolate(fills[i], [0, 0.5], [0, 1], clamp),
                      }}
                    >
                      <div style={{opacity: labels[i]}}>
                        <b style={{display: 'block', fontWeight: 600, fontSize: 19}}>{p.t}</b>
                        <span style={{display: 'block'}}>{p.m}</span>
                        {p.k === 'booked' ? (
                          <Tag>{p.tag}</Tag>
                        ) : (
                          <div style={{display: 'flex', gap: 6, marginTop: 8}}>
                            <span style={{borderRadius: 999, padding: '4px 12px', fontSize: 15, fontWeight: 600, background: C.spring, color: '#fff'}}>Book it</span>
                            <span style={{borderRadius: 999, padding: '4px 12px', fontSize: 15, fontWeight: 600, color: C.springDeep, boxShadow: 'inset 0 0 0 1.5px rgba(34,103,90,.45)'}}>Skip</span>
                          </div>
                        )}
                      </div>
                    </div>
                  ),
                )}
              </div>
            );
          })}
        </div>
        {/* foot */}
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 4px 0', fontSize: 19, color: C.muted, borderTop: `1px solid ${C.line}`, marginTop: 4}}>
          <div style={{display: 'flex', gap: 28}}>
            {[
              ['Already in your calendar', {background: hatch}],
              ['Booked for you', {background: C.spring}],
              ['Waiting for your yes', {background: C.tint, boxShadow: `inset 0 0 0 2px ${C.spring}`}],
            ].map(([label, st]) => (
              <span key={label as string} style={{display: 'inline-flex', alignItems: 'center', gap: 9}}>
                <span style={{width: 18, height: 18, borderRadius: 5, display: 'inline-block', ...(st as React.CSSProperties)}} />
                {label as string}
              </span>
            ))}
          </div>
          <span>
            <b style={{color: C.ink, fontWeight: 600}}>${Math.round(booked)}</b> booked this week, ${BUDGET - Math.round(booked)} left for October
          </span>
        </div>
      </div>
      {/* the dark band's shadow as it comes up */}
      <AbsoluteFill style={{background: C.night, opacity: leave * 0.35}} />
    </AbsoluteFill>
  );
};
const outCubicish = (t: number) => 1 - Math.pow(1 - t, 3);
