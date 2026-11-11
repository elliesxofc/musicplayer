//! moonlit in the system tray (Windows: the hidden icons behind the ^ next to the clock),
//! and a Windows notification when a new song starts.
//!
//! With "keep moonlit in the tray" on, closing or minimising the window hides it from the
//! taskbar instead of quitting, and the music keeps playing. Clicking the tray icon brings
//! it back; right-clicking gives play/pause, next, previous and quit.

use crate::{app, config, emit};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

const TRAY_ID: &str = "moonlit";

#[derive(Clone, Default)]
struct Song {
    id: String,
    title: String,
    artist: String,
}

struct State {
    song: Option<Song>,
    playing: bool,
    quitting: bool,
    told: bool,
}

static STATE: Mutex<State> = Mutex::new(State { song: None, playing: false, quitting: false, told: false });

fn st() -> std::sync::MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn settings() -> Value {
    let saved = config::get("tray");
    let b = |k: &str, d: bool| saved.get(k).and_then(|v| v.as_bool()).unwrap_or(d);
    json!({ "tray": b("tray", false), "notify": b("notify", true), "notifyAlways": b("notifyAlways", false) })
}
fn on(key: &str) -> bool {
    settings().get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}
pub fn quitting() -> bool { st().quitting }
pub fn set_quitting(v: bool) { st().quitting = v; }

pub fn set(patch: &Value) -> Value {
    let mut s = settings();
    for k in ["tray", "notify", "notifyAlways"] {
        if let Some(v) = patch.get(k).and_then(|v| v.as_bool()) {
            s[k] = json!(v);
        }
    }
    config::set("tray", s.clone());
    apply();
    s
}

/// the theme's icon (or moonlit's usual one) as a picture of `size` pixels
pub fn icon(size: u32) -> Option<tauri::image::Image<'static>> {
    let file = crate::icon_file(192);
    let bytes = crate::asset(&file)?;
    let img = tauri::image::Image::from_bytes(&bytes).ok()?;
    Some(resize(&img, size))
}

/// box-filter downscale (Windows shows small tray icons crisper from a picture of the right size)
pub fn resize(img: &tauri::image::Image<'_>, size: u32) -> tauri::image::Image<'static> {
    let (w, h) = (img.width(), img.height());
    if w <= size || h <= size {
        return tauri::image::Image::new_owned(img.rgba().to_vec(), w, h);
    }
    let src = img.rgba();
    let mut out = vec![0u8; (size * size * 4) as usize];
    for y in 0..size {
        let (y0, y1) = (y * h / size, ((y + 1) * h / size).max(y * h / size + 1));
        for x in 0..size {
            let (x0, x1) = (x * w / size, ((x + 1) * w / size).max(x * w / size + 1));
            let mut acc = [0u64; 4];
            let mut n = 0u64;
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let i = ((sy * w + sx) * 4) as usize;
                    let a = src[i + 3] as u64;
                    // premultiplied, so see-through edges don't turn dark
                    acc[0] += src[i] as u64 * a;
                    acc[1] += src[i + 1] as u64 * a;
                    acc[2] += src[i + 2] as u64 * a;
                    acc[3] += a;
                    n += 1;
                }
            }
            let o = ((y * size + x) * 4) as usize;
            if acc[3] > 0 {
                for c in 0..3 {
                    out[o + c] = (acc[c] / acc[3]).min(255) as u8;
                }
            }
            out[o + 3] = (acc[3] / n.max(1)) as u8;
        }
    }
    tauri::image::Image::new_owned(out, size, size)
}

fn label() -> String {
    match &st().song {
        Some(s) => {
            let t = if s.artist.is_empty() { s.title.clone() } else { format!("{} - {}", s.artist, s.title) };
            if t.chars().count() > 60 { format!("{}…", t.chars().take(57).collect::<String>()) } else { t }
        }
        None => "nothing playing".into(),
    }
}

fn menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let playing = st().playing;
    Menu::with_items(app, &[
        &MenuItem::with_id(app, "label", label(), false, None::<&str>)?,
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "toggle", if playing { "pause" } else { "play" }, true, None::<&str>)?,
        &MenuItem::with_id(app, "next", "next song", true, None::<&str>)?,
        &MenuItem::with_id(app, "prev", "previous song", true, None::<&str>)?,
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "open", "open moonlit", true, None::<&str>)?,
        &MenuItem::with_id(app, "quit", "quit moonlit", true, None::<&str>)?,
    ])
}

fn refresh() {
    let app = app();
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let now = st().song.clone().map(|s| if s.artist.is_empty() { s.title } else { format!("{} - {}", s.artist, s.title) });
    let tip = match now {
        Some(n) if !n.is_empty() => format!("moonlit · {}", n).chars().take(127).collect(),
        _ => "moonlit".to_string(),
    };
    let _ = tray.set_tooltip(Some(tip));
    if let Ok(m) = menu(&app) {
        let _ = tray.set_menu(Some(m));
    }
}

