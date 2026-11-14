//! moonlit downloader.
//! - YouTube / YouTube Music / SoundCloud and anything else yt-dlp supports: downloaded as audio.
//! - Spotify links: Spotify's own audio is copy-protected and is never touched. We only read
//!   the song names from the link, find each song on YouTube, and tag the file with the
//!   Spotify title / artist / album / cover.
//! Speed: several downloads run side by side, each fetching in parallel chunks.
//!
//! yt-dlp, ffmpeg and Deno (the JavaScript engine YouTube needs yt-dlp to have) are fetched
//! the first time something is downloaded, instead of making moonlit's installer bigger.

use crate::{channels, config, emit, files, matcher, spotify_link};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;

const PARALLEL: usize = 3;
const UPDATE_EVERY_MS: f64 = 3.0 * 24.0 * 60.0 * 60.0 * 1000.0;

#[cfg(windows)]
mod urls {
    pub const YTDLP: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
    pub const FFMPEG: &str = "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64.gz";
    pub const DENO: &str = "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip";
    pub const EXE: &str = ".exe";
}
#[cfg(not(windows))]
mod urls {
    pub const YTDLP: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";
    pub const FFMPEG: &str = "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-x64.gz";
    pub const DENO: &str = "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip";
    pub const EXE: &str = "";
}

// words that make a different version of a song: asked for, it has to be that version;
// not asked for, the normal song wins
pub const VERSION_WORDS: &str = "instrumental|karaoke|acapella|a cappella|acoustic|remix|live|cover|slowed|reverb|sped up|speed up|nightcore|8d|extended|piano|orchestral|lofi|lo-fi|bass boosted|radio edit|cut|demo";

// Bits that copyright-free channels add to video titles (the same patterns tidy songs already
// in the library, see app.js).
const TITLE_EXTRAS: [&str; 3] = [
    r"\s+\|\s.*$",
    r"(?i)\s*[\[(][^\])]*(ncs|no ?copyright|copyright[ -]?free|free download|royalty[ -]?free|release)[^\])]*[\])]",
    r"(?i)\s*[-–]\s*(no ?copyright|copyright[ -]?free|royalty[ -]?free)\b.*$",
];

fn plain(s: &str) -> String {
    matcher::tokens(s).join(" ")
}
fn versions_in(s: &str) -> HashSet<String> {
    let re = Regex::new(&format!(r"\b({})\b", VERSION_WORDS)).unwrap();
    re.find_iter(&plain(s)).map(|m| if m.as_str() == "speed up" { "sped up".to_string() } else { m.as_str().to_string() }).collect()
}
// how well a search result fits what was asked: the asked-for words in its title, the right version
pub fn request_score(e: &Value, query: &str) -> i64 {
    let ch = { let c = sv(e, "channel"); if c.is_empty() { sv(e, "uploader") } else { c } };
    let title = plain(&format!("{} {}", sv(e, "title"), ch));
    let words: Vec<String> = plain(query).split(' ').filter(|w| w.chars().count() > 1).map(String::from).collect();
    let mut score = words.iter().filter(|w| title.contains(w.as_str())).count() as i64 * 2;
    let (asked, got) = (versions_in(query), versions_in(&sv(e, "title")));
    for v in &asked { score += if got.contains(v) { 8 } else { -8 }; }
    for v in &got { if !asked.contains(v) { score -= 5; } }
    score
}

// several artists come as "A;B" (or "A / B"): written into the file as "A, B" (AC/DC stays)
pub fn tidy_artist(s: &str) -> String {
    let a = Regex::new(r"\s*;\s*|\s+/\s+|\x00").unwrap().replace_all(s, ", ").to_string();
    let b = Regex::new(r"(,\s*)+").unwrap().replace_all(&a, ", ").to_string();
    Regex::new(r"^,\s*|,\s*$").unwrap().replace_all(&b, "").trim().to_string()
}

fn clean_name(s: &str) -> String {
    let a = Regex::new(r#"[<>:"/\\|?*\x00-\x1f]"#).unwrap().replace_all(s, "").to_string();
    Regex::new(r"\s+").unwrap().replace_all(&a, " ").trim().chars().take(120).collect()
}
fn spotify_file_name(j: &Job, ext: &str) -> String {
    let a = clean_name(&j.artist);
    let t = clean_name(&j.title);
    format!("{} - {}{}", if a.is_empty() { "unknown" } else { &a }, if t.is_empty() { "untitled" } else { &t }, ext)
}

fn sv(e: &Value, k: &str) -> String { e.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string() }

/* ───────────── a playlist saved as a .csv file (exportify.net, TuneMyMusic) ───────────── */
fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let text = text.trim_start_matches('\u{feff}');
    // some spreadsheet apps save with semicolons instead of commas
    let first = text.lines().next().unwrap_or("");
    let sep = if !first.contains(',') && first.contains(';') { ';' } else { ',' };
    let mut rows = Vec::new();
    let (mut row, mut field, mut quoted) = (Vec::new(), String::new(), false);
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if quoted {
            if c == '"' && chars.get(i + 1) == Some(&'"') { field.push('"'); i += 1; } else if c == '"' { quoted = false; } else { field.push(c); }
        } else if c == '"' { quoted = true; }
        else if c == sep { row.push(std::mem::take(&mut field)); }
        else if c == '\n' || c == '\r' {
            if c == '\r' && chars.get(i + 1) == Some(&'\n') { i += 1; }
            row.push(std::mem::take(&mut field));
            if row.iter().any(|f: &String| !f.trim().is_empty()) { rows.push(std::mem::take(&mut row)); } else { row.clear(); }
        } else { field.push(c); }
        i += 1;
    }
    row.push(field);
    if row.iter().any(|f| !f.trim().is_empty()) { rows.push(row); }
    rows
}

fn read_playlist_csv(text: &str) -> Vec<Job> {
    let rows = parse_csv(text);
    if rows.len() < 2 { return vec![]; }
    let head: Vec<String> = rows[0].iter().map(|h| h.trim().to_lowercase()).collect();
    let col = |names: &[&str]| head.iter().position(|h| names.contains(&h.as_str()));
    let Some(title) = col(&["track name", "title", "name", "track", "song", "song name"]) else { return vec![] };
    let artist = col(&["artist name(s)", "artist name", "artist", "artists", "artist(s)"]);
    let album = col(&["album name", "album", "album title"]);
    let ms = col(&["duration (ms)", "track duration (ms)", "duration_ms"]);
    let cover = col(&["album image url", "image url", "album art", "cover"]);
    let ws = Regex::new(r"\s+").unwrap();
    let get = |r: &Vec<String>, i: Option<usize>| i.and_then(|i| r.get(i)).cloned().unwrap_or_default();
    rows[1..].iter().map(|r| Job {
        source: "spotify".into(),
        title: ws.replace_all(&get(r, Some(title)), " ").trim().to_string(),
        // Exportify separates several artists with commas
        artist: get(r, artist).split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(", "),
        album: ws.replace_all(&get(r, album), " ").trim().to_string(),
        cover: { let c = get(r, cover); if c.starts_with("https://") { c.trim().to_string() } else { String::new() } },
        duration_ms: get(r, ms).trim().parse().unwrap_or(0.0),
        ..Job::default()
    }).filter(|j| !j.title.is_empty()).collect()
}

