// The setup page (/onboard) and its result pages. One page, four steps top to bottom; everything but the budget
// saves as you go (POST /onboard/profile, /onboard/swipe), so it survives the Composio redirect.
// Flow and API: docs/onboarding/PLAN.md.
import { DECK_CSS, DECK_JS, categoryPhotos, deckHtml } from './deck';
import { CURRENCY_SIGN, asset, esc, messagePage, shell, whatsappLink } from './shell';

export type OnboardView = {
  token: string;
  name: string | null;
  city: string | null;
  interests: string | null;
  status: string;                       // users.onboarding_status
  currency: string;
  monthlyCents: number;
  autoCents: number;
  connected: ('google' | 'microsoft')[];
  canConnect: boolean;                  // Composio configured
  error?: string;
  liked: number;                        // earlier starter-deck swipes
  disliked: number;
};

const CHECK = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.4l3 3 6-6.6"/></svg>`;
const GOOGLE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.5 12.2c0-.8-.1-1.4-.2-2.1H12v4h5.9c-.3 1.4-1 2.6-2.2 3.4v2.8h3.6c2-1.9 3.2-4.7 3.2-8.1z"/><path fill="#34A853" d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.8c-1 .7-2.2 1.1-3.7 1.1-2.9 0-5.3-1.9-6.2-4.5H2.1v2.9C3.9 20.6 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.8 14.1c-.2-.7-.4-1.4-.4-2.1s.1-1.4.4-2.1V7H2.1C1.4 8.5 1 10.2 1 12s.4 3.5 1.1 5l3.7-2.9z"/><path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.2-3.2C17.5 2.1 15 1 12 1 7.7 1 3.9 3.4 2.1 7l3.7 2.9c.9-2.6 3.3-4.5 6.2-4.5z"/></svg>`;
const MICROSOFT = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#F25022" d="M2 2h9.5v9.5H2z"/><path fill="#7FBA00" d="M12.5 2H22v9.5h-9.5z"/><path fill="#00A4EF" d="M2 12.5h9.5V22H2z"/><path fill="#FFB900" d="M12.5 12.5H22V22h-9.5z"/></svg>`;

