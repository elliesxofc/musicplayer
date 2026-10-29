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
  setTimeout(() => $('#password').focus(), 50);
}
function showPanel() {
  $('#loginView').hidden = true;
  $('#panelView').hidden = false;
  listen();
  remoteInfo();
}
$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  $('#loginBtn').disabled = true;
  $('#loginError').textContent = '';
  try {
    await api('/api/login', { password: $('#password').value });
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

function renderScenes() {
  const box = $('#scenes');
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
    li.append(name, b);
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
  // don't redraw under a finger that's moving a slider
  if (dragging) {
    const a = st.audio.find(x => x.name === dragging);
    const row = [...list.children].find(li => li.dataset.name === dragging);
    if (a && row) { row.classList.toggle('muted', a.muted); return; }
  }
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
    let sendTimer = null;
    range.oninput = () => {
      dragging = a.name;
      const mul = toMul(Number(range.value));
      db.textContent = dbText(mul);
      clearTimeout(sendTimer);
      sendTimer = setTimeout(() => act({ type: 'volume', input: a.name, mul }), 60);
    };
    range.onchange = () => { setTimeout(() => { dragging = null; }, 400); };
    vol.append(range, db);
    li.append(name, b, vol);
    list.append(li);
  }
  if (!st.audio.length) list.innerHTML = '<li class="empty">no audio sources</li>';
}

/* ───────────── preview: what OBS shows, and the layout of the scene ───────────── */
let selected = null, drag = null, lastShot = null;
const stage = $('#stage'), boxes = $('#boxes');
const editing = () => $('#editOn').checked;

