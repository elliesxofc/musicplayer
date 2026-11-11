//! The Spotify app on this PC, through Windows' own media controls (Windows 10/11).
//! The Spotify desktop app tells Windows what it's playing (the same info as the media pop-up
//! when you press a media key), and lets Windows press play / pause / skip. moonlit asks
//! Windows directly (the Electron version needed a hidden PowerShell for this), so it works
//! with Spotify Free and needs no setup. Nothing here talks to Spotify's servers.

use crate::{config, emit, overlay, spotify};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

static RUN: AtomicU64 = AtomicU64::new(0);
static ON: AtomicBool = AtomicBool::new(false);
static STATUS: Mutex<Option<Value>> = Mutex::new(None);
static LAST: Mutex<Value> = Mutex::new(Value::Null);

pub fn available() -> bool { cfg!(windows) }

fn set_status(text: &str, kind: &str) {
    let s = json!({ "text": text, "kind": kind });
    {
        let mut g = STATUS.lock().unwrap_or_else(|e| e.into_inner());
        if g.as_ref() == Some(&s) { return; }
        *g = Some(s.clone());
    }
    emit("spotify:local-status", s);
}
fn publish(state: Value) {
    *LAST.lock().unwrap_or_else(|e| e.into_inner()) = state.clone();
    spotify::local_state(state);
}

pub fn info() -> Value {
    let status = STATUS.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or(json!({ "text": "off", "kind": "off" }));
    json!({ "available": available(), "on": ON.load(Ordering::SeqCst), "status": status, "state": LAST.lock().unwrap_or_else(|e| e.into_inner()).clone() })
}

fn id_for(title: &str, artist: &str) -> String {
    let mut h = Sha1::new();
    h.update(format!("{}|{}", title, artist).as_bytes());
    format!("sp:local:{}", h.finalize().iter().take(8).map(|b| format!("{:02x}", b)).collect::<String>())
}

/// what Windows says about the Spotify app, once a second
#[derive(Default)]
struct Seen {
    running: bool,
    title: String,
    artist: String,
    album: String,
    playing: bool,
    duration: f64,
    position: f64,
    updated: f64,
    cover: Option<(String, Vec<u8>)>, // type, bytes (only when the song changed)
}

// Spotify doesn't always tell Windows the song's position, so moonlit keeps its own clock
struct Clock { id: String, base: f64, since: f64, playing: bool }

pub fn start() {
    if !available() || ON.swap(true, Ordering::SeqCst) {
        return;
    }
    let me = RUN.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let off = STATUS.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|s| s["kind"] == "off").unwrap_or(true);
        if off { set_status("looking for the Spotify app…", "wait"); }
    }
    std::thread::spawn(move || {
        let mut clock = Clock { id: String::new(), base: 0.0, since: 0.0, playing: false };
        let mut covers: VecDeque<(String, String)> = VecDeque::new(); // id → data: URL, for the mini player
        let mut last_key = String::new();
        let mut fails = 0u32;
        #[cfg(windows)]
        let mut session = native::Watcher::new();
        while RUN.load(Ordering::SeqCst) == me {
            #[cfg(windows)]
            let seen = session.read(&mut last_key);
            #[cfg(not(windows))]
            let seen: Result<Seen, String> = { let _ = &mut last_key; Err("not on Windows".into()) };
            match seen {
                Ok(s) => { fails = 0; handle(s, &mut clock, &mut covers); }
                Err(e) => {
                    fails += 1;
                    if fails >= 3 {
                        set_status(&format!("Windows' media controls aren't available here ({})", e.chars().take(160).collect::<String>()), "warn");
                        publish(Value::Null);
                    }
                    #[cfg(windows)]
                    { session = native::Watcher::new(); }
                    if fails >= 3 { std::thread::sleep(std::time::Duration::from_secs(60)); continue; }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(1000));
        }
    });
}

fn handle(msg: Seen, clock: &mut Clock, covers: &mut VecDeque<(String, String)>) {
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    if let Some((kind, bytes)) = &msg.cover {
        let id = id_for(&msg.title, &msg.artist);
        let kind = if kind.starts_with("image/") { kind.clone() } else { "image/png".into() };
        covers.retain(|c| c.0 != id);
        covers.push_back((id.clone(), format!("data:{};base64,{}", kind, B64.encode(bytes))));
        while covers.len() > 4 { covers.pop_front(); }
        overlay::get().set_cover(&id, &kind, Some(bytes.clone()));
    }
    if !msg.running {
        set_status("open the Spotify app on this PC and play something", "wait");
        return publish(Value::Null);
    }
    if msg.title.is_empty() {
        set_status("the Spotify app is open, nothing playing yet", "wait");
        return publish(Value::Null);
    }
    let id = id_for(&msg.title, &msg.artist);
    let now = config::now_ms();
    if clock.id != id { *clock = Clock { id: id.clone(), base: 0.0, since: now, playing: msg.playing }; }
    if clock.playing != msg.playing {
        if clock.playing { clock.base += (now - clock.since) / 1000.0; }
        clock.since = now;
        clock.playing = msg.playing;
    }
    let own = clock.base + if msg.playing { (now - clock.since) / 1000.0 } else { 0.0 };
    let duration = if msg.duration > 1.0 { msg.duration } else { 0.0 };
    let mut position = own;
    if duration > 0.0 && msg.updated > 0.0 {
        position = msg.position + if msg.playing { (now - msg.updated).max(0.0) / 1000.0 } else { 0.0 };
        if position > duration + 2.0 { position = own; } // stale timeline: fall back to our clock
    }
    if duration > 0.0 { position = position.min(duration); }
    set_status(if msg.playing { "showing the Spotify app on this PC ✓" } else { "the Spotify app is paused" }, "on");
    let cover = covers.iter().find(|c| c.0 == id).map(|c| c.1.clone()).unwrap_or_default();
    publish(json!({
        "id": id, "title": msg.title, "artist": msg.artist, "album": msg.album, "duration": duration, "position": position,
        "playing": msg.playing, "cover": cover, "url": "", "device": "this PC", "at": now, "local": true,
    }));
}