const CSS = `
  .progress { display: flex; gap: 6px; list-style: none; margin: 0; padding: 0; }
  .progress li { width: 26px; height: 5px; border-radius: 99px; background: var(--edge); transition: background .3s; }
  .progress li.done { background: var(--spring); }
  .progress li.on { background: var(--ink); }
  .site-top { position: sticky; top: 0; z-index: 20; background: rgba(243, 245, 239, .86); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); width: 100%; padding-inline: max(1.5rem, (100% - 1120px) / 2); }

  .site-top { transition: background .3s, color .3s; }
  body.over-dark .site-top { background: rgba(16, 32, 28, .82); color: var(--mist); }
  body.over-dark .progress li { background: rgba(232, 239, 235, .22); }
  body.over-dark .progress li.done { background: #3E9A87; }
  body.over-dark .progress li.on { background: var(--mist); }

  .hero { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 2rem 4rem; align-items: end; padding-block: 3.5rem 4.5rem; }
  .hero-side { display: grid; gap: 1.75rem; }

  .step { display: grid; grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr); gap: 2rem 5rem; padding-block: 4.5rem; border-top: 1px solid var(--line); }
  .step-head { align-self: start; position: sticky; top: 6rem; }
  .num { width: 2rem; height: 2rem; border-radius: 50%; display: grid; place-items: center; background: var(--ink); color: var(--paper); font-weight: 600; font-size: .95rem; margin-bottom: 1.1rem; transition: background .3s; }
  .num svg { width: 15px; height: 15px; }
  .num.done { background: var(--spring); color: #fff; }
  .sub { color: var(--muted); font-size: 1.1rem; margin: .9rem 0 0; max-width: 34ch; }
  .step-body { display: grid; gap: 1.1rem; align-content: start; max-width: 34rem; }

  .providers { display: grid; gap: .75rem; }
  .provider {
    display: grid; grid-template-columns: 46px minmax(0, 1fr) auto; align-items: center; gap: .95rem;
    padding: 1rem 1rem 1rem 1.05rem; background: var(--surface); border-radius: 18px; text-decoration: none;
    box-shadow: 0 1px 0 var(--line), 0 16px 32px -26px rgba(28, 48, 44, .5); transition: transform .15s, box-shadow .15s;
  }
  .provider:hover { transform: translateY(-1px); box-shadow: 0 1px 0 var(--line), 0 22px 38px -24px rgba(28, 48, 44, .55); }
  .provider .ic { width: 46px; height: 46px; border-radius: 13px; background: #F1F4EF; display: grid; place-items: center; }
  .provider .ic svg { width: 22px; height: 22px; }
  .provider b { display: block; font-weight: 600; font-size: 1.05rem; letter-spacing: -.01em; line-height: 1.25; }
  .provider small { display: block; color: var(--muted); font-size: .88rem; line-height: 1.3; margin-top: .1rem; }
  .provider .go { display: inline-flex; align-items: center; gap: .35rem; padding: .5rem .95rem; border-radius: 999px; background: var(--coral); color: #fff; font-weight: 600; font-size: .9rem; white-space: nowrap; }
  .provider:hover .go { background: var(--coral-deep); }
  .provider.done { box-shadow: inset 0 0 0 2px var(--spring), 0 16px 32px -26px rgba(28, 48, 44, .5); }
  .provider.done .go, .provider.done:hover .go { background: var(--spring-tint); color: var(--spring-deep); }
  .provider.done .go svg { width: 14px; height: 14px; }
  .provider.off { pointer-events: none; opacity: .55; }
  .provider.off .go { background: #E6EBE4; color: var(--muted); }

  .city { font-size: 1.45rem; font-weight: 600; letter-spacing: -.02em; padding-block: .75rem; }
  .saved { min-height: 1.4em; display: inline-flex; align-items: center; gap: .35rem; }
  .saved svg { width: 14px; height: 14px; color: var(--spring); }

  .band .step { border-top: 0; padding-block: 5rem; grid-template-areas: "head deck" "next deck"; grid-template-rows: auto 1fr; row-gap: 0; }
  .band .step-head { position: static; grid-area: head; align-self: end; }
  .band .deck { grid-area: deck; align-self: center; }
  .band .deck-next { grid-area: next; align-self: start; }
  .band .chat { margin-top: 2rem; }
  .deck-next { margin-top: 1.75rem; display: flex; align-items: center; flex-wrap: wrap; gap: .75rem 1rem; }
  .link-btn { background: none; border: 0; padding: .35rem 0; color: var(--mist-dim); font-weight: 600; text-decoration: underline; text-underline-offset: 4px; cursor: pointer; }
  .link-btn:hover { color: #fff; }
  .deck-next .btn.on-dark { background: var(--mist); color: var(--night); }
  .deck-next .btn.on-dark:hover { background: #fff; }
  .deck-next .btn[hidden] { display: none; }

  .budget-card { background: var(--surface); border-radius: 20px; padding: 1.4rem 1.4rem 1.5rem; display: grid; gap: 1.75rem; box-shadow: 0 1px 0 var(--line), 0 30px 60px -40px rgba(28, 48, 44, .4); }
  .control-top { display: flex; justify-content: space-between; align-items: flex-end; gap: 1rem; margin-bottom: .8rem; }
  .control-top label { font-weight: 600; font-size: .98rem; line-height: 1.3; }
  .control-top label small { display: block; font-weight: 400; color: var(--muted); font-size: .86rem; margin-top: .15rem; }
  .amount { display: inline-flex; align-items: baseline; font-size: 2.5rem; font-weight: 600; letter-spacing: -.05em; line-height: 1; white-space: nowrap; }
  .amount input {
    field-sizing: content; min-width: 1.2ch; border: 0; padding: 0 0 2px; margin-left: .04em; background: transparent;
    font: inherit; letter-spacing: inherit; border-bottom: 2px dashed var(--edge); border-radius: 0; -moz-appearance: textfield; appearance: textfield;
  }
  @supports not (field-sizing: content) { .amount input { width: 3.4ch; } }
  .amount input::-webkit-inner-spin-button, .amount input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
  .amount input:hover { border-bottom-color: #AEBBAF; }
  .amount input:focus { outline: none; border-bottom: 2px solid var(--spring); }
  input[type=range] { -webkit-appearance: none; appearance: none; width: 100%; height: 6px; margin: .6rem 0; border-radius: 99px; background: linear-gradient(var(--spring), var(--spring)) 0 / var(--p, 50%) 100% no-repeat, var(--line); cursor: pointer; }
  input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 28px; height: 28px; border-radius: 50%; background: var(--surface); box-shadow: 0 0 0 2px var(--spring), 0 2px 6px rgba(28, 48, 44, .2); }
  input[type=range]::-moz-range-thumb { width: 26px; height: 26px; border: 0; border-radius: 50%; background: var(--surface); box-shadow: 0 0 0 2px var(--spring), 0 2px 6px rgba(28, 48, 44, .2); }
  .summary { margin: 0; font-size: 1.02rem; color: var(--muted); }
  .summary b { color: var(--ink); font-weight: 600; }
  .submit { display: grid; gap: .8rem; margin-top: .6rem; }

  @media (max-width: 960px) {
    .hero, .step { grid-template-columns: 1fr; }
    .step-head { position: static; }
    .step-body { max-width: none; }
    .band .step { grid-template-areas: "head" "deck" "next"; grid-template-rows: none; row-gap: 2rem; }
    .band .deck-next { justify-content: center; margin-top: 0; }
  }
  @media (max-width: 640px) {
    .site-top { padding-inline: 1rem; }
    .hero { padding-block: 1.75rem 2.75rem; gap: 1.5rem; }
    .hero h1 { font-size: clamp(2.7rem, 13vw, 3.6rem); }
    .step { padding-block: 2.75rem; gap: 1.5rem; }
    .num { margin-bottom: .9rem; }
    .sub { font-size: 1.02rem; margin-top: .65rem; }
    .band .step { padding-block: 3rem 3.25rem; gap: 2rem; }
    .band .chat { margin-top: 1.4rem; }
    .provider { grid-template-columns: 42px minmax(0, 1fr) auto; gap: .8rem; padding: .9rem .9rem .9rem .95rem; }
    .provider .ic { width: 42px; height: 42px; }
    .budget-card { padding: 1.2rem 1.1rem 1.3rem; }
    .amount { font-size: 2.2rem; }
  }
`;

