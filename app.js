'use strict';

/* moonlit — a private little music player.
   Everything lives in this browser: songs are kept in IndexedDB,
   settings in localStorage. Nothing is ever uploaded anywhere. */

const $ = (s, r = document) => r.querySelector(s);
// set when running as the desktop app (Electron); see desktop/preload.js
const desktop = window.moonlitDesktop || null;
document.body.classList.toggle('is-desktop', !!desktop);

const THEMES = [
  { id: 'midnight-rose', name: 'midnight rose', swatch: 'linear-gradient(135deg,#2a0f22 30%,#ff7eb6)', color: '#170a14' },
  { id: 'strawberry-milk', name: 'strawberry milk', swatch: 'linear-gradient(135deg,#ffdbe7 30%,#f0609e)', color: '#fff1f5' },
  { id: 'cherry-noir', name: 'cherry noir', swatch: 'linear-gradient(135deg,#0a0709 35%,#ff2e7e)', color: '#0a0709' },
  { id: 'bubblegum', name: 'bubblegum', swatch: 'linear-gradient(135deg,#ff5fa8,#8f7bff)', color: '#fde9ff' },
  { id: 'sakura-dusk', name: 'sakura dusk', swatch: 'linear-gradient(135deg,#4a2440,#ffa3c4 60%,#ffd29a)', color: '#24142b' },
  { id: 'rose-gold', name: 'rosé gold', swatch: 'linear-gradient(135deg,#f8ebe6,#d97a8a 55%,#c9a27a)', color: '#f8ebe6' },
  { id: 'pure-black', name: 'pure black', swatch: 'linear-gradient(135deg,#000 55%,#fff)', color: '#000000' },
];

let overlayPalette = null; // the current theme's colours for the OBS overlay (worked out when needed)

/* ───────────── tiny storage helpers ───────────── */
const prefs = {
  get(k, d) { try { const v = localStorage.getItem('moonlit:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('moonlit:' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const DB = (() => {
  let dbp = null;
  function open() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open('moonlit', 2);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }
  async function run(mode, fn, store = 'tracks') {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  return {
    all: () => run('readonly', s => s.getAll()),
    put: rec => run('readwrite', s => { s.put(rec); }),
    putMany: recs => run('readwrite', s => { for (const r of recs) s.put(r); }),
    del: id => run('readwrite', s => { s.delete(id); }),
    clear: () => run('readwrite', s => { s.clear(); }),
    // small key/value store, used for the OBS file handle
    getKV: key => run('readonly', s => s.get(key), 'kv'),
    setKV: (key, val) => run('readwrite', s => { val === undefined ? s.delete(key) : s.put(val, key); }, 'kv'),
  };
})();

/* ───────────── metadata ───────────── */
const syncsafe = (b, i) => (b[i] << 21) | (b[i + 1] << 14) | (b[i + 2] << 7) | b[i + 3];
const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

function decodeText(bytes, enc) {
  let label = 'latin1';
  if (enc === 1) label = bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-16le';
  else if (enc === 2) label = 'utf-16be';
  else if (enc === 3) label = 'utf-8';
  return new TextDecoder(label).decode(bytes).replace(/^﻿/, '').split('\0').filter(Boolean).join(', ').trim();
}

function readPicture(data, isV22) {
  const enc = data[0];
  let i = 1, mime;
  if (isV22) {
    mime = String.fromCharCode(data[1], data[2], data[3]).toLowerCase();
    i = 4;
  } else {
    const start = i;
    while (i < data.length && data[i] !== 0) i++;
    mime = String.fromCharCode(...data.subarray(start, i)).toLowerCase();
    i++;
  }
  i++; // picture type
  if (enc === 1 || enc === 2) {
    while (i + 1 < data.length && !(data[i] === 0 && data[i + 1] === 0)) i += 2;
    i += 2;
  } else {
    while (i < data.length && data[i] !== 0) i++;
    i++;
  }
  if (!mime.includes('/')) mime = 'image/' + mime;
  if (mime === 'image/jpg') mime = 'image/jpeg';
  return i < data.length ? new Blob([data.slice(i)], { type: mime }) : null;
}

// Small ID3v2 reader for title / artist / album / cover art.
// Small MP4/M4A reader: title / artist / album / cover from moov › udta › meta › ilst.
async function readMp4Tags(file) {
  const out = {};
  try {
    const type = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
    // find the top-level 'moov' box (it can be at the start or the end of the file)
    let off = 0, moov = null;
    while (off + 8 <= file.size) {
      const h = new Uint8Array(await file.slice(off, off + 16).arrayBuffer());
      let len = u32(h, 0), hdr = 8;
      if (len === 1) { len = u32(h, 8) * 2 ** 32 + u32(h, 12); hdr = 16; } else if (len === 0) len = file.size - off;
      if (len < hdr) break;
      if (type(h, 4) === 'moov') {
        if (len > 64 * 1024 * 1024) return out;
        moov = new Uint8Array(await file.slice(off + hdr, off + len).arrayBuffer());
        break;
      }
      off += len;
    }
    if (!moov) return out;
    const boxes = function* (b, start, end) {
      for (let p = start; p + 8 <= end;) {
        const len = u32(b, p);
        if (len < 8 || p + len > end) return;
        yield { type: type(b, p + 4), s: p + 8, e: p + len };
        p += len;
      }
    };
    const child = (b, start, end, name) => { for (const x of boxes(b, start, end)) if (x.type === name) return x; return null; };
    const udta = child(moov, 0, moov.length, 'udta');
    const meta = (udta && child(moov, udta.s, udta.e, 'meta')) || child(moov, 0, moov.length, 'meta');
    if (!meta) return out;
    // usually a "full box": 4 bytes of version/flags come before its first child (hdlr)
    const metaStart = type(moov, meta.s + 8) === 'hdlr' ? meta.s + 4 : meta.s;
    const ilst = child(moov, metaStart, meta.e, 'ilst');
    if (!ilst) return out;
    for (const item of boxes(moov, ilst.s, ilst.e)) {
      const data = child(moov, item.s, item.e, 'data');
      if (!data) continue;
      const kind = u32(moov, data.s) & 0xffffff;
      const value = moov.subarray(data.s + 8, data.e);
      const text = () => new TextDecoder('utf-8').decode(value).replace(/\0+$/, '').trim();
      if (item.type === '©nam') out.title = text();
      else if (item.type === '©ART') out.artist = text();
      else if (item.type === 'aART' && !out.artist) out.artist = text();
      else if (item.type === '©alb') out.album = text();
      else if (item.type === 'covr' && !out.cover && value.length) {
        out.cover = new Blob([value.slice()], { type: kind === 14 ? 'image/png' : 'image/jpeg' });
      }
    }
  } catch { /* unreadable tags are fine, we fall back to the filename */ }
  return out;
}

async function readTags(file) {
  const out = {};
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (String.fromCharCode(...head.subarray(4, 8)) === 'ftyp') return readMp4Tags(file); // .m4a / .mp4
    if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return out; // "ID3"
    const ver = head[3], flags = head[5];
    const size = syncsafe(head, 6);
    const buf = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
    let p = 0;
    if (flags & 0x40 && ver >= 3) p = ver === 4 ? syncsafe(buf, 0) : u32(buf, 0) + 4;
    const idLen = ver === 2 ? 3 : 4, hdrLen = ver === 2 ? 6 : 10;
    while (p + hdrLen < buf.length) {
      const id = String.fromCharCode(...buf.subarray(p, p + idLen));
      if (!/^[A-Z0-9]+$/.test(id)) break;
      const fsize = ver === 2 ? (buf[p + 3] << 16) | (buf[p + 4] << 8) | buf[p + 5]
        : ver === 4 ? syncsafe(buf, p + 4) : u32(buf, p + 4);
      if (fsize <= 0) break;
      const data = buf.subarray(p + hdrLen, p + hdrLen + fsize);
      p += hdrLen + fsize;
      switch (id) {
        case 'TIT2': case 'TT2': out.title = decodeText(data.subarray(1), data[0]); break;
        case 'TPE1': case 'TP1': out.artist = decodeText(data.subarray(1), data[0]); break;
        case 'TALB': case 'TAL': out.album = decodeText(data.subarray(1), data[0]); break;
        case 'APIC': case 'PIC': if (!out.cover) out.cover = readPicture(data, ver === 2); break;
      }
    }
  } catch { /* unreadable tags are fine, we fall back to the filename */ }
  return out;
}

function fromFilename(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').replace(/^\d{1,3}[\s.\-]+/, '').trim();
  const parts = base.split(' - ');
  return parts.length > 1 ? { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() } : { title: base };
}

function probeDuration(blob) {
  return new Promise(resolve => {
    const a = new Audio();
    const url = URL.createObjectURL(blob);
    let finished = false;
    const done = d => {
      if (finished) return;
      finished = true;
      // detach handlers before unloading, otherwise unloading fires 'error' and calls us again
      a.onloadedmetadata = a.onerror = null;
      a.removeAttribute('src');
      a.load();
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(d) ? d : 0);
    };
    const timer = setTimeout(() => done(0), 8000);
    a.preload = 'metadata';
    a.onloadedmetadata = () => { clearTimeout(timer); done(a.duration); };
    a.onerror = () => { clearTimeout(timer); done(0); };
    a.src = url;
  });
}

async function coverColors(blob) {
  try {
    const bmp = await createImageBitmap(blob, { resizeWidth: 24, resizeHeight: 24 });
    const c = document.createElement('canvas');
    c.width = c.height = 24;
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0, 24, 24);
    const px = g.getImageData(0, 0, 24, 24).data;
    // Weight colourful pixels more so we pick up the "vibe", not the grey.
    const buckets = [[0, 0, 0, 0], [0, 0, 0, 0]];
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], gr = px[i + 1], b = px[i + 2];
      const max = Math.max(r, gr, b), min = Math.min(r, gr, b);
      const w = 0.05 + ((max - min) / 255) ** 2;
      const k = (i / 4) % 24 < 12 ? 0 : 1; // left half / right half
      buckets[k][0] += r * w; buckets[k][1] += gr * w; buckets[k][2] += b * w; buckets[k][3] += w;
    }
    return buckets.map(([r, gr, b, w]) => [r / w, gr / w, b / w].map(v => Math.round(Math.min(255, v * 1.1))).join(' '));
  } catch { return null; }
}

/* ───────────── state ───────────── */
const audio = new Audio();
audio.preload = 'auto';

const state = {
  tracks: [],
  currentId: null,
  queue: [],
  history: [],
  shuffle: prefs.get('shuffle', false),
  repeat: prefs.get('repeat', 'off'), // off | all | one
  view: 'all',
  query: '',
  persistent: true,
};
const coverUrls = new Map();
let audioUrl = null;

const el = {
  title: $('#title'), artist: $('#artist'), cover: $('#cover'), labelIcon: $('#labelIcon'),
  seek: $('#seek'), cur: $('#curTime'), dur: $('#durTime'),
  play: $('#playBtn'), playIcon: $('#playIcon'), prev: $('#prevBtn'), next: $('#nextBtn'),
  shuffle: $('#shuffleBtn'), repeat: $('#repeatBtn'), repeatIcon: $('#repeatIcon'),
  fav: $('#favBtn'), vol: $('#volume'), mute: $('#muteBtn'), volIcon: $('#volIcon'),
  list: $('#tracks'), empty: $('#empty'), count: $('#libCount'), search: $('#search'),
  library: $('#library'), scrim: $('#scrim'), file: $('#fileInput'), drop: $('#drop'), toastEl: $('#toast'),
  greeting: $('#greeting'), settingsBtn: $('#settingsBtn'), settings: $('#settings'), themeGrid: $('#themeGrid'),
  nameInput: $('#nameInput'), wmInput: $('#wmInput'), watermark: $('#watermark'), nowState: $('#nowState'),
  obsLink: $('#obsLink'), obsLinkText: $('#obsLinkText'), obsStatus: $('#obsStatus'), obsFormat: $('#obsFormat'),
  obsPause: $('#obsPause'), obsPad: $('#obsPad'), obsUnlink: $('#obsUnlink'), obsLive: $('#obsLive'),
};

// id → track lookup, so big libraries stay quick
const trackMap = new Map();
const reindex = () => { trackMap.clear(); for (const t of state.tracks) trackMap.set(t.id, t); };
const byId = id => trackMap.get(id);
const fmt = s => { if (!Number.isFinite(s) || s < 0) s = 0; const m = Math.floor(s / 60); return m + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const coverUrl = t => {
  if (!t.cover) return null;
  if (!coverUrls.has(t.id)) coverUrls.set(t.id, URL.createObjectURL(t.cover));
  return coverUrls.get(t.id);
};

let toastTimer;
function toast(msg, ms = 2600) {
  el.toastEl.textContent = msg;
  el.toastEl.classList.add('show');
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => el.toastEl.classList.remove('show'), ms);
}

/* ───────────── theme, greeting, watermark ───────────── */
function applyTheme(id) {
  const t = THEMES.find(x => x.id === id) || THEMES[0];
  document.body.dataset.theme = t.id;
  $('meta[name="theme-color"]').content = t.color;
  prefs.set('theme', t.id);
  el.themeGrid.querySelectorAll('.theme-opt').forEach(b => b.setAttribute('aria-checked', String(b.dataset.theme === t.id)));
  viz.refreshColor();
  overlayPalette = null;
  setTimeout(pushOverlay); // the OBS overlay can follow the theme
  syncIcon();
}