/* ───────────── jobs ───────────── */
#[derive(Clone, Default)]
struct Job {
    id: u64,
    title: String,
    artist: String,
    album: String,
    cover: String,
    source: String,
    status: String,
    progress: f64,
    speed: String,
    eta: String,
    error: String,
    file: String,
    format: String,
    note: String,
    matched: String,
    url: String,
    group: u64,
    duration_ms: f64,
    skip_existing: bool,
    attempts: u32,
    dir: Option<PathBuf>,
    tag_artist: String,
}

impl Job {
    fn public(&self) -> Value {
        json!({ "id": self.id, "title": self.title, "artist": self.artist, "source": self.source, "status": self.status,
                "progress": self.progress, "speed": self.speed, "eta": self.eta, "error": self.error, "file": self.file,
                "format": self.format, "note": self.note, "matched": self.matched })
    }
}

#[derive(Default)]
struct Dl {
    jobs: BTreeMap<u64, Job>,
    running: HashMap<u64, Option<oneshot::Sender<()>>>, // job id → a way to stop its download
    used: HashMap<u64, HashSet<String>>,                // album/playlist → YouTube videos already picked
    waiters: HashMap<u64, oneshot::Sender<Job>>,        // song requests waiting on their download
}

static DL: Mutex<Option<Dl>> = Mutex::new(None);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_GROUP: AtomicU64 = AtomicU64::new(1);
static READY: tokio::sync::Mutex<bool> = tokio::sync::Mutex::const_new(false);

fn with<R>(f: impl FnOnce(&mut Dl) -> R) -> R {
    let mut g = DL.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(Dl::default))
}

fn update(id: u64) {
    if let Some(p) = with(|d| d.jobs.get(&id).map(|j| j.public())) { emit("dl:update", p); }
}
fn status(text: &str) { emit("dl:status", json!(text)); }

fn new_job(mut j: Job) -> u64 {
    j.id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    if j.status.is_empty() { j.status = "queued".into(); }
    let id = j.id;
    with(|d| d.jobs.insert(id, j));
    update(id);
    id
}
fn edit(id: u64, f: impl FnOnce(&mut Job)) -> Option<Job> {
    with(|d| d.jobs.get_mut(&id).map(|j| { f(j); j.clone() }))
}
fn remove(id: u64) {
    with(|d| d.jobs.remove(&id));
    emit("dl:remove", json!(id));
}

fn out_dir() -> PathBuf {
    let d = config::get_str("downloadDir");
    if !d.is_empty() { return PathBuf::from(d); }
    let app = crate::app();
    tauri::Manager::path(&app).audio_dir().unwrap_or_else(|_| config::data_dir()).join("moonlit")
}
// songs downloaded for viewers' requests live apart, in their own folder: they're temporary
// (deleted after they play) and never mix with the songs you download yourself
fn request_dir() -> PathBuf { out_dir().join("requests") }

/* ───────────── yt-dlp, ffmpeg and Deno: fetched on first use, kept fresh ───────────── */
fn bin_dir() -> PathBuf { config::data_dir().join("bin") }
fn ytdlp() -> PathBuf { bin_dir().join(format!("yt-dlp{}", urls::EXE)) }
fn ffmpeg() -> PathBuf { bin_dir().join(format!("ffmpeg{}", urls::EXE)) }
fn deno() -> PathBuf { bin_dir().join(format!("deno{}", urls::EXE)) }

fn hidden(cmd: &mut Command) {
    #[cfg(windows)]
    { cmd.creation_flags(0x0800_0000); } // CREATE_NO_WINDOW
    let _ = cmd;
}

async fn fetch_bytes(url: &str) -> Result<Vec<u8>, String> {
    let c = reqwest::Client::builder().timeout(std::time::Duration::from_secs(600)).build().map_err(|e| e.to_string())?;
    let r = c.get(url).send().await.map_err(|_| "no internet connection?".to_string())?;
    if !r.status().is_success() { return Err(format!("couldn't download a part of the downloader ({})", r.status().as_u16())); }
    r.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
}

fn put_exe(target: &Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::create_dir_all(bin_dir()).map_err(|e| e.to_string())?;
    let tmp = target.with_extension("download");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)); }
    std::fs::rename(&tmp, target).map_err(|e| e.to_string())
}

async fn ensure_ready() -> Result<(), String> {
    let mut ready = READY.lock().await;
    if *ready { return Ok(()); }
    let r = async {
        if !ytdlp().exists() {
            status("getting the downloader ready (one time, ~20 MB)…");
            put_exe(&ytdlp(), &fetch_bytes(urls::YTDLP).await?)?;
            config::set("ytdlpCheckedAt", json!(config::now_ms()));
        } else if config::now_ms() - config::get("ytdlpCheckedAt").as_f64().unwrap_or(0.0) > UPDATE_EVERY_MS {
            status("checking the downloader for updates…");
            let mut c = Command::new(ytdlp());
            c.arg("-U").stdout(Stdio::null()).stderr(Stdio::null());
            hidden(&mut c);
            if let Ok(mut child) = c.spawn() {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(60), child.wait()).await;
                let _ = child.kill().await;
            }
            config::set("ytdlpCheckedAt", json!(config::now_ms()));
        }
        if !ffmpeg().exists() {
            status("getting the sound converter ready (one time, ~30 MB)…");
            let gz = fetch_bytes(urls::FFMPEG).await?;
            let mut out = Vec::new();
            std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(&gz[..]), &mut out).map_err(|e| e.to_string())?;
            put_exe(&ffmpeg(), &out)?;
        }
        if !deno().exists() {
            status("getting YouTube's player helper ready (one time, ~45 MB)…");
            let z = fetch_bytes(urls::DENO).await?;
            let mut archive = zip::ZipArchive::new(std::io::Cursor::new(z)).map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            {
                let mut f = archive.by_name(&format!("deno{}", urls::EXE)).map_err(|e| e.to_string())?;
                std::io::Read::read_to_end(&mut f, &mut out).map_err(|e| e.to_string())?;
            }
            put_exe(&deno(), &out)?;
        }
        Ok::<(), String>(())
    }.await;
    status("");
    if r.is_ok() { *ready = true; }
    r
}


