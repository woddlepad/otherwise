import React from 'react';
import {AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame} from 'remotion';
import {C} from '../theme';
import {RiseWords} from '../RiseWords';
import {T, clamp, inOut, lerp, mix, sp} from '../timeline';

// Scene 3: the dark band with last week's picks as a liquid-glass card stack (otherwise.html "Last week").
const K = 1.32; // page px -> video px
const W = 390 * K;
const H = 540 * K;
const STACK = {left: 1180, top: 150};
// [x, y, scale, tilt, brightness] per depth, from the page's POSES
const POSES = [[0, 0, 1, 0, 1], [16, 20, 0.95, 4, 0.82], [-12, 38, 0.9, -3.5, 0.66], [0, 52, 0.86, 0, 0.5]];

const CARDS = [
  {img: 'green-crowd.jpg', when: 'Fri 2 Oct, 8 pm', t: 'Gillian Welch & David Rawlings', where: 'The Fillmore, Western Addition', why: [<b key="b">Best match.</b>, " You've bought tickets to see them twice, and Friday was empty."]},
  {img: 'comedy.jpg', when: 'Sat 3 Oct', t: 'Cheaper Than Therapy, stand-up', where: 'Shelton Theater, Union Square, $25', why: ['You go to stand-up about once a month.']},
  {img: 'crowd.jpg', when: 'Thu 1 Oct', t: 'Mari Froes', where: 'The Independent, NoPa', why: ["She's in the playlist you open most on Sunday mornings."], pos: 'center 85%'},
  {img: 'club.jpg', when: '2 to 4 Oct', t: 'Parameter x SQUISH Weekender', where: 'The Loom, Oakland', why: ['You opened every newsletter from Parameter this year.']},
];

const poseAt = (depth: number) => {
  const lo = Math.max(0, Math.min(POSES.length - 1, Math.floor(depth)));
  const hi = Math.min(POSES.length - 1, lo + 1);
  const t = Math.max(0, Math.min(1, depth - lo));
  return POSES[lo].map((v, i) => mix(t, v, POSES[hi][i]));
};