// moonlit's icon in the theme's colours: the browser tab, the installed phone app's icon
// (through the web app manifest) and, in the desktop app, the window, taskbar and tray icon
function syncIcon() {
  const id = prefs.get('theme', 'midnight-rose');
  const themed = prefs.get('themeIcon', true) && id !== 'midnight-rose' && THEMES.some(t => t.id === id);
  const d = `icons/themes/${id}`;
  const set = (sel, href) => { const l = $(sel); if (l && l.getAttribute('href') !== href) l.setAttribute('href', href); };
  set('#iconSvg', themed ? `${d}.svg` : 'icons/icon.svg');
  set('#iconPng', themed ? `${d}-32.png` : 'icons/favicon-32.png');
  set('#iconTouch', themed ? `${d}-180.png` : 'icons/apple-touch-icon.png');
  set('#manifestLink', themed ? `${d}.webmanifest` : 'manifest.webmanifest?v=50');
  if (desktop && desktop.setIcon) desktop.setIcon(themed ? id : null).catch(() => {});
}
function setupThemeIcon() {
  const box = $('#themeIcon');
  box.checked = prefs.get('themeIcon', true);
  box.onchange = () => { prefs.set('themeIcon', box.checked); syncIcon(); };
  const phone = !desktop && (matchMedia('(display-mode: standalone)').matches || matchMedia('(pointer: coarse)').matches);
  $('#themeIconHint').textContent = desktop
    ? 'the window, the taskbar and the tray icon change with the theme. a pinned taskbar shortcut may keep the usual icon until moonlit is opened.'
    : phone
      ? "the home screen icon follows when your phone checks the app for updates (Chrome on Android asks you to accept the new icon, it can take a day). removing the app from the home screen and installing it again changes it right away."
      : 'the browser tab and the installed app change with the theme.';
}

function buildThemeGrid() {
  el.themeGrid.innerHTML = '';
  for (const t of THEMES) {
    const b = document.createElement('button');
    b.className = 'theme-opt';
    b.dataset.theme = t.id;
    b.setAttribute('role', 'radio');
    b.innerHTML = `<span class="swatch" style="background:${t.swatch}"></span>${t.name}`;
    b.onclick = () => applyTheme(t.id);
    el.themeGrid.append(b);
  }
}

function setSettings(open) {
  if (open) setDownloads(false);
  el.settings.hidden = !open;
  el.settingsBtn.setAttribute('aria-expanded', String(open));
}
el.settingsBtn.onclick = e => { e.stopPropagation(); setSettings(el.settings.hidden); if (!el.settings.hidden) { showStorage(); showLibraryInfo(); } };

const fmtBytes = b => b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(b / 1e6)) + ' MB';
async function showStorage() {
  const box = $('#storageInfo');
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    box.textContent = `your songs are using ${fmtBytes(usage)} · room for about ${fmtBytes(Math.max(0, quota - usage))} more`;
    box.hidden = false;
  } catch { box.hidden = true; }
}
$('#settingsClose').onclick = () => setSettings(false);
document.addEventListener('click', e => {
  if (!el.settings.hidden && !e.target.closest('#settings, #settingsBtn')) setSettings(false);
  if (!$('#downloads').hidden && !e.target.closest('#downloads, #dlBtn, .toast')) setDownloads(false);
});

function updateGreeting() {
  const h = new Date().getHours();
  const part = h < 5 ? 'still up' : h < 12 ? 'good morning' : h < 17 ? 'good afternoon' : h < 22 ? 'good evening' : 'sweet dreams';
  const name = prefs.get('name', '');
  el.greeting.textContent = name ? `${part}, ${name} ♡` : `${part} ♡`;
}
el.greeting.onclick = () => { setSettings(true); el.nameInput.focus(); };
el.nameInput.addEventListener('input', () => { prefs.set('name', el.nameInput.value.trim()); updateGreeting(); });

function updateWatermark() {
  const text = prefs.get('watermark', '');
  el.watermark.textContent = text;
  el.watermark.hidden = !text;
}
el.wmInput.addEventListener('input', () => { prefs.set('watermark', el.wmInput.value.trim()); updateWatermark(); });

/* floating hearts + sparkles in the background */
// effects level: full (everything) · lite (no heavy effects, record still spins) · super (no motion at all)
const PERF = {
  full: { hint: 'every effect on: the visualizer, floating hearts and glow.', toast: 'all the pretty effects are back ✦' },
  lite: { hint: 'no blur, glow or visualizer. the record still spins. easier on older PCs.', toast: 'lite mode on: easier on your PC' },
  super: { hint: 'no animations, and the record is put away. lightest on your PC.', toast: 'super lite on: as light as it gets' },
};
let deckAnim = null, deckLeaving = false;
// The record leaves (and comes back) with a little shrink-and-fade while the
// title and controls glide into its place. Super lite itself has no motion,
// so this runs just before super lite switches on, and just after it switches off.
function animateDeck(leaving) {
  const deck = $('#deck');
  if (deckAnim) deckAnim.cancel();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return Promise.resolve();
  const cs = getComputedStyle(deck);
  const shown = { height: deck.offsetHeight + 'px', marginBottom: cs.marginBottom, opacity: 1, transform: 'scale(1) rotate(0deg)' };
  const gone = { height: '0px', marginBottom: '0px', opacity: 0, transform: 'scale(.55) rotate(-25deg)' };
  deckLeaving = leaving;
  deckAnim = deck.animate(leaving ? [shown, gone] : [gone, shown], {
    duration: 550, easing: 'cubic-bezier(.2, .8, .2, 1)', fill: leaving ? 'forwards' : 'none',
  });
  return deckAnim.finished.catch(() => {});
}

async function applyPerf(mode, animate = false) {
  if (!PERF[mode]) mode = 'full';
  const wasSuper = document.body.classList.contains('super');
  const toSuper = mode === 'super';
  prefs.set('perf', mode);
  document.querySelectorAll('#perfSeg button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.perf === mode)));
  $('#perfHint').textContent = PERF[mode].hint;
  document.body.classList.toggle('lite', mode !== 'full');
  viz.setEnabled(mode === 'full');
  $('#vizOffHint').hidden = mode === 'full';
  if (animate && toSuper && !wasSuper) {
    await animateDeck(true);
    if (prefs.get('perf') !== 'super') return; // switched again mid-animation
  }
  document.body.classList.toggle('super', toSuper);
  if (deckAnim && toSuper) { deckAnim.cancel(); deckAnim = null; deckLeaving = false; }
  if (!toSuper && deckLeaving && deckAnim) {
    // changed your mind while the record was leaving: send it back from where it is
    const a = deckAnim;
    deckLeaving = false;
    a.reverse();
    a.finished.then(() => a.cancel(), () => {});
  } else if (animate && wasSuper && !toSuper) animateDeck(false);
}
document.querySelectorAll('#perfSeg button').forEach(b => b.onclick = () => {
  if (prefs.get('perf', 'full') === b.dataset.perf) return;
  applyPerf(b.dataset.perf, true);
  toast(PERF[b.dataset.perf].toast);
});

/* visualizer settings, like OBS's Spectralizer: mode, filter + strength, detail, speed, gravity,
   inertia, round corners, automatic scaling, log scale, stereo, colour, glow, bar sizes */
function setupVizSettings() {
  const num = (v, d) => (+v).toFixed(d).replace(/\.?0+$/, '') || '0';
  const ranges = {
    strength: [$('#vizStrength'), v => num(v, 2)],
    bars: [$('#vizBars'), v => `${v} bars`],
    gap: [$('#vizGap'), v => (+v === 0 ? 'touching' : `${Math.round(v * 100)}%`)],
    speed: [$('#vizSpeed'), v => `${num(v, 2)}×`],
    gravity: [$('#vizGravity'), v => (+v === 0 ? 'off' : (+v).toFixed(2))],
    inertia: [$('#vizInertia'), v => (+v === 0 ? 'off' : `${Math.round(v * 100)}%`)],
    spin: [$('#vizSpin'), v => (+v === 0 ? 'off' : `${+v > 0 ? '↻' : '↺'} ${num(Math.abs(v), 1)}`)],
    size: [$('#vizSize'), v => `${Math.round(v * 100)}%`],
  };
  const checks = { ring: $('#vizRing'), round: $('#vizRound'), autoscale: $('#vizAutoscale'), log: $('#vizLog'), stereo: $('#vizStereo'), glow: $('#vizGlow') };
  const px = { barWidth: [$('#vizBarWidth'), 1, 60], barHeight: [$('#vizBarHeight'), 10, 1000], barSpacing: [$('#vizBarSpacing'), 0, 40] };
  const save = patch => {
    const next = VizCore.options({ ...vizOpts(), ...patch });
    prefs.set('viz', next);
    viz.configure(next);
    show(next);
    pushOverlay(); // the OBS overlay and visualizer source follow these settings too
  };
  function show(o) {
    document.querySelectorAll('#vizStyleSeg button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.style === o.style)));
    for (const [key, [input, label]] of Object.entries(ranges)) {
      input.value = o[key];
      setFill(input);
      $(`#${input.id}Val`).textContent = label(o[key]);
    }
    for (const [key, box] of Object.entries(checks)) box.checked = !!o[key];
    for (const [key, [input]] of Object.entries(px)) if (document.activeElement !== input) input.value = o[key];
    $('#vizFilter').value = o.filter;
    $('#vizStrengthField').hidden = o.filter !== 'monstercat';
    $('#vizColor').value = o.color;
    $('#vizCustom').value = o.custom;
    $('#vizCustomField').hidden = o.color !== 'custom';
    // the visualizer source's size in OBS: every bar + the gaps between them
    const w = o.bars * (o.barWidth + o.barSpacing) - o.barSpacing;
    $('#vizSizeHint').textContent = `size in OBS: ${w} × ${o.barHeight}${o.stereo ? ' (stereo: left channel up, right channel down)' : ''}.`;
  }
  // the monstercat look comes with its filter switched on (it can be switched off again)
  document.querySelectorAll('#vizStyleSeg button').forEach(b => b.onclick = () =>
    save(b.dataset.style === 'monstercat' && vizOpts().style !== 'monstercat' ? { style: 'monstercat', filter: 'monstercat' } : { style: b.dataset.style }));
  for (const [key, [input]] of Object.entries(ranges)) input.oninput = () => save({ [key]: +input.value });
  for (const [key, box] of Object.entries(checks)) box.onchange = () => save({ [key]: box.checked });
  for (const [key, [input, min, max]] of Object.entries(px)) {
    input.oninput = () => { const n = Math.round(+input.value); if (n >= min && n <= max) save({ [key]: n }); };
    input.onchange = () => { save({ [key]: Math.max(min, Math.min(max, Math.round(+input.value) || VIZ_DEFAULTS[key])) }); input.value = vizOpts()[key]; };
  }
  $('#vizFilter').onchange = () => save({ filter: $('#vizFilter').value });
  $('#vizColor').onchange = () => save({ color: $('#vizColor').value });
  $('#vizCustom').oninput = () => save({ custom: $('#vizCustom').value });
  $('#vizReset').onclick = () => { prefs.set('viz', {}); viz.configure(VIZ_DEFAULTS); show(VizCore.options({})); pushOverlay(); toast('visualizer reset ✦'); };
  show(vizOpts());
  // desktop app: the visualizer as its own OBS source
  if (desktop && desktop.overlay) desktop.overlay.url().then(base => {
    if (!base) return;
    const url = `${base}?layout=bars`;
    $('#vizObsBox').hidden = false;
    $('#vizUrl').value = url;
    $('#vizUrlCopy').onclick = async () => {
      try { await navigator.clipboard.writeText(url); } catch { $('#vizUrl').select(); document.execCommand('copy'); }
      toast('copied ✦ paste it in a Browser source in OBS');
    };
    $('#vizPreview').onclick = () => desktop.overlay.open(url);
  }).catch(() => {});
}

// Settings sections fold away when you click their heading (remembered), so the long
// panel stays easy to find your way around
function setupFolding() {
  const folded = new Set(prefs.get('foldedSections', []));
  document.querySelectorAll('#settings section').forEach(sec => {
    const head = sec.querySelector(':scope > .eyebrow:first-child');
    if (!head) return;
    const key = sec.id || head.textContent.trim();
    head.tabIndex = 0;
    head.setAttribute('role', 'button');
    const set = fold => {
      sec.classList.toggle('folded', fold);
      head.setAttribute('aria-expanded', String(!fold));
      if (fold) folded.add(key); else folded.delete(key);
      prefs.set('foldedSections', [...folded]);
    };
    set(folded.has(key));
    head.onclick = () => set(!sec.classList.contains('folded'));
    head.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); head.click(); } };
  });
}

function buildFloaties() {
  const box = $('#floaties');
  const n = matchMedia('(max-width: 900px)').matches ? 8 : 14;
  for (let i = 0; i < n; i++) {
    const f = document.createElement('div');
    const size = 8 + Math.random() * 14;
    f.className = 'floaty';
    f.style.cssText = `left:${Math.random() * 100}%;width:${size}px;height:${size}px;` +
      `animation-duration:${18 + Math.random() * 22}s;animation-delay:${-Math.random() * 40}s;` +
      `--dx:${(Math.random() - 0.5) * 120}px;--o:${0.15 + Math.random() * 0.3}`;
    f.innerHTML = `<svg style="--heart-fill:currentColor"><use href="#i-${i % 3 ? 'sparkle' : 'heart'}"/></svg>`;
    box.append(f);
  }
}

function heartBurst(from) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || document.body.classList.contains('super')) return;
  const r = from.getBoundingClientRect();
  for (let i = 0; i < 8; i++) {
    const b = document.createElement('div');
    const a = (i / 8) * Math.PI * 2;
    b.className = 'burst';
    b.style.cssText = `left:${r.left + r.width / 2 - 8}px;top:${r.top + r.height / 2 - 8}px;` +
      `--bx:${Math.cos(a) * 46}px;--by:${Math.sin(a) * 46 - 10}px;--br:${(Math.random() - 0.5) * 90}deg`;
    b.innerHTML = `<svg style="--heart-fill:currentColor"><use href="#i-${i % 2 ? 'sparkle' : 'heart'}"/></svg>`;
    document.body.append(b);
    setTimeout(() => b.remove(), 1000);
  }
}

