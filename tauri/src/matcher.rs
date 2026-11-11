//! Picks the YouTube result that really is this Spotify song. The title has to match (an
//! artist's other songs never win just for being on their official channel), then version,
//! length, artist and official uploads decide between candidates. Live / cover / sped-up
//! versions lose unless the Spotify song itself is one. When nothing matches well enough it
//! returns None, so we say "couldn't find it" rather than grab a wrong song.

use regex::Regex;
use serde_json::Value;
use std::collections::HashSet;
use unicode_normalization::UnicodeNormalization;

const MIN_SCORE: f64 = 10.0;
const FILLER: [&str; 16] = ["official", "audio", "video", "music", "lyric", "lyrics", "visualizer", "visualiser", "mv", "hd", "hq", "4k", "ft", "feat", "featuring", "with"];

fn odd() -> Regex {
    Regex::new(r"(?i)\b(live|cover|karaoke|instrumental|remix|sped ?up|slowed|nightcore|8d|reverb|bass ?boost(ed)?|1 ?hour|loop|acoustic)\b").unwrap()
}

/// lower case, accents off, only letters and numbers, as words
pub fn tokens(s: &str) -> Vec<String> {
    let low: String = s.to_lowercase().nfkd().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).collect();
    let re = Regex::new(r"[^\p{L}\p{N}]+").unwrap();
    re.replace_all(&low, " ").split_whitespace().map(String::from).collect()
}

// Spotify's "Love for You (feat. ovg!) - Remastered" → "love for you"
fn song_words(title: &str) -> Vec<String> {
    let a = Regex::new(r"\s*[\(\[][^\)\]]*[\)\]]").unwrap().replace_all(title, " ").to_string();
    let b = Regex::new(r"\s+-\s+.*$").unwrap().replace(&a, " ").to_string();
    tokens(&b)
}

pub struct Song<'a> {
    pub title: &'a str,
    pub artist: &'a str,
    pub duration_ms: f64,
}

fn s(e: &Value, k: &str) -> String { e.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string() }

pub fn score(e: &Value, song: &Song) -> f64 {
    let want = song.duration_ms / 1000.0;
    let raw = s(e, "title").to_lowercase();
    let channel = { let c = s(e, "channel"); if c.is_empty() { s(e, "uploader") } else { c } }.to_lowercase();
    let artist_names: Vec<String> = Regex::new(r",|&").unwrap().split(&song.artist.to_lowercase()).map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect();
    let artist_words: HashSet<String> = artist_names.iter().flat_map(|a| tokens(a)).collect();
    let title = song_words(song.title);
    let have = tokens(&s(e, "title"));
    let have_set: HashSet<&String> = have.iter().collect();

    // how much of the song's name is in the result's title, as whole words
    let coverage = if title.is_empty() { 0.0 } else { title.iter().filter(|w| have_set.contains(w)).count() as f64 / title.len() as f64 };
    // what's left of the result title once the artist's name and words like "official audio" are removed
    let core = have.iter().filter(|w| !artist_words.contains(*w) && !FILLER.contains(&w.as_str()) && w.as_str() != "topic").cloned().collect::<Vec<_>>().join(" ");

    let mut score = 0.0;
    if coverage >= 0.999 { score += 40.0 } else if coverage >= 0.6 { score += 10.0 } else { score -= 80.0 } // a different song
    if core == title.join(" ") { score += 15.0 } // nothing extra in the title: not a remix, not a medley…
    let listed: Vec<String> = e.get("artists").and_then(|a| a.as_array()).cloned().unwrap_or_default().iter().map(|a| a.as_str().map(String::from).unwrap_or_else(|| a.to_string()).to_lowercase()).collect();
    if !artist_names.is_empty() && (artist_names.iter().any(|a| channel.contains(a) || raw.contains(a)) || listed.iter().any(|a| artist_names.contains(a))) {
        score += 15.0;
    }
    if coverage >= 0.999 && channel.ends_with(" - topic") { score += 20.0 } // YouTube Music's official audio
    if coverage >= 0.999 && e.get("fromMusic").and_then(|v| v.as_bool()).unwrap_or(false) { score += 15.0 } // a YouTube Music "song" result
    if raw.contains("official audio") { score += 10.0 }
    if Regex::new(r"\blyrics?\b").unwrap().is_match(&raw) { score -= 5.0 } // usually fan re-uploads
    // music videos often run long (intros, outros), so length nudges rather than decides
    let dur = e.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);
    if want > 0.0 && dur > 0.0 { score -= (dur - want).abs().min(45.0) }
    let song_odd = odd().find(song.title).map(|m| m.as_str().to_lowercase());
    let result_odd = odd().find(&raw).map(|m| m.as_str().to_lowercase());
    if result_odd.is_some() && song_odd.is_none() { score -= 100.0 } // e.g. a live recording when the album has the studio song
    if let (Some(a), Some(b)) = (&song_odd, &result_odd) { if a == b { score += 20.0 } } // the version we want
    score
}

// `used`: videos already picked for other songs in the same album / playlist
pub fn pick<'a>(entries: &'a [Value], song: &Song, used: &HashSet<String>) -> Option<&'a Value> {
    let mut best = None;
    let mut best_score = f64::NEG_INFINITY;
    for e in entries {
        let id = s(e, "id");
        if id.is_empty() || used.contains(&id) { continue; }
        let sc = score(e, song);
        if sc > best_score { best_score = sc; best = Some(e); }
    }
    if best_score >= MIN_SCORE { best } else { None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn same_picks_as_javascript() {
        let song = Song { title: "Love for You (feat. ovg!) - Remastered", artist: "loveli lori, ovg!", duration_ms: 180000.0 };
        let e = vec![
            json!({"id":"a","title":"loveli lori - Love for You (Official Audio)","channel":"loveli lori","duration":181}),
            json!({"id":"b","title":"Love for You (Live)","channel":"loveli lori - Topic","duration":200}),
            json!({"id":"c","title":"Love for You","channel":"loveli lori - Topic","duration":179,"fromMusic":true}),
            json!({"id":"d","title":"Other song","channel":"x","duration":180}),
        ];
        let none = HashSet::new();
        assert_eq!(pick(&e, &song, &none).map(|v| v["id"].clone()), Some(json!("c")));
        assert_eq!(pick(&e[..2], &song, &none).map(|v| v["id"].clone()), Some(json!("a")));
        assert!(pick(&e[3..], &song, &none).is_none());
        assert_eq!(crate::downloader::request_score(&json!({"title":"Song (Instrumental)","channel":"X"}), "song instrumental"), 12);
        assert_eq!(crate::downloader::request_score(&json!({"title":"Song Live at Wembley","channel":"Café"}), "song"), -3);
        assert_eq!(crate::downloader::tidy_artist("A ; B//C / D"), "A, B//C, D");
    }
}
