//! moonlit's small settings file (desktop.json in the app's data folder), the same file and
//! the same keys the Electron version used, so settings carry over.

use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

static PATH: OnceLock<PathBuf> = OnceLock::new();
static DATA: OnceLock<PathBuf> = OnceLock::new();
static LOCK: Mutex<()> = Mutex::new(());

pub fn init(data_dir: &Path) {
    let _ = std::fs::create_dir_all(data_dir);
    let _ = DATA.set(data_dir.to_path_buf());
    let _ = PATH.set(data_dir.join("desktop.json"));
}

/// moonlit's own data folder (%APPDATA%\io.github.elliesxofc.moonlit on Windows)
pub fn data_dir() -> PathBuf {
    DATA.get().cloned().unwrap_or_else(std::env::temp_dir)
}

fn path() -> PathBuf {
    PATH.get().cloned().unwrap_or_else(|| data_dir().join("desktop.json"))
}

fn load() -> Map<String, Value> {
    std::fs::read_to_string(path())
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(s.trim_start_matches('\u{feff}')).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

pub fn read() -> Map<String, Value> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    load()
}

pub fn get(key: &str) -> Value {
    read().get(key).cloned().unwrap_or(Value::Null)
}

pub fn get_str(key: &str) -> String {
    get(key).as_str().unwrap_or("").to_string()
}

/// Merges `patch` (an object) into the file and returns the result.
pub fn write(patch: Value) -> Map<String, Value> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut next = load();
    if let Value::Object(p) = patch {
        for (k, v) in p {
            next.insert(k, v);
        }
    }
    if let Ok(text) = serde_json::to_string_pretty(&Value::Object(next.clone())) {
        let tmp = path().with_extension("json.tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, path());
        }
    }
    next
}

pub fn set(key: &str, value: Value) {
    let mut m = Map::new();
    m.insert(key.to_string(), value);
    write(Value::Object(m));
}

pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}