/* ───────────── visualizer ───────────── */
const VIZ_DEFAULTS = VizCore.DEFAULTS;
const vizOpts = () => VizCore.options(prefs.get('viz', {}));
const viz = (() => {
  const canvas = $('#viz');
  const g = canvas.getContext('2d');
  let opts = vizOpts();
  const shape = VizCore.shaper();
  let ctx = null, analyser = null, freq = null, color = '#fff', color2 = '#fff';
  let analyserL = null, analyserR = null, freqL = null, freqR = null; // for stereo
  // speed: how quickly the bars jump up and fall back (1 = moonlit's usual)
  const smoothing = () => Math.min(0.95, Math.max(0.3, 0.95 - 0.13 * opts.speed));

  function ensureAudioGraph() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaElementSource(audio);
      const make = () => { const a = ctx.createAnalyser(); a.fftSize = 2048; a.smoothingTimeConstant = smoothing(); return a; };
      analyser = make();
      freq = new Uint8Array(analyser.frequencyBinCount);
      src.connect(analyser);
      analyser.connect(ctx.destination);
      // left and right on their own, only listened to (they don't go to the speakers)
      const split = ctx.createChannelSplitter(2);
      src.connect(split);
      analyserL = make(); analyserR = make();
      split.connect(analyserL, 0); split.connect(analyserR, 1);
      freqL = new Uint8Array(analyserL.frequencyBinCount); freqR = new Uint8Array(analyserR.frequencyBinCount);
      // once audio runs through the AudioContext, the context decides the output device
      const sink = prefs.get('sinkId', '');
      if (sink && ctx.setSinkId) ctx.setSinkId(sink).catch(() => toast("your chosen sound output isn't connected, so music is on the default device", 6000));
    } catch { ctx = null; }
  }

  // n levels (0-255), bass → treble; with stereo: n for the left channel, then n for the right
  // (into one reused buffer: this runs every frame, so it makes no new arrays)
  let bandBuf = new Float32Array(0);
  function read(n, stereo) {
    const len = stereo && analyserL ? n * 2 : n;
    if (bandBuf.length < len) bandBuf = new Float32Array(len * 2);
    if (stereo && analyserL) {
      analyserL.getByteFrequencyData(freqL); analyserR.getByteFrequencyData(freqR);
      VizCore.bands(freqL, n, opts.log, bandBuf.subarray(0, n));
      VizCore.bands(freqR, n, opts.log, bandBuf.subarray(n, len));
    } else {
      analyser.getByteFrequencyData(freq);
      VizCore.bands(freq, n, opts.log, bandBuf.subarray(0, n));
    }
    return bandBuf.subarray(0, len);
  }
  let goal = new Float32Array(0);

  function resize() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
  }
  new ResizeObserver(resize).observe(canvas);

  function refreshColor() {
    const cs = getComputedStyle(document.body);
    color = cs.getPropertyValue('--accent').trim() || '#fff';
    color2 = cs.getPropertyValue('--accent2').trim() || color;
  }

  function configure(next) {
    opts = VizCore.options(next);
    for (const a of [analyser, analyserL, analyserR]) if (a) a.smoothingTimeConstant = smoothing();
    lastDraw = 0;
  }

  let raf = 0, enabled = true, lastDraw = 0, lastT = 0, turn = 0, cleared = false;
  const settled = () => shape.levels().every(v => v < 0.07);
  function frame(t) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(100, t - (lastT || t));
    lastT = t;
    if (document.hidden || document.body.classList.contains('asleep')) return;
    const w = canvas.width, h = canvas.height;
    // the ring switched off (visualizer → "show the visualizer around the record")
    if (!opts.ring) { if (!cleared) { g.clearRect(0, 0, w, h); cleared = true; } return; }
    cleared = false;
    if (!w) return;
    const playing = !audio.paused;
    turn += opts.spin * dt * 0.00035 * (playing ? 1 : 0.3);
    // nothing playing, no spin and the ring has settled: 12 frames a second is plenty for the gentle idle shimmer
    if (!playing && !opts.spin && t - lastDraw < 83 && settled()) return;
    lastDraw = t;
    const BARS = opts.bars, half = Math.ceil(BARS / 2);
    const f = (dt / 16.7) * opts.speed;
    // the ring is mirrored: the left half shows bass at the top down to treble at the bottom, the
    // right half the same again (with stereo: left half = left channel, right half = right channel)
    const raw = analyser && playing ? read(half, opts.stereo) : null;
    if (goal.length !== BARS) goal = new Float32Array(BARS);
    for (let i = 0; i < BARS; i++) {
      const right = i >= half, k = right ? BARS - 1 - i : i;
      goal[i] = raw ? (raw[opts.stereo && right ? half + k : k] / 255) ** 1.6 : 0;
    }
    if (raw && opts.autoscale) shape.scale(goal, f);
    // each half on its own, so the mirror line stays clean
    if (opts.filter === 'monstercat') { VizCore.monstercat(goal, opts.strength, 0, half); VizCore.monstercat(goal, opts.strength, half, BARS); }
    for (let i = 0; i < BARS; i++) goal[i] = Math.max(goal[i], 0.03 + 0.02 * Math.sin((t * opts.speed) / 900 + i * 0.5 * (72 / BARS)));
    const levels = shape.move(goal, f, opts);

    g.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    // the canvas is 1.9× the record, so there's room for big sizes; sizes are measured from the record
    const rec = w / 2 / 1.9, edge = rec * 1.86;
    const inner = rec * 1.035; // just outside the record
    const maxLen = Math.min(rec * 0.375 * opts.size, edge - inner);
    const thin = 72 / BARS; // more bars → thinner lines
    const paint = i => (opts.color === 'rainbow' ? `hsl(${(i / BARS) * 360 + t * 0.02 * opts.speed} 90% 72%)` : null);
    let fill;
    if (opts.color === 'custom') fill = opts.custom;
    else if (opts.color === 'theme') {
      fill = g.createLinearGradient(0, 0, w, h);
      fill.addColorStop(0, color);
      fill.addColorStop(1, color2);
    }
    g.strokeStyle = g.fillStyle = fill || color;
    g.shadowColor = opts.color === 'custom' ? opts.custom : color;
    g.shadowBlur = playing && opts.glow ? rec * 0.035 : 0;
    g.lineCap = opts.round ? 'round' : 'butt';
    g.lineJoin = 'round';
    const angle = i => (i / BARS) * Math.PI * 2 - Math.PI / 2 + turn;

    if (opts.style === 'wave') {
      // one smooth line around the record, gently filled underneath
      const pts = [];
      for (let i = 0; i < BARS; i++) {
        const a = angle(i), r = inner + Math.min(levels[i] * maxLen, edge - inner);
        pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
      }
      g.beginPath();
      for (let i = 0; i <= BARS; i++) {
        const p = pts[i % BARS], q = pts[(i + 1) % BARS];
        const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
        if (i === 0) g.moveTo(mx, my); else g.quadraticCurveTo(p[0], p[1], mx, my);
      }
      g.closePath();
      if (opts.color === 'rainbow') {
        const cg = g.createConicGradient ? g.createConicGradient(turn - Math.PI / 2, cx, cy) : null;
        if (cg) for (let s = 0; s <= 6; s++) cg.addColorStop(s / 6, `hsl(${s * 60 + t * 0.02 * opts.speed} 90% 72%)`);
        g.strokeStyle = g.fillStyle = cg || color;
      }
      g.lineWidth = Math.max(2, rec * 0.017);
      g.globalAlpha = 0.16;
      g.fill();
      g.globalAlpha = 0.9;
      g.stroke();
    } else {
      for (let i = 0; i < BARS; i++) {
        const a = angle(i), len = Math.min(levels[i] * maxLen, edge - inner);
        const cos = Math.cos(a), sin = Math.sin(a);
        const c = paint(i);
        if (c) { g.strokeStyle = g.fillStyle = c; if (opts.glow) g.shadowColor = c; }
        g.globalAlpha = Math.min(1, 0.35 + levels[i] * 0.65);
        if (opts.style === 'dots') {
          const r = Math.max(1.5, rec * 0.013 * Math.min(1.6, thin)) * (0.7 + Math.min(1, levels[i]) * 0.9);
          g.beginPath();
          g.arc(cx + cos * (inner + len), cy + sin * (inner + len), r, 0, Math.PI * 2);
          g.fill();
        } else if (opts.style === 'monstercat') {
          // Monstercat's solid, flat-topped blocks, packed close together
          g.globalAlpha = 0.92;
          g.lineWidth = Math.max(2, ((Math.PI * 2 * inner) / BARS) * 0.62);
          g.beginPath();
          g.moveTo(cx + cos * inner, cy + sin * inner);
          g.lineTo(cx + cos * (inner + Math.max(rec * 0.012, len)), cy + sin * (inner + Math.max(rec * 0.012, len)));
          g.stroke();
        } else if (opts.style === 'rays') {
          // thin tapered wedges that fan out from the record
          const spread = (Math.PI / BARS) * 0.55, out = Math.min(edge, inner + len * 1.25);
          g.beginPath();
          g.moveTo(cx + cos * inner, cy + sin * inner);
          g.lineTo(cx + Math.cos(a - spread) * out, cy + Math.sin(a - spread) * out);
          g.lineTo(cx + Math.cos(a + spread) * out, cy + Math.sin(a + spread) * out);
          g.closePath();
          g.fill();
        } else {
          g.lineWidth = Math.max(1.5, rec * 0.017 * Math.min(1.5, thin));
          g.beginPath();
          g.moveTo(cx + cos * inner, cy + sin * inner);
          g.lineTo(cx + cos * (inner + len), cy + sin * (inner + len));
          g.stroke();
        }
      }
    }
    g.globalAlpha = 1;
  }
  raf = requestAnimationFrame(frame);
  // lite mode switches the visualizer off completely (no drawing loop at all)
  function setEnabled(on) {
    if (on === enabled) return;
    enabled = on;
    cancelAnimationFrame(raf);
    if (on) raf = requestAnimationFrame(frame);
    else g.clearRect(0, 0, canvas.width, canvas.height);
  }
  // levels for the OBS overlay: bass on the left, treble on the right (and the right channel
  // after the left with stereo). Works in every effects mode (lite only stops drawing the ring).
  function sample(n, stereo) {
    if (!analyser || audio.paused) return null;
    return Array.from(read(n, stereo), Math.round);
  }
  return { ensureAudioGraph, refreshColor, setEnabled, sample, configure, opts: () => opts, getCtx: () => ctx };
})();

/* ───────────── library rendering ───────────── */
function visibleTracks() {
  const q = state.query.toLowerCase();
  const pl = currentPlaylist();
  // a playlist keeps its own order; "all" and "loved" follow the library's
  const from = pl ? pl.ids.map(byId).filter(Boolean) : state.tracks.filter(t => state.view !== 'loved' || t.fav);
  return q ? from.filter(t => `${t.title} ${t.artist || ''} ${t.album || ''}`.toLowerCase().includes(q)) : from;
}

function updateCount() {
  const total = state.tracks.length;
  const secs = state.tracks.reduce((s, t) => s + (t.duration || 0), 0);
  const h = Math.floor(secs / 3600);
  el.count.textContent = `${total.toLocaleString()} song${total === 1 ? '' : 's'}` +
    (secs ? ` · ${h ? `${h}h ${Math.floor((secs % 3600) / 60)}m` : fmt(secs)}` : '');
}

function renderList(animate = false) {
  const items = visibleTracks();
  const total = state.tracks.length;
  updateCount();
  el.empty.hidden = total > 0;
  el.list.hidden = total === 0;
  el.list.innerHTML = '';
  renderToken++;
  el.list.classList.toggle('intro', animate);
  if (total && !items.length) {
    const li = document.createElement('li');
    li.className = 'empty-sub';
    li.style.cssText = 'text-align:center;padding:30px 10px';
    li.textContent = state.query ? 'nothing matches that'
      : state.view === 'loved' ? 'no loved songs yet — tap the heart ♡'
      : "none of this playlist's songs are in your library yet. add them, then open the playlist again";
    el.list.append(li);
    return;
  }
  // Draw the first screenful right away and the rest a chunk per frame,
  // so even a 1,000+ song list never freezes the app.
  const token = ++renderToken;
  const drawRows = (from, to) => {
    const frag = document.createDocumentFragment();
    for (let i = from; i < Math.min(to, items.length); i++) frag.append(trackRow(items[i], i));
    el.list.append(frag);
    if (to < items.length) requestAnimationFrame(() => { if (token === renderToken) drawRows(to, to + 150); });
  };
  drawRows(0, 60);
}

let renderToken = 0;
function trackRow(t, i) {
  const li = document.createElement('li');
  li.className = 'track' + (t.id === state.currentId ? ' current' : '');
  li.dataset.id = t.id;
  li.style.animationDelay = Math.min(i * 18, 300) + 'ms';
  const url = coverUrl(t);
  li.innerHTML = `
    <div class="thumb">${url ? `<img src="${url}" alt="" loading="lazy">` : '<svg><use href="#i-note"/></svg>'}
      <div class="bars"><i></i><i></i><i></i></div></div>
    <div class="t-text"><div class="t-title"></div><div class="t-artist"></div></div>
    <span class="t-dur">${t.duration ? fmt(t.duration) : ''}</span>
    <div class="t-actions">
      <button class="icon-btn t-fav" aria-label="love" aria-pressed="${!!t.fav}"><svg><use href="#i-heart"/></svg></button>
      <button class="icon-btn t-del" aria-label="remove from library"><svg><use href="#i-x"/></svg></button>
    </div>`;
  li.querySelector('.t-title').textContent = t.title;
  li.querySelector('.t-artist').textContent = [t.artist, t.album].filter(Boolean).join(' · ') || 'unknown artist';
  return li;
}

el.list.addEventListener('click', e => {
  const li = e.target.closest('.track');
  if (!li) return;
  const id = li.dataset.id;
  if (e.target.closest('.t-fav')) { toggleFav(id); return; }
  if (e.target.closest('.t-del')) { removeTrack(id); return; }
  state.queue = visibleTracks().map(t => t.id);
  state.history = [];
  if (id === state.currentId) { togglePlay(); return; }
  playTrack(id);
  if (matchMedia('(max-width: 900px)').matches) setLibrary(false);
});

