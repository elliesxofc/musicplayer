'use strict';

/* Stagelight's remote panel: log in, then watch and steer OBS. Everything goes through the
   Stagelight program on the stream PC; this page never talks to OBS itself. */

const $ = s => document.querySelector(s);
let st = null, clockOffset = 0, events = null, toastTimer = null, dragging = null;

function toast(msg, ms = 2600) {
  $('#toast').textContent = msg;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), ms);
}

const api = async (path, body) => {
  const res = await fetch(path, body === undefined ? { credentials: 'same-origin' } : {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Stagelight': '1' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.error === 'log in first') showLogin(); // logged out (not a wrong password typed again)
  if (!res.ok) throw new Error(data.error || `error ${res.status}`);
  return data;
};
const act = (a, done) => api('/api/action', a).then(done || (() => {})).catch(err => toast(err.message, 4000));

/* ───────────── log in / out ───────────── */
function showLogin() {
  if (events) { events.close(); events = null; }
  if (typeof rdClose === 'function') rdClose(false);
  $('#panelView').hidden = true;
  $('#loginView').hidden = false;
  setTimeout(() => ($('#username').value ? $('#password') : $('#username')).focus(), 50);
}
const ROLE_NAMES = { full: 'full access', control: 'stream control', watch: 'watch only' };
let me = { user: '', role: 'watch' };
function showPanel() {
  $('#loginView').hidden = true;
  $('#panelView').hidden = false;
  listen();
  // who's signed in decides what the panel offers (Stagelight checks it again for everything)
  api('/api/me').then(m => {
    me = m;
    document.body.dataset.role = m.role;
    $('#who').innerHTML = '';
    const b = document.createElement('b'); b.textContent = m.user;
    $('#who').append(b, ` · ${ROLE_NAMES[m.role] || m.role}`);
    $('#watchNote').hidden = m.role !== 'watch';
    if (m.role === 'watch') { $('#editOn').checked = false; renderStage(); }
    remoteInfo();
  }).catch(() => {});
}
$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  $('#loginBtn').disabled = true;
  $('#loginError').textContent = '';
  try {
    await api('/api/login', { username: $('#username').value.trim(), password: $('#password').value });
    $('#password').value = '';
    showPanel();
  } catch (err) {
    $('#loginError').textContent = err.message;
  } finally {
    $('#loginBtn').disabled = false;
  }
};
$('#logoutBtn').onclick = () => api('/api/logout', {}).finally(showLogin);

/* ───────────── live state from the stream PC ───────────── */
function listen() {
  if (events) events.close();
  events = new EventSource('/api/events');
  events.onmessage = e => { try { apply(JSON.parse(e.data)); } catch { /* skip a bad message */ } };
  events.onerror = () => {
    // logged out (or Stagelight closed): find out which
    fetch('/api/state', { credentials: 'same-origin' }).then(r => {
      if (r.status === 401) showLogin();
      else setConn('Stagelight is not answering… retrying', 'wait');
    }).catch(() => setConn("can't reach Stagelight on the stream PC… retrying", 'wait'));
  };
}

function setConn(text, kind) { $('#connText').textContent = text; $('#connDot').dataset.kind = kind; }

const clock = ms => {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
};

function apply(next) {
  st = next;
  clockOffset = (next.now || Date.now()) - Date.now(); // the stream PC's clock vs this device's
  setConn(st.status, st.connected ? 'on' : 'wait');
  renderOnAir();
  renderStage();
  renderScenes();
  renderSources();
  renderAudio();
}

function renderOnAir() {
  const s = st.stream, r = st.record, on = st.connected;
  $('#onAir').classList.toggle('live', s.active);
  $('#liveBadge').textContent = s.active ? (s.reconnecting ? 'reconnecting' : 'live') : on ? 'offline' : 'OBS not connected';
  $('#streamBtn').classList.toggle('live', s.active);
  $('#streamText').textContent = s.active ? 'end stream' : 'go live';
  $('#streamBtn').disabled = !on;
  $('#recBtn').classList.toggle('on', r.active);
  $('#recText').textContent = r.active ? `stop rec · ${clock(r.ms)}` : 'record';
  $('#recBtn').disabled = !on;
  $('#recPauseBtn').hidden = !r.active;
  $('#recPauseText').textContent = r.paused ? 'resume' : 'pause';
  const bits = [];
  if (s.active) {
    if (s.kbps) bits.push(s.kbps >= 1000 ? `${(s.kbps / 1000).toFixed(1)} Mb/s` : `${s.kbps} kb/s`);
    if (s.total) bits.push(`${(s.skipped / s.total * 100).toFixed(1)}% dropped`);
  }
  if (st.stats && on) {
    if (Number.isFinite(st.stats.fps)) bits.push(`${Math.round(st.stats.fps)} fps`);
    if (Number.isFinite(st.stats.cpu)) bits.push(`CPU ${st.stats.cpu.toFixed(1)}%`);
  }
  $('#stats').textContent = bits.join(' · ');
  $('#stats').classList.toggle('warn', s.active && (s.congestion > 0.5 || (s.total && s.skipped / s.total > 0.02)));
  tick();
}
function tick() {
  if (!st) return;
  const s = st.stream;
  $('#liveClock').textContent = s.active && s.startedAt ? clock(Date.now() + clockOffset - s.startedAt) : '';
}
setInterval(tick, 1000);

/* The lists are redrawn only when what they show changes, and never under a finger: OBS sends
   news every couple of seconds (more while live), and a button swapped out mid-tap ignores it. */
const drawn = {};
let pressing = 0, pendingDraw = false;
for (const id of ['#scenes', '#sources', '#audio']) {
  const el = $(id);
  el.addEventListener('pointerdown', () => { pressing++; });
  const up = () => {
    if (!pressing) return;
    pressing--;
    // after the click (or the slider's last change) has been handled
    if (!pressing && pendingDraw) setTimeout(() => { if (!pressing && pendingDraw && st) { pendingDraw = false; renderScenes(); renderSources(); renderAudio(); } }, 450);
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}
window.addEventListener('pointerup', () => { if (pressing) setTimeout(() => { pressing = 0; }, 0); }, true);
// true when the list should be left alone: unchanged, or a finger is on it right now
function unchanged(which, key) {
  if (drawn[which] === key) return true;
  if (pressing) { pendingDraw = true; return true; }
  drawn[which] = key;
  return false;
}

function renderScenes() {
  const box = $('#scenes');
  if (unchanged('scenes', JSON.stringify([st.scene, st.scenes]))) return;
  box.innerHTML = '';
  for (const name of st.scenes) {
    const b = document.createElement('button');
    b.className = 'scene';
    b.textContent = name;
    b.setAttribute('aria-pressed', String(name === st.scene));
    b.onclick = () => { if (name !== st.scene) act({ type: 'scene', name }); };
    box.append(b);
  }
  if (!st.scenes.length) box.innerHTML = '<p class="muted">no scenes yet</p>';
}

function renderSources() {
  $('#sceneName').textContent = st.scene || '…';
  const list = $('#sources');
  if (unchanged('sources', JSON.stringify([st.scene, st.items.map(it => [it.id, it.name, it.on, it.kind])]))) return;
  list.innerHTML = '';
  for (const it of st.items) {
    const li = document.createElement('li');
    li.className = it.on ? '' : 'off';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = it.name;
    const b = document.createElement('button');
    b.className = `toggle${it.on ? '' : ' off'}`;
    b.setAttribute('aria-label', `${it.on ? 'hide' : 'show'} ${it.name}`);
    b.innerHTML = `<svg><use href="#${it.on ? 'i-eye' : 'i-eye-off'}"/></svg>`;
    b.onclick = () => act({ type: 'source', scene: st.scene, id: it.id, on: !it.on });
    li.append(name);
    if (it.kind === 'browser_source') {
      const r = document.createElement('button');
      r.className = 'toggle refresh needs-control';
      r.setAttribute('aria-label', `refresh ${it.name}`);
      r.title = 'refresh (reload the page)';
      r.innerHTML = '<svg><use href="#i-refresh"/></svg>';
      r.onclick = () => {
        r.classList.add('spin');
        act({ type: 'refresh', scene: st.scene, id: it.id, name: it.name }, () => toast(`refreshed ${it.name} ✦`));
        setTimeout(() => r.classList.remove('spin'), 700);
      };
      const g = document.createElement('button');
      g.className = 'toggle refresh needs-control';
      g.setAttribute('aria-label', `settings for ${it.name}`);
      g.title = 'web address, size and CSS';
      g.innerHTML = '<svg><use href="#i-gear"/></svg>';
      g.onclick = () => browserForm(it);
      li.append(r, g);
    }
    li.append(b);
    list.append(li);
  }
  if (!st.items.length) list.innerHTML = '<li class="empty">no sources in this scene</li>';
}

// the volume slider works in decibels like OBS's mixer: 0 = silent … 100 = 0 dB
const toPos = mul => (mul <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((20 * Math.log10(mul) + 60) / 60 * 100))));
const toMul = pos => (pos <= 0 ? 0 : Math.pow(10, (pos / 100 * 60 - 60) / 20));
const dbText = mul => (mul <= 0 ? '-inf dB' : `${(20 * Math.log10(mul)).toFixed(1)} dB`);

