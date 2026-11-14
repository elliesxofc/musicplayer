// The small, fixed set of desktop-only abilities the player page is allowed to use: the same
// window.moonlitDesktop the Electron version gave the page, now answered by moonlit's Rust side.
(() => {
  if (window.moonlitDesktop || window.top !== window) return;
  const T = () => window.__TAURI_INTERNALS__;
  const call = (cmd, args) => T().invoke(cmd, args || {});
  // raw bytes (covers) go as the body, with the rest in headers
  const send = (cmd, bytes, headers) => T().invoke(cmd, bytes ? new Uint8Array(bytes) : new Uint8Array(0), { headers });
  const enc = v => encodeURIComponent(String(v == null ? '' : v));
  const on = (event, cb) => {
    const go = () => window.__TAURI__.event.listen(event, e => cb(e.payload));
    if (window.__TAURI__ && window.__TAURI__.event) go(); else window.addEventListener('DOMContentLoaded', go, { once: true });
  };
  const fire = (cmd, args) => { call(cmd, args).catch(() => {}); };

  window.moonlitDesktop = {
    engine: 'rust',
    chooseNowPlayingFile: () => call('obs_choose'),
    getNowPlayingFile: () => call('obs_get'),
    unlinkNowPlaying: () => call('obs_unlink'),
    writeNowPlaying: text => call('obs_write', { text: String(text) }),
    getOpenAtLogin: () => call('startup_get'),
    setOpenAtLogin: on => call('startup_set', { on: !!on }),
    version: () => call('app_version'),
    // closing moonlit: the page shows "Do you want to close the program?" and answers
    onCloseRequest: cb => on('app:close-request', () => { fire('close_seen'); cb(); }),
    answerClose: yes => fire('close_answer', { yes: !!yes }),
    // the window was hidden / minimised (false) or shown again (true)
    onVisible: cb => on('app:visible', v => cb(!!v)),
    // songs opened from Windows (double-click / Open with)
    takePendingFiles: () => call('files_pending'),
    readFile: async file => {
      const info = await call('file_info', { file: String(file) });
      if (!info) return null;
      const data = await call('file_bytes', { file: String(file) });
      return { name: info.name, data: new Uint8Array(data), lastModified: info.lastModified };
    },
    // the window, taskbar and tray icon in a theme's colours (null: the usual icon)
    setIcon: theme => call('app_icon', { theme: theme == null ? null : String(theme) }),
    playlist: {
      open: () => call('playlist_open'),
      save: (name, text) => call('playlist_save', { name: String(name), text: String(text) }),
    },
    onOpenFiles: cb => on('files:open', files => cb(files)),
    tray: {
      get: () => call('tray_get'),
      set: patch => call('tray_set', { patch: patch || {} }),
      nowPlaying: song => {
        if (!song) return send('tray_now_playing', null, {}).catch(() => {});
        const { cover, ...info } = song;
        return send('tray_now_playing', cover, { 'x-song': enc(JSON.stringify(info)) }).catch(() => {});
      },
      playing: v => fire('tray_playing', { on: !!v }),
      onCommand: cb => on('tray:command', cmd => cb(String(cmd))),
    },
    overlay: {
      state: s => fire('overlay_state', { state: s }),
      cover: (id, type, bytes) => send('overlay_cover', bytes, { 'x-id': enc(id), 'x-type': enc(type) }).catch(() => {}),
      url: () => call('overlay_url'),
      open: url => call('overlay_open', { url: String(url) }),
      spectrum: levels => fire('overlay_spectrum', { levels: Array.from(levels || [], v => Number(v) || 0) }),
      // how many overlays are open (in OBS or a browser), so the bars are only sampled when seen
      onWatchers: cb => on('overlay:watchers', n => cb(n)),
    },
    // the same commands in your Discord server, with your own bot
    discord: {
      get: () => call('discord_get'),
      set: settings => call('discord_set', { next: settings || {} }),
      onStatus: cb => on('discord:status', s => cb(s)),
      // someone is typing /sr: the page answers with library songs and that person's request rules
      onSuggest: cb => on('discord:suggest', q => cb(q)),
      suggestions: (req, answer) => fire('discord_suggestions', { req: String(req), answer: answer || {} }),
    },
    chat: {
      get: () => call('chat_get'),
      set: settings => call('chat_set', { next: settings || {} }),
      preview: () => call('chat_preview'),
      liveStart: () => call('chat_live_start'),
      onStatus: cb => on('chat:status', s => cb(s)),
      onCommand: cb => on('chat:command', c => cb(c)),
      // `to`: where a command came from when it wasn't YouTube (a Discord message), so the answer goes back there
      say: (text, to) => fire('chat_say', { text: String(text), to: to || null }),
      resolveChannel: input => call('channels_resolve', { input: String(input) }),
    },
    spotify: {
      get: () => call('spotify_get'),
      connect: clientId => call('spotify_connect', { clientId: String(clientId) }),
      control: action => call('spotify_control', { action: String(action) }),
      disconnect: () => call('spotify_disconnect'),
      setLocal: v => call('spotify_local', { on: !!v }),
      onLocalStatus: cb => on('spotify:local-status', s => cb(s)),
      open: url => call('spotify_open', { url: String(url) }),
      onState: cb => on('spotify:state', s => cb(s)),
      onStatus: cb => on('spotify:status', s => cb(s)),
    },
    download: {
      add: (url, format) => call('dl_add', { url: String(url), format: String(format) }),
      addList: (text, format) => call('dl_add_list', { text: String(text), format: String(format) }),
      list: () => call('dl_list'),
      cancel: id => call('dl_cancel', { id: Number(id) }),
      retry: id => call('dl_retry', { id: Number(id) }),
      cancelAll: () => call('dl_cancel_all'),
      clearFinished: () => call('dl_clear'),
      folder: () => call('dl_folder'),
      chooseFolder: () => call('dl_choose_folder'),
      openFolder: () => call('dl_open_folder'),
      request: (query, rules) => call('dl_request', { query: String(query), rules: rules || {} }),
      forgetRequest: file => call('dl_forget_request', { file: String(file) }),
      requestFiles: () => call('dl_request_files'),
      onUpdate: cb => on('dl:update', job => cb(job)),
      onRemove: cb => on('dl:remove', id => cb(id)),
      onStatus: cb => on('dl:status', text => cb(text)),
    },
    // bringing the library over from the old (Electron) moonlit, once
    move: {
      status: () => call('move_status'),
      run: () => call('move_run'),
      take: () => call('move_take'),
      blob: async (id, field) => new Uint8Array(await call('move_blob', { id: String(id), field: String(field) })),
      done: () => call('move_done'),
    },
  };
})();
