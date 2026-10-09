'use strict';

/* moonlit stream control (desktop app only).
   Talks to OBS through its built-in WebSocket server (OBS 28+, Tools → WebSocket Server
   Settings): go live / end stream, record, switch scenes, show/hide sources, mute and set
   volumes, and watch the stream's health, without touching OBS. Uses app.js helpers
   ($, prefs, toast, desktop, setSettings, setDownloads). */

(() => {
  if (!desktop) return;

  /* ───────────── a small OBS WebSocket (v5) client ───────────── */
  // events we listen for: general, scenes, inputs, outputs, scene items
  const SUBSCRIPTIONS = 1 | 4 | 8 | 64 | 128;

  function createObsClient() {
    let ws = null, identified = false, nextId = 1, version = '';
    const pending = new Map();
    const listeners = new Map();
    const emit = (type, data) => (listeners.get(type) || []).forEach(fn => { try { fn(data); } catch { /* keep going */ } });

    async function sha256b64(text) {
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return btoa(String.fromCharCode(...new Uint8Array(hash)));
    }

    function drop() {
      for (const p of pending.values()) p.reject(new Error('OBS disconnected'));
      pending.clear();
      identified = false;
    }

    function connect({ host, port, password }) {
      close();
      return new Promise((resolve, reject) => {
        let settled = false;
        const fail = msg => { if (!settled) { settled = true; reject(new Error(msg)); } };
        const sock = ws = new WebSocket(`ws://${host}:${port}`);
        const timer = setTimeout(() => { fail("OBS didn't answer. Is it open, with its WebSocket server turned on?"); sock.close(); }, 6000);
        sock.onerror = () => fail("couldn't reach OBS. Is it open, with its WebSocket server turned on?");
        sock.onclose = e => {
          clearTimeout(timer);
          const wasIdentified = identified;
          if (ws === sock) { ws = null; drop(); }
          fail(e.code === 4009 ? 'wrong OBS password' : e.code === 4010 ? 'this OBS is too old (needs OBS 28 or newer)' : 'OBS closed the connection');
          if (wasIdentified) emit('_closed', e.code);
        };
        sock.onmessage = async ev => {
          let m;
          try { m = JSON.parse(ev.data); } catch { return; }
          if (m.op === 0) { // Hello
            version = m.d.obsWebSocketVersion || '';
            const d = { rpcVersion: 1, eventSubscriptions: SUBSCRIPTIONS };
            if (m.d.authentication) {
              if (!password) { fail('OBS needs its WebSocket password'); sock.close(); return; }
              const secret = await sha256b64(password + m.d.authentication.salt);
              d.authentication = await sha256b64(secret + m.d.authentication.challenge);
            }
            sock.send(JSON.stringify({ op: 1, d }));
          } else if (m.op === 2) { // Identified
            identified = true;
            clearTimeout(timer);
            if (!settled) { settled = true; resolve(); }
          } else if (m.op === 5) { // Event
            emit(m.d.eventType, m.d.eventData || {});
          } else if (m.op === 7) { // RequestResponse
            const p = pending.get(m.d.requestId);
            if (!p) return;
            pending.delete(m.d.requestId);
            if (m.d.requestStatus && m.d.requestStatus.result) p.resolve(m.d.responseData || {});
            else p.reject(new Error((m.d.requestStatus && m.d.requestStatus.comment) || 'OBS said no'));
          }
        };
      });
    }

    function call(requestType, requestData) {
      return new Promise((resolve, reject) => {
        if (!ws || !identified) return reject(new Error('not connected to OBS'));
        const requestId = String(nextId++);
        pending.set(requestId, { resolve, reject });
        ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
        setTimeout(() => { if (pending.has(requestId)) { pending.delete(requestId); reject(new Error('OBS took too long to answer')); } }, 8000);
      });
    }

    function close() {
      if (!ws) return;
      const sock = ws;
      ws = null;
      drop();
      sock.onclose = null; sock.onerror = null; sock.onmessage = null;
      try { sock.close(); } catch { /* already closed */ }
    }

    return {
      connect, call, close,
      on(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
      get connected() { return identified; },
      get version() { return version; },
    };
  }

  /* ───────────── the panel ───────────── */
  const obs = createObsClient();
  const panel = $('#ocPanel');
  const ui = {
    btn: $('#ocBtn'), badge: $('#ocBadge'), dot: $('#ocDot'), conn: $('#ocConnText'), setupBtn: $('#ocSetupBtn'),
    setup: $('#ocSetup'), host: $('#ocHost'), port: $('#ocPort'), pass: $('#ocPass'), auto: $('#ocAuto'),
    body: $('#ocBody'), stream: $('#ocStream'), streamLabel: $('#ocStreamLabel'), streamTime: $('#ocStreamTime'),
    rec: $('#ocRec'), recPause: $('#ocRecPause'), stats: $('#ocStats'),
    scenes: $('#ocScenes'), items: $('#ocItems'), audio: $('#ocAudio'),
  };
  const st = {
    scenes: [], scene: '', items: [], audio: new Map(),
    stream: { active: false, ms: 0, bytes: 0, at: 0, congestion: 0, skipped: 0, total: 0 },
    rec: { active: false, paused: false, ms: 0 },
    stats: null, kbps: 0, wanted: false, retry: null, poll: null,
  };

  const clock = ms => {
    const s = Math.floor((ms || 0) / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
  };

  function setPanel(open) {
    if (open) { setSettings(false); setDownloads(false); }
    panel.hidden = !open;
    ui.btn.setAttribute('aria-expanded', String(open));
    if (open && !obs.connected && !prefs.get('ocPass', '') && !prefs.get('ocConnected', false)) showSetup(true);
  }
  ui.btn.hidden = false;
  ui.btn.onclick = e => { e.stopPropagation(); setPanel(panel.hidden); };
  ui.badge.onclick = e => { e.stopPropagation(); setPanel(true); };
  $('#ocClose').onclick = () => setPanel(false);
  document.addEventListener('click', e => { if (!panel.hidden && !e.target.closest('#ocPanel, #ocBtn, #ocBadge, .toast')) setPanel(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') setPanel(false); });
  // the other panels close this one when they open
  for (const id of ['#settingsBtn', '#dlBtn']) $(id)?.addEventListener('click', () => setPanel(false));

  function showSetup(show) { ui.setup.hidden = !show; }
  ui.setupBtn.onclick = () => showSetup(ui.setup.hidden);
  ui.host.value = prefs.get('ocHost', 'localhost');
  ui.port.value = prefs.get('ocPort', 4455);
  ui.pass.value = prefs.get('ocPass', '');
  ui.auto.checked = prefs.get('ocAuto', true);
  ui.auto.onchange = () => prefs.set('ocAuto', ui.auto.checked);
  ui.setup.onsubmit = e => {
    e.preventDefault();
    prefs.set('ocHost', ui.host.value.trim() || 'localhost');
    prefs.set('ocPort', Number(ui.port.value) || 4455);
    prefs.set('ocPass', ui.pass.value);
    connect(true);
  };

  function setConn(text, kind) {
    ui.conn.textContent = text;
    ui.dot.dataset.kind = kind; // on | off | wait
  }

  async function connect(fromUser = false) {
    clearTimeout(st.retry);
    st.wanted = true;
    setConn('connecting to OBS…', 'wait');
    try {
      await obs.connect({ host: prefs.get('ocHost', 'localhost'), port: prefs.get('ocPort', 4455), password: prefs.get('ocPass', '') });
      prefs.set('ocConnected', true);
      setConn(`connected to OBS${obs.version ? ` · websocket ${obs.version}` : ''}`, 'on');
      showSetup(false);
      ui.body.hidden = false;
      if (fromUser) toast('connected to OBS ✦');
      await refreshAll();
      clearInterval(st.poll);
      st.poll = setInterval(pollStatus, 2000);
    } catch (err) {
      ui.body.hidden = true;
      const wrongPass = /password/.test(err.message);
      setConn(err.message, 'off');
      if (fromUser || wrongPass) showSetup(true);
      // OBS might just not be open yet: keep trying quietly (not after a wrong password)
      if (!wrongPass && st.wanted) st.retry = setTimeout(() => connect(false), 5000);
    }
  }

  obs.on('_closed', () => {
    clearInterval(st.poll);
    ui.body.hidden = true;
    st.stream.active = false; st.rec.active = false;
    renderOutputs();
    setConn('OBS closed. Reconnecting when it’s back…', 'wait');
    if (st.wanted) st.retry = setTimeout(() => connect(false), 3000);
  });
  obs.on('ExitStarted', () => setConn('OBS is closing…', 'wait'));

  /* ───────────── reading OBS ───────────── */
  async function refreshAll() {
    await Promise.all([refreshScenes(), refreshAudio(), pollStatus()]);
  }

  async function refreshScenes() {
    const r = await obs.call('GetSceneList');
    // OBS lists scenes bottom-up; show them the way OBS's own Scenes box does
    st.scenes = (r.scenes || []).slice().sort((a, b) => b.sceneIndex - a.sceneIndex).map(s => s.sceneName);
    st.scene = r.currentProgramSceneName || '';
    renderScenes();
    await refreshItems();
  }

  async function refreshItems() {
    if (!st.scene) { st.items = []; renderItems(); return; }
    const r = await obs.call('GetSceneItemList', { sceneName: st.scene }).catch(() => ({ sceneItems: [] }));
    st.items = (r.sceneItems || []).slice().sort((a, b) => b.sceneItemIndex - a.sceneItemIndex)
      .map(i => ({ id: i.sceneItemId, name: i.sourceName, on: i.sceneItemEnabled }));
    renderItems();
  }

  async function refreshAudio() {
    const r = await obs.call('GetInputList');
    const next = new Map();
    await Promise.all((r.inputs || []).map(async inp => {
      try {
        // only inputs that have audio answer these
        const [m, v] = await Promise.all([
          obs.call('GetInputMute', { inputName: inp.inputName }),
          obs.call('GetInputVolume', { inputName: inp.inputName }),
        ]);
        next.set(inp.inputName, { muted: m.inputMuted, mul: v.inputVolumeMul, db: v.inputVolumeDb });
      } catch { /* not an audio source */ }
    }));
    st.audio = new Map([...next.entries()].sort((a, b) => a[0].localeCompare(b[0])));
    renderAudio();
  }

  async function pollStatus() {
    if (!obs.connected) return;
    const [s, r, stats] = await Promise.all([
      obs.call('GetStreamStatus').catch(() => null),
      obs.call('GetRecordStatus').catch(() => null),
      obs.call('GetStats').catch(() => null),
    ]);
    const now = performance.now();
    if (s) {
      const prev = st.stream;
      st.kbps = s.outputActive && prev.active && prev.at && s.outputBytes >= prev.bytes
        ? Math.round((s.outputBytes - prev.bytes) * 8 / ((now - prev.at) / 1000) / 1000) : 0;
      st.stream = { active: s.outputActive, reconnecting: s.outputReconnecting, ms: s.outputDuration, bytes: s.outputBytes, at: now,
        congestion: s.outputCongestion || 0, skipped: s.outputSkippedFrames || 0, total: s.outputTotalFrames || 0 };
    }
    if (r) st.rec = { active: r.outputActive, paused: r.outputPaused, ms: r.outputDuration };
    if (stats) st.stats = stats;
    renderOutputs();
  }

  /* ───────────── OBS telling us things ───────────── */
  obs.on('CurrentProgramSceneChanged', d => { st.scene = d.sceneName; renderScenes(); refreshItems(); });
  obs.on('SceneListChanged', () => refreshScenes().catch(() => {}));
  obs.on('SceneNameChanged', () => refreshScenes().catch(() => {}));
  obs.on('SceneItemEnableStateChanged', d => {
    if (d.sceneName !== st.scene) return;
    const it = st.items.find(i => i.id === d.sceneItemId);
    if (it) { it.on = d.sceneItemEnabled; renderItems(); }
  });
  for (const ev of ['SceneItemCreated', 'SceneItemRemoved', 'SceneItemListReindexed']) obs.on(ev, d => { if (!d.sceneName || d.sceneName === st.scene) refreshItems(); });
  obs.on('InputMuteStateChanged', d => { const a = st.audio.get(d.inputName); if (a) { a.muted = d.inputMuted; renderAudio(); } });
  obs.on('InputVolumeChanged', d => {
    const a = st.audio.get(d.inputName);
    if (a) { a.mul = d.inputVolumeMul; a.db = d.inputVolumeDb; updateVolume(d.inputName); }
  });
  for (const ev of ['InputCreated', 'InputRemoved', 'InputNameChanged']) obs.on(ev, () => refreshAudio().catch(() => {}));
  obs.on('StreamStateChanged', d => {
    st.stream.active = d.outputActive;
    if (d.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') toast('you’re live ✦');
    if (d.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') toast('stream ended');
    if (d.outputState === 'OBS_WEBSOCKET_OUTPUT_RECONNECTING') toast('stream connection dropped, OBS is reconnecting…', 5000);
    pollStatus();
  });
  obs.on('RecordStateChanged', d => { st.rec.active = d.outputActive; pollStatus(); });

  /* ───────────── drawing ───────────── */
  function renderOutputs() {
    const s = st.stream, r = st.rec;
    ui.stream.classList.toggle('live', s.active);
    ui.streamLabel.textContent = s.active ? (s.reconnecting ? 'reconnecting…' : 'end stream') : 'go live';
    ui.streamTime.textContent = s.active ? clock(s.ms) : '';
    ui.rec.classList.toggle('on', r.active);
    ui.rec.textContent = r.active ? `stop recording · ${clock(r.ms)}` : 'record';
    ui.recPause.hidden = !r.active;
    ui.recPause.textContent = r.paused ? 'resume' : 'pause';
    const bits = [];
    if (s.active) {
      if (st.kbps) bits.push(st.kbps >= 1000 ? `${(st.kbps / 1000).toFixed(1)} Mb/s` : `${st.kbps} kb/s`);
      if (s.total) bits.push(`${(s.skipped / s.total * 100).toFixed(1)}% dropped`);
    }
    if (st.stats) {
      bits.push(`${Math.round(st.stats.activeFps)} fps`);
      bits.push(`OBS CPU ${st.stats.cpuUsage.toFixed(1)}%`);
    }
    ui.stats.textContent = bits.join(' · ');
    ui.stats.classList.toggle('warn', s.active && (s.congestion > 0.5 || (s.total && s.skipped / s.total > 0.02)));
    // top bar badge
    ui.badge.hidden = !(s.active || r.active);
    ui.badge.classList.toggle('rec-only', !s.active && r.active);
    ui.badge.textContent = s.active ? `● LIVE ${clock(s.ms)}` : r.active ? `● REC ${clock(r.ms)}` : '';
  }

  function renderScenes() {
    ui.scenes.innerHTML = '';
    for (const name of st.scenes) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'oc-scene';
      b.textContent = name;
      b.setAttribute('aria-pressed', String(name === st.scene));
      b.onclick = () => obs.call('SetCurrentProgramScene', { sceneName: name }).catch(err => toast(err.message));
      ui.scenes.append(b);
    }
    if (!st.scenes.length) ui.scenes.textContent = 'no scenes';
  }

  function renderItems() {
    ui.items.innerHTML = '';
    for (const it of st.items) {
      const li = document.createElement('li');
      li.className = 'oc-row' + (it.on ? '' : ' off');
      li.innerHTML = `<span class="oc-name"></span><button type="button" class="icon-btn" aria-pressed="${it.on}"><svg><use href="#i-${it.on ? 'eye' : 'eye-off'}"/></svg></button>`;
      li.querySelector('.oc-name').textContent = it.name;
      const btn = li.querySelector('button');
      btn.setAttribute('aria-label', `${it.on ? 'hide' : 'show'} ${it.name}`);
      // set the exact value (OBS also reports the change back, so flipping here would undo it)
      btn.onclick = () => { const want = !it.on; obs.call('SetSceneItemEnabled', { sceneName: st.scene, sceneItemId: it.id, sceneItemEnabled: want })
        .then(() => { it.on = want; renderItems(); }).catch(err => toast(err.message)); };
      ui.items.append(li);
    }
    if (!st.items.length) ui.items.innerHTML = '<li class="oc-empty">nothing in this scene</li>';
  }

  // OBS's own fader feel: slider position 0…1 ↔ volume multiplier (cubic)
  const toSlider = mul => Math.round(Math.cbrt(Math.max(0, Math.min(1, mul))) * 100);
  const fromSlider = v => Math.pow(v / 100, 3);
  const dbText = db => (db <= -100 || !Number.isFinite(db) ? '−∞ dB' : `${db.toFixed(1)} dB`);

  function renderAudio() {
    ui.audio.innerHTML = '';
    for (const [name, a] of st.audio) {
      const li = document.createElement('li');
      li.className = 'oc-row oc-audio' + (a.muted ? ' off' : '');
      li.dataset.name = name;
      li.innerHTML = `<button type="button" class="icon-btn" aria-pressed="${a.muted}"><svg><use href="#i-${a.muted ? 'mute' : 'volume'}"/></svg></button>
        <span class="oc-name"></span><input type="range" min="0" max="100" step="1"><span class="oc-db"></span>`;
      li.querySelector('.oc-name').textContent = name;
      const btn = li.querySelector('button');
      btn.setAttribute('aria-label', `${a.muted ? 'unmute' : 'mute'} ${name}`);
      btn.onclick = () => { const want = !a.muted; obs.call('SetInputMute', { inputName: name, inputMuted: want })
        .then(() => { a.muted = want; renderAudio(); }).catch(err => toast(err.message)); };
      const range = li.querySelector('input');
      range.setAttribute('aria-label', `${name} volume`);
      range.value = toSlider(a.mul);
      setFill(range);
      range.oninput = () => {
        setFill(range);
        a.mul = fromSlider(+range.value);
        a.db = a.mul > 0 ? 20 * Math.log10(a.mul) : -100;
        li.querySelector('.oc-db').textContent = dbText(a.db);
        obs.call('SetInputVolume', { inputName: name, inputVolumeMul: a.mul }).catch(() => {});
      };
      li.querySelector('.oc-db').textContent = dbText(a.db);
      ui.audio.append(li);
    }
    if (!st.audio.size) ui.audio.innerHTML = '<li class="oc-empty">no audio sources</li>';
  }

  function updateVolume(name) {
    const li = [...ui.audio.children].find(l => l.dataset.name === name);
    const a = st.audio.get(name);
    if (!li || !a) return;
    const range = li.querySelector('input');
    if (document.activeElement !== range) { range.value = toSlider(a.mul); setFill(range); }
    li.querySelector('.oc-db').textContent = dbText(a.db);
  }

  /* ───────────── controls ───────────── */
  ui.stream.onclick = async () => {
    if (!obs.connected) return;
    if (st.stream.active) {
      if (!confirm('end the stream now?')) return;
      obs.call('StopStream').catch(err => toast(err.message));
    } else {
      if (!confirm('go live now?')) return;
      obs.call('StartStream').catch(err => toast(err.message));
    }
  };
  ui.rec.onclick = () => obs.call(st.rec.active ? 'StopRecord' : 'StartRecord').then(pollStatus).catch(err => toast(err.message));
  ui.recPause.onclick = () => obs.call(st.rec.paused ? 'ResumeRecord' : 'PauseRecord').then(pollStatus).catch(err => toast(err.message));

  renderOutputs();
  if (prefs.get('ocAuto', true) && prefs.get('ocConnected', false)) connect(false);
  else setConn('not connected to OBS', 'off');
})();
