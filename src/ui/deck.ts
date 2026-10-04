// The starter-deck card stack for /onboard, ported from the "Last week" stack on the homepage
// (design/homepage/otherwise.html): liquid-glass cards, drag/flick/buttons/arrow keys, stamps, the capybara's
// speech bubble, an ambient glow from the top card's photo, reduced motion. Fed by GET /onboard/deck.
import { asset } from './shell';

/** Card fallback photo per event category (src/lib/events/classify.ts) when the listing has no image. */
const CATEGORY_PHOTO: Record<string, string> = {
  music: 'music.webp',
  festival: 'crowd.webp',
  sports: 'crowd.webp',
  comedy: 'comedy.webp',
  nightlife: 'club.webp',
  food_drink: 'market.webp',
  family: 'market.webp',
  film: 'film.webp',
  theatre: 'theatre.webp',
  dance: 'theatre.webp',
  art: 'art.webp',
  workshop: 'art.webp',
  talk: 'talk.webp',
  tech_meetup: 'talk.webp',
  other: 'crowd.webp',
};

export const categoryPhotos = () => Object.fromEntries(Object.entries(CATEGORY_PHOTO).map(([k, f]) => [k, asset(f)]));

export const DECK_CSS = `
  .band { position: relative; background: var(--night); color: var(--mist); overflow: hidden; isolation: isolate; }
  .band .sub { color: var(--mist-dim); }
  .band .num { background: var(--mist); color: var(--night); }
  .band .num.done { background: var(--spring); color: #fff; }
  .band .chat p {
    background: rgba(255, 255, 255, .08); color: var(--mist);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .18), inset 0 0 0 1px rgba(255, 255, 255, .08);
    -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
  }
  .band .chat p b { color: #fff; }

  .glow { position: absolute; z-index: -1; inset: -10% -30%; pointer-events: none; }
  .glow img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; filter: blur(70px) saturate(1.5); opacity: 0; transform: scale(.9); transition: opacity .9s ease, transform 1.2s ease; border-radius: 50%; }
  .glow img.on { opacity: .5; transform: scale(1); }

  .deck { position: relative; display: flex; flex-direction: column; align-items: center; gap: 2rem; }
  .stack { position: relative; z-index: 1; width: min(390px, 100%); height: 540px; margin-bottom: 40px; outline: none; }
  .stack:focus-visible { outline: 2px solid rgba(255, 255, 255, .7); outline-offset: 12px; border-radius: 32px; }
  .card {
    position: absolute; inset: 0; overflow: hidden; border-radius: 30px; background: #0B1714; color: #fff;
    box-shadow: 0 40px 70px -30px rgba(0, 0, 0, .75), inset 0 0 0 1px rgba(255, 255, 255, .14);
    transform: translate(var(--x, 0), var(--y, 0)) scale(var(--sc, 1)) rotate(var(--r, 0deg)); transform-origin: 50% 85%;
    transition: transform .5s cubic-bezier(.2, .9, .25, 1.1), opacity .35s ease, filter .5s ease; transition-delay: var(--delay, 0s);
    filter: brightness(var(--dim, 1)); user-select: none; -webkit-user-select: none; touch-action: pan-y;
  }
  .card.is-top { cursor: grab; }
  .card.dragging { cursor: grabbing; transition: none; }
  .card.flying { transition: transform .42s cubic-bezier(.4, 0, .9, .6), opacity .26s ease .06s; }
  .card > img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; pointer-events: none; }
  .card::after { content: ""; position: absolute; inset: 0; pointer-events: none; background: linear-gradient(180deg, rgba(0, 0, 0, .3), transparent 24%, transparent 42%, rgba(0, 0, 0, .45)); }
  .glass {
    position: relative; z-index: 1;
    background: linear-gradient(155deg, rgba(255, 255, 255, .24), rgba(255, 255, 255, .07) 38%, rgba(255, 255, 255, .03) 70%, rgba(255, 255, 255, .1)), rgba(14, 26, 23, .3);
    -webkit-backdrop-filter: blur(14px) saturate(1.7) brightness(1.05); backdrop-filter: blur(14px) saturate(1.7) brightness(1.05);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .55), inset 0 -1px 0 rgba(255, 255, 255, .14), inset 0 0 0 1px rgba(255, 255, 255, .12),
      inset 0 -18px 30px -24px rgba(255, 255, 255, .35), 0 14px 30px -12px rgba(0, 0, 0, .45);
  }
  .glass::before {
    content: ""; position: absolute; inset: 0; border-radius: inherit; padding: 1.2px; pointer-events: none;
    background: linear-gradient(140deg, rgba(255, 255, 255, .8), rgba(255, 255, 255, .05) 32%, rgba(255, 255, 255, 0) 60%, rgba(255, 255, 255, .45));
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor;
    mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); mask-composite: exclude;
  }
  .card .chips { position: absolute; z-index: 1; top: 12px; left: 12px; right: 12px; display: flex; justify-content: space-between; align-items: flex-start; gap: .5rem; }
  .pill { border-radius: 999px; padding: .32rem .75rem; font-size: .84rem; font-weight: 600; text-shadow: 0 1px 2px rgba(0, 0, 0, .25); white-space: nowrap; }
  .card .panel { position: absolute; left: 10px; right: 10px; bottom: 10px; border-radius: 22px; padding: 1rem 1.15rem 1.05rem; }
  .card h3 {
    margin: 0; font-size: 1.55rem; font-weight: 600; letter-spacing: -.03em; line-height: 1.06; text-shadow: 0 1px 12px rgba(0, 0, 0, .25);
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere;
  }
  .card .where { display: block; font-size: .95rem; color: rgba(255, 255, 255, .85); margin-top: .3rem; }
  .card .foot { display: flex; justify-content: space-between; align-items: baseline; gap: .75rem; margin: .7rem 0 0; padding-top: .65rem; border-top: 1px solid rgba(255, 255, 255, .18); font-size: .88rem; }
  .card .tags { color: rgba(255, 255, 255, .78); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .card .more { color: #fff; font-weight: 600; white-space: nowrap; text-underline-offset: 3px; }
  .stamp { position: absolute; z-index: 2; top: 4.2rem; font-weight: 700; font-size: 1.05rem; padding: .45rem .95rem; border-radius: 999px; pointer-events: none; opacity: 0; }
  .stamp.yes { left: 14px; background-color: rgba(34, 103, 90, .6); transform: rotate(-6deg); opacity: var(--yes, 0); }
  .stamp.no { right: 14px; background-color: rgba(20, 20, 20, .45); transform: rotate(6deg); opacity: var(--no, 0); }

  /* loading / empty / done: one glass card in the stack's place */
  .deck-state {
    position: absolute; inset: 0; z-index: 0; border-radius: 30px; display: flex; flex-direction: column; justify-content: flex-end; gap: .6rem;
    padding: 1.6rem 1.5rem; color: var(--mist); overflow: hidden;
    background: linear-gradient(160deg, rgba(255, 255, 255, .09), rgba(255, 255, 255, .02) 60%), #142824;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .12), 0 40px 70px -30px rgba(0, 0, 0, .75);
  }
  .deck-state[hidden] { display: none; }
  .deck-state img { width: 150px; align-self: center; margin: auto 0 .5rem; filter: drop-shadow(0 18px 20px rgba(0, 0, 0, .35)); }
  .deck-state h3 { margin: 0; font-size: 1.5rem; font-weight: 600; letter-spacing: -.03em; line-height: 1.1; color: #fff; }
  .deck-state p { margin: 0; color: var(--mist-dim); font-size: .98rem; }
  .deck-state.loading::after {
    content: ""; position: absolute; inset: 0; pointer-events: none;
    background: linear-gradient(105deg, transparent 30%, rgba(255, 255, 255, .07) 45%, rgba(255, 255, 255, .12) 50%, transparent 65%) -150% 0 / 250% 100% no-repeat;
    animation: sheen 1.8s ease-in-out infinite;
  }
  .deck-state.loading img { animation: bob 1.8s ease-in-out infinite; }
  @keyframes sheen { to { background-position: 150% 0; } }
  @keyframes bob { 50% { transform: translateY(-6px) rotate(-2deg); } }
  .dots i { display: inline-block; width: 5px; height: 5px; margin-left: 3px; border-radius: 50%; background: currentColor; animation: blink 1s infinite; vertical-align: middle; }
  .dots i:nth-child(2) { animation-delay: .15s; } .dots i:nth-child(3) { animation-delay: .3s; }
  @keyframes blink { 0%, 100% { opacity: .25; } 50% { opacity: 1; } }

  .deck-controls { display: flex; align-items: center; gap: 1.25rem; }
  .deck-controls[hidden], .hint[hidden] { display: none; }
  .round { width: 60px; height: 60px; border-radius: 50%; border: 0; display: grid; place-items: center; cursor: pointer; color: #fff; transition: transform .15s; }
  .round:hover { transform: scale(1.06); }
  .round:active { transform: scale(.94); }
  .round.yes { background-color: rgba(34, 103, 90, .75); }
  .round svg { width: 22px; height: 22px; }
  .count { min-width: 5.5rem; text-align: center; font-size: .95rem; color: var(--mist-dim); }
  .count b { color: #fff; font-weight: 600; }
  .hint { margin: -1rem 0 0; font-size: .85rem; color: #7F958E; text-align: center; }

  @media (max-width: 640px) {
    .stack { height: 468px; width: calc(100% - 36px); margin-bottom: 34px; }
    .deck { gap: 1.6rem; }
    .card h3 { font-size: 1.4rem; }
  }
  @media (prefers-reduced-motion: reduce) {
    .card, .card.flying { transition: opacity .2s ease; }
    .glow img { transition: opacity .3s; }
  }
`;

