// Shared page shell for the server-rendered pages (/onboard, the done page, /wallet): the homepage's look
// (design/homepage/otherwise.html, "Otherwise × Mellow"): Host Grotesk, sage paper, pine ink, spring teal, coral buttons
// and the capybara.
import { ASSETS } from './assets.gen';

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** URL of an embedded image, versioned so it can be cached for good (see src/mastra/routes/assets.ts). */
export const asset = (name: string) => `/assets/ui/${name}?v=${ASSETS[name]?.v ?? '0'}`;

/** wa.me link to the concierge's WhatsApp number, if one is configured. */
export function whatsappLink(): string | null {
  const digits = (process.env.TWILIO_WHATSAPP_FROM ?? '').replace(/\D/g, '');
  return digits ? `https://wa.me/${digits}` : null;
}

export const CURRENCY_SIGN: Record<string, string> = { EUR: '€', USD: '$', GBP: '£' };

const CSS = `
  :root {
    --paper: #F3F5EF; --surface: #FFFFFF; --ink: #1C302C; --muted: #5A6B66; --line: #DCE2DA; --edge: #C9D2C8;
    --spring: #22675A; --spring-deep: #1A5248; --spring-tint: #DDEEE8;
    --coral: #C44F2F; --coral-deep: #A9401F; --coral-tint: #F7E3DC; --cream: #F6EBDD;
    --night: #10201C; --mist: #E8EFEB; --mist-dim: #A3B8B1;
  }
  * { box-sizing: border-box; }
  html { overflow-x: clip; -webkit-text-size-adjust: 100%; scroll-padding-top: 5rem; }
  body {
    margin: 0; min-height: 100svh; background: var(--paper); color: var(--ink);
    font-family: "Host Grotesk", system-ui, sans-serif; font-size: 1.0625rem; line-height: 1.55;
    font-feature-settings: "tnum" 1;
  }
  a { color: inherit; }
  img { display: block; max-width: 100%; height: auto; }
  button, input, textarea { font: inherit; color: inherit; }
  :focus-visible { outline: 3px solid var(--coral); outline-offset: 3px; border-radius: 4px; }
  .wrap { width: min(1120px, 100% - 3rem); margin-inline: auto; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

  .site-top { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding-block: 1.1rem; }
  .logo { display: inline-flex; align-items: center; gap: .55rem; font-weight: 650; font-size: 1.3rem; letter-spacing: -.02em; text-decoration: none; }
  .logo img { width: 38px; height: 38px; margin: -4px 0; }
  .top-link { color: var(--muted); text-decoration: none; font-size: .95rem; }
  .top-link:hover { color: var(--ink); }

  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: .55rem;
    background: var(--coral); color: #fff; text-decoration: none; font-weight: 600; font-size: 1rem; line-height: 1.2;
    padding: .85rem 1.35rem; border-radius: 999px; border: 0; cursor: pointer; transition: background .15s, transform .15s, box-shadow .15s;
  }
  .btn:hover { background: var(--coral-deep); }
  .btn:active { transform: translateY(1px); }
  .btn.quiet { background: transparent; color: var(--ink); box-shadow: inset 0 0 0 1.5px var(--edge); }
  .btn.quiet:hover { box-shadow: inset 0 0 0 1.5px var(--ink); }
  .btn.small { padding: .55rem 1rem; font-size: .925rem; }
  .btn.wide { width: 100%; padding-block: 1.05rem; font-size: 1.075rem; }
  .btn[disabled] { opacity: .55; cursor: progress; }

  h1 { font-size: clamp(2.8rem, 8vw, 5.6rem); font-weight: 600; line-height: .95; letter-spacing: -.045em; margin: 0; }
  h2 { font-size: clamp(1.75rem, 3.3vw, 2.6rem); font-weight: 600; line-height: 1.02; letter-spacing: -.035em; margin: 0; }
  .lede { font-size: 1.2rem; color: var(--muted); margin: 0; max-width: 40ch; }
  .lede strong { color: var(--ink); font-weight: 600; }
  .fine { font-size: .9rem; color: var(--muted); margin: 0; }
  .fine a { color: var(--ink); text-underline-offset: 3px; }

  /* the capybara talking */
  .chat { display: flex; align-items: flex-end; gap: .7rem; max-width: 28rem; }
  .chat img { width: 48px; height: 48px; flex: none; }
  .chat p {
    margin: 0; padding: .75rem 1rem; font-size: .98rem; line-height: 1.4; border-radius: 18px 18px 18px 4px;
    background: var(--surface); box-shadow: 0 1px 0 var(--line), 0 14px 30px -18px rgba(28, 48, 44, .45);
  }
  .chat p b { font-weight: 600; }
  .chat p.swap { animation: pop .3s ease-out both; }
  @keyframes pop { from { opacity: 0; transform: translateY(6px) scale(.96); } to { opacity: 1; transform: none; } }

  .note { margin: 0; padding: .8rem 1rem; border-radius: 14px; font-size: .95rem; line-height: 1.4; }
  .note.ok { background: var(--spring-tint); color: var(--spring-deep); }
  .note.err { background: var(--coral-tint); color: var(--coral-deep); }

  .field { display: grid; gap: .45rem; }
  .field > span { font-weight: 600; font-size: .95rem; }
  .field > span small { font-weight: 400; color: var(--muted); font-size: .9rem; }
  .input {
    width: 100%; padding: .85rem 1rem; border: 0; border-radius: 14px; background: var(--surface);
    box-shadow: inset 0 0 0 1.5px var(--edge); font-size: 1.05rem; transition: box-shadow .15s;
  }
  .input:hover { box-shadow: inset 0 0 0 1.5px #AEBBAF; }
  .input:focus { outline: none; box-shadow: inset 0 0 0 2px var(--spring); }
  .input::placeholder { color: #93A29D; }
  textarea.input { resize: vertical; min-height: 5.5rem; line-height: 1.45; }

  .site-foot { padding-block: 2.5rem 3rem; color: var(--muted); font-size: .9rem; display: flex; justify-content: space-between; gap: .5rem 1rem; flex-wrap: wrap; }

  @media (max-width: 640px) {
    body { font-size: 1rem; }
    .wrap { width: min(1120px, 100% - 2rem); }
    .site-top { padding-block: .9rem; }
    .lede { font-size: 1.06rem; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; }
  }
`;

