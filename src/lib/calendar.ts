import { activeAccounts, providerRequest } from './connections';

export type CalendarEvent = { title: string; start: string; end: string; location?: string; busy: boolean };

type GoogleEvents = {
  items?: { summary?: string; location?: string; transparency?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } }[];
};
type GraphEvents = {
  value?: { subject?: string; showAs?: string; location?: { displayName?: string }; start: { dateTime: string }; end: { dateTime: string } }[];
};

async function googleEvents(userId: string, from: Date, to: Date): Promise<CalendarEvent[]> {
  const q = new URLSearchParams({
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
  });
  const data = await providerRequest<GoogleEvents>(userId, 'googlecalendar', 'GET', `https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`);
  return (data.items ?? []).map(e => ({
    title: e.summary ?? '(no title)',
    start: e.start?.dateTime ?? e.start?.date ?? '',
    end: e.end?.dateTime ?? e.end?.date ?? '',
    location: e.location,
    busy: e.transparency !== 'transparent',
  }));
}

async function microsoftEvents(userId: string, from: Date, to: Date): Promise<CalendarEvent[]> {
  const q = new URLSearchParams({
    startDateTime: from.toISOString(),
    endDateTime: to.toISOString(),
    $select: 'subject,start,end,location,showAs',
    $orderby: 'start/dateTime',
    $top: '250',
  });
  const data = await providerRequest<GraphEvents>(userId, 'outlook', 'GET', `https://graph.microsoft.com/v1.0/me/calendarView?${q}`, {
    headers: { Prefer: 'outlook.timezone="UTC"' },
  });
  return (data.value ?? []).map(e => ({
    title: e.subject ?? '(no title)',
    start: `${e.start.dateTime}Z`,
    end: `${e.end.dateTime}Z`,
    location: e.location?.displayName || undefined,
    busy: e.showAs !== 'free',
  }));
}

/** Events across every connected calendar, sorted by start. */
export async function getCalendarEvents(userId: string, from: Date, to: Date): Promise<CalendarEvent[]> {
  const accounts = await activeAccounts(userId);
  const all: CalendarEvent[] = [];
  if (accounts.has('googlecalendar')) all.push(...(await googleEvents(userId, from, to)));
  if (accounts.has('outlook')) all.push(...(await microsoftEvents(userId, from, to)));
  return all.sort((a, b) => a.start.localeCompare(b.start));
}

/** Busy blocks overlapping [from, to]. Empty array = free. */
export async function getBusy(userId: string, from: Date, to: Date) {
  const events = await getCalendarEvents(userId, from, to);
  return events.filter(e => e.busy).map(({ title, start, end }) => ({ title, start, end }));
}

/** Puts a booked event on the first connected calendar. */
export async function addCalendarEvent(
  userId: string,
  e: { title: string; start: string; end: string; location?: string; description?: string },
) {
  const accounts = await activeAccounts(userId);
  if (accounts.has('googlecalendar')) {
    return providerRequest(userId, 'googlecalendar', 'POST', 'https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      body: { summary: e.title, location: e.location, description: e.description, start: { dateTime: e.start }, end: { dateTime: e.end } },
    });
  }
  if (!accounts.has('outlook')) return null;
  return providerRequest(userId, 'outlook', 'POST', 'https://graph.microsoft.com/v1.0/me/events', { body: {
    subject: e.title,
    body: { contentType: 'text', content: e.description ?? '' },
    location: { displayName: e.location ?? '' },
    start: { dateTime: e.start, timeZone: 'UTC' },
    end: { dateTime: e.end, timeZone: 'UTC' },
  } });
}
