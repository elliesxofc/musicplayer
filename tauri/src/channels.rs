//! The song request channel list: turning what you paste (a channel link, an @handle, or a
//! link to one of the channel's videos) into the channel's ID ("UC" + 22 letters), which is
//! what a song's channel is checked against. IDs never change, unlike names and handles.

use regex::Regex;
use serde_json::{json, Value};

#[derive(Debug, PartialEq)]
pub enum Parsed {
    Id(String),
    Page { page: String, video: bool, handle: Option<String> },
}

fn id_re() -> Regex { Regex::new(r"^UC[\w-]{22}$").unwrap() }
fn is_vid(s: &str) -> bool { s.len() == 11 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') }

// What was pasted → an ID, a page to look the ID up on, or None (a plain name)
pub fn parse_channel(input: &str) -> Option<Parsed> {
    let s = input.split('#').next().unwrap_or("").trim();
    if s.is_empty() { return None; }
    if id_re().is_match(s) { return Some(Parsed::Id(s.into())); }
    if Regex::new(r"^@[\w.\-·]{3,100}$").unwrap().is_match(s) {
        return Some(Parsed::Page { page: format!("https://www.youtube.com/{}", s), video: false, handle: Some(s[1..].into()) });
    }
    let full = if Regex::new(r"(?i)^[a-z]+://").unwrap().is_match(s) { s.to_string() } else { format!("https://{}", s) };
    let url = url::Url::parse(&full).ok()?;
    let host = url.host_str()?.to_string();
    let host = host.strip_prefix("www.").or_else(|| host.strip_prefix("m.")).or_else(|| host.strip_prefix("music.")).unwrap_or(&host).to_string();
    if !(host == "youtube.com" || host == "youtu.be") || !(s.contains('.') || s.contains('/')) { return None; }
    let parts: Vec<String> = url.path().split('/').filter(|p| !p.is_empty()).map(|p| urlencoding::decode(p).map(|c| c.into_owned()).unwrap_or_else(|_| p.into())).collect();
    let part = |i: usize| parts.get(i).map(|s| s.as_str()).unwrap_or("");
    let watch = |v: &str| Some(Parsed::Page { page: format!("https://www.youtube.com/watch?v={}", v), video: true, handle: None });
    if host == "youtu.be" && is_vid(part(0)) { return watch(part(0)); }
    if let Some(v) = url.query_pairs().find(|(k, _)| k == "v").map(|(_, v)| v.to_string()) { if is_vid(&v) { return watch(&v); } }
    if ["live", "shorts", "embed"].contains(&part(0)) && is_vid(part(1)) { return watch(part(1)); }
    if part(0) == "channel" && id_re().is_match(part(1)) { return Some(Parsed::Id(part(1).into())); }
    if part(0).starts_with('@') {
        return Some(Parsed::Page { page: format!("https://www.youtube.com/{}", part(0)), video: false, handle: Some(part(0)[1..].into()) });
    }
    if ["c", "user"].contains(&part(0)) && !part(1).is_empty() {
        return Some(Parsed::Page { page: format!("https://www.youtube.com/{}/{}", part(0), part(1)), video: false, handle: Some(part(1).into()) });
    }
    None
}

// a line of the list → what a song's channel is compared with (offline, no lookups):
// "UC… # name" → the ID, "youtube.com/@name" or "@name" → the handle, anything else → the name
pub fn channel_key(line: &str) -> String {
    match parse_channel(line) {
        Some(Parsed::Id(id)) => id.to_lowercase(),
        Some(Parsed::Page { handle: Some(h), .. }) => h.to_lowercase(),
        _ => line.split('#').next().unwrap_or("").trim().trim_start_matches('@').to_lowercase(),
    }
}

pub fn unescape(s: &str) -> String {
    let u = Regex::new(r"(?i)\\u([0-9a-f]{4})").unwrap();
    let s = u.replace_all(s, |c: &regex::Captures| u32::from_str_radix(&c[1], 16).ok().and_then(char::from_u32).map(String::from).unwrap_or_default());
    let s = Regex::new(r#"\\(["\\/])"#).unwrap().replace_all(&s, "$1");
    s.replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'").replace("&#x27;", "'").replace("&lt;", "<").replace("&gt;", ">")
}

// a YouTube page → the channel's ID and name
pub fn channel_from_page(html: &str, video: bool) -> Option<(String, String)> {
    let cap = |re: &str, text: &str| Regex::new(re).unwrap().captures(text).map(|c| c[1].to_string());
    if video {
        let block = cap(r#"(?s)"videoDetails":\{(.{0,4000}?)"thumbnail""#, html).unwrap_or_else(|| html.to_string());
        let id = cap(r#""channelId":"(UC[\w-]{22})""#, &block).or_else(|| cap(r#"itemprop="channelId" content="(UC[\w-]{22})""#, html))?;
        let name = cap(r#""author":"((?:[^"\\]|\\.)*)""#, &block).or_else(|| cap(r#""ownerChannelName":"((?:[^"\\]|\\.)*)""#, html));
        return Some((id, name.map(|n| unescape(&n)).unwrap_or_default()));
    }
    let id = cap(r#"<link rel="canonical" href="https://www\.youtube\.com/channel/(UC[\w-]{22})""#, html)
        .or_else(|| cap(r#"<meta property="og:url" content="https://www\.youtube\.com/channel/(UC[\w-]{22})""#, html))
        .or_else(|| cap(r#""externalId":"(UC[\w-]{22})""#, html))
        .or_else(|| cap(r#""channelId":"(UC[\w-]{22})""#, html))?;
    let name = cap(r#"<meta property="og:title" content="([^"]*)""#, html).or_else(|| cap(r#""channelMetadataRenderer":\{"title":"((?:[^"\\]|\\.)*)""#, html));
    Some((id, name.map(|n| unescape(&n)).unwrap_or_default()))
}

/// Look a pasted channel up: { ok, id, name } or { ok: false, error }.
/// When YouTube's page can't be read, yt-dlp has a go.
#[tauri::command]
pub async fn channels_resolve(input: String) -> Value {
    let input: String = input.chars().take(500).collect();
    let Some(p) = parse_channel(&input) else { return json!({ "ok": false, "error": "that isn't a YouTube channel link, @handle or video link" }) };
    let (page, video, pasted_id) = match &p {
        Parsed::Id(id) => (format!("https://www.youtube.com/channel/{}", id), false, Some(id.clone())),
        Parsed::Page { page, video, .. } => (page.clone(), *video, None),
    };
    let mut found = None;
    let mut missing = false;
    match crate::chat::youtube_page(&page).await {
        Ok((404, _)) => missing = true,
        Ok((_, html)) => found = channel_from_page(&html, video),
        Err(_) => {} // offline, or YouTube said no: try yt-dlp
    }
    if found.is_none() && !missing {
        found = crate::downloader::channel_of(&page, video).await.ok().flatten();
    }
    // an ID that was pasted stays good even when its name couldn't be looked up
    if found.is_none() && !missing {
        if let Some(id) = pasted_id { return json!({ "ok": true, "id": id, "name": "" }); }
    }
    match found {
        Some((id, name)) if id_re().is_match(&id) => {
            let name: String = Regex::new(r"[\r\n#]+").unwrap().replace_all(&name, " ").trim().chars().take(100).collect();
            json!({ "ok": true, "id": id, "name": name })
        }
        _ => json!({ "ok": false, "error": if missing { "that channel wasn't found" } else { "couldn't look that channel up (are you online?)" } }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keys() {
        assert_eq!(channel_key("UC_aEa8K-EOJ3D6gOs7HcyNg  # NoCopyrightSounds"), "uc_aea8k-eoj3d6gos7hcyng");
        assert_eq!(channel_key("https://www.youtube.com/@NoCopyrightSounds"), "nocopyrightsounds");
        assert_eq!(channel_key("@Name"), "name");
        assert_eq!(channel_key("Some Name"), "some name");
        assert!(matches!(parse_channel("youtu.be/dQw4w9WgXcQ"), Some(Parsed::Page { video: true, .. })));
    }
}
