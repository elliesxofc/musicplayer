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
  C.onStatus(s => setStatus($('#chatStatus'), s));

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
