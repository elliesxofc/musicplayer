'use strict';

/* moonlit — a private little music player.
   Everything lives in this browser: songs are kept in IndexedDB,
   settings in localStorage. Nothing is ever uploaded anywhere. */

const $ = (s, r = document) => r.querySelector(s);

const THEMES = [
  { id: 'midnight-rose', name: 'midnight rose', swatch: 'linear-gradient(135deg,#2a0f22 30%,#ff7eb6)', color: '#170a14' },
  { id: 'strawberry-milk', name: 'strawberry milk', swatch: 'linear-gradient(135deg,#ffdbe7 30%,#f0609e)', color: '#fff1f5' },
  { id: 'cherry-noir', name: 'cherry noir', swatch: 'linear-gradient(135deg,#0a0709 35%,#ff2e7e)', color: '#0a0709' },
  { id: 'bubblegum', name: 'bubblegum', swatch: 'linear-gradient(135deg,#ff5fa8,#8f7bff)', color: '#fde9ff' },
  { id: 'sakura-dusk', name: 'sakura dusk', swatch: 'linear-gradient(135deg,#4a2440,#ffa3c4 60%,#ffd29a)', color: '#24142b' },
  { id: 'rose-gold', name: 'rosé gold', swatch: 'linear-gradient(135deg,#f8ebe6,#d97a8a 55%,#c9a27a)', color: '#f8ebe6' },
];

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
    del: id => run('readwrite', s => { s.delete(id); }),
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
async function readTags(file) {
  const out = {};
  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
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
    const done = d => { URL.revokeObjectURL(url); a.src = ''; resolve(Number.isFinite(d) ? d : 0); };
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

const byId = id => state.tracks.find(t => t.id === id);
const fmt = s => { if (!Number.isFinite(s) || s < 0) s = 0; const m = Math.floor(s / 60); return m + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const coverUrl = t => {
  if (!t.cover) return null;
  if (!coverUrls.has(t.id)) coverUrls.set(t.id, URL.createObjectURL(t.cover));
  return coverUrls.get(t.id);
};

let toastTimer;
function toast(msg) {
  el.toastEl.textContent = msg;
  el.toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toastEl.classList.remove('show'), 2600);
}

/* ───────────── theme, greeting, watermark ───────────── */
function applyTheme(id) {
  const t = THEMES.find(x => x.id === id) || THEMES[0];
  document.body.dataset.theme = t.id;
  $('meta[name="theme-color"]').content = t.color;
  prefs.set('theme', t.id);
  el.themeGrid.querySelectorAll('.theme-opt').forEach(b => b.setAttribute('aria-checked', String(b.dataset.theme === t.id)));
  viz.refreshColor();
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
  el.settings.hidden = !open;
  el.settingsBtn.setAttribute('aria-expanded', String(open));
}
el.settingsBtn.onclick = e => { e.stopPropagation(); setSettings(el.settings.hidden); };
$('#settingsClose').onclick = () => setSettings(false);
document.addEventListener('click', e => {
  if (!el.settings.hidden && !e.target.closest('#settings, #settingsBtn')) setSettings(false);
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
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
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
const viz = (() => {
  const canvas = $('#viz');
  const g = canvas.getContext('2d');
  const BARS = 72;
  const levels = new Float32Array(BARS);
  let ctx = null, analyser = null, freq = null, color = '#fff', color2 = '#fff';

  function ensureAudioGraph() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaElementSource(audio);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.82;
      freq = new Uint8Array(analyser.frequencyBinCount);
      src.connect(analyser);
      analyser.connect(ctx.destination);
    } catch { ctx = null; }
  }

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

  function frame(t) {
    requestAnimationFrame(frame);
    if (document.hidden) return;
    const w = canvas.width, h = canvas.height;
    if (!w) return;
    const playing = !audio.paused;
    if (analyser && playing) analyser.getByteFrequencyData(freq);
    g.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const inner = w / 2 / 1.44 + w * 0.012; // just outside the record
    const maxLen = w * 0.13;
    g.lineCap = 'round';
    g.lineWidth = Math.max(2, w * 0.006);
    const grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, color);
    grad.addColorStop(1, color2);
    g.strokeStyle = grad;
    g.shadowColor = color;
    g.shadowBlur = playing ? w * 0.012 : 0;
    const half = BARS / 2;
    for (let i = 0; i < BARS; i++) {
      // mirror the spectrum so the ring is symmetrical
      const k = i < half ? i : BARS - 1 - i;
      let target = 0.03 + 0.02 * Math.sin(t / 900 + i * 0.5);
      if (analyser && playing) {
        const bin = Math.floor(2 + (k / half) ** 1.6 * (freq.length * 0.62));
        target = Math.max(target, (freq[bin] / 255) ** 1.6);
      }
      levels[i] += (target - levels[i]) * (target > levels[i] ? 0.45 : 0.12);
      const a = (i / BARS) * Math.PI * 2 - Math.PI / 2;
      const len = levels[i] * maxLen;
      const cos = Math.cos(a), sin = Math.sin(a);
      g.globalAlpha = 0.35 + levels[i] * 0.65;
      g.beginPath();
      g.moveTo(cx + cos * inner, cy + sin * inner);
      g.lineTo(cx + cos * (inner + len), cy + sin * (inner + len));
      g.stroke();
    }
    g.globalAlpha = 1;
  }
  requestAnimationFrame(frame);
  return { ensureAudioGraph, refreshColor };
})();

