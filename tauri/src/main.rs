// moonlit desktop: the same player as the website, as a real app, now on Rust (Tauri).
// It shows the web files from inside the app (no internet needed) in Windows' own browser
// engine (WebView2), and adds what a browser can't do: write the OBS now-playing file, the
// OBS overlay, the tray, chat song requests, Spotify, downloads, and start with the PC.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod channels;
mod chat;
mod config;
mod discord;
mod downloader;
mod files;
mod httpd;
mod matcher;
mod moving;
mod overlay;
mod secrets;
mod spotify;
mod spotify_link;
mod tray;
mod winmedia;

use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub const APP_ID: &str = "io.github.elliesxofc.moonlit";
const BRIDGE: &str = include_str!("../bridge.js");

static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn app() -> AppHandle {
    APP.get().expect("moonlit has started").clone()
}

/// tells the player page something (the page listens with desktop.*.onX)
pub fn emit(channel: &str, payload: Value) {
    if let Some(a) = APP.get() {
        let _ = a.emit(channel, payload);
    }
}

/// one of the web files built into the app (icons, …)
pub fn asset(path: &str) -> Option<Vec<u8>> {
    let a = APP.get()?;
    let r = a.asset_resolver();
    r.get(path.trim_start_matches('/').to_string())
        .or_else(|| r.get(format!("/{}", path.trim_start_matches('/'))))
        .map(|x| x.bytes().to_vec())
}

/* ───────────── the app's icon in the theme's colours ───────────── */
fn icon_theme() -> Option<String> {
    let t = config::get_str("iconTheme");
    let ok = !t.is_empty() && t.len() <= 40 && t.chars().all(|c| c.is_ascii_lowercase() || c == '-');
    ok.then_some(t)
}
pub fn icon_file(size: u32) -> String {
    if let Some(t) = icon_theme() {
        let f = format!("icons/themes/{}-{}.png", t, size);
        if asset(&f).is_some() {
            return f;
        }
    }
    if size <= 192 { "icons/icon-192.png".into() } else { "icons/icon-512.png".into() }
}
fn apply_icon() {
    let Some(w) = app().get_webview_window("main") else { return };
    if let Some(img) = asset(&icon_file(512)).and_then(|b| tauri::image::Image::from_bytes(&b).ok()) {
        let _ = w.set_icon(tray::resize(&img, 256));
    }
}

/* ───────────── closing ───────────── */
// "Do you want to close the program?": the page shows its own popup and answers. If it
// doesn't answer in a moment (stuck), moonlit closes anyway.
struct Close {
    ok: bool,
    asking: bool,
    turn: u64,
}
static CLOSE: Mutex<Close> = Mutex::new(Close { ok: false, asking: false, turn: 0 });

pub fn quit(app: &AppHandle) {
    CLOSE.lock().unwrap_or_else(|e| e.into_inner()).ok = true;
    save_window();
    downloader::stop_all();
    app.exit(0);
}

fn close_requested() {
    let turn = {
        let mut c = CLOSE.lock().unwrap_or_else(|e| e.into_inner());
        if c.asking {
            return;
        }
        c.asking = true;
        c.turn += 1;
        c.turn
    };
    tray::show();
    emit("app:close-request", Value::Null);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
        let still = { let c = CLOSE.lock().unwrap_or_else(|e| e.into_inner()); c.asking && c.turn == turn };
        if still {
            quit(&app());
        }
    });
}

#[tauri::command]
fn close_seen() {
    // the popup is up: wait for the answer
    CLOSE.lock().unwrap_or_else(|e| e.into_inner()).turn += 1;
}

#[tauri::command]
fn close_answer(yes: bool) {
    CLOSE.lock().unwrap_or_else(|e| e.into_inner()).asking = false;
    if yes { quit(&app()) } else { tray::set_quitting(false) }
}

/* ───────────── window size and place, remembered ───────────── */
fn save_window() {
    let Some(w) = APP.get().and_then(|a| a.get_webview_window("main")) else { return };
    if w.is_minimized().unwrap_or(false) || !w.is_visible().unwrap_or(true) {
        return;
    }
    let maximized = w.is_maximized().unwrap_or(false);
    let mut saved = config::get("window");
    if !saved.is_object() {
        saved = json!({});
    }
    if !maximized {
        let scale = w.scale_factor().unwrap_or(1.0);
        if let (Ok(p), Ok(s)) = (w.outer_position(), w.inner_size()) {
            let s = s.to_logical::<f64>(scale);
            saved["x"] = json!(p.x);
            saved["y"] = json!(p.y);
            saved["width"] = json!(s.width.round());
            saved["height"] = json!(s.height.round());
        }
    }
    saved["maximized"] = json!(maximized);
    config::set("window", saved);
}

