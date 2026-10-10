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
  function findInLibrary(query) {
    const q = norm(query);
    const words = q.split(' ').filter(Boolean);
    if (q.length < 3 || !words.length) return null;
    let best = null, bestScore = Infinity;
    for (const t of state.tracks) {
      const title = norm(t.title);
      const hay = `${norm(t.artist)} ${title} ${norm(t.album)}`;
      if (!words.every(w => hay.includes(w))) continue;
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
      await openExternalFiles([result.file], { play: false, quiet: true });
      track = byId((openExternalFiles.ids || [])[0]);
      if (!track) return say(`${user.name}, something went wrong adding that song.`);
      if (job.cancelled) return; // they took it back (!wrongsong) while it downloaded: it stays in the library only
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
    songRequests.splice(songRequests.indexOf(q), 1);
    requestsChanged();
    cooldowns.delete(user.id);
    say(`${user.name}, ${songName(byId(q.id) || { title: 'your song' })} was removed from the queue.`);
  }

  C.onCommand(({ cmd, args, user }) => {
    if (!on()) return;
    if (cmd === 'sr') request(user, args);
    else if (cmd === 'queue') queue();
    else if (cmd === 'skip') skip(user);
    else if (cmd === 'wrongsong') wrongSong(user);
  });

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
      li.querySelector('[data-act="play"]').onclick = () => { songRequests.splice(songRequests.indexOf(r), 1); requestsChanged(); playTrack(r.id); };
      li.querySelector('[data-act="remove"]').onclick = () => { songRequests.splice(songRequests.indexOf(r), 1); requestsChanged(); };
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
  const srOn = $('#srOn'), srAny = $('#srAny'), srChannels = $('#srChannels'), srMax = $('#srMax');
  srOn.checked = on();
  srAny.checked = prefs.get('srAny', false);
  srChannels.value = prefs.get('srChannels', DEFAULT_CHANNELS);
  srMax.value = maxMinutes();
  $('#srChannelsField').hidden = srAny.checked;
  srOn.onchange = () => prefs.set('srOn', srOn.checked);
  srAny.onchange = () => { prefs.set('srAny', srAny.checked); $('#srChannelsField').hidden = srAny.checked; };
  srChannels.onchange = () => prefs.set('srChannels', srChannels.value.trim() || DEFAULT_CHANNELS);
  srMax.onchange = () => { prefs.set('srMax', Math.max(1, Math.min(60, Math.round(Number(srMax.value) || 10)))); srMax.value = maxMinutes(); };
})();