function renderAudio() {
  const list = $('#audio');
  // the same sources as before: only the volumes and mutes change, in place
  if (drawn.audioNames === JSON.stringify(st.audio.map(a => a.name))) {
    for (const a of st.audio) {
      const row = [...list.children].find(li => li.dataset.name === a.name);
      if (!row) continue;
      row.classList.toggle('muted', a.muted);
      const b = row.querySelector('.toggle');
      b.setAttribute('aria-label', `${a.muted ? 'unmute' : 'mute'} ${a.name}`);
      b.querySelector('use').setAttribute('href', `#${a.muted ? 'i-mute' : 'i-vol'}`);
      b.onclick = () => act({ type: 'mute', input: a.name, on: !a.muted });
      if (dragging === a.name) continue; // not under a finger that's moving the slider
      row.querySelector('input').value = toPos(a.mul);
      row.querySelector('.db').textContent = dbText(a.mul);
    }
    return;
  }
  if (pressing) { pendingDraw = true; return; }
  drawn.audioNames = JSON.stringify(st.audio.map(a => a.name));
  list.innerHTML = '';
  for (const a of st.audio) {
    const li = document.createElement('li');
    li.className = `audio-row${a.muted ? ' muted' : ''}`;
    li.dataset.name = a.name;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = a.name;
    const b = document.createElement('button');
    b.className = 'toggle';
    b.setAttribute('aria-label', `${a.muted ? 'unmute' : 'mute'} ${a.name}`);
    b.innerHTML = `<svg><use href="#${a.muted ? 'i-mute' : 'i-vol'}"/></svg>`;
    b.onclick = () => act({ type: 'mute', input: a.name, on: !a.muted });
    const vol = document.createElement('div');
    vol.className = 'vol';
    const range = document.createElement('input');
    range.type = 'range'; range.min = 0; range.max = 100; range.step = 1; range.value = toPos(a.mul);
    range.setAttribute('aria-label', `${a.name} volume`);
    const db = document.createElement('span');
    db.className = 'db';
    db.textContent = dbText(a.mul);
    let sendTimer = null, letGo = null;
    // held from the first touch (before it moves), and for a moment after letting go
    range.onpointerdown = () => { clearTimeout(letGo); dragging = a.name; };
    const release = () => { clearTimeout(letGo); letGo = setTimeout(() => { if (dragging === a.name) dragging = null; }, 600); };
    range.onpointerup = range.onpointercancel = release;
    range.oninput = () => {
      dragging = a.name;
      const mul = toMul(Number(range.value));
      db.textContent = dbText(mul);
      clearTimeout(sendTimer);
      sendTimer = setTimeout(() => act({ type: 'volume', input: a.name, mul }), 60);
    };
    range.onchange = release;
    vol.append(range, db);
    li.append(name, b, vol);
    list.append(li);
  }
  if (!st.audio.length) list.innerHTML = '<li class="empty">no audio sources</li>';
}

/* ───────────── preview: what OBS shows, and the layout of the scene ───────────── */
let selected = null, drag = null, lastShot = null, lastTag = null, boxesKey = null;
const stage = $('#stage'), boxes = $('#boxes');
const editing = () => $('#editOn').checked;

/* The scene the preview and edit layout work on: the one on stream, or (while editing) another
   one picked from the list, changed without anyone watching seeing it until it's switched to. */
let editScene = '', editAsk = null;
const stageScene = () => (editing() && editScene && st.scenes.includes(editScene) ? editScene : st.scene);
const offStream = () => !!st && stageScene() !== st.scene;
const stageItems = () => { const sc = stageScene(); return sc === st.scene ? st.items : (st.others && st.others[sc]) || null; };
function pickScene(name) {
  editScene = name && name !== st.scene ? name : '';
  selected = null; boxesKey = null; lastTag = null;
  // the other scene's picture, not the old one, while it loads
  $('#previewImg').removeAttribute('src');
  $('#stageMsg').textContent = 'loading the preview…';
  clearInterval(editAsk);
  if (editScene) {
    // Stagelight keeps that scene's sources up to date while someone edits it
    const ask = () => api('/api/action', { type: 'editScene', scene: editScene }).catch(err => toast(err.message, 4000));
    ask();
    editAsk = setInterval(() => { if (editScene && editing()) ask(); }, 60_000);
  }
  renderStage();
}
$('#editScene').onchange = () => pickScene($('#editScene').value);
$('#goScene').onclick = () => { const name = stageScene(); act({ type: 'scene', name }, () => { toast(`"${name}" is on stream now ✦`); editScene = ''; renderStage(); }); };

// the picture: about once a second while the panel is open (it pauses in the background)
async function previewLoop() {
  let wait = 1000;
  try {
    // (not while the remote display covers it: each picture costs OBS a little)
    if ($('#previewOn').checked && !$('#panelView').hidden && !rd && document.visibilityState === 'visible' && st && st.connected) {
      // asks "has it changed?": an unchanged picture isn't sent again
      const r = await fetch(offStream() ? `/api/preview?scene=${encodeURIComponent(stageScene())}` : '/api/preview', { credentials: 'same-origin', cache: 'no-cache' });
      const tag = r.headers.get('ETag');
      if (r.status === 401) showLogin();
      else if (r.ok && tag && tag === lastTag) { /* same picture */ }
      else if (r.ok) {
        lastTag = tag;
        const url = URL.createObjectURL(await r.blob());
        $('#previewImg').src = url;
        if (lastShot) URL.revokeObjectURL(lastShot);
        lastShot = url;
        $('#stageMsg').textContent = '';
      } else wait = 2500;
    } else if (st && !st.connected) {
      $('#stageMsg').textContent = 'OBS is not connected';
    } else if (!$('#previewOn').checked) {
      $('#stageMsg').textContent = lastShot ? '' : 'preview paused';
    }
  } catch { wait = 2500; }
  setTimeout(previewLoop, wait);
}
previewLoop();
$('#previewOn').onchange = () => { if (!$('#previewOn').checked) $('#stageMsg').textContent = 'preview paused (saves data)'; };
$('#editOn').onchange = () => { if (!editing()) { selected = null; pickScene(''); } else renderStage(); };

function renderStage() {
  if (!st) return;
  stage.style.aspectRatio = `${st.canvas.w} / ${st.canvas.h}`;
  stage.style.setProperty('--ar', st.canvas.w / st.canvas.h);
  stage.classList.toggle('editing', editing());
  $('#editHint').hidden = !editing();
  // which scene: the list, and whether the one shown is on stream
  if (editScene && (!st.scenes.includes(editScene) || editScene === st.scene)) editScene = '';
  $('#editSceneRow').hidden = !editing();
  const opts = JSON.stringify([st.scenes, st.scene]);
  if ($('#editScene').dataset.key !== opts) {
    $('#editScene').dataset.key = opts;
    $('#editScene').replaceChildren(...st.scenes.map(n => { const o = document.createElement('option'); o.value = n; o.textContent = n === st.scene ? `${n} · on stream` : n; return o; }));
  }
  $('#editScene').value = stageScene();
  const off = offStream();
  stage.classList.toggle('off-stream', off);
  $('#goScene').hidden = !off;
  $('#editHint').textContent = off
    ? `tap a source to pick it, drag to move it, drag its corner to resize. "${stageScene()}" isn't on stream: nobody sees the changes until you show it.`
    : 'tap a source to pick it, drag to move it, drag its corner to resize. changes show on stream straight away.';
  const items = stageItems() || [];
  if (!stageItems()) $('#stageMsg').textContent = `loading "${stageScene()}"…`;
  if (selected != null && !items.some(i => i.id === selected)) selected = null;
  const it = items.find(i => i.id === selected);
  $('#selBar').hidden = !it;
  if (it) {
    $('#selName').textContent = it.name;
    $('#selText').hidden = typeof it.text !== 'string';
    $('#selBrowser').hidden = it.kind !== 'browser_source';
    $('#selHide').textContent = it.on ? 'hide' : 'show';
  }
  if (drag) return; // don't redraw under a finger
  // only when something about the boxes changed (most updates are just the stream's numbers)
  const key = editing() ? JSON.stringify([stageScene(), selected, st.canvas, items.map(i => [i.id, i.on, i.name, i.box])]) : '';
  if (key === boxesKey) return;
  boxesKey = key;
  boxes.replaceChildren();
  if (!editing()) return;
  // bottom of OBS's list first, so the top source ends up on top here too
  for (const i of items.slice().reverse()) {
    if (!i.box || i.box.w <= 0 || i.box.h <= 0) continue;
    const el = document.createElement('div');
    // near the top edge the name goes inside the box, so it isn't cut off
    // a source that fills the screen (a game, a background) has its name at the bottom, out of the
    // way of the others; near the top edge the name goes inside the box, so it isn't cut off
    const full = i.box.w >= st.canvas.w * 0.9 && i.box.h >= st.canvas.h * 0.9;
    el.className = `box${i.on ? '' : ' off'}${i.id === selected ? ' sel' : ''}${full ? ' tag-bottom' : i.box.y < st.canvas.h * 0.06 ? ' tag-in' : ''}`;
    el.dataset.id = i.id;
    place(el, i.box);
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = i.name;
    const grip = document.createElement('span');
    grip.className = 'grip';
    el.append(tag, grip);
    boxes.append(el);
  }
}
function place(el, b) {
  el.style.left = `${b.x / st.canvas.w * 100}%`;
  el.style.top = `${b.y / st.canvas.h * 100}%`;
  el.style.width = `${b.w / st.canvas.w * 100}%`;
  el.style.height = `${b.h / st.canvas.h * 100}%`;
}

