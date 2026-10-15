/* moonlit · live: Spotify's now playing and !nowplaying in YouTube chat (desktop app only).
   Uses app.js's helpers ($, toast, setSpotifyNow, …), which are loaded before this file. */
(() => {
  const D = window.moonlitDesktop;
  if (!D || !D.spotify || !D.chat) return;

  /* ───────────── Spotify ───────────── */
  const S = D.spotify;
  const mini = $('#spMini');
  let sp = null, tickTimer = 0;

  const setStatus = (box, s) => {
    box.textContent = s.text;
    box.classList.toggle('ok', s.kind === 'on');
    box.classList.toggle('warn', s.kind === 'warn');
  };

  function showConnected(connected) {
    $('#spSetup').hidden = connected;
    $('#spDisconnect').hidden = !connected;
  }

  function render() {
    mini.hidden = !sp;
    clearInterval(tickTimer);
    if (!sp) return;
    $('#spTitle').textContent = sp.title;
    $('#spArtist').textContent = [sp.artist, sp.album].filter(Boolean).join(' · ');
    $('#spDevice').textContent = sp.device ? ` · ${sp.device}` : '';
    const img = $('#spCover');
    if (img.dataset.src !== sp.cover) { img.dataset.src = sp.cover; if (sp.cover) img.src = sp.cover; else img.removeAttribute('src'); }
    $('#spPlayIcon').setAttribute('href', sp.playing ? '#i-pause' : '#i-play');
    $('#spPlay').setAttribute('aria-label', sp.playing ? 'pause Spotify' : 'play on Spotify');
    mini.classList.toggle('playing', sp.playing);
    const tick = () => {
      const pos = Math.min(sp.duration, sp.position + (sp.playing ? (Date.now() - sp.at) / 1000 : 0));
      $('#spFill').style.width = sp.duration ? `${(pos / sp.duration) * 100}%` : '0%';
      $('#spFill').parentElement.style.visibility = sp.duration ? '' : 'hidden';
    };
    tick();
    if (sp.playing) tickTimer = setInterval(tick, 1000);
  }

  function update(state) {
    sp = state;
    render();
    setSpotifyNow(state);
  }

  async function control(action) {
    const r = await S.control(action);
    if (!r.ok) toast(r.message, 5000);
  }
  $('#spPlay').onclick = () => control(sp && sp.playing ? 'pause' : 'play');
  $('#spPrev').onclick = () => control('previous');
  $('#spNext').onclick = () => control('next');

  $('#spConnect').onclick = async () => {
    const id = $('#spClientId').value.trim();
    $('#spConnect').disabled = true;
    const r = await S.connect(id);
    $('#spConnect').disabled = false;
    if (r.ok) { showConnected(true); toast('Spotify connected ♡'); } else toast(r.message, 6000);
  };
  $('#spDisconnect').onclick = async () => { await S.disconnect(); showConnected(false); };
  $('#spRedirectCopy').onclick = async () => {
    const input = $('#spRedirect');
    try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand('copy'); }
    toast('copied ✦ paste it under Redirect URIs');
  };
  $('#spDashLink').onclick = e => { e.preventDefault(); S.open(e.currentTarget.href); };

  S.onState(update);
  S.onStatus(s => {
    setStatus($('#spStatus'), s);
    if (s.kind === 'on') showConnected(true);
  });
  // the Spotify app on this PC (Windows): on by default, nothing to set up
  S.onLocalStatus(s => setStatus($('#spLocalStatus'), s));
  $('#spLocalOn').onchange = async () => {
    const info = await S.setLocal($('#spLocalOn').checked);
    setStatus($('#spLocalStatus'), info.status);
  };

  /* ───────────── !nowplaying in YouTube chat ───────────── */
  // one value from a .env file: KEY=value, "quoted", 'quoted', export KEY=..., # comments
  function envValue(text, key) {
    const rows = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
    for (let i = 0; i < rows.length; i++) {
      const m = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/.exec(rows[i]);
      if (!m || m[1] !== key) continue;
      let v = m[2];
      const q = v[0];
      if (q === '"' || q === "'" || q === '`') {
        // a quoted value can carry on over several lines
        while (v.indexOf(q, 1) === -1 && i + 1 < rows.length) v += '\n' + rows[++i];
        const end = v.indexOf(q, 1);
        v = end === -1 ? v.slice(1) : v.slice(1, end);
        if (q === '"') v = v.replace(/\\n/g, '\n');
      } else {
        v = v.replace(/\s+#.*$/, '');
      }
      return v.trim();
    }
    return '';
  }
  const C = D.chat;
  const on = $('#chatOn'), stream = $('#chatStream'), login = $('#chatLogin');

  async function save(extra = {}) {
    const next = { enabled: on.checked, stream: stream.value, ...extra };
    if (login.value.trim()) next.login = login.value;
    const s = await C.set(next);
    if (next.login) { login.value = ''; login.placeholder = 'saved ✓ (paste a new one to replace it)'; }
    if (s) setStatus($('#chatStatus'), s);
  }
  on.onchange = () => save();
  $('#chatSave').onclick = () => save().then(() => toast('saved'));

  // the song request app's .env file: only YOUTUBE_BOT_CREDENTIALS is read, the rest is ignored
  $('#chatEnvBtn').onclick = () => { $('#chatEnvInput').value = ''; $('#chatEnvInput').click(); };
  $('#chatEnvInput').onchange = async () => {
    const file = $('#chatEnvInput').files[0];
    if (!file) return;
    if (file.size > 1_000_000) { toast("that file is too big to be a .env file"); return; }
    const value = envValue(await file.text(), 'YOUTUBE_BOT_CREDENTIALS');
    if (!value) { toast("no YOUTUBE_BOT_CREDENTIALS in that file. is it the song request app's .env?", 5000); return; }
    login.value = value;
    await save();
    toast('bot login imported from the .env file ✓ (nothing else was taken from it)', 4500);
  };
  C.onStatus(s => setStatus($('#chatStatus'), s));

  /* ───────────── !uptime and !aboutme ─────────────
     !uptime: how long the stream has been live, from OBS (stream control has to be connected).
     !aboutme: where the music comes from, a message you can change ({placeholders} filled in). */
  const ABOUT_DEFAULT = "🌙 the music here plays from moonlit {version}, a little music player running on {owner} {os} PC. it's been open for {open}, with {songs} in the library. get it: {link}";
  const OPENED = Date.now();
  const span = ms => {
    const s = Math.max(0, Math.floor(ms / 1000)), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    const part = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    if (d) return `${part(d, 'day')} ${part(h, 'hour')}`;
    if (h) return `${part(h, 'hour')} ${part(m, 'minute')}`;
    if (m) return `${part(m, 'minute')} ${part(s % 60, 'second')}`;
    return part(s % 60, 'second');
  };
  const osName = () => { const p = navigator.platform || ''; return /win/i.test(p) ? 'Windows' : /mac/i.test(p) ? 'Mac' : /linux/i.test(p) ? 'Linux' : ''; };
  let version = '';
  if (D.version) D.version().then(v => { version = v; }).catch(() => {});

  async function uptimeAnswer() {
    const s = window.obsStreamStatus ? await window.obsStreamStatus() : null;
    if (!s) return "I can't see the stream's uptime right now (OBS isn't connected to moonlit).";
    if (!s.live) return "the stream isn't live right now.";
    return `⏱ the stream has been live for ${span(s.ms)}${s.reconnecting ? ' (reconnecting right now)' : ''}.`;
  }
  function aboutAnswer() {
    const name = prefs.get('name', '').trim();
    const os = osName();
    const fill = {
      version: version ? `v${version}` : '',
      owner: name ? `${name}'s` : 'the streamer\'s',
      name: name || 'the streamer',
      os,
      open: span(Date.now() - OPENED),
      songs: `${state.tracks.length.toLocaleString()} song${state.tracks.length === 1 ? '' : 's'}`,
      link: 'elliesxofc.github.io/musicplayer',
    };
    return (prefs.get('aboutMe', '') || ABOUT_DEFAULT)
      .replace(/\{(\w+)\}/g, (all, k) => (k in fill ? fill[k] : all))
      .replace(/\s{2,}/g, ' ').replace(/\s+([.,)])/g, '$1').trim();
  }

  const lastInfo = {};
  C.onCommand(async ({ cmd }) => {
    if (cmd !== 'uptime' && cmd !== 'aboutme') return;
    if (!prefs.get(cmd === 'uptime' ? 'cmdUptime' : 'cmdAbout', true)) return;
    // one answer every 10 seconds per command, however many people ask
    if (Date.now() - (lastInfo[cmd] || 0) < 10_000) return;
    lastInfo[cmd] = Date.now();
    C.say(cmd === 'uptime' ? await uptimeAnswer() : aboutAnswer());
  });

  const cmdUptime = $('#cmdUptime'), cmdAbout = $('#cmdAbout'), aboutText = $('#aboutText');
  cmdUptime.checked = prefs.get('cmdUptime', true);
  cmdAbout.checked = prefs.get('cmdAbout', true);
  cmdUptime.onchange = () => prefs.set('cmdUptime', cmdUptime.checked);
  cmdAbout.onchange = () => { prefs.set('cmdAbout', cmdAbout.checked); $('#aboutField').hidden = !cmdAbout.checked; };
  $('#aboutField').hidden = !cmdAbout.checked;
  aboutText.value = prefs.get('aboutMe', '') || ABOUT_DEFAULT;
  const showAbout = () => { $('#aboutPreview').textContent = `the bot answers: ${aboutAnswer()}`; };
  aboutText.oninput = () => {
    const v = aboutText.value.trim();
    prefs.set('aboutMe', v && v !== ABOUT_DEFAULT ? v.slice(0, 400) : '');
    showAbout();
  };
  $('#aboutReset').onclick = () => { aboutText.value = ABOUT_DEFAULT; prefs.set('aboutMe', ''); showAbout(); };
  $('#settingsBtn').addEventListener('click', () => setTimeout(showAbout, 80));
  showAbout();

  // what the bot would answer right now, shown while the settings are open
  async function preview() {
    if ($('#settings').hidden) return;
    $('#chatPreview').textContent = `the bot answers: ${await C.preview()}`;
  }
  setInterval(preview, 2000);
  $('#settingsBtn').addEventListener('click', () => setTimeout(preview, 50));

  /* ───────────── start ───────────── */
  (async () => {
    $('#spotifySection').hidden = false;
    $('#chatSection').hidden = false;
    const info = await S.get();
    if (info) {
      $('#spRedirect').value = info.redirect;
      $('#spClientId').value = info.clientId;
      showConnected(info.connected);
      setStatus($('#spStatus'), info.status);
      if (info.state) update(info.state);
      // Windows: the Spotify app first; elsewhere only the account way exists, so show it open
      const local = info.local || {};
      $('#spLocalBox').hidden = !local.available;
      $('#spLocalOn').checked = !!local.on;
      setStatus($('#spLocalStatus'), local.status || { text: '', kind: 'off' });
      if (!local.available) { $('#spWeb').open = true; $('#spWebSummary').textContent = 'connect your Spotify account (Spotify only allows this with Premium)'; }
      if (info.connected) $('#spWeb').open = true;
    }
    const c = await C.get();
    on.checked = c.enabled;
    stream.value = c.stream;
    if (c.hasLogin) login.placeholder = 'saved ✓ (paste a new one to replace it)';
    setStatus($('#chatStatus'), c.status);
  })();
})();
