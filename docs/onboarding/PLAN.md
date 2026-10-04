# Onboarding v2: homepage look + starter deck to swipe

Worktree `wt/onboarding` (port 4118, Neon branch `wt/onboarding`). Started 2026-10-04.

## Goals

1. The setup page (`/onboard`) looks like the homepage (`design/homepage/otherwise.html`, "Otherwise × Mellow"), not a
   plain form. Same type, palette, capybara and the liquid-glass card stack.
2. New users swipe through real upcoming events in their city during onboarding. Every swipe is stored and goes into
   the taste analysis, so the first profile isn't built only from mail and calendar.
3. Those events (a "starter deck") exist before the user opens the page: seeded when the user is created, cached per city.

## Flow

One page, steps top to bottom (state survives the Composio redirect because everything is saved as you go):

1. **Hi + connect**: Gmail + Google Calendar / Outlook (unchanged logic, `/connect/:provider/start`).
2. **Where**: city (prefilled) + optional "anything I should know". Saved with `POST /onboard/profile` on change;
   a changed city rebuilds the deck.
3. **Swipe a few**: the starter deck (about 12 cards). Right = "More like this", left = "Not for me". Buttons and
   arrow keys too. The capybara reacts. Skippable; "keep going" after about 5 swipes.
4. **Budget**: per month + "surprise me up to", link to the wallet.
5. **Done, analyse me** → `POST /onboard/complete` (unchanged contract) → the done page in the same style.

## Backend (the starter deck)

- `src/lib/events/starter.ts`
  - `STARTER_QUERIES(city, month)`: about 8 broad queries across categories (concerts, stand-up, cinema, theatre,
    exhibitions, club nights, talks, markets/food). Run through `findCandidates(ctx, { queries })`, so there is no
    LLM planning, then `storeEvents`. The window is the next 14 days.
  - `ensureStarterDeck(city, timezone)`: cached per city in `starter_decks (city_key pk, status building|ready|failed,
    built_at, event_ids uuid[])`, rebuilt after 24 h. Only one build per city at a time (status row as a lock;
    a stale `building` older than 10 min counts as failed).
  - `seedStarterSuggestions(userId)`: picks about 12 upcoming, attendable, diverse events (`diversify`, max 2 per
    category) from the user's city deck and inserts `suggestions` rows with `source = 'starter'`,
    `status = 'suggested'`. Idempotent; reseeds when the city changes (old unswiped starter rows → `expired`).
  - City before the user has typed one: guessed from the phone prefix (+49 Berlin, +1 San Francisco, +44 London,
    +33 Paris, …), else `DEFAULT_CITY`. The timezone is guessed the same way.
- Images: `details.image` from Exa's result `image` field or the page's og:image when available; else null and the
  UI uses a category photo.
- Seeding runs in the background (`waitUntil`) when `onboardingReply` first sends the link and when the city changes.
- `scripts/starter-deck.ts <city>` builds a city's deck ahead of time (for the demo: Berlin, San Francisco).
- Schema (`db/schema.sql`, idempotent): `suggestions.source text DEFAULT 'discovery'`,
  `suggestions.reaction text CHECK (reaction IN ('like','dislike'))`, `suggestions.reacted_at timestamptz`,
  the `starter_decks` table.
- The onboard workflow (`gather-signals`) adds "Swiped right on: …" / "Swiped left on: …" (title, category, tags,
  venue) to the signals, and the analyst prompt treats those as explicit, strong evidence.
- Swipes write a `feedback` row (kind `liked`/`disliked`, `suggestion_id`, note `onboarding swipe`) but do **not**
  move the auto-book threshold (they're taste, not booking decisions).

### API (contract between backend and UI)

All endpoints use the onboarding token, like `/onboard`.

```
GET  /onboard/deck?t=<token>
  200 { city, status: 'ready' | 'building' | 'failed' | 'empty',
        cards: [{ suggestionId, title, category, tags: string[], when: "Sat 11 Oct · 20:00", venue: string|null,
                  price: string|null, url, image: string|null }] }
  // only cards not yet swiped, in deck order; 'building' → the client polls every 3 s

POST /onboard/swipe   JSON { t, suggestionId, verdict: 'like' | 'dislike' }
  200 { ok: true, liked: n, disliked: n }

POST /onboard/profile JSON { t, city, interests, tz }
  200 { ok: true, city, deckStatus }   // saves; a changed city reseeds the deck
```

### Contract changes

None to the shapes above. Clarifications from the implementation (`src/mastra/routes/deck.ts`, `src/lib/events/starter.ts`):

- `category` is the `classify.ts` key (`music`, `film`, `comedy`, `theatre`, `dance`, `talk`, `tech_meetup`, `art`,
  `food_drink`, `nightlife`, `sports`, `workshop`, `festival`, `family`, `other`), not a display label;
  `CATEGORY_LABEL` in `classify.ts` has the labels. Good key for picking the fallback photo.
- `when` is just the date ("Sat 17 Oct") for events whose page gave no time. Times are in the city's timezone.
- `tags` has at most 5 entries; `price` is "Free", a short price text as on the page ("€10", "From $12") or "from €9".
- `status`: `ready` = the user has starter cards for this city (`cards` can be empty once all are swiped → "done");
  `building` = the city's deck is being built (first build for a city takes ~30–60 s); `failed` = the build failed
  (retried at the earliest 10 min later, on the next request); `empty` = the city's deck has nothing attendable.
- `GET /onboard/deck` seeds on demand too (cheap when the city's deck exists), so polling is all the client needs.
- `POST /onboard/profile`: every field optional; an empty `city` keeps the current one, `interests` is only written when
  sent (empty string clears it), an invalid `tz` is ignored. `city` in the response is the effective city (typed, else
  guessed from the phone prefix). Same `deckStatus` values as `status` above.
- Errors: unknown token → 404 `{ error }`; bad swipe body → 400; unknown/foreign card → 404. Re-swiping a card
  overwrites the earlier verdict (one feedback row per card).
- `userByToken` in `onboarding.ts` is unchanged and not exported; `deck.ts` has its own id-only lookup.

## UI

- Shared shell `src/ui/` used by `/onboard`, the done page and `/wallet`: Host Grotesk, tokens from
  `design/homepage/NOTES.md` (paper #F3F5EF, ink #1C302C, spring #22675A, spring-tint #DDEEE8, coral #C44F2F),
  the capybara (capy-head as the avatar, capy-soft on the done page).
- The card stack is ported from `otherwise.html` (drag/flick/buttons/arrow keys, stamps, capy speech bubble, ambient
  glow, reduced motion), fed by `/onboard/deck`.
- Assets go through `GET /assets/:name`, embedded as base64 in a generated TS module, so they work under `mastra dev`
  and in the esbuild bundle for Neon. Photos are resized and compressed (target total under 400 KB).
- Mobile first (most people arrive from WhatsApp). Works without the deck (empty/failed → a short "skip" note).
