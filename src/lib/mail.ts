import { activeAccounts, providerRequest } from './connections';

export type MailSignal = { from: string; subject: string; snippet: string; date: string };

// Emails that tend to reveal taste: tickets, bookings, venue/artist newsletters.
const KEYWORDS = [
  'ticket', 'tickets', 'booking', 'reservation', 'concert', 'cinema', 'kino', 'festival', 'theatre',
  'theater', 'museum', 'exhibition', 'meetup', 'eventbrite', 'ticketmaster', 'dice', 'luma', 'eventim',
];

const MAX_MESSAGES = 80;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  return out;
}

type GmailList = { messages?: { id: string }[] };
type GmailMessage = { snippet?: string; internalDate?: string; payload?: { headers?: { name: string; value: string }[] } };

// Gmail answers on both hosts; which one Composio's proxy accepts depends on the toolkit's base URL.
const GMAIL_HOSTS = ['https://gmail.googleapis.com', 'https://www.googleapis.com'];
let gmailHost: string | undefined;

async function gmailGet<T>(userId: string, path: string): Promise<T> {
  if (gmailHost) return providerRequest<T>(userId, 'gmail', 'GET', `${gmailHost}${path}`);
  let lastErr: unknown;
  for (const host of GMAIL_HOSTS) {
    try {
      const data = await providerRequest<T>(userId, 'gmail', 'GET', `${host}${path}`);
      gmailHost = host;
      return data;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function gmailSignals(userId: string): Promise<MailSignal[]> {
  const q = `newer_than:1y (${KEYWORDS.join(' OR ')})`;
  const list = await gmailGet<GmailList>(
    userId,
    `/gmail/v1/users/me/messages?${new URLSearchParams({ q, maxResults: String(MAX_MESSAGES) })}`,
  );
  return mapLimit(list.messages ?? [], 10, async ({ id }) => {
    const m = await gmailGet<GmailMessage>(
      userId,
      `/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
    );
    const header = (name: string) => m.payload?.headers?.find(h => h.name === name)?.value ?? '';
    return {
      from: header('From'),
      subject: header('Subject'),
      snippet: m.snippet ?? '',
      date: m.internalDate ? new Date(Number(m.internalDate)).toISOString().slice(0, 10) : '',
    };
  });
}

type GraphMessages = {
  value?: { subject?: string; bodyPreview?: string; receivedDateTime?: string; from?: { emailAddress?: { name?: string; address?: string } } }[];
};

async function outlookSignals(userId: string): Promise<MailSignal[]> {
  const q = new URLSearchParams({
    $search: `"${KEYWORDS.join(' OR ')}"`,
    $top: String(MAX_MESSAGES),
    $select: 'subject,from,bodyPreview,receivedDateTime',
  });
  const data = await providerRequest<GraphMessages>(userId, 'outlook', 'GET', `https://graph.microsoft.com/v1.0/me/messages?${q}`);
  return (data.value ?? []).map(m => ({
    from: `${m.from?.emailAddress?.name ?? ''} <${m.from?.emailAddress?.address ?? ''}>`,
    subject: m.subject ?? '',
    snippet: (m.bodyPreview ?? '').slice(0, 200),
    date: (m.receivedDateTime ?? '').slice(0, 10),
  }));
}

/** Event-related emails from every connected mailbox. */
export async function getMailSignals(userId: string): Promise<MailSignal[]> {
  const accounts = await activeAccounts(userId);
  const all: MailSignal[] = [];
  if (accounts.has('gmail')) all.push(...(await gmailSignals(userId)));
  if (accounts.has('outlook')) all.push(...(await outlookSignals(userId)));
  return all;
}