/* ───────────── running yt-dlp ───────────── */
fn base_args() -> Vec<String> {
    let mut a: Vec<String> = ["--no-warnings", "--no-colors", "--encoding", "utf-8", "--windows-filenames"].iter().map(|s| s.to_string()).collect();
    a.push("--ffmpeg-location".into());
    a.push(ffmpeg().to_string_lossy().to_string());
    // YouTube needs a JavaScript engine
    a.push("--js-runtimes".into());
    a.push(format!("deno:{}", deno().to_string_lossy()));
    a
}
fn command(args: &[String]) -> Command {
    let mut c = Command::new(ytdlp());
    c.args(base_args()).args(args).env("PYTHONIOENCODING", "utf-8").env("PYTHONUTF8", "1").stdin(Stdio::null());
    hidden(&mut c);
    c
}

async fn run_json(args: &[String]) -> Result<Value, String> {
    let out = command(args).kill_on_drop(true).output().await.map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(friendly_error(&String::from_utf8_lossy(&out.stderr)));
    }
    serde_json::from_slice(&out.stdout).map_err(|_| "couldn't read that link".into())
}

fn friendly_error(text: &str) -> String {
    let line = Regex::new(r"(?m)ERROR:.*$").unwrap().find(text).map(|m| m.as_str().to_string())
        .unwrap_or_else(|| { let t = text.trim(); let l = t.lines().last().unwrap_or(""); if l.is_empty() { "something went wrong".into() } else { l.to_string() } });
    let line = Regex::new(r"^ERROR:\s*(\[[^\]]+\]\s*)?([\w-]+:\s*)?").unwrap().replace(&line, "").to_string();
    let has = |re: &str| Regex::new(re).unwrap().is_match(&line);
    if has(r"(?i)sign in to confirm|not a bot") { return "YouTube wants a sign-in check right now. Try again in a little while".into(); }
    if has(r"(?i)private video") { return "this video is private".into(); }
    if has(r"(?i)video unavailable|not available") { return "this video isn't available".into(); }
    if has(r"(?i)unsupported url") { return "that link isn't supported".into(); }
    if has(r"(?i)getaddrinfo|network|timed out|connection") { return "no internet connection?".into(); }
    line.chars().take(160).collect()
}

/* ───────────── adding links ───────────── */
fn is_spotify(url: &str) -> bool { Regex::new(r"(?i)(^spotify:|open\.spotify\.com/|play\.spotify\.com/)").unwrap().is_match(url) }

async fn add(url: String, format: String) -> Value {
    let url = url.trim().to_string();
    if !Regex::new(r"(?i)^(https?://|spotify:)").unwrap().is_match(&url) { return json!({ "ok": false, "error": "paste a link that starts with https://" }); }
    let format = if format == "mp3" { "mp3" } else { "m4a" }.to_string();
    let placeholder = new_job(Job { title: "reading the link…".into(), source: if is_spotify(&url) { "spotify" } else { "youtube" }.into(), status: "reading".into(), format: format.clone(), ..Job::default() });
    let items = async {
        ensure_ready().await?;
        if is_spotify(&url) { read_spotify(&url).await } else { read_link(&url).await }
    }.await;
    match items {
        Ok((items, skipped)) => {
            remove(placeholder);
            if items.is_empty() {
                return json!({ "ok": false, "error": if skipped > 0 { "every video in that playlist is deleted or private" } else { "no songs found in that link" } });
            }
            let group = NEXT_GROUP.fetch_add(1, Ordering::SeqCst);
            let count = items.len();
            for it in items { new_job(Job { format: format.clone(), group, ..it }); }
            pump();
            json!({ "ok": true, "count": count, "skipped": skipped })
        }
        Err(e) => {
            edit(placeholder, |j| { j.status = "error".into(); j.title = url.clone(); j.error = e.clone(); });
            update(placeholder);
            json!({ "ok": false, "error": e })
        }
    }
}

// every song in a playlist file (.csv), with no 100-song limit
async fn add_list(text: String, format: String) -> Value {
    let format = if format == "mp3" { "mp3" } else { "m4a" }.to_string();
    let items = read_playlist_csv(&text);
    if items.is_empty() { return json!({ "ok": false, "error": "that file doesn't look like a playlist (no song names in it)" }); }
    if let Err(e) = ensure_ready().await { return json!({ "ok": false, "error": e }); }
    let group = NEXT_GROUP.fetch_add(1, Ordering::SeqCst);
    let count = items.len();
    for it in items { new_job(Job { format: format.clone(), group, skip_existing: true, ..it }); }
    pump();
    json!({ "ok": true, "count": count })
}

async fn read_link(url: &str) -> Result<(Vec<Job>, usize), String> {
    let info = run_json(&["--flat-playlist".into(), "-J".into(), "--no-playlist".into(), url.into()]).await?;
    let all: Vec<Value> = if sv(&info, "_type") == "playlist" {
        info.get("entries").and_then(|e| e.as_array()).cloned().unwrap_or_default().into_iter().filter(|e| !e.is_null()).collect()
    } else { vec![info.clone()] };
    // playlists keep placeholders for removed videos; those can't be downloaded
    let gone = Regex::new(r"(?i)^\[(deleted|private) video\]$").unwrap();
    let entries: Vec<&Value> = all.iter().filter(|e| !gone.is_match(&sv(e, "title")) && sv(e, "availability") != "private").collect();
    let yt = Regex::new(r"(?i)youtube").unwrap();
    let items = entries.iter().map(|e| {
        let ie = { let k = sv(e, "ie_key"); if k.is_empty() { sv(&info, "extractor") } else { k } };
        let link = [sv(e, "webpage_url"), sv(e, "url")].into_iter().find(|s| !s.is_empty())
            .unwrap_or_else(|| if !sv(e, "id").is_empty() && yt.is_match(&ie) { format!("https://www.youtube.com/watch?v={}", sv(e, "id")) } else { url.to_string() });
        let artist = [sv(e, "artist"), sv(e, "channel"), sv(e, "uploader")].into_iter().find(|s| !s.is_empty()).unwrap_or_default();
        Job { source: "youtube".into(), url: link, title: { let t = sv(e, "title"); if t.is_empty() { "untitled".into() } else { t } }, artist, ..Job::default() }
    }).collect();
    Ok((items, all.len() - entries.len()))
}

