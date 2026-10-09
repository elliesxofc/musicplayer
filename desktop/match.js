'use strict';

// Picks the YouTube search result that best matches a Spotify song: close in length,
// right title and artist, official "Topic" uploads preferred, and no live / cover /
// sped-up versions unless the Spotify song itself is one.
const ODD_VERSION = /\b(live|cover|karaoke|instrumental|remix|sped ?up|slowed|nightcore|8d|reverb|bass ?boost(ed)?|1 ?hour|loop)\b/i;

function pickMatch(entries, song) {
  const want = (song.durationMs || 0) / 1000;
  const title = String(song.title || '').toLowerCase();
  // "Song (feat. X)" / "Song - Remastered" → "song" for matching
  const base = title.replace(/\s*[\(\[][^\)\]]*[\)\]]/g, '').replace(/\s+-\s+.*$/, '').trim() || title;
  const artist = String(song.artist || '').toLowerCase().split(/,|&/)[0].trim();
  let best = null, bestScore = -Infinity;
  for (const e of entries || []) {
    if (!e || !e.id) continue;
    const t = String(e.title || '').toLowerCase();
    const channel = String(e.channel || e.uploader || '').toLowerCase();
    let score = 0;
    // music videos often run a little long (intros), so length only nudges the score
    if (want && e.duration) score -= Math.min(45, Math.abs(e.duration - want)) * 1.5;
    if (base && t.includes(base)) score += 20;
    if (artist && (channel.includes(artist) || t.includes(artist))) score += 15;
    if (/ - topic$/.test(channel)) score += 25; // YouTube Music's official audio uploads
    if (/official audio|\baudio\b/.test(t)) score += 5;
    if (ODD_VERSION.test(t) && !ODD_VERSION.test(title)) score -= 100;
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return best;
}

module.exports = { pickMatch };
