'use strict';

/* moonlit downloader (desktop app only).
   - YouTube / YouTube Music / SoundCloud and anything else yt-dlp supports: downloaded as audio.
   - Spotify links: Spotify's own audio is copy-protected and is never touched. We only read
     the song names from the link, find each song on YouTube, and tag the file with the
     Spotify title / artist / album / cover.
   Speed: several downloads run side by side, each fetching in parallel chunks. */

const { app, net, dialog, shell } = require('electron');
const { pickMatch } = require('./match');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const PARALLEL = 3;
const UPDATE_EVERY_MS = 3 * 24 * 60 * 60 * 1000;
const YTDLP_ASSET = { win32: 'yt-dlp.exe', darwin: 'yt-dlp_macos', linux: 'yt-dlp_linux' }[process.platform] || 'yt-dlp';
const YTDLP_URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_ASSET}`;

function ffmpegPath() {
  if (process.env.MOONLIT_FFMPEG) return process.env.MOONLIT_FFMPEG; // tests
  try {
    // packed apps keep binaries next to the archive, in app.asar.unpacked
    return require('ffmpeg-static').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  } catch { return null; }
}

// words that make a different version of a song: asked for, it has to be that version;
// not asked for, the normal song wins
const VERSION_WORDS = 'instrumental|karaoke|acapella|a cappella|acoustic|remix|live|cover|slowed|reverb|sped up|speed up|nightcore|8d|extended|piano|orchestral|lofi|lo-fi|bass boosted|radio edit|cut|demo';
const versionRe = () => new RegExp(`\\b(${VERSION_WORDS})\\b`, 'gi');
const plain = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const versionsIn = s => new Set((plain(s).match(versionRe()) || []).map(v => v.replace(/^speed up$/, 'sped up')));
// how well a search result fits what was asked: the asked-for words in its title, the right version
function requestScore(entry, query) {
  const title = plain(`${entry.title || ''} ${entry.channel || entry.uploader || ''}`);
  const words = plain(query).split(' ').filter(w => w.length > 1);
  let score = words.filter(w => title.includes(w)).length * 2;
  const asked = versionsIn(query), got = versionsIn(entry.title);
  for (const v of asked) score += got.has(v) ? 8 : -8;
  for (const v of got) if (!asked.has(v)) score -= 5;
  return score;
}

// "Artist - Title.m4a": the name Spotify songs are saved under (see retag)
const cleanName = s => String(s).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
const spotifyFileName = (job, ext) => `${cleanName(job.artist) || 'unknown'} - ${cleanName(job.title) || 'untitled'}${ext}`;

// A playlist saved as a .csv file, e.g. from exportify.net (Spotify) or TuneMyMusic.
// Reads quoted fields (commas, quotes and line breaks inside them) and finds the columns by name.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  text = String(text).replace(/^\uFEFF/, '');
  // some spreadsheet apps save with semicolons instead of commas
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const sep = !firstLine.includes(',') && firstLine.includes(';') ? ';' : ',';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(f => f.trim())) rows.push(row);
  return rows;
}

function readPlaylistCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = (...names) => head.findIndex(h => names.includes(h));
  const title = col('track name', 'title', 'name', 'track', 'song', 'song name');
  const artist = col('artist name(s)', 'artist name', 'artist', 'artists', 'artist(s)');
  const album = col('album name', 'album', 'album title');
  const ms = col('duration (ms)', 'track duration (ms)', 'duration_ms');
  const cover = col('album image url', 'image url', 'album art', 'cover');
  if (title < 0) return [];
  return rows.slice(1).map(r => ({
    source: 'spotify',
    title: (r[title] || '').replace(/\s+/g, ' ').trim(),
    // Exportify separates several artists with commas
    artist: artist >= 0 ? (r[artist] || '').split(/\s*,\s*/).filter(Boolean).join(', ') : '',
    album: album >= 0 ? (r[album] || '').replace(/\s+/g, ' ').trim() : '',
    cover: cover >= 0 && /^https:\/\//.test(r[cover] || '') ? r[cover].trim() : '',
    durationMs: ms >= 0 ? Number(r[ms]) || 0 : 0,
  })).filter(it => it.title);
}

function createDownloader({ send, readConfig, writeConfig, allowRead }) {
  const binDir = path.join(app.getPath('userData'), 'bin');
  // MOONLIT_YTDLP lets tests point at a stand-in program
  const ytdlp = process.env.MOONLIT_YTDLP || path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  const jobs = new Map();
  const running = new Map(); // job id → child process
  let nextId = 1, nextGroup = 1;
  const usedVideos = new Map(); // album/playlist → YouTube videos already picked for its songs
  let ready = null;

  const outDir = () => readConfig().downloadDir || path.join(app.getPath('music'), 'moonlit');
  const update = job => { if (jobs.has(job.id)) send('dl:update', publicJob(job)); };
  const publicJob = j => ({
    id: j.id, title: j.title, artist: j.artist, source: j.source, status: j.status,
    progress: j.progress, speed: j.speed, eta: j.eta, error: j.error, file: j.file, format: j.format, note: j.note || '', matched: j.matched || '',
  });
  const status = text => send('dl:status', text);

  /* ───────────── yt-dlp itself: fetched on first use, kept fresh ───────────── */
  async function fetchYtDlp() {
    status('getting the downloader ready (one time, ~20 MB)…');
    fs.mkdirSync(binDir, { recursive: true });
    const res = await net.fetch(YTDLP_URL);
    if (!res.ok) throw new Error(`couldn't download yt-dlp (${res.status})`);
    const tmp = `${ytdlp}.download`;
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, ytdlp);
    writeConfig({ ytdlpCheckedAt: Date.now() });
  }

  function selfUpdate() {
    return new Promise(resolve => {
      status('checking the downloader for updates…');
      const p = spawn(ytdlp, ['-U'], { windowsHide: true });
      const timer = setTimeout(() => p.kill(), 60000);
      p.on('error', () => resolve());
      p.on('close', () => { clearTimeout(timer); writeConfig({ ytdlpCheckedAt: Date.now() }); resolve(); });
    });
  }

  function ensureReady() {
    if (!ready) {
      ready = (async () => {
        if (!fs.existsSync(ytdlp)) await fetchYtDlp();
        else if (Date.now() - (readConfig().ytdlpCheckedAt || 0) > UPDATE_EVERY_MS) await selfUpdate();
        status('');
      })().catch(err => { ready = null; status(''); throw err; });
    }
    return ready;
  }

  /* ───────────── running yt-dlp ───────────── */
  function baseArgs() {
    const args = ['--no-warnings', '--no-colors', '--encoding', 'utf-8', '--windows-filenames'];
    const ff = ffmpegPath();
    if (ff) args.push('--ffmpeg-location', ff);
    // YouTube needs a JavaScript engine: the app's own (Electron can act as Node)
    args.push('--js-runtimes', `node:${process.execPath}`);
    return args;
  }
  const env = () => ({ ...process.env, ELECTRON_RUN_AS_NODE: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' });

  function runJson(args) {
    return new Promise((resolve, reject) => {
      const p = spawn(ytdlp, [...baseArgs(), ...args], { env: env(), windowsHide: true });
      let out = '', err = '';
      p.stdout.on('data', d => { out += d; });
      p.stderr.on('data', d => { err += d; });
      p.on('error', reject);
      p.on('close', code => {
        if (code !== 0) return reject(new Error(friendlyError(err)));
        try { resolve(JSON.parse(out)); } catch { reject(new Error("couldn't read that link")); }
      });
    });
  }

  function friendlyError(text) {
    const line = (text.match(/ERROR:.*$/m) || [String(text).trim().split('\n').pop() || 'something went wrong'])[0]
      .replace(/^ERROR:\s*(\[[^\]]+\]\s*)?([\w-]+:\s*)?/, '');
    if (/sign in to confirm|not a bot/i.test(line)) return 'YouTube wants a sign-in check right now. Try again in a little while';
    if (/private video/i.test(line)) return 'this video is private';
    if (/video unavailable|not available/i.test(line)) return "this video isn't available";
    if (/unsupported url/i.test(line)) return "that link isn't supported";
    if (/getaddrinfo|network|timed out|connection/i.test(line)) return 'no internet connection?';
    return line.slice(0, 160);
  }

  /* ───────────── adding links ───────────── */
  const isSpotify = url => /(^spotify:|open\.spotify\.com\/|play\.spotify\.com\/)/i.test(url);

  function newJob(fields) {
    const job = { id: nextId++, status: 'queued', progress: 0, speed: '', eta: '', error: '', file: '', ...fields };
    jobs.set(job.id, job);
    update(job);
    return job;
  }

  async function add(url, format) {
    url = String(url || '').trim();
    if (!/^(https?:\/\/|spotify:)/i.test(url)) return { ok: false, error: 'paste a link that starts with https://' };
    format = format === 'mp3' ? 'mp3' : 'm4a';
    const placeholder = newJob({ title: 'reading the link…', source: isSpotify(url) ? 'spotify' : 'youtube', status: 'reading', format });
    try {
      await ensureReady();
      const items = isSpotify(url) ? await readSpotify(url) : await readLink(url);
      const skipped = items.skipped || 0;
      jobs.delete(placeholder.id);
      send('dl:remove', placeholder.id);
      if (!items.length) return { ok: false, error: skipped ? 'every video in that playlist is deleted or private' : 'no songs found in that link' };
      const group = nextGroup++;
      for (const it of items) newJob({ ...it, format, group });
      pump();
      return { ok: true, count: items.length, skipped };
    } catch (err) {
      Object.assign(placeholder, { status: 'error', title: url, error: err.message || String(err) });
      update(placeholder);
      return { ok: false, error: placeholder.error };
    }
  }

  // every song in a playlist file (.csv), with no 100-song limit
  async function addList(text, format) {
    format = format === 'mp3' ? 'mp3' : 'm4a';
    const items = readPlaylistCsv(text);
    if (!items.length) return { ok: false, error: "that file doesn't look like a playlist (no song names in it)" };
    try { await ensureReady(); } catch (err) { return { ok: false, error: err.message || String(err) }; }
    const group = nextGroup++;
    for (const it of items) newJob({ ...it, format, group, skipExisting: true });
    pump();
    return { ok: true, count: items.length };
  }

  async function readLink(url) {
    const info = await runJson(['--flat-playlist', '-J', '--no-playlist', url]);
    const all = info._type === 'playlist' ? (info.entries || []).filter(Boolean) : [info];
    // playlists keep placeholders for removed videos; those can't be downloaded
    const gone = e => /^\[(deleted|private) video\]$/i.test(e.title || '') || e.availability === 'private';
    const entries = all.filter(e => !gone(e));
    const items = entries.map(e => ({
      source: 'youtube',
      url: e.webpage_url || e.url || (e.id && /youtube/i.test(e.ie_key || info.extractor || '') ? `https://www.youtube.com/watch?v=${e.id}` : url),
      title: e.title || 'untitled',
      artist: e.artist || e.channel || e.uploader || '',
    }));
    items.skipped = all.length - entries.length;
    return items;
  }

  async function readSpotify(url) {
    const { getDetails } = require('spotify-url-info')((u, o) => net.fetch(u, o));
    let details;
    try { details = await getDetails(url); } catch (err) {
      throw new Error(/parse|valid url/i.test(err.message) ? "that Spotify link couldn't be read" : 'no internet connection?');
    }
    const { preview, tracks } = details;
    const album = preview.type === 'album' ? preview.title : '';
    // album and single-song links share one cover; playlists use each song's YouTube cover
    const cover = preview.type === 'album' || preview.type === 'track' ? preview.image : '';
    return tracks.filter(t => t && t.name).map(t => ({
      source: 'spotify', title: t.name, artist: t.artist || '', album, cover, durationMs: t.duration || 0,
    }));
  }

  /* ───────────── matching a Spotify song on YouTube ───────────── */
  async function findOnYouTube(job) {
    const q = `${job.artist.split(',')[0]} ${job.title}`.replace(/"/g, '').trim();
    // search YouTube Music's song results (cleanest for this) and normal YouTube, side by side
    const [music, yt] = await Promise.all([
      runJson(['--flat-playlist', '-J', '--playlist-end', '8', `https://music.youtube.com/search?q=${encodeURIComponent(q)}#songs`]).catch(() => ({})),
      runJson(['--flat-playlist', '-J', `ytsearch8:${q}`]).catch(() => ({})),
    ]);
    const entries = [...(music.entries || []).map(e => ({ ...e, fromMusic: true })), ...(yt.entries || [])];
    if (!entries.length) throw new Error("couldn't search YouTube right now");
    if (!usedVideos.has(job.group)) usedVideos.set(job.group, new Set());
    const used = usedVideos.get(job.group);
    const pick = pickMatch(entries, job, used);
    if (!pick) throw new Error("couldn't find this exact song on YouTube");
    used.add(pick.id); // no other song in this album / playlist gets the same video
    job.matched = pick.title || '';
    return `https://www.youtube.com/watch?v=${pick.id}`;
  }

  /* ───────────── downloading ───────────── */
  function pump() {
    for (const job of jobs.values()) {
      if (running.size >= PARALLEL) return;
      if (job.status === 'queued') start(job);
    }
  }

  async function start(job) {
    running.set(job.id, null);
    try {
      // a playlist file imported again: songs already in the download folder aren't fetched twice
      if (job.skipExisting) {
        const have = path.join(outDir(), spotifyFileName(job, `.${job.format}`));
        if (fs.existsSync(have)) {
          job.file = have;
          job.note = 'already downloaded';
          allowRead(have);
          Object.assign(job, { status: 'done', progress: 100 });
          return;
        }
      }
      if (job.source === 'spotify' && !job.url) {
        job.status = 'finding'; update(job);
        job.url = await findOnYouTube(job);
      }
      if (job.status === 'cancelled') return;
      job.status = 'downloading'; job.note = ''; update(job);
      const file = await download(job);
      job.file = job.source === 'spotify' ? await retag(file, job) : file;
      allowRead(job.file);
      Object.assign(job, { status: 'done', progress: 100, speed: '', eta: '' });
    } catch (err) {
      const message = err.message || String(err);
      if (job.status === 'cancelled') { /* nothing to do */ }
      else if (RETRYABLE.test(message) && (job.attempts || 0) < 2) {
        // YouTube sometimes refuses a download (403), mostly when it's busy: wait, then try again more gently
        job.attempts = (job.attempts || 0) + 1;
        Object.assign(job, { status: 'waiting', note: `YouTube said no, trying again (${job.attempts}/2)…`, progress: 0, speed: '', eta: '' });
        setTimeout(() => { if (job.status === 'waiting') { job.status = 'queued'; update(job); pump(); } }, 3000 * job.attempts);
      } else {
        Object.assign(job, { status: 'error', error: message });
      }
    } finally {
      running.delete(job.id);
      update(job);
      settle(job);
      pump();
    }
  }

  const RETRYABLE = /403|forbidden|timed out|connection (reset|aborted)|temporar|incomplete|429/i;

  function download(job) {
    const dir = outDir();
    fs.mkdirSync(dir, { recursive: true });
    const args = [
      ...baseArgs(),
      '--no-playlist',
      '-f', job.format === 'm4a' ? 'bestaudio[ext=m4a]/bestaudio/best' : 'bestaudio/best',
      '-x', '--audio-format', job.format, '--audio-quality', '0',
      '--embed-metadata', '--embed-thumbnail', '--convert-thumbnails', 'jpg',
      // speed: fetch several pieces at once, in larger chunks (retries go one piece at a time)
      ...(job.attempts ? ['--retries', '10', '--fragment-retries', '10'] : ['-N', '4', '--http-chunk-size', '10M', '--retries', '5']),
      '--no-mtime', '--newline', '--progress',
      '--progress-template', 'download:MOONLIT_PROGRESS %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
      '--print', 'after_move:MOONLIT_FILE %(filepath)s',
      // Spotify songs get renamed after tagging, so their temporary name carries the video id:
      // two songs downloading at once can then never write to the same file
      '-o', path.join(dir, job.source === 'spotify'
        ? '%(title).120B [%(id)s].%(ext)s'
        : '%(artist,uploader,channel)s - %(title).150B.%(ext)s'),
    ];
    if (job.source !== 'spotify') {
      // "Artist - Song (Official Video)" → artist "Artist", title "Song"
      args.push('--parse-metadata', 'title:%(artist)s - %(title)s');
      // (brackets naming a version, like "(Official Instrumental)", are kept: that's a different song)
      args.push('--replace-in-metadata', 'title', `(?i)\\s*[\\(\\[](?![^\\)\\]]*(?:${VERSION_WORDS}))[^\\)\\]]*(official|lyrics?|audio|video|visuali[sz]er|hd|hq|4k|m/?v)[^\\)\\]]*[\\)\\]]`, '');
    }
    args.push(job.url);

    return new Promise((resolve, reject) => {
      const p = spawn(ytdlp, args, { env: env(), windowsHide: true });
      running.set(job.id, p);
      let file = '', err = '', buf = '';
      let lastSent = 0;
      p.stdout.on('data', chunk => {
        buf += chunk;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const line of lines) {
          const prog = line.match(/^MOONLIT_PROGRESS\s+([\d.]+)%\|([^|]*)\|(.*)$/);
          if (prog) {
            job.progress = Math.min(99, parseFloat(prog[1]) || 0);
            job.speed = prog[2].trim().replace(/^Unknown.*$/i, '');
            job.eta = prog[3].trim().replace(/^Unknown.*$/i, '');
            if (Date.now() - lastSent > 250) { lastSent = Date.now(); update(job); }
          } else if (line.startsWith('MOONLIT_FILE ')) {
            file = line.slice(13).trim();
          } else if (/^\[(ExtractAudio|EmbedThumbnail|Metadata)\]/.test(line) && job.status !== 'converting') {
            job.status = 'converting'; job.speed = ''; job.eta = ''; update(job);
          }
        }
      });
      p.stderr.on('data', d => { err += d; });
      p.on('error', reject);
      p.on('close', code => {
        if (job.status === 'cancelled') return reject(new Error('cancelled'));
        if (code === 0 && file && fs.existsSync(file)) resolve(file);
        else reject(new Error(friendlyError(err || 'the download stopped')));
      });
    });
  }

  // Give Spotify songs their Spotify name, artist, album (and cover) and a tidy filename.
  async function retag(file, job) {
    const ff = ffmpegPath();
    if (!ff) return file;
    const ext = path.extname(file);
    let target = path.join(path.dirname(file), spotifyFileName(job, ext));
    const tmp = `${file}.moonlit${ext}`;
    let coverFile = '';
    if (job.cover) {
      try {
        const res = await net.fetch(job.cover);
        if (res.ok) { coverFile = `${file}.cover.jpg`; fs.writeFileSync(coverFile, Buffer.from(await res.arrayBuffer())); }
      } catch { /* keep the YouTube cover */ }
    }
    const args = ['-y', '-loglevel', 'error', '-i', file];
    if (coverFile) args.push('-i', coverFile, '-map', '0:a', '-map', '1:0', '-disposition:v:0', 'attached_pic');
    else args.push('-map', '0');
    args.push('-c', 'copy', '-map_metadata', '-1',
      '-metadata', `title=${job.title}`, '-metadata', `artist=${job.artist}`);
    if (job.album) args.push('-metadata', `album=${job.album}`);
    if (ext === '.mp3') args.push('-id3v2_version', '3');
    args.push(tmp);
    const ok = await new Promise(resolve => {
      const p = spawn(ff, args, { windowsHide: true });
      p.on('error', () => resolve(false));
      p.on('close', code => resolve(code === 0));
    });
    if (coverFile) fs.rm(coverFile, () => {});
    if (!ok) { fs.rm(tmp, () => {}); return file; }
    // the same song downloaded again (say, after a wrong match) replaces the old file
    fs.rmSync(file, { force: true });
    fs.rmSync(target, { force: true });
    fs.renameSync(tmp, target);
    return target;
  }

  /* ───────────── controls ───────────── */
  function cancel(id) {
    const job = jobs.get(id);
    if (!job) return;
    if (['done', 'error', 'cancelled'].includes(job.status)) { jobs.delete(id); send('dl:remove', id); return; }
    job.status = 'cancelled';
    const p = running.get(id);
    if (p) p.kill();
    update(job);
    settle(job);
    jobs.delete(id);
    send('dl:remove', id);
    pump();
  }

  function cancelAll() {
    for (const job of [...jobs.values()]) {
      if (!['done', 'error'].includes(job.status)) cancel(job.id);
    }
  }

  function retry(id) {
    const job = jobs.get(id);
    if (!job || job.status !== 'error') return;
    Object.assign(job, { status: 'queued', error: '', note: '', attempts: 0, progress: 0 });
    update(job);
    ensureReady().then(pump, err => { Object.assign(job, { status: 'error', error: err.message }); update(job); });
  }

  function clearFinished() {
    for (const [id, job] of jobs) {
      if (['done', 'error'].includes(job.status)) { jobs.delete(id); send('dl:remove', id); }
    }
  }

  async function chooseFolder() {
    const res = await dialog.showOpenDialog({
      title: 'Where should moonlit save downloaded songs?',
      defaultPath: outDir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return outDir();
    writeConfig({ downloadDir: res.filePaths[0] });
    return res.filePaths[0];
  }

  function openFolder() {
    const dir = outDir();
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  }

  /* ───────────── song requests from chat ─────────────
     One song: a YouTube link, or the best search result. It has to pass the request rules
     (from an allowed channel, not too long, not a live stream), is downloaded once, and the
     file is reused whenever the same video is requested again. */
  const waiters = new Map(); // job id → resolve, for requests waiting on their download
  function settle(job) {
    if (!['done', 'error', 'cancelled'].includes(job.status)) return;
    const done = waiters.get(job.id);
    if (done) { waiters.delete(job.id); done(job); }
  }

  const norm = s => String(s || '').toLowerCase().replace(/^@/, '').trim();
  // "UC_aEa8K-EOJ3D6gOs7HcyNg  # NoCopyrightSounds" → the part before the #
  const channelKeys = list => (list || []).map(l => norm(String(l).split('#')[0])).filter(Boolean);
  const allowedChannel = (e, keys) => keys.some(k => [e.channel_id, e.uploader_id, e.channel, e.uploader].some(v => norm(v) === k));

  async function request(query, { channels = [], anyChannel = false, maxSeconds = 600 } = {}) {
    query = String(query || '').trim();
    if (!query) return { ok: false, reason: 'empty' };
    try {
      await ensureReady();
      const keys = channelKeys(channels);
      let candidates;
      if (/^https?:\/\//i.test(query) || /^(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(query)) {
        const url = /^https?:/i.test(query) ? query : `https://${query}`;
        if (!/(^|\.)(youtube\.com|youtu\.be)$/i.test(new URL(url).hostname)) return { ok: false, reason: 'link' };
        candidates = [await runJson(['-J', '--no-playlist', url])];
      } else {
        const found = await runJson(['--flat-playlist', '-J', `ytsearch10:${query}`]);
        // best fit first (YouTube's own order breaks ties): "Song (Instrumental)" finds the instrumental
        candidates = (found.entries || []).filter(e => e && e.id)
          .map((e, i) => ({ e, i, s: requestScore(e, query) }))
          .sort((a, b) => b.s - a.s || a.i - b.i).map(x => x.e);
      }
      if (!candidates.length) return { ok: false, reason: 'not-found' };
      const live = e => e.live_status === 'is_live' || e.is_live === true || e.live_status === 'is_upcoming';
      const allowed = candidates.filter(e => anyChannel || allowedChannel(e, keys));
      if (!allowed.length) return { ok: false, reason: 'not-allowed', title: candidates[0].title || '' };
      const fits = allowed.filter(e => !live(e) && (!e.duration || e.duration <= maxSeconds));
      if (!fits.length) return { ok: false, reason: live(allowed[0]) ? 'live' : 'too-long', title: allowed[0].title || '' };
      const pick = fits[0];
      const title = pick.title || 'untitled', artist = pick.artist || pick.channel || pick.uploader || '';

      // asked for before: same file again
      const known = (readConfig().requestFiles || {})[pick.id];
      if (known && fs.existsSync(known)) { allowRead(known); return { ok: true, file: known, title, artist, videoId: pick.id, reused: true }; }

      const job = newJob({ source: 'youtube', url: `https://www.youtube.com/watch?v=${pick.id}`, title, artist, format: 'm4a', group: nextGroup++, note: 'song request' });
      const finished = await new Promise(resolve => { waiters.set(job.id, resolve); pump(); });
      if (finished.status !== 'done' || !finished.file) return { ok: false, reason: 'download', title, error: finished.error || 'cancelled' };
      writeConfig({ requestFiles: { ...(readConfig().requestFiles || {}), [pick.id]: finished.file } });
      return { ok: true, file: finished.file, title, artist, videoId: pick.id };
    } catch (err) {
      return { ok: false, reason: 'error', error: err.message || String(err) };
    }
  }

  // a request's download that has played: delete the file (only files moonlit downloaded for requests)
  function forgetRequest(file) {
    const map = { ...(readConfig().requestFiles || {}) };
    const ids = Object.keys(map).filter(k => map[k] === file);
    if (!ids.length) return false;
    for (const k of ids) delete map[k];
    writeConfig({ requestFiles: map });
    fs.rm(file, { force: true }, () => {});
    return true;
  }

  function stopAll() {
    for (const p of running.values()) if (p) p.kill();
  }

  return {
    add, addList, cancel, cancelAll, retry, clearFinished, chooseFolder, openFolder, stopAll, request, forgetRequest,
    list: () => [...jobs.values()].map(publicJob),
    folder: outDir,
  };
}

module.exports = { createDownloader, readPlaylistCsv, requestScore, VERSION_WORDS };
