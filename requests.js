/* moonlit · song requests from YouTube chat (desktop app only), like the song request app:
     !sr <song or YouTube link>   request a song: your library first, otherwise YouTube
     !queue                       the next 3 requested songs
     !skip                        skip the current song (mods and the channel owner)
     !wrongsong                   take back your last request
   Requested songs play next, in the order they came in (songRequests in app.js).
   Uses app.js's helpers ($, prefs, state, byId, next, playTrack, openExternalFiles, …). */
(() => {
  const D = window.moonlitDesktop;
  if (!D || !D.chat || !D.chat.onCommand || !D.download || !D.download.request) return;
  const C = D.chat;

  const COOLDOWN = 10_000;     // between one viewer's requests
  const PER_VIEWER = 3;        // requests one viewer can have waiting
  // copyright-free channels (the song request app's list); editable in settings
  const DEFAULT_CHANNELS = [
    'UC_aEa8K-EOJ3D6gOs7HcyNg  # NoCopyrightSounds',
    'UCiJnBO_XuDsi1SSRAmt4n5g  # NCS Arcade',
    'UCJ6td3C9QlPO9O_J5dF4ZzA  # Monstercat Uncaged',
    'UCp8OOssjSjGZRVYK6zWbNLg  # Monstercat Instinct',
    'UCa_UMppcMsHIzb5LDx1u9zQ  # TheFatRat',
    'UCMg7TTDtUXq2yTu3uqqoprQ  # Epidemic Electronic',
    'UCCeNgETxEJf__ZAAOvU5ZaQ  # Elektronomia',
    'UCAA6pKrh72sARBb7JCfp8AA  # Tobu',
  ].join('\n');

  const on = () => prefs.get('srOn', true);
  const channels = () => prefs.get('srChannels', DEFAULT_CHANNELS).split('\n').map(s => s.trim()).filter(Boolean);
  const maxMinutes = () => Math.max(1, Math.min(60, Number(prefs.get('srMax', 10)) || 10));
  const isMod = u => u.mod || u.owner;
  const songName = t => [t.artist, t.title].filter(Boolean).join(' - ') || t.title;
  const say = text => C.say(text);

  const cooldowns = new Map();  // viewer → when they may request again
  const pending = [];           // requests being found / downloaded: { by, userId, query, cancelled }

  /* ───────────── finding a song in the library ───────────── */
  const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  // versions of a song (instrumental, remix, slowed, …): the same rule as for YouTube searches,
  // asked for means that version, not asked for means the normal song
  const VERSIONS = /\b(instrumental|karaoke|acapella|a cappella|acoustic|remix|live|cover|slowed|reverb|sped up|speed up|nightcore|8d|extended|piano|orchestral|lofi|lo fi|bass boosted|radio edit|cut|demo)\b/g;
  const versionsIn = s => [...new Set((norm(s).match(VERSIONS) || []).map(v => v.replace('speed up', 'sped up')))].sort().join('|');

  function findInLibrary(query) {
    const q = norm(query);
    const words = q.split(' ').filter(Boolean);
    if (q.length < 3 || !words.length) return null;
    const asked = versionsIn(query);
    let best = null, bestScore = Infinity;
    for (const t of state.tracks) {
      const title = norm(t.title);
      const hay = `${norm(t.artist)} ${title} ${norm(t.album)}`;
      if (!words.every(w => hay.includes(w))) continue;
      if (versionsIn(t.title) !== asked) continue; // "Song" isn't "Song (Instrumental)", and the other way round
      // closest match wins: an exact title first, then the one with the least extra text
      const score = title === q || `${norm(t.artist)} ${title}` === q ? -1 : hay.length - q.length;
      if (score < bestScore) { best = t; bestScore = score; }
    }
    return best;
  }

  /* ───────────── commands ───────────── */
  async function request(user, query) {
    if (!query) return say(`${user.name}, type !sr and a song name or a YouTube link.`);
    const mod = isMod(user);
    const until = cooldowns.get(user.id) || 0;
    if (!mod && Date.now() < until) {
      return say(`${user.name}, you're on cooldown. Please wait ${Math.ceil((until - Date.now()) / 1000)} seconds before requesting another song.`);
    }
    const waiting = songRequests.filter(r => r.userId === user.id).length + pending.filter(p => p.userId === user.id && !p.cancelled).length;
    if (!mod && waiting >= PER_VIEWER) return say(`${user.name}, you already have ${PER_VIEWER} songs waiting. Wait for one to play first.`);
    if (!mod) cooldowns.set(user.id, Date.now() + COOLDOWN);

    const link = /https?:\/\/|(^|\s)(www\.)?(youtube\.com|youtu\.be)\//i.test(query);
    let track = link ? null : findInLibrary(query);
    if (!track) {
      const job = { by: user.name, userId: user.id, query, cancelled: false, at: Date.now() };
      pending.push(job);
      render();
      const rules = { channels: channels(), anyChannel: mod || prefs.get('srAny', false), maxSeconds: maxMinutes() * 60 };
      const result = await D.download.request(query, rules).catch(err => ({ ok: false, reason: 'error', error: err.message }));
      pending.splice(pending.indexOf(job), 1);
      render();
      if (!result.ok) {
        cooldowns.delete(user.id); // a request that didn't work doesn't count
        return say(`${user.name}, ${why(result)}`);
      }
      const had = new Set(state.tracks.map(t => t.id));
      await openExternalFiles([result.file], { play: false, quiet: true });
      track = byId((openExternalFiles.ids || [])[0]);
      if (!track) return say(`${user.name}, something went wrong adding that song.`);
      // downloaded just for this request: deleted again once it has played (your own songs never are)
      if (!had.has(track.id) && cleanupOn()) markTemporary(track.id, result.file);
      if (job.cancelled) { dropIfTemporary(track.id); return; } // taken back (!wrongsong) while it downloaded
    }
    // not added: no cooldown for that
    if (track.id === state.currentId && !audio.paused) { cooldowns.delete(user.id); return say(`${user.name}, ${songName(track)} is playing right now.`); }
    if (songRequests.some(r => r.id === track.id)) { cooldowns.delete(user.id); return say(`${user.name}, ${songName(track)} is already in the queue.`); }
    songRequests.push({ id: track.id, by: user.name, userId: user.id, at: Date.now() });
    requestsChanged();
    say(`${user.name}, ${songName(track)} has been added to the queue (#${songRequests.length}).`);
  }

  function why(r) {
    const max = maxMinutes();
    switch (r.reason) {
      case 'not-allowed': return 'you can only request copyright-free songs (like NCS or Monstercat).';
      case 'too-long': return `that song is too long (${max} minutes at most).`;
      case 'live': return "live streams can't be requested.";
      case 'link': return 'only YouTube links work.';
      case 'not-found': case 'empty': return "I couldn't find that song.";
      default: return "I couldn't get that song right now. Try another one.";
    }
  }

  function queue() {
    if (!songRequests.length) return say('There are no songs in the queue.');
    const next3 = songRequests.slice(0, 3).map((r, i) => `${i + 1}. ${songName(byId(r.id) || { title: '?' })}`).join(', ');
    const more = songRequests.length > 3 ? ` (+${songRequests.length - 3} more)` : '';
    say(`Next ${Math.min(3, songRequests.length)} song${songRequests.length === 1 ? '' : 's'} in the queue: ${next3}${more}`);
  }

  function skip(user) {
    if (!isMod(user)) return say(`${user.name}, only mods can skip songs.`);
    const t = byId(state.currentId);
    if (!t) return;
    say(`${user.name} skipped ${songName(t)}.`);
    next();
  }

  function wrongSong(user) {
    // the newest request from this viewer: still downloading, or already in the queue
    const p = [...pending].reverse().find(x => x.userId === user.id && !x.cancelled);
    const q = [...songRequests].reverse().find(r => r.userId === user.id);
    if (p && (!q || p.at > q.at)) {
      p.cancelled = true;
      render();
      cooldowns.delete(user.id);
      return say(`${user.name}, your request for "${p.query}" was removed.`);
    }
    if (!q) return say(`${user.name}, you don't have a song in the queue.`);
    const name = songName(byId(q.id) || { title: 'your song' });
    songRequests.splice(songRequests.indexOf(q), 1);
    dropIfTemporary(q.id);
    requestsChanged();
    cooldowns.delete(user.id);
    say(`${user.name}, ${name} was removed from the queue.`);
  }

  C.onCommand(({ cmd, args, user }) => {
    if (!on()) return;
    if (cmd === 'sr') request(user, args);
    else if (cmd === 'queue') queue();
    else if (cmd === 'skip') skip(user);
    else if (cmd === 'wrongsong') wrongSong(user);
  });

  /* ───────────── requested downloads are temporary ─────────────
     A song downloaded for a request is deleted (from the library and the PC) once it has
     played and moonlit has moved on, or when the request is taken back before it plays.
     Remembered across restarts, so leftovers are cleaned up next time. */
  const cleanupOn = () => prefs.get('srCleanup', true);
  const temporary = new Map(prefs.get('srTemp', []).map(x => [x.id, x.file])); // song id → file
  const played = new Set();
  const saveTemporary = () => prefs.set('srTemp', [...temporary].map(([id, file]) => ({ id, file })));
  function markTemporary(id, file) { temporary.set(id, file); saveTemporary(); }
  function forget(id) {
    const file = temporary.get(id);
    temporary.delete(id);
    played.delete(id);
    saveTemporary();
    state.history = state.history.filter(x => x !== id); // ⏮ won't try to go back to it
    if (byId(id)) removeTrack(id, { ask: false });
    if (file) D.download.forgetRequest(file).catch(() => {});
  }
  // gone unless it's playing now or still waiting in the request list
  const inUse = id => id === state.currentId || songRequests.some(r => r.id === id);
  function dropIfTemporary(id) { if (temporary.has(id) && !inUse(id)) forget(id); }
  audio.addEventListener('playing', () => { if (temporary.has(state.currentId)) played.add(state.currentId); });
  // a new song is loading: requested downloads that have had their turn can go
  audio.addEventListener('loadstart', () => {
    for (const id of [...played]) if (!inUse(id)) forget(id);
  });
  // leftovers from last time (moonlit closed before they played), once the library has loaded
  setTimeout(() => {
    for (const id of [...temporary.keys()]) {
      if (id === state.currentId) played.add(id); // it goes after this play
      else if (!songRequests.some(r => r.id === id)) forget(id);
    }
  }, 5000);

  /* ───────────── the list in the library ───────────── */
  const box = $('#requests'), list = $('#reqList');
  function render() {
    const items = pending.filter(p => !p.cancelled);
    box.hidden = !songRequests.length && !items.length;
    $('#reqCount').textContent = songRequests.length ? `${songRequests.length} waiting` : '';
    list.replaceChildren();
    songRequests.forEach((r, i) => {
      const t = byId(r.id);
      if (!t) return;
      const li = document.createElement('li');
      li.className = 'req';
      li.innerHTML = `<span class="req-text"><span class="req-title"></span><span class="req-by"></span></span>
        <button class="icon-btn" data-act="play" aria-label="play now"><svg><use href="#i-play"/></svg></button>
        <button class="icon-btn" data-act="remove" aria-label="remove request"><svg><use href="#i-x"/></svg></button>`;
      li.querySelector('.req-title').textContent = `${i + 1}. ${songName(t)}`;
      li.querySelector('.req-by').textContent = `requested by ${r.by}`;
      li.querySelector('[data-act="play"]').onclick = () => { songRequests.splice(songRequests.indexOf(r), 1); requestsChanged(); playRequest(r.id); };
      li.querySelector('[data-act="remove"]').onclick = () => { songRequests.splice(songRequests.indexOf(r), 1); requestsChanged(); dropIfTemporary(r.id); };
      list.append(li);
    });
    for (const p of items) {
      const li = document.createElement('li');
      li.className = 'req pending';
      li.innerHTML = '<span class="req-text"><span class="req-title"></span><span class="req-by"></span></span>';
      li.querySelector('.req-title').textContent = `getting "${p.query}" ready…`;
      li.querySelector('.req-by').textContent = `requested by ${p.by}`;
      list.append(li);
    }
  }
  document.addEventListener('moonlit:requests', render);

  /* ───────────── settings ───────────── */
  $('#srBox').hidden = false;
  const srOn = $('#srOn'), srAny = $('#srAny'), srChannels = $('#srChannels'), srMax = $('#srMax'), srCleanup = $('#srCleanup');
  srCleanup.checked = cleanupOn();
  srCleanup.onchange = () => prefs.set('srCleanup', srCleanup.checked);
  srOn.checked = on();
  srAny.checked = prefs.get('srAny', false);
  srChannels.value = prefs.get('srChannels', DEFAULT_CHANNELS);
  srMax.value = maxMinutes();
  $('#srChannelsField').hidden = srAny.checked;
  srOn.onchange = () => prefs.set('srOn', srOn.checked);
  srAny.onchange = () => { prefs.set('srAny', srAny.checked); $('#srChannelsField').hidden = srAny.checked; };
  // saved as you type (an empty box counts as the original list, so requests never lose their rules)
  srChannels.oninput = () => prefs.set('srChannels', srChannels.value.trim() || DEFAULT_CHANNELS);
  srChannels.onchange = () => { if (!srChannels.value.trim()) srChannels.value = DEFAULT_CHANNELS; };
  srMax.oninput = () => { const n = Math.round(Number(srMax.value)); if (n >= 1 && n <= 60) prefs.set('srMax', n); };
  srMax.onchange = () => { prefs.set('srMax', Math.max(1, Math.min(60, Math.round(Number(srMax.value) || 10)))); srMax.value = maxMinutes(); };
})();
