'use strict';

/* Stagelight's remote display, on the stream PC: the screen goes to the panel as a WebRTC video
   (the same way video calls work), straight between the two devices on the same network or
   through Tailscale. Mouse and keyboard come back over a data channel and are handed to the
   program, which decides whether they're allowed. */

let pc = null, stream = null, channel = null;
let session = 0; // which start this is (a stop meant for an earlier one leaves a newer one alone)

/* Through the web address instead (when a direct connection is blocked, like behind a VPN):
   pictures of the screen (JPEG), only when something changed (and every 2 s anyway), at up to
   10 a second, smaller and fewer when the PC is busy. Stagelight sends them on to the panel. */
let relay = null; // { source, canvas, timer, prev, lastSent, stop }
function stopRelay() {
  if (!relay) return;
  clearTimeout(relay.timer);
  relay.stop();
  relay = null;
}
/* Where the pictures come from: the screen capture itself, frame by frame (keeps working when
   Windows thinks the hidden window is covered, which pauses a video player); a hidden video
   player only where that isn't available. */
function frameSource() {
  const track = stream.getVideoTracks()[0];
  if (typeof MediaStreamTrackProcessor === 'function' && track) {
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    const src = { latest: null, done: false };
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done || src.done) { if (value) value.close(); break; }
          if (src.latest) src.latest.close(); // only the newest frame is kept
          src.latest = value;
        }
      } catch { /* the capture ended */ }
    })();
    return {
      image: () => src.latest,
      size: () => (src.latest ? [src.latest.displayWidth, src.latest.displayHeight] : [0, 0]),
      stop: () => { src.done = true; reader.cancel().catch(() => {}); if (src.latest) { src.latest.close(); src.latest = null; } },
    };
  }
  const video = document.createElement('video');
  video.muted = true; video.srcObject = stream; video.play().catch(() => {});
  return {
    image: () => (video.readyState >= 2 ? video : null),
    size: () => [video.videoWidth, video.videoHeight],
    stop: () => { video.srcObject = null; },
  };
}
function startRelay() {
  const source = frameSource();
  const canvas = new OffscreenCanvas(16, 16), ctx = canvas.getContext('2d', { alpha: false });
  const tiny = new OffscreenCanvas(160, 90), tctx = tiny.getContext('2d', { willReadFrequently: true });
  relay = { source, canvas, timer: null, prev: null, lastSent: 0, stop: source.stop };
  const me = relay;
  const tick = async () => {
    if (relay !== me) return;
    const t0 = performance.now();
    try {
      const img = source.image(), [vw, vh] = source.size();
      if (img && vw) {
        const sc = Math.max(1, (limit && limit.scale) || 1);
        const w = Math.round(vw / sc), h = Math.round(vh / sc);
        // how much has changed? a small copy of the screen says it cheaply: nothing (send one every
        // 2 s anyway), a little (a blinking dot, the mouse pointer: 3 a second at most), or a lot
        tctx.drawImage(img, 0, 0, 160, 90);
        const px = tctx.getImageData(0, 0, 160, 90).data;
        let changed = me.prev ? 0 : Infinity;
        if (me.prev) for (let i = 0; i < px.length; i += 4) if (Math.abs(px[i] - me.prev[i]) + Math.abs(px[i + 1] - me.prev[i + 1]) + Math.abs(px[i + 2] - me.prev[i + 2]) > 24) changed++;
        const since = Date.now() - me.lastSent;
        if ((changed > 30) || (changed > 0 && since >= 330) || since > 2000) {
          if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
          ctx.drawImage(img, 0, 0, w, h);
          const busy = limit && (limit.level === 'hot' || limit.level === 'low');
          const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: busy ? 0.45 : 0.62 });
          if (relay !== me) return;
          window.capture.frame(await blob.arrayBuffer());
          me.prev = px; me.lastSent = Date.now();
        }
      }
    } catch { /* a frame skipped */ }
    const fps = Math.max(1, Math.min(10, (limit && limit.fps) || 10));
    me.timer = setTimeout(tick, Math.max(30, 1000 / fps - (performance.now() - t0)));
  };
  tick();
}

function stop(why) {
  stopRelay();
  // tell the panel first, so it doesn't wait for the connection to time out
  if (channel && channel.readyState === 'open') { try { channel.send(JSON.stringify({ t: 'end', why: why || 'ended on the stream PC' })); } catch { /* closing anyway */ } }
  channel = null;
  if (pc) { pc.onconnectionstatechange = null; pc.close(); pc = null; }
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  if (why) window.capture.ended(why);
}

const iceDone = p => new Promise(resolve => {
  if (p.iceGatheringState === 'complete') return resolve();
  const t = setTimeout(resolve, 3000);
  p.addEventListener('icegatheringstatechange', () => { if (p.iceGatheringState === 'complete') { clearTimeout(t); resolve(); } });
});

