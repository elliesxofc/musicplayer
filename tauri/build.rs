// Copies the player's web files (the same ones the website serves) into dist/, which Tauri
// builds into the app, then runs Tauri's own build step.
use std::path::Path;

const FILES: [&str; 9] = ["index.html", "style.css", "vizcore.js", "app.js", "obs.js", "live.js", "requests.js", "manifest.webmanifest", "sw.js"];

fn copy_dir(from: &Path, to: &Path) {
    let _ = std::fs::create_dir_all(to);
    for e in std::fs::read_dir(from).expect("icons folder").flatten() {
        let p = e.path();
        if p.is_dir() { copy_dir(&p, &to.join(e.file_name())); } else { std::fs::copy(&p, to.join(e.file_name())).expect("copy icon"); }
    }
}

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let dist = Path::new(env!("CARGO_MANIFEST_DIR")).join("dist");
    let _ = std::fs::remove_dir_all(&dist);
    std::fs::create_dir_all(&dist).expect("dist folder");
    for f in FILES {
        std::fs::copy(root.join(f), dist.join(f)).unwrap_or_else(|e| panic!("copy {}: {}", f, e));
        println!("cargo:rerun-if-changed=../{}", f);
    }
    copy_dir(&root.join("icons"), &dist.join("icons"));
    println!("cargo:rerun-if-changed=../icons");
    println!("cargo:rerun-if-changed=../desktop/overlay.html");
    println!("cargo:rerun-if-changed=bridge.js");
    tauri_build::build()
}