export type ShellOptions = {
  title: string;
  body: string;
  /** Extra CSS for this page. */
  css?: string;
  /** Inline script (no <script> tag). */
  script?: string;
  /** Right side of the header. */
  topRight?: string;
};

export function shell({ title, body, css = '', script, topRight = '' }: ShellOptions) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#F3F5EF"><meta name="robots" content="noindex">
<title>${esc(title)}</title>
<link rel="icon" href="${asset('favicon.ico')}" sizes="any"><link rel="apple-touch-icon" href="${asset('apple-touch-icon.png')}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Host+Grotesk:wght@300..800&display=swap" rel="stylesheet">
<style>${CSS}${css}</style></head><body>
<header class="wrap site-top"><span class="logo"><img src="${asset('capy-head.webp')}" alt="" width="38" height="38">otherwise</span>${topRight}</header>
${body}
${script ? `<script>${script}</script>` : ''}
</body></html>`;
}

/**
 * A short message page. `card` (done pages): the homepage's closing card, ink with the soft capybara, plus optional
 * content under it. `plain` (link expired): the capybara's head, a headline and a line.
 */
export function messagePage({ title, heading, text, actions = '', after = '', variant = 'card' }: {
  title: string; heading: string; text: string; actions?: string; after?: string; variant?: 'card' | 'plain';
}) {
  const acts = actions ? `<div class="msg-actions">${actions}</div>` : '';
  return shell({
    title,
    css: MESSAGE_CSS,
    body:
      variant === 'card'
        ? `<main class="wrap message">
  <div class="close-card"><h1>${heading}</h1><div class="msg-text">${text}</div>${acts}
    <img class="capy" src="${asset('capy-soft.webp')}" alt="" width="280" height="280"></div>
  ${after}
