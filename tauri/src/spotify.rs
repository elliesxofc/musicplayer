//! Spotify's "now playing" in moonlit. Two ways: the Spotify app on this PC through Windows'
//! media controls (free, no setup, the default on Windows), or a connected Spotify account
//! through Spotify's Web API (Spotify only allows that with Premium). A connected account
//! wins when there is one.
//!
//! The account: you connect your own Spotify account once (through your own free Spotify
//! developer app, so nothing goes through anyone else's server). moonlit then asks Spotify
//! every few seconds what's playing.

use crate::{config, emit, httpd, overlay, secrets, winmedia};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::AppHandle;

const ACCOUNTS: &str = "https://accounts.spotify.com";
const API: &str = "https://api.spotify.com";
// Spotify only accepts this exact address, typed into the developer app's settings
const REDIRECT_PORT: u16 = 4860;
const REDIRECT: &str = "http://127.0.0.1:4860/callback";
const SCOPES: &str = "user-read-playback-state user-read-currently-playing user-modify-playback-state";
const POLL: u64 = 3000;
const POLL_IDLE: u64 = 10_000;

#[derive(Default, Clone)]
struct Auth {
    client_id: String,
    refresh: String,
    access: String,
    expires: f64,
}

struct S {
    auth: Auth,
    status: Value,
    last: Value,
    last_cover_for: String,
    web: Value,
    local: Value,
}

static ST: Mutex<Option<S>> = Mutex::new(None);
static TIMER: AtomicU64 = AtomicU64::new(0);
static LOGIN: AtomicU64 = AtomicU64::new(0);
static POLLING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn with<R>(f: impl FnOnce(&mut S) -> R) -> R {
    let mut g = ST.lock().unwrap_or_else(|e| e.into_inner());
    let s = g.get_or_insert_with(|| S { auth: Auth::default(), status: json!({"text":"not connected","kind":"off"}), last: Value::Null, last_cover_for: String::new(), web: Value::Null, local: Value::Null });
    f(s)
}

fn http() -> reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| reqwest::Client::builder().timeout(Duration::from_secs(20)).build().unwrap_or_default()).clone()
}

fn load() -> Auth {
    let s = config::get("spotify");
    Auth {
        client_id: s.get("clientId").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        refresh: secrets::unseal(s.get("refresh").unwrap_or(&Value::Null)),
        ..Default::default()
    }
}
fn save(a: &Auth) {
    config::set("spotify", json!({ "clientId": a.client_id, "refresh": secrets::seal(&a.refresh) }));
}

fn set_status(text: &str, kind: &str) {
    let s = json!({ "text": text, "kind": kind });
    with(|st| st.status = s.clone());
    emit("spotify:status", s);
}

fn connected() -> bool { with(|s| !s.auth.refresh.is_empty()) }
fn current() -> Value { with(|s| if !s.auth.refresh.is_empty() { s.web.clone() } else { s.local.clone() }) }
fn publish_all() { emit("spotify:state", current()); }

/// the Spotify app on this PC said what it's playing
pub fn local_state(state: Value) {
    with(|s| s.local = state);
    publish_all();
}

fn local_on() -> bool {
    winmedia::available() && config::get("spotifyLocal").as_bool() != Some(false)
}

pub fn init() {
    let auth = load();
    let has = !auth.refresh.is_empty();
    with(|s| { s.auth = auth; s.status = if has { json!({"text":"connecting…","kind":"wait"}) } else { json!({"text":"not connected","kind":"off"}) }; });
    if has { schedule(500); }
    if local_on() { winmedia::start(); }
}

#[derive(Debug)]
enum Fail { Auth(String), Other(String) }

async fn token(force: bool) -> Result<String, Fail> {
    let a = with(|s| s.auth.clone());
    if a.refresh.is_empty() { return Err(Fail::Auth("not connected".into())); }
    if !force && !a.access.is_empty() && config::now_ms() < a.expires - 60_000.0 { return Ok(a.access); }
    let r = http().post(format!("{}/api/token", ACCOUNTS))
        .form(&[("grant_type", "refresh_token"), ("refresh_token", a.refresh.as_str()), ("client_id", a.client_id.as_str())])
        .send().await.map_err(|e| Fail::Other(e.to_string()))?;
    let ok = r.status().is_success();
    let code = r.status().as_u16();
    let data: Value = r.json().await.unwrap_or(Value::Null);
    if !ok {
        let err = data.get("error").and_then(|v| v.as_str()).unwrap_or("");
        // the connection was removed on Spotify's side (or the developer app was deleted)
        if err == "invalid_grant" || err == "invalid_client" {
            let cleared = Auth { client_id: a.client_id.clone(), ..Default::default() };
            save(&cleared);
            with(|s| s.auth = cleared);
            return Err(Fail::Auth("Spotify ended the connection, connect again".into()));
        }
        return Err(Fail::Other(data.get("error_description").and_then(|v| v.as_str()).map(String::from).unwrap_or(format!("Spotify said {}", code))));
    }
    let access = data.get("access_token").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let exp = data.get("expires_in").and_then(|v| v.as_f64()).unwrap_or(3600.0);
    let refresh = data.get("refresh_token").and_then(|v| v.as_str()).map(String::from).unwrap_or(a.refresh.clone());
    let next = Auth { client_id: a.client_id, refresh, access: access.clone(), expires: config::now_ms() + exp * 1000.0 };
    save(&next);
    with(|s| s.auth = next);
    Ok(access)
}