// pick, move and resize with a finger or the mouse
boxes.addEventListener('pointerdown', e => {
  if (!editing()) return;
  const el = e.target.closest('.box');
  if (!el) { selected = null; renderStage(); return; }
  const it = (stageItems() || []).find(i => i.id === Number(el.dataset.id));
  if (!it) return;
  e.preventDefault();
  if (selected !== it.id) { selected = it.id; renderStage(); }
  const target = boxes.querySelector(`.box[data-id="${it.id}"]`);
  const rect = stage.getBoundingClientRect();
  drag = { id: it.id, el: target, resize: !!e.target.closest('.grip'), sx: e.clientX, sy: e.clientY, start: { ...it.box }, now: { ...it.box },
    k: st.canvas.w / rect.width, sent: 0, timer: null };
  target.setPointerCapture(e.pointerId);
});
boxes.addEventListener('pointermove', e => {
  if (!drag) return;
  const dx = (e.clientX - drag.sx) * drag.k, dy = (e.clientY - drag.sy) * drag.k, b = drag.start;
  if (drag.resize) {
    // keeps its shape: the corner follows the finger along the source's own proportions
    const ratio = b.h / b.w;
    const w = Math.max(8, b.w + Math.max(dx, dy / ratio));
    drag.now = { ...b, w, h: w * ratio };
  } else {
    drag.now = { ...b, x: b.x + dx, y: b.y + dy };
  }
  place(drag.el, drag.now);
  // live on stream while dragging, a few times a second
  if (Date.now() - drag.sent > 120) { drag.sent = Date.now(); send(drag); }
});
const endDrag = () => { if (!drag) return; const d = drag; drag = null; boxesKey = null; send(d, true); };
boxes.addEventListener('pointerup', endDrag);
boxes.addEventListener('pointercancel', endDrag);
function send(d, last = false) {
  const b = d.now, s = d.start;
  if (last && b.x === s.x && b.y === s.y && b.w === s.w) return;
  const a = d.resize ? { type: 'resize', x: b.x, y: b.y, w: b.w, h: b.h } : { type: 'move', x: b.x, y: b.y };
  act({ ...a, scene: stageScene(), id: d.id });
}

// add / change / remove sources
const fieldHtml = f => {
  const id = `f_${f.name}`;
  const label = document.createElement('label');
  label.className = 'field';
  const span = document.createElement('span');
  span.textContent = f.label;
  const area = f.type === 'textarea' || f.type === 'code';
  const input = document.createElement(area ? 'textarea' : 'input');
  input.id = id;
  if (!area) input.type = f.type || 'text';
  if (f.type === 'code') { input.className = 'code'; input.spellcheck = false; input.setAttribute('autocapitalize', 'off'); }
  if (f.type === 'checkbox') { label.className = 'field check'; input.checked = !!f.value; label.append(input, span); return label; }
  if (f.value != null) input.value = f.value;
  if (f.placeholder) input.placeholder = f.placeholder;
  if (f.required) input.required = true;
  if (f.min != null) { input.min = f.min; input.max = f.max; }
  label.append(span, input);
  return label;
};
function form(title, text, fields, yes) {
  $('#formTitle').textContent = title;
  $('#formText').textContent = text;
  $('#formFields').replaceChildren(...fields.map(fieldHtml));
  $('#formYes').textContent = yes;
  $('#formModal').hidden = false;
  setTimeout(() => { const first = $('#formFields input, #formFields textarea'); if (first) first.focus(); }, 50);
  return new Promise(resolve => {
    const done = v => { $('#formModal').hidden = true; resolve(v); };
    $('#form').onsubmit = e => { e.preventDefault(); done(Object.fromEntries(fields.map(f => [f.name, f.type === 'checkbox' ? $(`#f_${f.name}`).checked : $(`#f_${f.name}`).value]))); };
    $('#formNo').onclick = () => done(null);
  });
}
const added = name => () => { toast(`added ${name} ✦`); if (!editing()) { $('#editOn').checked = true; renderStage(); } };
$('#addText').onclick = async () => {
  const v = await form('add text', `shows in the middle of "${stageScene()}"${offStream() ? " (not on stream)" : ''}. move it with edit layout.`, [
    { name: 'text', label: 'the words', type: 'textarea', required: true, placeholder: 'be right back ✦' },
    { name: 'name', label: 'name in OBS (optional)', placeholder: 'Text' },
  ], 'add text');
  if (v) act({ type: 'addText', scene: stageScene(), text: v.text, name: v.name }, added('the text'));
};
$('#addBrowser').onclick = async () => {
  const v = await form('add a website', 'alerts, chat, widgets or a picture link, as an OBS browser source.', [
    { name: 'url', label: 'web address', type: 'url', required: true, placeholder: 'https://' },
    { name: 'width', label: 'width', type: 'number', value: 800, min: 16, max: 7680 },
    { name: 'height', label: 'height', type: 'number', value: 600, min: 16, max: 4320 },
    { name: 'name', label: 'name in OBS (optional)' },
  ], 'add website');
  if (v) act({ type: 'addBrowser', scene: stageScene(), url: v.url, width: Number(v.width), height: Number(v.height), name: v.name }, added('the website'));
};
$('#addColor').onclick = async () => {
  const v = await form('add a colour box', 'a block of colour, for a frame or a background.', [
    { name: 'color', label: 'colour', type: 'color', value: '#8f7bff' },
    { name: 'name', label: 'name in OBS (optional)', placeholder: 'Colour' },
  ], 'add box');
  if (v) act({ type: 'addColor', scene: stageScene(), color: v.color, name: v.name }, added('the colour box'));
};
// a picture, video or sound from this device, uploaded to the stream PC and put in the scene
$('#addFile').onclick = () => { $('#fileInput').value = ''; $('#fileInput').click(); };
$('#fileInput').onchange = () => {
  const f = $('#fileInput').files[0];
  if (!f) return;
  if (f.size > 200 * 1024 * 1024) return toast('that file is too big (200 MB at most)', 4000);
  const scene = stageScene();
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/upload?scene=${encodeURIComponent(scene)}&file=${encodeURIComponent(f.name)}`);
  xhr.setRequestHeader('X-Stagelight', '1');
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  $('#addFile').disabled = true;
  xhr.upload.onprogress = e => { if (e.lengthComputable) toast(`uploading ${f.name}… ${Math.round(e.loaded / e.total * 100)}%`, 60_000); };
  const done = msg => { $('#addFile').disabled = false; toast(msg, 4000); };
  xhr.onload = () => {
    let r = {}; try { r = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
    if (xhr.status === 401) { done('log in first'); return showLogin(); }
    if (xhr.status !== 200) return done(r.error || (xhr.status === 413 ? 'that file is too big for this connection' : `upload failed (${xhr.status})`));
    done(`added ${r.name} ✦`);
    if (!editing()) { $('#editOn').checked = true; renderStage(); }
  };
  xhr.onerror = () => done("the upload didn't get through");
  xhr.send(f);
};

/* The preview filling the screen, for laying things out: the browser's own full screen where it
   has one, and the whole page otherwise (iPhones). */
const fsOn = () => $('#previewCard').classList.contains('fs');
function setFull(on) {
  $('#previewCard').classList.toggle('fs', on);
  document.body.classList.toggle('fs-open', on);
  $('#fsText').textContent = on ? 'close' : 'full screen';
  $('#fsBtn').setAttribute('aria-label', on ? 'close full screen' : 'full screen');
  if (on) {
    const el = $('#previewCard');
    if (el.requestFullscreen && !document.fullscreenElement) el.requestFullscreen().catch(() => {});
    if (!editing()) { $('#editOn').checked = true; $('#editOn').onchange(); }
  } else if (document.fullscreenElement === $('#previewCard')) document.exitFullscreen().catch(() => {});
  boxesKey = null;
  renderStage();
}
$('#fsBtn').onclick = () => setFull(!fsOn());
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && fsOn()) setFull(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && fsOn() && !document.fullscreenElement) setFull(false); });

const selectedItem = () => (stageItems() || []).find(i => i.id === selected);
$('#selText').onclick = async () => {
  const it = selectedItem();
  if (!it) return;
  const v = await form('edit text', it.name, [{ name: 'text', label: 'the words', type: 'textarea', value: it.text || '' }], 'save');
  if (v) act({ type: 'setText', scene: stageScene(), id: it.id, text: v.text }, () => toast('text changed ✦'));
};
// a browser source's settings: the page, its size and frame rate, and its CSS
async function browserForm(it, scene = st.scene) {
  let s;
  try { s = await api(`/api/browser?scene=${encodeURIComponent(scene)}&id=${it.id}`); } catch (err) { return toast(err.message, 4000); }
  const v = await form(`${s.name}`, s.localFile ? `this one shows a file on the stream PC (${s.localFile}). type a web address to show a website instead.` : 'like OBS\'s properties window. saving reloads the page on stream.', [
    { name: 'url', label: 'web address', type: 'url', required: !s.localFile, value: s.url, placeholder: s.localFile ? 'keeps the file when empty' : 'https://' },
    { name: 'width', label: 'width', type: 'number', value: s.width, min: 16, max: 7680 },
    { name: 'height', label: 'height', type: 'number', value: s.height, min: 16, max: 4320 },
    { name: 'fps', label: 'frame rate', type: 'number', value: s.fps, min: 1, max: 60 },
    { name: 'css', label: 'custom CSS', type: 'code', value: s.css },
    { name: 'shutdown', label: 'shut down when not visible', type: 'checkbox', value: s.shutdown },
    { name: 'restartWhenActive', label: 'refresh when the scene becomes active', type: 'checkbox', value: s.restartWhenActive },
  ], 'save');
  if (v) act({ type: 'browserSet', scene, id: it.id, name: it.name, ...v, width: Number(v.width), height: Number(v.height), fps: Number(v.fps) }, () => toast(`saved ${it.name} ✦`));
}
$('#selBrowser').onclick = () => { const it = selectedItem(); if (it) browserForm(it, stageScene()); };
$('#selHide').onclick = () => {
  const it = selectedItem();
  if (it) act({ type: 'source', scene: stageScene(), id: it.id, on: !it.on });
};
$('#selRemove').onclick = async () => {
  const it = selectedItem();
  if (!it || !(await ask(`remove "${it.name}"?`, `it's taken out of the scene "${stageScene()}".`, 'remove'))) return;
  act({ type: 'remove', scene: stageScene(), id: it.id }, () => { selected = null; toast('removed'); });
};

