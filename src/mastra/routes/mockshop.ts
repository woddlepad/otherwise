import { randomBytes } from 'node:crypto';
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { db } from '../../lib/db';
import { formatLocal, zonedToUtc } from '../../lib/events/time';
import {
  CATALOGUE,
  MEMBER_PASSWORD,
  SHOP_NAME,
  SHOP_PATH,
  SHOP_TZ,
  acceptedCard,
  euro,
  findMockEvent,
  isFree,
  mockShopEnabled,
  priceOrder,
  showtimes,
  sign,
  standardPrice,
  verify,
  type MockEvent,
} from '../../lib/mockshop';
import { esc } from './onboarding';
import { devGuard } from './whatsapp';

/**
 * Ticketeria, the mock ticket shop (src/lib/mockshop.ts), served only with MOCK_SHOP=1 (404 otherwise).
 * Plain server-rendered forms with real POST → redirect steps, so a browser has to click through:
 * events → event (showtime, ticket type, qty) → [login] → checkout (name, email, terms) → payment (card) → order.
 * The cart travels as a signed token in the URL; the shop login is a signed cookie. Card numbers are never stored or logged.
 */

type Cart = { id: string; slug: string; showtime: string; type: string; qty: number; name?: string; email?: string };
const MEMBER_COOKIE = 'tkt_member';
const MAX_QTY = 6;

const when = (local: string) => formatLocal(zonedToUtc(local, SHOP_TZ)!, SHOP_TZ);
const member = (c: Context) => verify<{ email: string }>(getCookie(c, MEMBER_COOKIE))?.email ?? null;