async fn api(method: reqwest::Method, path: &str) -> Result<reqwest::Response, Fail> {
    for retried in [false, true] {
        let t = token(retried).await?;
        let r = http().request(method.clone(), format!("{}{}", API, path)).bearer_auth(t).header("Content-Length", "0").send().await.map_err(|e| Fail::Other(e.to_string()))?;
        if r.status().as_u16() == 401 && !retried { continue; }
        return Ok(r);
    }
    unreachable!()
}

fn to_state(p: &Value) -> Value {
    let Some(item) = p.get("item").filter(|i| !i.is_null()) else { return Value::Null };
    let images = item.pointer("/album/images").or_else(|| item.get("images")).or_else(|| item.pointer("/show/images")).and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let cover = images.iter().find(|i| i.get("width").and_then(|w| w.as_f64()).map(|w| w > 0.0 && w <= 640.0).unwrap_or(false)).or(images.first());
    let artist = item.get("artists").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.get("name").and_then(|n| n.as_str())).collect::<Vec<_>>().join(", ")).filter(|s| !s.is_empty())
        .or_else(|| item.pointer("/show/name").and_then(|v| v.as_str()).map(String::from)).unwrap_or_default();
    json!({
        "id": format!("sp:{}", item.get("id").and_then(|v| v.as_str()).or_else(|| item.get("uri").and_then(|v| v.as_str())).unwrap_or("")),
        "title": item.get("name").and_then(|v| v.as_str()).unwrap_or(""),
        "artist": artist,
        "album": item.pointer("/album/name").and_then(|v| v.as_str()).unwrap_or(""),
        "duration": item.get("duration_ms").and_then(|v| v.as_f64()).unwrap_or(0.0) / 1000.0,
        "position": p.get("progress_ms").and_then(|v| v.as_f64()).unwrap_or(0.0) / 1000.0,
        "playing": p.get("is_playing").and_then(|v| v.as_bool()).unwrap_or(false),
        "cover": cover.and_then(|c| c.get("url")).and_then(|v| v.as_str()).unwrap_or(""),
        "url": item.pointer("/external_urls/spotify").and_then(|v| v.as_str()).unwrap_or(""),
        "device": p.pointer("/device/name").and_then(|v| v.as_str()).unwrap_or(""),
        "at": config::now_ms(),
    })
}

fn publish(state: Value) {
    let cover = {
        let id = state.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let url = state.get("cover").and_then(|v| v.as_str()).unwrap_or("").to_string();
        with(|s| {
            s.last = state.clone();
            s.web = state.clone();
            if !url.is_empty() && s.last_cover_for != id { s.last_cover_for = id.clone(); Some((id, url)) } else { None }
        })
    };
    publish_all();
    if let Some((id, url)) = cover {
        tauri::async_runtime::spawn(async move {
            if let Ok(r) = http().get(&url).send().await {
                if r.status().is_success() {
                    if let Ok(b) = r.bytes().await { overlay::get().set_cover(&id, "image/jpeg", Some(b.to_vec())); }
                }
            }
        });
    }
}

fn schedule(ms: u64) {
    let me = TIMER.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(ms)).await;
        if TIMER.load(Ordering::SeqCst) == me { poll().await; }
    });
}

