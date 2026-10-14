/* Makes moonlit's icon in every theme's colours: icons/themes/<theme>.svg and .png sizes,
   and a web app manifest for each theme (so an installed phone app can use the theme's icon).
   Run after changing a theme or the icon:  node tools/make-icons.js
   (needs Playwright's Chromium to turn the SVGs into PNGs) */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'icons', 'themes');

// bg: background (light → dark), glow, disc (3), label (2), stars (big, small), grooves
const THEMES = {
  'midnight-rose': { bg: ['#4a1538', '#22091b', '#170a14'], glow: '#ff7eb6', disc: ['#ff9cc8', '#ff6fae', '#c35a9c'], label: ['#ffb0d3', '#c49bff'], stars: ['#ffffff', '#ffd1e6'], groove: '#ffffff', color: '#170a14' },
  'strawberry-milk': { bg: ['#fff8fb', '#ffe6ef', '#ffd6e5'], glow: '#f0609e', disc: ['#ff9fc6', '#f0609e', '#c94a86'], label: ['#ffd3e3', '#ff9f8a'], stars: ['#f0609e', '#ff9f8a'], groove: '#ffffff', color: '#fff1f5' },
  'cherry-noir': { bg: ['#2e0b19', '#14070d', '#0a0709'], glow: '#ff2e7e', disc: ['#ff6aa3', '#ff2e7e', '#a3124d'], label: ['#ffb3cf', '#ff2e7e'], stars: ['#ffffff', '#ff9ac1'], groove: '#ffffff', color: '#0a0709' },
  'bubblegum': { bg: ['#fff4ff', '#f3e6ff', '#e6dcff'], glow: '#c86eff', disc: ['#ff8cc4', '#ff5fa8', '#8f7bff'], label: ['#ffc6e3', '#a99bff'], stars: ['#8f7bff', '#ff5fa8'], groove: '#ffffff', color: '#fde9ff' },
  'sakura-dusk': { bg: ['#6b3459', '#3a1d38', '#24142b'], glow: '#ffa3c4', disc: ['#ffc4d9', '#ffa3c4', '#d47fa8'], label: ['#ffe0b8', '#ffa3c4'], stars: ['#ffffff', '#ffd29a'], groove: '#ffffff', color: '#24142b' },
  'rose-gold': { bg: ['#fffaf7', '#f8ebe6', '#efd3cb'], glow: '#d97a8a', disc: ['#eba7b2', '#d97a8a', '#b5677a'], label: ['#f6dcc4', '#c9a27a'], stars: ['#d97a8a', '#c9a27a'], groove: '#ffffff', color: '#f8ebe6' },
  'pure-black': { bg: ['#202020', '#0a0a0a', '#000000'], glow: '#ffffff', disc: ['#f4f4f4', '#bdbdbd', '#6e6e6e'], label: ['#ffffff', '#8c8c8c'], stars: ['#ffffff', '#cfcfcf'], groove: '#000000', color: '#000000' },
};

const svg = t => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="bg" cx="30%" cy="20%" r="95%">
      <stop offset="0" stop-color="${t.bg[0]}"/>
      <stop offset=".6" stop-color="${t.bg[1]}"/>
      <stop offset="1" stop-color="${t.bg[2]}"/>
    </radialGradient>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="${t.glow}" stop-opacity=".55"/>
      <stop offset="1" stop-color="${t.glow}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="disc" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.disc[0]}"/>
      <stop offset=".55" stop-color="${t.disc[1]}"/>
      <stop offset="1" stop-color="${t.disc[2]}"/>
    </linearGradient>
    <linearGradient id="label" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.label[0]}"/>
      <stop offset="1" stop-color="${t.label[1]}"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".45"/>
      <stop offset=".45" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <circle cx="256" cy="262" r="230" fill="url(#glow)"/>
  <circle cx="256" cy="262" r="168" fill="url(#disc)"/>
  <g fill="none" stroke="${t.groove}" stroke-opacity="${t.groove === '#000000' ? '.14' : '.16'}" stroke-width="2">
    <circle cx="256" cy="262" r="150"/><circle cx="256" cy="262" r="134"/>
    <circle cx="256" cy="262" r="118"/><circle cx="256" cy="262" r="102"/><circle cx="256" cy="262" r="86"/>
  </g>
  <path d="M256 94a168 168 0 0 0-150 92l150 76z" fill="url(#sheen)"/>
  <circle cx="256" cy="262" r="60" fill="url(#label)" stroke="#fff" stroke-opacity=".5" stroke-width="5"/>
  <circle cx="256" cy="262" r="9" fill="#fff"/>
  <path d="M366 112c3 26 14 39 42 42-28 3-39 16-42 42-3-26-14-39-42-42 28-3 39-16 42-42z" fill="${t.stars[0]}"/>
  <path d="M156 352c1.6 13 7 19.5 21 21-14 1.5-19.4 8-21 21-1.6-13-7-19.5-21-21 14-1.5 19.4-8 21-21z" fill="${t.stars[1]}"/>
</svg>
`;

const manifest = (id, t) => JSON.stringify({
  name: 'moonlit',
  short_name: 'moonlit',
  description: 'a little private music player, just for you',
  id: './', // the same app whichever theme's manifest is in use
  start_url: '../../',
  scope: '../../',
  display: 'standalone',
  orientation: 'any',
  background_color: t.color,
  theme_color: t.color,
  categories: ['music', 'entertainment'],
  icons: [
    { src: `${id}-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: `${id}-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: `${id}-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}, null, 2) + '\n';

(async () => {
  const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const [id, t] of Object.entries(THEMES)) {
    const art = svg(t);
    fs.writeFileSync(path.join(OUT, `${id}.svg`), art);
    fs.writeFileSync(path.join(OUT, `${id}.webmanifest`), manifest(id, t));
    for (const size of [32, 180, 192, 256, 512]) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(`<style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style><img src="data:image/svg+xml;base64,${Buffer.from(art).toString('base64')}">`);
      await page.waitForFunction(() => document.images[0].complete);
      await page.screenshot({ path: path.join(OUT, `${id}-${size}.png`), omitBackground: true });
    }
    console.log('made', id);
  }
  await browser.close();
})().catch(err => { console.error(err); process.exit(1); });