async fn read_spotify(url: &str) -> Result<(Vec<Job>, usize), String> {
    let d = spotify_link::details(url).await?;
    let album = if d.kind == "album" { d.title.clone() } else { String::new() };
    // album and single-song links share one cover; playlists use each song's YouTube cover
    let cover = if d.kind == "album" || d.kind == "track" { d.image.clone() } else { String::new() };
    Ok((d.tracks.into_iter().filter(|t| !t.name.is_empty()).map(|t| Job {
        source: "spotify".into(), title: t.name, artist: t.artist, album: album.clone(), cover: cover.clone(), duration_ms: t.duration_ms, ..Job::default()
    }).collect(), 0))
}

/* ───────────── matching a Spotify song on YouTube ───────────── */
async fn find_on_youtube(job: &Job) -> Result<(String, String), String> {
    let q = format!("{} {}", job.artist.split(',').next().unwrap_or(""), job.title).replace('"', "").trim().to_string();
    // search YouTube Music's song results (cleanest for this) and normal YouTube, side by side
    let music_url = format!("https://music.youtube.com/search?q={}#songs", urlencoding::encode(&q));
    let music_args: Vec<String> = vec!["--flat-playlist".into(), "-J".into(), "--playlist-end".into(), "8".into(), music_url];
    let yt_args: Vec<String> = vec!["--flat-playlist".into(), "-J".into(), format!("ytsearch8:{}", q)];
    let (music, yt) = tokio::join!(run_json(&music_args), run_json(&yt_args));
    let mut entries: Vec<Value> = music.ok().and_then(|m| m.get("entries").and_then(|e| e.as_array()).cloned()).unwrap_or_default()
        .into_iter().map(|mut e| { if e.is_object() { e["fromMusic"] = json!(true); } e }).collect();
    entries.extend(yt.ok().and_then(|y| y.get("entries").and_then(|e| e.as_array()).cloned()).unwrap_or_default());
    entries.retain(|e| e.is_object());
    if entries.is_empty() { return Err("couldn't search YouTube right now".into()); }
    let used = with(|d| d.used.get(&job.group).cloned().unwrap_or_default());
    let song = matcher::Song { title: &job.title, artist: &job.artist, duration_ms: job.duration_ms };
    let pick = matcher::pick(&entries, &song, &used).ok_or("couldn't find this exact song on YouTube")?;
    let id = sv(pick, "id");
    with(|d| d.used.entry(job.group).or_default().insert(id.clone())); // no other song in this album / playlist gets the same video
    Ok((format!("https://www.youtube.com/watch?v={}", id), sv(pick, "title")))
}

/* ───────────── downloading ───────────── */
fn pump() {
    let starts: Vec<u64> = with(|d| {
        let mut out = vec![];
        for (id, j) in d.jobs.iter() {
            if d.running.len() + out.len() >= PARALLEL { break; }
            if j.status == "queued" { out.push(*id); }
        }
        for id in &out { d.running.insert(*id, None); }
        out
    });
    for id in starts {
        tauri::async_runtime::spawn(async move { start(id).await });
    }
}

fn retryable(m: &str) -> bool { Regex::new(r"(?i)403|forbidden|timed out|connection (reset|aborted)|temporar|incomplete|429").unwrap().is_match(m) }

async fn start(id: u64) {
    let result = run_job(id).await;
    let Some(job) = with(|d| d.jobs.get(&id).cloned()) else { with(|d| d.running.remove(&id)); pump(); return };
    match result {
        Ok(()) => {}
        Err(_) if job.status == "cancelled" => {}
        Err(m) if retryable(&m) && job.attempts < 2 => {
            // YouTube sometimes refuses a download (403), mostly when it's busy: wait, then try again more gently
            let n = job.attempts + 1;
            edit(id, |j| { j.attempts = n; j.status = "waiting".into(); j.note = format!("YouTube said no, trying again ({}/2)…", n); j.progress = 0.0; j.speed.clear(); j.eta.clear(); });
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(3000 * n as u64)).await;
                if edit(id, |j| if j.status == "waiting" { j.status = "queued".into() }).map(|j| j.status == "queued").unwrap_or(false) { update(id); pump(); }
            });
        }
        Err(m) => { edit(id, |j| { j.status = "error".into(); j.error = m; }); }
    }
    with(|d| d.running.remove(&id));
    update(id);
    settle(id);
    pump();
}

async fn run_job(id: u64) -> Result<(), String> {
    let job = with(|d| d.jobs.get(&id).cloned()).ok_or("gone")?;
    // a playlist file imported again: songs already in the download folder aren't fetched twice
    if job.skip_existing {
        let have = out_dir().join(spotify_file_name(&job, &format!(".{}", job.format)));
        if have.exists() {
            files::allow(&have);
            edit(id, |j| { j.file = have.to_string_lossy().to_string(); j.note = "already downloaded".into(); j.status = "done".into(); j.progress = 100.0; });
            return Ok(());
        }
    }
    if job.source == "spotify" && job.url.is_empty() {
        edit(id, |j| j.status = "finding".into());
        update(id);
        let (url, matched) = find_on_youtube(&job).await?;
        edit(id, |j| { j.url = url; j.matched = matched; });
    }
    if with(|d| d.jobs.get(&id).map(|j| j.status == "cancelled").unwrap_or(true)) { return Err("cancelled".into()); }
    edit(id, |j| { j.status = "downloading".into(); j.note.clear(); });
    update(id);
    let file = download(id).await?;
    let job = with(|d| d.jobs.get(&id).cloned()).ok_or("gone")?;
    let file = if job.source == "spotify" { retag(&file, &job).await } else { tidy_artist_tag(&file, &job.tag_artist).await };
    files::allow(&file);
    edit(id, |j| { j.file = file.to_string_lossy().to_string(); j.status = "done".into(); j.progress = 100.0; j.speed.clear(); j.eta.clear(); });
    Ok(())
}