/* ───────────── remote display: the PC's whole screen, mouse and keyboard ─────────────
   The video comes straight from the stream PC over WebRTC; mouse and keyboard go back over a
   data channel. Places are sent as 0…1 across the screen, so any size of phone works. */
let rd = null; // { pc, dc, password, control }
const rdStage = $('#rdStage'), rdVideo = $('#rdVideo'), rdCanvas = $('#rdCanvas'), rdCtx = rdCanvas.getContext('2d');
// what shows the PC: the video (direct), or pictures drawn on a canvas (through the web address)
const rdView = () => (rd && rd.relay ? { el: rdCanvas, w: rdCanvas.width, h: rdCanvas.height } : { el: rdVideo, w: rdVideo.videoWidth, h: rdVideo.videoHeight });

async function remoteInfo() {
  const info = await api('/api/remote').catch(() => ({ view: false }));
  $('#remoteCard').hidden = !info.view && !info.files;
  $('#remoteOpen').hidden = !info.view;
  $('#filesOpen').hidden = !info.files;
  $('#rdFiles').hidden = !info.files;
  if (!info.view && info.files) $('#remoteHint').textContent = 'browse, download and upload files on the stream PC.';
  if (info.view) {
    $('#remoteHint').textContent = info.active
      ? `in use right now (${info.from}). opening it here takes over.`
      : info.control && info.controlWorks ? `see ${info.pcName ? `${info.pcName}'s` : 'the stream PC\'s'} screen and use its mouse and keyboard, for OBS's full window.`
        : 'see the stream PC\'s screen (watching only: mouse and keyboard are switched off on the PC).';
  }
  return info;
}
setInterval(() => { if (!$('#panelView').hidden && !rd) remoteInfo(); }, 15_000);

const iceDone = pc => new Promise(resolve => {
  if (pc.iceGatheringState === 'complete') return resolve();
  const t = setTimeout(resolve, 2500);
  pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); } });
});
const rdState = (text, on = false) => { $('#rdState').textContent = text; $('#rdState').classList.toggle('on', on); };

const rdConnected = () => {
  // the PC's name first: it's what stays visible on a narrow phone
  const how = rd.relay ? ' · via web' : '';
  rdState(rd.pcName ? `${rd.pcName} · ${rd.control ? 'in control' : 'watching'}${how}` : `connected${how} · ${rd.control ? 'mouse and keyboard on' : 'watching only'}`, true);
  $('#rdState').title = `connected${rd.pcName ? ` to ${rd.pcName}` : ''} · ${rd.control ? 'mouse and keyboard on' : 'watching only'}${rd.relay ? ' · through the web address (a direct connection was blocked)' : ''}`;
};
const rdUseControls = r => {
  rd.control = !!r.control;
  $('#rdKeys').hidden = !rd.control;
  $('#rdTouch').hidden = !rd.control || !matchMedia('(pointer: coarse)').matches;
  dot.hidden = !rd.control || !padMode;
  rdStage.classList.toggle('watch', !rd.control);
};

/* Through the web address (the backup when a direct connection is blocked, like behind a VPN):
   the stream PC sends pictures over the panel's own connection, and mouse and keyboard go back a
   few at a time. Slower than the direct video, but it works wherever the panel works. */
function relayStop() {
  if (!rd) return;
  if (rd.relayAbort) rd.relayAbort.abort();
  clearInterval(rd.relayFlush);
  rd.relayAbort = null; rd.relayFlush = null; rd.relayQueue = [];
}
async function relayConnect() {
  relayStop();
  if (rd.pc) { rd.pc.close(); rd.pc = null; rd.dc = null; }
  rdVideo.srcObject = null;
  rdVideo.hidden = true; rdCanvas.hidden = false;
  rdState('connecting through the web address…');
  const gen = rd.gen = (rd.gen || 0) + 1;
  let r;
  try {
    r = await api('/api/remote/start', { relay: true, password: rd.password, screen: $('#rdScreen').value, quality: $('#rdQuality').value });
  } catch (err) {
    rdState(err.message);
    if (/password|tries|access/.test(err.message)) { rdClose(false); toast(err.message, 4000); }
    return;
  }
  if (!rd || rd.gen !== gen) return;
  rdUseControls(r);
  const ctl = new AbortController();
  rd.relayAbort = ctl; rd.relayQueue = [];
  rd.relayFlush = setInterval(() => {
    if (!rd || !rd.relayQueue.length) return;
    const events = rd.relayQueue.splice(0);
    fetch('/api/remote/relay/input', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Stagelight': '1' }, body: JSON.stringify({ events }) }).catch(() => {});
  }, 50);
  let res;
  try { res = await fetch('/api/remote/relay', { credentials: 'same-origin', cache: 'no-store', signal: ctl.signal }); } catch { return; }
  if (!res.ok || !res.body) { rdState("couldn't open the picture through the web address"); return; }
  rdConnected();
  const reader = res.body.getReader();
  let buf = new Uint8Array(0), drawing = false, next = null;
  const draw = async bytes => {
    if (drawing) { next = bytes; return; } // still drawing the last one: keep only the newest
    drawing = true;
    try {
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      if (rd && rd.gen === gen) {
        const sized = rdCanvas.width !== bmp.width || rdCanvas.height !== bmp.height;
        if (sized) { rdCanvas.width = bmp.width; rdCanvas.height = bmp.height; }
        rdCtx.drawImage(bmp, 0, 0);
        if (sized) placeDot();
      }
      bmp.close();
    } catch { /* a broken picture: skip it */ }
    drawing = false;
    if (next) { const n = next; next = null; draw(n); }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const joined = new Uint8Array(buf.length + value.length); joined.set(buf); joined.set(value, buf.length); buf = joined;
      while (buf.length >= 5) {
        const len = new DataView(buf.buffer, buf.byteOffset + 1, 4).getUint32(0);
        if (buf.length < 5 + len) break;
        const kind = buf[0], body = buf.slice(5, 5 + len);
        buf = buf.slice(5 + len);
        if (kind === 1) draw(body);
        else if (kind === 2) {
          let msg; try { msg = JSON.parse(new TextDecoder().decode(body)); } catch { continue; }
          if (msg.t === 'end' && rd && rd.gen === gen) { rdClose(false); toast(`remote display ended: ${msg.why || 'on the stream PC'}`, 4000); return; }
          if (msg.t === 'note' && typeof msg.text === 'string') toast(msg.text.slice(0, 240), msg.text.length > 100 ? 8000 : 4000);
        }
      }
    }
  } catch { /* stopped (closed, or the line dropped) */ }
  // the line dropped without a goodbye: try again
  if (rd && rd.gen === gen && rd.relay) { rdState('connection dropped… trying again'); setTimeout(() => { if (rd && rd.gen === gen) relayConnect(); }, 2000); }
}