/* ───────────── things the page can ask the app to do ───────────── */
// (for testing: a line from the page in moonlit's own output)
#[tauri::command]
fn debug_log(text: String) {
    eprintln!("[page] {}", text.chars().take(4000).collect::<String>());
}

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

// the theme changed (or "match the icon" was switched): theme id, or null for the usual icon
#[tauri::command]
fn app_icon(theme: Option<String>) -> Option<String> {
    let next = theme.filter(|t| {
        !t.is_empty() && t.len() <= 40 && t.chars().all(|c| c.is_ascii_lowercase() || c == '-')
            && asset(&format!("icons/themes/{}-512.png", t)).is_some()
    });
    if next == icon_theme() {
        return next;
    }
    config::set("iconTheme", json!(next));
    apply_icon();
    tray::refresh_icon();
    next
}

#[tauri::command]
fn tray_get() -> Value { tray::settings() }
#[tauri::command]
fn tray_set(patch: Value) -> Value { tray::set(&patch) }
#[tauri::command]
fn tray_playing(on: bool) { tray::set_playing(on) }
// a new song: { id, title, artist, album } plus its cover as the raw body
#[tauri::command]
fn tray_now_playing(request: tauri::ipc::Request<'_>) {
    let song = request.headers().get("x-song").and_then(|v| v.to_str().ok())
        .and_then(|s| urlencoding::decode(s).ok().map(|s| s.into_owned()))
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(|v| v.is_object());
    let cover = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) if !b.is_empty() => Some(b.clone()),
        _ => None,
    };
    tray::now_playing(song, cover);
}

// Start with Windows.
#[tauri::command]
fn startup_get(app: AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}
#[tauri::command]
fn startup_set(app: AppHandle, on: bool) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    let l = app.autolaunch();
    let _ = if on { l.enable() } else { l.disable() };
    l.is_enabled().unwrap_or(false)
}