function setView(view) {
  state.view = view;
  if (!currentPlaylist() && view.startsWith('pl:')) state.view = 'all';
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.view === state.view)));
  // an open playlist shows as a bar under the search, with a ✕ back to all songs
  const pl = currentPlaylist();
  $('#plBar').hidden = !pl;
  if (pl) {
    $('#plBarName').textContent = pl.name;
    $('#plBarName').title = pl.name;
    const n = pl.ids.filter(byId).length;
    $('#plBarCount').textContent = `${n} song${n === 1 ? '' : 's'}`;
  }
  renderList();
  syncPlaylistMenu();
}
document.querySelectorAll('.tab').forEach(tab => tab.onclick = () => setView(tab.dataset.view));

/* ───────────── playlists: import and export (.m3u8 files) ─────────────
   A playlist file lists songs by file name (plus "artist - title" and the length), the way
   VLC, foobar2000, Winamp and most players write them. Importing one finds those songs in
   your library (on the PC, songs it points to that aren't in your library yet are added),
   and it becomes a tab next to "all" and "loved". */
let playlists = prefs.get('playlists', []).filter(p => p && p.id && Array.isArray(p.ids));
const savePlaylists = () => prefs.set('playlists', playlists);
function currentPlaylist() {
  return state.view.startsWith('pl:') ? playlists.find(p => p.id === state.view.slice(3)) || null : null;
}
const oneLine = s => String(s || '').replace(/[\r\n]+/g, ' ').trim();

function toM3u(name, tracks) {
  const out = ['#EXTM3U', `#PLAYLIST:${oneLine(name)}`];
  for (const t of tracks) {
    out.push(`#EXTINF:${Math.round(t.duration) || -1},${oneLine(t.artist ? `${t.artist} - ${t.title}` : t.title)}`);
    if (t.album) out.push(`#EXTALB:${oneLine(t.album)}`);
    out.push(oneLine(t.file && t.file.name) || `${oneLine(t.title)}.mp3`);
  }
  return out.join('\r\n') + '\r\n';
}

function parseM3u(text) {
  const entries = [];
  let name = '', info = null;
  for (const raw of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    let m;
    if ((m = /^#PLAYLIST:(.*)$/i.exec(l))) name = m[1].trim();
    else if ((m = /^#EXTINF:\s*(-?[\d.]+)?[^,]*,(.*)$/i.exec(l))) info = { duration: Number(m[1]) || 0, label: m[2].trim() };
    else if (!l.startsWith('#')) { entries.push({ line: l, ...(info || {}) }); info = null; }
  }
  return { name, entries };
}

// "C:\Music\Song.mp3", "file:///C:/Music/Song%20Name.mp3", "../Song.mp3" → "Song.mp3"
function fileNameOf(line) {
  let s = line;
  if (/^file:/i.test(s)) { try { s = decodeURIComponent(new URL(s).pathname); } catch { /* keep it */ } }
  return s.split(/[\\/]/).pop();
}
const matchKey = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|webm|weba|aiff?)$/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function matchEntries(entries) {
  const byFile = new Map(), byName = new Map();
  const put = (map, k, t) => { if (k && !map.has(k)) map.set(k, t); };
  for (const t of state.tracks) {
    if (t.file && t.file.name) put(byFile, t.file.name.toLowerCase(), t);
    if (t.artist) put(byName, matchKey(`${t.artist} - ${t.title}`), t);
    put(byName, matchKey(t.title), t);
    if (t.file && t.file.name) put(byName, matchKey(t.file.name), t);
  }
  return entries.map(e => {
    const file = fileNameOf(e.line);
    return byFile.get(file.toLowerCase()) || byName.get(matchKey(e.label)) || byName.get(matchKey(file)) || null;
  });
}

async function importPlaylist({ name, text, files = {} }) {
  const parsed = parseM3u(text);
  if (!parsed.entries.length) { toast("that file has no songs in it. is it a playlist (.m3u8 / .m3u)?", 5000); return; }
  let found = matchEntries(parsed.entries);
  // on the PC: songs the playlist points to that aren't in your library yet are added
  const missing = [...new Set(parsed.entries.filter((e, i) => !found[i] && files[e.line]).map(e => files[e.line]))];
  if (missing.length && desktop) {
    toast(`adding ${missing.length} song${missing.length === 1 ? '' : 's'} from the playlist…`, 0);
    await openExternalFiles(missing, { play: false, quiet: true });
    found = matchEntries(parsed.entries);
  }
  const ids = [...new Set(found.filter(Boolean).map(t => t.id))];
  const title = (parsed.name || name || 'playlist').slice(0, 80);
  // importing the same playlist again updates it
  const old = playlists.find(p => p.name === title);
  const pl = old || { id: uid(), name: title, ids: [] };
  pl.ids = ids;
  if (!old) playlists.push(pl);
  savePlaylists();
  setView(`pl:${pl.id}`);
  $('#plMenu').hidden = true;
  $('#plBtn').setAttribute('aria-expanded', 'false');
  const lost = parsed.entries.length - found.filter(Boolean).length;
  toast(`playlist "${title}": ${ids.length} song${ids.length === 1 ? '' : 's'}` +
    (lost ? ` · ${lost} not in your library (add them, then import it again)` : ' ✦'), lost ? 6000 : 3000);
}

async function exportPlaylist() {
  const tracks = visibleTracks();
  if (!tracks.length) { toast('this list is empty, nothing to save'); return; }
  const pl = currentPlaylist();
  const name = pl ? pl.name : state.view === 'loved' ? 'moonlit - loved' : 'moonlit - all songs';
  const text = toM3u(name, tracks);
  if (desktop && desktop.playlist) {
    const where = await desktop.playlist.save(name, text).catch(() => null);
    if (where) toast(`saved ${tracks.length} song${tracks.length === 1 ? '' : 's'} as ${fileNameOf(where)} ✓`, 4000);
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'audio/x-mpegurl' }));
  // browsers fall back to "download" for some letters, so the file name is kept to plain ones
  const plain = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w .()&'-]+/g, ' ').replace(/\s+/g, ' ').trim();
  a.download = `${plain || 'playlist'}.m3u8`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  toast(`saved ${tracks.length} song${tracks.length === 1 ? '' : 's'} as a playlist file ✓`, 4000);
}

function syncPlaylistMenu() {
  const list = $('#plList');
  list.innerHTML = '';
  for (const p of playlists) {
    const b = document.createElement('button');
    b.className = 'pl-chip';
    b.type = 'button';
    b.textContent = p.name;
    const n = document.createElement('small');
    n.textContent = p.ids.filter(byId).length;
    b.append(n);
    b.setAttribute('aria-current', String(state.view === `pl:${p.id}`));
    b.onclick = () => { setView(`pl:${p.id}`); $('#plMenu').hidden = true; $('#plBtn').setAttribute('aria-expanded', 'false'); };
    list.append(b);
  }
  const pl = currentPlaylist();
  $('#plRemove').hidden = !pl;
  $('#plExportText').textContent = pl ? `save "${pl.name}" as a playlist file`
    : state.view === 'loved' ? 'save your loved songs as a playlist file' : 'save all your songs as a playlist file';
}

function setupPlaylists() {
  const menu = $('#plMenu'), btn = $('#plBtn'), input = $('#plInput');
  btn.onclick = () => {
    menu.hidden = !menu.hidden;
    btn.setAttribute('aria-expanded', String(!menu.hidden));
    if (!menu.hidden) syncPlaylistMenu();
  };
  $('#plExport').onclick = exportPlaylist;
  $('#plBarClose').onclick = () => setView('all');
  $('#plImport').onclick = async () => {
    if (desktop && desktop.playlist) {
      const r = await desktop.playlist.open().catch(() => null);
      if (r && r.error) toast(r.error);
      else if (r) importPlaylist(r);
      return;
    }
    input.value = '';
    input.click();
  };
  // file-type filters hide .m3u8 files on some phones, so every file can be picked
  if (!matchMedia('(pointer: coarse)').matches) input.accept = '.m3u8,.m3u,audio/x-mpegurl,audio/mpegurl,application/vnd.apple.mpegurl';
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    if (f.size > 5_000_000) { toast('that file is too big to be a playlist'); return; }
    const bytes = new Uint8Array(await f.arrayBuffer());
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = new TextDecoder('windows-1252').decode(bytes); }
    importPlaylist({ name: f.name.replace(/\.m3u8?$/i, ''), text });
  };
  $('#plRemove').onclick = () => {
    const pl = currentPlaylist();
    if (!pl || !confirm(`remove the playlist "${pl.name}"?\n\nonly the playlist goes. its songs stay in your library.`)) return;
    playlists = playlists.filter(p => p !== pl);
    savePlaylists();
    setView('all');
    toast('playlist removed');
  };
  syncPlaylistMenu();
}
let searchTimer;
el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.query = el.search.value.trim(); renderList(); }, state.tracks.length > 300 ? 150 : 0);
});

/* ───────────── adding / removing ───────────── */
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|webm|weba|aiff?)$/i;

// Several artists are often stored as "A;B" or "A/B" (YouTube downloads, some taggers):
// shown as "A, B". A slash only counts between names with spaces around it, so AC/DC stays AC/DC.
const tidyArtist = s => String(s || '').replace(/\s*;\s*|\s+\/\s+|\0/g, ', ').replace(/(,\s*)+/g, ', ').replace(/^,\s*|,\s*$/g, '').trim();

// Songs downloaded before 1.6.9 from copyright-free channels could be mixed up: title "Copyright
// Free Music", artist "Priamo - Weakness | Future Bass | NCS". Tidied once when the library loads
// (downloads are tidied by the downloader now; desktop/downloader.js TITLE_EXTRAS).
const JUNK_BRACKETS = /\s*[\[(][^\])]*(ncs|no ?copyright|copyright[ -]?free|free download|royalty[ -]?free|release)[^\])]*[\])]/gi;
const JUNK_TAIL = /\s*[-–]\s*(no ?copyright|copyright[ -]?free|royalty[ -]?free)\b.*$/i;
const JUNK_TITLE = /^\s*(no )?copyright[ -]?free( music| sounds?)?\s*$|^\s*no copyright (music|sounds?)\s*$/i;
const unquote = s => s.replace(/^\s*["“”](.+)["“”]\s*$/, '$1');
function untangleTags(t) {
  let { title = '', artist = '' } = t;
  if (JUNK_TITLE.test(title) && artist.includes(' - ')) {
    const i = artist.indexOf(' - ');
    title = artist.slice(i + 3);
    artist = artist.slice(0, i);
  }
  const channelJunk = /ncs|copyright|royalty/i.test(title);
  title = title.replace(JUNK_BRACKETS, '').replace(JUNK_TAIL, '');
  if (channelJunk) title = title.replace(/\s+\|\s.*$/, ''); // "Weakness | Future Bass | NCS"
  title = unquote(title).trim();
  artist = tidyArtist(unquote(artist.replace(JUNK_BRACKETS, '')));
  if (!title || (title === t.title && artist === (t.artist || ''))) return false;
  t.title = title;
  t.artist = artist;
  return true;
}

async function makeRecord(f) {
  const tags = await readTags(f);
  const guess = fromFilename(f.name);
  return {
    id: uid(),
    title: tags.title || guess.title || f.name,
    artist: tidyArtist(tags.artist || guess.artist || ''),
    album: tags.album || '',
    cover: tags.cover || null,
    duration: 0, // measured in the background afterwards, see fillDurations()
    file: f,
    fav: false,
    added: Date.now(),
  };
}

let importing = false;
async function addFiles(fileList, { quiet = false } = {}) {
  const files = [...fileList].filter(f => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name));
  if (!files.length) { toast("those don't look like songs"); return; }
  if (importing) { toast('still adding the last batch, one sec…'); return; }
  importing = true;
  const total = files.length;
  const CHUNK = 40;
  let added = 0;
  try {
    for (let i = 0; i < total; i += CHUNK) {
      if (total > CHUNK && !quiet) toast(`adding songs… ${added} / ${total}`, 0);
      const recs = await Promise.all(files.slice(i, i + CHUNK).map(makeRecord));
      if (state.persistent) {
        try { await DB.putMany(recs); } catch (err) {
          state.persistent = false;
          toast(err && err.name === 'QuotaExceededError'
            ? 'your device ran out of room for more songs. the rest will only last until you close the app'
            : "couldn't save to this browser. songs will last until you close the tab", 6000);
        }
      }
      for (const r of recs) { state.tracks.push(r); trackMap.set(r.id, r); }
      added += recs.length;
      // re-draw the list now and then so you can see it filling up
      if (i === 0 || (i / CHUNK) % 5 === 4 || added === total) renderList(i === 0);
    }
  } finally {
    importing = false;
  }
  saveOrder();
  renderList();
  if (!quiet && (state.persistent || added < 2)) toast(`added ${added} song${added === 1 ? '' : 's'} ✦`);
  if (!state.currentId && state.tracks.length) loadTrack(state.tracks[0].id);
  fillDurations();
}

// Song lengths are measured a few at a time in the background,
// so adding a big folder doesn't have to wait for every file to be opened.
const durationTried = new Set();
let filling = false;
async function fillDurations() {
  if (filling) return;
  filling = true;
  const work = async () => {
    for (;;) {
      const t = state.tracks.find(x => !x.duration && !durationTried.has(x.id));
      if (!t) return;
      durationTried.add(t.id);
      const d = await probeDuration(t.file);
      if (d && byId(t.id)) setDuration(t, d);
    }
  };
  try { await Promise.all([work(), work(), work()]); } finally { filling = false; }
  updateCount();
}
function setDuration(t, d) {
  t.duration = d;
  if (state.persistent) DB.put(t).catch(() => {});
  const cell = el.list.querySelector(`[data-id="${t.id}"] .t-dur`);
  if (cell) cell.textContent = fmt(d);
}