async function rdConnect() {
  if (!rd) return;
  if (rd.relay) return relayConnect();
  if (rd.pc) rd.pc.close();
  rdVideo.hidden = false; rdCanvas.hidden = true;
  const gen = rd.gen = (rd.gen || 0) + 1;
  // no direct connection after 12 s (or it failed): through the web address instead
  const fallBack = why => {
    if (!rd || rd.gen !== gen || rd.relay) return;
    rd.relay = true;
    toast(`${why}: showing the PC through the web address instead (a little slower)`, 5000);
    relayConnect();
  };
  clearTimeout(rd.fallTimer);
  rd.fallTimer = setTimeout(() => { if (rd && rd.gen === gen && rd.pc && rd.pc.connectionState !== 'connected') fallBack("couldn't connect directly (a VPN or the network blocks it)"); }, 12_000);
  rdState(rd.pcName ? `connecting to ${rd.pcName}…` : 'connecting…');
  zoomReset();
  const pc = new RTCPeerConnection({ iceServers: (rd.ice || []).map(u => ({ urls: u })) });
  const dc = pc.createDataChannel('input', { ordered: true });
  // the stream PC ended it (its stop button, switched off, or someone else took over)
  dc.onmessage = m => {
    let msg; try { msg = JSON.parse(m.data); } catch { return; }
    if (msg.t === 'end' && rd && rd.pc === pc) { rdClose(false); toast(`remote display ended: ${msg.why || 'on the stream PC'}`, 4000); }
    if (msg.t === 'note' && rd && rd.pc === pc && typeof msg.text === 'string') toast(msg.text.slice(0, 240), msg.text.length > 100 ? 8000 : 4000);
  };
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.ontrack = e => { rdVideo.srcObject = e.streams[0] || new MediaStream([e.track]); };
  pc.onconnectionstatechange = () => {
    if (!rd || rd.pc !== pc) return;
    if (pc.connectionState === 'connected') { clearTimeout(rd.fallTimer); rdConnected(); }
    if (pc.connectionState === 'failed') fallBack("couldn't connect directly (a VPN or the network blocks it)");
    if (pc.connectionState === 'disconnected') rdState('connection dropped… waiting');
  };
  Object.assign(rd, { pc, dc });
  await pc.setLocalDescription(await pc.createOffer());
  await iceDone(pc);
  try {
    const r = await api('/api/remote/start', { password: rd.password, sdp: pc.localDescription.sdp, screen: $('#rdScreen').value, quality: $('#rdQuality').value });
    if (!rd || rd.pc !== pc) return;
    rdUseControls(r);
    await pc.setRemoteDescription({ type: 'answer', sdp: r.sdp });
  } catch (err) {
    rdState(err.message);
    if (/password|tries|access/.test(err.message)) { rdClose(false); toast(err.message, 4000); }
  }
}

$('#remoteOpen').onclick = async () => {
  const info = await remoteInfo();
  if (!info.view) return toast('the remote display was switched off on the stream PC');
  const v = await form('open the full screen', `type your password again (${me.user}): the remote display shows (and may control) the whole stream PC.`, [
    { name: 'password', label: 'your password', type: 'password', required: true },
  ], 'open');
  if (!v) return;
  $('#rdScreen').replaceChildren(...(info.screens || []).map(sc => { const o = document.createElement('option'); o.value = sc.id; o.textContent = sc.name; return o; }));
  $('#rdScreen').hidden = (info.screens || []).length < 2;
  rd = { password: v.password, control: false, ice: info.ice || [], pcName: String(info.pcName || '').slice(0, 64) };
  $('#rd').hidden = false;
  $('#rdKeyPad').hidden = true;
  Object.assign(cursor, { x: 0.5, y: 0.5 });
  showPadMode();
  rdStage.focus();
  rdConnect();
};
function rdClose(tell = true) {
  if (!rd) return;
  const was = rd;
  relayStop();
  clearTimeout(was.fallTimer);
  rd = null;
  if (was.pc) was.pc.close();
  rdVideo.srcObject = null;
  rdCanvas.width = rdCanvas.height = 1;
  zoomReset();
  $('#rd').hidden = true;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (tell) api('/api/remote/stop', {}).catch(() => {});
  remoteInfo();
}
$('#rdEnd').onclick = () => rdClose();
$('#rdScreen').onchange = $('#rdQuality').onchange = () => rdConnect();
$('#rdFull').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : $('#rd').requestFullscreen()).catch(() => {});
$('#rdKeys').onclick = () => { $('#rdKeyPad').hidden = !$('#rdKeyPad').hidden; };

const rdSend = m => {
  if (!rd || !rd.control) return;
  if (rd.relay) {
    // through the web address: a few at a time; of several moves in a row only the last one matters
    const q = rd.relayQueue;
    if (!q) return;
    if (m.t === 'm' && q.length && q[q.length - 1].t === 'm') q[q.length - 1] = m; else if (q.length < 300) q.push(m);
    return;
  }
  if (rd.dc && rd.dc.readyState === 'open') rd.dc.send(JSON.stringify(m));
};
// a place on the video → 0…1 across the PC's screen (the picture is letterboxed to fit)
function rdAt(e) {
  const v = rdView(), r = v.el.getBoundingClientRect(), vw = v.w, vh = v.h;
  if (!vw || !vh || vw < 2) return null;
  const k = Math.min(r.width / vw, r.height / vh), w = vw * k, h = vh * k;
  const x = (e.clientX - r.left - (r.width - w) / 2) / w, y = (e.clientY - r.top - (r.height - h) / 2) / h;
  return x < 0 || y < 0 || x > 1 || y > 1 ? null : { x, y };
}

// mouse (and pen): like a normal mouse
let moveQueued = null;
const queueMove = p => {
  if (!moveQueued) requestAnimationFrame(() => { if (moveQueued) rdSend({ t: 'm', ...moveQueued }); moveQueued = null; });
  moveQueued = p;
};
/* touch, two ways (the button in the bar switches, and the phone remembers it):
   direct:   tap = click where you tap, hold = right-click, drag = drag, two fingers = scroll
   trackpad: slide = move the cursor, tap = click, two-finger tap or hold = right-click,
             tap then touch again and slide = drag, two fingers = scroll */
let padMode = false;
try { padMode = localStorage.getItem('stagelight:touch') === 'pad'; } catch { /* private mode */ }
const cursor = { x: 0.5, y: 0.5 };
const dot = document.createElement('i');
dot.className = 'rd-dot';
rdStage.append(dot);
function showPadMode() {
  $('#rdTouch').textContent = padMode ? 'trackpad' : 'direct touch';
  $('#rdTouch').setAttribute('aria-pressed', String(padMode));
  dot.hidden = !padMode;
  placeDot();
}
function placeDot() {
  const v = rdView(), r = v.el.getBoundingClientRect(), s = rdStage.getBoundingClientRect(), vw = v.w, vh = v.h;
  if (!vw || !vh || vw < 2) return;
  const k = Math.min(r.width / vw, r.height / vh), w = vw * k, h = vh * k;
  dot.style.left = `${r.left - s.left + (r.width - w) / 2 + cursor.x * w}px`;
  dot.style.top = `${r.top - s.top + (r.height - h) / 2 + cursor.y * h}px`;
}
$('#rdTouch').onclick = () => {
  padMode = !padMode;
  try { localStorage.setItem('stagelight:touch', padMode ? 'pad' : 'direct'); } catch { /* fine */ }
  showPadMode();
  toast(padMode ? 'trackpad: slide to move, tap to click, two fingers to right-click or scroll' : 'direct touch: tap where you want to click');
};
rdVideo.addEventListener('resize', placeDot);
window.addEventListener('resize', () => zoomApply());

const pad = { fingers: new Map(), start: 0, moved: 0, lastTapEnd: 0, dragging: false, scrollY: 0, two: false, timer: null, held: false, sx: 0, sy: 0, from: null };
/* A tap, like on a laptop trackpad: short (under 400 ms) and ending close to where it started
   (22 px), however much the finger wobbled on the way. The click goes where the pointer was
   before the wobble. */
const TAP_MS = 400, TAP_PX = 22;
const padNet = e => Math.hypot(e.clientX - pad.sx, e.clientY - pad.sy);
function padMove(dx, dy) {
  const v = rdView(), r = v.el.getBoundingClientRect(), vw = v.w, vh = v.h;
  if (!vw || vw < 2) return;
  const k = Math.min(r.width / vw, r.height / vh);
  // quicker swipes go further (like a laptop trackpad)
  const speed = Math.hypot(dx, dy), gain = speed > 12 ? 1.9 : speed > 5 ? 1.3 : 1;
  cursor.x = Math.max(0, Math.min(1, cursor.x + dx * gain / (vw * k)));
  cursor.y = Math.max(0, Math.min(1, cursor.y + dy * gain / (vh * k)));
  placeDot();
  zoomFollow();
  queueMove({ x: cursor.x, y: cursor.y });
}
const padClick = b => { rdSend({ t: 'b', b, d: true, ...cursor }); rdSend({ t: 'b', b, d: false, ...cursor }); };
function padDown(e) {
  pad.fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pad.fingers.size === 2) {
    clearTimeout(pad.timer);
    pad.two = true; pad.moved = 0; pad.start = Date.now();
    pad.scrollY = [...pad.fingers.values()].reduce((a, f) => a + f.y, 0) / 2;
    return;
  }
  if (pad.fingers.size > 2) return;
  pad.two = false; pad.moved = 0; pad.held = false; pad.start = Date.now();
  pad.sx = e.clientX; pad.sy = e.clientY; pad.from = { x: cursor.x, y: cursor.y };
  // touching again right after a tap: hold the button down and drag
  if (Date.now() - pad.lastTapEnd < 280) { pad.dragging = true; rdSend({ t: 'b', b: 0, d: true, ...cursor }); return; }
  pad.timer = setTimeout(() => {
    if (pad.net < TAP_PX && !pad.two) { pad.held = true; padClick(2); if (navigator.vibrate) navigator.vibrate(15); }
  }, 600);
  pad.net = 0;
}
function padMoveEvent(e) {
  const f = pad.fingers.get(e.pointerId);
  if (!f) return;
  const dx = e.clientX - f.x, dy = e.clientY - f.y;
  f.x = e.clientX; f.y = e.clientY;
  if (pad.two) {
    pad.moved += Math.hypot(dx, dy);
    const y = [...pad.fingers.values()].reduce((a, g) => a + g.y, 0) / pad.fingers.size;
    const d = pad.scrollY - y;
    if (Math.abs(d) > 6 && !zoomBusy()) { rdSend({ t: 'w', dy: d * 4 }); pad.scrollY = y; }
    return;
  }
  pad.moved += Math.hypot(dx, dy);
  pad.net = padNet(e);
  if (pad.net >= TAP_PX) clearTimeout(pad.timer);
  if (!pad.held) padMove(dx, dy);
}
function padUp(e) {
  pad.fingers.delete(e.pointerId);
  if (pad.fingers.size) return; // wait for the last finger
  clearTimeout(pad.timer);
  const quick = Date.now() - pad.start < TAP_MS, small = padNet(e) < TAP_PX;
  if (pad.two) { if (quick && pad.moved < 40) padClick(2); pad.two = false; return; }
  if (pad.dragging) { pad.dragging = false; rdSend({ t: 'b', b: 0, d: false, ...cursor }); if (quick && small) padClick(0); return; }
  if (!pad.held && quick && small && e.type === 'pointerup') {
    // the wobble isn't a move: back to where the pointer was, then the click
    if (pad.from) { Object.assign(cursor, pad.from); placeDot(); rdSend({ t: 'm', x: cursor.x, y: cursor.y, f: 1 }); }
    padClick(0);
    pad.lastTapEnd = Date.now();
  }
}