pub fn apply() {
    let app = app();
    let want = on("tray");
    let have = app.tray_by_id(TRAY_ID).is_some();
    if want && !have {
        let Ok(m) = menu(&app) else { return };
        let mut b = TrayIconBuilder::with_id(TRAY_ID)
            .menu(&m)
            .tooltip("moonlit")
            .show_menu_on_left_click(false)
            .on_menu_event(|app, e| match e.id().as_ref() {
                "toggle" | "next" | "prev" => emit("tray:command", json!(e.id().as_ref())),
                "open" => show(),
                "quit" => {
                    set_quitting(true);
                    crate::quit(app);
                }
                _ => {}
            })
            .on_tray_icon_event(|_tray, e| match e {
                TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } => {
                    let app = crate::app();
                    let seen = app.get_webview_window("main").map(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false)).unwrap_or(false);
                    if seen { hide() } else { show() }
                }
                TrayIconEvent::DoubleClick { .. } => show(),
                _ => {}
            });
        if let Some(i) = icon(32) {
            b = b.icon(i);
        }
        let _ = b.build(&app);
        refresh();
    } else if !want && have {
        let _ = app.remove_tray_by_id(TRAY_ID);
        show(); // never leave the window hidden with no way back
    }
}

pub fn refresh_icon() {
    if let (Some(t), Some(i)) = (app().tray_by_id(TRAY_ID), icon(32)) {
        let _ = t.set_icon(Some(i));
    }
}

pub fn show() {
    let Some(w) = app().get_webview_window("main") else { return };
    let _ = w.set_skip_taskbar(false);
    if w.is_minimized().unwrap_or(false) {
        let _ = w.unminimize();
    }
    let _ = w.show();
    let _ = w.set_focus();
    emit("app:visible", json!(true));
}

pub fn hide() {
    let Some(w) = app().get_webview_window("main") else { return };
    let _ = w.hide();
    let _ = w.set_skip_taskbar(true);
    emit("app:visible", json!(false));
    // the first time, say where it went
    let first = { let mut s = st(); let f = !s.told; s.told = true; f };
    if first {
        notify("moonlit is still here ♡", "the music keeps playing. click the moonlit icon by the clock (under ^) to open it again.", None);
    }
}

/// the window's close and minimise buttons hide it to the tray (when that's on)
pub fn hides_on_close() -> bool { on("tray") && !quitting() }
pub fn hides_on_minimize() -> bool { on("tray") }

pub fn set_playing(on: bool) {
    let changed = { let mut s = st(); let c = s.playing != on; s.playing = on; c };
    if changed { refresh(); }
}

/// a new song started: update the tray, and maybe show a Windows notification
pub fn now_playing(next: Option<Value>, cover: Option<Vec<u8>>) {
    let fresh;
    {
        let mut s = st();
        let song = next.as_ref().map(|n| Song {
            id: n.get("id").map(|v| v.as_str().map(String::from).unwrap_or_else(|| v.to_string())).unwrap_or_default(),
            title: n.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            artist: n.get("artist").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        });
        fresh = match (&song, &s.song) { (Some(a), Some(b)) => a.id != b.id, (Some(_), None) => true, _ => false };
        s.song = song;
    }
    refresh();
    if !fresh || !on("notify") {
        return;
    }
    let looking = app().get_webview_window("main").map(|w| {
        w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) && !w.is_minimized().unwrap_or(false)
    }).unwrap_or(false);
    if looking && !on("notifyAlways") {
        return; // you can already see it
    }
    let Some(song) = st().song.clone() else { return };
    let album = next.as_ref().and_then(|n| n.get("album")).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let body = [song.artist.as_str(), album.as_str()].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(" · ");
    let title = if song.title.is_empty() { "now playing".to_string() } else { song.title };
    notify(&title, if body.is_empty() { "moonlit" } else { &body }, cover);
}

/// A silent Windows notification (never a ding on stream), with a picture when there is one.
/// Clicking it opens moonlit (Windows starts moonlit again, which shows the open window).
pub fn notify(title: &str, body: &str, picture: Option<Vec<u8>>) {
    #[cfg(windows)]
    {
        use tauri_winrt_notification::{IconCrop, Toast};
        let dir = config::data_dir().join("notify");
        let _ = std::fs::create_dir_all(&dir);
        // two files, used in turn, so the picture Windows is still reading is never overwritten
        static TURN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        let turn = TURN.fetch_xor(true, std::sync::atomic::Ordering::SeqCst);
        let bytes = match picture {
            Some(b) if !b.is_empty() => Some(b),
            _ => crate::asset(&crate::icon_file(192)),
        };
        let pic = bytes.and_then(|b| {
            let ext = if b.starts_with(&[0xff, 0xd8]) { "jpg" } else if b.starts_with(b"RIFF") { "webp" } else { "png" };
            let file = dir.join(format!("picture-{}.{}", if turn { "a" } else { "b" }, ext));
            std::fs::write(&file, &b).ok().map(|_| file)
        });
        let mut t = Toast::new(crate::APP_ID).title(title).text1(body).sound(None);
        if let Some(p) = &pic {
            t = t.icon(p, IconCrop::Square, "");
        }
        let _ = t.show();
    }
    #[cfg(not(windows))]
    {
        let _ = (title, body, picture);
    }
}
