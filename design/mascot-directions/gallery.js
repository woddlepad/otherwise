(() => {
const root = document.getElementById('mascot-lab');
const data = JSON.parse(root.querySelector('.brand-data').textContent);
const saved = new Set();
let onlySaved = false;
const grid = root.querySelector('.grid');
const status = root.querySelector('.status');
const bar = root.querySelector('.selectedbar');
const asset = (b,kind) => b.assets ? b.assets[kind] : `assets/${b.id}/${kind === 'hero' ? 'preview.webp' : kind === 'original' ? 'mascot.png' : kind === 'ico' ? 'favicon.ico' : `favicon-${kind}.png`}`;
const esc = str => String(str).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
grid.innerHTML = data.map((b,i) => `<article class="card" id="${b.id}" style="--bg:${b.bg};--ink:${b.ink};--primary:${b.primary};--accent:${b.accent};--button:${b.button};--font:${b.font}">
<div class="cardtop"><div><span class="number">${String(i+1).padStart(2,'0')}</span><strong>${b.name}</strong> <span class="tone">/ ${b.animal}</span></div><button class="save" data-save="${b.id}" aria-label="Shortlist ${b.name}" aria-pressed="false">♡ Shortlist</button></div>
<section class="brand" aria-label="${b.name} landing page design"><div class="brandnav"><span class="wordmark"><img src="${asset(b,'32')}" alt="">${b.name.toLowerCase()}</span><span class="navlabel">Your personal booking agent</span></div><div class="hero"><div><h2>${b.headline}</h2><p>${b.copy}</p><span class="samplecta">Get my time back ↗</span></div><img src="${asset(b,'hero')}" alt="${b.name}, ${b.animal.toLowerCase()} mascot" width="400" height="400"></div><div class="brandfoot"><span>${b.tag}</span><span>Less planning. More living.</span></div></section>
<div class="specs"><div class="specrow"><strong class="eyebrow">${b.pick}</strong><span class="tone">${b.tone}</span></div><div class="swatches">${[b.primary,b.bg,b.accent,b.ink].map(c=>`<div class="swatch"><span class="chip" style="background:${c}"></span><span class="hex">${c}</span></div>`).join('')}</div><p class="type">${b.style}<br>Type: ${b.type}</p><div class="favrow"><div class="tab"><img src="${asset(b,'16')}" alt="${b.name} 16px favicon on light"><span>${b.name} — time for you</span><span aria-hidden="true">×</span></div><div class="tab dark"><img src="${asset(b,'16')}" alt="${b.name} 16px favicon on dark"><span>${b.name} — time for you</span><span aria-hidden="true">×</span></div></div><div class="icons">${[16,32,64].map(s=>`<span class="icon"><img data-size="${s}" src="${asset(b,String(s))}" width="${s}" height="${s}" alt="${b.name} favicon at ${s} pixels"><span>${s}px</span></span>`).join('')}<button class="try" data-try="${b.id}">Try favicon ↗</button></div><details><summary>Why this direction works</summary><p>${b.why}</p><p><strong>At tab size:</strong> ${b.favicon}</p></details><div class="downloads">${b.assets?'':`<a href="${asset(b,'original')}" download="${b.id}-mascot.png">Mascot PNG ↓</a><a href="${asset(b,'ico')}" download="${b.id}-favicon.ico">Favicon ICO ↓</a><a href="${asset(b,'32')}" download="${b.id}-favicon-32.png">32px PNG ↓</a>`}</div></div></article>`).join('');
function update() {
 for (const card of grid.querySelectorAll('.card')) {
  const chosen=saved.has(card.id);card.hidden=onlySaved&&!chosen;
  const btn=card.querySelector('.save');btn.setAttribute('aria-pressed',String(chosen));btn.textContent=chosen?'♥ Shortlisted':'♡ Shortlist';
 }
 root.querySelector('[data-filter="saved"]').textContent=`Shortlist (${saved.size})`;
 root.querySelectorAll('[data-filter]').forEach(b=>b.setAttribute('aria-pressed',String((b.dataset.filter==='saved')===onlySaved)));
 status.textContent=onlySaved?`${saved.size} shortlisted direction${saved.size===1?'':'s'}`:'10 directions · 10 favicon sets';
 let empty=grid.querySelector('.empty');if(empty)empty.remove();
 if(onlySaved&&!saved.size){empty=document.createElement('p');empty.className='empty';empty.textContent='Your shortlist is empty. Browse all directions and save your favorites.';grid.append(empty);}
 bar.hidden=saved.size===0;bar.textContent='Your shortlist: '+data.filter(b=>saved.has(b.id)).map(b=>b.name).join(' · ');
}
root.addEventListener('click',event=>{
 const btn=event.target.closest('button');if(!btn)return;
 if(btn.dataset.save){const id=btn.dataset.save;saved.has(id)?saved.delete(id):saved.add(id);update();}
 if(btn.dataset.filter){onlySaved=btn.dataset.filter==='saved';update();}
 if(btn.dataset.try){const b=data.find(b=>b.id===btn.dataset.try);let link=document.querySelector('link[data-mascot-icon]');if(!link){link=document.createElement('link');link.rel='icon';link.type='image/png';link.dataset.mascotIcon='true';document.head.append(link);}link.href=asset(b,'32');status.textContent=`${b.name} favicon selected · ${b.animal.toLowerCase()}`;root.querySelectorAll('.try').forEach(x=>x.textContent=x===btn?'Selected ✓':'Try favicon ↗');}
});
update();
})();