/* Zoom, like AnyDesk on a phone: pinch to zoom in (up to 5×) on the spot between the fingers,
   and move both fingers to look around while zoomed. Two fingers sliding together (without
   pinching) still scroll the PC. ctrl + wheel (or a laptop's trackpad pinch) zooms too. Watching
   only, one finger moves around a zoomed picture. Places sent to the PC take the zoom into
   account (they're measured on the picture as it's shown). */
const zoom = { k: 1, x: 0, y: 0 };
const zf = new Map();   // every finger on the picture
let zg = null;          // a two-finger gesture: { d0, m0, k0, x0, y0, mode: null | 'zoom' | 'scroll' }
function zoomApply() {
  const s = rdStage.getBoundingClientRect();
  zoom.k = Math.max(1, Math.min(5, zoom.k));
  // the picture always covers the screen: no empty space past its edges
  zoom.x = Math.min(0, Math.max(s.width * (1 - zoom.k), zoom.x));
  zoom.y = Math.min(0, Math.max(s.height * (1 - zoom.k), zoom.y));
  if (zoom.k < 1.02) Object.assign(zoom, { k: 1, x: 0, y: 0 });
  rdVideo.style.transform = rdCanvas.style.transform = zoom.k === 1 ? '' : `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.k})`;
  $('#rdZoom').hidden = zoom.k === 1;
  $('#rdZoom').textContent = `${zoom.k.toFixed(1)}× · reset`;
  placeDot();
}
function zoomReset() { Object.assign(zoom, { k: 1, x: 0, y: 0 }); zg = null; zf.clear(); zoomApply(); }
// zoom to k, keeping the point (px, py) on the screen where it is
function zoomAt(k, px, py) {
  const s = rdStage.getBoundingClientRect(), ux = (px - s.left - zoom.x) / zoom.k, uy = (py - s.top - zoom.y) / zoom.k;
  zoom.k = Math.max(1, Math.min(5, k));
  zoom.x = px - s.left - ux * zoom.k; zoom.y = py - s.top - uy * zoom.k;
  zoomApply();
}
$('#rdZoom').onclick = () => { zoomReset(); rdStage.focus(); };
// in trackpad mode the view follows the pointer when it gets near an edge
function zoomFollow() {
  if (zoom.k === 1 || dot.hidden) return;
  const s = rdStage.getBoundingClientRect(), x = parseFloat(dot.style.left), y = parseFloat(dot.style.top), m = 40;
  let dx = 0, dy = 0;
  if (x < m) dx = m - x; else if (x > s.width - m) dx = s.width - m - x;
  if (y < m) dy = m - y; else if (y > s.height - m) dy = s.height - m - y;
  if (dx || dy) { zoom.x += dx; zoom.y += dy; zoomApply(); }
}
const mid = () => { const f = [...zf.values()]; return { x: (f[0].x + f[1].x) / 2, y: (f[0].y + f[1].y) / 2, d: Math.hypot(f[0].x - f[1].x, f[0].y - f[1].y) }; };
// true when the zoom gesture takes this event (the PC doesn't get it)
function zoomDown(e) {
  if (e.pointerType !== 'touch' || !rd) return false;
  zf.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
  if (zf.size === 2) { const m = mid(); zg = { d0: m.d, m0: m, k0: zoom.k, x0: zoom.x, y0: zoom.y, mode: null }; }
  return !rd.control;
}
function zoomMove(e) {
  if (e.pointerType !== 'touch' || !rd) return false;
  const f = zf.get(e.pointerId);
  if (!f) return false;
  const px = f.x, py = f.y;
  f.x = e.clientX; f.y = e.clientY;
  if (zg && zf.size >= 2) {
    const m = mid();
    if (!zg.mode) {
      if (Math.abs(m.d - zg.d0) > 22) zg.mode = 'zoom';
      else if (Math.hypot(m.x - zg.m0.x, m.y - zg.m0.y) > 14) zg.mode = rd.control ? 'scroll' : 'zoom';
    }
    if (zg.mode === 'zoom') {
      const s = rdStage.getBoundingClientRect();
      const ux = (zg.m0.x - s.left - zg.x0) / zg.k0, uy = (zg.m0.y - s.top - zg.y0) / zg.k0;
      zoom.k = Math.max(1, Math.min(5, zg.k0 * m.d / Math.max(1, zg.d0)));
      zoom.x = m.x - s.left - ux * zoom.k; zoom.y = m.y - s.top - uy * zoom.k;
      zoomApply();
      return true;
    }
    return zg.mode !== 'scroll'; // not decided yet: wait before scrolling
  }
  // watching only: one finger looks around a zoomed picture
  if (!rd.control && zoom.k > 1 && zf.size === 1) { zoom.x += e.clientX - px; zoom.y += e.clientY - py; zoomApply(); return true; }
  return !rd.control;
}
function zoomUp(e) {
  if (e.pointerType !== 'touch' || !rd) return false;
  const was = zg && zg.mode === 'zoom';
  zf.delete(e.pointerId);
  if (zf.size < 2) zg = was ? { done: true, mode: 'zoom' } : null;
  if (!zf.size && zg && zg.done) { zg = null; return true; }
  return was || !rd.control;
}
const zoomBusy = () => !!(zg && zg.mode === 'zoom');

const touches = new Map();
let touch = null;
rdStage.addEventListener('pointerdown', e => {
  if (zoomDown(e)) { e.preventDefault(); return; }
  if (!rd || !rd.control) return;
  rdStage.focus();
  const p = rdAt(e);
  if (e.pointerType !== 'touch') {
    if (!p) return;
    e.preventDefault();
    rdSend({ t: 'b', b: e.button, d: true, ...p });
    rdStage.setPointerCapture(e.pointerId);
    return;
  }
  if (padMode) { e.preventDefault(); padDown(e); return; }
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touches.size === 2) { if (touch && touch.timer) clearTimeout(touch.timer); touch = { scroll: true, y: (e.clientY + [...touches.values()][0].y) / 2 }; return; }
  if (!p) return;
  Object.assign(cursor, p);
  touch = { start: p, sx: e.clientX, sy: e.clientY, dragging: false, done: false };
  touch.timer = setTimeout(() => {
    if (!touch || touch.dragging || touch.scroll) return;
    touch.done = true;
    rdSend({ t: 'b', b: 2, d: true, ...p }); rdSend({ t: 'b', b: 2, d: false, ...p });
    if (navigator.vibrate) navigator.vibrate(15);
  }, 550);
});
rdStage.addEventListener('pointermove', e => {
  if (zoomMove(e)) {
    // a pinch cancels what one finger had started (a click or a hold)
    if (zoomBusy()) {
      if (touch && touch.timer) clearTimeout(touch.timer);
      if (touch) touch.done = true;
      clearTimeout(pad.timer); pad.moved = 99;
    }
    return;
  }
  if (!rd || !rd.control) return;
  if (e.pointerType !== 'touch') { const p = rdAt(e); if (p) { queueMove(p); Object.assign(cursor, p); } return; }
  if (padMode) { padMoveEvent(e); return; }
  const t = touches.get(e.pointerId);
  if (t) { t.x = e.clientX; t.y = e.clientY; }
  if (!touch) return;
  if (touch.scroll && touches.size >= 2) {
    const y = [...touches.values()].reduce((a, b) => a + b.y, 0) / touches.size;
    const dy = touch.y - y;
    if (Math.abs(dy) > 6 && !zoomBusy()) { rdSend({ t: 'w', dy: dy * 4 }); touch.y = y; }
    return;
  }
  if (touch.done || touch.scroll) return;
  const p = rdAt(e);
  if (!touch.dragging && Math.hypot(e.clientX - touch.sx, e.clientY - touch.sy) > 10) {
    clearTimeout(touch.timer);
    touch.dragging = true;
    rdSend({ t: 'b', b: 0, d: true, ...touch.start });
  }
  if (touch.dragging && p) queueMove(p);
});
const pointerEnd = e => {
  const zoomed = zoomUp(e);
  if (zoomed) {
    // the fingers of a pinch are forgotten, without a click
    touches.delete(e.pointerId); pad.fingers.delete(e.pointerId);
    if (!touches.size) touch = null;
    if (!pad.fingers.size) { pad.two = false; pad.dragging = false; }
    return;
  }
  if (!rd || !rd.control) return;
  if (e.pointerType !== 'touch') {
    const p = rdAt(e) || {};
    rdSend({ t: 'b', b: e.button, d: false, ...p });
    return;
  }
  if (padMode) { padUp(e); return; }
  touches.delete(e.pointerId);
  if (!touch) return;
  clearTimeout(touch.timer);
  if (touch.scroll) { if (!touches.size) touch = null; return; }
  if (touch.dragging) rdSend({ t: 'b', b: 0, d: false, ...(rdAt(e) || {}) });
  else if (!touch.done && e.type === 'pointerup') { rdSend({ t: 'b', b: 0, d: true, ...touch.start }); rdSend({ t: 'b', b: 0, d: false, ...touch.start }); }
  touch = null;
};
rdStage.addEventListener('pointerup', pointerEnd);
rdStage.addEventListener('pointercancel', pointerEnd);
rdStage.addEventListener('contextmenu', e => e.preventDefault());
rdStage.addEventListener('wheel', e => {
  if (rd && e.ctrlKey) { e.preventDefault(); zoomAt(zoom.k * Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0025)), e.clientX, e.clientY); return; }
  if (!rd || !rd.control) return;
  e.preventDefault();
  const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1;
  rdSend({ t: 'w', dy: e.deltaY * k, dx: e.deltaX * k });
}, { passive: false });