async fn poll() {
    let Ok(_g) = POLLING.try_lock() else { return };
    let mut next = POLL;
    match api(reqwest::Method::GET, "/v1/me/player?additional_types=episode").await {
        Ok(r) => {
            let code = r.status().as_u16();
            if code == 429 {
                let after = r.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()).unwrap_or(30);
                next = POLL.max(after * 1000);
            } else if code == 204 {
                publish(Value::Null);
                next = POLL_IDLE;
            } else if r.status().is_success() {
                let state = to_state(&r.json::<Value>().await.unwrap_or(Value::Null));
                let idle = state.is_null() || !state.get("playing").and_then(|v| v.as_bool()).unwrap_or(false);
                publish(state);
                if idle { next = POLL_IDLE / 2; }
            } else if code == 403 {
                set_status("Spotify didn't allow it. In your Spotify developer app, add your account under User Management", "warn");
                next = POLL_IDLE * 3;
            } else {
                next = POLL_IDLE;
            }
            if r_ok(code) {
                let last = with(|s| s.last.clone());
                if last.is_null() { set_status("connected · nothing playing on Spotify", "on"); }
                else { let d = last.get("device").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("Spotify").to_string(); set_status(&format!("connected · {}", d), "on"); }
            }
        }
        Err(Fail::Auth(m)) => {
            set_status(if m == "not connected" { "not connected" } else { &m }, "warn");
            publish(Value::Null);
            return;
        }
        Err(Fail::Other(m)) => {
            set_status(&format!("can't reach Spotify ({}), trying again", m), "warn");
            next = POLL_IDLE * 2;
        }
    }
    schedule(next);
}
fn r_ok(code: u16) -> bool { (200..300).contains(&code) }

fn page(title: &str, text: &str) -> String {
    format!("<!doctype html><meta charset=\"utf-8\"><title>moonlit</title><body style=\"font:16px system-ui;background:#170a14;color:#fff3f8;display:grid;place-items:center;height:90vh;text-align:center\"><div><h1 style=\"font-weight:600;color:#ff7eb6\">{}</h1><p>{}</p></div>", title, text)
}

// Sign in through the browser (PKCE: no secret needed). Spotify sends you back to
// http://127.0.0.1:4860/callback, which this little server answers.
async fn connect(app: AppHandle, client_id: String) -> Result<(), String> {
    let client_id = client_id.trim().to_string();
    if client_id.len() != 32 || !client_id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("that doesn't look like a Client ID (32 letters and numbers)".into());
    }
    let me = LOGIN.fetch_add(1, Ordering::SeqCst) + 1;
    let mut raw = [0u8; 48];
    rand::thread_rng().fill_bytes(&mut raw);
    let verifier = B64URL.encode(raw);
    let challenge = B64URL.encode(Sha256::digest(verifier.as_bytes()));
    let mut sk = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut sk);
    let state_key = B64URL.encode(sk);

    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", REDIRECT_PORT)).await {
        Ok(l) => l,
        Err(_) => {
            let m = format!("port {} is busy. close whatever uses it, then try again", REDIRECT_PORT);
            set_status(&m, "warn");
            return Err(m);
        }
    };
    set_status("waiting for you to sign in to Spotify in your browser…", "wait");
    let q = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("client_id", &client_id).append_pair("response_type", "code").append_pair("redirect_uri", REDIRECT)
        .append_pair("scope", SCOPES).append_pair("code_challenge_method", "S256").append_pair("code_challenge", &challenge)
        .append_pair("state", &state_key).finish();
    crate::open_url(&app, &format!("{}/authorize?{}", ACCOUNTS, q));

    let result = tokio::time::timeout(Duration::from_secs(300), async {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else { continue };
            if LOGIN.load(Ordering::SeqCst) != me { return Err("cancelled".to_string()); }
            let Some(req) = httpd::read_request(&mut stream).await else { continue };
            if req.path != "/callback" { httpd::respond(&mut stream, 404, &[], b"").await; continue; }
            let code = req.q("code").map(String::from);
            let error = req.q("error").map(String::from);
            if req.q("state") != Some(state_key.as_str()) || (code.is_none() && error.is_none()) {
                httpd::respond(&mut stream, 400, &[], b"").await;
                continue;
            }
            let html = [("Content-Type", "text/html; charset=utf-8")];
            if let Some(e) = error {
                httpd::respond(&mut stream, 200, &html, page("not connected", "you can close this tab and try again in moonlit.").as_bytes()).await;
                return Err(if e == "access_denied" { "you cancelled the Spotify sign-in".to_string() } else { format!("Spotify said: {}", e) });
            }
            let r = http().post(format!("{}/api/token", ACCOUNTS)).form(&[
                ("grant_type", "authorization_code"), ("code", code.as_deref().unwrap_or("")), ("redirect_uri", REDIRECT),
                ("client_id", client_id.as_str()), ("code_verifier", verifier.as_str()),
            ]).send().await;
            let parsed = match r {
                Ok(r) => { let ok = r.status().is_success(); let c = r.status().as_u16(); let d: Value = r.json().await.unwrap_or(Value::Null); (ok, c, d) }
                Err(e) => (false, 0, json!({ "error_description": e.to_string() })),
            };
            if !parsed.0 {
                httpd::respond(&mut stream, 200, &html, page("not connected", "something went wrong. you can close this tab; moonlit says what happened.").as_bytes()).await;
                let d = &parsed.2;
                return Err(d.get("error_description").or_else(|| d.get("error")).and_then(|v| v.as_str()).map(String::from).unwrap_or(format!("Spotify said {}", parsed.1)));
            }
            let d = parsed.2;
            let auth = Auth {
                client_id: client_id.clone(),
                refresh: d.get("refresh_token").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                access: d.get("access_token").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                expires: config::now_ms() + d.get("expires_in").and_then(|v| v.as_f64()).unwrap_or(3600.0) * 1000.0,
            };
            save(&auth);
            with(|s| s.auth = auth);
            httpd::respond(&mut stream, 200, &html, page("connected ♡", "Spotify is connected to moonlit. you can close this tab.").as_bytes()).await;
            return Ok(());
        }
    }).await.unwrap_or(Err("the Spotify sign-in timed out, try again".into()));
    match &result {
        Ok(()) => { set_status("connected", "on"); schedule(0); }
        Err(m) if m == "cancelled" => {}
        Err(m) => set_status(m, "warn"),
    }
    result
}

