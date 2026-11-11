//! Files on this PC: songs opened from Windows (double-click / Open with), the OBS
//! now-playing text file, and playlist files (.m3u8 / .m3u). The page can only read files
//! Windows handed moonlit, ones a playlist you picked names, or songs moonlit downloaded.

use crate::config;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

static OPENED: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);
static PENDING: Mutex<Vec<String>> = Mutex::new(Vec::new());

const AUDIO: [&str; 12] = ["mp3", "m4a", "aac", "flac", "wav", "ogg", "oga", "opus", "webm", "weba", "aif", "aiff"];

pub fn is_audio(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).map(|e| AUDIO.contains(&e.to_ascii_lowercase().as_str())).unwrap_or(false)
}

pub fn audio_files_in(argv: &[String], cwd: Option<&Path>) -> Vec<PathBuf> {
    argv.iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(a);
            match (p.is_absolute(), cwd) {
                (false, Some(c)) => c.join(p),
                _ => p,
            }
        })
        .filter(|p| is_audio(p) && p.is_file())
        .map(|p| std::fs::canonicalize(&p).map(clean).unwrap_or(p))
        .collect()
}

// Windows' canonical paths start with \\?\ ; the page shows (and Windows opens) them without
fn clean(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy().to_string();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => p,
    }
}

/// files the page may read from now on
pub fn allow(p: &Path) {
    let mut g = OPENED.lock().unwrap_or_else(|e| e.into_inner());
    g.get_or_insert_with(HashSet::new).insert(p.to_path_buf());
}
fn allowed(p: &Path) -> bool {
    OPENED.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|s| s.contains(p)).unwrap_or(false)
}

pub fn accept(files: Vec<PathBuf>) -> Vec<String> {
    files.iter().for_each(|f| allow(f));
    files.iter().map(|f| f.to_string_lossy().to_string()).collect()
}
pub fn add_pending(f: String) {
    PENDING.lock().unwrap_or_else(|e| e.into_inner()).push(f);
}

// Songs opened from Windows: the page asks for the list once it's ready, then reads each one.
#[tauri::command]
pub fn files_pending() -> Vec<String> {
    std::mem::take(&mut *PENDING.lock().unwrap_or_else(|e| e.into_inner()))
}

#[tauri::command]
pub fn file_info(file: String) -> Option<Value> {
    let p = PathBuf::from(&file);
    if !allowed(&p) {
        return None;
    }
    let meta = std::fs::metadata(&p).ok()?;
    let ms = meta.modified().ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);
    Some(json!({ "name": p.file_name()?.to_string_lossy(), "lastModified": ms, "size": meta.len() }))
}

#[tauri::command]
pub async fn file_bytes(file: String) -> Result<tauri::ipc::Response, String> {
    let p = PathBuf::from(&file);
    if !allowed(&p) {
        return Err("not allowed".into());
    }
    let data = tokio::fs::read(&p).await.map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(data))
}

/* ───────────── the OBS now-playing file: picked once, remembered, written directly ───────────── */
fn base_name(p: &str) -> String {
    Path::new(p).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

#[tauri::command]
pub async fn obs_choose(app: AppHandle) -> Option<Value> {
    let current = config::get_str("nowPlayingPath");
    let mut d = app.dialog().file().set_title("Where should moonlit save the song name for OBS?").add_filter("Text file", &["txt"]);
    if !current.is_empty() {
        let c = PathBuf::from(&current);
        if let Some(dir) = c.parent() { d = d.set_directory(dir); }
        d = d.set_file_name(base_name(&current));
    } else {
        if let Ok(docs) = tauri::Manager::path(&app).document_dir() { d = d.set_directory(docs); }
        d = d.set_file_name("nowplaying.txt");
    }
    let picked = tauri::async_runtime::spawn_blocking(move || d.blocking_save_file()).await.ok()??;
    let path = picked.into_path().ok()?.to_string_lossy().to_string();
    config::set("nowPlayingPath", json!(path));
    Some(json!({ "path": path, "name": base_name(&path) }))
}

#[tauri::command]
pub fn obs_get() -> Option<Value> {
    let p = config::get_str("nowPlayingPath");
    (!p.is_empty()).then(|| json!({ "path": p, "name": base_name(&p) }))
}

#[tauri::command]
pub fn obs_unlink() -> bool {
    config::set("nowPlayingPath", Value::Null);
    true
}

#[tauri::command]
pub async fn obs_write(text: String) -> bool {
    let p = config::get_str("nowPlayingPath");
    if p.is_empty() {
        return false;
    }
    let text: String = text.chars().take(2000).collect();
    tokio::fs::write(&p, text.as_bytes()).await.is_ok()
}

/* ───────────── playlist files (.m3u8 / .m3u) ───────────── */
// import: the file's text, plus the songs it points to that are on this PC (only these, the
// ones the playlist you picked names, may then be read)
#[tauri::command]
pub async fn playlist_open(app: AppHandle) -> Option<Value> {
    let d = app.dialog().file().set_title("import a playlist")
        .add_filter("playlists", &["m3u8", "m3u"])
        .add_filter("all files", &["*"]);
    let picked = tauri::async_runtime::spawn_blocking(move || d.blocking_pick_file()).await.ok()??;
    let file = picked.into_path().ok()?;
    let buf = std::fs::read(&file).ok()?;
    if buf.len() > 5_000_000 {
        return Some(json!({ "error": "that file is too big to be a playlist" }));
    }
    let text = match String::from_utf8(buf.clone()) {
        Ok(s) => s.trim_start_matches('\u{feff}').to_string(),
        // an old .m3u in the Windows code page
        Err(_) => buf.iter().map(|&b| b as char).collect(),
    };
    let dir = file.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let mut files = serde_json::Map::new();
    let web = regex::Regex::new(r"(?i)^[a-z][a-z0-9+.-]+://").unwrap();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let p = if line.to_ascii_lowercase().starts_with("file:") {
            match url::Url::parse(line).ok().and_then(|u| u.to_file_path().ok()) { Some(p) => p, None => continue }
        } else if web.is_match(line) {
            continue; // web links
        } else {
            dir.join(line)
        };
        if is_audio(&p) && p.is_file() {
            let abs = std::fs::canonicalize(&p).map(clean).unwrap_or(p);
            allow(&abs);
            files.insert(line.to_string(), json!(abs.to_string_lossy()));
        }
    }
    let name = file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let name = regex::Regex::new(r"(?i)\.m3u8?$").unwrap().replace(&name, "").to_string();
    Some(json!({ "name": name, "text": text, "files": files }))
}

// export: save the playlist where you choose (your Music folder to start with)
#[tauri::command]
pub async fn playlist_save(app: AppHandle, name: String, text: String) -> Option<String> {
    let bad = regex::Regex::new(r#"[<>:"/\\|?*\x00-\x1f]+"#).unwrap();
    let safe: String = bad.replace_all(&name, " ").trim().chars().take(120).collect();
    let safe = if safe.is_empty() { "playlist".to_string() } else { safe };
    let mut d = app.dialog().file().set_title("save the playlist").add_filter("playlist", &["m3u8"]).set_file_name(format!("{}.m3u8", safe));
    if let Ok(m) = tauri::Manager::path(&app).audio_dir() { d = d.set_directory(m); }
    let picked = tauri::async_runtime::spawn_blocking(move || d.blocking_save_file()).await.ok()??;
    let path = picked.into_path().ok()?;
    let text: String = text.chars().take(20_000_000).collect();
    std::fs::write(&path, text).ok()?;
    Some(path.to_string_lossy().to_string())
}