// how much of the upload the picture may use (lowered while live, so the stream keeps its share)
let limit = null;
function applyLimit(next) {
  if (next) limit = next;
  if (!pc || !limit) return;
  for (const sender of pc.getSenders()) {
    const p = sender.getParameters();
    p.encodings = (p.encodings && p.encodings.length ? p.encodings : [{}]).map(e => ({ ...e, maxBitrate: limit.bitrate, maxFramerate: limit.fps, scaleResolutionDownBy: Math.max(1, limit.scale || 1) }));
    // while live, fewer frames before blurry text; otherwise smooth first
    p.degradationPreference = limit.saving ? 'maintain-resolution' : 'maintain-framerate';
    sender.setParameters(p).catch(() => {});
  }
  // fewer frames taken off the screen too, not just sent (taking them costs the processor)
  if (stream) for (const t of stream.getVideoTracks()) t.applyConstraints({ frameRate: { max: limit.fps } }).catch(() => {});
  if (limit.note && channel && channel.readyState === 'open') { try { channel.send(JSON.stringify({ t: 'note', text: limit.note })); } catch { /* fine */ } }
}
window.capture.onLimit(next => applyLimit(next));
// something to tell the panel (like: Windows blocks clicks into a program run as administrator)
window.capture.onNote(text => { if (channel && channel.readyState === 'open') try { channel.send(JSON.stringify({ t: 'note', text })); } catch { /* fine */ } });

window.capture.onStart(async job => {
  session++;
  stop();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: job.sourceId, maxWidth: job.width, maxHeight: job.height, maxFrameRate: job.fps } },
    });
    if (job.relay) {
      limit = job.limit || limit;
      for (const t of stream.getVideoTracks()) t.contentHint = 'detail';
      startRelay();
      window.capture.answer(job.id, { ok: true });
      return;
    }
    // STUN only when the web address is on (to find a direct way between the two networks)
    pc = new RTCPeerConnection({ iceServers: (job.ice || []).map(u => ({ urls: u })) });
    for (const track of stream.getTracks()) {
      track.contentHint = 'detail'; // text stays sharp (OBS's menus and numbers)
      pc.addTrack(track, stream);
    }
    pc.ondatachannel = e => {
      channel = e.channel;
      e.channel.onopen = () => { if (limit && limit.note) try { e.channel.send(JSON.stringify({ t: 'note', text: limit.note })); } catch { /* fine */ } };
      e.channel.onmessage = m => { try { window.capture.input(JSON.parse(m.data)); } catch { /* not JSON */ } };
    };
    // a few seconds in: which encoder makes the picture (the graphics card's, or the processor)
    const thisPc = pc;
    setTimeout(async () => {
      if (pc !== thisPc) return;
      try {
        let out = null;
        (await pc.getStats()).forEach(r => { if (r.type === 'outbound-rtp' && r.kind === 'video') out = r; });
        if (out && out.encoderImplementation) window.capture.encoder({ name: out.encoderImplementation, hardware: out.powerEfficientEncoder === true || /MediaFoundation|NVENC|QSV|AMF|VideoToolbox|Vaapi|Accelerator/i.test(out.encoderImplementation) });
      } catch { /* no stats */ }
    }, 5000);
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        // a short drop can come back; give it a few seconds
        const was = pc;
        setTimeout(() => { if (pc === was && pc.connectionState !== 'connected') stop('the connection was lost'); }, pc.connectionState === 'disconnected' ? 5000 : 0);
      }
    };
    await pc.setRemoteDescription({ type: 'offer', sdp: job.offer });
    // H.264 first: most PCs encode it on the graphics card, which leaves the processor to OBS
    // (otherwise the browser's own choice, usually VP8, done by the processor)
    try {
      const codecs = RTCRtpSender.getCapabilities('video').codecs;
      const h264 = codecs.filter(c => /h264/i.test(c.mimeType));
      if (h264.length) {
        for (const t of pc.getTransceivers()) if (t.sender.track) t.setCodecPreferences([...h264, ...codecs.filter(c => !/h264/i.test(c.mimeType))]);
      }
    } catch { /* keep the default */ }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await iceDone(pc);
    // a steady picture: up to the chosen bitrate, frames kept smooth before sharpness
    applyLimit(job.limit);
    window.capture.answer(job.id, { sdp: pc.localDescription.sdp });
  } catch (err) {
    stop();
    window.capture.answer(job.id, { error: `couldn't share the screen (${err.message || err})` });
  }
});
// ended on the stream PC (the bar's stop button, the tray, switched off): the channel needs a
// moment to deliver the goodbye before the connection closes
window.capture.onStop(why => {
  stopRelay();
  const was = session;
  if (channel && channel.readyState === 'open') { try { channel.send(JSON.stringify({ t: 'end', why })); } catch { /* fine */ } }
  channel = null;
  // only this session, not a new one started meanwhile (like switching the picture's quality)
  setTimeout(() => { if (session === was) stop(); }, 300);
});