export const Picks: React.FC = () => {
  const f = useCurrentFrame();
  const sheet = lerp(f, [T.toPicks, T.toPicks + 26], [0, 1], inOut);
  const leave = lerp(f, [T.toBudget, T.toBudget + 28], [0, 1], inOut);
  // the drag: the top card leans right and the stamp fades in, then it is thrown
  const drag = lerp(f, [T.drag, T.fly], [0, 1], inOut);
  const fly = lerp(f, [T.fly, T.fly + 16], [0, 1], (t) => t * t * (1.6 - 0.6 * t));
  const say = lerp(f, [T.fly + 4, T.fly + 14], [0, 1]);
  return (
    <AbsoluteFill
      style={{
        background: C.night, color: C.mist, overflow: 'hidden',
        transform: `translateY(${(1 - sheet) * 1080 - leave * 160}px)`,
        borderRadius: `${(1 - sheet) * 56}px ${(1 - sheet) * 56}px 0 0`,
      }}
    >
      {/* ambient light: the top card's photo, blurred huge behind the stack (crossfades on the swipe) */}
      {CARDS.slice(0, 2).map((c, i) => {
        const on = i === 0 ? 1 - lerp(f, [T.fly, T.fly + 24], [0, 1]) : lerp(f, [T.fly, T.fly + 27], [0, 1]);
        const grow = lerp(f, [T.cards, T.cards + 40], [0.85, 1]);
        return (
          <Img
            key={c.img}
            src={staticFile(c.img)}
            style={{
              position: 'absolute', left: STACK.left - 380, top: -120, width: W + 760, height: 1320, objectFit: 'cover', borderRadius: '50%',
              filter: 'blur(90px) saturate(1.5)', opacity: on * 0.55 * lerp(f, [T.cards, T.cards + 30], [0, 1]), transform: `scale(${grow})`,
            }}
          />
        );
      })}
      <div style={{position: 'absolute', left: 150, top: 300, width: 860, zIndex: 3}}>
        <RiseWords
          start={T.picksHead}
          stagger={3}
          lines={[['It', 'learns', 'your', 'taste'], ['from', 'your', 'inbox.']]}
          style={{fontSize: 104, fontWeight: 600, lineHeight: 1, letterSpacing: '-.04em'}}
        />
        <p style={{margin: '34px 0 0', fontSize: 28, lineHeight: 1.45, color: C.mistDim, maxWidth: 640, opacity: lerp(f, [T.picksHead + 16, T.picksHead + 30], [0, 1])}}>
          Ticket receipts and the newsletters you open say what you like.
        </p>
        <div style={{display: 'flex', alignItems: 'flex-end', gap: 16, marginTop: 40, height: 96}}>
          <Img src={staticFile('capy-head.webp')} style={{width: 76, height: 76, flex: 'none', opacity: say, transform: `scale(${0.8 + say * 0.2})`}} />
          <p
            style={{
              margin: 0, padding: '16px 22px', fontSize: 25, lineHeight: 1.4, borderRadius: '22px 22px 22px 5px', maxWidth: 560,
              background: 'rgba(255,255,255,.08)', color: C.mist,
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,.18), inset 0 0 0 1px rgba(255,255,255,.08)',
              opacity: say, transform: `translateY(${(1 - say) * 8}px) scale(${0.96 + say * 0.04})`, transformOrigin: '0 100%',
            }}
          >
            Noted. I'll watch for more folk duos like Welch and Rawlings.
          </p>
        </div>
      </div>

      <div style={{position: 'absolute', left: STACK.left, top: STACK.top, width: W, height: H}}>
        {CARDS.map((c, i) => {
          // entrance: cards rise in from below, staggered
          const inP = sp(f, T.cards + (3 - i) * 3, {damping: 200, stiffness: 80}, 30);
          // after the throw every card moves one step up (45 ms stagger on the page, ~1.5 frames here)
          const up = i === 0 ? 0 : sp(f, T.fly + 2 + i * 1.5, {damping: 17, stiffness: 120, mass: 0.9});
          const depth = i - up;
          const [x, y, sc, r, dim] = poseAt(depth);
          let tx = x * K, ty = y * K + (1 - inP) * 700, rot = r, op = depth < 2.95 ? 1 : interpolate(depth, [2.95, 3], [1, 0], clamp);
          if (i === 0) {
            tx += drag * 120 + fly * W * 1.6;
            ty += fly * 40;
            rot += drag * 7 + fly * 17;
            op *= 1 - lerp(f, [T.fly + 2, T.fly + 10], [0, 1]);
          }
          const stamp = i === 0 ? lerp(f, [T.drag + 4, T.drag + 12], [0, 1]) : 0;
          return (
            <div
              key={c.img}
              style={{
                position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: 40, background: '#0B1714', color: '#fff',
                boxShadow: '0 50px 90px -36px rgba(0,0,0,.75), inset 0 0 0 1px rgba(255,255,255,.14)',
                transform: `translate(${tx}px, ${ty}px) scale(${sc}) rotate(${rot}deg)`, transformOrigin: '50% 85%',
                filter: `brightness(${dim})`, opacity: op, zIndex: 10 - i,
              }}
            >
              <Img src={staticFile(c.img)} style={{position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: c.pos ?? 'center'}} />
              <div style={{position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,.28), transparent 22%, transparent 48%, rgba(0,0,0,.35))'}} />
              <div style={{position: 'absolute', top: 16, left: 16, display: 'flex'}}>
                <span className="glass" style={{borderRadius: 999, padding: '7px 16px', fontSize: 20, fontWeight: 600, textShadow: '0 1px 2px rgba(0,0,0,.25)'}}>{c.when}</span>
              </div>
              <span
                className="glass"
                style={{
                  position: 'absolute', top: 98, left: 20, fontWeight: 700, fontSize: 26, padding: '10px 22px', borderRadius: 999,
                  backgroundColor: 'rgba(34,103,90,.6)', transform: `rotate(-6deg) scale(${0.9 + stamp * 0.1})`, opacity: stamp,
                }}
              >
                More like this
              </span>
              <div className="glass" style={{position: 'absolute', left: 13, right: 13, bottom: 13, borderRadius: 29, padding: '22px 26px 24px'}}>
                <div style={{fontSize: 38, fontWeight: 600, letterSpacing: '-.03em', lineHeight: 1.05, textShadow: '0 1px 12px rgba(0,0,0,.25)'}}>{c.t}</div>
                <span style={{display: 'block', fontSize: 21, color: 'rgba(255,255,255,.82)', marginTop: 6}}>{c.where}</span>
                <p style={{margin: '16px 0 0', paddingTop: 15, fontSize: 21, lineHeight: 1.4, color: 'rgba(255,255,255,.92)', borderTop: '1px solid rgba(255,255,255,.18)'}}>{c.why}</p>
              </div>
            </div>
          );
        })}
      </div>
      <AbsoluteFill style={{background: C.paper, opacity: leave * 0.25, pointerEvents: 'none'}} />
    </AbsoluteFill>
  );
};