/* ───────────── what the page asks ───────────── */
#[tauri::command]
pub fn spotify_get() -> Value {
    let (client_id, conn, status, state) = with(|s| (s.auth.client_id.clone(), !s.auth.refresh.is_empty(), s.status.clone(), s.last.clone()));
    let mut local = winmedia::info();
    local["on"] = json!(local_on());
    json!({ "clientId": client_id, "connected": conn, "status": status, "state": if conn { state } else { current() }, "redirect": REDIRECT, "local": local })
}

#[tauri::command]
pub async fn spotify_connect(app: AppHandle, client_id: String) -> Value {
    match connect(app, client_id).await {
        Ok(()) => json!({ "ok": true }),
        Err(m) => json!({ "ok": false, "message": m }),
    }
}

// play / pause / next / previous: the connected account (Premium), or the Spotify app on this PC
#[tauri::command]
pub async fn spotify_control(action: String) -> Value {
    if !connected() {
        return winmedia::control(&action).await;
    }
    let route = match action.as_str() {
        "play" => (reqwest::Method::PUT, "/v1/me/player/play"),
        "pause" => (reqwest::Method::PUT, "/v1/me/player/pause"),
        "next" => (reqwest::Method::POST, "/v1/me/player/next"),
        "previous" => (reqwest::Method::POST, "/v1/me/player/previous"),
        _ => return json!({ "ok": false, "message": "unknown button" }),
    };
    match api(route.0, route.1).await {
        Ok(r) => {
            schedule(400); // show the change straight away
            if r.status().is_success() { return json!({ "ok": true }); }
            let code = r.status().as_u16();
            let d: Value = r.json().await.unwrap_or(Value::Null);
            let reason = d.pointer("/error/reason").and_then(|v| v.as_str()).unwrap_or("");
            if reason == "PREMIUM_REQUIRED" { return json!({ "ok": false, "message": "the Spotify buttons need Spotify Premium" }); }
            if reason == "NO_ACTIVE_DEVICE" || code == 404 { return json!({ "ok": false, "message": "open Spotify and play something first" }); }
            json!({ "ok": false, "message": d.pointer("/error/message").and_then(|v| v.as_str()).map(String::from).unwrap_or(format!("Spotify said {}", code)) })
        }
        Err(Fail::Auth(m)) | Err(Fail::Other(m)) => json!({ "ok": false, "message": m }),
    }
}

#[tauri::command]
pub fn spotify_disconnect() {
    TIMER.fetch_add(1, Ordering::SeqCst);
    let cleared = with(|s| Auth { client_id: s.auth.client_id.clone(), ..Default::default() });
    save(&cleared);
    with(|s| { s.auth = cleared; s.web = Value::Null; s.last = Value::Null; });
    publish_all();
    set_status("not connected", "off");
}

#[tauri::command]
pub fn spotify_local(on: bool) -> Value {
    config::set("spotifyLocal", json!(on));
    if local_on() { winmedia::start() } else { winmedia::stop() }
    let mut i = winmedia::info();
    i["on"] = json!(local_on());
    i
}

#[tauri::command]
pub fn spotify_open(app: AppHandle, url: String) {
    if url.starts_with("https://open.spotify.com/") || url.starts_with("https://developer.spotify.com/") {
        crate::open_url(&app, &url);
    }
}
