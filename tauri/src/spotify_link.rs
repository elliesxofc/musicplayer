//! Song names from a Spotify link (a song, album or playlist), read from Spotify's public
//! embed page, the way the spotify-url-info library did for the Electron version. Only the
//! names: Spotify's audio is never touched.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use regex::Regex;
use serde_json::Value;

pub struct Track {
    pub name: String,
    pub artist: String,
    pub duration_ms: f64,
}
pub struct Details {
    pub kind: String,
    pub title: String,
    pub image: String,
    pub tracks: Vec<Track>,
}

/// open.spotify.com/(intl-xx/)album/ID, spotify:album:ID, play.spotify.com/… → (type, id)
pub fn parse(url: &str) -> Option<(String, String)> {
    let u = url.trim();
    let types = "track|album|playlist|artist|episode|show";
    if let Some(c) = Regex::new(&format!(r"^spotify:({}):([A-Za-z0-9]+)", types)).unwrap().captures(u) {
        return Some((c[1].to_string(), c[2].to_string()));
    }
    let re = Regex::new(&format!(r"(?i)^(?:https?://)?(?:open|play|embed)\.spotify\.com/(?:intl-[a-z-]+/)?(?:embed/)?({})/([A-Za-z0-9]+)", types)).unwrap();
    re.captures(u).map(|c| (c[1].to_lowercase(), c[2].to_string()))
}

fn script(html: &str, id: &str) -> Option<String> {
    let re = Regex::new(&format!(r#"(?s)<script[^>]*\bid="{}"[^>]*>(.*?)</script>"#, regex::escape(id))).unwrap();
    re.captures(html).map(|c| c[1].trim().to_string())
}

fn entity(html: &str) -> Option<Value> {
    if let Some(s) = script(html, "resource") {
        return B64.decode(s).ok().and_then(|b| serde_json::from_slice(&b).ok());
    }
    if let Some(s) = script(html, "initial-state") {
        let v: Value = B64.decode(s).ok().and_then(|b| serde_json::from_slice(&b).ok())?;
        return v.pointer("/data/entity").cloned();
    }
    if let Some(s) = script(html, "__NEXT_DATA__") {
        let v: Value = serde_json::from_str(&s).ok()?;
        return v.pointer("/props/pageProps/state/data/entity").cloned();
    }
    None
}

fn artist_of(t: &Value) -> String {
    if let Some(p) = t.pointer("/show/publisher").and_then(|v| v.as_str()) {
        return p.to_string();
    }
    let names: Vec<String> = t.get("artists").and_then(|a| a.as_array()).cloned().unwrap_or_default().iter()
        .filter_map(|a| a.get("name").and_then(|n| n.as_str()).map(String::from)).collect();
    let mut out = String::new();
    for (i, n) in names.iter().enumerate() {
        if i > 0 { out.push_str(if i == names.len() - 1 { " & " } else { ", " }); }
        out.push_str(n);
    }
    if out.is_empty() { t.get("subtitle").and_then(|s| s.as_str()).unwrap_or("").to_string() } else { out }
}

fn to_track(t: &Value) -> Track {
    Track {
        name: t.get("title").or_else(|| t.get("name")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
        artist: artist_of(t),
        duration_ms: t.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0),
    }
}

pub fn details_from(html: &str) -> Option<Details> {
    let data = entity(html)?;
    let name = data.get("name").and_then(|v| v.as_str())?.to_string();
    let kind = data.get("uri").and_then(|v| v.as_str()).and_then(|u| u.split(':').nth(1)).map(String::from)
        .or_else(|| data.get("type").and_then(|v| v.as_str()).map(String::from))?;
    let images = data.pointer("/coverArt/sources").or_else(|| data.get("images")).or_else(|| data.pointer("/visualIdentity/image"))
        .and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let image = images.iter().max_by(|a, b| {
        let w = |x: &Value| x.get("width").and_then(|v| v.as_f64()).unwrap_or(0.0);
        w(a).partial_cmp(&w(b)).unwrap_or(std::cmp::Ordering::Equal)
    }).and_then(|i| i.get("url")).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let tracks = match data.get("trackList").and_then(|t| t.as_array()) {
        Some(list) => list.iter().map(to_track).collect(),
        None => vec![to_track(&data)],
    };
    Some(Details { kind, title: name, image, tracks })
}

pub async fn details(url: &str) -> Result<Details, String> {
    let (kind, id) = parse(url).ok_or("that Spotify link couldn't be read")?;
    let embed = format!("https://open.spotify.com/embed/{}/{}", kind, id);
    let mut html = String::new();
    for attempt in 0..3 {
        match crate::chat::http().get(&embed).header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36").send().await {
            Ok(r) => html = r.text().await.unwrap_or_default(),
            Err(_) if attempt < 2 => continue,
            Err(_) => return Err("no internet connection?".into()),
        }
        if html.contains("<html") { break; }
    }
    details_from(&html).ok_or_else(|| "that Spotify link couldn't be read".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn links() {
        assert_eq!(parse("https://open.spotify.com/intl-de/album/4aawyAB9vmqN3uQ7FjRGTy?si=x"), Some(("album".into(), "4aawyAB9vmqN3uQ7FjRGTy".into())));
        assert_eq!(parse("spotify:track:6rqhFgbbKwnb9MLmUQDhG6"), Some(("track".into(), "6rqhFgbbKwnb9MLmUQDhG6".into())));
        assert_eq!(parse("https://example.com/album/1"), None);
    }
}