async function removeTrack(id, { ask = true } = {}) {
  const t = byId(id);
  if (!t || (ask && !confirm(`remove “${t.title}” from your library?`))) return;
  if (id === state.currentId) {
    const next = neighbour(1);
    audio.pause();
    if (next && next !== id) loadTrack(next); else clearNowPlaying();
  }
  state.tracks = state.tracks.filter(x => x.id !== id);
  trackMap.delete(id);
  state.queue = state.queue.filter(x => x !== id);
  if (coverUrls.has(id)) { URL.revokeObjectURL(coverUrls.get(id)); coverUrls.delete(id); }
  if (state.persistent) DB.del(id).catch(() => {});
  saveOrder();
  renderList();
}

function saveOrder() { prefs.set('order', state.tracks.map(t => t.id)); }

// Empties moonlit's library (the song copies it keeps). Files on your PC aren't touched.
async function clearLibrary() {
  const n = state.tracks.length;
  if (!n) { toast('your library is already empty'); return; }
  if (!confirm(`remove all ${n.toLocaleString()} songs from moonlit?\n\nthis empties moonlit's library. song files on your computer stay where they are.`)) return;
  pause();
  clearNowPlaying();
  for (const url of coverUrls.values()) URL.revokeObjectURL(url);
  coverUrls.clear();
  state.tracks = [];
  state.queue = [];
  state.history = [];
  reindex();
  if (state.persistent) await DB.clear().catch(() => {});
  prefs.set('last', null);
  saveOrder();
  renderList();
  showLibraryInfo();
  toast('library cleared. add songs whenever you like ♡');
}
function showLibraryInfo() {
  const n = state.tracks.length;
  $('#libInfo').textContent = n ? `${n.toLocaleString()} song${n === 1 ? '' : 's'} in your library` : 'your library is empty';
  $('#libClear').hidden = !n;
}
$('#libClear').onclick = clearLibrary;

async function toggleFav(id = state.currentId) {
  const t = byId(id);
  if (!t) return;
  t.fav = !t.fav;
  if (state.persistent) DB.put(t).catch(() => {});
  if (id === state.currentId) syncFav(true);
  const rowBtn = el.list.querySelector(`[data-id="${id}"] .t-fav`);
  if (t.fav) heartBurst(id === state.currentId ? el.fav : rowBtn || el.fav);
  if (state.view === 'loved') renderList();
  else if (rowBtn) rowBtn.setAttribute('aria-pressed', String(t.fav));
}
function syncFav(pulse) {
  const t = byId(state.currentId);
  el.fav.setAttribute('aria-pressed', String(!!(t && t.fav)));
  el.fav.setAttribute('aria-label', t && t.fav ? 'unlove this song' : 'love this song');
  if (pulse) { el.fav.classList.remove('pulse'); void el.fav.offsetWidth; el.fav.classList.add('pulse'); }
}

/* ───────────── playback ───────────── */
function clearNowPlaying() {
  state.currentId = null;
  audio.removeAttribute('src');
  audio.load();
  el.title.textContent = 'nothing playing yet';
  el.nowState.textContent = 'ready when you are';
  queueObsWrite();
  overlayCoverFor = null;
  pushOverlay();
  el.artist.textContent = 'add a few songs to begin';
  el.cover.hidden = true; el.labelIcon.hidden = false;
  document.documentElement.style.removeProperty('--glow');
  document.documentElement.style.removeProperty('--glow2');
  updateTime();
  syncFav();
}

async function loadTrack(id, startAt = 0) {
  const t = byId(id);
  if (!t) return;
  state.currentId = id;
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = URL.createObjectURL(t.file);
  audio.src = audioUrl;
  if (startAt) audio.addEventListener('loadedmetadata', () => { audio.currentTime = startAt; }, { once: true });
  prefs.set('last', { id, time: startAt });

  el.title.textContent = t.title;
  el.title.title = t.title;
  queueObsWrite();
  overlayTrack();
  el.artist.textContent = [t.artist, t.album].filter(Boolean).join(' — ') || 'unknown artist';
  document.title = `${t.title} · moonlit`;
  const url = coverUrl(t);
  el.cover.hidden = !url; el.labelIcon.hidden = !!url;
  if (url) el.cover.src = url;

  const root = document.documentElement.style;
  const cols = t.cover ? await coverColors(t.cover) : null;
  if (state.currentId !== id) return;
  if (cols) { root.setProperty('--glow', cols[0]); root.setProperty('--glow2', cols[1]); }
  else { root.removeProperty('--glow'); root.removeProperty('--glow2'); }

  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist || '', album: t.album || '',
      artwork: url ? [{ src: url, sizes: '512x512', type: t.cover.type || 'image/jpeg' }] : [],
    });
  }
  syncFav();
  document.querySelectorAll('.track').forEach(li => li.classList.toggle('current', li.dataset.id === id));
}

async function playTrack(id) {
  if (state.currentId && state.currentId !== id) state.history.push(state.currentId);
  await loadTrack(id);
  play();
}

function play() {
  if (!state.currentId) {
    if (!state.tracks.length) { el.file.click(); return; }
    state.queue = visibleTracks().map(t => t.id);
    playTrack(state.queue[0] || state.tracks[0].id);
    return;
  }
  viz.ensureAudioGraph();
  maybeReconnectObs();
  state.wantPlaying = true;
  // NotSupportedError is handled by the 'error' listener below, which skips the song
  audio.play().catch(err => { if (err.name === 'NotAllowedError') toast('tap play to start the music'); });
}
function pause() { state.wantPlaying = false; audio.pause(); }
function togglePlay() { audio.paused ? play() : pause(); }

function currentQueue() {
  const q = state.queue.filter(id => byId(id));
  return q.length ? q : state.tracks.map(t => t.id);
}

// Returns the id one step away in the queue (respects shuffle / repeat).
function neighbour(dir, fromEnded = false, from = state.currentId) {
  const q = currentQueue();
  if (!q.length) return null;
  if (state.shuffle && dir > 0 && q.length > 1) {
    const recent = new Set(state.history.slice(-Math.floor(q.length * 0.6)));
    const pool = q.filter(id => id !== from && id !== state.currentId && !recent.has(id));
    const pick = pool.length ? pool : q.filter(id => id !== state.currentId);
    return pick[Math.floor(Math.random() * pick.length)];
  }
  const i = q.indexOf(from);
  let n = i + dir;
  if (n >= q.length) { if (fromEnded && state.repeat === 'off') return null; n = 0; }
  if (n < 0) n = q.length - 1;
  return q[n];
}

// song requests from chat (desktop app, requests.js): they play first, in the order they came
// in; then the playlist carries on right where it was before the first request
const songRequests = [];
const requestsChanged = () => document.dispatchEvent(new Event('moonlit:requests'));
let requestPlaying = null, resumeAfter = null;
function playRequest(id) {
  if (state.currentId !== requestPlaying) resumeAfter = state.currentId; // the playlist's place
  requestPlaying = id;
  playTrack(id);
}

// What plays after this song, so the overlay can show "up next" before it starts.
// With shuffle on, the random pick is made ahead of time (and then really used by next()).
let plannedNext = null; // { from, id }
function playlistFrom() {
  return state.currentId === requestPlaying && byId(resumeAfter) ? resumeAfter : state.currentId;
}
function upNext() {
  if (state.repeat === 'one') return null;
  const req = songRequests.find(r => byId(r.id));
  if (req) return { id: req.id, by: req.by };
  const from = playlistFrom();
  if (!state.shuffle) { plannedNext = null; return { id: neighbour(1, true, from) }; }
  const q = currentQueue();
  if (!plannedNext || plannedNext.from !== from || !q.includes(plannedNext.id) || plannedNext.id === state.currentId) {
    plannedNext = { from, id: neighbour(1, true, from) };
  }
  return { id: plannedNext.id };
}

function next(fromEnded = false) {
  while (songRequests.length) {
    const req = songRequests.shift();
    requestsChanged();
    if (byId(req.id)) { playRequest(req.id); return; } // (skips songs removed from the library since)
  }
  // requests are done: back to the playlist, from the song before them (unless you've picked
  // another song yourself in the meantime)
  const from = playlistFrom();
  requestPlaying = null;
  const planned = state.shuffle && plannedNext && plannedNext.from === from && byId(plannedNext.id) && plannedNext.id !== state.currentId ? plannedNext.id : null;
  plannedNext = null;
  const id = planned || neighbour(1, fromEnded, from);
  if (id) playTrack(id);
  else { pause(); audio.currentTime = 0; }
}
function prev() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (state.shuffle && state.history.length) {
    const id = state.history.pop();
    loadTrack(id).then(play);
    return;
  }
  const id = neighbour(-1);
  if (id) { loadTrack(id).then(play); }
}

audio.addEventListener('play', () => { document.body.classList.add('playing'); syncPlayBtn(); queueObsWrite(); });
audio.addEventListener('pause', () => { document.body.classList.remove('playing'); syncPlayBtn(); saveProgress(true); queueObsWrite(); });
audio.addEventListener('ended', () => {
  if (state.repeat === 'one') { audio.currentTime = 0; play(); return; }
  next(true);
});
// A broken or unsupported file shouldn't leave a 24/7 stream silent: skip it and
// keep going, unless several songs in a row fail (then something bigger is wrong).
let badStreak = 0;
audio.addEventListener('playing', () => { badStreak = 0; });
audio.addEventListener('error', () => {
  if (!audio.getAttribute('src')) return;
  const t = byId(state.currentId);
  if (!state.wantPlaying) { toast(`“${t ? t.title : 'this song'}” won't play here`); return; }
  badStreak++;
  if (badStreak >= Math.min(10, currentQueue().length)) {
    badStreak = 0;
    pause();
    toast("several songs in a row won't play, so i've paused", 8000);
    return;
  }
  toast(`skipped “${t ? t.title : 'a song'}”, it won't play here`, 3500);
  setTimeout(() => { if (state.wantPlaying) next(); }, 600);
});

function syncPlayBtn() {
  const playing = !audio.paused;
  el.playIcon.setAttribute('href', playing ? '#i-pause' : '#i-play');
  el.play.setAttribute('aria-label', playing ? 'pause' : 'play');
  el.nowState.textContent = playing ? 'now playing' : state.currentId ? 'paused' : 'ready when you are';
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}

/* progress */
let seeking = false;
function setFill(input) {
  const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--fill', pct + '%');
}
function updateTime() {
  const d = audio.duration, c = audio.currentTime;
  el.cur.textContent = fmt(c);
  el.dur.textContent = fmt(Number.isFinite(d) ? d : byId(state.currentId)?.duration || 0);
  if (!seeking) { el.seek.value = d ? Math.round((c / d) * 1000) : 0; setFill(el.seek); }
}
audio.addEventListener('timeupdate', () => { updateTime(); saveProgress(); });
audio.addEventListener('loadedmetadata', () => {
  updateTime();
  const t = byId(state.currentId);
  if (t && !t.duration && Number.isFinite(audio.duration)) { setDuration(t, audio.duration); updateCount(); }
});
el.seek.addEventListener('input', () => {
  seeking = true;
  setFill(el.seek);
  if (audio.duration) el.cur.textContent = fmt((el.seek.value / 1000) * audio.duration);
});
el.seek.addEventListener('change', () => {
  if (audio.duration) audio.currentTime = (el.seek.value / 1000) * audio.duration;
  seeking = false;
});

let lastSave = 0;
function saveProgress(force) {
  const now = Date.now();
  if (!state.currentId || (!force && now - lastSave < 4000)) return;
  lastSave = now;
  prefs.set('last', { id: state.currentId, time: audio.currentTime || 0 });
}

/* volume */
function setVolume(v, remember = true) {
  v = Math.max(0, Math.min(1, v));
  audio.volume = v;
  el.vol.value = v;
  setFill(el.vol);
  el.volIcon.setAttribute('href', v === 0 ? '#i-mute' : '#i-volume');
  el.mute.setAttribute('aria-label', v === 0 ? 'unmute' : 'mute');
  if (remember && v > 0) prefs.set('volume', v);
}
el.vol.addEventListener('input', () => setVolume(+el.vol.value));
el.mute.onclick = () => setVolume(audio.volume > 0 ? 0 : prefs.get('volume', 0.8), false);

/* buttons */
el.play.onclick = togglePlay;
el.next.onclick = () => next();
el.prev.onclick = prev;
el.fav.onclick = () => toggleFav();
el.shuffle.onclick = () => { state.shuffle = !state.shuffle; prefs.set('shuffle', state.shuffle); syncModes(); toast(state.shuffle ? 'shuffle on' : 'shuffle off'); };
el.repeat.onclick = () => {
  state.repeat = { off: 'all', all: 'one', one: 'off' }[state.repeat];
  prefs.set('repeat', state.repeat);
  syncModes();
  toast({ off: 'repeat off', all: 'repeating your queue', one: 'repeating this song' }[state.repeat]);
};
function syncModes() {
  if (typeof pushOverlay === 'function') setTimeout(pushOverlay);
  el.shuffle.setAttribute('aria-pressed', String(state.shuffle));
  el.repeat.setAttribute('aria-pressed', String(state.repeat !== 'off'));
  el.repeat.setAttribute('aria-label', 'repeat: ' + state.repeat);
  el.repeatIcon.setAttribute('href', state.repeat === 'one' ? '#i-repeat-one' : '#i-repeat');
}

/* media keys / lock screen */
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch { /* unsupported */ } };
  set('play', play);
  set('pause', pause);
  set('nexttrack', () => next());
  set('previoustrack', prev);
  set('seekto', d => { audio.currentTime = d.seekTime; });
  set('seekbackward', d => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10)); });
  set('seekforward', d => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (d.seekOffset || 10)); });
}