const layout = (c: Context, title: string, body: string) => {
  const who = member(c);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · ${SHOP_NAME}</title>
<style>
  :root{--ink:#1d1a16;--paper:#f6f1e7;--card:#fffaf0;--line:#e2d8c6;--muted:#7a6f60;--accent:#c8402a;--ok:#2f7d4f}
  *{box-sizing:border-box} body{margin:0;font:16px/1.5 ui-sans-serif,system-ui,sans-serif;color:var(--ink);background:var(--paper)}
  header{display:flex;align-items:baseline;justify-content:space-between;padding:14px 22px;border-bottom:2px solid var(--ink)}
  .logo{font:700 24px/1 Georgia,serif;letter-spacing:-.5px;color:var(--ink);text-decoration:none}
  .logo span{color:var(--accent)} .who{font-size:13px;color:var(--muted)} .who a{color:inherit}
  main{max-width:720px;margin:0 auto;padding:22px}
  h1{font:700 30px/1.15 Georgia,serif;margin:6px 0 8px} h2{font:600 13px/1 ui-sans-serif;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:26px 0 10px}
  .muted{color:var(--muted)} .small{font-size:13px}
  .ev{display:grid;grid-template-columns:76px 1fr auto;gap:16px;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:14px;margin:0 0 10px;color:inherit;text-decoration:none}
  .date{border:2px solid var(--ink);text-align:center;font:700 13px/1.2 ui-monospace,monospace;padding:6px 0}
  .date b{display:block;font:700 24px/1 Georgia,serif}
  .price{font:600 15px ui-monospace,monospace;white-space:nowrap}
  .box{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:18px;margin:14px 0}
  label{display:block;font-size:14px;font-weight:600;margin:14px 0 5px}
  input,select{width:100%;padding:10px;border:1px solid #b9ad99;border-radius:4px;background:#fff;font:inherit;color:var(--ink)}
  input[type=radio],input[type=checkbox]{width:auto;margin-right:8px}
  .opt{display:flex;align-items:center;font-weight:400;margin:6px 0}
  button{margin-top:18px;width:100%;padding:13px;border:0;border-radius:4px;background:var(--ink);color:var(--paper);font:700 16px ui-sans-serif;cursor:pointer}
  button.pay{background:var(--accent)}
  table{width:100%;border-collapse:collapse} td{padding:6px 0;border-bottom:1px dashed var(--line)} td:last-child{text-align:right;font-family:ui-monospace,monospace}
  tr.total td{border:0;font-weight:700;font-size:18px;padding-top:12px}
  .err{background:#fbe3dd;border:1px solid var(--accent);color:#7a1d0e;padding:10px 12px;border-radius:4px}
  .ok{color:var(--ok)} .two{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .qr{display:grid;grid-template-columns:repeat(21,8px);gap:0;width:max-content;padding:12px;background:#fff;border:1px solid var(--line)}
  .qr i{width:8px;height:8px;display:block} .qr i.on{background:var(--ink)}
  footer{max-width:720px;margin:0 auto;padding:0 22px 30px;font-size:12px;color:var(--muted)} footer a{color:inherit}
</style></head><body>
<header><a class="logo" href="${SHOP_PATH}">Ticket<span>eria</span></a>
<span class="who">${who ? `Signed in as ${esc(who)}` : `<a href="${SHOP_PATH}/login">Sign in</a>`} · Berlin</span></header>
<main>${body}</main>
<footer>${SHOP_NAME} GmbH (not really) · <a href="${SHOP_PATH}/terms">Terms &amp; refunds</a> · This is a test shop: nothing here is real.</footer>
</body></html>`;
};

/** Every shop route 404s unless MOCK_SHOP=1. */
function shopRoute(path: string, method: 'GET' | 'POST', handler: (c: Context) => Promise<Response> | Response) {
  return registerApiRoute(`${SHOP_PATH}${path}`, {
    method,
    requiresAuth: false,
    handler: async c => (mockShopEnabled() ? handler(c) : c.text('not found', 404)),
  });
}

const notFound = (c: Context, what = 'That page') =>
  c.html(layout(c, 'Not found', `<h1>Not found</h1><p class="muted">${what} doesn't exist (any more).</p><p><a href="${SHOP_PATH}">All events</a></p>`), 404);

/** A cart from the URL token, checked against the catalogue (showtime still on sale, real ticket type, sane qty). */
function loadCart(token: string | undefined): { cart: Cart; event: MockEvent } | null {
  const cart = verify<Cart>(token);
  const event = cart && findMockEvent(cart.slug);
  if (!cart || !event || !showtimes(event).includes(cart.showtime)) return null;
  if (!event.ticketTypes.some(t => t.id === cart.type) || !Number.isInteger(cart.qty) || cart.qty < 1 || cart.qty > MAX_QTY) return null;
  return { cart, event };
}

const needsLogin = (c: Context, event: MockEvent) => event.variant === 'login-required' && !member(c);
const loginRedirect = (c: Context, next: string) => c.redirect(`${SHOP_PATH}/login?next=${encodeURIComponent(next)}`, 303);

function summary(event: MockEvent, cart: Cart, withFees: boolean) {
  const p = priceOrder(event, cart.type, cart.qty);
  const rows = [
    `<tr><td>${cart.qty} × ${esc(p.type.name)} @ ${euro(p.type.priceCents)}</td><td>${euro(p.subtotal)}</td></tr>`,
    ...(withFees && p.fees ? [`<tr><td>Service fee ${cart.qty} × ${euro(event.feeCents!)}</td><td>${euro(p.fees)}</td></tr>`] : []),
    `<tr class="total"><td>${withFees ? 'Total' : 'Subtotal'}</td><td>${euro(withFees ? p.total : p.subtotal)}</td></tr>`,
  ];
  return `<div class="box"><strong>${esc(event.title)}</strong><br><span class="muted">${esc(when(cart.showtime))} · ${esc(event.venue)}, ${esc(event.address)}</span>
<table style="margin-top:10px">${rows.join('')}</table></div>`;
}

const ORDER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const orderNo = () => `TK-${[...randomBytes(6)].map(b => ORDER_ALPHABET[b % ORDER_ALPHABET.length]).join('')}`;

async function placeOrder(c: Context, event: MockEvent, cart: Cart, cardLast4: string | null) {
  const p = priceOrder(event, cart.type, cart.qty);
  // One order per cart: a double submit (or a retry after a timeout) returns the first order.
  await db.query(
    `INSERT INTO mock_orders (order_no, cart_id, event_slug, showtime, qty, ticket_type, unit_price_cents, fees_cents, total_cents,
                              attendee_name, attendee_email, member_email, card_last4)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT (cart_id) DO NOTHING`,
    [orderNo(), cart.id, event.slug, cart.showtime, cart.qty, p.type.name, p.type.priceCents, p.fees, p.total,
     cart.name ?? null, cart.email ?? null, member(c), cardLast4],
  );
  const { rows } = await db.query<{ order_no: string }>(`SELECT order_no FROM mock_orders WHERE cart_id = $1`, [cart.id]);
  return c.redirect(`${SHOP_PATH}/order/${rows[0].order_no}`, 303);
}

// ---------- pages ----------

export const shopHome = shopRoute('', 'GET', c => {
  const list = CATALOGUE.map(e => {
    const first = zonedToUtc(showtimes(e)[0], SHOP_TZ)!;
    const [wd, day, mon] = formatLocal(first, SHOP_TZ, false).replace(',', '').split(' ');
    return `<a class="ev" href="${SHOP_PATH}/e/${e.slug}"><div class="date">${esc(wd)}<b>${esc(day)}</b>${esc(mon)}</div>
<div><strong>${esc(e.title)}</strong><br><span class="muted small">${esc(e.venue)} · ${e.times.join(' / ')}</span></div>
<div class="price">${isFree(e) ? 'Free' : euro(standardPrice(e))}</div></a>`;
  });
  return c.html(layout(c, 'Berlin', `<h1>This week in Berlin</h1><p class="muted">Small rooms, good nights. ${CATALOGUE.length} events on sale.</p>${list.join('')}`));
});

export const shopEvent = shopRoute('/e/:slug', 'GET', c => {
  const event = findMockEvent(c.req.param('slug') ?? '');
  if (!event) return notFound(c, 'That event');
  const times = showtimes(event);
  const error = c.req.query('error');
  return c.html(
    layout(
      c,
      event.title,
      `<p class="muted small"><a href="${SHOP_PATH}" style="color:inherit">← All events</a></p>
<h1>${esc(event.title)}</h1>
<p>${esc(event.blurb)}</p>
<p class="muted">${esc(event.venue)}, ${esc(event.address)}</p>
<p class="price">${isFree(event) ? 'Free entry · RSVP required' : `${euro(standardPrice(event))} per ticket`}</p>
${event.variant === 'login-required' ? `<p class="small muted">Members only: you'll be asked to sign in with your ${SHOP_NAME} account.</p>` : ''}
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="${SHOP_PATH}/e/${event.slug}" class="box">
  <label>Showtime</label>
  ${times.map((t, i) => `<label class="opt"><input type="radio" name="showtime" value="${t}" ${i === 0 ? 'checked' : ''} required>${esc(when(t))}</label>`).join('')}
  <label for="type">Ticket type</label>
  <select id="type" name="type">${event.ticketTypes.map(t => `<option value="${t.id}">${esc(t.name)}${isFree(event) ? '' : ` · ${euro(t.priceCents)}`}</option>`).join('')}</select>
  <label for="qty">Quantity</label>
  <select id="qty" name="qty">${Array.from({ length: MAX_QTY }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('')}</select>
  <button type="submit">${isFree(event) ? 'RSVP' : 'Get tickets'}</button>
</form>`,
    ),
  );
});

export const shopAddToCart = shopRoute('/e/:slug', 'POST', async c => {
  const event = findMockEvent(c.req.param('slug') ?? '');
  if (!event) return notFound(c, 'That event');
  const form = await c.req.parseBody();
  const cart: Cart = {
    id: randomBytes(9).toString('base64url'),
    slug: event.slug,
    showtime: String(form.showtime ?? ''),
    type: String(form.type ?? ''),
    qty: Number(form.qty),
  };
  if (!loadCart(sign(cart))) {
    return c.redirect(`${SHOP_PATH}/e/${event.slug}?error=${encodeURIComponent('Please pick a showtime, ticket type and quantity.')}`, 303);
  }
  const next = `${SHOP_PATH}/checkout?c=${sign(cart)}`;
  return needsLogin(c, event) ? loginRedirect(c, next) : c.redirect(next, 303);
});

export const shopCheckout = shopRoute('/checkout', 'GET', c => {
  const token = c.req.query('c');
  const loaded = loadCart(token);
  if (!loaded) return notFound(c, 'This checkout');
  const { cart, event } = loaded;
  if (needsLogin(c, event)) return loginRedirect(c, `${SHOP_PATH}/checkout?c=${token}`);
  const error = c.req.query('error');
  return c.html(
    layout(
      c,
      'Checkout',
      `<h1>Checkout</h1>${summary(event, cart, false)}
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="${SHOP_PATH}/checkout" class="box">
  <input type="hidden" name="c" value="${esc(token)}">
  <label for="name">Name on the tickets</label><input id="name" name="name" autocomplete="name" required value="${esc(cart.name)}">
  <label for="email">Email for the tickets</label><input id="email" name="email" type="email" autocomplete="email" required value="${esc(cart.email ?? member(c) ?? '')}">
  <label class="opt"><input type="checkbox" name="terms" value="1" required>I accept the <a href="${SHOP_PATH}/terms" target="_blank">terms &amp; refund policy</a></label>
  <button type="submit">${isFree(event) ? 'Reserve' : 'Continue to payment'}</button>
</form>`,
    ),
  );
});

export const shopCheckoutSubmit = shopRoute('/checkout', 'POST', async c => {
  const form = await c.req.parseBody();
  const token = String(form.c ?? '');
  const loaded = loadCart(token);
  if (!loaded) return notFound(c, 'This checkout');
  const { event } = loaded;
  if (needsLogin(c, event)) return loginRedirect(c, `${SHOP_PATH}/checkout?c=${token}`);
  const name = String(form.name ?? '').trim();
  const email = String(form.email ?? '').trim();
  const back = (msg: string) => c.redirect(`${SHOP_PATH}/checkout?c=${token}&error=${encodeURIComponent(msg)}`, 303);
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return back('Please enter a name and a valid email.');
  if (form.terms !== '1') return back('Please accept the terms to continue.');
  const cart = { ...loaded.cart, name, email };
  if (isFree(event)) return placeOrder(c, event, cart, null);
  return c.redirect(`${SHOP_PATH}/pay?c=${sign(cart)}`, 303);
});

function payPage(c: Context, token: string, event: MockEvent, cart: Cart, error?: string) {
  const total = priceOrder(event, cart.type, cart.qty).total;
  return layout(
    c,
    'Payment',
    `<h1>Payment</h1>${summary(event, cart, true)}
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="${SHOP_PATH}/pay" class="box" autocomplete="on">
  <input type="hidden" name="c" value="${esc(token)}">
  <label for="holder">Name on card</label><input id="holder" name="holder" autocomplete="cc-name" required>
  <label for="number">Card number</label><input id="number" name="number" autocomplete="cc-number" inputmode="numeric" placeholder="1234 5678 9012 3456" required>
  <div class="two">
    <div><label for="exp">Expiry</label><input id="exp" name="exp" autocomplete="cc-exp" placeholder="MM/YY" required></div>
    <div><label for="cvc">CVC</label><input id="cvc" name="cvc" autocomplete="cc-csc" inputmode="numeric" placeholder="123" required></div>
  </div>
  <button type="submit" class="pay">Pay ${euro(total)}</button>
  <p class="small muted">Charged by ${SHOP_NAME}. Booking for ${esc(cart.name)} (${esc(cart.email)}).</p>
</form>`,
  );
}

export const shopPay = shopRoute('/pay', 'GET', c => {
  const token = c.req.query('c') ?? '';
  const loaded = loadCart(token);
  if (!loaded?.cart.email || isFree(loaded.event)) return notFound(c, 'This payment');
  if (needsLogin(c, loaded.event)) return loginRedirect(c, `${SHOP_PATH}/pay?c=${token}`);
  return c.html(payPage(c, token, loaded.event, loaded.cart));
});

export const shopPaySubmit = shopRoute('/pay', 'POST', async c => {
  const form = await c.req.parseBody();
  const token = String(form.c ?? '');
  const loaded = loadCart(token);
  if (!loaded?.cart.email || isFree(loaded.event)) return notFound(c, 'This payment');
  if (needsLogin(c, loaded.event)) return loginRedirect(c, `${SHOP_PATH}/pay?c=${token}`);
  const number = String(form.number ?? '').replace(/\D/g, '');
  const exp = String(form.exp ?? '').match(/^\s*(\d{2})\s*\/\s*(\d{2})\s*$/);
  const expired = !exp || Number(exp[1]) < 1 || Number(exp[1]) > 12 || new Date(2000 + Number(exp[2]), Number(exp[1])) < new Date();
  const accepted = acceptedCard();
  // The declined page never echoes what was typed.
  if (!accepted || number !== accepted || expired || !/^\d{3,4}$/.test(String(form.cvc ?? '').trim())) {
    return c.html(payPage(c, token, loaded.event, loaded.cart, 'Your card was declined. Please check the details or use another card.'), 402);
  }
  return placeOrder(c, loaded.event, loaded.cart, number.slice(-4));
});

type OrderRow = {
  order_no: string; event_slug: string; showtime: string; qty: number; ticket_type: string; total_cents: number;
  fees_cents: number; attendee_name: string | null; attendee_email: string | null; card_last4: string | null;
};
async function loadOrder(no: string) {
  const { rows } = await db.query<OrderRow>(`SELECT * FROM mock_orders WHERE order_no = $1`, [no]);
  const order = rows[0];
  const event = order && findMockEvent(order.event_slug);
  return order && event ? { order, event } : null;
}

export const shopOrder = shopRoute('/order/:no', 'GET', async c => {
  const loaded = await loadOrder(c.req.param('no') ?? '');
  if (!loaded) return notFound(c, 'That order');
  const { order, event } = loaded;
  return c.html(
    layout(
      c,
      `Order ${order.order_no}`,
      `<p class="ok"><strong>✓ ${isFree(event) ? 'Reservation' : 'Order'} confirmed</strong></p>
<h1>Order ${esc(order.order_no)}</h1>
<div class="box"><strong>${esc(event.title)}</strong><br><span class="muted">${esc(when(order.showtime))} · ${esc(event.venue)}, ${esc(event.address)}</span>
<table style="margin-top:10px">
<tr><td>Tickets</td><td>${order.qty} × ${esc(order.ticket_type)}</td></tr>
<tr><td>Name</td><td>${esc(order.attendee_name)}</td></tr>
${order.fees_cents ? `<tr><td>Service fees</td><td>${euro(order.fees_cents)}</td></tr>` : ''}
<tr class="total"><td>${order.total_cents ? `Paid${order.card_last4 ? ` (card •••• ${esc(order.card_last4)})` : ''}` : 'Price'}</td><td>${order.total_cents ? euro(order.total_cents) : 'Free'}</td></tr>
</table></div>
<p>We've sent the tickets to ${esc(order.attendee_email)}. <a href="${SHOP_PATH}/ticket/${esc(order.order_no)}">Open your tickets</a></p>`,
    ),
  );
});

/** A QR-looking 21×21 grid from the order number: just for show, nothing scans it. */
function fakeQr(seed: string) {
  let h = 2166136261;
  const cells: string[] = [];
  for (let i = 0; i < 21 * 21; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i % seed.length) ^ i, 16777619) >>> 0;
    const x = i % 21;
    const y = Math.floor(i / 21);
    const finder = [[0, 0], [14, 0], [0, 14]].some(([fx, fy]) => {
      const dx = x - fx;
      const dy = y - fy;
      return dx >= 0 && dx < 7 && dy >= 0 && dy < 7 && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
    });
    const inFinderZone = [[0, 0], [14, 0], [0, 14]].some(([fx, fy]) => x - fx >= -1 && x - fx < 8 && y - fy >= -1 && y - fy < 8);
    cells.push(`<i${finder || (!inFinderZone && h % 2) ? ' class="on"' : ''}></i>`);
  }
  return `<div class="qr">${cells.join('')}</div>`;
}

export const shopTicket = shopRoute('/ticket/:no', 'GET', async c => {
  const loaded = await loadOrder(c.req.param('no') ?? '');
  if (!loaded) return notFound(c, 'That ticket');
  const { order, event } = loaded;
  return c.html(
    layout(
      c,
      `Tickets ${order.order_no}`,
      `<h1>${esc(event.title)}</h1><p class="muted">${esc(when(order.showtime))} · ${esc(event.venue)}</p>
<div class="box" style="display:flex;gap:22px;align-items:center;flex-wrap:wrap">${fakeQr(order.order_no)}
<div><div class="price">${esc(order.order_no)}</div><p>${order.qty} × ${esc(order.ticket_type)}<br>${esc(order.attendee_name)}</p>
<p class="small muted">Show this code at the door.</p></div></div>`,
    ),
  );
});

// ---------- account (login-required events) ----------

const safeNext = (next: unknown) => (typeof next === 'string' && next.startsWith(`${SHOP_PATH}/`) ? next : SHOP_PATH);

function loginPage(c: Context, next: string, error?: string) {
  return layout(
    c,
    'Sign in',
    `<h1>Sign in</h1><p class="muted">Members' events need a ${SHOP_NAME} account.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="${SHOP_PATH}/login" class="box">
  <input type="hidden" name="next" value="${esc(next)}">
  <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required>
  <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Sign in</button>
</form>
<p class="small">No account yet? <a href="${SHOP_PATH}/signup">Create one</a></p>`,
  );
}

export const shopLogin = shopRoute('/login', 'GET', c => c.html(loginPage(c, safeNext(c.req.query('next')))));

export const shopLoginSubmit = shopRoute('/login', 'POST', async c => {
  const form = await c.req.parseBody();
  const next = safeNext(form.next);
  const email = String(form.email ?? '').trim();
  if (!/^[^@\s]+@[^@\s]+$/.test(email) || form.password !== MEMBER_PASSWORD) {
    return c.html(loginPage(c, next, 'Wrong email or password.'), 401);
  }
  setCookie(c, MEMBER_COOKIE, sign({ email }), { path: SHOP_PATH, httpOnly: true, sameSite: 'Lax', maxAge: 86_400 });
  return c.redirect(next, 303);
});

export const shopSignup = shopRoute('/signup', 'GET', c =>
  c.html(layout(c, 'Sign up', `<h1>Sign-ups are paused</h1><p class="muted">New memberships open again next season. Existing members can <a href="${SHOP_PATH}/login">sign in</a>.</p>`)),
);

export const shopTerms = shopRoute('/terms', 'GET', c =>
  c.html(
    layout(
      c,
      'Terms',
      `<h1>Terms &amp; refunds</h1><div class="box">
<p><strong>Cancellation.</strong> Tickets can be cancelled free of charge in your ${SHOP_NAME} order up to 24 hours before the show. The full price is refunded to the original payment method.</p>
<p><strong>Transfers.</strong> Tickets are personal but may be passed on: change the name in your order.</p>
<p><strong>Fees.</strong> Some events carry a service fee per ticket, shown before you pay.</p></div>`,
    ),
  ),
);

/** Dev: GET /dev/mock-orders?since=<iso>&limit=50, newest first (the worktrees plugin's mock_orders tool reads this). */
export const devMockOrders = registerApiRoute('/dev/mock-orders', {
  method: 'GET',
  requiresAuth: false,
  handler: async c => {
    const denied = devGuard(c);
    if (denied) return denied;
    if (!mockShopEnabled()) return c.json({ error: 'MOCK_SHOP is not 1 in this app' }, 404);
    const since = c.req.query('since') || null;
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 500);
    const { rows } = await db.query(
      `SELECT order_no AS "orderNo", event_slug AS "eventSlug", showtime, qty, ticket_type AS "ticketType",
              unit_price_cents AS "unitPriceCents", fees_cents AS "feesCents", total_cents AS "totalCents",
              attendee_name AS "attendeeName", attendee_email AS "attendeeEmail", member_email AS "memberEmail",
              card_last4 AS "cardLast4", created_at AS "createdAt"
       FROM mock_orders WHERE ($1::timestamptz IS NULL OR created_at > $1::timestamptz) ORDER BY created_at DESC LIMIT $2`,
      [since, limit],
    );
    return c.json({ orders: rows });
  },
});

export const mockShopRoutes = [
  shopHome, shopEvent, shopAddToCart, shopCheckout, shopCheckoutSubmit, shopPay, shopPaySubmit, shopOrder, shopTicket,
  shopLogin, shopLoginSubmit, shopSignup, shopTerms, devMockOrders,
];
