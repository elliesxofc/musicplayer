'use strict';

/* Stagelight's connection to OBS, on the stream PC, through OBS's own WebSocket server
   (OBS 28+: Tools → WebSocket Server Settings). It keeps a picture of what OBS is doing
   (scenes, sources, audio, stream, recording, health) for the panel, and runs the few
   things the panel is allowed to ask for. The OBS password never leaves this PC. */

const crypto = require('node:crypto');
const path = require('node:path');

// general, profiles and scene collections, scenes, inputs, outputs, scene items, and sources being
// moved or resized in OBS
const SUBSCRIPTIONS = 1 | 2 | 4 | 8 | 64 | 128 | (1 << 19);
const TEXT_KINDS = ['text_gdiplus_v3', 'text_gdiplus_v2', 'text_gdiplus', 'text_ft2_source_v2', 'text_ft2_source'];
const sha256 = text => crypto.createHash('sha256').update(text).digest('base64');

function createObs({ onChange = () => {}, log = () => {} } = {}) {
  let ws = null, identified = false, nextId = 1, settings = null, retry = null, poll = null, wanted = false;
  const pending = new Map();

  const state = {
    connected: false, status: 'not connected to OBS', obsVersion: '',
    scenes: [], scene: '', items: [], audio: [], canvas: { w: 1920, h: 1080 },
    others: {}, // scenes being edited in the panel while another one is on stream: name → items
    stream: { active: false, reconnecting: false, startedAt: 0, kbps: 0, skipped: 0, total: 0, congestion: 0 },
    record: { active: false, paused: false, ms: 0 },
    stats: null,
  };
  let lastBytes = { bytes: 0, at: 0 };
  let changeTimer = null;
  // tells Stagelight something changed (it builds the full picture only when someone looks)
  const changed = () => { if (!changeTimer) changeTimer = setTimeout(() => { changeTimer = null; onChange(); }, 120); };

  /* How often OBS is asked about the stream: every 2 s while a panel (or the settings window)
     is open, every 15 s otherwise. OBS still tells Stagelight about changes straight away. */
  let pollMs = 15_000;
  function setBusy(busy) {
    const next = busy ? 2000 : 15_000;
    if (next === pollMs) return;
    pollMs = next;
    if (identified) { clearInterval(poll); poll = setInterval(() => pollStatus().catch(() => {}), pollMs); if (busy) pollStatus().catch(() => {}); }
  }
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
        poll = setInterval(() => pollStatus().catch(() => {}), pollMs);
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

  async function readItems(scene) {
    const r = await call('GetSceneItemList', { sceneName: scene }).catch(() => ({ sceneItems: [] }));
    const items = (r.sceneItems || []).slice().sort((a, b) => b.sceneItemIndex - a.sceneItemIndex)
      .map(i => ({ id: i.sceneItemId, name: i.sourceName, on: !!i.sceneItemEnabled, kind: i.inputKind || i.sourceType || '', box: boxOf(i.sceneItemTransform) }));
    // the words in text sources, so the panel can show and change them
    await Promise.all(items.filter(i => TEXT_KINDS.includes(i.kind)).map(async i => {
      const t = await call('GetInputSettings', { inputName: i.name }).catch(() => null);
      i.text = t && t.inputSettings ? String(t.inputSettings.text || '') : '';
    }));
    return items;
  }
  async function refreshItems() {
    state.items = state.scene ? await readItems(state.scene) : [];
    changed();
  }

  /* Scenes being edited without being on stream. A panel asks for one (and asks again every
     minute while it's open); nobody asking for 3 minutes, and it's dropped. */
  const otherWanted = new Map(); // scene → last asked
  async function refreshOther(scene) {
    if (!otherWanted.has(scene) || !state.scenes.includes(scene)) return;
    state.others[scene] = await readItems(scene);
    changed();
  }
  setInterval(() => {
    for (const [scene, at] of otherWanted) if (Date.now() - at > 180_000) { otherWanted.delete(scene); delete state.others[scene]; changed(); }
  }, 30_000).unref();
  // the items of any scene: the one on stream, or one being edited
  const itemsIn = scene => (scene === state.scene ? state.items : state.others[scene]);

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
      case 'CurrentProgramSceneChanged': {
        state.scene = d.sceneName;
        changed();
        refreshItems().catch(() => {});
        for (const s of otherWanted.keys()) refreshOther(s).catch(() => {}); // the one that left the stream
        break;
      }
      case 'SceneListChanged': case 'SceneNameChanged': refreshScenes().catch(() => {}); break;
      case 'SceneItemEnableStateChanged': {
        const it = (itemsIn(d.sceneName) || []).find(i => i.id === d.sceneItemId);
        if (it) { it.on = !!d.sceneItemEnabled; changed(); }
        break;
      }
      case 'SceneItemCreated': case 'SceneItemRemoved': case 'SceneItemListReindexed':
        if (!d.sceneName || d.sceneName === state.scene) refreshItems().catch(() => {});
        if (d.sceneName && otherWanted.has(d.sceneName)) refreshOther(d.sceneName).catch(() => {});
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
        const it = (itemsIn(d.sceneName) || []).find(i => i.id === d.sceneItemId);
        if (it) { it.box = boxOf(d.sceneItemTransform); changed(); }
        break;
      }
      case 'InputSettingsChanged': {
        for (const it of [state.items, ...Object.values(state.others)].flat()) {
          if (it.name === d.inputName && TEXT_KINDS.includes(it.kind) && d.inputSettings && 'text' in d.inputSettings) { it.text = String(d.inputSettings.text || ''); changed(); }
        }
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
      // another scene collection or profile: everything may be different
      case 'CurrentSceneCollectionChanged': case 'CurrentProfileChanged': case 'VideoSettingsChanged':
        state.others = {}; otherWanted.clear();
        refreshAll().catch(() => {});
        break;
      default: break;
    }
  }

  /* ───────────── what the panel may ask for (nothing else gets through) ───────────── */
  async function act(a) {
    if (!a || typeof a !== 'object') throw new Error('nothing to do');
    if (!identified) throw new Error('not connected to OBS');
    const str = v => (typeof v === 'string' ? v : '');
    const itemOf = x => {
      const it = (itemsIn(str(x.scene)) || []).find(i => i.id === Number(x.id));
      if (!it) throw new Error('that source is gone');
      return it;
    };
    // the scene a change is for: the one on stream, or one being edited
    const sceneOf = x => (x.scene == null || x.scene === '' ? state.scene : itemsIn(str(x.scene)) ? str(x.scene) : (() => { throw new Error('that scene is gone'); })());
    switch (a.type) {
      case 'stream': await call(a.on ? 'StartStream' : 'StopStream'); break;
      case 'record': await call(a.on ? 'StartRecord' : 'StopRecord'); break;
      case 'recordPause': await call(a.on ? 'PauseRecord' : 'ResumeRecord'); break;
      // the panel edits a scene that isn't on stream: keep its sources up to date for the panels
      case 'editScene': {
        const scene = str(a.scene);
        if (!state.scenes.includes(scene)) throw new Error('that scene is gone');
        if (scene === state.scene) break;
        const first = !otherWanted.has(scene);
        otherWanted.set(scene, Date.now());
        if (first) await refreshOther(scene);
        break;
      }
      case 'scene': {
        if (!state.scenes.includes(str(a.name))) throw new Error('that scene is gone');
        await call('SetCurrentProgramScene', { sceneName: a.name });
        break;
      }
      case 'source': {
        const it = itemOf(a);
        await call('SetSceneItemEnabled', { sceneName: sceneOf(a), sceneItemId: it.id, sceneItemEnabled: !!a.on });
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
        await call('SetSceneItemTransform', { sceneName: sceneOf(a), sceneItemId: it.id, sceneItemTransform: t });
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
      // browser sources (alerts, chat, widgets): reload the page, like OBS's "Refresh cache of current page"
      case 'refresh': {
        const it = itemOf(a);
        if (it.kind !== 'browser_source') throw new Error("that's not a browser source");
        await call('PressInputPropertiesButton', { inputName: it.name, propertyName: 'refreshnocache' });
        break;
      }
      case 'refreshAll': {
        const list = await call('GetInputList', { inputKind: 'browser_source' });
        const names = (list.inputs || []).map(i => i.inputName);
        if (!names.length) throw new Error('there are no browser sources in OBS');
        await Promise.all(names.map(n => call('PressInputPropertiesButton', { inputName: n, propertyName: 'refreshnocache' }).catch(() => {})));
        break;
      }
      // a browser source's settings, like OBS's properties window: the page, its size, its CSS
      case 'browserSet': {
        const it = itemOf(a);
        if (it.kind !== 'browser_source') throw new Error("that's not a browser source");
        const now = (await call('GetInputSettings', { inputName: it.name })).inputSettings || {};
        const next = {
          width: Math.round(Math.max(16, Math.min(7680, Number(a.width) || now.width || 800))),
          height: Math.round(Math.max(16, Math.min(4320, Number(a.height) || now.height || 600))),
          css: str(a.css).slice(0, 20_000),
          shutdown: !!a.shutdown,
          restart_when_active: !!a.restartWhenActive,
        };
        // a page on the stream PC (a local file) keeps its file: the panel only sets web addresses
        if (!now.is_local_file || str(a.url)) {
          let url;
          try { url = new URL(str(a.url)); } catch { throw new Error('that is not a web address'); }
          if (!/^https?:$/.test(url.protocol)) throw new Error('only http:// and https:// addresses');
          next.url = url.href;
          next.is_local_file = false;
        }
        const fps = Math.round(Number(a.fps));
        if (fps >= 1 && fps <= 60) { next.fps = fps; next.fps_custom = fps !== 30; }
        await call('SetInputSettings', { inputName: it.name, inputSettings: next, overlay: true });
        break;
      }
      case 'remove': {
        const it = itemOf(a);
        await call('RemoveSceneItem', { sceneName: sceneOf(a), sceneItemId: it.id });
        if (sceneOf(a) !== state.scene) await refreshOther(sceneOf(a));
        break;
      }
      case 'addText': case 'addBrowser': case 'addColor': {
        const into = sceneOf(a);
        if (!into) throw new Error('no scene to add it to');
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
        await createSource(into, kind, settings, base, str(a.name));
        break;
      }
      default: throw new Error('the panel asked for something Stagelight does not do');
    }
    setTimeout(() => pollStatus().catch(() => {}), 300);
    changed();
  }

  /* A picture of a scene for the panel's preview (the one on stream, or one being edited), shared
     by every open panel. OBS draws it on its own render thread, so it's kept light: at most one a
     second per scene, smaller while live, and slower still whenever OBS takes long to make one. */
  const shots = new Map(); // scene → { at, data, busy, gap }
  async function screenshot(scene = state.scene) {
    if (!identified || !scene || !itemsIn(scene)) return null;
    const shot = shots.get(scene) || { at: 0, data: null, busy: null, gap: 1000 };
    shots.set(scene, shot);
    if (shot.data && Date.now() - shot.at < shot.gap) return shot.data;
    if (shot.busy) return shot.busy;
    const w = Math.min(state.stream.active ? 640 : 960, state.canvas.w);
    const started = Date.now();
    shot.busy = call('GetSourceScreenshot', { sourceName: scene, imageFormat: 'jpg', imageWidth: w, imageHeight: Math.round(w * state.canvas.h / state.canvas.w), imageCompressionQuality: 60 })
      .then(r => {
        const took = Date.now() - started;
        const m = /^data:image\/\w+;base64,(.*)$/.exec(r.imageData || '');
        // a slow answer means OBS is busy: wait longer before the next picture
        Object.assign(shot, { at: Date.now(), data: m ? Buffer.from(m[1], 'base64') : null, busy: null, error: m ? '' : 'OBS sent an empty picture', gap: took > 250 ? 4000 : took > 120 ? 2000 : 1000 });
        return shot.data;
      })
      .catch(err => { shot.busy = null; shot.error = String((err && err.message) || err).slice(0, 160); return null; });
    // pictures of scenes nobody looks at any more go
    for (const [s, x] of shots) if (s !== scene && Date.now() - x.at > 60_000 && !x.busy) shots.delete(s);
    return shot.busy;
  }

  // a new source in a scene, with a name of its own (OBS needs every source's name to be different),
  // in the middle of the screen
  async function createSource(into, kind, settings, base, wanted = '') {
    const W = state.canvas.w, H = state.canvas.h;
    const list = await call('GetInputList');
    const taken = new Set((list.inputs || []).map(i => i.inputName));
    const own = String(wanted || '').trim();
    let name = own.slice(0, 80) || base;
    for (let n = 2; taken.has(name); n++) name = `${own.slice(0, 76) || base.slice(0, 76)} ${n}`;
    const made = await call('CreateInput', { sceneName: into, inputName: name, inputKind: kind, inputSettings: settings, sceneItemEnabled: true });
    if (made && made.sceneItemId != null) {
      await call('SetSceneItemTransform', { sceneName: into, sceneItemId: made.sceneItemId,
        sceneItemTransform: { alignment: 0, positionX: W / 2, positionY: H / 2 } }).catch(() => {});
    }
    if (into === state.scene) await refreshItems(); else await refreshOther(into);
    return name;
  }

  /* A file uploaded from the panel (saved by Stagelight in its own media folder): a picture
     becomes an image source, a video or a sound a media source. Not reachable through act():
     the panel never names a file on this PC. */
  async function addMedia({ scene, file, type, name }) {
    if (!identified) throw new Error('not connected to OBS');
    const into = scene && itemsIn(String(scene)) ? String(scene) : state.scene;
    if (!into) throw new Error('no scene to add it to');
    const base = path.basename(file).replace(/^\d+-/, '').replace(/\.[^.]+$/, '').slice(0, 60) || 'File';
    if (type === 'image') return createSource(into, 'image_source', { file }, base, name);
    return createSource(into, 'ffmpeg_source', { local_file: file, is_local_file: true, looping: type === 'video', restart_on_activate: true }, base, name);
  }

  /* ───────────── OBS's own settings (full access only) ─────────────
     What OBS lets other programs change: the video size and frame rate, the stream service and
     key, the bitrate (in OBS's simple output mode), the recording folder, and which profile and
     scene collection are used. The stream key is never sent to the panel: it can only be replaced. */
  const busyOut = () => state.stream.active || state.record.active;
  async function obsSettings() {
    if (!identified) throw new Error('not connected to OBS');
    const [v, svc, mode, vb, ab, rec, prof, coll] = await Promise.all([
      call('GetVideoSettings').catch(() => null),
      call('GetStreamServiceSettings').catch(() => null),
      call('GetProfileParameter', { parameterCategory: 'Output', parameterName: 'Mode' }).catch(() => null),
      call('GetProfileParameter', { parameterCategory: 'SimpleOutput', parameterName: 'VBitrate' }).catch(() => null),
      call('GetProfileParameter', { parameterCategory: 'SimpleOutput', parameterName: 'ABitrate' }).catch(() => null),
      call('GetRecordDirectory').catch(() => null),
      call('GetProfileList').catch(() => null),
      call('GetSceneCollectionList').catch(() => null),
    ]);
    const ss = (svc && svc.streamServiceSettings) || {};
    const val = x => (x && x.parameterValue != null ? x.parameterValue : '');
    return {
      busy: busyOut(),
      video: v ? { baseW: v.baseWidth, baseH: v.baseHeight, outW: v.outputWidth, outH: v.outputHeight, fps: Math.round(v.fpsNumerator / v.fpsDenominator * 100) / 100 } : null,
      stream: svc ? { type: svc.streamServiceType, service: String(ss.service || ''), server: String(ss.server || ''), keySet: !!ss.key } : null,
      output: { mode: String(val(mode) || 'Simple'), vbitrate: Number(val(vb)) || 0, abitrate: Number(val(ab)) || 0 },
      recordDir: rec ? String(rec.recordDirectory || '') : null,
      profile: prof ? { now: prof.currentProfileName, all: prof.profiles || [] } : null,
      collection: coll ? { now: coll.currentSceneCollectionName, all: coll.sceneCollections || [] } : null,
    };
  }
  const FPS = { 24: [24, 1], 25: [25, 1], 29.97: [30000, 1001], 30: [30, 1], 48: [48, 1], 50: [50, 1], 59.94: [60000, 1001], 60: [60, 1], 120: [120, 1] };
  async function setObsSettings(a) {
    if (!a || typeof a !== 'object') throw new Error('nothing to change');
    if (!identified) throw new Error('not connected to OBS');
    const str = v => (typeof v === 'string' ? v : '');
    const int = (v, lo, hi, what) => { const n = Math.round(Number(v)); if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${what}: ${lo} to ${hi}`); return n; };
    const notBusy = what => { if (busyOut()) throw new Error(`stop the stream and the recording first: OBS can't change ${what} while they run`); };
    switch (a.group) {
      case 'video': {
        notBusy('the video settings');
        const fps = FPS[Number(a.fps)];
        if (!fps) throw new Error('pick a frame rate');
        await call('SetVideoSettings', {
          baseWidth: int(a.baseW, 32, 7680, 'canvas width'), baseHeight: int(a.baseH, 32, 4320, 'canvas height'),
          outputWidth: int(a.outW, 32, 7680, 'output width'), outputHeight: int(a.outH, 32, 4320, 'output height'),
          fpsNumerator: fps[0], fpsDenominator: fps[1],
        });
        return 'video settings';
      }
      case 'output': {
        const mode = await call('GetProfileParameter', { parameterCategory: 'Output', parameterName: 'Mode' }).catch(() => null);
        if (mode && mode.parameterValue === 'Advanced') throw new Error('OBS is in advanced output mode: the bitrate is set in OBS itself (Settings → Output)');
        await call('SetProfileParameter', { parameterCategory: 'SimpleOutput', parameterName: 'VBitrate', parameterValue: String(int(a.vbitrate, 200, 100_000, 'video bitrate')) });
        if (a.abitrate != null && a.abitrate !== '') {
          const ab = int(a.abitrate, 32, 320, 'audio bitrate');
          if (![64, 96, 128, 160, 192, 224, 256, 288, 320].includes(ab)) throw new Error('audio bitrate: 64, 96, 128, 160, 192, 256 or 320');
          await call('SetProfileParameter', { parameterCategory: 'SimpleOutput', parameterName: 'ABitrate', parameterValue: String(ab) });
        }
        return 'bitrate';
      }
      case 'stream': {
        notBusy('the stream settings');
        const now = await call('GetStreamServiceSettings');
        const settings = { ...(now.streamServiceSettings || {}) };
        const server = str(a.server).trim();
        if (server) {
          if (now.streamServiceType === 'rtmp_custom' && !/^(rtmps?|srt|rist):\/\/\S+$/i.test(server)) throw new Error('the server is an rtmp://, rtmps://, srt:// or rist:// address');
          if (server.length > 500) throw new Error('that server is too long');
          settings.server = server;
        }
        const key = str(a.key).trim();
        if (key) { if (key.length > 500 || /\s/.test(key)) throw new Error("that doesn't look like a stream key"); settings.key = key; }
        await call('SetStreamServiceSettings', { streamServiceType: now.streamServiceType, streamServiceSettings: settings });
        return key ? 'stream server and key' : 'stream server';
      }
      case 'recordDir': {
        const dir = str(a.dir).trim();
        if (!/^([a-z]:[\\/]|\/|\\\\)/i.test(dir) || dir.length > 400) throw new Error('a full folder path, like C:\\Users\\you\\Videos');
        await call('SetRecordDirectory', { recordDirectory: dir });
        return 'recording folder';
      }
      case 'profile': {
        notBusy('the profile');
        const list = await call('GetProfileList');
        if (!(list.profiles || []).includes(str(a.name))) throw new Error('that profile is gone');
        await call('SetCurrentProfile', { profileName: a.name });
        return `profile "${a.name}"`;
      }
      case 'collection': {
        notBusy('the scene collection');
        const list = await call('GetSceneCollectionList');
        if (!(list.sceneCollections || []).includes(str(a.name))) throw new Error('that scene collection is gone');
        await call('SetCurrentSceneCollection', { sceneCollectionName: a.name });
        return `scene collection "${a.name}"`;
      }
      default: throw new Error('the panel asked for something Stagelight does not do');
    }
  }

  // what the panel's browser source form starts with
  async function browserSettings(scene, id) {
    if (!identified) throw new Error('not connected to OBS');
    const it = (itemsIn(String(scene)) || []).find(i => i.id === Number(id));
    if (!it) throw new Error('that source is gone');
    if (it.kind !== 'browser_source') throw new Error("that's not a browser source");
    const s = (await call('GetInputSettings', { inputName: it.name })).inputSettings || {};
    return {
      name: it.name,
      localFile: s.is_local_file ? String(s.local_file || 'a file on the stream PC') : '',
      url: s.is_local_file ? '' : String(s.url || ''),
      width: Number(s.width) || 800, height: Number(s.height) || 600,
      fps: s.fps_custom ? Number(s.fps) || 30 : 30,
      css: typeof s.css === 'string' ? s.css : 'body { background-color: rgba(0, 0, 0, 0); margin: 0px auto; overflow: hidden; }',
      shutdown: !!s.shutdown, restartWhenActive: !!s.restart_when_active,
    };
  }

  function snapshot() {
    return JSON.parse(JSON.stringify({ ...state, now: Date.now() }));
  }

  return {
    // settings: { host, port, password }
    start(next) { settings = next; wanted = true; connect(); },
    stop() { close(true); setStatus('not connected to OBS'); },
    act,
    addMedia,
    obsSettings,
    setObsSettings,
    browserSettings,
    snapshot,
    screenshot,
    shotTag: (scene = state.scene) => `"${(shots.get(scene) || { at: 0 }).at}"`,
    // why there's no picture: OBS's own answer, or what Stagelight is missing
    shotError: (scene = state.scene) => (!identified ? 'OBS is not connected' : !itemsIn(scene) ? `Stagelight doesn't know the scene "${scene}" yet` : (shots.get(scene) || {}).error || 'OBS sent no picture'),
    setBusy,
    summary: () => (!state.connected ? 'OBS not connected' : state.stream.active ? 'live' : state.record.active ? 'recording' : 'OBS connected'),
  };
}

module.exports = { createObs };
