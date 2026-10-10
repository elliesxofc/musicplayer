'use strict';

/* !song in YouTube live chat (desktop app only).
   moonlit reads your stream's chat (no login needed for that) and a bot account answers
   "!song" with what's playing, the same song the OBS overlay shows. Give it your channel
   (@handle or channel link) and it finds your live stream by itself every time you go live,
   or give it one stream's link. */

const { Masterchat, stringify } = require('masterchat');

const COMMAND = /^!(song|np|nowplaying|currentsong)\b/i;
// song requests: handled by the player (it knows the library and the queue)
const REQUEST_COMMAND = /^!(sr|songrequest|queue|q|skip|wrongsong)(?:\s+([\s\S]*))?$/i;
const REPLY_GAP = 5000; // one answer every 5 seconds at most, however many people ask
const RETRY = 60_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// What the user typed → a stream to join, or a channel to find the live stream of.
function parseTarget(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^@[\w.\-·]{3,100}$/.test(s)) return { kind: 'channel', path: `/${s}` };
  if (/^UC[\w-]{22}$/.test(s)) return { kind: 'channel', path: `/channel/${s}` };
  if (/^[\w-]{11}$/.test(s)) return { kind: 'video', id: s };
  let url;
  try { url = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  const host = url.hostname.replace(/^(www|m)\./, '');
  const parts = url.pathname.split('/').filter(Boolean);
  if (host === 'youtu.be' && /^[\w-]{11}$/.test(parts[0] || '')) return { kind: 'video', id: parts[0] };
  if (host !== 'youtube.com' && host !== 'studio.youtube.com') return null;
  const v = url.searchParams.get('v');
  if (v && /^[\w-]{11}$/.test(v)) return { kind: 'video', id: v };
  if (['live', 'shorts', 'embed'].includes(parts[0]) && /^[\w-]{11}$/.test(parts[1] || '')) return { kind: 'video', id: parts[1] };
  // studio.youtube.com/video/ID/livestreaming
  if (parts[0] === 'video' && /^[\w-]{11}$/.test(parts[1] || '')) return { kind: 'video', id: parts[1] };
  if (parts[0]?.startsWith('@')) return { kind: 'channel', path: `/${parts[0]}` };
  if (['channel', 'c', 'user'].includes(parts[0]) && parts[1]) return { kind: 'channel', path: `/${parts[0]}/${parts[1]}` };
  return null;
}

// youtube.com/<channel>/live shows the live stream's page while you're live, and the channel
// (or an upcoming stream) otherwise.
function liveIdFromPage(html) {
  const canon = /<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/.exec(html);
  if (!canon) return null;
  return /"isLiveNow":true/.test(html) ? canon[1] : null;
}

async function findLive(path) {
  const res = await fetch(`https://www.youtube.com${path}/live`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'SOCS=CAI; CONSENT=YES+1' },
  });
  if (res.status === 404) throw new Error("that channel wasn't found");
  return liveIdFromPage(await res.text());
}

