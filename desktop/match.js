'use strict';

// Picks the YouTube result that really is this Spotify song. The title has to match
// (an artist's other songs never win just for being on their official channel), then
// version, length, artist and official uploads decide between candidates. Live / cover /
// sped-up versions lose unless the Spotify song itself is one. When nothing matches well
// enough it returns null, so we say "couldn't find it" rather than grab a wrong song.
const ODD_VERSION = /\b(live|cover|karaoke|instrumental|remix|sped ?up|slowed|nightcore|8d|reverb|bass ?boost(ed)?|1 ?hour|loop|acoustic)\b/i;
const FILLER = new Set(['official', 'audio', 'video', 'music', 'lyric', 'lyrics', 'visualizer', 'visualiser', 'mv', 'hd', 'hq', '4k', 'ft', 'feat', 'featuring', 'with', 'topic']);
const MIN_SCORE = 10;

const tokens = s => String(s || '')
  .toLowerCase()
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim().split(/\s+/).filter(Boolean);

// Spotify's "Love for You (feat. ovg!) - Remastered" → "love for you"
const songWords = title => tokens(String(title || '').replace(/\s*[\(\[][^\)\]]*[\)\]]/g, ' ').replace(/\s+-\s+.*$/, ' '));

function scoreResult(e, song) {
  const want = (song.durationMs || 0) / 1000;
  const raw = String(e.title || '').toLowerCase();
  const channel = String(e.channel || e.uploader || '').toLowerCase();
  const artistNames = String(song.artist || '').toLowerCase().split(/,|&/).map(s => s.trim()).filter(Boolean);
  const artistWords = new Set(artistNames.flatMap(tokens));
  const title = songWords(song.title);
  const have = tokens(e.title);
  const haveSet = new Set(have);

  // how much of the song's name is in the result's title, as whole words
  const coverage = title.length ? title.filter(w => haveSet.has(w)).length / title.length : 0;
  // what's left of the result title once the artist's name and words like "official audio" are removed
  const core = have.filter(w => !artistWords.has(w) && !FILLER.has(w)).join(' ');

  let score = 0;
  if (coverage >= 0.999) score += 40;
  else if (coverage >= 0.6) score += 10;
  else score -= 80; // a different song
  if (core === title.join(' ')) score += 15; // nothing extra in the title: not a remix, not a medley…
  if (artistNames.length && (artistNames.some(a => channel.includes(a) || raw.includes(a)) ||
      (e.artists || []).some(a => artistNames.includes(String(a).toLowerCase())))) score += 15;
  if (coverage >= 0.999 && / - topic$/.test(channel)) score += 20; // YouTube Music's official audio
  if (coverage >= 0.999 && e.fromMusic) score += 15; // a YouTube Music "song" result
  if (/official audio/.test(raw)) score += 10;
  if (/\blyrics?\b/.test(raw)) score -= 5; // usually fan re-uploads
  // music videos often run long (intros, outros), so length nudges rather than decides
  if (want && e.duration) score -= Math.min(45, Math.abs(e.duration - want));
  const songOdd = (String(song.title || '').match(ODD_VERSION) || [])[0];
  const resultOdd = (raw.match(ODD_VERSION) || [])[0];
  if (resultOdd && !songOdd) score -= 100; // e.g. a live recording when the album has the studio song
  if (songOdd && resultOdd && songOdd.toLowerCase() === resultOdd.toLowerCase()) score += 20; // the version we want
  return score;
}

// `used`: videos already picked for other songs in the same album / playlist
function pickMatch(entries, song, used = new Set()) {
  let best = null, bestScore = -Infinity;
  for (const e of entries || []) {
    if (!e || !e.id || used.has(e.id)) continue;
    const score = scoreResult(e, song);
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return bestScore >= MIN_SCORE ? best : null;
}

module.exports = { pickMatch };
