# Booking agent mascot directions

Open `index.html` directly in a browser. It contains ten coordinated brand studies, transparent mascot art, light/dark browser tabs, real 16/32/64px icon previews, a temporary shortlist, and favicon switching. No server or network connection is required. The CTA labels are visual mockups.

## Deliverables

Each `assets/<number-name>/` directory contains:
- `mascot.png`: original 1254px transparent image generated using built-in imagegen.
- `preview.webp`: compact 440px transparent gallery export.
- `favicon.ico`: 16/32/48px images in an ICO container.
- `favicon-{16,32,48,64,180,192,512}.png`: transparent raster exports.

Favicon candidates are scaled versions of each complete mascot, so you can compare their real small-size legibility. Names are concept labels.

`prompts.json` contains the exact ten generation prompts. `brands.json` contains copy, palettes, typography, and design rationale. `gallery.css` and `gallery.js` are the editable gallery sources. Run `node design/mascot-directions/build.mjs` from the repository root to rebuild `index.html` and the embedded chat visualization under `.atmos/visualizations/`.

Generation: built-in imagegen, one original generation per direction, transparent background. Original image files preserved. Sharp was used only for resizing and format export; no artwork was redrawn or substituted.