const script = (cfg: object) => `
${DECK_JS}
(function () {
  var CFG = ${JSON.stringify(cfg).replace(/</g, '\\u003c')};
  var $ = function (id) { return document.getElementById(id); };
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var CHECK = ${JSON.stringify(CHECK)};
  var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  $('tz').value = tz;

  /* progress: steps done, and the one you're on */
  var steps = ['s-connect', 's-where', 's-swipe', 's-budget'];
  var done = { 's-connect': CFG.connected, 's-where': !!$('city').value.trim(), 's-swipe': CFG.liked + CFG.disliked > 0, 's-budget': false };
  var bars = document.querySelectorAll('.progress li'), current = 's-connect';
  function paint() {
    steps.forEach(function (id, i) {
      bars[i].className = id === current ? 'on' : done[id] ? 'done' : '';
      var n = document.querySelector('#' + id + ' .num');
      n.classList.toggle('done', !!done[id]);
      n.innerHTML = done[id] ? CHECK : String(i + 1);
    });
  }
  function mark(id, v) { if (done[id] !== v) { done[id] = v; paint(); } }
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { current = e.target.id; paint(); } });
    }, { rootMargin: '-45% 0px -50% 0px' });
    steps.forEach(function (id) { io.observe($(id)); });
  }
  paint();
  // the sticky header turns dark while the swipe band is under it
  var band = $('s-swipe'), top = document.querySelector('.site-top'), ticking = false;
  function headerTone() {
    ticking = false;
    var r = band.getBoundingClientRect(), hh = top.offsetHeight / 2;
    document.body.classList.toggle('over-dark', r.top <= hh && r.bottom > hh);
  }
  addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(headerTone); } }, { passive: true });
  headerTone();
  function go(id) { $(id).scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' }); }

  /* back from a Composio connect page: show where you are */
  document.querySelectorAll('.provider').forEach(function (a) { a.addEventListener('click', function () { try { sessionStorage.setItem('onb-connect', '1'); } catch (e) {} }); });
  try { if (sessionStorage.getItem('onb-connect')) { sessionStorage.removeItem('onb-connect'); go(CFG.connected ? 's-where' : 's-connect'); } } catch (e) {}

  /* the capybara's bubble in the swipe step */
  var says = $('capy-says');
  function speak(html) { says.innerHTML = html; says.classList.remove('swap'); void says.offsetWidth; says.classList.add('swap'); }
  var REACT = {
    music: ['Good ear. I\\u2019ll watch for gigs like this.', 'Got it, not your sound.'],
    film: ['Cinema it is. I\\u2019ll keep an eye on screenings.', 'Okay, fewer films like that.'],
    comedy: ['More laughs, coming up.', 'Fair. I\\u2019ll ease off the comedy.'],
    theatre: ['Noted. I\\u2019ll look at what\\u2019s on stage.', 'Okay, less theatre.'],
    dance: ['Noted. More dance like this.', 'Okay, less dance.'],
    talk: ['A curious one. More talks and readings.', 'Got it, fewer talks.'],
    tech_meetup: ['I\\u2019ll keep an eye on meetups like this.', 'Got it, fewer meetups.'],
    art: ['I\\u2019ll watch for openings and shows.', 'Okay, fewer exhibitions.'],
    food_drink: ['Good call. More food things like this.', 'Noted, I\\u2019ll skip those.'],
    nightlife: ['Late nights it is. I\\u2019ll watch the clubs.', 'Got it, no club nights.'],
    festival: ['Festivals, noted.', 'Okay, fewer festivals.'],
  };
  var CITY = CFG.city;
  var KEEP_GOING = 5;
  var skip = $('deck-skip'), next = $('deck-next');
  function nextButtons(n, finished) {
    var enough = finished || n >= KEEP_GOING;
    next.hidden = !enough; skip.hidden = enough;
  }
  var deck = createDeck(CFG, function (ev, info) {
    if (ev === 'swipe') {
      mark('s-swipe', true);
      var r = REACT[info.card.category] || ['Noted. More like this.', 'Got it. Not for you.'];
      if (info.left === 0) speak('Thanks, that\\u2019s a good start. <b>On to your budget.</b>');
      else if (info.swiped === KEEP_GOING) speak('That\\u2019s enough to go on. <b>More helps</b>, if you\\u2019re enjoying it.');
      else speak(info.dir > 0 ? r[0] : r[1]);
      nextButtons(info.swiped, info.left === 0);
    } else {
      if (info.city) CITY = info.city;
      document.querySelectorAll('[data-city]').forEach(function (el) { el.textContent = CITY; });
      if (info.kind === 'cards') { if (!info.swiped) speak('Here\\u2019s what\\u2019s on in <b>' + CITY + '</b> soon. Swipe, and I\\u2019ll learn what you\\u2019re into.'); nextButtons(info.swiped, false); }
      if (info.kind === 'building') speak('I\\u2019m looking at what\\u2019s on in <b>' + CITY + '</b>. Give me a moment.');
      if (info.kind === 'empty' || info.kind === 'failed') { speak('No cards this time. That\\u2019s fine, your mail and calendar tell me plenty.'); mark('s-swipe', true); nextButtons(0, true); }
      if (info.kind === 'done') { speak('Thanks, that\\u2019s a good start. <b>On to your budget.</b>'); nextButtons(info.swiped, true); }
    }
  });
  deck.load();
  skip.addEventListener('click', function () { go('s-budget'); });
  next.addEventListener('click', function () { go('s-budget'); });

  /* city + "anything I should know": saved as you go */
  var city = $('city'), interests = $('interests'), saved = $('saved');
  var last = { city: city.value.trim(), interests: interests.value.trim() };
  function save() {
    var body = { t: CFG.t, city: city.value.trim(), interests: interests.value.trim(), tz: tz };
    mark('s-where', !!body.city);
    if (!body.city || (body.city === last.city && body.interests === last.interests)) return;
    var cityChanged = body.city.toLowerCase() !== last.city.toLowerCase();
    saved.textContent = 'Saving\\u2026';
    fetch('/onboard/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (d) {
        last = { city: body.city, interests: body.interests };
        saved.innerHTML = CHECK + (cityChanged ? ' Saved. New cards for ' + (d.city || body.city).replace(/[<&]/g, '') + ' below.' : ' Saved');
        if (cityChanged) { CITY = d.city || body.city; deck.reload(); }
      })
      .catch(function () { saved.textContent = 'Couldn\\u2019t save just now. It\\u2019ll be saved when you finish.'; });
  }
  city.addEventListener('change', save);
  interests.addEventListener('change', save);
  city.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); city.blur(); } });

  /* the two numbers */
  var monthly = $('monthly'), auto = $('auto'), rm = $('monthly-range'), ra = $('auto-range'), sign = CFG.sign;
  function fill(r) { r.style.setProperty('--p', Math.min(100, (r.value - r.min) / (r.max - r.min) * 100) + '%'); }
  function sync(from) {
    if (from === rm) monthly.value = rm.value;
    if (from === ra) auto.value = ra.value;
    var m = Math.max(0, Math.round(+monthly.value || 0)), a = Math.max(0, Math.round(+auto.value || 0));
    if (a > m && monthly.value !== '') { a = m; if (from !== auto) auto.value = String(a); }
    if (from !== rm) rm.value = String(m);
    if (from !== ra) ra.value = String(a);
    fill(rm); fill(ra);
    $('summary').innerHTML = m
      ? 'Up to <b>' + sign + m + ' a month</b>. ' + (a ? 'Anything up to <b>' + sign + a + '</b> I just book when I\\u2019m sure you\\u2019ll love it; above that, I ask first.' : 'I ask before every booking.')
      : 'With no monthly budget I only suggest things and never book.';
  }
  [monthly, auto, rm, ra].forEach(function (el) { el.addEventListener('input', function () { sync(el); }); });
  sync(null);

  $('setup').addEventListener('submit', function () {
    var b = $('submit');
    setTimeout(function () { b.disabled = true; b.textContent = CFG.ready ? 'Saving\\u2026' : 'One moment\\u2026'; }, 0);
  });
})();
`;