async fn download(id: u64) -> Result<PathBuf, String> {
    let job = with(|d| d.jobs.get(&id).cloned()).ok_or("gone")?;
    let dir = job.dir.clone().unwrap_or_else(out_dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut args: Vec<String> = vec!["--no-playlist".into(), "-f".into(),
        if job.format == "m4a" { "bestaudio[ext=m4a]/bestaudio/best" } else { "bestaudio/best" }.into(),
        "-x".into(), "--audio-format".into(), job.format.clone(), "--audio-quality".into(), "0".into(),
        "--embed-metadata".into(), "--embed-thumbnail".into(), "--convert-thumbnails".into(), "jpg".into()];
    // speed: fetch several pieces at once, in larger chunks (retries go one piece at a time)
    if job.attempts > 0 { args.extend(["--retries", "10", "--fragment-retries", "10"].map(String::from)); }
    else { args.extend(["-N", "4", "--http-chunk-size", "10M", "--retries", "5"].map(String::from)); }
    args.extend(["--no-mtime", "--newline", "--progress", "--progress-template",
        "download:MOONLIT_PROGRESS %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
        "--print", "after_move:MOONLIT_FILE %(filepath)s", "--print", "after_move:MOONLIT_ARTIST %(artist|)s", "-o"].map(String::from));
    // Spotify songs get renamed after tagging, so their temporary name carries the video id:
    // two songs downloading at once can then never write to the same file
    args.push(dir.join(if job.source == "spotify" { "%(title).120B [%(id)s].%(ext)s" } else { "%(artist,uploader,channel)s - %(title).150B.%(ext)s" }).to_string_lossy().to_string());
    if job.source != "spotify" {
        // "Artist - Song (Official Video)" → artist "Artist", title "Song". Split at the FIRST " - "
        args.extend(["--parse-metadata", "title:(?P<artist>.+?) - (?P<title>.+)"].map(String::from));
        // channel extras after the song name: "| Future Bass | NCS - Copyright Free Music", "[NCS Release]"
        for p in TITLE_EXTRAS { args.extend(["--replace-in-metadata".to_string(), "title".into(), p.into(), "".into()]); }
        args.extend(["--replace-in-metadata".to_string(), "artist".into(), TITLE_EXTRAS[1].into(), "".into()]);
        // "\"Scarlet Fire\"" → Scarlet Fire
        args.extend(["--replace-in-metadata", "title,artist", "^\\s*[\"“”](.+)[\"“”]\\s*$", "\\g<1>"].map(String::from));
        // (brackets naming a version, like "(Official Instrumental)", are kept: that's a different song)
        args.extend(["--replace-in-metadata".to_string(), "title".into(),
            format!(r"(?i)\s*[\(\[](?![^\)\]]*(?:{}))[^\)\]]*(official|lyrics?|audio|video|visuali[sz]er|hd|hq|4k|m/?v)[^\)\]]*[\)\]]", VERSION_WORDS), "".into()]);
    }
    args.push(job.url.clone());

    let mut child = command(&args).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let (kill_tx, kill_rx) = oneshot::channel::<()>();
    with(|d| d.running.insert(id, Some(kill_tx)));
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let err_task = tokio::spawn(async move { let mut s = String::new(); let _ = stderr.read_to_string(&mut s).await; s });
    let prog = Regex::new(r"^MOONLIT_PROGRESS\s+([\d.]+)%\|([^|]*)\|(.*)$").unwrap();
    let unknown = Regex::new(r"(?i)^Unknown.*$").unwrap();
    let converting = Regex::new(r"^\[(ExtractAudio|EmbedThumbnail|Metadata)\]").unwrap();
    let reader = async {
        let mut lines = BufReader::new(stdout).lines();
        let mut file = String::new();
        let mut last_sent = std::time::Instant::now() - std::time::Duration::from_secs(1);
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(c) = prog.captures(&line) {
                let (p, sp, et) = (c[1].parse::<f64>().unwrap_or(0.0).min(99.0), unknown.replace(c[2].trim(), "").to_string(), unknown.replace(c[3].trim(), "").to_string());
                edit(id, |j| { j.progress = p; j.speed = sp; j.eta = et; });
                if last_sent.elapsed().as_millis() > 250 { last_sent = std::time::Instant::now(); update(id); }
            } else if let Some(f) = line.strip_prefix("MOONLIT_FILE ") {
                file = f.trim().to_string();
            } else if let Some(a) = line.strip_prefix("MOONLIT_ARTIST ") {
                let a = a.trim().to_string();
                edit(id, |j| j.tag_artist = a);
            } else if converting.is_match(&line) {
                let changed = edit(id, |j| if j.status != "converting" { j.status = "converting".into(); j.speed.clear(); j.eta.clear(); }).is_some();
                if changed { update(id); }
            }
        }
        file
    };
    let (file, status) = tokio::select! {
        r = async { let f = reader.await; (f, child.wait().await.ok()) } => r,
        _ = kill_rx => { let _ = child.kill().await; (String::new(), None) }
    };
    let err = err_task.await.unwrap_or_default();
    if with(|d| d.jobs.get(&id).map(|j| j.status == "cancelled").unwrap_or(true)) { return Err("cancelled".into()); }
    let ok = status.map(|s| s.success()).unwrap_or(false);
    if ok && !file.is_empty() && Path::new(&file).exists() { Ok(PathBuf::from(file)) }
    else { Err(friendly_error(if err.trim().is_empty() { "the download stopped" } else { &err })) }
}

async fn ffmpeg_run(args: Vec<String>) -> bool {
    let mut c = Command::new(ffmpeg());
    c.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    hidden(&mut c);
    c.status().await.map(|s| s.success()).unwrap_or(false)
}

// "A;B" in a downloaded file's artist tag → "A, B" (only the tag is rewritten, the sound is copied as is)
async fn tidy_artist_tag(file: &Path, artist: &str) -> PathBuf {
    let fixed = tidy_artist(artist);
    if !ffmpeg().exists() || artist.is_empty() || fixed == artist { return file.to_path_buf(); }
    let ext = file.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let tmp = PathBuf::from(format!("{}.moonlit{}", file.to_string_lossy(), ext));
    let mut args: Vec<String> = vec!["-y".into(), "-loglevel".into(), "error".into(), "-i".into(), file.to_string_lossy().into(), "-map".into(), "0".into(), "-c".into(), "copy".into(), "-metadata".into(), format!("artist={}", fixed)];
    if ext == ".mp3" { args.extend(["-id3v2_version".into(), "3".into()]); }
    args.push(tmp.to_string_lossy().into());
    if !ffmpeg_run(args).await { let _ = std::fs::remove_file(&tmp); return file.to_path_buf(); } // the old tag is still fine to play
    // the file name too: "A;B - Song.m4a" → "A, B - Song.m4a"
    let base = file.file_name().map(|b| b.to_string_lossy().to_string()).unwrap_or_default();
    let prefix = format!("{} - ", artist);
    let named = match base.strip_prefix(&prefix) { Some(rest) => file.with_file_name(format!("{} - {}", clean_name(&fixed), rest)), None => file.to_path_buf() };
    let _ = std::fs::remove_file(file);
    if named != file { let _ = std::fs::remove_file(&named); }
    if std::fs::rename(&tmp, &named).is_err() { return tmp; }
    named
}