/* overlay */
#[tauri::command]
fn overlay_state(state: Value) {
    if let Value::Object(m) = state {
        overlay::get().update(m);
    }
}
#[tauri::command]
fn overlay_spectrum(levels: Vec<f64>) {
    overlay::get().spectrum(&levels);
}
#[tauri::command]
fn overlay_cover(request: tauri::ipc::Request<'_>) {
    let h = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(|s| urlencoding::decode(s).map(|s| s.into_owned()).unwrap_or_default()).unwrap_or_default();
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) if !b.is_empty() => Some(b.clone()),
        _ => None,
    };
    overlay::get().set_cover(&h("x-id"), &h("x-type"), bytes);
}
#[tauri::command]
async fn overlay_url() -> Option<String> {
    for _ in 0..50 {
        if let Some(u) = overlay::get().url() {
            return Some(u);
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    None
}
#[tauri::command]
fn overlay_open(app: AppHandle, url: String) {
    let ok = regex::Regex::new(r"^http://localhost:\d+/overlay").map(|r| r.is_match(&url)).unwrap_or(false);
    if ok {
        open_url(&app, &url);
    }
}

pub fn open_url(app: &AppHandle, url: &str) {
    use tauri_plugin_opener::OpenerExt;
    let _ = app.opener().open_url(url, None::<&str>);
}

fn main() {
    // Windows shows notifications and groups the taskbar button under this name
    #[cfg(windows)]
    unsafe {
        let _ = windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(windows::core::w!("io.github.elliesxofc.moonlit"));
    }

    tauri::Builder::default()
        // opening moonlit (or a song) while it's already running: use this window
        .plugin(tauri_plugin_single_instance::init(|_app, argv, cwd| {
            tray::show();
            let files = files::accept(files::audio_files_in(&argv, Some(std::path::Path::new(&cwd))));
            if !files.is_empty() {
                emit("files:open", json!(files));
            }
        }))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            debug_log, app_version, app_icon, close_seen, close_answer,
            tray_get, tray_set, tray_playing, tray_now_playing,
            startup_get, startup_set,
            overlay_state, overlay_spectrum, overlay_cover, overlay_url, overlay_open,
            files::obs_choose, files::obs_get, files::obs_unlink, files::obs_write,
            files::files_pending, files::file_info, files::file_bytes,
            files::playlist_open, files::playlist_save,
            chat::chat_get, chat::chat_set, chat::chat_preview, chat::chat_live_start, chat::chat_say,
            discord::discord_get, discord::discord_set,
            channels::channels_resolve,
            spotify::spotify_get, spotify::spotify_connect, spotify::spotify_control, spotify::spotify_disconnect,
            spotify::spotify_local, spotify::spotify_open,
            downloader::dl_add, downloader::dl_add_list, downloader::dl_list, downloader::dl_cancel, downloader::dl_retry,
            downloader::dl_cancel_all, downloader::dl_clear, downloader::dl_folder, downloader::dl_choose_folder,
            downloader::dl_open_folder, downloader::dl_request, downloader::dl_forget_request, downloader::dl_request_files,
            moving::move_status, moving::move_run, moving::move_take, moving::move_blob, moving::move_done,
        ])
        .setup(|app| {
            let _ = APP.set(app.handle().clone());
            config::init(&app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("moonlit")));
            moving::bring_settings();
            files::accept(files::audio_files_in(&std::env::args().collect::<Vec<_>>(), None))
                .into_iter()
                .for_each(files::add_pending);

            let saved = config::get("window");
            let num = |k: &str| saved.get(k).and_then(|v| v.as_f64());
            let b = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("moonlit")
                .inner_size(num("width").unwrap_or(1280.0), num("height").unwrap_or(800.0))
                .min_inner_size(360.0, 560.0)
                .visible(false)
                .background_color(tauri::window::Color(0x17, 0x0a, 0x14, 0xff))
                .initialization_script(BRIDGE)
                // music starts by itself after a restart ("start playing by itself when it opens")
                .additional_browser_args("--autoplay-policy=no-user-gesture-required --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection")
                // links (e.g. the VB-CABLE site) open in your normal browser
                .on_navigation(|url| {
                    let inside = matches!(url.host_str(), Some("tauri.localhost") | Some("localhost")) || url.scheme() == "tauri";
                    if !inside && (url.scheme() == "http" || url.scheme() == "https") {
                        open_url(&crate::app(), url.as_str());
                    }
                    inside
                })
                .on_new_window(|url, _features| {
                    if url.scheme() == "http" || url.scheme() == "https" {
                        open_url(&crate::app(), url.as_str());
                    }
                    tauri::webview::NewWindowResponse::Deny
                })
                .on_page_load(|w, p| {
                    if p.event() == tauri::webview::PageLoadEvent::Finished {
                        let _ = w.show();
                        // (development builds only: run a test script in the page)
                        #[cfg(debug_assertions)]
                        if let Some(js) = std::env::var_os("MOONLIT_TEST_SCRIPT").and_then(|f| std::fs::read_to_string(f).ok()) {
                            let _ = w.eval(&js);
                        }
                    }
                });
            let win = b.build()?;
            if let (Some(x), Some(y)) = (num("x"), num("y")) {
                let _ = win.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
            }
            if saved.get("maximized").and_then(|v| v.as_bool()).unwrap_or(false) {
                let _ = win.maximize();
            }
            if icon_theme().is_some() {
                apply_icon();
            }

            let w2 = win.clone();
            let was_min = std::sync::atomic::AtomicBool::new(false);
            win.on_window_event(move |e| match e {
                WindowEvent::CloseRequested { api, .. } => {
                    save_window();
                    if CLOSE.lock().unwrap_or_else(|e| e.into_inner()).ok {
                        return;
                    }
                    api.prevent_close();
                    if tray::hides_on_close() {
                        tray::hide(); // the tray hides it instead
                    } else {
                        close_requested();
                    }
                }
                WindowEvent::Resized(_) => {
                    let min = w2.is_minimized().unwrap_or(false);
                    let before = was_min.swap(min, std::sync::atomic::Ordering::SeqCst);
                    if min && !before {
                        if tray::hides_on_minimize() { tray::hide() } else { emit("app:visible", json!(false)) }
                    } else if !min && before {
                        emit("app:visible", json!(true));
                    }
                    if !min { save_window(); }
                }
                WindowEvent::Moved(_) => save_window(),
                _ => {}
            });

            tray::apply();

            // the OBS overlay (http://localhost:4848/overlay)
            let ov = overlay::get();
            ov.on_watchers(|n| emit("overlay:watchers", json!(n)));
            tauri::async_runtime::spawn(async move { ov.start().await; });

            chat::start_saved();
            discord::start_saved();
            spotify::init();
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("moonlit couldn't start")
        .run(|_app, e| {
            if let tauri::RunEvent::Exit = e {
                downloader::stop_all();
                winmedia::stop();
            }
        });
}