/* keyboard */
document.addEventListener('keydown', e => {
  if (e.target.closest('input[type="search"], input[type="text"], textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (!$('#closeAsk').hidden) return; // the close popup has the keyboard
  const k = e.key.toLowerCase();
  const onRange = e.target.matches('input[type="range"]');
  if (k === ' ' || k === 'k') { e.preventDefault(); togglePlay(); }
  else if (k === 'arrowright' && !onRange) { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5); }
  else if (k === 'arrowleft' && !onRange) { audio.currentTime = Math.max(0, audio.currentTime - 5); }
  else if (k === 'arrowup' && !onRange) { e.preventDefault(); setVolume(audio.volume + 0.05); }
  else if (k === 'arrowdown' && !onRange) { e.preventDefault(); setVolume(audio.volume - 0.05); }
  else if (k === 'n') next();
  else if (k === 'p') prev();
  else if (k === 'l') toggleFav();
  else if (k === 's') el.shuffle.click();
  else if (k === 'r') el.repeat.click();
  else if (k === 'm') el.mute.click();
  else if (k === 'escape') { setSettings(false); setDownloads(false); setLibrary(false); }
});

/* ───────────── files in ───────────── */
$('#addBtn').onclick = () => el.file.click();
// a whole folder (and the folders inside it); songs already in the library are skipped
$('#addFolderBtn').onclick = () => $('#folderInput').click();
$('#folderInput').onchange = () => {
  const input = $('#folderInput');
  const files = [...input.files].filter(f => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name));
  input.value = '';
  if (!files.length) { toast('no songs in that folder'); return; }
  const fresh = files.filter(f => !state.tracks.some(t => t.file && t.file.name === f.name && t.file.size === f.size));
  const had = files.length - fresh.length;
  if (!fresh.length) { toast(`all ${files.length} songs in that folder are already in your library ✦`); return; }
  if (had) toast(`${had} already in your library, adding the other ${fresh.length}…`, 3000);
  addFiles(fresh);
};
el.file.onchange = () => { addFiles(el.file.files); el.file.value = ''; };

let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; el.drop.classList.add('show'); });
// desktop app: a link dragged in from the browser goes to the downloader
const hasLink = e => !!desktop && !hasFiles(e) && [...(e.dataTransfer?.types || [])].includes('text/uri-list');
window.addEventListener('dragover', e => { if (hasFiles(e) || hasLink(e)) e.preventDefault(); });
window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; el.drop.classList.remove('show'); } });
window.addEventListener('drop', e => {
  if (hasLink(e)) {
    e.preventDefault();
    const url = e.dataTransfer.getData('text/uri-list').split(/\r?\n/).find(l => l && !l.startsWith('#'));
    if (url && setDownloads.submit) setDownloads.submit(url);
    return;
  }
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  el.drop.classList.remove('show');
  addFiles(e.dataTransfer.files);
});

/* mobile library sheet */
function setLibrary(open) {
  el.library.classList.toggle('open', open);
  el.scrim.classList.toggle('show', open);
}
// In the big layout the library sits beside the record; it can be closed there too
// (remembered), and the list button brings it back.
const narrow = () => matchMedia('(max-width: 900px)').matches;
function setLibraryShown(shown) {
  document.body.classList.toggle('lib-hidden', !shown);
  prefs.set('libHidden', !shown);
  $('#libToggle').setAttribute('aria-pressed', String(shown));
  $('#libToggle').setAttribute('aria-label', shown ? 'close the library' : 'open the library');
}
setLibraryShown(!prefs.get('libHidden', false));
$('#libToggle').onclick = () => {
  if (narrow()) setLibrary(!el.library.classList.contains('open'));
  else setLibraryShown(document.body.classList.contains('lib-hidden'));
};
$('#libClose').onclick = () => (narrow() ? setLibrary(false) : setLibraryShown(false));
el.scrim.onclick = () => setLibrary(false);

window.addEventListener('pagehide', () => saveProgress(true));

/* ───────────── OBS: now playing → .txt file ─────────────
   OBS can't read from a web page, but its Text source can "read from file".
   With the File System Access API (Chrome / Edge) we keep one .txt file you
   choose up to date with the current song. */
const obs = { handle: null, granted: false, asked: false };
let obsTimer = null, obsChain = Promise.resolve();

// the song as one line, in the format picked under "obs · now playing"
function formatSong(t) {
  if (!t) return '';
  let s = prefs.get('obsFormat', '{artist} - {title}');
  if (s === 'custom') s = prefs.get('obsCustom', '') || '{artist} - {title}';
  if (!t.artist) s = s.replace(/\s*[-—]\s*\{artist\}|\{artist\}\s*[-—]\s*|\s+by\s+\{artist\}/g, '');
  if (!t.album) s = s.replace(/\s*[-—·|(\[]?\s*\{album\}\s*[)\]]?/g, '');
  return s.replace(/\{title\}/g, () => t.title).replace(/\{artist\}/g, () => t.artist || '').replace(/\{album\}/g, () => t.album || '').trim();
}

/* What's "on air" for the overlay, nowplaying.txt and !song: moonlit's song, or Spotify's
   (desktop app, Spotify connected) while Spotify is the one playing. If both play, or
   neither, the one started most recently wins. */
let spotifyNow = null;
const lastStart = { moonlit: 0, spotify: 0 };
audio.addEventListener('play', () => { lastStart.moonlit = Date.now(); });
function onAir() {
  const m = byId(state.currentId), sp = spotifyNow;
  if (!sp) return m ? { source: 'moonlit', song: m, playing: !audio.paused } : null;
  const spotifyWins = !m || (sp.playing !== !audio.paused ? sp.playing : lastStart.spotify > lastStart.moonlit);
  return spotifyWins ? { source: 'spotify', song: sp, playing: sp.playing } : { source: 'moonlit', song: m, playing: !audio.paused };
}
// called with each update from Spotify (null: nothing there, or not connected)
function setSpotifyNow(sp) {
  const was = spotifyNow;
  if (sp && sp.playing && (!was || !was.playing || was.id !== sp.id)) lastStart.spotify = Date.now();
  spotifyNow = sp;
  const changed = !was !== !sp || (was && sp && (was.id !== sp.id || was.playing !== sp.playing));
  if (changed) queueObsWrite();
  pushOverlay();
}

function obsText() {
  const now = onAir();
  if (!now || (prefs.get('obsPause', false) && !now.playing)) return '';
  return formatSong(now.song) + (prefs.get('obsPad', false) ? '        ' : '');
}

function queueObsWrite() {
  if (!obs.handle || !obs.granted) return;
  clearTimeout(obsTimer);
  obsTimer = setTimeout(() => { obsChain = obsChain.then(writeObs); }, 150);
}

async function writeObs() {
  if (!obs.handle) return;
  if (desktop) {
    obs.granted = await desktop.writeNowPlaying(obsText()).catch(() => false);
    syncObsUi();
    return;
  }
  try {
    if ((await obs.handle.queryPermission({ mode: 'readwrite' })) !== 'granted') { obs.granted = false; return; }
    const w = await obs.handle.createWritable();
    await w.write(obsText());
    await w.close();
  } catch {
    obs.granted = false;
  } finally {
    syncObsUi();
  }
}

async function linkObs() {
  if (desktop) {
    const file = await desktop.chooseNowPlayingFile().catch(() => null);
    if (!file) return;
    obs.handle = file;
    obs.granted = true;
    syncObsUi();
    queueObsWrite();
    toast(`linked! now point OBS at ${file.name}`);
    return;
  }
  if (obs.handle && !obs.granted) {
    try { obs.granted = (await obs.handle.requestPermission({ mode: 'readwrite' })) === 'granted'; } catch { /* dismissed */ }
    syncObsUi();
    if (obs.granted) { queueObsWrite(); toast('obs file reconnected ♡'); }
    return;
  }
  if (!window.showSaveFilePicker) { toast('the OBS link needs chrome or edge on a computer'); return; }
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: 'nowplaying.txt',
      types: [{ description: 'Text file', accept: { 'text/plain': ['.txt'] } }],
    });
    obs.handle = handle;
    obs.granted = true;
    DB.setKV('obsHandle', handle).catch(() => {});
    syncObsUi();
    queueObsWrite();
    toast(`linked! now point OBS at ${handle.name}`);
  } catch (e) {
    if (e.name !== 'AbortError') toast("couldn't link that file");
  }
}

function unlinkObs() {
  if (desktop) desktop.unlinkNowPlaying().catch(() => {});
  obs.handle = null;
  obs.granted = false;
  DB.setKV('obsHandle', undefined).catch(() => {});
  syncObsUi();
}

// Browsers forget file permission between visits; ask again on your first play.
function maybeReconnectObs() {
  if (desktop || !obs.handle || obs.granted || obs.asked || !navigator.userActivation?.isActive) return;
  obs.asked = true;
  obs.handle.requestPermission({ mode: 'readwrite' })
    .then(p => { obs.granted = p === 'granted'; syncObsUi(); queueObsWrite(); })
    .catch(() => {});
}

function syncObsUi() {
  const linked = !!obs.handle;
  el.obsStatus.textContent = !linked ? 'not linked'
    : obs.granted ? `writing to ${obs.handle.name}`
    : desktop ? `can't write to ${obs.handle.name}, try picking it again` : `${obs.handle.name} · tap reconnect`;
  el.obsStatus.classList.toggle('ok', linked && obs.granted);
  el.obsLinkText.textContent = !linked ? 'link nowplaying.txt' : obs.granted || desktop ? 'pick another file' : 'reconnect';
  el.obsUnlink.hidden = !linked;
  el.obsLive.hidden = !(linked && obs.granted);
}

el.obsLink.onclick = linkObs;
el.obsUnlink.onclick = unlinkObs;
el.obsFormat.onchange = () => {
  prefs.set('obsFormat', el.obsFormat.value);
  $('#obsCustomField').hidden = el.obsFormat.value !== 'custom';
  if (el.obsFormat.value === 'custom') $('#obsCustom').focus();
  queueObsWrite(); pushOverlay();
};
$('#obsCustom').addEventListener('input', () => { prefs.set('obsCustom', $('#obsCustom').value); queueObsWrite(); pushOverlay(); });
el.obsPause.onchange = () => { prefs.set('obsPause', el.obsPause.checked); queueObsWrite(); };
el.obsPad.onchange = () => { prefs.set('obsPad', el.obsPad.checked); queueObsWrite(); };

async function restoreObs() {
  el.obsFormat.value = prefs.get('obsFormat', '{artist} - {title}');
  if (!el.obsFormat.value) el.obsFormat.value = '{artist} - {title}'; // a format from an older version
  $('#obsCustom').value = prefs.get('obsCustom', '');
  $('#obsCustomField').hidden = el.obsFormat.value !== 'custom';
  el.obsPause.checked = prefs.get('obsPause', false);
  el.obsPad.checked = prefs.get('obsPad', false);
  if (desktop) {
    const file = await desktop.getNowPlayingFile().catch(() => null);
    if (file) { obs.handle = file; obs.granted = true; queueObsWrite(); }
    syncObsUi();
    return;
  }
  try {
    const handle = await DB.getKV('obsHandle');
    if (handle) {
      obs.handle = handle;
      obs.granted = (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
    }
  } catch { /* no saved file */ }
  syncObsUi();
}

/* ───────────── sound output (e.g. a virtual cable for OBS) ───────────── */
const sinkSupported = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
const outSel = $('#outputSelect');

async function applySink(id) {
  try {
    // Once music has played, sound runs through the visualizer's AudioContext and
    // that decides the output; the <audio> element then refuses setSinkId (AbortError).
    const ctx = viz.getCtx();
    if (ctx) await ctx.setSinkId(id);
    else if (audio.setSinkId) await audio.setSinkId(id);
    return true;
  } catch { return false; }
}

// Device ids can change (browser updates, cleared data), so we also remember
// the device's name and find it again by name if its id is gone.
async function resolveSink() {
  const id = prefs.get('sinkId', '');
  if (!id) return '';
  try {
    const outs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput');
    if (outs.some(d => d.deviceId === id)) return id;
    const label = prefs.get('sinkLabel', '');
    const match = label && outs.find(d => d.label === label);
    if (match) { prefs.set('sinkId', match.deviceId); return match.deviceId; }
  } catch { /* no device access */ }
  return id;
}

async function listOutputs(askForNames = false) {
  if (askForNames) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach(t => t.stop());
    } catch { toast("no problem. without that, chrome won't show device names", 5000); }
  }
  let devs = [];
  try {
    devs = (await navigator.mediaDevices.enumerateDevices())
      .filter(d => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  } catch { /* no device access */ }
  const saved = await resolveSink();
  outSel.innerHTML = '';
  outSel.append(new Option('system default', ''));
  devs.forEach((d, i) => outSel.append(new Option(d.label || `sound output ${i + 1}`, d.deviceId)));
  if (saved && !devs.some(d => d.deviceId === saved)) {
    outSel.append(new Option(`${prefs.get('sinkLabel', '') || 'your saved device'} (not connected)`, saved));
  }
  outSel.value = saved;
  const named = devs.length > 0 && devs.every(d => d.label);
  $('#outputScan').hidden = named;
  $('#outputNote').hidden = named;
}

outSel.onchange = async () => {
  const id = outSel.value;
  const label = outSel.selectedOptions[0]?.textContent || 'that device';
  if (await applySink(id)) {
    prefs.set('sinkId', id);
    prefs.set('sinkLabel', id && !/^sound output \d+$/.test(label) ? label.replace(/ \(not connected\)$/, '') : '');
    toast(id ? `music now plays through ${label}` : 'music is back on the default device');
  } else {
    toast("couldn't switch to that device. is it plugged in?", 5000);
    outSel.value = prefs.get('sinkId', '');
  }
};
$('#outputScan').onclick = () => listOutputs(true);
if (sinkSupported && navigator.mediaDevices) {
  navigator.mediaDevices.addEventListener?.('devicechange', () => listOutputs());
}