// Give Spotify songs their Spotify name, artist, album (and cover) and a tidy filename.
async fn retag(file: &Path, job: &Job) -> PathBuf {
    if !ffmpeg().exists() { return file.to_path_buf(); }
    let ext = file.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let target = file.with_file_name(spotify_file_name(job, &ext));
    let tmp = PathBuf::from(format!("{}.moonlit{}", file.to_string_lossy(), ext));
    let mut cover_file = None;
    if !job.cover.is_empty() {
        if let Ok(b) = fetch_bytes(&job.cover).await {
            let c = PathBuf::from(format!("{}.cover.jpg", file.to_string_lossy()));
            if std::fs::write(&c, b).is_ok() { cover_file = Some(c); }
        }
    }
    let mut args: Vec<String> = vec!["-y".into(), "-loglevel".into(), "error".into(), "-i".into(), file.to_string_lossy().into()];
    if let Some(c) = &cover_file { args.extend(["-i".into(), c.to_string_lossy().into(), "-map".into(), "0:a".into(), "-map".into(), "1:0".into(), "-disposition:v:0".into(), "attached_pic".into()]); }
    else { args.extend(["-map".into(), "0".into()]); }
    args.extend(["-c".into(), "copy".into(), "-map_metadata".into(), "-1".into(), "-metadata".into(), format!("title={}", job.title), "-metadata".into(), format!("artist={}", job.artist)]);
    if !job.album.is_empty() { args.extend(["-metadata".into(), format!("album={}", job.album)]); }
    if ext == ".mp3" { args.extend(["-id3v2_version".into(), "3".into()]); }
    args.push(tmp.to_string_lossy().into());
    let ok = ffmpeg_run(args).await;
    if let Some(c) = cover_file { let _ = std::fs::remove_file(c); }
    if !ok { let _ = std::fs::remove_file(&tmp); return file.to_path_buf(); }
    // the same song downloaded again (say, after a wrong match) replaces the old file
    let _ = std::fs::remove_file(file);
    let _ = std::fs::remove_file(&target);
    if std::fs::rename(&tmp, &target).is_err() { return tmp; }
    target
}

/* ───────────── controls ───────────── */
fn cancel(id: u64) {
    let Some(job) = with(|d| d.jobs.get(&id).cloned()) else { return };
    if ["done", "error", "cancelled"].contains(&job.status.as_str()) { remove(id); return; }
    edit(id, |j| j.status = "cancelled".into());
    if let Some(Some(tx)) = with(|d| d.running.get_mut(&id).map(|t| t.take())) { let _ = tx.send(()); }
    update(id);
    settle(id);
    remove(id);
    pump();
}

fn settle(id: u64) {
    let Some(job) = with(|d| d.jobs.get(&id).cloned()) else { return };
    if !["done", "error", "cancelled"].contains(&job.status.as_str()) { return; }
    if let Some(tx) = with(|d| d.waiters.remove(&id)) { let _ = tx.send(job); }
}

pub fn stop_all() {
    let txs: Vec<oneshot::Sender<()>> = with(|d| d.running.values_mut().filter_map(|t| t.take()).collect());
    for t in txs { let _ = t.send(()); }
}

/* ───────────── song requests from chat ─────────────
   One song: a YouTube link, or the best search result. It has to pass the request rules
   (from an allowed channel, not too long, not a live stream), is downloaded once, and the
   file is reused whenever the same video is requested again. */
fn url_tail(u: &str) -> String {
    Regex::new(r"/(?:channel/|@)([^/?#]+)").unwrap().captures(u).map(|c| urlencoding::decode(&c[1]).map(|s| s.into_owned()).unwrap_or_default()).unwrap_or_default()
}
fn allowed_channel(e: &Value, keys: &[String]) -> bool {
    let norm = |s: String| s.to_lowercase().trim_start_matches('@').trim().to_string();
    let vals = [sv(e, "channel_id"), sv(e, "uploader_id"), sv(e, "channel"), sv(e, "uploader"), url_tail(&sv(e, "channel_url")), url_tail(&sv(e, "uploader_url"))];
    keys.iter().any(|k| vals.iter().any(|v| !v.is_empty() && &norm(v.clone()) == k))
}
// words that can never be requested, checked against the title and the channel
fn blocked_by(text: &str, words: &[String]) -> bool {
    let t = format!(" {} ", plain(text));
    words.iter().map(|w| plain(w)).filter(|w| !w.is_empty()).any(|w| t.contains(&format!(" {} ", w)))
}