/* ───────────── library rendering ───────────── */
function visibleTracks() {
  const q = state.query.toLowerCase();
  return state.tracks.filter(t =>
    (state.view === 'all' || t.fav) &&
    (!q || `${t.title} ${t.artist || ''} ${t.album || ''}`.toLowerCase().includes(q)));
}

function renderList(animate = false) {
  const items = visibleTracks();
  const total = state.tracks.length;
  el.count.textContent = `${total} song${total === 1 ? '' : 's'}` +
    (total ? ` · ${fmt(state.tracks.reduce((s, t) => s + (t.duration || 0), 0))}` : '');
  el.empty.hidden = total > 0;
  el.list.hidden = total === 0;
  el.list.innerHTML = '';
  el.list.classList.toggle('intro', animate);
  if (total && !items.length) {
    const li = document.createElement('li');
    li.className = 'empty-sub';
    li.style.cssText = 'text-align:center;padding:30px 10px';
    li.textContent = state.view === 'loved' && !state.query ? 'no loved songs yet — tap the heart ♡' : 'nothing matches that';
    el.list.append(li);
    return;
  }
  const frag = document.createDocumentFragment();
  items.forEach((t, i) => {
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
    frag.append(li);
  });
  el.list.append(frag);
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

document.querySelectorAll('.tab').forEach(tab => tab.onclick = () => {
  state.view = tab.dataset.view;
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', t === tab));
  renderList();
});
el.search.addEventListener('input', () => { state.query = el.search.value.trim(); renderList(); });

/* ───────────── adding / removing ───────────── */
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|webm|weba|aiff?)$/i;

async function addFiles(fileList) {
  const files = [...fileList].filter(f => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name));
  if (!files.length) { toast("those don't look like songs"); return; }
  toast(`adding ${files.length} song${files.length === 1 ? '' : 's'}…`);
  let added = 0;
  for (const f of files) {
    const tags = await readTags(f);
    const guess = fromFilename(f.name);
    const rec = {
      id: uid(),
      title: tags.title || guess.title || f.name,
      artist: tags.artist || guess.artist || '',
      album: tags.album || '',
      cover: tags.cover || null,
      duration: await probeDuration(f),
      file: f,
      fav: false,
      added: Date.now(),
    };
    if (state.persistent) {
      try { await DB.put(rec); } catch {
        state.persistent = false;
        toast("couldn't save to this browser — songs will last until you close the tab");
      }
    }
    state.tracks.push(rec);
    added++;
  }
  saveOrder();
  renderList(true);
  toast(`added ${added} song${added === 1 ? '' : 's'} ✦`);
  if (!state.currentId && state.tracks.length) loadTrack(state.tracks[0].id);
}

