# Mellow refinements

Six variants generated with built-in imagegen using the original Mellow mascot as the reference. Exact prompts: `prompts.json`. The original mascot is unchanged.

Open `index.html`, or serve the parent `mascot-directions` folder and visit `/mellow/`. Compare each variant against the original, adjust display size from 16 to 96px, and test oat/white/dark backgrounds. Each card also has actual-size favicon exports and PNG/ICO downloads.

Assets are in `assets/<variant>/`: original transparent `mascot.png`, `preview.webp`, `favicon.ico` containing 16/32/48px images, and PNG sizes 16/24/32/48/64/180/192/512. Only resizing and format conversion were performed after generation. These are raster concepts; the one-color mark is a visual concept, not a production vector separation.

Edit `variants.json`, `style.css`, or `app.js`, then run `node design/mascot-directions/mellow/build.mjs` to rebuild.

Local persistent preview services: `mellow-gallery-preview.service` and `mellow-gallery-tunnel.service` (systemd user services). The former serves only the design gallery folder on loopback port 4178. The latter publishes it through Cloudflare. Stop with `systemctl --user stop mellow-gallery-tunnel mellow-gallery-preview`.
