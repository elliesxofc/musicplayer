//! Moving in from the Electron version of moonlit.
//!
//! The old app kept your library (the songs themselves, covers, loved songs, playlists) and
//! your settings inside its own browser storage, which this app's browser engine can't open.
//! So, once, moonlit starts the old app hidden-ish with a debugging port only this PC can
//! reach, asks its page to hand everything over to a small local server here, then closes
//! it. The page then puts it all in the new library. Nothing leaves this PC.
//!
//! Settings in desktop.json (OBS file, chat bot, Spotify, tray…) are simply copied, and the
//! secrets in it are re-locked for this app.

use crate::{config, httpd, secrets};
use rand::RngCore;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::AsyncWriteExt;

fn old_data() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|d| Path::new(&d).join("moonlit"))
}
fn move_dir() -> PathBuf { config::data_dir().join("moving") }

/// desktop.json from the old app, the first time this one starts
pub fn bring_settings() {
    if config::get("movedSettings").as_bool() == Some(true) { return; }
    let mut moved = json!({ "movedSettings": true });
    if let Some(old) = old_data().map(|d| d.join("desktop.json")).filter(|p| p.exists()) {
        if let Some(Value::Object(m)) = std::fs::read_to_string(old).ok().and_then(|s| serde_json::from_str(&s).ok()) {
            let mine = config::read();
            for (k, v) in m {
                if mine.contains_key(&k) || k == "window" || k == "ytdlpCheckedAt" { continue; }
                moved[&k] = v;
            }
            // secrets locked by the old app (Electron's safeStorage): unlock and lock again for this one
            if let Some(login) = moved.pointer("/chat/login").cloned() {
                let plain = secrets::unseal(&login);
                moved["chat"]["login"] = if plain.is_empty() { Value::Null } else { secrets::seal(&plain) };
            }
            if let Some(r) = moved.pointer("/spotify/refresh").cloned() {
                let plain = secrets::unseal(&r);
                moved["spotify"]["refresh"] = if plain.is_empty() { Value::Null } else { secrets::seal(&plain) };
            }
        }
    }
    config::write(moved);
}

/// the old app's moonlit.exe, if it's still installed
fn old_exe() -> Option<PathBuf> {
    let mine = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()));
    let mut found: Vec<PathBuf> = vec![];
    if let Some(l) = std::env::var_os("LOCALAPPDATA") {
        // the copy the installer kept, then the usual install place
        found.push(Path::new(&l).join("moonlit-old").join("moonlit.exe"));
        found.push(Path::new(&l).join("Programs").join("moonlit").join("moonlit.exe"));
    }
    #[cfg(windows)]
    {
        use winreg::enums::*;
        for root in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            let Ok(k) = winreg::RegKey::predef(root).open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Uninstall") else { continue };
            for name in k.enum_keys().flatten() {
                let Ok(sub) = k.open_subkey(&name) else { continue };
                let display: String = sub.get_value("DisplayName").unwrap_or_default();
                if !display.to_lowercase().starts_with("moonlit") { continue; }
                let loc: String = sub.get_value("InstallLocation").unwrap_or_default();
                if !loc.is_empty() { found.push(Path::new(loc.trim_matches('"')).join("moonlit.exe")); }
            }
        }
    }
    found.into_iter().find(|p| {
        // the old app has its Electron files next to it; this app is a single program
        p.exists() && p.parent().map(|d| d.join("resources").join("app.asar").exists()).unwrap_or(false)
            && p.parent().map(|d| Some(d.to_path_buf()) != mine).unwrap_or(false)
    })
}

fn old_has_library() -> bool {
    old_data().map(|d| d.join("IndexedDB").exists() || d.join("Local Storage").exists()).unwrap_or(false)
}

/// the copy of the old app the installer kept, once it's no longer needed
fn forget_old_copy() {
    if let Some(l) = std::env::var_os("LOCALAPPDATA") {
        let _ = std::fs::remove_dir_all(Path::new(&l).join("moonlit-old"));
    }
}

