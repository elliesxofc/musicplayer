'use strict';

/* The Spotify app on this PC, through Windows' own media controls (Windows 10/11).
   The Spotify desktop app tells Windows what it's playing (the same info as the media pop-up
   when you press a media key), and lets Windows press play / pause / skip. moonlit reads that
   with a small hidden PowerShell script, so it works with Spotify Free and needs no setup.
   Nothing here talks to Spotify's servers. */

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const readline = require('node:readline');

// shared start of both scripts: load Windows' media controls and a way to wait for them
const PRELUDE = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${'`'}1'
} | Select-Object -First 1
function Await($operation, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
  if (-not $task.Wait(5000)) { throw 'Windows took too long to answer' }
  return $task.Result
}
$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$manager = Await ($managerType::RequestAsync()) $managerType
function Find-Spotify {
  foreach ($s in $manager.GetSessions()) { if ($s.SourceAppUserModelId -match 'spotify') { return $s } }
  return $null
}
`;

// Prints one line of JSON a second about the Spotify app, plus the cover once per song.
// Stops by itself when moonlit (process __PARENT__) is gone.
const WATCH = PRELUDE + String.raw`
$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$streamType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType]
$lastCover = ''
while ($true) {
  if (-not (Get-Process -Id __PARENT__ -ErrorAction SilentlyContinue)) { exit 0 }
  try {
    $session = Find-Spotify
    if ($null -eq $session) {
      $out = @{ running = $false }
    } else {
      $props = Await ($session.TryGetMediaPropertiesAsync()) $propsType
      $playback = $session.GetPlaybackInfo()
      $timeline = $session.GetTimelineProperties()
      $out = @{
        running  = $true
        title    = [string]$props.Title
        artist   = [string]$props.Artist
        album    = [string]$props.AlbumTitle
        playing  = ([string]$playback.PlaybackStatus -eq 'Playing')
        duration = [double]$timeline.EndTime.TotalSeconds
        position = [double]$timeline.Position.TotalSeconds
        updated  = [double]$timeline.LastUpdatedTime.ToUnixTimeMilliseconds()
      }
      $key = [string]$props.Title + '|' + [string]$props.Artist
      if ($props.Thumbnail -and $key -ne $lastCover) {
        $lastCover = $key
        try {
          $stream = Await ($props.Thumbnail.OpenReadAsync()) $streamType
          $size = [uint32]$stream.Size
          $reader = [Windows.Storage.Streams.DataReader]::new($stream.GetInputStreamAt(0))
          $null = Await ($reader.LoadAsync($size)) ([uint32])
          $bytes = New-Object byte[] $size
          $reader.ReadBytes($bytes)
          $type = [string]$stream.ContentType
          $reader.Dispose()
          $stream.Dispose()
          [Console]::Out.WriteLine((@{ cover = [Convert]::ToBase64String($bytes); type = $type; key = $key } | ConvertTo-Json -Compress))
        } catch { }
      }
    }
    [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress))
  } catch {
    [Console]::Out.WriteLine((@{ error = [string]$_.Exception.Message } | ConvertTo-Json -Compress))
  }
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 1000
}
`;

// Presses one button on the Spotify app, then exits.
const PRESS = PRELUDE + String.raw`
$session = Find-Spotify
if ($null -eq $session) { [Console]::Out.WriteLine('not-running'); exit 0 }
$ok = switch ('__ACTION__') {
  'play'     { Await ($session.TryPlayAsync()) ([bool]) }
  'pause'    { Await ($session.TryPauseAsync()) ([bool]) }
  'next'     { Await ($session.TrySkipNextAsync()) ([bool]) }
  'previous' { Await ($session.TrySkipPreviousAsync()) ([bool]) }
}
[Console]::Out.WriteLine($(if ($ok) { 'ok' } else { 'refused' }))
`;

const encode = script => Buffer.from(script, 'utf16le').toString('base64');
const powershell = script => ({
  cmd: 'powershell.exe',
  args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode(script)],
});
// tests swap PowerShell for a stand-in: MOONLIT_WINMEDIA_CMD=<node script>
const command = (script, mode) => (process.env.MOONLIT_WINMEDIA_CMD
  ? { cmd: process.execPath, args: [process.env.MOONLIT_WINMEDIA_CMD, mode], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
  : powershell(script));

const available = () => process.platform === 'win32' || !!process.env.MOONLIT_WINMEDIA_CMD;
const idFor = (title, artist) => `sp:local:${crypto.createHash('sha1').update(`${title}|${artist}`).digest('hex').slice(0, 16)}`;

function createWinMedia({ onState, onStatus, onCover }) {
  let child = null, stopped = true, restartTimer = null, quickExits = 0, startedAt = 0;
  let status = { text: 'off', kind: 'off' };
  let last = null;
  const covers = new Map(); // song id → data: URL, for the mini player
  // Spotify doesn't always tell Windows the song's position, so moonlit keeps its own clock
  const clock = { id: null, base: 0, since: 0, playing: false };

  const setStatus = (text, kind) => {
    if (status.text === text && status.kind === kind) return;
    status = { text, kind };
    onStatus(status);
  };
  const publish = state => { last = state; onState(state); };

  function elapsed(id, playing) {
    const now = Date.now();
    if (clock.id !== id) Object.assign(clock, { id, base: 0, since: now, playing });
    if (clock.playing !== playing) {
      if (clock.playing) clock.base += (now - clock.since) / 1000;
      clock.since = now;
      clock.playing = playing;
    }
    return clock.base + (playing ? (now - clock.since) / 1000 : 0);
  }

  function handle(line) {
    let msg;
    try { msg = JSON.parse(line.replace(/^﻿/, '')); } catch { return; }
    if (msg.error) return setStatus(`couldn't read the Spotify app (${msg.error})`, 'warn');
    if (msg.cover) {
      const [title, artist] = String(msg.key || '').split('|');
      const id = idFor(title, artist);
      const bytes = Buffer.from(msg.cover, 'base64');
      const type = /^image\//.test(msg.type) ? msg.type : 'image/png';
      covers.set(id, `data:${type};base64,${msg.cover}`);
      while (covers.size > 4) covers.delete(covers.keys().next().value);
      onCover(id, type, bytes);
      return;
    }
    if (!msg.running) { setStatus('open the Spotify app on this PC and play something', 'wait'); return publish(null); }
    if (!msg.title) { setStatus('the Spotify app is open, nothing playing yet', 'wait'); return publish(null); }
    const id = idFor(msg.title, msg.artist);
    const playing = !!msg.playing;
    const own = elapsed(id, playing);
    let duration = msg.duration > 1 ? msg.duration : 0;
    let position = own;
    if (duration && msg.updated > 0) {
      position = msg.position + (playing ? Math.max(0, Date.now() - msg.updated) / 1000 : 0);
      if (position > duration + 2) position = own; // stale timeline: fall back to our clock
    }
    if (duration) position = Math.min(position, duration);
    setStatus(playing ? 'showing the Spotify app on this PC ✓' : 'the Spotify app is paused', 'on');
    publish({
      id, title: msg.title, artist: msg.artist || '', album: msg.album || '',
      duration, position, playing, cover: covers.get(id) || '', url: '', device: 'this PC', at: Date.now(), local: true,
    });
  }

  function start() {
    if (!available() || child) return;
    stopped = false;
    clearTimeout(restartTimer);
    const { cmd, args, env } = command(WATCH.replace(/__PARENT__/g, String(process.pid)), 'watch');
    startedAt = Date.now();
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    } catch (err) {
      return setStatus(`couldn't start the Spotify reader (${err.message})`, 'warn');
    }
    if (status.kind === 'off') setStatus('looking for the Spotify app…', 'wait');
    readline.createInterface({ input: child.stdout }).on('line', handle);
    let errText = '';
    child.stderr.on('data', d => { errText = (errText + d).slice(-400); });
    child.on('error', err => setStatus(`couldn't start the Spotify reader (${err.message})`, 'warn'));
    child.on('exit', () => {
      child = null;
      if (stopped) return;
      // it shouldn't stop on its own: try again, more slowly if it keeps failing right away
      quickExits = Date.now() - startedAt < 15000 ? quickExits + 1 : 0;
      if (quickExits >= 3) {
        const why = errText.replace(/\s+/g, ' ').trim().slice(0, 160);
        setStatus(`Windows' media controls aren't available here${why ? ` (${why})` : ''}`, 'warn');
      }
      publish(null);
      restartTimer = setTimeout(start, quickExits >= 3 ? 60_000 : 3000);
    });
  }

  function stop() {
    stopped = true;
    clearTimeout(restartTimer);
    if (child) { child.kill(); child = null; }
    publish(null);
    setStatus('off', 'off');
  }

  // play / pause / next / previous on the Spotify app (works with Spotify Free)
  function control(action) {
    if (!['play', 'pause', 'next', 'previous'].includes(action)) return Promise.resolve({ ok: false, message: 'unknown button' });
    const { cmd, args, env } = command(PRESS.replace(/__ACTION__/g, action), action);
    return new Promise(resolve => {
      let out = '';
      let p;
      try { p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env }); } catch (err) { return resolve({ ok: false, message: err.message }); }
      const timer = setTimeout(() => { p.kill(); resolve({ ok: false, message: 'the Spotify app didn\'t answer' }); }, 10000);
      p.stdout.on('data', d => { out += d; });
      p.on('error', err => { clearTimeout(timer); resolve({ ok: false, message: err.message }); });
      p.on('exit', () => {
        clearTimeout(timer);
        const answer = out.trim().split(/\s+/).pop();
        if (answer === 'ok') resolve({ ok: true });
        else if (answer === 'not-running') resolve({ ok: false, message: 'open the Spotify app first' });
        else resolve({ ok: false, message: "the Spotify app didn't take that button right now" });
      });
    });
  }

  return {
    available, start, stop, control,
    info: () => ({ available: available(), on: !stopped, status, state: last }),
  };
}

module.exports = { createWinMedia, WATCH, PRESS };
