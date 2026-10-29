'use strict';

/* Stagelight's connection to OBS, on the stream PC, through OBS's own WebSocket server
   (OBS 28+: Tools → WebSocket Server Settings). It keeps a picture of what OBS is doing
   (scenes, sources, audio, stream, recording, health) for the panel, and runs the few
   things the panel is allowed to ask for. The OBS password never leaves this PC. */

const crypto = require('node:crypto');

// general, scenes, inputs, outputs, scene items, and sources being moved or resized in OBS
const SUBSCRIPTIONS = 1 | 4 | 8 | 64 | 128 | (1 << 19);
const TEXT_KINDS = ['text_gdiplus_v3', 'text_gdiplus_v2', 'text_gdiplus', 'text_ft2_source_v2', 'text_ft2_source'];
const sha256 = text => crypto.createHash('sha256').update(text).digest('base64');

function createObs({ onChange = () => {}, log = () => {} } = {}) {
  let ws = null, identified = false, nextId = 1, settings = null, retry = null, poll = null, wanted = false;
  const pending = new Map();

  const state = {
    connected: false, status: 'not connected to OBS', obsVersion: '',
    scenes: [], scene: '', items: [], audio: [], canvas: { w: 1920, h: 1080 },
    stream: { active: false, reconnecting: false, startedAt: 0, kbps: 0, skipped: 0, total: 0, congestion: 0 },
    record: { active: false, paused: false, ms: 0 },
    stats: null,
  };
  let lastBytes = { bytes: 0, at: 0 };
  let changeTimer = null;
  const changed = () => { if (!changeTimer) changeTimer = setTimeout(() => { changeTimer = null; onChange(snapshot()); }, 120); };
  const setStatus = text => { state.status = text; changed(); };

  /* ───────────── the WebSocket ───────────── */
  function drop() {
    for (const p of pending.values()) p.reject(new Error('OBS disconnected'));
    pending.clear();
    identified = false;
    state.connected = false;
    clearInterval(poll);
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

  function later(ms = 5000) {
    clearTimeout(retry);
    if (wanted) retry = setTimeout(connect, ms);
  }

  function connect() {
    clearTimeout(retry);
    if (!settings) return;
    close(false);
    const { host = 'localhost', port = 4455, password = '' } = settings;
    setStatus('connecting to OBS…');
    let sock;
    try { sock = ws = new WebSocket(`ws://${host}:${port}`); } catch (err) { setStatus(`can't reach OBS (${err.message})`); return later(); }
    const timer = setTimeout(() => { if (!identified) { setStatus("OBS didn't answer. Is it open, with its WebSocket server on?"); try { sock.close(); } catch { /* fine */ } } }, 6000);
    sock.onerror = () => {};
    sock.onclose = e => {
      clearTimeout(timer);
      if (ws !== sock) return;
      ws = null;
      const was = identified;
      drop();
      if (e.code === 4009) { setStatus('wrong OBS WebSocket password'); return; } // no retrying with a wrong password
      setStatus(was ? 'OBS closed. Reconnecting when it’s back…' : "can't reach OBS. Is it open, with its WebSocket server on?");
      later(was ? 3000 : 5000);
    };
    sock.onmessage = ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.op === 0) { // Hello
        state.obsVersion = m.d.obsWebSocketVersion || '';
        const d = { rpcVersion: 1, eventSubscriptions: SUBSCRIPTIONS };
        if (m.d.authentication) {
          if (!password) { setStatus('OBS needs its WebSocket password (add it in Stagelight)'); sock.close(); return; }
          d.authentication = sha256(sha256(password + m.d.authentication.salt) + m.d.authentication.challenge);
        }
        sock.send(JSON.stringify({ op: 1, d }));
      } else if (m.op === 2) { // Identified
        identified = true;
        clearTimeout(timer);
        state.connected = true;
        setStatus(`connected to OBS${state.obsVersion ? ` · websocket ${state.obsVersion}` : ''}`);
        refreshAll().catch(err => log('refresh', err.message));
        clearInterval(poll);
        poll = setInterval(() => pollStatus().catch(() => {}), 2000);
      } else if (m.op === 5) { // Event
        onEvent(m.d.eventType, m.d.eventData || {});
      } else if (m.op === 7) { // RequestResponse
        const p = pending.get(m.d.requestId);
        if (!p) return;
        pending.delete(m.d.requestId);
        if (m.d.requestStatus && m.d.requestStatus.result) p.resolve(m.d.responseData || {});
        else p.reject(new Error((m.d.requestStatus && m.d.requestStatus.comment) || 'OBS said no'));
      }
    };
  }

  function close(stopWanting = true) {
    if (stopWanting) wanted = false;
    clearTimeout(retry);
    if (!ws) return;
    const sock = ws;
    ws = null;
    drop();
    sock.onclose = null; sock.onerror = null; sock.onmessage = null;
    try { sock.close(); } catch { /* already closed */ }
  }

  /* ───────────── reading OBS ───────────── */
  let kinds = [];
  async function refreshAll() {
    const [v, k] = await Promise.all([call('GetVideoSettings').catch(() => null), call('GetInputKindList').catch(() => null)]);
    if (v && v.baseWidth) state.canvas = { w: v.baseWidth, h: v.baseHeight };
    if (k) kinds = k.inputKinds || [];
    await Promise.all([refreshScenes(), refreshAudio(), pollStatus()]);
  }

  async function refreshScenes() {
    const r = await call('GetSceneList');
    // OBS lists scenes bottom-up; show them the way OBS's own Scenes box does
    state.scenes = (r.scenes || []).slice().sort((a, b) => b.sceneIndex - a.sceneIndex).map(s => s.sceneName);
    state.scene = r.currentProgramSceneName || '';
    changed();
    await refreshItems();
  }

  async function refreshItems() {
    if (!state.scene) { state.items = []; changed(); return; }
    const r = await call('GetSceneItemList', { sceneName: state.scene }).catch(() => ({ sceneItems: [] }));
    state.items = (r.sceneItems || []).slice().sort((a, b) => b.sceneItemIndex - a.sceneItemIndex)
      .map(i => ({ id: i.sceneItemId, name: i.sourceName, on: !!i.sceneItemEnabled, kind: i.inputKind || i.sourceType || '', box: boxOf(i.sceneItemTransform) }));
    // the words in text sources, so the panel can show and change them
    await Promise.all(state.items.filter(i => TEXT_KINDS.includes(i.kind)).map(async i => {
      const t = await call('GetInputSettings', { inputName: i.name }).catch(() => null);
      i.text = t && t.inputSettings ? String(t.inputSettings.text || '') : '';
    }));
    changed();
  }

  /* Where a source sits on the canvas, as a box (left, top, width, height in canvas pixels).
     OBS keeps a position for the source's alignment point (top-left, centre, …), a scale and
     maybe a bounding box; rotation is left out (the box is the unrotated one). */
  function boxOf(t) {
    if (!t) return null;
    const bounded = t.boundsType && t.boundsType !== 'OBS_BOUNDS_NONE';
    const w = bounded ? t.boundsWidth : t.width, h = bounded ? t.boundsHeight : t.height;
    const a = t.alignment ?? 5; // 1 left, 2 right, 4 top, 8 bottom (0 = centre)
    const left = t.positionX - (a & 1 ? 0 : a & 2 ? w : w / 2);
    const top = t.positionY - (a & 4 ? 0 : a & 8 ? h : h / 2);
    return { x: left, y: top, w, h, align: a, bounded, rot: t.rotation || 0,
      srcW: t.sourceWidth || 0, srcH: t.sourceHeight || 0, scaleX: t.scaleX || 1, scaleY: t.scaleY || 1 };
  }

  async function refreshAudio() {
    const r = await call('GetInputList');
    const found = [];
    await Promise.all((r.inputs || []).map(async inp => {
      try {
        // only inputs that have audio answer these
        const [m, v] = await Promise.all([
          call('GetInputMute', { inputName: inp.inputName }),
          call('GetInputVolume', { inputName: inp.inputName }),
        ]);
        found.push({ name: inp.inputName, muted: !!m.inputMuted, mul: v.inputVolumeMul, db: v.inputVolumeDb });
      } catch { /* not an audio source */ }
    }));
    state.audio = found.sort((a, b) => a.name.localeCompare(b.name));
    changed();
  }

  async function pollStatus() {
    if (!identified) return;
    const [s, r, stats] = await Promise.all([
      call('GetStreamStatus').catch(() => null),
      call('GetRecordStatus').catch(() => null),
      call('GetStats').catch(() => null),
    ]);
    const now = Date.now();
    if (s) {
      const st = state.stream;
      st.kbps = s.outputActive && lastBytes.at && s.outputBytes >= lastBytes.bytes
        ? Math.round((s.outputBytes - lastBytes.bytes) * 8 / ((now - lastBytes.at) / 1000) / 1000) : 0;
      lastBytes = s.outputActive ? { bytes: s.outputBytes, at: now } : { bytes: 0, at: 0 };
      st.active = !!s.outputActive;
      st.reconnecting = !!s.outputReconnecting;
      st.skipped = s.outputSkippedFrames || 0;
      st.total = s.outputTotalFrames || 0;
      st.congestion = s.outputCongestion || 0;
      // OBS times the stream by the frames it sent, which falls behind the real time; the start
      // is noted by the clock when the stream starts, and only guessed from OBS when it was missed
      if (!st.active) st.startedAt = 0;
      else if (!st.startedAt) st.startedAt = now - (s.outputDuration || 0);
    }
    if (r) state.record = { active: !!r.outputActive, paused: !!r.outputPaused, ms: r.outputDuration || 0 };
    if (stats) state.stats = { fps: stats.activeFps, cpu: stats.cpuUsage, renderSkipped: stats.renderSkippedFrames, renderTotal: stats.renderTotalFrames };
    changed();
  }

  /* ───────────── OBS telling us things ───────────── */
  function onEvent(type, d) {
    switch (type) {
      case 'CurrentProgramSceneChanged': state.scene = d.sceneName; changed(); refreshItems().catch(() => {}); break;
      case 'SceneListChanged': case 'SceneNameChanged': refreshScenes().catch(() => {}); break;
      case 'SceneItemEnableStateChanged': {
        if (d.sceneName !== state.scene) break;
        const it = state.items.find(i => i.id === d.sceneItemId);
        if (it) { it.on = !!d.sceneItemEnabled; changed(); }
        break;
      }
      case 'SceneItemCreated': case 'SceneItemRemoved': case 'SceneItemListReindexed':
        if (!d.sceneName || d.sceneName === state.scene) refreshItems().catch(() => {});
        break;
      case 'InputMuteStateChanged': {
        const a = state.audio.find(x => x.name === d.inputName);
        if (a) { a.muted = !!d.inputMuted; changed(); }
        break;
      }
      case 'InputVolumeChanged': {
        const a = state.audio.find(x => x.name === d.inputName);
        if (a) { a.mul = d.inputVolumeMul; a.db = d.inputVolumeDb; changed(); }
        break;
      }
      case 'SceneItemTransformChanged': {
        if (d.sceneName !== state.scene) break;
        const it = state.items.find(i => i.id === d.sceneItemId);
        if (it) { it.box = boxOf(d.sceneItemTransform); changed(); }
        break;
      }
      case 'InputSettingsChanged': {
        const it = state.items.find(i => i.name === d.inputName && TEXT_KINDS.includes(i.kind));
        if (it && d.inputSettings && 'text' in d.inputSettings) { it.text = String(d.inputSettings.text || ''); changed(); }
        break;
      }
      case 'InputCreated': case 'InputRemoved': case 'InputNameChanged': refreshAudio().catch(() => {}); break;
      case 'StreamStateChanged':
        if (d.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') state.stream.startedAt = Date.now();
        if (d.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') state.stream.startedAt = 0;
        state.stream.active = !!d.outputActive;
        changed();
        pollStatus().catch(() => {});
        break;
      case 'RecordStateChanged': state.record.active = !!d.outputActive; changed(); pollStatus().catch(() => {}); break;
      case 'ExitStarted': setStatus('OBS is closing…'); break;
      default: break;
    }
  }

  /* ───────────── what the panel may ask for (nothing else gets through) ───────────── */
  async function act(a) {
    if (!a || typeof a !== 'object') throw new Error('nothing to do');
    if (!identified) throw new Error('not connected to OBS');
    const str = v => (typeof v === 'string' ? v : '');
    const itemOf = x => {
      const it = state.items.find(i => i.id === Number(x.id));
      if (!it || str(x.scene) !== state.scene) throw new Error('that source is gone');
      return it;
    };
    switch (a.type) {
      case 'stream': await call(a.on ? 'StartStream' : 'StopStream'); break;
      case 'record': await call(a.on ? 'StartRecord' : 'StopRecord'); break;
      case 'recordPause': await call(a.on ? 'PauseRecord' : 'ResumeRecord'); break;
      case 'scene': {
        if (!state.scenes.includes(str(a.name))) throw new Error('that scene is gone');
        await call('SetCurrentProgramScene', { sceneName: a.name });
        break;
      }
      case 'source': {
        const it = state.items.find(i => i.id === Number(a.id));
        if (!it || str(a.scene) !== state.scene) throw new Error('that source is gone');
        await call('SetSceneItemEnabled', { sceneName: state.scene, sceneItemId: it.id, sceneItemEnabled: !!a.on });
        it.on = !!a.on;
        break;
      }
      case 'mute': {
        if (!state.audio.some(x => x.name === str(a.input))) throw new Error('that audio source is gone');
        await call('SetInputMute', { inputName: a.input, inputMuted: !!a.on });
        break;
      }
      case 'volume': {
        if (!state.audio.some(x => x.name === str(a.input))) throw new Error('that audio source is gone');
        const mul = Math.max(0, Math.min(1, Number(a.mul)));
        if (!Number.isFinite(mul)) throw new Error('that volume is not a number');
        await call('SetInputVolume', { inputName: a.input, inputVolumeMul: mul });
        break;
      }
      case 'move': case 'resize': {
        const it = itemOf(a);
        const b = it.box;
        if (!b) throw new Error("that source can't be moved");
        const num = (v, lo, hi) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error('that is not a number'); return Math.max(lo, Math.min(hi, n)); };
        const W = state.canvas.w, H = state.canvas.h;
        const x = num(a.x, -W * 4, W * 5), y = num(a.y, -H * 4, H * 5);
        const w = a.type === 'resize' ? num(a.w, 2, W * 8) : b.w, h = a.type === 'resize' ? num(a.h, 2, H * 8) : b.h;
        // back from the box to OBS's alignment point
        const t = {
          positionX: x + (b.align & 1 ? 0 : b.align & 2 ? w : w / 2),
          positionY: y + (b.align & 4 ? 0 : b.align & 8 ? h : h / 2),
        };
        if (a.type === 'resize') {
          if (b.bounded) { t.boundsWidth = w; t.boundsHeight = h; }
          else if (b.srcW && b.srcH) { t.scaleX = w / b.srcW; t.scaleY = h / b.srcH; }
        }
        await call('SetSceneItemTransform', { sceneName: state.scene, sceneItemId: it.id, sceneItemTransform: t });
        it.box = { ...b, x, y, w, h };
        break;
      }
      case 'setText': {
        const it = itemOf(a);
        if (!TEXT_KINDS.includes(it.kind)) throw new Error("that source isn't text");
        const text = str(a.text).slice(0, 2000);
        await call('SetInputSettings', { inputName: it.name, inputSettings: { text }, overlay: true });
        it.text = text;
        break;
      }
      case 'remove': {
        const it = itemOf(a);
        await call('RemoveSceneItem', { sceneName: state.scene, sceneItemId: it.id });
        break;
      }
      case 'addText': case 'addBrowser': case 'addColor': {
        if (!state.scene) throw new Error('no scene to add it to');
        const W = state.canvas.w, H = state.canvas.h;
        let kind, settings, base;
        if (a.type === 'addText') {
          kind = TEXT_KINDS.find(k => kinds.includes(k));
          if (!kind) throw new Error("this OBS has no text source");
          const text = str(a.text).slice(0, 2000) || 'text';
          settings = { text, font: { face: kind.startsWith('text_gdiplus') ? 'Arial' : 'Sans Serif', size: 96, style: 'Bold', flags: 1 } };
          base = 'Text';
        } else if (a.type === 'addBrowser') {
          let url;
          try { url = new URL(str(a.url)); } catch { throw new Error('that is not a web address'); }
          if (!/^https?:$/.test(url.protocol)) throw new Error('only http:// and https:// addresses');
          const w = Math.round(Math.max(16, Math.min(7680, Number(a.width) || 800)));
          const h = Math.round(Math.max(16, Math.min(4320, Number(a.height) || 600)));
          kind = 'browser_source';
          if (kinds.length && !kinds.includes(kind)) throw new Error('this OBS has no browser source');
          settings = { url: url.href, width: w, height: h };
          base = url.hostname.replace(/^www\./, '') || 'Browser';
        } else {
          const m = /^#?([0-9a-f]{6})$/i.exec(str(a.color));
          if (!m) throw new Error('pick a colour');
          const n = parseInt(m[1], 16);
          // OBS keeps colours as ABGR
          const abgr = (0xff000000 | ((n & 0xff) << 16) | (n & 0xff00) | ((n >> 16) & 0xff)) >>> 0;
          kind = kinds.find(k => /^color_source/.test(k)) || 'color_source_v3';
          settings = { color: abgr, width: Math.round(W / 4), height: Math.round(H / 4) };
          base = 'Colour';
        }
        // a name of its own (OBS needs every source's name to be different)
        const list = await call('GetInputList');
        const taken = new Set((list.inputs || []).map(i => i.inputName));
        let name = str(a.name).trim().slice(0, 80) || base;
        for (let n = 2; taken.has(name); n++) name = `${str(a.name).trim().slice(0, 76) || base} ${n}`;
        const made = await call('CreateInput', { sceneName: state.scene, inputName: name, inputKind: kind, inputSettings: settings, sceneItemEnabled: true });
        // new things start in the middle of the screen
        if (made && made.sceneItemId != null) {
          await call('SetSceneItemTransform', { sceneName: state.scene, sceneItemId: made.sceneItemId,
            sceneItemTransform: { alignment: 0, positionX: W / 2, positionY: H / 2 } }).catch(() => {});
        }
        await refreshItems();
        break;
      }
      default: throw new Error('the panel asked for something Stagelight does not do');
    }
    setTimeout(() => pollStatus().catch(() => {}), 300);
    changed();
  }

  // a picture of the current scene for the panel's preview (shared by every open panel)
  let shot = { at: 0, scene: '', data: null, busy: null };
  async function screenshot() {
    if (!identified || !state.scene) return null;
    if (shot.data && shot.scene === state.scene && Date.now() - shot.at < 450) return shot.data;
    if (shot.busy) return shot.busy;
    const w = Math.min(960, state.canvas.w);
    shot.busy = call('GetSourceScreenshot', { sourceName: state.scene, imageFormat: 'jpg', imageWidth: w, imageHeight: Math.round(w * state.canvas.h / state.canvas.w), imageCompressionQuality: 70 })
      .then(r => {
        const m = /^data:image\/\w+;base64,(.*)$/.exec(r.imageData || '');
        shot = { at: Date.now(), scene: state.scene, data: m ? Buffer.from(m[1], 'base64') : null, busy: null };
        return shot.data;
      })
      .catch(() => { shot.busy = null; return null; });
    return shot.busy;
  }

  function snapshot() {
    return JSON.parse(JSON.stringify({ ...state, now: Date.now() }));
  }

  return {
    // settings: { host, port, password }
    start(next) { settings = next; wanted = true; connect(); },
    stop() { close(true); setStatus('not connected to OBS'); },
    act,
    snapshot,
    screenshot,
  };
}

module.exports = { createObs };