</main>`
        : `<main class="wrap message plain">
  <img class="msg-head" src="${asset('capy-head.webp')}" alt="" width="88" height="88">
  <h1>${heading}</h1><div class="msg-text">${text}</div>${acts}
</main>`,
  });
}

const MESSAGE_CSS = `
  .message { padding-block: 1.5rem 3rem; }
  .message h1 { font-size: clamp(2.8rem, 7vw, 5.4rem); max-width: 12ch; }
  .msg-text { margin-top: 1.25rem; font-size: 1.18rem; max-width: 38ch; }
  .msg-text p { margin: 0 0 .6rem; }
  .msg-actions { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: 1.75rem; }
  .close-card {
    position: relative; overflow: hidden; isolation: isolate; background: var(--ink); color: var(--paper); border-radius: 20px;
    padding: clamp(2.25rem, 6vw, 4.5rem); padding-right: clamp(2.25rem, 26vw, 22rem); min-height: 24rem;
  }
  .close-card::before { content: ""; position: absolute; z-index: -1; right: -4rem; bottom: -9rem; width: 30rem; height: 18rem; border-radius: 50%; background: radial-gradient(closest-side, rgba(34, 103, 90, .9), rgba(34, 103, 90, 0)); }
  .close-card .msg-text { color: #B9C7C2; }
  .close-card .msg-text strong { color: var(--paper); font-weight: 600; }
  .close-card .btn.quiet { color: var(--paper); box-shadow: inset 0 0 0 1.5px rgba(243, 245, 239, .35); }
  .close-card .btn.quiet:hover { box-shadow: inset 0 0 0 1.5px var(--paper); }
  .close-card .capy { position: absolute; z-index: -1; right: clamp(1rem, 5vw, 4.5rem); bottom: -1.5rem; width: clamp(170px, 22vw, 290px); filter: drop-shadow(0 24px 24px rgba(0, 0, 0, .3)); animation: settle .9s cubic-bezier(.3, 1.6, .5, 1) .3s both; }
  @keyframes settle { 0% { transform: translateY(0); } 35% { transform: translateY(-16px) rotate(-3deg); } 70% { transform: translateY(0) rotate(1deg); } 100% { transform: none; } }
  .plain { padding-block: clamp(2rem, 10vh, 6rem) 4rem; }
  .plain .msg-head { width: 88px; margin-bottom: 1.5rem; }
  .plain .msg-text { color: var(--muted); }
  .next { list-style: none; padding: 0; margin: 3.5rem 0 1rem; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 2.5rem; counter-reset: s; }
  .next li { position: relative; padding-top: 2.75rem; color: var(--muted); }
  .next li b { display: block; color: var(--ink); font-weight: 600; font-size: 1.3rem; letter-spacing: -.025em; margin-bottom: .4rem; }
  .next li::before { counter-increment: s; content: counter(s); position: absolute; top: 0; left: 0; width: 2rem; height: 2rem; border-radius: 50%; display: grid; place-items: center; background: var(--ink); color: var(--paper); font-weight: 600; font-size: .95rem; }
  .next li:not(:last-child)::after { content: ""; position: absolute; top: 1rem; left: 2.75rem; right: -1.75rem; height: 1px; background: var(--edge); }
  .next li.now::before { background: var(--spring); }
  @media (max-width: 760px) {
    .next { grid-template-columns: 1fr; gap: 1.75rem; margin-top: 2.5rem; }
    .next li { padding: 0 0 0 2.9rem; }
    .next li b { font-size: 1.1rem; }
    .next li:not(:last-child)::after { display: none; }
  }
  @media (max-width: 640px) {
    .message { padding-top: .75rem; }
    .msg-text { font-size: 1.06rem; }
    .close-card { padding: 2.25rem 1.5rem 11.5rem; min-height: 0; }
    .close-card .capy { width: 165px; right: 50%; transform: translateX(50%); bottom: -1rem; animation: none; }
    .msg-actions .btn { flex: 1 1 100%; }
  }
`;