/// { available: the old app and its library are there, ready: moved and waiting for the page }
#[tauri::command]
pub fn move_status() -> Value {
    let done = config::get("movedLibrary").as_bool() == Some(true);
    if done || !old_has_library() { forget_old_copy(); }
    let ready = move_dir().join("meta.json").exists();
    json!({ "available": !done && old_has_library() && old_exe().is_some(), "ready": ready, "done": done })
}

// the page of the old app runs this: everything in its library and settings, to us
const EXPORT: &str = r#"(async (base) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('moonlit'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const recs = db.objectStoreNames.contains('tracks') ? await new Promise((res, rej) => {
    const q = db.transaction('tracks', 'readonly').objectStore('tracks').getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  }) : [];
  const tracks = [];
  for (const t of recs) {
    const m = {};
    for (const [k, v] of Object.entries(t)) {
      if (v instanceof Blob) {
        const r = await fetch(base + '/blob?id=' + encodeURIComponent(t.id) + '&field=' + encodeURIComponent(k), { method: 'POST', body: v });
        if (!r.ok) throw new Error('the new moonlit didn\'t take a song');
        m[k] = { __blob: true, type: v.type || '', name: v.name || '', lastModified: v.lastModified || 0 };
      } else m[k] = v;
    }
    tracks.push(m);
  }
  const prefs = {};
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('moonlit:')) prefs[k] = localStorage.getItem(k); }
  const r = await fetch(base + '/meta', { method: 'POST', body: JSON.stringify({ tracks, prefs }) });
  if (!r.ok) throw new Error('the new moonlit didn\'t take the list');
  return tracks.length;
})"#;

static RUN: AtomicU64 = AtomicU64::new(0);

fn safe_name(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).take(120).collect()
}

async fn receiver() -> Result<(tokio::net::TcpListener, u16), String> {
    let l = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| e.to_string())?;
    let port = l.local_addr().map_err(|e| e.to_string())?.port();
    Ok((l, port))
}

async fn serve(listener: tokio::net::TcpListener, token: String, me: u64) {
    let dir = move_dir();
    loop {
        if RUN.load(Ordering::SeqCst) != me { return; }
        let Ok(Ok((mut s, _))) = tokio::time::timeout(std::time::Duration::from_secs(1), listener.accept()).await else { continue };
        let dir = dir.clone();
        let token = token.clone();
        tokio::spawn(async move {
            let Some(req) = httpd::read_request(&mut s).await else { return };
            // the old page asks first whether it may send (it's another "site" to its browser)
            let cors = [("Access-Control-Allow-Origin", "*"), ("Access-Control-Allow-Methods", "POST"), ("Access-Control-Allow-Headers", "*"), ("Access-Control-Allow-Private-Network", "true")];
            if req.method == "OPTIONS" { return httpd::respond(&mut s, 204, &cors, b"").await; }
            if req.method != "POST" || !req.path.starts_with(&format!("/{}/", token)) { return httpd::respond(&mut s, 404, &cors, b"").await; }
            let what = &req.path[token.len() + 1..];
            let target = match what {
                "/meta" => dir.join("meta.json"),
                "/blob" => dir.join(format!("{}.{}", safe_name(req.q("id").unwrap_or("")), safe_name(req.q("field").unwrap_or("")))),
                _ => return httpd::respond(&mut s, 404, &cors, b"").await,
            };
            // the body goes straight to the file (songs can be big)
            let total = req.content_length();
            let Ok(mut f) = tokio::fs::File::create(&target).await else { return httpd::respond(&mut s, 500, &cors, b"").await };
            let mut got = req.early_body.len();
            let _ = f.write_all(&req.early_body).await;
            let mut buf = vec![0u8; 256 * 1024];
            while got < total {
                match tokio::io::AsyncReadExt::read(&mut s, &mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => { got += n; if f.write_all(&buf[..n]).await.is_err() { break; } }
                }
            }
            let _ = f.flush().await;
            httpd::respond(&mut s, if got >= total { 200 } else { 400 }, &cors, b"").await;
        });
    }
}