/* ───────────── desktop app extras ───────────── */
async function setupDesktop() {
  $('#desktopSection').hidden = false;
  const login = $('#openAtLogin'), resume = $('#autoResume');
  login.checked = await desktop.getOpenAtLogin().catch(() => false);
  resume.checked = prefs.get('autoResume', false);
  login.onchange = async () => {
    login.checked = await desktop.setOpenAtLogin(login.checked).catch(() => false);
    toast(login.checked ? 'moonlit will open when your PC starts' : "moonlit won't open by itself any more");
  };
  resume.onchange = () => prefs.set('autoResume', resume.checked);
  if (desktop.tray) setupTray();
  if (desktop.onCloseRequest) setupCloseAsk();
  // minimised or hidden in the tray: pause the animations and the ring (the music, the OBS
  // overlay and its bars carry on)
  desktop.onVisible?.(on => document.body.classList.toggle('asleep', !on));
  const v = $('.version');
  v.textContent += ` · desktop ${await desktop.version().catch(() => '')}`.trimEnd();
}

// "Do you want to close the program, <your name>?" when moonlit is closed (desktop app)
// The "Do you want to close the program, <name>?" popup. Used by the desktop app's close
// button and tray quit, and by the Back button on phones. done(yes) gets the answer.
let closeAskDone = null;
function askToClose(done) {
  const name = prefs.get('name', '').trim();
  $('#closeAskTitle').textContent = name ? `Do you want to close the program, ${name}?` : 'Do you want to close the program?';
  $('#closeAskSub').textContent = !audio.paused ? 'the music will stop.' : '';
  $('#closeDontAsk').checked = false;
  $('#closeAsk').hidden = false;
  closeAskDone = done;
  $('#closeYes').focus();
}
function answerCloseAsk(yes) {
  if (!closeAskDone) return;
  const done = closeAskDone;
  closeAskDone = null;
  $('#closeAsk').hidden = true;
  if ($('#closeDontAsk').checked) setAskClose(false);
  if (yes) saveProgress(true);
  done(yes);
}
// "ask before closing moonlit": one setting, shown in the desktop app section (desktop) or the app section (phones)
function setAskClose(on) {
  prefs.set('askClose', on);
  for (const id of ['#askClose', '#askCloseWeb']) { const c = $(id); if (c) c.checked = on; }
}
$('#closeYes').onclick = () => answerCloseAsk(true);
$('#closeNo').onclick = () => answerCloseAsk(false);
$('#closeAsk').onclick = e => { if (e.target === $('#closeAsk')) answerCloseAsk(false); }; // tapping outside keeps it open
$('#closeAsk').onkeydown = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); answerCloseAsk(false); } };
for (const id of ['#askClose', '#askCloseWeb']) {
  const c = $(id);
  if (c) { c.checked = prefs.get('askClose', true); c.onchange = () => setAskClose(c.checked); }
}

// desktop app: the window's close button and the tray's quit
function setupCloseAsk() {
  desktop.onCloseRequest(() => {
    if (!prefs.get('askClose', true)) { saveProgress(true); desktop.answerClose(true); return; }
    askToClose(yes => desktop.answerClose(yes));
  });
}

// Phones (and the installed app on them): Back closes whatever is open first (settings,
// library, downloads), and otherwise asks before leaving moonlit. Browsers only let a page
// catch Back after you've tapped it once, so the catch is set on the first tap.
function setupBackAsk() {
  if (desktop) return;
  const phoneLike = matchMedia('(display-mode: standalone)').matches || matchMedia('(pointer: coarse)').matches;
  if (!phoneLike) return;
  $('#askCloseWebRow').hidden = false;
  let armed = false, leaving = false;
  const arm = () => {
    if (armed || leaving) return;
    history.pushState({ moonlit: 'back' }, '');
    armed = true;
  };
  addEventListener('pointerdown', arm, true);
  addEventListener('popstate', () => {
    if (!armed || leaving) return;
    armed = false; // Back used up the catch
    if (closeAskDone) { answerCloseAsk(false); arm(); return; } // Back while asking = "No"
    const settingsOpen = !$('#settings').hidden, dlOpen = $('#downloads') && !$('#downloads').hidden;
    if (settingsOpen || dlOpen || el.library.classList.contains('open')) {
      setSettings(false); setDownloads(false); setLibrary(false);
      arm();
      return;
    }
    const leave = () => {
      leaving = true;
      audio.pause();
      saveProgress(true);
      // an installed app closes; a tab goes back to where you came from; if neither is
      // possible, the next Back leaves as usual (nothing catches it any more)
      window.close();
      setTimeout(() => { if (!document.hidden) history.go(armed ? -2 : -1); }, 150);
      setTimeout(() => { if (!document.hidden) toast('press back once more to leave'); }, 600);
    };
    if (!prefs.get('askClose', true)) { leave(); return; }
    arm(); // so Back pressed again while the popup is up counts as "No"
    askToClose(yes => { if (yes) leave(); else arm(); });
  });
}

// the tray icon (moonlit hidden from the taskbar) and the "now playing" Windows notification
async function setupTray() {
  const T = desktop.tray, on = $('#trayOn'), notify = $('#notifyOn'), always = $('#notifyAlways');
  const show = st => { on.checked = st.tray; notify.checked = st.notify; always.checked = st.notifyAlways; always.disabled = !st.notify; };
  show(await T.get());
  on.onchange = async () => { show(await T.set({ tray: on.checked })); toast(on.checked ? 'closing moonlit now hides it by the clock ✦' : 'moonlit is back in the taskbar'); };
  notify.onchange = async () => show(await T.set({ notify: notify.checked }));
  always.onchange = async () => show(await T.set({ notifyAlways: always.checked }));
  // play/pause, next and previous from the tray menu
  T.onCommand(cmd => { if (cmd === 'toggle') togglePlay(); else if (cmd === 'next') next(); else if (cmd === 'prev') prev(); });
  // tell the tray (and the notification) about each new song, once it really starts playing
  let told = null;
  audio.addEventListener('playing', async () => {
    T.playing(true);
    const t = byId(state.currentId);
    if (!t || told === t.id) return;
    told = t.id;
    const cover = t.cover ? await t.cover.arrayBuffer().catch(() => null) : null;
    T.nowPlaying({ id: t.id, title: t.title, artist: t.artist || '', album: t.album || '', cover });
  });
  audio.addEventListener('pause', () => T.playing(false));
}

/* ───────────── songs opened from Windows (desktop app as default player) ───────────── */
const MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm', weba: 'audio/webm', aif: 'audio/aiff', aiff: 'audio/aiff' };
const sameFile = (t, f) => t.file && t.file.name === f.name && t.file.size === f.size;

// Double-clicking a song plays it. It's added to your library the first time;
// opening the same song again just plays the copy you already have.
async function openExternalFiles(paths, { play = true, quiet = false, replace = false } = {}) {
  const files = [];
  for (const p of paths) {
    const r = await desktop.readFile(p).catch(() => null);
    if (!r) continue;
    const ext = r.name.split('.').pop().toLowerCase();
    files.push(new File([r.data], r.name, { type: MIME[ext] || 'audio/mpeg', lastModified: r.lastModified }));
  }
  if (!files.length) { if (!quiet) toast("couldn't open that file"); return 0; }
  while (importing) await new Promise(r => setTimeout(r, 300));
  // a song downloaded again (e.g. after a wrong match) replaces the old copy instead of doubling up
  let replaced = 0;
  if (replace) {
    for (const f of files) {
      const t = state.tracks.find(x => x.file && x.file.name === f.name && x.file.size !== f.size);
      if (!t) continue;
      const tags = await readTags(f);
      if (coverUrls.has(t.id)) { URL.revokeObjectURL(coverUrls.get(t.id)); coverUrls.delete(t.id); }
      Object.assign(t, { file: f, duration: 0, cover: tags.cover || null, title: tags.title || t.title, artist: tidyArtist(tags.artist || t.artist), album: tags.album || t.album });
      durationTried.delete(t.id);
      if (state.persistent) DB.put(t).catch(() => {});
      replaced++;
    }
    if (replaced) { renderList(); fillDurations(); }
  }
  openExternalFiles.replaced = replaced;
  const fresh = files.filter(f => !state.tracks.some(t => sameFile(t, f)));
  if (fresh.length) await addFiles(fresh, { quiet });
  const ids = files.map(f => state.tracks.find(t => sameFile(t, f))?.id).filter(Boolean);
  openExternalFiles.ids = ids;
  if (!ids.length || !play) return fresh.length;
  // several songs: play just those; one song: play it, then carry on through your library
  state.queue = ids.length > 1 ? ids : state.tracks.map(t => t.id);
  state.history = [];
  await playTrack(ids[0]);
  return fresh.length;
}

