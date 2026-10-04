# Homepage concepts

Open `index.html` in a browser. Each concept is one self-contained HTML file (Google Fonts only).
Screenshots in `shots/` (desktop hero, desktop full page, mobile full page and mobile top).

| | Unmissed (A) | Otherwise (B) | Plus One (C) |
|---|---|---|---|
| Idea | Proof of a fuller life: a pile of ticket stubs | Your calendar, empty evenings filling in | The hour before you go out |
| Memorable element | Stubs drop onto the pile on load; marker strikes through "things you missed" | Week grid fills with bookings; sliders show book/ask/skip live | Live local time; skyline windows switch on one by one |
| Palette | Riso blue #24418F, fluorescent pink #FF48B0, yellow #FFE800 on white | Ink #161937, cobalt #2B3FF0, marigold #FFC53D on #F6F7F9 | Night #12143A, dusk gradient to peach, lamp gold #FFD27D |
| Type | Archivo, width axis 62 (display) to 125 (ticket small print) | Host Grotesk, tabular figures | Gloock (display) + Albert Sans |

Copy is shared across concepts and grounded in the product: read-only mail and calendar, a monthly budget plus a
"book without asking up to" limit, a fixed rule (src/lib/policy.ts) deciding book/ask/skip, price checked at
checkout, the model never sees the card number. Names are interchangeable between styles.

Avoided on purpose: cream + terracotta serif, black + acid green, identical rounded SaaS cards, all-caps eyebrows,
middle-dot meta strings, arrows on buttons, fade-up on every section (each page has one orchestrated moment).

## Current direction: `otherwise.html` (Otherwise × Mellow)

Otherwise's layout (self-filling week, book/ask/skip sliders) with the Mellow capybara: Soft 3D sits on the calendar and
in the closing card, Pocket 3D is the logo, favicon and chat avatar. New "last week" section with real Berlin listings
(28 Sept to 4 Oct 2026); the calendar and decision list use real listings for 12 to 18 Oct. Prices on those are examples.
Photos are Unsplash (free licence), chosen without identifiable performers so no artist is shown as someone else.

Palette: a cool spring around a warm animal, so the capybara and its coral clock are what glows.

| Token | Hex | Use |
|---|---|---|
| paper | #F3F5EF | page (sage-tinted, deliberately not cream) |
| ink | #1C302C | text, closing card |
| spring | #22675A | booked events, sliders |
| spring-tint | #DDEEE8 | waiting for your yes |
| coral | #C44F2F | buttons and "still on" only (the clock on its belly; white text passes AA) |
| fur / cream | #C07848 / #F6EBDD | sampled from the mascot, used inside the mascot details |

### Swipeable picks (otherwise.html, "Last week" section)
A card stack replaces the photo grid. Drag or swipe the top card (touch, mouse or pen), use the two round buttons, or
focus the stack and press the left or right arrow key. Past 30% of the card width, or on a quick flick, the card flies off; otherwise it springs
back. The cards behind move up with a 45ms stagger, the thrown card rejoins at the back, and the stack loops. Dragging
shows "More like this" / "Not for me" stamps, and the capybara's bubble answers each swipe (per-card `data-yes`/`data-no`).
Three cards are visible, each lower one offset, scaled and tilted. Reduced motion swaps the throw for a fade.