/** Markup of the deck column. */
export const deckHtml = () => `
<div class="deck">
  <div class="glow" id="glow" aria-hidden="true"></div>
  <div class="stack" id="stack" tabindex="0" role="group" aria-roledescription="card stack" aria-label="Events to swipe. Use the left and right arrow keys.">
    <div class="deck-state loading" id="deck-state">
      <img src="${asset('capy-soft.webp')}" alt="" width="150" height="150">
      <h3 id="deck-state-h">Looking at what's on<span class="dots"><i></i><i></i><i></i></span></h3>
      <p id="deck-state-p">This takes a few seconds.</p>
    </div>
  </div>
  <div class="deck-controls" id="deck-controls" hidden>
    <button class="round no glass" type="button" id="btn-no" aria-label="Not for me">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
    <span class="count" id="count" aria-live="polite"></span>
    <button class="round yes glass" type="button" id="btn-yes" aria-label="More like this">
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 20.5l-1.3-1.2C5.9 15 3 12.4 3 9.2 3 6.6 5 4.6 7.6 4.6c1.6 0 3.2.8 4.4 2 1.2-1.2 2.8-2 4.4-2C19 4.6 21 6.6 21 9.2c0 3.2-2.9 5.8-7.7 10.1z"/></svg>
    </button>
  </div>
  <p class="hint" id="hint" hidden>Swipe or drag a card. Arrow keys work too.</p>
</div>`;