async function removeTrack(id) {
  const t = byId(id);
  if (!t || !confirm(`remove “${t.title}” from your library?`)) return;
  if (id === state.currentId) {
    const next = neighbour(1);
    audio.pause();
    if (next && next !== id) loadTrack(next); else clearNowPlaying();
  }
  state.tracks = state.tracks.filter(x => x.id !== id);
  state.queue = state.queue.filter(x => x !== id);
  if (coverUrls.has(id)) { URL.revokeObjectURL(coverUrls.get(id)); coverUrls.delete(id); }
  if (state.persistent) DB.del(id).catch(() => {});
  saveOrder();
  renderList();
}

function saveOrder() { prefs.set('order', state.tracks.map(t => t.id)); }

async function toggleFav(id = state.currentId) {
  const t = byId(id);
  if (!t) return;
  t.fav = !t.fav;
  if (state.persistent) DB.put(t).catch(() => {});
  if (id === state.currentId) syncFav(true);
  if (t.fav) heartBurst(id === state.currentId ? el.fav : el.list.querySelector(`[data-id="${id}"] .t-fav`) || el.fav);
  renderList();
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
  audio.play().catch(err => { if (err.name !== 'AbortError') toast("couldn't play that one — the format may not be supported"); });
}
function togglePlay() { audio.paused ? play() : audio.pause(); }

function currentQueue() {
  const q = state.queue.filter(id => byId(id));
  return q.length ? q : state.tracks.map(t => t.id);
}

// Returns the id one step away in the queue (respects shuffle / repeat).
function neighbour(dir, fromEnded = false) {
  const q = currentQueue();
  if (!q.length) return null;
  if (state.shuffle && dir > 0 && q.length > 1) {
    const recent = new Set(state.history.slice(-Math.floor(q.length * 0.6)));
    const pool = q.filter(id => id !== state.currentId && !recent.has(id));
    const pick = pool.length ? pool : q.filter(id => id !== state.currentId);
    return pick[Math.floor(Math.random() * pick.length)];
  }
  const i = q.indexOf(state.currentId);
  let n = i + dir;
  if (n >= q.length) { if (fromEnded && state.repeat === 'off') return null; n = 0; }
  if (n < 0) n = q.length - 1;
  return q[n];
}

function next(fromEnded = false) {
  const id = neighbour(1, fromEnded);
  if (id) playTrack(id);
  else { audio.pause(); audio.currentTime = 0; }
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
audio.addEventListener('error', () => { if (audio.getAttribute('src')) toast("hmm, this file won't play here"); });

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
audio.addEventListener('loadedmetadata', updateTime);
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
  set('pause', () => audio.pause());
  set('nexttrack', () => next());
  set('previoustrack', prev);
  set('seekto', d => { audio.currentTime = d.seekTime; });
  set('seekbackward', d => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10)); });
  set('seekforward', d => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (d.seekOffset || 10)); });
}