// a real keyboard: everything typed while the screen is focused goes to the PC
rdStage.addEventListener('keydown', e => { if (!rd || !rd.control) return; e.preventDefault(); rdSend({ t: 'k', code: e.code, d: true }); });
rdStage.addEventListener('keyup', e => { if (!rd || !rd.control) return; e.preventDefault(); rdSend({ t: 'k', code: e.code, d: false }); });
rdStage.addEventListener('blur', () => { /* let go of keys the browser won't tell us about */ for (const c of ['ShiftLeft', 'ControlLeft', 'AltLeft', 'MetaLeft']) rdSend({ t: 'k', code: c, d: false }); });

// phones: a text box, held-down ctrl / alt / shift / win, and the keys phones don't have
const mods = new Set();
$('#rdMods').onclick = e => {
  const b = e.target.closest('[data-mod]');
  if (!b) return;
  const m = b.dataset.mod;
  if (mods.has(m)) mods.delete(m); else mods.add(m);
  b.setAttribute('aria-pressed', String(mods.has(m)));
};
function pressWithMods(code) {
  for (const m of mods) rdSend({ t: 'k', code: m, d: true });
  rdSend({ t: 'k', code, d: true }); rdSend({ t: 'k', code, d: false });
  for (const m of mods) rdSend({ t: 'k', code: m, d: false });
  mods.clear();
  $('#rdMods').querySelectorAll('[data-mod]').forEach(b => b.setAttribute('aria-pressed', 'false'));
}
$('#rdSpecial').onclick = e => { const b = e.target.closest('[data-key]'); if (b) pressWithMods(b.dataset.key); };
$('#rdSend').onclick = () => {
  const text = $('#rdText').value;
  if (!text) return;
  // with ctrl / alt held, one letter is a shortcut (ctrl + s, alt + f, …)
  if (mods.size && /^[a-z0-9]$/i.test(text)) pressWithMods(/\d/.test(text) ? `Digit${text}` : `Key${text.toUpperCase()}`);
  else rdSend({ t: 'txt', s: text });
  $('#rdText').value = '';
};
$('#rdText').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#rdSend').click(); } });

/* ───────────── go live / end stream / record ───────────── */
function ask(title, text, yes) {
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  $('#confirmYes').textContent = yes;
  $('#confirm').hidden = false;
  return new Promise(resolve => {
    const done = ok => { $('#confirm').hidden = true; resolve(ok); };
    $('#confirmYes').onclick = () => done(true);
    $('#confirmNo').onclick = () => done(false);
  });
}
$('#streamBtn').onclick = async () => {
  if (!st) return;
  const live = st.stream.active;
  const ok = await ask(live ? 'end the stream?' : 'go live?', live ? 'your stream stops for everyone watching.' : 'OBS starts streaming right away.', live ? 'end stream' : 'go live');
  if (ok) act({ type: 'stream', on: !live }, () => toast(live ? 'ending the stream…' : 'going live… ✦'));
};
$('#recBtn').onclick = async () => {
  if (!st) return;
  if (st.record.active && !(await ask('stop recording?', 'the recording is saved where OBS saves recordings.', 'stop'))) return;
  act({ type: 'record', on: !st.record.active });
};
/* ───────────── file transfer (remote display, full access) ─────────────
   Browse the stream PC's drives and folders, download files (folders as a .zip), upload files
   or whole folders into the folder that's open, and make folders. */
