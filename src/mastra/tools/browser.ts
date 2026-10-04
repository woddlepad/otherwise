import Kernel from '@onkernel/sdk';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

// One Kernel cloud browser per user, reused across turns until it idles out.
// Cookies and logins persist in a Kernel profile named after the user.
// The browser is addressed by its name (unique among active sessions), not an ID kept in memory:
// Neon Functions isolates get evicted, and a second browser saving to the same profile would
// overwrite the first one's logins.
const IDLE_TIMEOUT_SECONDS = 15 * 60;

let kernel: Kernel | undefined;
function getKernel() {
  if (!process.env.KERNEL_API_KEY) throw new Error('KERNEL_API_KEY is not set');
  kernel ??= new Kernel({ apiKey: process.env.KERNEL_API_KEY });
  return kernel;
}

export const browserName = (userId: string) => `user-${userId}`;

function isStatus(err: unknown, ...statuses: number[]) {
  return err instanceof Kernel.APIError && statuses.includes(err.status as number);
}

function userIdFrom(requestContext: { get(key: string): unknown } | undefined): string {
  const userId = requestContext?.get('userId');
  if (typeof userId !== 'string') throw new Error('userId missing from request context');
  return userId;
}

async function ensureProfile(name: string) {
  try {
    await getKernel().profiles.create({ name });
  } catch (err) {
    if (!isStatus(err, 409)) throw err;
  }
}

async function createBrowser(name: string) {
  await ensureProfile(name);
  try {
    await getKernel().browsers.create({
      name,
      stealth: true,
      timeout_seconds: IDLE_TIMEOUT_SECONDS,
      profile: { name, save_changes: true },
    });
  } catch (err) {
    // 409: a concurrent request already started this user's browser, so use that one.
    if (!isStatus(err, 409)) throw err;
  }
}

export async function liveViewUrl(name: string) {
  const b = await getKernel().browsers.retrieve(name).catch(() => undefined);
  return b?.browser_live_view_url;
}

// Runs in the page (also used by the booking checkout, src/lib/booking/checkout.ts). Tags visible interactive elements with data-ref="N" so later code can target
// them with page.locator('[data-ref="N"]'). Plain string so bundlers can't rewrite it.
export const SNAPSHOT = String.raw`
return await page.evaluate(() => {
  const selector = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=option], [role=menuitem], [contenteditable=true]';
  document.querySelectorAll('[data-ref]').forEach(el => el.removeAttribute('data-ref'));
  const elements = [];
  let n = 0;
  for (const el of document.querySelectorAll(selector)) {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
    const ref = String(++n);
    el.setAttribute('data-ref', ref);
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.name || '')
      .trim().replace(/\s+/g, ' ').slice(0, 80);
    const type = el.getAttribute('type') ? ':' + el.getAttribute('type') : '';
    const href = el.tagName === 'A' ? ' -> ' + (el.getAttribute('href') || '').slice(0, 100) : '';
    elements.push('[' + ref + '] ' + el.tagName.toLowerCase() + type + ' "' + label + '"' + href);
    if (elements.length >= 150) break;
  }
  const text = document.body ? document.body.innerText.replace(/\n{3,}/g, '\n\n') : '';
  return { title: document.title, url: location.href, text: text.slice(0, 6000), truncated: text.length > 6000, elements };
});
`;

export async function execute(name: string, code: string, timeoutSec = 60) {
  const run = () => getKernel().browsers.playwright.execute(name, { code, timeout_sec: timeoutSec });
  try {
    return await run();
  } catch (err) {
    // No active browser (first use, idled out or closed): start one and retry once.
    if (!isStatus(err, 404, 410)) throw err;
    await createBrowser(name);
    return await run();
  }
}

export async function snapshot(name: string) {
  const res = await execute(name, SNAPSHOT, 30);
  return res.success ? res.result : { error: res.error };
}

/** Closes (and so saves the profile of) a user's browser; already gone is fine. */
export async function closeBrowser(name: string) {
  await getKernel().browsers.deleteByID(name).catch(err => {
    if (!isStatus(err, 404, 410)) throw err;
  });
}

export const browserOpen = createTool({
  id: 'browser-open',
  description:
    "Open a URL in the user's cloud browser (Kernel) and return the page title, visible text and a numbered list of clickable/fillable elements. Use for pages that need interaction, logins or JavaScript; prefer web-search / read-page for plain reading.",
  inputSchema: z.object({ url: z.string().url() }),
  execute: async ({ url }, { requestContext }) => {
    const name = browserName(userIdFrom(requestContext));
    const nav = await execute(
      name,
      `await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded', timeout: 30000 });
       await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});`,
    );
    if (!nav.success) return { error: nav.error, liveViewUrl: await liveViewUrl(name) };
    const [page, live] = await Promise.all([snapshot(name), liveViewUrl(name)]);
    return { page, liveViewUrl: live };
  },
});

export const browserAct = createTool({
  id: 'browser-act',
  description: `Run Playwright (TypeScript) code against the current page in the user's cloud browser, then return a fresh snapshot.
\`page\`, \`context\` and \`browser\` are in scope. Target elements from the last snapshot with page.locator('[data-ref="N"]'),
e.g. await page.locator('[data-ref="12"]').click(); await page.locator('[data-ref="3"]').fill('Berlin'); await page.keyboard.press('Enter').
Anything you \`return\` comes back as \`result\`. Do one or a few steps per call and check the snapshot before continuing.
Never submit a payment, send a message or create an account without the user's explicit OK.`,
  inputSchema: z.object({
    code: z.string().describe('Playwright statements; may use await and return'),
    snapshot: z.boolean().optional().describe('Return a page snapshot afterwards (default true)'),
  }),
  execute: async ({ code, snapshot: wantSnapshot }, { requestContext }) => {
    const name = browserName(userIdFrom(requestContext));
    const res = await execute(name, `${code}\n;await page.waitForLoadState('domcontentloaded').catch(() => {});`);
    const [page, live] = await Promise.all([
      wantSnapshot === false ? undefined : snapshot(name),
      liveViewUrl(name),
    ]);
    return { success: res.success, result: res.result, error: res.error, page, liveViewUrl: live };
  },
});

export const browserClose = createTool({
  id: 'browser-close',
  description: "Close the user's cloud browser when a task is done. This saves cookies and logins to their profile.",
  inputSchema: z.object({}),
  execute: async (_input, { requestContext }) => {
    await closeBrowser(browserName(userIdFrom(requestContext)));
    return { ok: true };
  },
});
