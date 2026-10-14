'use strict';

/* The song request channel list: turning what you paste (a channel link, an @handle, or a
   link to one of the channel's videos) into the channel's ID ("UC" + 22 letters), which is
   what a song's channel is checked against. IDs never change, unlike names and handles. */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const ID_RE = /^UC[\w-]{22}$/;

// What was pasted → { id } (already an ID), { page, kind } (a page to look the ID up on), or null (a plain name)
function parseChannel(input) {
  const s = String(input || '').split('#')[0].trim();
  if (!s) return null;
  if (ID_RE.test(s)) return { id: s };
  if (/^@[\w.\-·]{3,100}$/.test(s)) return { page: `https://www.youtube.com/${s}`, kind: 'channel', handle: s.slice(1) };
  let url;
  try { url = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  if (!/^(youtube\.com|youtu\.be)$/.test(host) || !/[./]/.test(s)) return null;
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (host === 'youtu.be' && /^[\w-]{11}$/.test(parts[0] || '')) return { page: `https://www.youtube.com/watch?v=${parts[0]}`, kind: 'video' };
  const v = url.searchParams.get('v');
  if (v && /^[\w-]{11}$/.test(v)) return { page: `https://www.youtube.com/watch?v=${v}`, kind: 'video' };
  if (['live', 'shorts', 'embed'].includes(parts[0]) && /^[\w-]{11}$/.test(parts[1] || '')) return { page: `https://www.youtube.com/watch?v=${parts[1]}`, kind: 'video' };
  if (parts[0] === 'channel' && ID_RE.test(parts[1] || '')) return { id: parts[1] };
  if (parts[0]?.startsWith('@')) return { page: `https://www.youtube.com/${parts[0]}`, kind: 'channel', handle: parts[0].slice(1) };
  if (['c', 'user'].includes(parts[0]) && parts[1]) return { page: `https://www.youtube.com/${parts[0]}/${parts[1]}`, kind: 'channel', handle: parts[1] };
  return null;
}

// a line of the list → what a song's channel is compared with (offline, no lookups):
// "UC… # name" → the ID, "youtube.com/@name" or "@name" → the handle, anything else → the name
function channelKey(line) {
  const p = parseChannel(line);
  if (p && p.id) return p.id.toLowerCase();
  if (p && p.handle) return p.handle.toLowerCase();
  return String(line || '').split('#')[0].trim().replace(/^@/, '').toLowerCase();
}

const unescape = s => String(s || '')
  .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\(["\\/])/g, '$1')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// a YouTube page → the channel's ID and name
function channelFromPage(html, kind) {
  if (kind === 'video') {
    const details = /"videoDetails":\{([\s\S]{0,4000}?)"thumbnail"/.exec(html);
    const block = details ? details[1] : html;
    const id = /"channelId":"(UC[\w-]{22})"/.exec(block) || /itemprop="channelId" content="(UC[\w-]{22})"/.exec(html);
    const name = /"author":"((?:[^"\\]|\\.)*)"/.exec(block) || /"ownerChannelName":"((?:[^"\\]|\\.)*)"/.exec(html);
    return id ? { id: id[1], name: name ? unescape(name[1]) : '' } : null;
  }
  const id = /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/.exec(html)
    || /<meta property="og:url" content="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/.exec(html)
    || /"externalId":"(UC[\w-]{22})"/.exec(html)
    || /"channelId":"(UC[\w-]{22})"/.exec(html);
  const name = /<meta property="og:title" content="([^"]*)"/.exec(html)
    || /"channelMetadataRenderer":\{"title":"((?:[^"\\]|\\.)*)"/.exec(html);
  return id ? { id: id[1], name: name ? unescape(name[1]) : '' } : null;
}

/* Look a pasted channel up: { ok, id, name } or { ok: false, error }.
   fallback(url, kind) is yt-dlp, for when YouTube's page can't be read. */
async function resolveChannel(input, { fetchImpl = fetch, fallback = null } = {}) {
  const p = parseChannel(input);
  if (!p) return { ok: false, error: "that isn't a YouTube channel link, @handle or video link" };
  const page = p.page || `https://www.youtube.com/channel/${p.id}`;
  const kind = p.kind || 'channel';
  let found = null, missing = false;
  try {
    const res = await fetchImpl(page, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'SOCS=CAI; CONSENT=YES+1' } });
    if (res.status === 404) missing = true;
    else found = channelFromPage(await res.text(), kind);
  } catch { /* offline, or YouTube said no: try yt-dlp */ }
  if (!found && !missing && fallback) {
    try { found = await fallback(page, kind); } catch { found = null; }
  }
  // an ID that was pasted stays good even when its name couldn't be looked up
  if (!found && p.id && !missing) return { ok: true, id: p.id, name: '' };
  if (!found || !ID_RE.test(found.id || '')) return { ok: false, error: missing ? "that channel wasn't found" : "couldn't look that channel up (are you online?)" };
  return { ok: true, id: found.id, name: String(found.name || '').replace(/[\r\n#]+/g, ' ').trim().slice(0, 100) };
}

module.exports = { parseChannel, channelKey, channelFromPage, resolveChannel };
