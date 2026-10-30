'use strict';

/* Stagelight's remote display, on the stream PC: the screen goes to the panel as a WebRTC video
   (the same way video calls work), straight between the two devices on the same network or
   through Tailscale. Mouse and keyboard come back over a data channel and are handed to the
   program, which decides whether they're allowed. */

let pc = null, stream = null, channel = null;

function stop(why) {
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

window.capture.onStart(async job => {
  stop();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: job.sourceId, maxWidth: job.width, maxHeight: job.height, maxFrameRate: job.fps } },
    });
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
  const was = pc;
  if (channel && channel.readyState === 'open') { try { channel.send(JSON.stringify({ t: 'end', why })); } catch { /* fine */ } }
  channel = null;
  setTimeout(() => { if (pc === was) stop(); }, 300); // only this connection, not a new one started meanwhile
});
