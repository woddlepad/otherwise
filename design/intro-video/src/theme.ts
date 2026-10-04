// Tokens copied from design/homepage/otherwise.html (:root)
export const C = {
  paper: '#F3F5EF',
  surface: '#FFFFFF',
  ink: '#1C302C',
  muted: '#5A6B66',
  line: '#DCE2DA',
  spring: '#22675A',
  springDeep: '#1A5248',
  tint: '#DDEEE8',
  coral: '#C44F2F',
  cream: '#F6EBDD',
  night: '#10201C',
  mist: '#E8EFEB',
  mistDim: '#A3B8B1',
};
export const FONT = '"Host Grotesk", system-ui, sans-serif';

// the cream check circle used on "booked" tags and chips
export const CHECK = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M3 6.2l2 2 4-4.4' fill='none' stroke='%2322675A' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`;

export const GLOBAL_CSS = `
  .glass {
    position: relative;
    background: linear-gradient(155deg, rgba(255,255,255,.24), rgba(255,255,255,.07) 38%, rgba(255,255,255,.03) 70%, rgba(255,255,255,.1)), rgba(14,26,23,.26);
    -webkit-backdrop-filter: blur(16px) saturate(1.7) brightness(1.05);
    backdrop-filter: blur(16px) saturate(1.7) brightness(1.05);
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,.55),
      inset 0 -1px 0 rgba(255,255,255,.14),
      inset 0 0 0 1px rgba(255,255,255,.12),
      inset 0 -24px 40px -30px rgba(255,255,255,.35),
      0 18px 40px -16px rgba(0,0,0,.45);
  }
  .glass::before {
    content: ""; position: absolute; inset: 0; border-radius: inherit; padding: 1.5px; pointer-events: none;
    background: linear-gradient(140deg, rgba(255,255,255,.8), rgba(255,255,255,.05) 32%, rgba(255,255,255,0) 60%, rgba(255,255,255,.45));
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor;
            mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); mask-composite: exclude;
  }
`;