// the picture: about once a second while the panel is open (it pauses in the background)
async function previewLoop() {
  let wait = 1000;
  try {
    if ($('#previewOn').checked && !$('#panelView').hidden && document.visibilityState === 'visible' && st && st.connected) {
      const r = await fetch('/api/preview', { credentials: 'same-origin', cache: 'no-store' });
      if (r.status === 401) showLogin();
      else if (r.ok) {
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
$('#editOn').onchange = () => { if (!editing()) selected = null; renderStage(); };

function renderStage() {
  if (!st) return;
  stage.style.aspectRatio = `${st.canvas.w} / ${st.canvas.h}`;
  stage.classList.toggle('editing', editing());
  $('#editHint').hidden = !editing();
  if (selected != null && !st.items.some(i => i.id === selected)) selected = null;
  const it = st.items.find(i => i.id === selected);
  $('#selBar').hidden = !it;
  if (it) {
    $('#selName').textContent = it.name;
    $('#selText').hidden = typeof it.text !== 'string';
    $('#selHide').textContent = it.on ? 'hide' : 'show';
  }
  if (drag) return; // don't redraw under a finger
  boxes.replaceChildren();
  if (!editing()) return;
  // bottom of OBS's list first, so the top source ends up on top here too
  for (const i of st.items.slice().reverse()) {
    if (!i.box || i.box.w <= 0 || i.box.h <= 0) continue;
    const el = document.createElement('div');
    // near the top edge the name goes inside the box, so it isn't cut off
    el.className = `box${i.on ? '' : ' off'}${i.id === selected ? ' sel' : ''}${i.box.y < st.canvas.h * 0.06 ? ' tag-in' : ''}`;
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
  const it = st.items.find(i => i.id === Number(el.dataset.id));
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
const endDrag = () => { if (!drag) return; const d = drag; drag = null; send(d, true); };
boxes.addEventListener('pointerup', endDrag);
boxes.addEventListener('pointercancel', endDrag);
function send(d, last = false) {
  const b = d.now, s = d.start;
  if (last && b.x === s.x && b.y === s.y && b.w === s.w) return;
  const a = d.resize ? { type: 'resize', x: b.x, y: b.y, w: b.w, h: b.h } : { type: 'move', x: b.x, y: b.y };
  act({ ...a, scene: st.scene, id: d.id });
}

// add / change / remove sources
const fieldHtml = f => {
  const id = `f_${f.name}`;
  const label = document.createElement('label');
  label.className = 'field';
  const span = document.createElement('span');
  span.textContent = f.label;
  const input = document.createElement(f.type === 'textarea' ? 'textarea' : 'input');
  input.id = id;
  if (f.type !== 'textarea') input.type = f.type || 'text';
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
    $('#form').onsubmit = e => { e.preventDefault(); done(Object.fromEntries(fields.map(f => [f.name, $(`#f_${f.name}`).value]))); };
    $('#formNo').onclick = () => done(null);
  });
}
const added = name => () => { toast(`added ${name} ✦`); if (!editing()) { $('#editOn').checked = true; renderStage(); } };
$('#addText').onclick = async () => {
  const v = await form('add text', `shows in the middle of "${st.scene}". move it with edit layout.`, [
    { name: 'text', label: 'the words', type: 'textarea', required: true, placeholder: 'be right back ✦' },
    { name: 'name', label: 'name in OBS (optional)', placeholder: 'Text' },
  ], 'add text');
  if (v) act({ type: 'addText', text: v.text, name: v.name }, added('the text'));
};
$('#addBrowser').onclick = async () => {
  const v = await form('add a website', 'alerts, chat, widgets or a picture link, as an OBS browser source.', [
    { name: 'url', label: 'web address', type: 'url', required: true, placeholder: 'https://' },
    { name: 'width', label: 'width', type: 'number', value: 800, min: 16, max: 7680 },
    { name: 'height', label: 'height', type: 'number', value: 600, min: 16, max: 4320 },
    { name: 'name', label: 'name in OBS (optional)' },
  ], 'add website');
  if (v) act({ type: 'addBrowser', url: v.url, width: Number(v.width), height: Number(v.height), name: v.name }, added('the website'));
};
$('#addColor').onclick = async () => {
  const v = await form('add a colour box', 'a block of colour, for a frame or a background.', [
    { name: 'color', label: 'colour', type: 'color', value: '#8f7bff' },
    { name: 'name', label: 'name in OBS (optional)', placeholder: 'Colour' },
  ], 'add box');
  if (v) act({ type: 'addColor', color: v.color, name: v.name }, added('the colour box'));
};
$('#selText').onclick = async () => {
  const it = st.items.find(i => i.id === selected);
  if (!it) return;
  const v = await form('edit text', it.name, [{ name: 'text', label: 'the words', type: 'textarea', value: it.text || '' }], 'save');
  if (v) act({ type: 'setText', scene: st.scene, id: it.id, text: v.text }, () => toast('text changed ✦'));
};
$('#selHide').onclick = () => {
  const it = st.items.find(i => i.id === selected);
  if (it) act({ type: 'source', scene: st.scene, id: it.id, on: !it.on });
};
$('#selRemove').onclick = async () => {
  const it = st.items.find(i => i.id === selected);
  if (!it || !(await ask(`remove "${it.name}"?`, `it's taken out of the scene "${st.scene}".`, 'remove'))) return;
  act({ type: 'remove', scene: st.scene, id: it.id }, () => { selected = null; toast('removed'); });
};

/* ───────────── remote display: the PC's whole screen, mouse and keyboard ─────────────
   The video comes straight from the stream PC over WebRTC; mouse and keyboard go back over a
   data channel. Places are sent as 0…1 across the screen, so any size of phone works. */
let rd = null; // { pc, dc, password, control }
const rdStage = $('#rdStage'), rdVideo = $('#rdVideo');

async function remoteInfo() {
  const info = await api('/api/remote').catch(() => ({ view: false }));
  $('#remoteCard').hidden = !info.view;
  if (info.view) {
    $('#remoteHint').textContent = info.active
      ? `in use right now (${info.from}). opening it here takes over.`
      : info.control && info.controlWorks ? 'see the stream PC\'s screen and use its mouse and keyboard, for OBS\'s full window.'
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

async function rdConnect() {
  if (!rd) return;
  if (rd.pc) rd.pc.close();
  rdState('connecting…');
  const pc = new RTCPeerConnection({ iceServers: [] });
  const dc = pc.createDataChannel('input', { ordered: true });
  // the stream PC ended it (its stop button, switched off, or someone else took over)
  dc.onmessage = m => {
    let msg; try { msg = JSON.parse(m.data); } catch { return; }
    if (msg.t === 'end' && rd && rd.pc === pc) { rdClose(false); toast(`remote display ended: ${msg.why || 'on the stream PC'}`, 4000); }
  };
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.ontrack = e => { rdVideo.srcObject = e.streams[0] || new MediaStream([e.track]); };
  pc.onconnectionstatechange = () => {
    if (!rd || rd.pc !== pc) return;
    if (pc.connectionState === 'connected') rdState(rd.control ? 'connected · mouse and keyboard on' : 'connected · watching only', true);
    if (pc.connectionState === 'failed') rdState("couldn't connect. same network (or Tailscale) as the stream PC?");
    if (pc.connectionState === 'disconnected') rdState('connection dropped… waiting');
  };
  Object.assign(rd, { pc, dc });
  await pc.setLocalDescription(await pc.createOffer());
  await iceDone(pc);
  try {
    const r = await api('/api/remote/start', { password: rd.password, sdp: pc.localDescription.sdp, screen: $('#rdScreen').value, quality: $('#rdQuality').value });
    if (!rd || rd.pc !== pc) return;
    rd.control = !!r.control;
    $('#rdKeys').hidden = !rd.control;
    rdStage.classList.toggle('watch', !rd.control);
    await pc.setRemoteDescription({ type: 'answer', sdp: r.sdp });
  } catch (err) {
    rdState(err.message);
    if (/password/.test(err.message)) { rdClose(false); toast(err.message, 4000); }
  }
}

$('#remoteOpen').onclick = async () => {
  const info = await remoteInfo();
  if (!info.view) return toast('the remote display was switched off on the stream PC');
  const v = await form('open the full screen', 'type the panel password again: the remote display shows (and may control) the whole stream PC.', [
    { name: 'password', label: 'panel password', type: 'password', required: true },
  ], 'open');
  if (!v) return;
  $('#rdScreen').replaceChildren(...(info.screens || []).map(sc => { const o = document.createElement('option'); o.value = sc.id; o.textContent = sc.name; return o; }));
  $('#rdScreen').hidden = (info.screens || []).length < 2;
  rd = { password: v.password, control: false };
  $('#rd').hidden = false;
  $('#rdKeyPad').hidden = true;
  rdStage.focus();
  rdConnect();
};
function rdClose(tell = true) {
  if (!rd) return;
  const was = rd;
  rd = null;
  if (was.pc) was.pc.close();
  rdVideo.srcObject = null;
  $('#rd').hidden = true;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (tell) api('/api/remote/stop', {}).catch(() => {});
  remoteInfo();
}
$('#rdEnd').onclick = () => rdClose();
$('#rdScreen').onchange = $('#rdQuality').onchange = () => rdConnect();
$('#rdFull').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : $('#rd').requestFullscreen()).catch(() => {});
$('#rdKeys').onclick = () => { $('#rdKeyPad').hidden = !$('#rdKeyPad').hidden; };

const rdSend = m => { if (rd && rd.control && rd.dc && rd.dc.readyState === 'open') rd.dc.send(JSON.stringify(m)); };
// a place on the video → 0…1 across the PC's screen (the picture is letterboxed to fit)
function rdAt(e) {
  const r = rdVideo.getBoundingClientRect(), vw = rdVideo.videoWidth, vh = rdVideo.videoHeight;
  if (!vw || !vh) return null;
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
// touch: tap = click, hold = right-click, drag = drag, two fingers = scroll
const touches = new Map();
let touch = null;
rdStage.addEventListener('pointerdown', e => {
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
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touches.size === 2) { if (touch && touch.timer) clearTimeout(touch.timer); touch = { scroll: true, y: (e.clientY + [...touches.values()][0].y) / 2 }; return; }
  if (!p) return;
  touch = { start: p, sx: e.clientX, sy: e.clientY, dragging: false, done: false };
  touch.timer = setTimeout(() => {
    if (!touch || touch.dragging || touch.scroll) return;
    touch.done = true;
    rdSend({ t: 'b', b: 2, d: true, ...p }); rdSend({ t: 'b', b: 2, d: false, ...p });
    if (navigator.vibrate) navigator.vibrate(15);
  }, 550);
});
rdStage.addEventListener('pointermove', e => {
  if (!rd || !rd.control) return;
  if (e.pointerType !== 'touch') { const p = rdAt(e); if (p) queueMove(p); return; }
  const t = touches.get(e.pointerId);
  if (t) { t.x = e.clientX; t.y = e.clientY; }
  if (!touch) return;
  if (touch.scroll && touches.size >= 2) {
    const y = [...touches.values()].reduce((a, b) => a + b.y, 0) / touches.size;
    const dy = touch.y - y;
    if (Math.abs(dy) > 6) { rdSend({ t: 'w', dy: dy * 4 }); touch.y = y; }
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
  if (!rd || !rd.control) return;
  if (e.pointerType !== 'touch') {
    const p = rdAt(e) || {};
    rdSend({ t: 'b', b: e.button, d: false, ...p });
    return;
  }
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
$('#recPauseBtn').onclick = () => st && act({ type: 'recordPause', on: !st.record.paused });

/* ───────────── start ───────────── */
fetch('/api/state', { credentials: 'same-origin' })
  .then(r => (r.ok ? r.json().then(s => { showPanel(); apply(s); }) : showLogin()))
  .catch(showLogin);
