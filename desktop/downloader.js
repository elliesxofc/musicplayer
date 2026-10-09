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

function createDownloader({ send, readConfig, writeConfig, allowRead }) {
  const binDir = path.join(app.getPath('userData'), 'bin');
  // MOONLIT_YTDLP lets tests point at a stand-in program
  const ytdlp = process.env.MOONLIT_YTDLP || path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  const jobs = new Map();
  const running = new Map(); // job id → child process
  let nextId = 1;
  let ready = null;

  const outDir = () => readConfig().downloadDir || path.join(app.getPath('music'), 'moonlit');
  const update = job => { if (jobs.has(job.id)) send('dl:update', publicJob(job)); };
  const publicJob = j => ({
    id: j.id, title: j.title, artist: j.artist, source: j.source, status: j.status,
    progress: j.progress, speed: j.speed, eta: j.eta, error: j.error, file: j.file, format: j.format,
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
      jobs.delete(placeholder.id);
      send('dl:remove', placeholder.id);
      if (!items.length) return { ok: false, error: 'no songs found in that link' };
      for (const it of items) newJob({ ...it, format });
      pump();
      return { ok: true, count: items.length };
    } catch (err) {
      Object.assign(placeholder, { status: 'error', title: url, error: err.message || String(err) });
      update(placeholder);
      return { ok: false, error: placeholder.error };
    }
  }

  async function readLink(url) {
    const info = await runJson(['--flat-playlist', '-J', '--no-playlist', url]);
    const entries = info._type === 'playlist' ? (info.entries || []).filter(Boolean) : [info];
    return entries.map(e => ({
      source: 'youtube',
      url: e.webpage_url || e.url || (e.id && /youtube/i.test(e.ie_key || info.extractor || '') ? `https://www.youtube.com/watch?v=${e.id}` : url),
      title: e.title || 'untitled',
      artist: e.artist || e.channel || e.uploader || '',
    }));
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
    const q = `${job.artist} - ${job.title}`.replace(/"/g, '');
    const info = await runJson(['--flat-playlist', '-J', `ytsearch6:${q} audio`]);
    const pick = pickMatch(info.entries || [], job);
    if (!pick) throw new Error("couldn't find this song on YouTube");
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
      if (job.source === 'spotify' && !job.url) {
        job.status = 'finding'; update(job);
        job.url = await findOnYouTube(job);
      }
      if (job.status === 'cancelled') return;
      job.status = 'downloading'; update(job);
      const file = await download(job);
      job.file = job.source === 'spotify' ? await retag(file, job) : file;
      allowRead(job.file);
      Object.assign(job, { status: 'done', progress: 100, speed: '', eta: '' });
    } catch (err) {
      if (job.status !== 'cancelled') Object.assign(job, { status: 'error', error: err.message || String(err) });
    } finally {
      running.delete(job.id);
      update(job);
      pump();
    }
  }

  function download(job) {
    const dir = outDir();
    fs.mkdirSync(dir, { recursive: true });
    const args = [
      ...baseArgs(),
      '--no-playlist',
      '-f', job.format === 'm4a' ? 'bestaudio[ext=m4a]/bestaudio/best' : 'bestaudio/best',
      '-x', '--audio-format', job.format, '--audio-quality', '0',
      '--embed-metadata', '--embed-thumbnail', '--convert-thumbnails', 'jpg',
      // speed: fetch several pieces at once, in larger chunks
      '-N', '4', '--http-chunk-size', '10M',
      '--no-mtime', '--newline', '--progress',
      '--progress-template', 'download:MOONLIT_PROGRESS %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
      '--print', 'after_move:MOONLIT_FILE %(filepath)s',
      '-o', path.join(dir, '%(artist,uploader,channel)s - %(title).150B.%(ext)s'),
    ];
    if (job.source !== 'spotify') {
      // "Artist - Song (Official Video)" → artist "Artist", title "Song"
      args.push('--parse-metadata', 'title:%(artist)s - %(title)s');
      args.push('--replace-in-metadata', 'title', '(?i)\\s*[\\(\\[][^\\)\\]]*(official|lyrics?|audio|video|visuali[sz]er|hd|hq|4k|m/?v)[^\\)\\]]*[\\)\\]]', '');
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
    const clean = s => String(s).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
    let target = path.join(path.dirname(file), `${clean(job.artist) || 'unknown'} - ${clean(job.title) || 'untitled'}${ext}`);
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
    if (fs.existsSync(target) && path.resolve(target) !== path.resolve(file)) {
      target = target.replace(new RegExp(`${ext.replace('.', '\\.')}$`), ` (${job.id})${ext}`);
    }
    fs.rmSync(file, { force: true });
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
    jobs.delete(id);
    send('dl:remove', id);
    pump();
  }

  function retry(id) {
    const job = jobs.get(id);
    if (!job || job.status !== 'error') return;
    Object.assign(job, { status: 'queued', error: '', progress: 0 });
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

  function stopAll() {
    for (const p of running.values()) if (p) p.kill();
  }

  return {
    add, cancel, retry, clearFinished, chooseFolder, openFolder, stopAll,
    list: () => [...jobs.values()].map(publicJob),
    folder: outDir,
  };
}

module.exports = { createDownloader };