/**
 * Client script. Expects `CFG` ({ t, photos, liked, disliked }) and calls `onDeck(event, info)` for 'swipe' | 'state'.
 * Written without template literals so it can live inside this TS template string.
 */
export const DECK_JS = `
function createDeck(CFG, onDeck) {
  var $ = function (id) { return document.getElementById(id); };
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var h = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var stack = $('stack'), glow = $('glow'), state = $('deck-state'), controls = $('deck-controls'), count = $('count'), hint = $('hint');
  var LABEL = { music: 'Music', film: 'Film', comedy: 'Comedy', theatre: 'Theatre', dance: 'Dance', talk: 'Talk', tech_meetup: 'Meetup', art: 'Art',
    food_drink: 'Food and drink', nightlife: 'Night out', sports: 'Sport', workshop: 'Workshop', festival: 'Festival', family: 'Family', other: 'Something else' };
  var POSES = [[0, 0, 1, 0, 1], [16, 20, .95, 4, .82], [-12, 38, .9, -3.5, .66], [0, 52, .86, 0, .5]];
  var VISIBLE = 3;
  var order = [], total = 0, liked = CFG.liked || 0, disliked = CFG.disliked || 0, swiped = liked + disliked, busy = false, poll = null, gen = 0;

  function photo(cat) { return CFG.photos[cat] || CFG.photos.other; }
  function cardHtml(c) {
    var meta = [c.venue, c.price].filter(Boolean).join(', ');
    var tags = (c.tags || []).slice(0, 3).map(function (t) { return t.replace(/-/g, ' '); }).join(', ');
    return '<img src="' + h(c.image || photo(c.category)) + '" alt="" draggable="false" referrerpolicy="no-referrer">' +
      '<div class="chips"><span class="pill glass">' + h(String(c.when || '').replace(' \\u00b7 ', ', ')) + '</span>' +
      '<span class="pill glass">' + h(LABEL[c.category] || 'Event') + '</span></div>' +
      '<span class="stamp yes glass">More like this</span><span class="stamp no glass">Not for me</span>' +
      '<div class="panel glass"><h3>' + h(c.title) + '</h3>' + (meta ? '<span class="where">' + h(meta) + '</span>' : '') +
      '<p class="foot"><span class="tags">' + h(tags) + '</span>' +
      (c.url ? '<a class="more" href="' + h(c.url) + '" target="_blank" rel="noopener">Details</a>' : '') + '</p></div>';
  }

  function place(card, depth, stagger) {
    var p = POSES[Math.min(depth, POSES.length - 1)];
    card.style.setProperty('--x', p[0] + 'px'); card.style.setProperty('--y', p[1] + 'px');
    card.style.setProperty('--sc', p[2]); card.style.setProperty('--r', p[3] + 'deg'); card.style.setProperty('--dim', p[4]);
    card.style.setProperty('--delay', stagger ? depth * 45 + 'ms' : '0ms');
    card.style.zIndex = String(100 - depth);
    card.style.opacity = depth < VISIBLE ? '1' : '0';
    card.classList.toggle('is-top', depth === 0);
    card.inert = depth !== 0;
    card._glow.classList.toggle('on', depth === 0);
    if (depth === 0) refract(card);
  }
  function layout(stagger) { order.forEach(function (c, d) { place(c, d, stagger); }); }
  function counter() {
    count.innerHTML = order.length ? '<b>' + (total - order.length + 1) + '</b> of ' + total : '';
  }

  function show(kind, city) {
    // kind: loading | building | empty | failed | done | cards
    var cards = kind === 'cards';
    controls.hidden = !cards; hint.hidden = !cards;
    state.hidden = cards;
    state.classList.toggle('loading', kind === 'loading' || kind === 'building');
    var where = city ? ' in ' + h(city) : '';
    var copy = {
      loading: ['Looking at what\\u2019s on' + '<span class="dots"><i></i><i></i><i></i></span>', 'This takes a few seconds.'],
      building: ['Looking at what\\u2019s on' + where + '<span class="dots"><i></i><i></i><i></i></span>', 'The first time for a city takes about a minute. You can carry on below meanwhile.'],
      empty: ['Nothing to swipe right now', 'I couldn\\u2019t find enough on' + where + ' yet. Skip ahead: your mail and calendar tell me plenty.'],
      failed: ['Nothing to swipe right now', 'I couldn\\u2019t look up what\\u2019s on' + where + ' just now. Skip ahead: your mail and calendar tell me plenty.'],
      done: ['That\\u2019s all of them', liked + disliked ? 'You liked ' + liked + ' and passed on ' + disliked + '. Plenty to start with.' : 'Plenty to start with.'],
    }[kind];
    if (copy) { $('deck-state-h').innerHTML = copy[0]; $('deck-state-p').innerHTML = copy[1]; }
    onDeck('state', { kind: kind, city: city, swiped: swiped });
  }

  function clear() {
    order.forEach(function (c) { c.remove(); c._glow.remove(); });
    order = []; total = 0;
  }

  function build(cards) {
    clear();
    cards.forEach(function (c) {
      var el = document.createElement('article');
      el.className = 'card'; el._data = c;
      el.setAttribute('aria-label', c.title);
      el.innerHTML = cardHtml(c);
      var img = el.querySelector('img');
      img.addEventListener('error', function () { if (img.src.indexOf('/assets/') < 0) { img.src = photo(c.category); el._glow.src = img.src; } }, { once: true });
      var g = document.createElement('img'); g.alt = ''; g.src = img.getAttribute('src'); g.referrerPolicy = 'no-referrer';
      el._glow = g; glow.appendChild(g);
      stack.appendChild(el);
      order.push(el);
    });
    total = order.length;
    layout(false); counter();
  }

  function load() {
    var my = ++gen;
    clearTimeout(poll);
    return fetch('/onboard/deck?t=' + encodeURIComponent(CFG.t), { headers: { accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (d) {
        if (my !== gen) return;
        if (d.cards && d.cards.length) { build(d.cards); show('cards', d.city); return; }
        clear();
        if (d.status === 'building') { show('building', d.city); poll = setTimeout(load, 3000); return; }
        show(swiped ? 'done' : d.status === 'failed' ? 'failed' : 'empty', d.city);
      })
      .catch(function () { if (my === gen) { clear(); show('failed'); } });
  }

  function send(card, verdict, tries) {
    fetch('/onboard/swipe', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ t: CFG.t, suggestionId: card._data.suggestionId, verdict: verdict }) })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (d) { if (typeof d.liked === 'number') { liked = d.liked; disliked = d.disliked; } })
      .catch(function () { if (tries < 2) setTimeout(function () { send(card, verdict, tries + 1); }, 1500); });
  }

  function throwTop(dir, fromY) {
    if (busy || !order.length) return;
    busy = true;
    var card = order[0];
    card.classList.remove('dragging'); card.classList.add('flying');
    card._glow.classList.remove('on');
    card.style.transform = reduce ? '' : 'translate(' + dir * stack.offsetWidth * 1.6 + 'px, ' + ((fromY || 0) + 40) + 'px) rotate(' + dir * 24 + 'deg)';
    card.style.opacity = '0';
    order = order.slice(1);
    swiped++;
    if (dir > 0) liked++; else disliked++;
    send(card, dir > 0 ? 'like' : 'dislike', 0);
    layout(true); counter();
    onDeck('swipe', { dir: dir, card: card._data, swiped: swiped, left: order.length });
    setTimeout(function () {
      card.remove(); card._glow.remove();
      busy = false;
      if (!order.length) show('done');
    }, reduce ? 200 : 420);
  }

  var drag = null;
  stack.addEventListener('pointerdown', function (e) {
    var card = e.target.closest('.card.is-top');
    if (!card || busy || e.button > 0 || e.target.closest('a')) return;
    if (drag) { drag.card.classList.remove('dragging'); drag.card.style.transform = ''; }   // a lost pointerup
    drag = { card: card, id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), dx: 0, dy: 0, moved: false };
    card.setPointerCapture(e.pointerId);
  });
  stack.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    drag.dx = e.clientX - drag.x; drag.dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(drag.dx) < 4) return;
    if (!drag.moved) { drag.moved = true; drag.card.classList.add('dragging'); }
    drag.card.style.transform = 'translate(' + drag.dx + 'px, ' + drag.dy * .35 + 'px) rotate(' + drag.dx * .06 + 'deg)';
    var k = Math.max(-1, Math.min(1, drag.dx / 110));
    drag.card.style.setProperty('--yes', Math.max(0, k)); drag.card.style.setProperty('--no', Math.max(0, -k));
  });
  function release(e) {
    if (!drag || e.pointerId !== drag.id) return;
    var d = drag; drag = null;
    d.card.style.setProperty('--yes', 0); d.card.style.setProperty('--no', 0);
    if (!d.moved) return;
    var speed = Math.abs(d.dx) / Math.max(1, performance.now() - d.t);
    if (Math.abs(d.dx) > stack.offsetWidth * .3 || (speed > .55 && Math.abs(d.dx) > 30)) throwTop(Math.sign(d.dx), d.dy * .35);
    else { d.card.classList.remove('dragging'); d.card.style.transform = ''; }
  }
  stack.addEventListener('pointerup', release);
  stack.addEventListener('pointercancel', release);
  $('btn-yes').addEventListener('click', function () { throwTop(1); });
  $('btn-no').addEventListener('click', function () { throwTop(-1); });
  stack.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight') { e.preventDefault(); throwTop(1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); throwTop(-1); }
  });

  /* liquid glass refraction (Chromium only): an SVG displacement map bends the photo near the panel's edges. */
  var chromium = !!(navigator.userAgentData && navigator.userAgentData.brands && navigator.userAgentData.brands.some(function (b) { return /Chromium/.test(b.brand); }));
  var lens = chromium && CSS.supports('backdrop-filter', 'url(#x) blur(2px)');
  var defs = document.getElementById('glass-defs'), maps = {};
  function map(w, hgt, r, edge) {
    var c = document.createElement('canvas'); c.width = w; c.height = hgt;
    var g = c.getContext('2d'), img = g.createImageData(w, hgt), px = img.data;
    for (var y = 0; y < hgt; y++) for (var x = 0; x < w; x++) {
      var nx = 0, ny = 0, dist;
      var cx = Math.min(Math.max(x, r), w - r), cy = Math.min(Math.max(y, r), hgt - r);
      if ((x < r || x > w - r) && (y < r || y > hgt - r)) {
        var vx = x - cx, vy = y - cy, len = Math.hypot(vx, vy) || 1;
        dist = r - len; nx = vx / len; ny = vy / len;
      } else {
        var ds = [[x, -1, 0], [w - x, 1, 0], [y, 0, -1], [hgt - y, 0, 1]].sort(function (a, b) { return a[0] - b[0]; })[0];
        dist = ds[0]; nx = ds[1]; ny = ds[2];
      }
      var t = Math.max(0, 1 - Math.max(0, dist) / edge), mag = t * t, o = (y * w + x) * 4;
      px[o] = 128 - nx * mag * 127; px[o + 1] = 128 - ny * mag * 127; px[o + 2] = 128; px[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c.toDataURL();
  }
  function refract(card) {
    if (!lens || !defs) return;
    var p = card.querySelector('.panel');
    var w = p.offsetWidth, hgt = p.offsetHeight;
    if (!w || !hgt) return;
    var id = 'lg' + w + 'x' + hgt;
    if (!maps[id]) {
      maps[id] = true;
      defs.insertAdjacentHTML('beforeend', '<filter id="' + id + '" x="0" y="0" width="' + w + '" height="' + hgt + '" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" color-interpolation-filters="sRGB">' +
        '<feImage href="' + map(w, hgt, 22, 26) + '" x="0" y="0" width="' + w + '" height="' + hgt + '" preserveAspectRatio="none" result="m"/>' +
        '<feDisplacementMap in="SourceGraphic" in2="m" scale="34" xChannelSelector="R" yChannelSelector="G"/></filter>');
    }
    p.style.backdropFilter = 'url(#' + id + ') blur(9px) saturate(1.7) brightness(1.05)';
  }

  show('loading');
  return { load: load, reload: function () { clear(); show('building'); load(); }, count: function () { return swiped; } };
}
`;