let fmPath = '', fmBusy = false;
const fmSize = n => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
const fmStatus = (text, bad = false) => { $('#fmStatus').textContent = text; $('#fmStatus').classList.toggle('bad', bad); };
const fmIcon = id => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('class', 'ico'); const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', `#${id}`); s.append(u); return s; };
async function fmApi(path, body) {
  try { return await api(path, body); } catch (err) {
    if (/password again/.test(err.message)) { fmLocked(); throw new Error('locked'); }
    throw err;
  }
}
function fmLocked() { $('#fmLock').hidden = false; $('#fmMain').hidden = true; $('#fmUser').textContent = me.user; setTimeout(() => $('#fmPass').focus(), 50); }
async function openFiles() {
  $('#fm').hidden = false;
  let st;
  try { st = await api('/api/files/state'); } catch (err) { $('#fm').hidden = true; return toast(err.message, 4000); }
  if (!st.unlocked) return fmLocked();
  $('#fmLock').hidden = true; $('#fmMain').hidden = false;
  fmGo(fmPath);
}
$('#fmLock').onsubmit = async e => {
  e.preventDefault();
  try { await api('/api/files/unlock', { password: $('#fmPass').value }); } catch (err) { return toast(err.message, 4000); } finally { $('#fmPass').value = ''; }
  $('#fmLock').hidden = true; $('#fmMain').hidden = false;
  fmGo(fmPath);
};
async function fmGo(path) {
  let r;
  fmStatus('loading…');
  try { r = await fmApi(`/api/files/list?path=${encodeURIComponent(path)}`); } catch (err) { if (err.message !== 'locked') fmStatus(err.message, true); return; }
  fmPath = r.path; $('#fmPath').value = r.path;
  $('#fmUp').disabled = r.parent == null;
  $('#fmUp').dataset.to = r.parent ?? '';
  for (const id of ['#fmUpFiles', '#fmUpFolder', '#fmMkdir', '#fmZip']) $(id).disabled = !r.path;
  fmStatus(r.path ? `${r.entries.length} item${r.entries.length === 1 ? '' : 's'}${r.more ? ` (and ${r.more} more not shown)` : ''}` : 'pick a drive');
  const list = $('#fmList');
  list.replaceChildren(...r.entries.map(en => {
    const li = document.createElement('li');
    li.append(fmIcon(!r.path ? 'i-drive' : en.dir ? 'i-folder' : 'i-file'));
    const nm = document.createElement('button');
    nm.type = 'button'; nm.className = `nm${en.dir ? '' : ' file'}`; nm.textContent = en.name; nm.title = en.path;
    if (en.dir) nm.onclick = () => fmGo(en.path);
    const meta = document.createElement('span'); meta.className = 'meta';
    meta.textContent = [en.dir ? '' : fmSize(en.size), en.mtime ? new Date(en.mtime).toLocaleDateString() : ''].filter(Boolean).join(' · ');
    li.append(nm, meta);
    if (r.path) {
      const dl = document.createElement('a');
      dl.className = 'dl'; dl.href = `/api/files/download?path=${encodeURIComponent(en.path)}${en.dir ? '&zip=1' : ''}`; // the stream PC names the file
      dl.title = en.dir ? 'download the folder (.zip)' : 'download';
      dl.setAttribute('aria-label', `download ${en.name}`);
      dl.innerHTML = '<svg><use href="#i-down"/></svg>';
      dl.onclick = () => toast(en.dir ? `zipping and downloading ${en.name}…` : `downloading ${en.name}…`);
      li.append(dl);
    }
    return li;
  }));
  if (!r.entries.length) list.innerHTML = '<li class="empty">this folder is empty</li>';
  list.scrollTop = 0;
}
$('#fmUp').onclick = () => fmGo($('#fmUp').dataset.to || '');
$('#fmRoots').onclick = () => fmGo('');
$('#fmPath').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); fmGo($('#fmPath').value.trim()); } };
$('#fmZip').onclick = () => { if (!fmPath) return; const a = document.createElement('a'); a.href = `/api/files/download?path=${encodeURIComponent(fmPath)}&zip=1`; document.body.append(a); a.click(); a.remove(); toast('zipping and downloading this folder…'); };
$('#fmMkdir').onclick = async () => {
  const v = await form('new folder', `in ${fmPath}`, [{ name: 'name', label: 'folder name', required: true, placeholder: 'New folder' }], 'make it');
  if (!v) return;
  try { const r = await fmApi('/api/files/mkdir', { dir: fmPath, name: v.name }); toast(`made ${r.name} ✦`); fmGo(fmPath); } catch (err) { if (err.message !== 'locked') toast(err.message, 4000); }
};
$('#fmUpFiles').onclick = () => { $('#fmFileIn').value = ''; $('#fmFileIn').click(); };
$('#fmUpFolder').onclick = () => { $('#fmDirIn').value = ''; $('#fmDirIn').click(); };
// one file after the other, each into the folder that's open (a folder keeps its own folders)
async function fmUpload(list) {
  const items = [...list];
  if (!items.length || fmBusy) return;
  fmBusy = true;
  const dir = fmPath, total = items.reduce((n, f) => n + f.size, 0);
  let done = 0, ok = 0, failed = 0;
  for (const [i, f] of items.entries()) {
    const rel = f.webkitRelativePath || f.name;
    try {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/files/upload?dir=${encodeURIComponent(dir)}&rel=${encodeURIComponent(rel)}`);
        xhr.setRequestHeader('X-Stagelight', '1');
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = e => fmStatus(`uploading ${i + 1} of ${items.length}: ${rel} · ${Math.round((done + e.loaded) / Math.max(1, total) * 100)}%`);
        xhr.onload = () => { let r = {}; try { r = JSON.parse(xhr.responseText); } catch { /* not JSON */ } if (xhr.status === 200) resolve(); else reject(new Error(r.error || (xhr.status === 413 ? 'too big for this connection' : `error ${xhr.status}`))); };
        xhr.onerror = () => reject(new Error("the upload didn't get through"));
        xhr.send(f);
      });
      ok++;
    } catch (err) {
      failed++;
      if (/password again/.test(err.message)) { fmBusy = false; return fmLocked(); }
      toast(`${rel}: ${err.message}`, 5000);
    }
    done += f.size;
  }
  fmBusy = false;
  if (fmPath === dir) await fmGo(dir);
  fmStatus(`uploaded ${ok} file${ok === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''} ✦`, !!failed);
}
$('#fmFileIn').onchange = () => fmUpload($('#fmFileIn').files);
$('#fmDirIn').onchange = () => fmUpload($('#fmDirIn').files);
$('#fmClose').onclick = () => { if (fmBusy && !confirm('an upload is still going. close anyway? (it keeps going in the background)')) return; $('#fm').hidden = true; };
$('#filesOpen').onclick = openFiles;
$('#rdFiles').onclick = openFiles;

/* ───────────── OBS's own settings (full access only) ───────────── */
function obsField(label, input) {
  const l = document.createElement('label'); l.className = 'field';
  const sp = document.createElement('span'); sp.textContent = label;
  l.append(sp, input); return l;
}
function obsInput(type, value, attrs = {}) {
  const i = document.createElement('input'); i.type = type; if (value != null) i.value = value;
  for (const [k, v] of Object.entries(attrs)) i.setAttribute(k, v);
  return i;
}
function obsSelect(options, value) {
  const s = document.createElement('select');
  for (const o of options) { const e = document.createElement('option'); e.value = String(o[0]); e.textContent = o[1]; s.append(e); }
  s.value = String(value); return s;
}
function obsSection(title, notes, fields, button, save) {
  const sec = document.createElement('section'); sec.className = 'obs-sec';
  const h = document.createElement('h4'); h.textContent = title; sec.append(h);
  for (const [text, warn] of notes) { if (!text) continue; const p = document.createElement('p'); p.className = `note${warn ? ' warn' : ''}`; p.textContent = text; sec.append(p); }
  sec.append(...fields);
  if (button) {
    const b = document.createElement('button'); b.className = 'btn primary'; b.type = 'button'; b.textContent = button;
    b.onclick = async () => {
      b.disabled = true;
      try { const r = await api('/api/obs-settings', save()); toast(`saved: ${r.what} ✦`); await openObs(); } catch (err) { toast(err.message, 5000); } finally { b.disabled = false; }
    };
    sec.append(b);
  }
  return sec;
}
async function openObs() {
  let s;
  try { s = await api('/api/obs-settings'); } catch (err) { return toast(err.message, 4000); }
  $('#obsModal').hidden = false;
  $('#obsNote').textContent = s.busy ? "you're live or recording: the stream, video, profile and scene collection can only be changed once both are stopped." : 'changes go straight to OBS on the stream PC.';
  const secs = [];
  if (s.stream) {
    const custom = s.stream.type === 'rtmp_custom';
    const server = obsInput('text', s.stream.server, { spellcheck: 'false', autocomplete: 'off', placeholder: custom ? 'rtmp://' : 'auto' });
    const key = obsInput('password', '', { autocomplete: 'new-password', spellcheck: 'false', placeholder: s.stream.keySet ? 'saved ✓ (type a new one to replace it)' : 'not set' });
    secs.push(obsSection('stream', [[custom ? 'custom server' : `service: ${s.stream.service || s.stream.type}`], ['the key is never shown here: you can only replace it.']],
      [obsField('server', server), obsField('stream key', key)], 'save stream', () => ({ group: 'stream', server: server.value, key: key.value })));
  }
  {
    const simple = s.output.mode !== 'Advanced';
    const vb = obsInput('number', s.output.vbitrate || 6000, { min: 200, max: 100000, step: 100 });
    const ab = obsSelect([64, 96, 128, 160, 192, 256, 320].map(n => [n, `${n} kbps`]), s.output.abitrate || 160);
    secs.push(simple
      ? obsSection('output', [['used from the next time you go live or record.']], [Object.assign(document.createElement('div'), { className: 'two' })], 'save bitrate', () => ({ group: 'output', vbitrate: Number(vb.value), abitrate: Number(ab.value) }))
      : obsSection('output', [["OBS is in advanced output mode: the bitrate and encoder are set in OBS itself (Settings → Output).", true]], [], null));
    if (simple) secs.at(-1).querySelector('.two').append(obsField('video bitrate (kbps)', vb), obsField('audio bitrate', ab));
  }
  if (s.video) {
    const two = () => Object.assign(document.createElement('div'), { className: 'two' });
    const bw = obsInput('number', s.video.baseW, { min: 32, max: 7680 }), bh = obsInput('number', s.video.baseH, { min: 32, max: 4320 });
    const ow = obsInput('number', s.video.outW, { min: 32, max: 7680 }), oh = obsInput('number', s.video.outH, { min: 32, max: 4320 });
    const fps = obsSelect([24, 25, 29.97, 30, 48, 50, 59.94, 60, 120].map(n => [n, `${n} fps`]), s.video.fps);
    const r1 = two(); r1.append(obsField('canvas width', bw), obsField('canvas height', bh));
    const r2 = two(); r2.append(obsField('output width', ow), obsField('output height', oh));
    secs.push(obsSection('video', [['the canvas is what you lay out; the output is what viewers get.'], s.busy ? ['stop the stream and the recording to change this.', true] : ['']],
      [r1, r2, obsField('frame rate', fps)], 'save video', () => ({ group: 'video', baseW: bw.value, baseH: bh.value, outW: ow.value, outH: oh.value, fps: fps.value })));
  }
  if (s.recordDir != null) {
    const dir = obsInput('text', s.recordDir, { spellcheck: 'false' });
    secs.push(obsSection('recording', [['the folder on the stream PC where OBS saves recordings.']], [obsField('folder', dir)], 'save folder', () => ({ group: 'recordDir', dir: dir.value })));
  }
  for (const [g, title, info] of [['profile', 'profile', s.profile], ['collection', 'scene collection', s.collection]]) {
    if (!info || info.all.length < 2) continue;
    const sel = obsSelect(info.all.map(n => [n, n]), info.now);
    secs.push(obsSection(title, [[g === 'collection' ? 'switching swaps every scene and source for that collection’s.' : 'a profile holds its own stream, output and video settings.']], [obsField(title, sel)], `switch ${title}`, () => ({ group: g, name: sel.value })));
  }
  $('#obsBody').replaceChildren(...secs);
}
$('#obsOpen').onclick = openObs;
$('#obsClose').onclick = () => { $('#obsModal').hidden = true; $('#obsBody').replaceChildren(); };

$('#refreshAll').onclick = () => act({ type: 'refreshAll' }, () => toast('refreshed every browser source ✦'));
$('#recPauseBtn').onclick = () => st && act({ type: 'recordPause', on: !st.record.paused });

/* ───────────── start ───────────── */
fetch('/api/state', { credentials: 'same-origin' })
  .then(r => (r.ok ? r.json().then(s => { showPanel(); apply(s); }) : showLogin()))
  .catch(showLogin);