/* ───────────── now-playing overlay for OBS (desktop app) ───────────── */
let overlayCoverFor = null;
let overlayNextCoverFor = null;
// The theme's colours for the OBS overlay card (when "match moonlit's theme" is on)
function themePalette() {
  if (overlayPalette) return overlayPalette;
  const cs = getComputedStyle(document.body), v = n => cs.getPropertyValue(`--${n}`).trim();
  const rgb = hex => { const m = /^#?([0-9a-f]{6})$/i.exec(hex); if (!m) return null; const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
  const a = (hex, alpha) => { const c = rgb(hex); return c ? `rgba(${c.join(', ')}, ${alpha})` : hex; };
  const light = v('scheme') === 'light';
  overlayPalette = {
    accent: v('accent'), accent2: v('accent2'), ink: v('ink'), muted: v('muted'),
    card1: a(v('bg2'), light ? 0.92 : 0.88), card2: a(v('bg'), light ? 0.92 : 0.88), pill: a(v('bg'), 0.85),
    edge: v('glass-line'), divider: v('glass-line'), track: light ? 'rgba(0, 0, 0, .1)' : 'rgba(255, 255, 255, .14)',
  };
  return overlayPalette;
}
function pushOverlay() {
  if (!desktop || !desktop.overlay) return;
  const now = onAir(), spectrum = prefs.get('overlaySpectrum', true), look = vizOpts();
  const theme = prefs.get('overlayTheme', false) ? themePalette() : null;
  if (!now) desktop.overlay.state({ spectrum, viz: look, theme });
  else if (now.source === 'spotify') {
    const sp = now.song;
    desktop.overlay.state({
      id: sp.id, title: sp.title, artist: sp.artist, album: sp.album, line: formatSong(sp),
      duration: sp.duration, position: sp.position + (sp.playing ? (Date.now() - sp.at) / 1000 : 0),
      playing: sp.playing, spectrum, viz: look, theme, source: 'spotify',
    });
  } else {
    const t = now.song;
    const up = upNext(), nt = up && up.id !== t.id ? byId(up.id) : null;
    // "up next" for the overlay: shown during the last few seconds of the song
    const coming = nt && prefs.get('overlayUpNext', true) ? {
      id: nt.id, title: nt.title, artist: nt.artist || '', line: formatSong(nt), duration: nt.duration || 0, by: up.by || '',
      seconds: prefs.get('overlayUpNextSecs', 10),
    } : null;
    // its cover goes over early, ready for when "up next" shows
    if (coming && overlayNextCoverFor !== nt.id) {
      overlayNextCoverFor = nt.id;
      (nt.cover ? nt.cover.arrayBuffer().catch(() => null) : Promise.resolve(null))
        .then(bytes => { if (bytes) desktop.overlay.cover(nt.id, nt.cover.type, bytes); });
    }
    desktop.overlay.state({
      next: coming,
      id: t.id, title: t.title, artist: t.artist || '', album: t.album || '', line: formatSong(t),
      duration: Number.isFinite(audio.duration) ? audio.duration : (t.duration || 0),
      position: audio.currentTime || 0, playing: !audio.paused, spectrum, viz: look, theme, source: 'moonlit',
    });
  }
  feedSpectrum();
}

// The overlay's music bars: sampled ~30 times a second, but only while an overlay is open
// in OBS (or a browser), the bars are switched on, and music is playing.

let overlayWatchers = 0, spectrumTimer = 0;
function feedSpectrum() {
  if (!desktop || !desktop.overlay) return;
  // (the visualizer source in OBS needs them even when the card's bars are switched off)
  const want = overlayWatchers > 0 && !audio.paused && onAir()?.source === 'moonlit';
  if (want && !spectrumTimer) {
    spectrumTimer = setInterval(() => {
      const o = viz.opts(), levels = viz.sample(o.bars, o.stereo);
      if (levels) desktop.overlay.spectrum(levels);
    }, 33);
  } else if (!want && spectrumTimer) {
    clearInterval(spectrumTimer);
    spectrumTimer = 0;
  }
}
// the cover goes over first, so it's ready when the overlay asks for it
async function overlayTrack() {
  if (!desktop || !desktop.overlay) return;
  const t = byId(state.currentId);
  if (t && overlayCoverFor !== t.id) {
    overlayCoverFor = t.id;
    const bytes = t.cover ? await t.cover.arrayBuffer().catch(() => null) : null;
    desktop.overlay.cover(t.id, t.cover ? t.cover.type : '', bytes);
  }
  pushOverlay();
}

async function setupOverlay() {
  if (!desktop.overlay) return;
  ['play', 'pause', 'seeked', 'loadedmetadata', 'durationchange'].forEach(ev => audio.addEventListener(ev, pushOverlay));
  setInterval(() => { if (!audio.paused) pushOverlay(); }, 15000); // keep the clock in step
  const base = await desktop.overlay.url().catch(() => null);
  if (!base) return;
  $('#overlayBox').hidden = false;
  $('#obsTxtHint').innerHTML = 'or keep a <b>.txt</b> file updated with the song name, for an OBS <b>Text</b> source:';
  const layout = $('#overlayLayout'), hide = $('#overlayHide'), input = $('#overlayUrl'), bars = $('#overlaySpectrum');
  layout.value = prefs.get('overlayLayout', 'card');
  hide.checked = prefs.get('overlayHide', false);
  // the bars switch on and off live, without changing the address in OBS
  // the same switch lives in two places: here and at the top of "visualizer"
  const vizOn = $('#vizOnOverlay');
  $('#vizOverlayRow').hidden = false;
  bars.checked = vizOn.checked = prefs.get('overlaySpectrum', true);
  const setBars = on => {
    prefs.set('overlaySpectrum', on);
    bars.checked = vizOn.checked = on;
    pushOverlay();
    toast(on ? 'visualizer on the overlay ✦' : 'visualizer hidden on the overlay');
  };
  bars.onchange = () => setBars(bars.checked);
  // the overlay card in moonlit's own theme colours, changing with it
  const themed = $('#overlayTheme');
  themed.checked = prefs.get('overlayTheme', false);
  themed.onchange = () => { prefs.set('overlayTheme', themed.checked); pushOverlay(); toast(themed.checked ? 'the overlay follows your theme ✦' : 'the overlay is back to its own pink'); };
  vizOn.onchange = () => setBars(vizOn.checked);
  // "up next" in the last seconds of a song (live, no address change)
  const upOn = $('#overlayUpNext'), upSecs = $('#overlayUpNextSecs');
  upOn.checked = prefs.get('overlayUpNext', true);
  upSecs.value = String(prefs.get('overlayUpNextSecs', 10));
  upSecs.disabled = !upOn.checked;
  upOn.onchange = () => { prefs.set('overlayUpNext', upOn.checked); upSecs.disabled = !upOn.checked; pushOverlay(); };
  upSecs.onchange = () => { prefs.set('overlayUpNextSecs', +upSecs.value); pushOverlay(); };
  document.addEventListener('moonlit:requests', () => pushOverlay());
  desktop.overlay.onWatchers(n => { overlayWatchers = n; feedSpectrum(); });
  const url = () => {
    const p = new URLSearchParams();
    if (layout.value === 'line') p.set('layout', 'line');
    if (hide.checked) p.set('hidepaused', '1');
    return base + (p.toString() ? `?${p}` : '');
  };
  const show = () => { input.value = url(); };
  layout.onchange = () => { prefs.set('overlayLayout', layout.value); show(); };
  hide.onchange = () => { prefs.set('overlayHide', hide.checked); show(); };
  $('#overlayCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand('copy'); }
    toast('overlay address copied ✦ paste it into an OBS Browser source');
  };
  $('#overlayPreview').onclick = () => desktop.overlay.open(input.value);
  show();
  overlayTrack();
}

/* ───────────── downloader (desktop app) ───────────── */
function setDownloads(open) {
  const panel = $('#downloads');
  if (!panel || (open && !desktop)) return;
  if (open) setSettings(false);
  panel.hidden = !open;
  $('#dlBtn').setAttribute('aria-expanded', String(open));
  if (open) setTimeout(() => $('#dlUrl').focus(), 50);
}

function setupDownloader() {
  const D = desktop.download;
  const list = $('#dlList'), rows = new Map(), jobs = new Map();
  const imported = new Set();
  let toImport = [], importTimer = null;
  $('#dlBtn').hidden = false;
  $('#dlBtn').onclick = e => { e.stopPropagation(); setDownloads($('#downloads').hidden); };
  $('#dlClose').onclick = () => setDownloads(false);

  // file type
  const setFormat = f => {
    prefs.set('dlFormat', f);
    document.querySelectorAll('#dlFormat button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.format === f)));
  };
  document.querySelectorAll('#dlFormat button').forEach(b => b.onclick = () => setFormat(b.dataset.format));
  setFormat(prefs.get('dlFormat', 'm4a'));

  const addLib = $('#dlAddLib');
  addLib.checked = prefs.get('dlAddLib', true);
  addLib.onchange = () => prefs.set('dlAddLib', addLib.checked);

  // the label is right-aligned so long paths show their end; the marks keep slashes in place
  const showFolder = dir => { $('#dlFolder').textContent = `\u200e${dir}\u200e`; $('#dlFolder').title = dir; };
  D.folder().then(showFolder);
  $('#dlChange').onclick = () => D.chooseFolder().then(showFolder);
  $('#dlOpen').onclick = () => D.openFolder();
  $('#dlClear').onclick = () => D.clearFinished();
  $('#dlStopAll').onclick = () => {
    const n = [...jobs.values()].filter(j => !['done', 'error'].includes(j.status)).length;
    if (n && confirm(`stop all ${n} downloads that haven't finished?`)) D.cancelAll();
  };

  async function submit(url, { askPlaylist = true } = {}) {
    url = String(url || '').trim();
    if (!url) return;
    // a song opened from inside a playlist: ask whether to get the song or the whole list
    // (YouTube "Mix" lists, which start with RD, are endless auto-mixes, so those stay one song)
    const list = (url.match(/[?&]list=([\w-]+)/) || [])[1];
    if (askPlaylist && list && /[?&]v=/.test(url) && !/^RD/.test(list)) {
      const choice = $('#dlChoice');
      choice.hidden = false;
      choice.querySelector('[data-pick="song"]').onclick = () => { choice.hidden = true; submit(url, { askPlaylist: false }); };
      choice.querySelector('[data-pick="list"]').onclick = () => {
        choice.hidden = true;
        const host = /music\.youtube\.com/i.test(url) ? 'music.youtube.com' : 'www.youtube.com';
        submit(`https://${host}/playlist?list=${list}`, { askPlaylist: false });
      };
      return;
    }
    const res = await D.add(url, prefs.get('dlFormat', 'm4a'));
    if (!res.ok) { toast(res.error, 5000); return; }
    const parts = [];
    if (res.count > 1) parts.push(`${res.count} songs added to the queue ✦`);
    if (res.skipped) parts.push(`skipped ${res.skipped} deleted or private video${res.skipped === 1 ? '' : 's'}`);
    if (parts.length) toast(parts.join(' · '), 5000);
  }
  $('#dlForm').onsubmit = e => { e.preventDefault(); const input = $('#dlUrl'); submit(input.value); input.value = ''; };
  // a whole playlist saved as a .csv file (exportify.net): every song, no 100-song limit
  const fileInput = $('#dlFile');
  $('#dlFileBtn').onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    const res = await D.addList(await file.text(), prefs.get('dlFormat', 'm4a'));
    if (!res.ok) { toast(res.error, 5000); return; }
    toast(`${res.count} songs from “${file.name.replace(/\.csv$/i, '')}” added to the queue ✦ songs you already have are skipped`, 6000);
  };
  setDownloads.submit = url => { setDownloads(true); submit(url); };

  // finished songs go into the library in small batches, quietly
  function queueImport(file) {
    toImport.push(file);
    clearTimeout(importTimer);
    importTimer = setTimeout(async () => {
      const batch = toImport; toImport = [];
      const n = await openExternalFiles(batch, { play: false, quiet: true, replace: true });
      const r = openExternalFiles.replaced || 0;
      const parts = [];
      if (n) parts.push(`${n} downloaded song${n === 1 ? '' : 's'} added to your library ✦`);
      if (r) parts.push(`${r} song${r === 1 ? '' : 's'} replaced with the new download`);
      if (parts.length) toast(parts.join(' · '), 4000);
    }, 1200);
  }

  const statusText = j => ({
    reading: 'reading the link…',
    queued: j.note || 'waiting…',
    waiting: j.note || 'trying again soon…',
    finding: 'finding it on YouTube…',
    downloading: [`${Math.round(j.progress || 0)}%`, j.speed, j.eta && `${j.eta} left`].filter(Boolean).join(' · '),
    converting: 'finishing up…',
    done: (addLib.checked ? 'saved ✦ in your library' : 'saved ✦') + (j.matched ? ` · from “${j.matched}”` : ''),
    error: j.error || 'something went wrong',
  })[j.status] || j.status;

  function render(job) {
    jobs.set(job.id, job);
    let li = rows.get(job.id);
    if (!li) {
      li = document.createElement('li');
      li.className = 'dl-item';
      li.innerHTML = `<div class="t"></div><div class="s"></div>
        <div class="acts">
          <button class="icon-btn retry" aria-label="try again" hidden><svg><use href="#i-retry"/></svg></button>
          <button class="icon-btn cancel" aria-label="remove"><svg><use href="#i-x"/></svg></button>
        </div>
        <div class="bar"><i></i></div>`;
      li.querySelector('.cancel').onclick = () => D.cancel(job.id);
      li.querySelector('.retry').onclick = () => D.retry(job.id);
      rows.set(job.id, li);
      list.append(li);
    }
    li.dataset.status = job.status;
    li.querySelector('.t').textContent = job.title + (job.artist && job.status !== 'reading' ? ` · ${job.artist}` : '');
    li.querySelector('.s').textContent = statusText(job);
    li.querySelector('.bar i').style.width = `${job.status === 'downloading' ? job.progress : 0}%`;
    li.querySelector('.retry').hidden = job.status !== 'error';
    li.querySelector('.cancel').setAttribute('aria-label', ['done', 'error'].includes(job.status) ? 'remove from list' : 'cancel');
    if (job.status === 'done' && job.file && !imported.has(job.id)) {
      imported.add(job.id);
      if (addLib.checked) queueImport(job.file);
    }
    summary();
  }

  function summary() {
    const all = [...jobs.values()];
    const active = all.filter(j => !['done', 'error'].includes(j.status)).length;
    const done = all.filter(j => j.status === 'done').length;
    const failed = all.filter(j => j.status === 'error').length;
    $('#dlEmpty').hidden = all.length > 0;
    $('#dlFoot').hidden = all.length === 0;
    $('#dlSummary').textContent = [active && `${active} to go`, done && `${done} done`, failed && `${failed} failed`].filter(Boolean).join(' · ');
    $('#dlStopAll').hidden = !active;
    $('#dlClear').hidden = !(done + failed);
    $('#dlBadge').hidden = !active;
    $('#dlBadge').textContent = active;
  }

  D.onUpdate(render);
  D.onRemove(id => { rows.get(id)?.remove(); rows.delete(id); jobs.delete(id); summary(); });
  D.onStatus(text => { $('#dlStatus').textContent = text; $('#dlStatus').hidden = !text; });
  D.list().then(js => js.forEach(render));
  summary();
}

/* ───────────── install as an app ───────────── */
let installPrompt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function syncInstallUi() {
  const btn = $('#installBtn'), hint = $('#appHint');
  if (desktop) {
    hint.textContent = "you're using the desktop app ♡";
    btn.hidden = true;
    return;
  }
  if (isStandalone()) {
    hint.textContent = "you're using the app version ♡";
    btn.hidden = true;
    return;
  }
  btn.hidden = !installPrompt;
  if (installPrompt) hint.textContent = 'add moonlit to your home screen so it opens like a real app, full screen and even offline.';
  else if (isIOS) hint.innerHTML = 'on iPhone / iPad: open this page in <b>Safari</b>, tap <b>Share</b> → <b>Add to Home Screen</b>.';
  else hint.innerHTML = 'open your browser menu (⋮) and choose <b>Install app</b> or <b>Add to Home screen</b>.';
}
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; syncInstallUi(); });
window.addEventListener('appinstalled', () => { installPrompt = null; toast('moonlit is on your home screen ♡'); syncInstallUi(); });
$('#installBtn').onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  syncInstallUi();
};

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  const hadWorker = !!navigator.serviceWorker.controller;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(reg => {
      // look for updates whenever the app comes back to the front
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
    }).catch(() => {});
  });
  // A new version took over: reload into it, but never cut off music that's playing.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadWorker) return;
    if (audio.paused && !importing) location.reload();
    else toast('moonlit was updated ✦ it switches over next time you open it', 5000);
  });
}

/* ───────────── boot ───────────── */
(async function init() {
  buildThemeGrid();
  buildFloaties();
  setupVizSettings();
  setupFolding();
  setupPlaylists();
  setupThemeIcon();
  setupBackAsk();
  applyPerf(prefs.get('perf', prefs.get('lite', false) ? 'lite' : 'full')); // older versions saved a lite on/off switch
  applyTheme(prefs.get('theme', 'midnight-rose'));
  el.nameInput.value = prefs.get('name', '');
  el.wmInput.value = prefs.get('watermark', '');
  updateGreeting();
  updateWatermark();
  syncInstallUi();
  if (sinkSupported && navigator.mediaDevices) {
    $('#outputSection').hidden = false;
    listOutputs();
    resolveSink().then(sink => sink && applySink(sink)).then(ok => {
      if (ok === false) toast("your chosen sound output isn't connected, so music is on the default device", 6000);
    });
  }
  // OBS lives on a computer: hide that section on phones and tablets (and browsers that can't write files).
  const obsSection = el.obsLink.closest('section');
  obsSection.hidden = !desktop && (!window.showSaveFilePicker || matchMedia('(hover: none) and (pointer: coarse)').matches);
  if (desktop) {
    obsSection.querySelector('.hint').innerHTML = 'keeps a <b>.txt</b> file updated with the current song, so an OBS text source can show it on stream.';
    setupDesktop();
    setupDownloader();
    setupOverlay();
  }
  setInterval(updateGreeting, 60_000);
  setVolume(prefs.get('volume', 0.8), false);
  syncModes();
  setFill(el.seek);

  try {
    const recs = await DB.all();
    const order = prefs.get('order', []);
    const pos = new Map(order.map((id, i) => [id, i]));
    recs.sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9) || a.added - b.added);
    state.tracks = recs;
    // songs added before artists and titles were tidied ("A;B", "Copyright Free Music"): fixed once, quietly
    for (const t of recs) {
      const before = `${t.artist}|${t.title}`;
      t.artist = tidyArtist(t.artist);
      untangleTags(t);
      if (`${t.artist}|${t.title}` !== before) DB.put(t).catch(() => {});
    }
    reindex();
    navigator.storage?.persist?.().catch(() => {});
  } catch {
    state.persistent = false;
  }
  renderList(true);
  fillDurations();
  await restoreObs();

  const last = prefs.get('last', null);
  const first = last && byId(last.id) ? loadTrack(last.id, last.time || 0)
    : state.tracks.length ? loadTrack(state.tracks[0].id) : null;
  updateTime();
  if (desktop) {
    desktop.onOpenFiles(openExternalFiles);
    const opened = await desktop.takePendingFiles().catch(() => []);
    // opened by double-clicking a song: play that
    if (opened.length) openExternalFiles(opened);
    // desktop app on an always-on PC: carry on playing after a restart
    else if (first && prefs.get('autoResume', false)) first.then(play);
  }
})();