/// Starts the old app, has its page send everything here, and closes it again.
#[tauri::command]
pub async fn move_run() -> Value {
    match run().await {
        Ok(n) => json!({ "ok": true, "count": n }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

async fn run() -> Result<u64, String> {
    let exe = old_exe().ok_or("the old moonlit isn't installed any more")?;
    let me = RUN.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = std::fs::remove_dir_all(move_dir());
    std::fs::create_dir_all(move_dir()).map_err(|e| e.to_string())?;
    let mut t = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut t);
    let token: String = t.iter().map(|b| format!("{:02x}", b)).collect();
    let (listener, port) = receiver().await?;
    tokio::spawn(serve(listener, token.clone(), me));

    // a free port for the old app's debugging connection
    let debug_port = { let l = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?; l.local_addr().map_err(|e| e.to_string())?.port() };
    let mut cmd = tokio::process::Command::new(&exe);
    cmd.arg(format!("--remote-debugging-port={}", debug_port)).arg("--remote-allow-origins=*").arg("--mute-audio").kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("couldn't start the old moonlit ({})", e))?;

    let result = async {
        // its page, once it's up
        let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(3)).no_proxy().build().map_err(|e| e.to_string())?;
        let mut ws_url = None;
        for _ in 0..60 {
            if let Ok(Some(_)) = child.try_wait() { return Err("the old moonlit closed right away. if it's open, close it (and its tray icon) and try again".to_string()); }
            if let Ok(r) = client.get(format!("http://127.0.0.1:{}/json/list", debug_port)).send().await {
                if let Ok(list) = r.json::<Value>().await {
                    ws_url = list.as_array().into_iter().flatten()
                        .find(|t| t.get("type").and_then(|v| v.as_str()) == Some("page") && t.get("url").and_then(|v| v.as_str()).map(|u| u.starts_with("moonlit://")).unwrap_or(false))
                        .and_then(|t| t.get("webSocketDebuggerUrl").and_then(|v| v.as_str()).map(String::from));
                    if ws_url.is_some() { break; }
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        let ws_url = ws_url.ok_or("the old moonlit didn't open its library")?;
        // give its page a moment to finish starting
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        let (mut ws, _) = tokio_tungstenite::connect_async(ws_url.as_str()).await.map_err(|e| e.to_string())?;
        use futures_util::{SinkExt, StreamExt};
        let expr = format!("{}('http://127.0.0.1:{}/{}')", EXPORT, port, token);
        let msg = json!({ "id": 1, "method": "Runtime.evaluate", "params": { "expression": expr, "awaitPromise": true, "returnByValue": true } });
        ws.send(tokio_tungstenite::tungstenite::Message::Text(msg.to_string())).await.map_err(|e| e.to_string())?;
        let answer = tokio::time::timeout(std::time::Duration::from_secs(3600), async {
            while let Some(Ok(m)) = ws.next().await {
                if let tokio_tungstenite::tungstenite::Message::Text(t) = m {
                    let v: Value = serde_json::from_str(&t).unwrap_or(Value::Null);
                    if v.get("id").and_then(|i| i.as_u64()) == Some(1) { return Some(v); }
                }
            }
            None
        }).await.ok().flatten().ok_or("the old moonlit stopped answering")?;
        if let Some(ex) = answer.pointer("/result/exceptionDetails") {
            let why = ex.pointer("/exception/description").and_then(|v| v.as_str()).unwrap_or("something went wrong");
            return Err(why.lines().next().unwrap_or("").to_string());
        }
        Ok(answer.pointer("/result/result/value").and_then(|v| v.as_u64()).unwrap_or(0))
    }.await;
    let _ = child.kill().await;
    RUN.fetch_add(1, Ordering::SeqCst);
    if result.is_err() { let _ = std::fs::remove_dir_all(move_dir()); }
    result
}

/// what was brought over: { tracks: [...], prefs: {...} }
#[tauri::command]
pub fn move_take() -> Value {
    std::fs::read_to_string(move_dir().join("meta.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn move_blob(id: String, field: String) -> Result<tauri::ipc::Response, String> {
    let f = move_dir().join(format!("{}.{}", safe_name(&id), safe_name(&field)));
    tokio::fs::read(f).await.map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

/// the page has it all: tidy up, and never ask again
#[tauri::command]
pub fn move_done() {
    let _ = std::fs::remove_dir_all(move_dir());
    forget_old_copy();
    config::set("movedLibrary", json!(true));
}