async fn request(query: String, channels_list: Vec<String>, any_channel: bool, max_seconds: f64, blocked: Vec<String>) -> Value {
    let query = query.trim().to_string();
    if query.is_empty() { return json!({ "ok": false, "reason": "empty" }); }
    let r: Result<Value, String> = async {
        ensure_ready().await?;
        let keys: Vec<String> = channels_list.iter().map(|l| channels::channel_key(l)).filter(|k| !k.is_empty()).collect();
        let mut candidates: Vec<Value>;
        if Regex::new(r"(?i)^https?://").unwrap().is_match(&query) || Regex::new(r"(?i)^(www\.|m\.)?(youtube\.com|youtu\.be)/").unwrap().is_match(&query) {
            let url = if query.to_lowercase().starts_with("http") { query.clone() } else { format!("https://{}", query) };
            let host = url::Url::parse(&url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
            if !Regex::new(r"(?i)(^|\.)(youtube\.com|youtu\.be)$").unwrap().is_match(&host) { return Ok(json!({ "ok": false, "reason": "link" })); }
            candidates = vec![run_json(&["-J".into(), "--no-playlist".into(), url]).await?];
        } else {
            let found = run_json(&["--flat-playlist".into(), "-J".into(), format!("ytsearch10:{}", query)]).await?;
            // best fit first (YouTube's own order breaks ties): "Song (Instrumental)" finds the instrumental
            let mut scored: Vec<(i64, usize, Value)> = found.get("entries").and_then(|e| e.as_array()).cloned().unwrap_or_default().into_iter()
                .filter(|e| !sv(e, "id").is_empty()).enumerate().map(|(i, e)| (request_score(&e, &query), i, e)).collect();
            scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
            candidates = scored.into_iter().map(|x| x.2).collect();
        }
        if candidates.is_empty() { return Ok(json!({ "ok": false, "reason": "not-found" })); }
        let clean: Vec<Value> = candidates.iter().filter(|e| !blocked_by(&format!("{} {} {} {}", sv(e, "title"), sv(e, "channel"), sv(e, "uploader"), sv(e, "artist")), &blocked)).cloned().collect();
        if clean.is_empty() { return Ok(json!({ "ok": false, "reason": "blocked" })); }
        candidates = clean;
        let live = |e: &Value| sv(e, "live_status") == "is_live" || e.get("is_live").and_then(|v| v.as_bool()) == Some(true) || sv(e, "live_status") == "is_upcoming";
        let allowed: Vec<&Value> = candidates.iter().filter(|e| any_channel || allowed_channel(e, &keys)).collect();
        if allowed.is_empty() { return Ok(json!({ "ok": false, "reason": "not-allowed", "title": sv(&candidates[0], "title") })); }
        let fits: Vec<&&Value> = allowed.iter().filter(|e| !live(e) && e.get("duration").and_then(|d| d.as_f64()).map(|d| d <= max_seconds).unwrap_or(true)).collect();
        let Some(pick) = fits.first() else {
            return Ok(json!({ "ok": false, "reason": if live(allowed[0]) { "live" } else { "too-long" }, "title": sv(allowed[0], "title") }));
        };
        let vid = sv(pick, "id");
        let title = { let t = sv(pick, "title"); if t.is_empty() { "untitled".into() } else { t } };
        let artist = [sv(pick, "artist"), sv(pick, "channel"), sv(pick, "uploader")].into_iter().find(|s| !s.is_empty()).unwrap_or_default();

        // asked for before: same file again
        let known = config::get("requestFiles").get(&vid).and_then(|v| v.as_str()).map(String::from);
        if let Some(k) = known.filter(|k| Path::new(k).exists()) {
            files::allow(Path::new(&k));
            return Ok(json!({ "ok": true, "file": k, "title": title, "artist": artist, "videoId": vid, "reused": true }));
        }
        let (tx, rx) = oneshot::channel();
        let id = new_job(Job { source: "youtube".into(), url: format!("https://www.youtube.com/watch?v={}", vid), title: title.clone(), artist: artist.clone(),
            format: "m4a".into(), group: NEXT_GROUP.fetch_add(1, Ordering::SeqCst), note: "song request".into(), dir: Some(request_dir()), ..Job::default() });
        with(|d| d.waiters.insert(id, tx));
        pump();
        let finished = rx.await.map_err(|_| "cancelled".to_string())?;
        if finished.status != "done" || finished.file.is_empty() {
            return Ok(json!({ "ok": false, "reason": "download", "title": title, "error": if finished.error.is_empty() { "cancelled".into() } else { finished.error } }));
        }
        let mut map = config::get("requestFiles");
        if !map.is_object() { map = json!({}); }
        map[&vid] = json!(finished.file);
        config::set("requestFiles", map);
        Ok(json!({ "ok": true, "file": finished.file, "title": title, "artist": artist, "videoId": vid }))
    }.await;
    r.unwrap_or_else(|e| json!({ "ok": false, "reason": "error", "error": e }))
}

/// Songs for Discord's suggestions while someone types /sr: YouTube's search results that pass
/// the same rules as a request (allowed channel, not too long, not live, no blocked words),
/// best fit first, as (video id, title, channel, seconds).
pub async fn suggest(query: &str, channels_list: &[String], any_channel: bool, max_seconds: f64, blocked: &[String]) -> Vec<(String, String, String, f64)> {
    let Ok(found) = crate::chat::search_videos(query).await else { return Vec::new() };
    pick_suggestions(found, query, channels_list, any_channel, max_seconds, blocked)
}
fn pick_suggestions(found: Vec<Value>, query: &str, channels_list: &[String], any_channel: bool, max_seconds: f64, blocked: &[String]) -> Vec<(String, String, String, f64)> {
    let keys: Vec<String> = channels_list.iter().map(|l| channels::channel_key(l)).filter(|k| !k.is_empty()).collect();
    let mut scored: Vec<(i64, usize, Value)> = found.into_iter().take(20).enumerate().map(|(i, e)| (request_score(&e, query), i, e)).collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    scored.into_iter().map(|x| x.2)
        .filter(|e| sv(e, "live_status") != "is_live")
        .filter(|e| e["duration"].as_f64().map(|d| d <= max_seconds).unwrap_or(false))
        .filter(|e| !blocked_by(&format!("{} {}", sv(e, "title"), sv(e, "channel")), blocked))
        .filter(|e| any_channel || allowed_channel(e, &keys))
        .map(|e| (sv(&e, "id"), sv(&e, "title"), sv(&e, "channel"), e["duration"].as_f64().unwrap_or(0.0)))
        .collect()
}

// a channel (or a video's channel) through yt-dlp, when YouTube's page couldn't be read
pub async fn channel_of(url: &str, video: bool) -> Result<Option<(String, String)>, String> {
    ensure_ready().await?;
    let args: Vec<String> = if video { vec!["-J".into(), "--no-playlist".into(), url.into()] } else { vec!["-J".into(), "--flat-playlist".into(), "--playlist-items".into(), "1".into(), url.into()] };
    let info = run_json(&args).await?;
    let re = Regex::new(r"^UC[\w-]{22}$").unwrap();
    let id = [sv(&info, "channel_id"), sv(&info, "uploader_id"), sv(&info, "id")].into_iter().find(|v| re.is_match(v));
    Ok(id.map(|id| (id, [sv(&info, "channel"), sv(&info, "uploader")].into_iter().find(|s| !s.is_empty()).unwrap_or_default())))
}

/* ───────────── what the page asks ───────────── */
#[tauri::command] pub async fn dl_add(url: String, format: String) -> Value { add(url, format).await }
#[tauri::command] pub async fn dl_add_list(text: String, format: String) -> Value { add_list(text.chars().take(20_000_000).collect(), format).await }
#[tauri::command] pub fn dl_list() -> Value { json!(with(|d| d.jobs.values().map(|j| j.public()).collect::<Vec<_>>())) }
#[tauri::command] pub fn dl_cancel(id: u64) { cancel(id) }
#[tauri::command]
pub fn dl_retry(id: u64) {
    let ok = edit(id, |j| if j.status == "error" { j.status = "queued".into(); j.error.clear(); j.note.clear(); j.attempts = 0; j.progress = 0.0; }).map(|j| j.status == "queued").unwrap_or(false);
    if !ok { return; }
    update(id);
    tauri::async_runtime::spawn(async move {
        match ensure_ready().await {
            Ok(()) => pump(),
            Err(e) => { edit(id, |j| { j.status = "error".into(); j.error = e; }); update(id); }
        }
    });
}
#[tauri::command]
pub fn dl_cancel_all() {
    let ids: Vec<u64> = with(|d| d.jobs.values().filter(|j| j.status != "done" && j.status != "error").map(|j| j.id).collect());
    for id in ids { cancel(id); }
}
#[tauri::command]
pub fn dl_clear() {
    let ids: Vec<u64> = with(|d| d.jobs.values().filter(|j| j.status == "done" || j.status == "error").map(|j| j.id).collect());
    for id in ids { remove(id); }
}
#[tauri::command] pub fn dl_folder() -> String { out_dir().to_string_lossy().to_string() }
#[tauri::command]
pub async fn dl_choose_folder(app: AppHandle) -> String {
    use tauri_plugin_dialog::DialogExt;
    let d = app.dialog().file().set_title("Where should moonlit save downloaded songs?").set_directory(out_dir());
    let picked = tauri::async_runtime::spawn_blocking(move || d.blocking_pick_folder()).await.ok().flatten().and_then(|p| p.into_path().ok());
    match picked {
        Some(p) => { config::set("downloadDir", json!(p.to_string_lossy())); p.to_string_lossy().to_string() }
        None => out_dir().to_string_lossy().to_string(),
    }
}
#[tauri::command]
pub fn dl_open_folder(app: AppHandle) -> String {
    use tauri_plugin_opener::OpenerExt;
    let dir = out_dir();
    let _ = std::fs::create_dir_all(&dir);
    match app.opener().open_path(dir.to_string_lossy(), None::<&str>) { Ok(()) => String::new(), Err(e) => e.to_string() }
}
#[tauri::command]
pub async fn dl_request(query: String, rules: Value) -> Value {
    let list = |k: &str, n: usize| rules.get(k).and_then(|v| v.as_array()).map(|a| a.iter().take(n).map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).collect()).unwrap_or_default();
    let max = rules.get("maxSeconds").and_then(|v| v.as_f64()).filter(|v| *v > 0.0).unwrap_or(600.0).clamp(60.0, 3600.0);
    request(query, list("channels", 200), rules.get("anyChannel").and_then(|v| v.as_bool()).unwrap_or(false), max, list("blocked", 500)).await
}
// a request's download that has played: delete the file (only files moonlit downloaded for requests)
#[tauri::command]
pub fn dl_forget_request(file: String) -> bool {
    let map = config::get("requestFiles");
    let Some(m) = map.as_object() else { return false };
    let keep: Map<String, Value> = m.iter().filter(|(_, v)| v.as_str() != Some(file.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
    if keep.len() == m.len() { return false; }
    config::set("requestFiles", Value::Object(keep));
    let _ = std::fs::remove_file(&file);
    true
}
// every file downloaded for a request that's still on the PC (to tidy up after older versions)
#[tauri::command]
pub fn dl_request_files() -> Vec<String> {
    config::get("requestFiles").as_object().map(|m| m.values().filter_map(|v| v.as_str()).filter(|f| Path::new(f).exists()).map(String::from).collect()).unwrap_or_default()
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggestions_follow_the_rules() {
        let v = |id: &str, title: &str, ch: &str, chid: &str, handle: &str, len: &str| json!({ "videoRenderer": {
            "videoId": id, "title": { "runs": [{ "text": title }] },
            "ownerText": { "runs": [{ "text": ch, "navigationEndpoint": { "browseEndpoint": { "browseId": chid, "canonicalBaseUrl": handle } } }] },
            "lengthText": if len.is_empty() { Value::Null } else { json!({ "simpleText": len }) },
        }});
        let page = json!({ "contents": { "twoColumnSearchResultsRenderer": { "primaryContents": { "sectionListRenderer": { "contents": [
            { "itemSectionRenderer": { "contents": [
                v("a1", "Alan Walker - Faded", "Alan Walker", "UCJrOtniJ0-NWz37R30urifQ", "/@Alanwalkermusic", "3:32"),
                { "adSlotRenderer": {} },
                v("n1", "Faded (NCS Release)", "NoCopyrightSounds", "UC_aEa8K-EOJ3D6gOs7HcyNg", "/@NoCopyrightSounds", "4:01"),
                v("n2", "Faded 10 hour loop", "NoCopyrightSounds", "UC_aEa8K-EOJ3D6gOs7HcyNg", "/@NoCopyrightSounds", "10:00:00"),
                v("n3", "Faded live", "NoCopyrightSounds", "UC_aEa8K-EOJ3D6gOs7HcyNg", "/@NoCopyrightSounds", ""),
                v("t1", "Faded nazi remix", "TheFatRat", "UCa_UMppcMsHIzb5LDx1u9zQ", "/@TheFatRat", "3:00"),
            ] } }
        ] } } } } });
        let found = crate::chat::search_results(&page);
        assert_eq!(found.len(), 5);
        assert_eq!(found[0]["duration"], json!(212.0));
        let channels = vec!["UC_aEa8K-EOJ3D6gOs7HcyNg  # NoCopyrightSounds".to_string(), "@TheFatRat".to_string()];
        let blocked = vec!["nazi".to_string()];
        let viewer: Vec<String> = pick_suggestions(found.clone(), "faded", &channels, false, 600.0, &blocked).into_iter().map(|x| x.0).collect();
        assert_eq!(viewer, ["n1"]);
        let owner: Vec<String> = pick_suggestions(found, "faded", &channels, true, 3600.0, &blocked).into_iter().map(|x| x.0).collect();
        assert_eq!(owner, ["a1", "n1"]);
    }
    #[test]
    fn csv() {
        let j = read_playlist_csv("\u{feff}Track Name,Artist Name(s),Album Name,Duration (ms)\n\"Song, with comma\",\"A, B\",Alb,123000\n");
        assert_eq!(j.len(), 1);
        assert_eq!(j[0].title, "Song, with comma");
        assert_eq!(j[0].artist, "A, B");
        assert_eq!(j[0].duration_ms, 123000.0);
    }
    #[test]
    fn artist() {
        assert_eq!(tidy_artist("A;B"), "A, B");
        assert_eq!(tidy_artist("AC/DC"), "AC/DC");
        assert_eq!(tidy_artist("A / B"), "A, B");
    }
    #[test]
    fn score() {
        let e = json!({ "title": "Song (Instrumental)", "channel": "X" });
        assert!(request_score(&e, "song instrumental") > request_score(&json!({ "title": "Song", "channel": "X" }), "song instrumental"));
    }
}
