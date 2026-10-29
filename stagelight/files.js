'use strict';

/* File transfer for the remote display, like AnyDesk's: browse the stream PC's drives and
   folders, download a file or a whole folder (as a .zip, made while it downloads), upload files
   or folders into a folder, and make new folders. Nothing is deleted, renamed or overwritten: an
   upload with a name that's taken gets " (2)" added. Who may use it is decided by server.js. */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');

const LIST_MAX = 3000;               // entries shown in one folder
const ZIP_MAX_FILES = 65_000;        // a plain .zip holds up to 65 535 entries
const ZIP_MAX_BYTES = 4 * 1024 ** 3 - 1; // and up to 4 GB
const UPLOAD_MAX = 20 * 1024 ** 3;   // one uploaded file

// a full path, as the panel sends it: absolute, normalised, no NUL
function full(p) {
  const s = String(p || '');
  if (!s || s.includes('\0') || !path.isAbsolute(s)) throw Object.assign(new Error('pick a folder first'), { code: 400 });
  return path.resolve(s);
}

// the starting points: the drives on Windows, the root and home elsewhere
async function roots() {
  if (process.platform === 'win32') {
    const found = [];
    for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZAB') {
      try { await fsp.access(`${l}:\\`); found.push({ name: `${l}:`, path: `${l}:\\`, dir: true }); } catch { /* no such drive */ }
    }
    return found;
  }
  return [{ name: '/', path: '/', dir: true }, { name: 'home', path: require('node:os').homedir(), dir: true }];
}

async function list(p) {
  if (!p) return { path: '', parent: null, entries: await roots() };
  const dir = full(p);
  const names = await fsp.readdir(dir, { withFileTypes: true });
  const entries = [];
  for (const d of names.slice(0, LIST_MAX)) {
    const fp = path.join(dir, d.name);
    let st = null;
    try { st = await fsp.stat(fp); } catch { /* gone, or not allowed */ }
    entries.push({ name: d.name, path: fp, dir: st ? st.isDirectory() : d.isDirectory(), size: st && st.isFile() ? st.size : null, mtime: st ? st.mtimeMs : null });
  }
  entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const up = path.dirname(dir);
  return { path: dir, parent: up === dir ? '' : up, entries, more: names.length > LIST_MAX ? names.length - LIST_MAX : 0 };
}

