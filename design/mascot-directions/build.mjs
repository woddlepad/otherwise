import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const brands=JSON.parse(await fs.readFile(path.join(dir,'brands.json'),'utf8'));
const css=await fs.readFile(path.join(dir,'gallery.css'),'utf8');
const js=await fs.readFile(path.join(dir,'gallery.js'),'utf8');
function fragment(data,inline=false){return `<style>${css}</style>
<div id="mascot-lab">
<div class="mast"><span>Booking agent / brand explorations</span><span>Edition 01 · 10 directions</span></div>
<header class="intro"><div><span class="eyebrow">A little helper. A fuller life.</span><h1>Meet your<br>new free-time friend.</h1></div><p>Ten personalities for an agent that gives you time back. Explore each world, check the tiny tab icons, and shortlist the ones that feel like you.</p></header>
<div class="toolbar" aria-label="Filter brand directions"><button class="filter" data-filter="all" aria-pressed="true">All directions</button><button class="filter" data-filter="saved" aria-pressed="false">Shortlist (0)</button><span class="status" aria-live="polite"></span></div>
<div class="selectedbar" aria-live="polite" hidden></div><main class="grid" aria-label="Ten mascot and brand concepts"></main>
<footer class="footer">Original artwork generated with imagegen. Concept names are working names. Landing pages are visual studies. ${inline?'':'Download transparent mascot art and favicon files from each card. '}Shortlists last for this viewing session.</footer>
<script type="application/json" class="brand-data">${JSON.stringify(data).replaceAll('<','\\u003c')}</script>
<script>${js}</script>
</div>`;}
const full=fragment(brands);
await fs.writeFile(path.join(dir,'index.html'),`<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>More life, less planning — 10 mascot directions</title><link rel="icon" data-mascot-icon="true" type="image/png" href="assets/01-mellow/favicon-32.png"><style>body{margin:0;background:#F6F5F1}</style></head><body>${full}</body></html>`);
const embedded=[];
for(const b of brands){const assets={};for(const [k,name,mime] of [['hero','preview.webp','image/webp'],['16','favicon-16.png','image/png'],['32','favicon-32.png','image/png'],['64','favicon-64.png','image/png']])assets[k]=`data:${mime};base64,${(await fs.readFile(path.join(dir,'assets',b.id,name))).toString('base64')}`;embedded.push({...b,assets});}
const inline=fragment(embedded,true);if(Buffer.byteLength(inline)>=1048576)throw Error('Inline fragment exceeds 1 MiB');
await fs.writeFile(path.join(dir,'../../.atmos/visualizations/booking-mascot-directions.html'),inline);
console.log(JSON.stringify({directions:brands.length,inlineBytes:Buffer.byteLength(inline)}));