// The bot login: the bot account's YouTube cookies as base64-encoded JSON (the same value the
// song request app uses). Quotes, line breaks or the plain JSON are fine too.
const COOKIES = ['SAPISID', 'APISID', 'HSID', 'SID', 'SSID'];
function parseLogin(raw) {
  const text = String(raw || '').trim().replace(/^(["'])([\s\S]*)\1$/, '$2').trim();
  let parsed;
  try {
    parsed = JSON.parse(text.startsWith('{') ? text : Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('utf8'));
  } catch {
    throw new Error("the bot login isn't the line PowerShell printed, or it was cut off");
  }
  const missing = COOKIES.filter(k => typeof parsed?.[k] !== 'string' || !parsed[k]);
  if (missing.length) throw new Error(`the bot login is missing ${missing.join(', ')}`);
  return parsed;
}

const clock = s => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
};

// The answer, e.g. "🎵 now playing: Artist - Title (1:23 / 3:45)". YouTube allows 200 characters.
function replyFor(np) {
  if (!np || !np.id) return 'nothing is playing right now';
  // plain "Artist - Title": the OBS format may already have its own emoji or words around it
  const song = [np.artist, np.title].filter(Boolean).join(' - ') || np.line || 'a song';
  const time = np.duration ? ` (${clock(np.position)} / ${clock(np.duration)})` : np.position >= 1 ? ` (${clock(np.position)})` : '';
  const where = np.source === 'spotify' ? ' on Spotify' : '';
  const state = np.playing ? '' : ' (paused)';
  const tail = `${time}${where}${state}`;
  const head = '🎵 now playing: ';
  const room = 200 - head.length - tail.length;
  return head + (song.length > room ? `${song.slice(0, room - 1)}…` : song) + tail;
}

// YouTube allows 200 characters per message: longer answers go out in parts, split between words
function splitMessage(text, max = 200) {
  const parts = [];
  let rest = String(text).trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

function createChat({ nowPlaying, onStatus, onCommand = () => {} }) {
  let mc = null, timer = null, run = 0, target = null, login = null, lastReply = 0;
  let status = { text: 'off', kind: 'off' };
  const setStatus = (text, kind) => { status = { text, kind }; onStatus(status); };

  function stop() {
    run++;
    clearTimeout(timer);
    if (mc) { mc.removeAllListeners(); try { mc.stop(); } catch { /* already stopped */ } mc = null; }
  }

  function later(me, ms = RETRY) {
    clearTimeout(timer);
    timer = setTimeout(() => { if (me === run) connect(); }, ms);
  }

  async function connect() {
    const me = run;
    if (mc) { mc.removeAllListeners(); try { mc.stop(); } catch { /* fine */ } mc = null; }
    try {
      let videoId = target.id;
      if (target.kind === 'channel') {
        setStatus('looking for your live stream…', 'wait');
        videoId = await findLive(target.path);
        if (me !== run) return;
        if (!videoId) { setStatus("waiting for you to go live (checks every minute)", 'wait'); return later(me); }
      }
      const chat = await Masterchat.init(videoId, { credentials: login, mode: 'live' });
      if (me !== run) { chat.stop(); return; }
      mc = chat;
      mc.on('chat', item => answer(item));
      mc.on('error', err => {
        if (me !== run) return;
        setStatus(`lost the chat (${err.message || err}), trying again in a minute`, 'warn');
        later(me);
      });
      mc.on('end', () => {
        if (me !== run) return;
        if (target.kind === 'channel') { setStatus('your stream ended, waiting for the next one', 'wait'); later(me); }
        else setStatus('that stream has ended. use your channel instead, so moonlit finds the next one', 'warn');
      });
      mc.listen({ ignoreFirstResponse: true });
      setStatus(`answering !song in “${mc.title || 'your stream'}”`, 'on');
    } catch (err) {
      if (me !== run) return;
      const msg = err && err.message ? err.message : String(err);
      setStatus(`couldn't join the chat (${msg}), trying again in a minute`, 'warn');
      later(me);
    }
  }

  function answer(item) {
    const text = stringify(item.message || []).trim();
    const request = REQUEST_COMMAND.exec(text);
    if (request && mc) {
      const cmd = request[1].toLowerCase();
      onCommand({
        cmd: { songrequest: 'sr', q: 'queue' }[cmd] || cmd,
        args: (request[2] || '').trim().slice(0, 300),
        user: { id: item.authorChannelId, name: item.authorName || 'someone', mod: !!item.isModerator, owner: !!item.isOwner },
      });
      return;
    }
    if (!COMMAND.test(text) || !mc) return;
    const now = Date.now();
    if (now - lastReply < REPLY_GAP) return;
    lastReply = now;
    mc.sendMessage(replyFor(nowPlaying())).catch(err => {
      setStatus(`couldn't answer in chat (${err.message || err}). check the bot login`, 'warn');
    });
  }

  // an answer from the player (song requests), split into 200-character messages
  function say(text) {
    if (!mc || !text) return;
    for (const part of splitMessage(text)) {
      mc.sendMessage(part).catch(err => setStatus(`couldn't answer in chat (${err.message || err}). check the bot login`, 'warn'));
    }
  }

  return {
    status: () => status,
    preview: () => replyFor(nowPlaying()),
    say,
    // settings: { enabled, stream, login } (login already decrypted)
    start(settings) {
      stop();
      if (!settings || !settings.enabled) return setStatus('off', 'off');
      target = parseTarget(settings.stream);
      if (!target) return setStatus('add your channel (like @yourname) or a stream link', 'warn');
      if (!settings.login) return setStatus('add the bot login, so the bot can answer in chat', 'warn');
      try { login = parseLogin(settings.login); } catch (err) { return setStatus(err.message, 'warn'); }
      connect();
    },
    stop() { stop(); setStatus('off', 'off'); },
  };
}

module.exports = { createChat, parseTarget, liveIdFromPage, parseLogin, replyFor, splitMessage, REQUEST_COMMAND };