pub fn stop() {
    ON.store(false, Ordering::SeqCst);
    RUN.fetch_add(1, Ordering::SeqCst);
    publish(Value::Null);
    set_status("off", "off");
}

// play / pause / next / previous on the Spotify app (works with Spotify Free)
pub async fn control(action: &str) -> Value {
    if !["play", "pause", "next", "previous"].contains(&action) {
        return json!({ "ok": false, "message": "unknown button" });
    }
    #[cfg(windows)]
    {
        let action = action.to_string();
        let r = tokio::task::spawn_blocking(move || native::press(&action)).await.unwrap_or(Err("the Spotify app didn't answer".into()));
        return match r {
            Ok(true) => json!({ "ok": true }),
            Ok(false) => json!({ "ok": false, "message": "the Spotify app didn't take that button right now" }),
            Err(m) => json!({ "ok": false, "message": m }),
        };
    }
    #[cfg(not(windows))]
    json!({ "ok": false, "message": "open the Spotify app first" })
}

#[cfg(windows)]
mod native {
    use super::Seen;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session, GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Storage::Streams::DataReader;

    // 100-nanosecond steps since 1601 → milliseconds since 1970
    fn unix_ms(universal: i64) -> f64 { ((universal - 116_444_736_000_000_000) / 10_000) as f64 }

    fn init_thread() {
        unsafe { let _ = windows::Win32::System::WinRT::RoInitialize(windows::Win32::System::WinRT::RO_INIT_MULTITHREADED); }
    }

    fn manager() -> Result<Manager, String> {
        init_thread();
        Manager::RequestAsync().and_then(|op| op.get()).map_err(|e| e.message().to_string())
    }

    fn find(m: &Manager) -> Result<Option<Session>, String> {
        let sessions = m.GetSessions().map_err(|e| e.message().to_string())?;
        for s in sessions {
            let id = s.SourceAppUserModelId().map(|h| h.to_string()).unwrap_or_default();
            if id.to_lowercase().contains("spotify") { return Ok(Some(s)); }
        }
        Ok(None)
    }

    pub struct Watcher { manager: Option<Manager> }
    impl Watcher {
        pub fn new() -> Self { Watcher { manager: None } }
        pub fn read(&mut self, last_key: &mut String) -> Result<Seen, String> {
            if self.manager.is_none() { self.manager = Some(manager()?); }
            let m = self.manager.as_ref().unwrap();
            let Some(s) = find(m)? else { return Ok(Seen::default()) };
            let e = |e: windows::core::Error| e.message().to_string();
            let props = s.TryGetMediaPropertiesAsync().and_then(|op| op.get()).map_err(e)?;
            let playback = s.GetPlaybackInfo().map_err(e)?;
            let timeline = s.GetTimelineProperties().map_err(e)?;
            let title = props.Title().map(|h| h.to_string()).unwrap_or_default();
            let artist = props.Artist().map(|h| h.to_string()).unwrap_or_default();
            let mut seen = Seen {
                running: true,
                album: props.AlbumTitle().map(|h| h.to_string()).unwrap_or_default(),
                playing: playback.PlaybackStatus().map(|st| st == Status::Playing).unwrap_or(false),
                duration: timeline.EndTime().map(|t| t.Duration as f64 / 10_000_000.0).unwrap_or(0.0),
                position: timeline.Position().map(|t| t.Duration as f64 / 10_000_000.0).unwrap_or(0.0),
                updated: timeline.LastUpdatedTime().map(|t| unix_ms(t.UniversalTime)).unwrap_or(0.0),
                title: title.clone(),
                artist: artist.clone(),
                cover: None,
            };
            let key = format!("{}|{}", title, artist);
            if &key != last_key {
                if let Ok(thumb) = props.Thumbnail() {
                    *last_key = key;
                    let read = || -> windows::core::Result<(String, Vec<u8>)> {
                        let stream = thumb.OpenReadAsync()?.get()?;
                        let size = stream.Size()? as u32;
                        let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0)?)?;
                        reader.LoadAsync(size)?.get()?;
                        let mut bytes = vec![0u8; size as usize];
                        reader.ReadBytes(&mut bytes)?;
                        Ok((stream.ContentType()?.to_string(), bytes))
                    };
                    seen.cover = read().ok();
                }
            }
            Ok(seen)
        }
    }

    pub fn press(action: &str) -> Result<bool, String> {
        let m = manager()?;
        let Some(s) = find(&m)? else { return Err("open the Spotify app first".into()) };
        let r = match action {
            "play" => s.TryPlayAsync(),
            "pause" => s.TryPauseAsync(),
            "next" => s.TrySkipNextAsync(),
            _ => s.TrySkipPreviousAsync(),
        };
        r.and_then(|op| op.get()).map_err(|e| e.message().to_string())
    }
}