/* keyboard */
document.addEventListener('keydown', e => {
  if (e.target.closest('input[type="search"], input[type="text"], textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
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
  else if (k === 'escape') { setSettings(false); setLibrary(false); }
});

/* ───────────── files in ───────────── */
$('#addBtn').onclick = () => el.file.click();
el.file.onchange = () => { addFiles(el.file.files); el.file.value = ''; };

let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; el.drop.classList.add('show'); });
window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; el.drop.classList.remove('show'); } });
window.addEventListener('drop', e => {
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
$('#libToggle').onclick = () => setLibrary(!el.library.classList.contains('open'));
el.scrim.onclick = () => setLibrary(false);

window.addEventListener('pagehide', () => saveProgress(true));

/* ───────────── OBS: now playing → .txt file ─────────────
   OBS can't read from a web page, but its Text source can "read from file".
   With the File System Access API (Chrome / Edge) we keep one .txt file you
   choose up to date with the current song. */
const obs = { handle: null, granted: false, asked: false };
let obsTimer = null, obsChain = Promise.resolve();

function obsText() {
  const t = byId(state.currentId);
  if (!t || (prefs.get('obsPause', false) && audio.paused)) return '';
  let s = prefs.get('obsFormat', '{artist} - {title}');
  if (!t.artist) s = s.replace(/\s*[-—]\s*\{artist\}|\{artist\}\s*[-—]\s*|\s+by\s+\{artist\}/g, '');
  s = s.replace('{title}', () => t.title).replace('{artist}', () => t.artist || '');
  return s + (prefs.get('obsPad', false) ? '        ' : '');
}

function queueObsWrite() {
  if (!obs.handle || !obs.granted) return;
  clearTimeout(obsTimer);
  obsTimer = setTimeout(() => { obsChain = obsChain.then(writeObs); }, 150);
}

async function writeObs() {
  if (!obs.handle) return;
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
  obs.handle = null;
  obs.granted = false;
  DB.setKV('obsHandle', undefined).catch(() => {});
  syncObsUi();
}

// Browsers forget file permission between visits; ask again on your first play.
function maybeReconnectObs() {
  if (!obs.handle || obs.granted || obs.asked || !navigator.userActivation?.isActive) return;
  obs.asked = true;
  obs.handle.requestPermission({ mode: 'readwrite' })
    .then(p => { obs.granted = p === 'granted'; syncObsUi(); queueObsWrite(); })
    .catch(() => {});
}

function syncObsUi() {
  const linked = !!obs.handle;
  el.obsStatus.textContent = !linked ? 'not linked'
    : obs.granted ? `writing to ${obs.handle.name}` : `${obs.handle.name} · tap reconnect`;
  el.obsStatus.classList.toggle('ok', linked && obs.granted);
  el.obsLinkText.textContent = !linked ? 'link nowplaying.txt' : obs.granted ? 'pick another file' : 'reconnect';
  el.obsUnlink.hidden = !linked;
  el.obsLive.hidden = !(linked && obs.granted);
}

el.obsLink.onclick = linkObs;
el.obsUnlink.onclick = unlinkObs;
el.obsFormat.onchange = () => { prefs.set('obsFormat', el.obsFormat.value); queueObsWrite(); };
el.obsPause.onchange = () => { prefs.set('obsPause', el.obsPause.checked); queueObsWrite(); };
el.obsPad.onchange = () => { prefs.set('obsPad', el.obsPad.checked); queueObsWrite(); };

async function restoreObs() {
  el.obsFormat.value = prefs.get('obsFormat', '{artist} - {title}');
  el.obsPause.checked = prefs.get('obsPause', false);
  el.obsPad.checked = prefs.get('obsPad', false);
  try {
    const handle = await DB.getKV('obsHandle');
    if (handle) {
      obs.handle = handle;
      obs.granted = (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
    }
  } catch { /* no saved file */ }
  syncObsUi();
}

/* ───────────── boot ───────────── */
(async function init() {
  buildThemeGrid();
  buildFloaties();
  applyTheme(prefs.get('theme', 'midnight-rose'));
  el.nameInput.value = prefs.get('name', '');
  el.wmInput.value = prefs.get('watermark', '');
  updateGreeting();
  updateWatermark();
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
    navigator.storage?.persist?.().catch(() => {});
  } catch {
    state.persistent = false;
  }
  renderList(true);
  await restoreObs();

  const last = prefs.get('last', null);
  if (last && byId(last.id)) loadTrack(last.id, last.time || 0);
  else if (state.tracks.length) loadTrack(state.tracks[0].id);
  updateTime();
})();
