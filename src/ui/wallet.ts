// The wallet page (/wallet): prepaid credits, top-ups, discount codes, history. Same shell as /onboard.
import { asset, esc, shell } from './shell';

export type WalletView = {
  token: string;
  ready: boolean;                       // onboarding done: the way back is "settings", else "setup"
  availableCents: number;
  heldCents: number;
  packsCents: number[];
  minTopUpCents: number;
  maxTopUpCents: number;
  msg?: string;
  ok?: boolean;
  history: { label: string; note: string | null; amountCents: number; at: Date }[];
};

export const eur = (cents: number) => `€${(cents / 100).toFixed(2)}`;

const CSS = `
  .wallet-hero { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 1.5rem 4rem; align-items: end; padding-block: 3rem 3.5rem; }
  .balance-label { display: block; color: var(--muted); font-size: 1rem; margin-bottom: .35rem; }
  .balance { font-size: clamp(4rem, 11vw, 7.5rem); font-weight: 600; letter-spacing: -.055em; line-height: .9; margin: 0; }
  .balance-sub { display: block; margin-top: .7rem; color: var(--muted); }
  .wallet-hero .note { margin-top: 1.25rem; max-width: 30rem; }
  .wallet-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 1.25rem 2rem; align-items: start; padding-bottom: 2rem; }
  .panel-card { background: var(--surface); border-radius: 20px; padding: 1.4rem; box-shadow: 0 1px 0 var(--line), 0 30px 60px -40px rgba(28, 48, 44, .4); }
  .panel-card + .panel-card { margin-top: 1.25rem; }
  .panel-card h2 { font-size: 1.35rem; letter-spacing: -.025em; margin-bottom: 1rem; }
  .packs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .6rem; }
  .packs form { margin: 0; }
  .pack { width: 100%; padding: .95rem .5rem; border: 0; border-radius: 16px; background: #F1F4EF; font-size: 1.5rem; font-weight: 600; letter-spacing: -.04em; cursor: pointer; transition: background .15s, box-shadow .15s; }
  .pack:hover { background: var(--spring-tint); box-shadow: inset 0 0 0 2px var(--spring); }
  .inline { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .6rem; margin-top: .75rem; }
  .money { position: relative; }
  .money span { position: absolute; left: 1rem; top: 50%; transform: translateY(-50%); color: var(--muted); font-size: 1.05rem; pointer-events: none; }
  .money .input { padding-left: 2rem; }
  .panel-card .fine { margin-top: .9rem; }
  .history { list-style: none; margin: 0; padding: 0; }
  .history li { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; padding: .8rem 0; border-top: 1px solid var(--line); }
  .history li:first-child { border-top: 0; padding-top: 0; }
  .history b { font-weight: 600; display: block; line-height: 1.3; }
  .history small { color: var(--muted); font-size: .86rem; }
  .history .amt { font-weight: 600; white-space: nowrap; letter-spacing: -.01em; }
  .history .amt.plus { color: var(--spring); }
  .empty { display: flex; align-items: center; gap: .75rem; color: var(--muted); margin: 0; }
  .empty img { width: 40px; height: 40px; }
  .wallet-foot { display: flex; gap: .75rem; flex-wrap: wrap; padding-bottom: 1rem; }
  @media (max-width: 860px) {
    .wallet-hero, .wallet-grid { grid-template-columns: 1fr; }
  }
  @media (max-width: 640px) {
    .wallet-hero { padding-block: 1.75rem 2.25rem; }
    .panel-card { padding: 1.2rem 1.1rem; }
    .pack { font-size: 1.3rem; }
  }
`;

const fmtDate = (d: Date) =>
  d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });

export function renderWallet(v: WalletView) {
  const t = `<input type="hidden" name="t" value="${esc(v.token)}">`;
  const history = v.history.length
    ? `<ul class="history">${v.history
        .map(
          h => `<li><span><b>${esc(h.label)}</b><small>${h.note && h.note !== h.label ? `${esc(h.note)}, ` : ''}${fmtDate(h.at)}</small></span>
  <span class="amt${h.amountCents > 0 ? ' plus' : ''}">${h.amountCents > 0 ? '+' : '−'}${eur(Math.abs(h.amountCents))}</span></li>`,
        )
        .join('')}</ul>`
    : `<p class="empty"><img src="${asset('capy-head.webp')}" alt="" width="40" height="40">Nothing yet. Top-ups and bookings show up here.</p>`;

  return shell({
    title: 'Credits, Otherwise',
    css: CSS,
    topRight: `<a class="top-link" href="/onboard?t=${esc(v.token)}">${v.ready ? 'Settings' : 'Setup'}</a>`,
    body: `
<main class="wrap">
  <div class="wallet-hero">
    <div>
      <span class="balance-label">Your credits</span>
      <p class="balance">${eur(v.availableCents)}</p>
      <span class="balance-sub">${v.heldCents ? `${eur(v.heldCents)} reserved for a booking in progress` : 'available to spend on tickets'}</span>
    </div>
    <div>
      <p class="lede">I pay for tickets from these. If an event gets cancelled, the money comes back here.</p>
      ${v.msg ? `<p class="note ${v.ok ? 'ok' : 'err'}" role="status">${esc(v.msg)}</p>` : ''}
    </div>
  </div>
  <div class="wallet-grid">
    <div>
      <section class="panel-card" aria-labelledby="h-top"><h2 id="h-top">Top up</h2>
        <div class="packs">${v.packsCents
          .map(a => `<form method="post" action="/billing/checkout">${t}<input type="hidden" name="amount" value="${a / 100}"><button class="pack">${eur(a).replace('.00', '')}</button></form>`)
          .join('')}</div>
        <form method="post" action="/billing/checkout" class="inline">${t}
          <label class="money"><span>€</span><input class="input" name="amount" type="number" inputmode="numeric" min="${v.minTopUpCents / 100}" max="${v.maxTopUpCents / 100}" step="1" placeholder="Other amount" required aria-label="Other amount in euros"></label>
          <button class="btn">Top up</button>
        </form>
        <p class="fine">Card payment through Stripe. Test mode: use 4242 4242 4242 4242, any future date, any CVC.</p>
      </section>
      <section class="panel-card" aria-labelledby="h-code"><h2 id="h-code">Discount code</h2>
        <form method="post" action="/billing/redeem" class="inline" style="margin-top:0">${t}
          <input class="input" name="code" required placeholder="CODE" autocapitalize="characters" aria-label="Discount code"><button class="btn quiet">Redeem</button>
        </form>
      </section>
    </div>
    <section class="panel-card" aria-labelledby="h-history"><h2 id="h-history">History</h2>${history}</section>
  </div>
  <div class="wallet-foot"><a class="btn quiet" href="/onboard?t=${esc(v.token)}">${v.ready ? 'Back to settings' : 'Back to setup'}</a></div>
</main>
<footer class="wrap site-foot"><span>Otherwise</span><span>Stop any time by texting “stop”.</span></footer>`,
  });
}
