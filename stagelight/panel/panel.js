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
  if (res.status === 401 && path !== '/api/login') showLogin();
  if (!res.ok) throw new Error(data.error || `error ${res.status}`);
  return data;
};
const act = (a, done) => api('/api/action', a).then(done || (() => {})).catch(err => toast(err.message, 4000));

/* ───────────── log in / out ───────────── */
function showLogin() {
  if (events) { events.close(); events = null; }
  $('#panelView').hidden = true;
  $('#loginView').hidden = false;
  setTimeout(() => $('#password').focus(), 50);
}
function showPanel() {
  $('#loginView').hidden = true;
  $('#panelView').hidden = false;
  listen();
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
