# Structured event APIs (optional complement to Exa)

Checked 2026-10-04 via Exa search of the official developer docs. These aren't sponsors. They only matter if Exa coverage
of big mainstream events (arena concerts, sports, Broadway-style theatre) is weak.

## Ticketmaster Discovery API v2 (best candidate)
- Docs: https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/
- Auth: self-serve key, `?apikey=…`, granted instantly on registration. Default quota (per their FAQ, not
  re-verified today): 5000 calls/day, 5 req/s.
- `GET https://app.ticketmaster.com/discovery/v2/events.json` filters: `keyword`, `city`, `countryCode`,
  `latlong`/`geoPoint` + `radius` + `unit`, `startDateTime`/`endDateTime` (UTC `YYYY-MM-DDTHH:mm:ssZ`),
  `localStartDateTime`, `classificationName` (segment/genre, e.g. "Music", "Jazz", "Film"), `venueId`,
  `sort` (`date,asc`, `relevance,desc`, …), `size`, `page`, `source`.
- Response `_embedded.events[]`: `name`, `url` (buy page), `dates.start.{localDate, localTime, dateTime}`, `dates.timezone`,
  `dates.status.code` (onsale/offsale/cancelled), `classifications[].{segment,genre,subGenre}.name`,
  `priceRanges[].{min,max,currency}` (often missing), `_embedded.venues[].{name, city.name, timezone}`, `images[]`.
- Covers Ticketmaster, Universe, FrontGate and others. Large venues mostly. **Booking** on ticketmaster.com is bot-walled (see plan), so
  treat TM results as "suggest + hand off the link", not auto-book.

## SeatGeek Platform API
- Docs: https://seatgeek.github.io/, base `https://api.seatgeek.com/2`, `client_id` query param (registration at seatgeek.com/build).
- `/events?venue.city=…&datetime_local.gte=…&datetime_local.lte=…&q=…&taxonomies.name=concert&lat=&lon=&range=25mi`
- Fields: `title`, `url`, `datetime_local`, `datetime_utc`, `time_tbd` (sentinel 3:30 AM!), `venue{name,city,timezone,location}`,
  `performers[]`, `taxonomies[]`, `stats.lowest_price` (resale market).
- US/Canada only.

## Not useful for discovery
- **Eventbrite**: public event search API was removed in 2020; the API only covers your own organisation's events. Exa finds
  eventbrite.com pages fine.
- **Luma**: the API covers calendars you manage. Exa finds lu.ma pages (good for tech meetups).
- **Bandsintown / Songkick**: artist-centric, partner keys; Exa already surfaces bandsintown.com event pages.

## Verdict
Exa covers small venues, cinemas, clubs and meetups well. In the SF test it returned single event pages
with price and time, plus full venue calendars. Add Ticketmaster only if a demo persona likes arena-scale
events. It's about one hour of work as a second `source` in the same pipeline.