export function renderOnboard(v: OnboardView) {
  const t = esc(v.token);
  const ready = v.status === 'ready';
  const sign = CURRENCY_SIGN[v.currency] ?? `${v.currency} `;
  // New users start from a suggestion rather than an empty field; after onboarding a 0 stays 0.
  const amount = (cents: number, suggest: number) => String(cents ? cents / 100 : ready ? 0 : suggest);
  const firstName = v.name?.split(' ')[0];

  const provider = (p: 'google' | 'microsoft', label: string, icon: string) => {
    const on = v.connected.includes(p);
    const cls = on ? ' done' : v.canConnect ? '' : ' off';
    const note = on ? 'Connected. Tap to reconnect.' : v.canConnect ? 'Mail read-only, plus your calendar' : 'Not available right now';
    return `<a class="provider${cls}" href="/connect/${p}/start?t=${t}">
      <span class="ic">${icon}</span><span><b>${label}</b><small>${note}</small></span>
      <span class="go">${on ? `${CHECK}Connected` : 'Connect'}</span></a>`;
  };

  const body = `
<main>
  <div class="wrap hero">
    <h1>${ready ? 'Your settings' : `Hi${firstName ? ` ${esc(firstName)}` : ''}.`}</h1>
    <div class="hero-side">
      <p class="lede">${
        ready
          ? '<strong>Change anything below, then save.</strong> Swiping a few more cards helps me learn what you like.'
          : '<strong>Four short steps, about two minutes.</strong> Everything saves as you go, so you can leave and come back.'
      }</p>
      <div class="chat"><img src="${asset('capy-head.webp')}" alt="" width="48" height="48">
        <p>${ready ? 'Anything new you\'re into? Tell me below, or swipe a few.' : 'I find evenings out you\'d pick yourself and book them within your budget. First, let me get to know you.'}</p></div>
    </div>
  </div>

  <section class="wrap step" id="s-connect" aria-labelledby="h-connect">
    <div class="step-head"><span class="num">1</span><h2 id="h-connect">Connect your mail and calendar</h2>
      <p class="sub">Your ticket receipts and the newsletters you open say what you like. Your calendar says when you're free.</p></div>
    <div class="step-body">
      ${v.error ? `<p class="note err" role="alert">Connecting failed: ${esc(v.error)}. Try again?</p>` : ''}
      <div class="providers">${provider('google', 'Gmail + Google Calendar', GOOGLE)}${provider('microsoft', 'Outlook + calendar', MICROSOFT)}</div>
      <p class="fine">Read-only mail: I never send from your account. Calendar access lets me check when you're free and add what I book.</p>
    </div>
  </section>

  <form method="post" action="/onboard/complete" id="setup">
    <input type="hidden" name="t" value="${t}"><input type="hidden" name="tz" id="tz">

    <section class="wrap step" id="s-where" aria-labelledby="h-where">
      <div class="step-head"><span class="num">2</span><h2 id="h-where">Where do you go out?</h2>
        <p class="sub">I'll look for things in this city. Anything else that helps, tell me in your own words.</p></div>
      <div class="step-body">
        <label class="field"><span>City</span>
          <input class="input city" id="city" name="city" required autocomplete="address-level2" enterkeyhint="done" value="${esc(v.city)}" placeholder="Berlin"></label>
        <label class="field"><span>Anything I should know? <small>Optional</small></span>
          <textarea class="input" id="interests" name="interests" rows="3" placeholder="indie films, small jazz gigs, no stadiums">${esc(v.interests)}</textarea></label>
        <p class="fine saved" id="saved" aria-live="polite"></p>
      </div>
    </section>

    <section class="band" id="s-swipe" aria-labelledby="h-swipe">
      <div class="wrap step">
        <div class="step-head">
          <span class="num">3</span><h2 id="h-swipe">Swipe a few</h2>
          <p class="sub">Real things on in <span data-city>${esc(v.city ?? 'your city')}</span> over the next two weeks. Right if you'd go, left if not. Every swipe teaches me a little.</p>
          <div class="chat"><img src="${asset('capy-head.webp')}" alt="" width="48" height="48"><p id="capy-says" aria-live="polite">Let me see what's on.</p></div>
        </div>
        ${deckHtml()}
        <div class="deck-next">
          <button type="button" class="btn small on-dark" id="deck-next" hidden>On to the budget</button>
          <button type="button" class="link-btn" id="deck-skip">Skip this step</button>
        </div>
      </div>
    </section>

    <section class="wrap step" id="s-budget" aria-labelledby="h-budget">
      <div class="step-head"><span class="num">4</span><h2 id="h-budget">Set your two numbers</h2>
        <p class="sub">A monthly budget, and how much I may spend without asking. You can change both by text any time.</p></div>
      <div class="step-body">
        <div class="budget-card">
          <div class="control">
            <div class="control-top"><label for="monthly">Per month</label>
              <span class="amount">${esc(sign)}<input id="monthly" name="monthly" type="number" inputmode="numeric" min="0" step="1" required value="${amount(v.monthlyCents, 100)}" placeholder="100"></span></div>
            <input type="range" id="monthly-range" min="0" max="500" step="5" aria-label="Per month" value="${amount(v.monthlyCents, 100)}">
          </div>
          <div class="control">
            <div class="control-top"><label for="auto">Surprise me up to<small>I book without asking up to this</small></label>
              <span class="amount">${esc(sign)}<input id="auto" name="auto" type="number" inputmode="numeric" min="0" step="1" required value="${amount(v.autoCents, 25)}" placeholder="25"></span></div>
            <input type="range" id="auto-range" min="0" max="200" step="5" aria-label="Surprise me up to" value="${amount(v.autoCents, 25)}">
          </div>
          <p class="summary" id="summary" aria-live="polite"></p>
        </div>
        <p class="fine">I only book unasked when I'm really sure you'll love it. Tickets are paid from your prepaid credits: <a href="/wallet?t=${t}">add credits</a>.</p>
        <div class="submit">
          <button class="btn wide" type="submit" id="submit">${ready ? 'Save' : 'Done, analyse me'}</button>
          ${ready ? '' : '<p class="fine">I\'ll read your mail and calendar, then text you on WhatsApp. Takes a minute or two.</p>'}
        </div>
      </div>
    </section>
  </form>
</main>
<footer class="wrap site-foot"><span>Otherwise</span><span>Stop any time by texting “stop”.</span></footer>
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs id="glass-defs"></defs></svg>`;

  return shell({
    title: ready ? 'Your settings, Otherwise' : 'Set up Otherwise',
    css: CSS + DECK_CSS,
    topRight: `<ol class="progress" aria-hidden="true"><li></li><li></li><li></li><li></li></ol>`,
    body,
    script: script({
      t: v.token,
      city: v.city ?? '',
      ready,
      sign,
      connected: v.connected.length > 0,
      liked: v.liked,
      disliked: v.disliked,
      photos: categoryPhotos(),
    }),
  });
}

