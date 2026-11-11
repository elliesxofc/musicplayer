//! !nowplaying and song requests in YouTube live chat.
//! moonlit reads your stream's chat and a bot account answers "!nowplaying" with what's
//! playing, the same song the OBS overlay shows. Give it your channel (@handle or channel
//! link) and it finds your live stream by itself every time you go live, or give it one
//! stream's link. (This talks to YouTube the way the masterchat library did for the
//! Electron version: the same requests, now written in Rust.)

use crate::{config, emit, overlay, secrets};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use regex::Regex;
use serde_json::{json, Map, Value};
use sha1::{Digest, Sha1};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

const REPLY_GAP_MS: f64 = 5000.0; // one answer every 5 seconds at most, however many people ask
const RETRY: Duration = Duration::from_secs(60);
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
// what masterchat sends to YouTube's chat API
const API_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.93 Safari/537.36";
const ORIGIN: &str = "https://www.youtube.com";
const KEY: &str = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const CLIENT_VERSION: &str = "2.20211014.05.00";

/* ───────────── what the user typed ───────────── */
#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    Channel(String), // a path like "/@name" or "/channel/UC…"
    Video(String),
}

fn is_video_id(s: &str) -> bool {
    s.len() == 11 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub fn parse_target(input: &str) -> Option<Target> {
    let s = input.trim();
    if s.is_empty() {
        return None;
    }
    if Regex::new(r"^@[\w.\-·]{3,100}$").unwrap().is_match(s) {
        return Some(Target::Channel(format!("/{}", s)));
    }
    if Regex::new(r"^UC[\w-]{22}$").unwrap().is_match(s) {
        return Some(Target::Channel(format!("/channel/{}", s)));
    }
    if is_video_id(s) {
        return Some(Target::Video(s.to_string()));
    }
    let with_scheme = if Regex::new(r"(?i)^[a-z]+://").unwrap().is_match(s) { s.to_string() } else { format!("https://{}", s) };
    let url = url::Url::parse(&with_scheme).ok()?;
    let host = url.host_str()?.trim_start_matches("www.").trim_start_matches("m.").to_string();
    let parts: Vec<String> = url.path().split('/').filter(|p| !p.is_empty()).map(|p| urlencoding::decode(p).map(|c| c.into_owned()).unwrap_or_else(|_| p.to_string())).collect();
    let part = |i: usize| parts.get(i).map(|s| s.as_str()).unwrap_or("");
    if host == "youtu.be" && is_video_id(part(0)) {
        return Some(Target::Video(part(0).into()));
    }
    if host != "youtube.com" && host != "studio.youtube.com" {
        return None;
    }
    if let Some(v) = url.query_pairs().find(|(k, _)| k == "v").map(|(_, v)| v.to_string()) {
        if is_video_id(&v) {
            return Some(Target::Video(v));
        }
    }
    if ["live", "shorts", "embed"].contains(&part(0)) && is_video_id(part(1)) {
        return Some(Target::Video(part(1).into()));
    }
    // studio.youtube.com/video/ID/livestreaming
    if part(0) == "video" && is_video_id(part(1)) {
        return Some(Target::Video(part(1).into()));
    }
    if part(0).starts_with('@') {
        return Some(Target::Channel(format!("/{}", part(0))));
    }
    if ["channel", "c", "user"].contains(&part(0)) && !part(1).is_empty() {
        return Some(Target::Channel(format!("/{}/{}", part(0), part(1))));
    }
    None
}

// youtube.com/<channel>/live shows the live stream's page while you're live, and the channel
// (or an upcoming stream) otherwise.
pub fn live_id_from_page(html: &str) -> Option<String> {
    let canon = Regex::new(r#"<link rel="canonical" href="https://www\.youtube\.com/watch\?v=([\w-]{11})""#).unwrap();
    let id = canon.captures(html)?.get(1)?.as_str().to_string();
    html.contains(r#""isLiveNow":true"#).then_some(id)
}

// when a live stream started, from its watch page
pub fn live_start_from_page(html: &str) -> f64 {
    let a = Regex::new(r#""liveBroadcastDetails":\{[^}]*"startTimestamp":"([^"]+)""#).unwrap();
    let b = Regex::new(r#""startTimestamp":"([^"]+)""#).unwrap();
    let m = a.captures(html).or_else(|| b.captures(html)).and_then(|c| c.get(1)).map(|m| m.as_str().to_string());
    m.and_then(|s| parse_iso_ms(&s)).unwrap_or(0.0)
}

/// "2026-11-03T20:15:04+00:00" → milliseconds since 1970
pub fn parse_iso_ms(s: &str) -> Option<f64> {
    let re = Regex::new(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):?(\d{2}))?$").unwrap();
    let c = re.captures(s.trim())?;
    let n = |i: usize| c.get(i).map(|m| m.as_str().parse::<i64>().unwrap_or(0)).unwrap_or(0);
    let (y, mo, d) = (n(1), n(2), n(3));
    // days from civil (Howard Hinnant)
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let mut secs = days * 86400 + n(4) * 3600 + n(5) * 60 + n(6);
    if c.get(9).is_some() {
        let off = n(10) * 3600 + n(11) * 60;
        secs -= if c.get(9).unwrap().as_str() == "-" { -off } else { off };
    }
    let frac = c.get(7).map(|m| format!("0.{}", m.as_str()).parse::<f64>().unwrap_or(0.0)).unwrap_or(0.0);
    Some(secs as f64 * 1000.0 + (frac * 1000.0).round())
}

// The bot login: the bot account's YouTube cookies as base64-encoded JSON (the same value the
// song request app uses). Quotes, line breaks or the plain JSON are fine too.
const COOKIES: [&str; 5] = ["SAPISID", "APISID", "HSID", "SID", "SSID"];
pub fn parse_login(raw: &str) -> Result<Map<String, Value>, String> {
    let mut text = raw.trim().to_string();
    if text.len() >= 2 && ((text.starts_with('"') && text.ends_with('"')) || (text.starts_with('\'') && text.ends_with('\''))) {
        text = text[1..text.len() - 1].trim().to_string();
    }
    let json_text = if text.starts_with('{') {
        Some(text.clone())
    } else {
        let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
        B64.decode(compact.trim_end_matches('=').to_string() + &"=".repeat((4 - compact.trim_end_matches('=').len() % 4) % 4))
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
    };
    let parsed = json_text
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .ok_or("the bot login isn't the line PowerShell printed, or it was cut off")?;
    let missing: Vec<&str> = COOKIES.iter().copied().filter(|k| parsed.get(*k).and_then(|v| v.as_str()).map(|s| s.is_empty()).unwrap_or(true)).collect();
    if !missing.is_empty() {
        return Err(format!("the bot login is missing {}", missing.join(", ")));
    }
    Ok(parsed)
}

fn clock(s: f64) -> String {
    let s = s.max(0.0).floor() as i64;
    let (h, m, x) = (s / 3600, (s % 3600) / 60, s % 60);
    if h > 0 { format!("{}:{:02}:{:02}", h, m, x) } else { format!("{}:{:02}", m, x) }
}

// The answer, e.g. "🎵 now playing: Artist - Title (1:23 / 3:45)". YouTube allows 200 characters.
pub fn reply_for(np: &Map<String, Value>) -> String {
    let has_id = np.get("id").map(|v| !v.is_null() && v.as_str() != Some("")).unwrap_or(false);
    if !has_id {
        return "nothing is playing right now".into();
    }
    let s = |k: &str| np.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let f = |k: &str| np.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
    // plain "Artist - Title": the OBS format may already have its own emoji or words around it
    let joined = [s("artist"), s("title")].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" - ");
    let song = if !joined.is_empty() { joined } else if !s("line").is_empty() { s("line") } else { "a song".into() };
    let (dur, pos) = (f("duration"), f("position"));
    let time = if dur > 0.0 { format!(" ({} / {})", clock(pos), clock(dur)) } else if pos >= 1.0 { format!(" ({})", clock(pos)) } else { String::new() };
    let wher = if s("source") == "spotify" { " on Spotify" } else { "" };
    let state = if np.get("playing").and_then(|v| v.as_bool()).unwrap_or(false) { "" } else { " (paused)" };
    let tail = format!("{}{}{}", time, wher, state);
    let head = "🎵 now playing: ";
    // (lengths in UTF-16 units, like YouTube and the JavaScript version count them)
    let u16len = |t: &str| t.encode_utf16().count();
    let room = 200usize.saturating_sub(u16len(head) + u16len(&tail));
    let song = if u16len(&song) > room {
        let mut out = String::new();
        for ch in song.chars() {
            if u16len(&out) + ch.len_utf16() > room.saturating_sub(1) { break; }
            out.push(ch);
        }
        out + "…"
    } else { song };
    format!("{}{}{}", head, song, tail)
}

// YouTube allows 200 characters per message: longer answers go out in parts, split between words
pub fn split_message(text: &str, max: usize) -> Vec<String> {
    let mut parts = Vec::new();
    let mut rest: Vec<char> = text.trim().chars().collect();
    while rest.len() > max {
        let upto = max.min(rest.len() - 1);
        let mut cut = rest[..=upto].iter().rposition(|&c| c == ' ').unwrap_or(0);
        if cut * 2 < max {
            cut = max;
        }
        parts.push(rest[..cut].iter().collect::<String>().trim().to_string());
        rest = rest[cut..].iter().collect::<String>().trim().chars().collect();
    }
    let last: String = rest.into_iter().collect();
    if !last.is_empty() {
        parts.push(last);
    }
    parts
}

/* ───────────── YouTube's chat API (the requests masterchat makes) ───────────── */
fn varint(mut n: u64) -> Vec<u8> {
    let mut out = Vec::new();
    while n >= 0x80 {
        out.push((n as u8 & 0x7f) | 0x80);
        n >>= 7;
    }
    out.push(n as u8);
    out
}
fn ld(fid: u64, payload: &[u8]) -> Vec<u8> {
    let mut v = varint((fid << 3) | 2);
    v.extend(varint(payload.len() as u64));
    v.extend_from_slice(payload);
    v
}
fn vt(fid: u64, n: u64) -> Vec<u8> {
    let mut v = varint(fid << 3);
    v.extend(varint(n));
    v
}
fn cat(parts: &[Vec<u8>]) -> Vec<u8> {
    parts.concat()
}
fn cv_token(channel: &str, video: &str) -> Vec<u8> {
    ld(5, &cat(&[ld(1, channel.as_bytes()), ld(2, video.as_bytes())]))
}
fn uri_b64(bytes: &[u8]) -> String {
    urlencoding::encode(&B64.encode(bytes)).into_owned()
}
fn live_reload_continuation(channel: &str, video: &str) -> String {
    let hdt = B64.encode(cat(&[ld(1, &cv_token(channel, video)), ld(3, &ld(48687757, &ld(1, video.as_bytes()))), vt(4, 1)]));
    uri_b64(&ld(119693434, &cat(&[ld(3, hdt.as_bytes()), vt(6, 1), ld(16, &vt(1, 1))])))
}
fn send_message_params(channel: &str, video: &str) -> String {
    let b1 = uri_b64(&cat(&[ld(1, &cv_token(channel, video)), vt(2, 2), vt(3, 4)]));
    B64.encode(b1.as_bytes())
}

fn auth_headers(creds: &Map<String, Value>) -> Vec<(String, String)> {
    let get = |k: &str| creds.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let cookie = creds.iter().map(|(k, v)| format!("{}={};", k, v.as_str().map(String::from).unwrap_or_else(|| v.to_string()))).collect::<Vec<_>>().join(" ");
    let now = (crate::config::now_ms() / 1000.0).floor() as i64;
    let mut h = Sha1::new();
    h.update(format!("{} {} {}", now, get("SAPISID"), ORIGIN).as_bytes());
    let digest: String = h.finalize().iter().map(|b| format!("{:02x}", b)).collect();
    let mut out = vec![
        ("Cookie".into(), cookie),
        ("Authorization".into(), format!("SAPISIDHASH {}_{}", now, digest)),
        ("X-Origin".into(), ORIGIN.into()),
        ("X-Goog-AuthUser".into(), "0".into()),
    ];
    let dsid = if !get("DELEGATED_SESSION_ID").is_empty() { get("DELEGATED_SESSION_ID") } else { get("SESSION_ID") };
    if !dsid.is_empty() {
        out.push(("X-Goog-PageId".into(), dsid));
    }
    out
}

pub fn http() -> reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| reqwest::Client::builder().timeout(Duration::from_secs(20)).build().unwrap_or_default()).clone()
}

pub async fn youtube_page(url: &str) -> Result<(u16, String), String> {
    let r = http().get(url)
        .header("User-Agent", UA)
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Cookie", "SOCS=CAI; CONSENT=YES+1")
        .send().await.map_err(|e| e.to_string())?;
    let code = r.status().as_u16();
    Ok((code, r.text().await.map_err(|e| e.to_string())?))
}

async fn post(path: &str, body: Value, creds: &Map<String, Value>) -> Result<Value, String> {
    let mut req = http().post(format!("{}{}?key={}", ORIGIN, path, KEY))
        .header("Content-Type", "application/json")
        .header("Accept-Language", "en")
        .header("User-Agent", API_UA);
    for (k, v) in auth_headers(creds) {
        req = req.header(k, v);
    }
    let mut body = body;
    body["context"] = json!({ "client": { "clientName": "WEB", "clientVersion": CLIENT_VERSION } });
    let r = req.json(&body).send().await.map_err(|e| if e.is_timeout() { "YouTube took too long".to_string() } else { e.to_string() })?;
    let ok = r.status().is_success();
    let v: Value = r.json().await.unwrap_or(Value::Null);
    if !ok {
        let msg = v.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("YouTube said no").to_string();
        return Err(msg);
    }
    Ok(v)
}

fn runs_text(v: &Value) -> String {
    if let Some(s) = v.as_str() {
        return s.to_string();
    }
    if let Some(s) = v.get("simpleText").and_then(|s| s.as_str()) {
        return s.to_string();
    }
    let runs = v.get("runs").or(Some(v)).and_then(|r| r.as_array()).cloned().unwrap_or_default();
    runs.iter().map(|r| {
        if let Some(t) = r.get("text").and_then(|t| t.as_str()) {
            t.to_string()
        } else if let Some(e) = r.get("emoji") {
            if e.get("isCustomEmoji").and_then(|b| b.as_bool()).unwrap_or(false) {
                e.get("shortcuts").and_then(|s| s.as_array()).and_then(|a| a.last()).and_then(|s| s.as_str()).unwrap_or("").to_string()
            } else {
                e.get("emojiId").and_then(|s| s.as_str()).unwrap_or("").to_string()
            }
        } else {
            String::new()
        }
    }).collect()
}

struct Joined {
    video: String,
    channel: String,
    title: String,
}

/// the watch page: the stream's title and its channel (needed for the chat requests)
async fn video_info(video: &str, creds: &Map<String, Value>) -> Result<Joined, String> {
    let mut req = http().get(format!("{}/watch?v={}", ORIGIN, video)).header("Accept-Language", "en").header("User-Agent", API_UA);
    for (k, v) in auth_headers(creds) {
        req = req.header(k, v);
    }
    let html = req.send().await.map_err(|e| e.to_string())?.text().await.map_err(|e| e.to_string())?;
    let details = Regex::new(r#""videoDetails":\{(.{0,6000}?)"thumbnail""#).unwrap().captures(&html).map(|c| c[1].to_string()).unwrap_or_default();
    let channel = Regex::new(r#""channelId":"(UC[\w-]{22})""#).unwrap().captures(&details)
        .or_else(|| Regex::new(r#""channelId":"(UC[\w-]{22})""#).unwrap().captures(&html))
        .map(|c| c[1].to_string())
        .ok_or("that stream wasn't found")?;
    let title = Regex::new(r#""title":"((?:[^"\\]|\\.)*)""#).unwrap().captures(&details)
        .and_then(|c| serde_json::from_str::<String>(&format!("\"{}\"", &c[1])).ok())
        .unwrap_or_default();
    if html.contains(r#""playabilityStatus":{"status":"ERROR""#) || html.contains(r#""playabilityStatus":{"status":"LOGIN_REQUIRED""#) {
        return Err("that stream isn't available".into());
    }
    Ok(Joined { video: video.to_string(), channel, title })
}

/* ───────────── the bot ───────────── */
struct Bot {
    run: AtomicU64,
    status: Mutex<Value>,
    joined: Mutex<Option<(String, String)>>, // (channel, video) of the chat moonlit is in
    creds: Mutex<Map<String, Value>>,
    last_reply: Mutex<f64>,
    start_cache: Mutex<(String, f64)>,
}

fn bot() -> Arc<Bot> {
    static B: OnceLock<Arc<Bot>> = OnceLock::new();
    B.get_or_init(|| Arc::new(Bot {
        run: AtomicU64::new(0),
        status: Mutex::new(json!({ "text": "off", "kind": "off" })),
        joined: Mutex::new(None),
        creds: Mutex::new(Map::new()),
        last_reply: Mutex::new(0.0),
        start_cache: Mutex::new((String::new(), 0.0)),
    })).clone()
}

fn set_status(text: &str, kind: &str) {
    let s = json!({ "text": text, "kind": kind });
    *bot().status.lock().unwrap_or_else(|e| e.into_inner()) = s.clone();
    emit("chat:status", s);
}
fn current(me: u64) -> bool {
    bot().run.load(Ordering::SeqCst) == me
}

fn settings() -> (bool, String, String) {
    let c = config::get("chat");
    let enabled = c.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
    let stream = c.get("stream").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let login = secrets::unseal(c.get("login").unwrap_or(&Value::Null));
    (enabled, stream, login)
}

pub fn start_saved() {
    let (enabled, stream, login) = settings();
    start(enabled, &stream, &login);
}

fn stop() -> u64 {
    *bot().joined.lock().unwrap_or_else(|e| e.into_inner()) = None;
    bot().run.fetch_add(1, Ordering::SeqCst) + 1
}

fn start(enabled: bool, stream: &str, login: &str) {
    let me = stop();
    if !enabled {
        return set_status("off", "off");
    }
    let Some(target) = parse_target(stream) else { return set_status("add your channel (like @yourname) or a stream link", "warn") };
    if login.is_empty() {
        return set_status("add the bot login, so the bot can answer in chat", "warn");
    }
    match parse_login(login) {
        Ok(c) => *bot().creds.lock().unwrap_or_else(|e| e.into_inner()) = c,
        Err(e) => return set_status(&e, "warn"),
    }
    tauri::async_runtime::spawn(async move { keep_connected(me, target).await });
}

async fn keep_connected(me: u64, target: Target) {
    loop {
        if !current(me) {
            return;
        }
        let again = connect(me, &target).await;
        if !current(me) || !again {
            return;
        }
        tokio::time::sleep(RETRY).await;
    }
}

/// Joins the chat and answers until it ends. Returns whether to try again in a minute.
async fn connect(me: u64, target: &Target) -> bool {
    let creds = bot().creds.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let video = match target {
        Target::Video(v) => v.clone(),
        Target::Channel(path) => {
            set_status("looking for your live stream…", "wait");
            match youtube_page(&format!("{}{}/live", ORIGIN, path)).await {
                Ok((404, _)) => { if current(me) { set_status("couldn't join the chat (that channel wasn't found), trying again in a minute", "warn"); } return true; }
                Ok((_, html)) => match live_id_from_page(&html) {
                    Some(v) => v,
                    None => { if current(me) { set_status("waiting for you to go live (checks every minute)", "wait"); } return true; }
                },
                Err(e) => { if current(me) { set_status(&format!("couldn't join the chat ({}), trying again in a minute", e), "warn"); } return true; }
            }
        }
    };
    if !current(me) { return false; }
    let joined = match video_info(&video, &creds).await {
        Ok(j) => j,
        Err(e) => { if current(me) { set_status(&format!("couldn't join the chat ({}), trying again in a minute", e), "warn"); } return true; }
    };
    if !current(me) { return false; }
    *bot().joined.lock().unwrap_or_else(|e| e.into_inner()) = Some((joined.channel.clone(), joined.video.clone()));
    let title = if joined.title.is_empty() { "your stream".to_string() } else { joined.title.clone() };
    set_status(&format!("answering !nowplaying in “{}”", title), "on");

    let mut token = live_reload_continuation(&joined.channel, &joined.video);
    let mut first = true;
    let mut failures = 0;
    loop {
        if !current(me) { return false; }
        let started = std::time::Instant::now();
        let res = post("/youtubei/v1/live_chat/get_live_chat", json!({ "continuation": token }), &creds).await;
        if !current(me) { return false; }
        let payload = match res {
            Ok(p) => { failures = 0; p }
            Err(e) => {
                failures += 1;
                if failures <= 3 { tokio::time::sleep(Duration::from_secs(1)).await; continue; }
                *bot().joined.lock().unwrap_or_else(|e| e.into_inner()) = None;
                set_status(&format!("lost the chat ({}), trying again in a minute", e), "warn");
                return true;
            }
        };
        let Some(cc) = payload.pointer("/continuationContents/liveChatContinuation") else {
            // the stream ended (or the chat was turned off)
            *bot().joined.lock().unwrap_or_else(|e| e.into_inner()) = None;
            if let Some(reason) = payload.pointer("/contents/messageRenderer/text") {
                let r = runs_text(reason);
                if !r.is_empty() && !matches!(target, Target::Channel(_)) {
                    set_status(&format!("couldn't join the chat ({}), trying again in a minute", r), "warn");
                    return true;
                }
            }
            match target {
                Target::Channel(_) => { set_status("your stream ended, waiting for the next one", "wait"); return true; }
                Target::Video(_) => { set_status("that stream has ended. use your channel instead, so moonlit finds the next one", "warn"); return false; }
            }
        };
        if !first {
            for a in cc.get("actions").and_then(|a| a.as_array()).cloned().unwrap_or_default() {
                if let Some(item) = a.pointer("/addChatItemAction/item/liveChatTextMessageRenderer") {
                    answer(item).await;
                }
            }
        }
        first = false;
        let next = cc.get("continuations").and_then(|c| c.as_array()).and_then(|a| a.first()).and_then(|c| c.as_object()).and_then(|o| o.values().next()).cloned();
        let Some(next) = next.filter(|n| n.get("continuation").is_some()) else {
            *bot().joined.lock().unwrap_or_else(|e| e.into_inner()) = None;
            match target {
                Target::Channel(_) => { set_status("your stream ended, waiting for the next one", "wait"); return true; }
                Target::Video(_) => { set_status("that stream has ended. use your channel instead, so moonlit finds the next one", "warn"); return false; }
            }
        };
        token = next.get("continuation").and_then(|c| c.as_str()).unwrap_or("").to_string();
        let wait = next.get("timeoutMs").and_then(|t| t.as_u64()).unwrap_or(5000) as i64 - started.elapsed().as_millis() as i64;
        if wait > 500 {
            tokio::time::sleep(Duration::from_millis(wait as u64)).await;
        }
    }
}

fn request_command() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?is)^!(sr|songrequest|queue|q|skip|wrongsong|uptime|aboutme)(?:\s+(.*))?$").unwrap())
}

async fn answer(item: &Value) {
    let text = runs_text(item.get("message").unwrap_or(&Value::Null)).trim().to_string();
    let badges: Vec<String> = item.get("authorBadges").and_then(|b| b.as_array()).cloned().unwrap_or_default().iter()
        .filter_map(|b| b.pointer("/liveChatAuthorBadgeRenderer/icon/iconType").and_then(|t| t.as_str()).map(String::from)).collect();
    if let Some(c) = request_command().captures(&text) {
        // song requests, !uptime and !aboutme: handled by the player (it knows the library, the queue and OBS)
        let cmd = c[1].to_lowercase();
        let cmd = match cmd.as_str() { "songrequest" => "sr".to_string(), "q" => "queue".to_string(), _ => cmd };
        let args: String = c.get(2).map(|m| m.as_str().trim()).unwrap_or("").chars().take(300).collect();
        emit("chat:command", json!({
            "cmd": cmd, "args": args,
            "user": {
                "id": item.get("authorExternalChannelId").and_then(|v| v.as_str()).unwrap_or(""),
                "name": item.get("authorName").map(runs_text).filter(|s| !s.is_empty()).unwrap_or_else(|| "someone".into()),
                "mod": badges.iter().any(|b| b == "MODERATOR"),
                "owner": badges.iter().any(|b| b == "OWNER"),
            }
        }));
        return;
    }
    // only !nowplaying: shorter names like !song are often taken by other bots (Nightbot, …)
    let lower = text.to_lowercase();
    if !lower.starts_with("!nowplaying") || lower[11..].chars().next().map(|c| c.is_ascii_alphanumeric() || c == '_').unwrap_or(false) {
        return;
    }
    let now = crate::config::now_ms();
    {
        let b = bot();
        let mut last = b.last_reply.lock().unwrap_or_else(|e| e.into_inner());
        if now - *last < REPLY_GAP_MS { return; }
        *last = now;
    }
    send(reply_for(&overlay::get().now())).await;
}

async fn send(text: String) {
    let Some((channel, video)) = bot().joined.lock().unwrap_or_else(|e| e.into_inner()).clone() else { return };
    let creds = bot().creds.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let body = json!({ "richMessage": { "textSegments": [{ "text": text }] }, "params": send_message_params(&channel, &video) });
    let res = post("/youtubei/v1/live_chat/send_message", body, &creds).await;
    let err = match res {
        Ok(v) if v.get("timeoutDurationUsec").is_some() => Some("the bot is in a timeout".to_string()),
        Ok(v) if v.pointer("/actions/0/addChatItemAction/item/liveChatTextMessageRenderer").is_none() => Some("YouTube didn't take the message".to_string()),
        Ok(_) => None,
        Err(e) => Some(e),
    };
    if let Some(e) = err {
        set_status(&format!("couldn't answer in chat ({}). check the bot login", e), "warn");
    }
}

/* ───────────── what the page asks ───────────── */
#[tauri::command]
pub fn chat_get() -> Value {
    let (enabled, stream, login) = settings();
    json!({ "enabled": enabled, "stream": stream, "hasLogin": !login.is_empty(), "status": bot().status.lock().unwrap_or_else(|e| e.into_inner()).clone() })
}

// login: a new value to save, '' to forget it, or left out to keep the saved one
#[tauri::command]
pub fn chat_set(next: Value) -> Value {
    if !next.is_object() {
        return Value::Null;
    }
    let mut c = config::get("chat");
    if !c.is_object() { c = json!({}); }
    if let Some(b) = next.get("enabled").and_then(|v| v.as_bool()) { c["enabled"] = json!(b); }
    if let Some(s) = next.get("stream").and_then(|v| v.as_str()) { c["stream"] = json!(s.trim().chars().take(300).collect::<String>()); }
    if let Some(s) = next.get("login").and_then(|v| v.as_str()) { c["login"] = secrets::seal(s.trim()); }
    config::set("chat", c);
    start_saved();
    bot().status.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[tauri::command]
pub fn chat_preview() -> String {
    reply_for(&overlay::get().now())
}

// an answer from the player (song requests), split into 200-character messages
#[tauri::command]
pub async fn chat_say(text: String) {
    let text: String = text.chars().take(1000).collect();
    for part in split_message(&text, 200) {
        send(part).await;
    }
}

// when the stream moonlit's chat is in went live (ms), or 0 when that isn't known
#[tauri::command]
pub async fn chat_live_start() -> f64 {
    let Some((_, video)) = bot().joined.lock().unwrap_or_else(|e| e.into_inner()).clone() else { return 0.0 };
    {
        let b = bot();
        let c = b.start_cache.lock().unwrap_or_else(|e| e.into_inner());
        if c.0 == video && c.1 > 0.0 { return c.1; }
    }
    let at = youtube_page(&format!("{}/watch?v={}", ORIGIN, video)).await.map(|(_, h)| live_start_from_page(&h)).unwrap_or(0.0);
    if at > 0.0 {
        *bot().start_cache.lock().unwrap_or_else(|e| e.into_inner()) = (video, at);
    }
    at
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn targets() {
        assert_eq!(parse_target("@lilianax"), Some(Target::Channel("/@lilianax".into())));
        assert_eq!(parse_target("https://youtu.be/dQw4w9WgXcQ"), Some(Target::Video("dQw4w9WgXcQ".into())));
        assert_eq!(parse_target("youtube.com/watch?v=dQw4w9WgXcQ&t=3"), Some(Target::Video("dQw4w9WgXcQ".into())));
        assert_eq!(parse_target("https://studio.youtube.com/video/dQw4w9WgXcQ/livestreaming"), Some(Target::Video("dQw4w9WgXcQ".into())));
        assert_eq!(parse_target("https://www.youtube.com/channel/UC_aEa8K-EOJ3D6gOs7HcyNg"), Some(Target::Channel("/channel/UC_aEa8K-EOJ3D6gOs7HcyNg".into())));
        assert_eq!(parse_target("https://example.com/x"), None);
    }
    #[test]
    fn iso() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:01+00:00"), Some(1000.0));
        assert_eq!(parse_iso_ms("2026-11-03T20:15:04Z"), Some(1793736904000.0));
    }
    #[test]
    fn same_requests_as_masterchat() {
        let (c, v) = ("UC_aEa8K-EOJ3D6gOs7HcyNg", "dQw4w9WgXcQ");
        assert_eq!(live_reload_continuation(c, v), "0ofMyANhGlhDaWtxSndvWVZVTmZZVVZoT0VzdFJVOUtNMFEyWjA5ek4waGplVTVuRWd0a1VYYzBkemxYWjFoalVSb1Q2cWpkdVFFTkNndGtVWGMwZHpsWFoxaGpVU0FCMAGCAQIIAQ%3D%3D");
        assert_eq!(send_message_params(c, v), "Q2lrcUp3b1lWVU5mWVVWaE9Fc3RSVTlLTTBRMlowOXpOMGhqZVU1bkVndGtVWGMwZHpsWFoxaGpVUkFDR0FRJTNE");
    }
    #[test]
    fn split() {
        let t = "word ".repeat(100);
        let p = split_message(&t, 200);
        assert!(p.iter().all(|x| x.chars().count() <= 200));
        assert_eq!(p.join(" "), t.trim());
    }
}
