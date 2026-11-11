//! "Now playing" overlay for OBS. A tiny web server on this PC only (127.0.0.1, never
//! reachable from the internet):
//!   /overlay  the page to add in OBS as a Browser Source
//!   /events   live updates for that page (server-sent events)
//!   /now      the current song as JSON
//!   /cover    the current song's cover art

use crate::httpd;
use serde_json::{json, Map, Value};
use sha1::{Digest, Sha1};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;

const PORTS: [u16; 5] = [4848, 4849, 4850, 4851, 4852];
const PAGE: &str = include_str!("../../desktop/overlay.html");
const VIZCORE: &str = include_str!("../../vizcore.js");

fn empty() -> Map<String, Value> {
    json!({ "id": null, "title": "", "artist": "", "album": "", "line": "", "duration": 0, "position": 0,
            "playing": false, "spectrum": true, "next": null, "theme": null, "plain": false })
    .as_object()
    .cloned()
    .unwrap()
}

struct Inner {
    state: Map<String, Value>,
    updated_at: f64,
    covers: VecDeque<(String, String, Vec<u8>)>, // song id, type, bytes: the last few
}

pub struct Overlay {
    inner: Mutex<Inner>,
    tx: broadcast::Sender<Arc<str>>,
    clients: AtomicUsize,
    port: Mutex<Option<u16>>,
    build: String,
    on_watchers: Mutex<Option<Box<dyn Fn(usize) + Send + Sync>>>,
}

static OVERLAY: OnceLock<Arc<Overlay>> = OnceLock::new();

pub fn get() -> Arc<Overlay> {
    OVERLAY
        .get_or_init(|| {
            // A fingerprint of the overlay's own files: OBS keeps the page open across moonlit
            // updates, so the page reloads itself when this changes.
            let mut h = Sha1::new();
            h.update(PAGE.as_bytes());
            h.update(VIZCORE.as_bytes());
            let build = h.finalize().iter().map(|b| format!("{:02x}", b)).collect::<String>()[..12].to_string();
            let (tx, _) = broadcast::channel(256);
            Arc::new(Overlay {
                inner: Mutex::new(Inner { state: empty(), updated_at: crate::config::now_ms(), covers: VecDeque::new() }),
                tx,
                clients: AtomicUsize::new(0),
                port: Mutex::new(None),
                build,
                on_watchers: Mutex::new(None),
            })
        })
        .clone()
}

impl Overlay {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    // position is sent as "seconds at the moment of sending"; the page keeps time from there
    fn snapshot(&self) -> String {
        let mut s = self.lock().state.clone();
        s.insert("build".into(), json!(self.build));
        s.insert("sentAt".into(), json!(crate::config::now_ms()));
        Value::Object(s).to_string()
    }

    fn send(&self, msg: String) {
        let _ = self.tx.send(Arc::from(msg));
    }