/** After POST /onboard/complete. */
export function renderOnboardDone({ ready, token }: { ready: boolean; token: string }) {
  const wa = whatsappLink();
  const t = encodeURIComponent(token);
  if (ready) {
    return messagePage({
      title: 'Saved, Otherwise',
      heading: 'Saved.',
      text: '<p>Your settings are updated. You can close this tab.</p>',
      actions: `${wa ? `<a class="btn" href="${wa}">Back to WhatsApp</a>` : ''}<a class="btn quiet" href="/onboard?t=${t}">Back to settings</a>`,
    });
  }
  return messagePage({
    title: 'Got it, Otherwise',
    heading: 'Got it.',
    text: `<p><strong>I'm reading your calendar and inbox now.</strong> You'll get a WhatsApp message in a minute or two.</p>`,
    after: `<ol class="next" aria-label="What happens now">
  <li class="now"><b>Learning your taste</b>Ticket receipts, newsletters you open, and your swipes.</li>
  <li><b>Finding your free evenings</b>Your calendar shows which evenings are still open.</li>
  <li><b>Your first plan on WhatsApp</b>Reply yes, no, or "more like this".</li>
</ol>`,
    actions: `${wa ? `<a class="btn" href="${wa}">Back to WhatsApp</a>` : ''}<a class="btn quiet" href="/wallet?t=${t}">Add credits</a>`,
  });
}

export function renderExpired() {
  const wa = whatsappLink();
  return messagePage({
    title: 'Link expired, Otherwise',
    heading: 'This link has expired.',
    text: "<p>Send me any message on WhatsApp and I'll send you a fresh one.</p>",
    actions: wa ? `<a class="btn" href="${wa}">Open WhatsApp</a>` : '',
    variant: 'plain',
  });
}
