import { Composio } from '@composio/core';

/**
 * Mail + calendar access through Composio. Its managed OAuth apps mean we don't register our own
 * Google/Microsoft apps. We keep calling the providers' REST APIs ourselves; Composio's proxy adds
 * the user's credentials server-side, so no tokens ever reach this app.
 */
export type Provider = 'google' | 'microsoft';
export type Toolkit = 'gmail' | 'googlecalendar' | 'outlook';

/** Toolkits a provider needs, connected one after another during onboarding. */
export const PROVIDER_TOOLKITS: Record<Provider, Toolkit[]> = {
  google: ['gmail', 'googlecalendar'],
  microsoft: ['outlook'],
};

export function isProvider(p: string): p is Provider {
  return p === 'google' || p === 'microsoft';
}

export function isComposioConfigured() {
  return Boolean(process.env.COMPOSIO_API_KEY);
}

export function publicUrl(path = '') {
  const base = (process.env.PUBLIC_URL || 'http://localhost:4111').replace(/\/$/, '');
  return `${base}${path}`;
}

let composio: Composio | undefined;
function getComposio() {
  if (!process.env.COMPOSIO_API_KEY) throw new Error('COMPOSIO_API_KEY is not set');
  composio ??= new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
  return composio;
}

/** Composio's hosted connect page for one toolkit; it sends the user back to `callbackUrl`. */
export async function connectLink(userId: string, toolkit: Toolkit, callbackUrl: string) {
  const session = await getComposio().create(userId, { manageConnections: false });
  const request = await session.authorize(toolkit, { callbackUrl });
  if (!request.redirectUrl) throw new Error(`no redirect URL from Composio for ${toolkit}`);
  return request.redirectUrl;
}

// Reading a mailbox makes dozens of proxied calls; don't list accounts before each one.
const accountCache = new Map<string, { at: number; accounts: Map<Toolkit, string> }>();
const ACCOUNT_CACHE_MS = 30_000;

/** The newest ACTIVE connected account per toolkit (cached briefly; `fresh` skips the cache). */
export async function activeAccounts(userId: string, fresh = false): Promise<Map<Toolkit, string>> {
  if (!isComposioConfigured()) return new Map();
  const cached = accountCache.get(userId);
  if (!fresh && cached && Date.now() - cached.at < ACCOUNT_CACHE_MS) return cached.accounts;
  const accounts = await listActiveAccounts(userId);
  accountCache.set(userId, { at: Date.now(), accounts });
  return accounts;
}

async function listActiveAccounts(userId: string): Promise<Map<Toolkit, string>> {
  const { items } = await getComposio().connectedAccounts.list({
    userIds: [userId],
    statuses: ['ACTIVE'],
    orderBy: 'created_at',
  });
  const out = new Map<Toolkit, string>();
  for (const a of items) {
    const slug = a.toolkit.slug as Toolkit;
    if (!out.has(slug)) out.set(slug, a.id);
  }
  return out;
}

/** Which providers are usable: Google needs both Gmail and Calendar. */
export async function connectedProviders(userId: string, fresh = false): Promise<Provider[]> {
  const accounts = await activeAccounts(userId, fresh);
  return (Object.keys(PROVIDER_TOOLKITS) as Provider[]).filter(p => PROVIDER_TOOLKITS[p].every(t => accounts.has(t)));
}

/** Polls briefly: right after the redirect back, Composio can still report the account as INITIATED. */
export async function waitForToolkit(userId: string, toolkit: Toolkit, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await activeAccounts(userId, true)).has(toolkit)) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

/**
 * An authenticated request to the provider's API as this user. `url` is absolute
 * (e.g. https://graph.microsoft.com/v1.0/me/messages); query params go in the URL.
 */
export async function providerRequest<T>(
  userId: string,
  toolkit: Toolkit,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const accountId = (await activeAccounts(userId)).get(toolkit);
  if (!accountId) throw new Error(`${toolkit} is not connected`);
  const u = new URL(url);
  const parameters = [
    ...[...u.searchParams].map(([name, value]) => ({ in: 'query' as const, name, value })),
    ...Object.entries(opts.headers ?? {}).map(([name, value]) => ({ in: 'header' as const, name, value })),
  ];
  const res = await getComposio().tools.proxyExecute({
    endpoint: `${u.origin}${u.pathname}`,
    method,
    connectedAccountId: accountId,
    parameters,
    ...(opts.body === undefined ? {} : { body: opts.body }),
  });
  if (res.status >= 400) throw new Error(`${method} ${u.pathname} via ${toolkit} → ${res.status} ${JSON.stringify(res.data).slice(0, 300)}`);
  return res.data as T;
}