    fn watchers_changed(&self) {
        let n = self.clients.load(Ordering::SeqCst);
        if let Some(cb) = self.on_watchers.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            cb(n);
        }
    }

    pub fn on_watchers(&self, cb: impl Fn(usize) + Send + Sync + 'static) {
        *self.on_watchers.lock().unwrap_or_else(|e| e.into_inner()) = Some(Box::new(cb));
    }

    pub fn url(&self) -> Option<String> {
        self.port.lock().unwrap_or_else(|e| e.into_inner()).map(|p| format!("http://localhost:{}/overlay", p))
    }

    pub fn update(&self, next: Map<String, Value>) {
        {
            let mut g = self.lock();
            let mut s = empty();
            for (k, v) in next {
                s.insert(k, v);
            }
            g.state = s;
            g.updated_at = crate::config::now_ms();
        }
        let msg = format!("data: {}\n\n", self.snapshot());
        self.send(msg);
    }

    pub fn set_cover(&self, id: &str, kind: &str, bytes: Option<Vec<u8>>) {
        let current = {
            let mut g = self.lock();
            g.covers.retain(|c| c.0 != id);
            if let Some(b) = &bytes {
                if !b.is_empty() {
                    g.covers.push_back((id.to_string(), kind.to_string(), b.clone()));
                }
            }
            while g.covers.len() > 6 {
                g.covers.pop_front();
            }
            g.state.get("id").and_then(|v| v.as_str()) == Some(id)
        };
        // the cover can arrive just after the song itself: tell the overlay to fetch it now
        if current && bytes.map(|b| !b.is_empty()).unwrap_or(false) {
            self.send(format!("event: cover\ndata: {}\n\n", json!(id)));
        }
    }

    /// music bar levels (0-255), sent as their own small event about 30 times a second
    pub fn spectrum(&self, levels: &[f64]) {
        if self.clients.load(Ordering::SeqCst) == 0 {
            return;
        }
        let s: Vec<String> = levels.iter().take(400).map(|v| (v.max(0.0).min(255.0) as i64).to_string()).collect();
        self.send(format!("event: spectrum\ndata: {}\n\n", s.join(",")));
    }

    /// what's on the overlay right now, with the song's clock moved on to this moment
    pub fn now(&self) -> Map<String, Value> {
        let g = self.lock();
        let mut s = g.state.clone();
        let playing = s.get("playing").and_then(|v| v.as_bool()).unwrap_or(false);
        let duration = s.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let mut pos = s.get("position").and_then(|v| v.as_f64()).unwrap_or(0.0);
        if playing {
            pos += (crate::config::now_ms() - g.updated_at) / 1000.0;
        }
        if duration > 0.0 {
            pos = pos.min(duration);
        }
        s.insert("position".into(), json!(pos));
        s
    }

    pub async fn start(self: Arc<Self>) -> Option<u16> {
        for p in PORTS {
            if let Ok(listener) = TcpListener::bind(("127.0.0.1", p)).await {
                *self.port.lock().unwrap_or_else(|e| e.into_inner()) = Some(p);
                let me = self.clone();
                tokio::spawn(async move {
                    loop {
                        let Ok((stream, _)) = listener.accept().await else { continue };
                        let me = me.clone();
                        tokio::spawn(async move { me.handle(stream).await });
                    }
                });
                return Some(p);
            }
        }
        None
    }

    async fn handle(self: Arc<Self>, mut stream: TcpStream) {
        let Some(req) = httpd::read_request(&mut stream).await else { return };
        let cors = [("Access-Control-Allow-Origin", "*"), ("Cache-Control", "no-store")];
        if req.method != "GET" {
            return httpd::respond(&mut stream, 405, &cors, b"").await;
        }
        match req.path.as_str() {
            "/" | "/overlay" => {
                let page = PAGE.replace("__BUILD__", &self.build);
                httpd::respond(&mut stream, 200, &[cors[0], cors[1], ("Content-Type", "text/html; charset=utf-8")], page.as_bytes()).await
            }
            // the visualizer engine, shared with the app
            "/vizcore.js" => {
                httpd::respond(&mut stream, 200, &[cors[0], cors[1], ("Content-Type", "text/javascript; charset=utf-8")], VIZCORE.as_bytes()).await
            }
            "/now" => {
                let body = self.snapshot();
                httpd::respond(&mut stream, 200, &[cors[0], cors[1], ("Content-Type", "application/json; charset=utf-8")], body.as_bytes()).await
            }
            "/cover" => {
                // the current song's cover, or the next song's (for "up next") when asked by id
                let found = {
                    let g = self.lock();
                    let want = req.q("id").map(|s| s.to_string()).or_else(|| g.state.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()));
                    want.and_then(|w| g.covers.iter().find(|c| c.0 == w).map(|c| (c.1.clone(), c.2.clone())))
                };
                match found {
                    Some((kind, bytes)) => {
                        let kind = if kind.is_empty() { "image/jpeg".to_string() } else { kind };
                        httpd::respond(&mut stream, 200, &[cors[0], cors[1], ("Content-Type", &kind)], &bytes).await
                    }
                    None => httpd::respond(&mut stream, 404, &cors, b"").await,
                }
            }
            "/events" => self.events(stream).await,
            _ => httpd::respond(&mut stream, 404, &cors, b"").await,
        }
    }

    async fn events(self: Arc<Self>, mut stream: TcpStream) {
        let mut rx = self.tx.subscribe();
        let head = "HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nContent-Type: text/event-stream; charset=utf-8\r\nConnection: keep-alive\r\n\r\n";
        let first = format!("{}retry: 2000\ndata: {}\n\n", head, self.snapshot());
        if stream.write_all(first.as_bytes()).await.is_err() {
            return;
        }
        self.clients.fetch_add(1, Ordering::SeqCst);
        self.watchers_changed();
        // keep connections alive through proxies/idle timers
        let mut ping = tokio::time::interval(std::time::Duration::from_secs(20));
        ping.tick().await;
        let mut probe = [0u8; 64];
        loop {
            let out: Option<Arc<str>> = tokio::select! {
                m = rx.recv() => match m {
                    Ok(m) => Some(m),
                    Err(broadcast::error::RecvError::Lagged(_)) => None,
                    Err(_) => break,
                },
                _ = ping.tick() => Some(Arc::from(": ping\n\n")),
                // the page went away (OBS closed the source, the browser tab closed)
                r = tokio::io::AsyncReadExt::read(&mut stream, &mut probe) => match r { Ok(0) | Err(_) => break, Ok(_) => None },
            };
            if let Some(m) = out {
                if stream.write_all(m.as_bytes()).await.is_err() {
                    break;
                }
            }
        }
        self.clients.fetch_sub(1, Ordering::SeqCst);
        self.watchers_changed();
    }
}
