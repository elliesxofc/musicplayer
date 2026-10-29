'use strict';

/* Stagelight's connection to OBS, on the stream PC, through OBS's own WebSocket server
   (OBS 28+: Tools → WebSocket Server Settings). It keeps a picture of what OBS is doing
   (scenes, sources, audio, stream, recording, health) for the panel, and runs the few
   things the panel is allowed to ask for. The OBS password never leaves this PC. */

const crypto = require('node:crypto');

const SUBSCRIPTIONS = 1 | 4 | 8 | 64 | 128; // general, scenes, inputs, outputs, scene items
const sha256 = text => crypto.createHash('sha256').update(text).digest('base64');

function createObs({ onChange = () => {}, log = () => {} } = {}) {
  let ws = null, identified = false, nextId = 1, settings = null, retry = null, poll = null, wanted = false;
  const pending = new Map();

  const state = {
    connected: false, status: 'not connected to OBS', obsVersion: '',
    scenes: [], scene: '', items: [], audio: [],
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
  async function refreshAll() {
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
      .map(i => ({ id: i.sceneItemId, name: i.sourceName, on: !!i.sceneItemEnabled }));
    changed();
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
      default: throw new Error('the panel asked for something Stagelight does not do');
    }
    setTimeout(() => pollStatus().catch(() => {}), 300);
    changed();
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
  };
}

module.exports = { createObs };