// "file name.ext" for a download header, also for names with accents or emoji
const disposition = name => `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

async function sendFile(res, p) {
  const fp = full(p);
  const st = await fsp.stat(fp);
  if (!st.isFile()) throw Object.assign(new Error("that's not a file"), { code: 400 });
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Content-Disposition': disposition(path.basename(fp)), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  await new Promise((resolve, reject) => { const s = fs.createReadStream(fp); s.on('error', reject); res.on('close', resolve); s.pipe(res); });
  return { name: path.basename(fp), size: st.size };
}

/* ───────────── a folder as a .zip (stored, not compressed: fast, and photos and videos
   don't get smaller anyway), written while it's sent ───────────── */
async function walk(root) {
  const out = []; let bytes = 0;
  const go = async (dir, rel) => {
    let names;
    try { names = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    if (!names.length && rel) out.push({ rel: rel + '/', dir: true });
    for (const d of names) {
      const fp = path.join(dir, d.name), r = rel ? `${rel}/${d.name}` : d.name;
      let st; try { st = await fsp.lstat(fp); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) await go(fp, r);
      else if (st.isFile()) { out.push({ rel: r, fp, size: st.size, mtime: st.mtime }); bytes += st.size; }
      if (out.length > ZIP_MAX_FILES || bytes > ZIP_MAX_BYTES) throw Object.assign(new Error('that folder is too big for one .zip (4 GB or 65 000 files at most): download the folders inside it one by one'), { code: 413 });
    }
  };
  await go(root, '');
  return { files: out, bytes };
}
const dosTime = d => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
const dosDate = d => (((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

async function sendZip(res, p) {
  const root = full(p);
  if (!(await fsp.stat(root)).isDirectory()) throw Object.assign(new Error("that's not a folder"), { code: 400 });
  const { files, bytes } = await walk(root);
  const name = (path.basename(root) || root.replace(/[:\\/]/g, '') || 'folder') + '.zip';
  res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': disposition(name), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  let offset = 0;
  const central = [];
  const write = buf => new Promise(resolve => { offset += buf.length; if (res.write(buf)) resolve(); else res.once('drain', resolve); });
  for (const f of files) {
    if (res.destroyed) return { name, size: bytes, files: files.length, stopped: true };
    const nameBuf = Buffer.from(f.rel, 'utf8');
    const when = f.mtime || new Date();
    const start = offset;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(f.dir ? 0x0800 : 0x0808, 6); head.writeUInt16LE(0, 8);
    head.writeUInt16LE(dosTime(when), 10); head.writeUInt16LE(dosDate(when), 12);
    head.writeUInt16LE(nameBuf.length, 26);
    await write(Buffer.concat([head, nameBuf]));
    let crc = 0, size = 0;
    if (!f.dir) {
      // the file as it is now (a file that shrank or grew while zipping is cut or padded to its listed size)
      try {
        for await (const chunk of fs.createReadStream(f.fp)) {
          const part = size + chunk.length > f.size ? chunk.subarray(0, f.size - size) : chunk;
          crc = zlib.crc32(part, crc); size += part.length; await write(part);
          if (size >= f.size) break;
        }
      } catch { /* unreadable now: stops where it got to */ }
      if (size < f.size) { const pad = Buffer.alloc(f.size - size); crc = zlib.crc32(pad, crc); size = f.size; await write(pad); }
      const desc = Buffer.alloc(16);
      desc.writeUInt32LE(0x08074b50, 0); desc.writeUInt32LE(crc >>> 0, 4); desc.writeUInt32LE(size, 8); desc.writeUInt32LE(size, 12);
      await write(desc);
    }
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(f.dir ? 0x0800 : 0x0808, 8); c.writeUInt16LE(0, 10);
    c.writeUInt16LE(dosTime(when), 12); c.writeUInt16LE(dosDate(when), 14);
    c.writeUInt32LE(crc >>> 0, 16); c.writeUInt32LE(size, 20); c.writeUInt32LE(size, 24); c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(f.dir ? 0x10 : 0, 38); c.writeUInt32LE(start, 42);
    central.push(Buffer.concat([c, nameBuf]));
  }
  const cd = Buffer.concat(central), cdStart = offset;
  await write(cd);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(cdStart, 16);
  await write(end);
  res.end();
  return { name, size: bytes, files: files.length };
}

/* ───────────── uploads ───────────── */
// one part of a name: no slashes, nothing Windows refuses, not "." or ".."
function part(s) {
  const n = String(s).replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
  if (!n || n === '.' || n === '..') throw Object.assign(new Error('that name is not allowed'), { code: 400 });
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) return '_' + n;
  return n.slice(0, 200);
}
// a free name: "photo.png", else "photo (2).png", "photo (3).png", …
function freeName(dir, name) {
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 10_000; i++) {
    const n = i === 1 ? name : `${base} (${i})${ext}`;
    if (!fs.existsSync(path.join(dir, n))) return n;
  }
  throw Object.assign(new Error('too many files with that name'), { code: 409 });
}

// rel: the file's place inside an uploaded folder ("My folder/sub/file.png"), or just its name
async function receive(req, dirPath, rel) {
  const dir = full(dirPath);
  if (!(await fsp.stat(dir)).isDirectory()) throw Object.assign(new Error("that's not a folder"), { code: 400 });
  const parts = String(rel || '').split(/[\\/]+/).filter(Boolean).map(part);
  if (!parts.length) throw Object.assign(new Error('the file has no name'), { code: 400 });
  const size = Number(req.headers['content-length']);
  if (!Number.isFinite(size) || size < 0) throw Object.assign(new Error('the upload has no size'), { code: 411 });
  if (size > UPLOAD_MAX) throw Object.assign(new Error('that file is too big (20 GB at most)'), { code: 413 });
  // the folders inside an uploaded folder are made as needed (an existing one is used)
  let target = dir;
  for (const p of parts.slice(0, -1)) { target = path.join(target, p); await fsp.mkdir(target, { recursive: true }); }
  const name = freeName(target, parts.at(-1));
  const final = path.join(target, name), tmp = path.join(target, `.${name}.stagelight-upload`);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp, { flags: 'wx' });
    let got = 0, failed = false;
    const fail = err => { if (failed) return; failed = true; req.unpipe(out); req.resume(); out.destroy(); fs.rm(tmp, { force: true }, () => {}); reject(err); };
    req.on('data', c => { got += c.length; if (got > size) fail(Object.assign(new Error('the upload was bigger than it said'), { code: 400 })); });
    req.on('aborted', () => fail(Object.assign(new Error('the upload stopped'), { code: 400 })));
    out.on('error', err => fail(Object.assign(new Error(err.code === 'ENOSPC' ? 'the stream PC is out of disk space' : err.code === 'EACCES' || err.code === 'EPERM' ? "Windows doesn't allow saving in that folder" : "couldn't save the file"), { code: 409 })));
    out.on('finish', () => { if (failed) return; if (got !== size) return fail(Object.assign(new Error('the upload stopped'), { code: 400 })); resolve(); });
    req.pipe(out);
  });
  await fsp.rename(tmp, final);
  return { path: final, name: path.relative(dir, final), size };
}

async function makeDir(dirPath, name) {
  const dir = full(dirPath);
  const n = freeName(dir, part(name));
  await fsp.mkdir(path.join(dir, n));
  return { path: path.join(dir, n), name: n };
}

module.exports = { list, sendFile, sendZip, receive, makeDir, full };
