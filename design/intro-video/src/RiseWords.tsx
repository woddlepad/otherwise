import React from 'react';
import {useCurrentFrame} from 'remotion';
import {sp} from './timeline';

export type Word = string | {t: string; color?: string};

// Masked rise, word by word, like a keynote title: each word slides up out of its own clipping box.
export const RiseWords: React.FC<{
  lines: Word[][];
  start: number;
  stagger?: number;
  dur?: number;
  style?: React.CSSProperties;
}> = ({lines, start, stagger = 3, dur = 24, style}) => {
  const f = useCurrentFrame();
  let k = 0;
  return (
    <div style={style}>
      {lines.map((line, li) => (
        <div key={li} style={{display: 'block', whiteSpace: 'nowrap'}}>
          {line.map((w, wi) => {
            const word = typeof w === 'string' ? {t: w} : w;
            const p = sp(f, start + k++ * stagger, {damping: 200, stiffness: 120}, dur);
            return (
              <React.Fragment key={wi}>
                <span
                  style={{
                    display: 'inline-block',
                    overflow: 'hidden',
                    verticalAlign: 'top',
                    padding: '0 .06em .16em 0',
                    margin: '0 -.06em -.16em 0',
                  }}
                >
                  <span
                    style={{
                      display: 'inline-block',
                      color: word.color,
                      transform: `translateY(${(1 - p) * 112}%) rotate(${(1 - p) * 4}deg)`,
                      transformOrigin: '0 100%',
                    }}
                  >
                    {word.t}
                  </span>
                </span>
                {wi < line.length - 1 ? ' ' : null}
              </React.Fragment>
            );
          })}
        </div>
      ))}
    </div>
  );
};
