//! !nowplaying and song requests in your Discord server, as slash commands: /nowplaying, /sr,
//! /queue, /skip, /wrongsong, /uptime and /aboutme (the same as !… in the YouTube chat),
//! answered by your own bot. You make the bot once in Discord's developer portal, paste its
//! token here, and add it to your server. moonlit connects to Discord's gateway (the live
//! connection every bot uses), adds the commands to each server the bot is in, and answers them.
//! Mods: the server's owner and anyone whose roles can manage messages (or the server).

use crate::{chat, config, emit, overlay, secrets};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

// only "guilds": slash commands reach the bot without reading anyone's messages
const INTENTS: u64 = 1 << 0;
// what the bot needs in a channel: view channels, send messages
pub const INVITE_PERMISSIONS: u64 = 1024 | 2048;
const ADMINISTRATOR: u64 = 1 << 3;
const MANAGE_GUILD: u64 = 1 << 5;
const MANAGE_MESSAGES: u64 = 1 << 13;
const MODERATE_MEMBERS: u64 = 1 << 40;

fn api() -> String {
    #[cfg(debug_assertions)]
    if let Ok(u) = std::env::var("MOONLIT_DISCORD_API") { return u; }
    "https://discord.com/api/v10".into()
}
fn gateway() -> String {
    #[cfg(debug_assertions)]
    if let Ok(u) = std::env::var("MOONLIT_DISCORD_GATEWAY") { return u; }
    "wss://gateway.discord.gg/?v=10&encoding=json".into()
}

#[derive(Default, Clone)]
struct Guild { owner: String }

struct Bot {
    run: AtomicU64,
    status: Mutex<Value>,
    token: Mutex<String>,
    me: Mutex<(String, String)>, // the bot's app id (for the invite link and answers) and name
    guilds: Mutex<HashMap<String, Guild>>,
    answered: Mutex<HashSet<String>>, // commands that already have their first answer
}

fn bot() -> &'static Bot {
    static B: OnceLock<Bot> = OnceLock::new();
    B.get_or_init(|| Bot {
        run: AtomicU64::new(0),
        status: Mutex::new(json!({ "text": "off", "kind": "off" })),
        token: Mutex::new(String::new()),
        me: Mutex::new((String::new(), String::new())),
        guilds: Mutex::new(HashMap::new()),
        answered: Mutex::new(HashSet::new()),
    })
}
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> { m.lock().unwrap_or_else(|e| e.into_inner()) }

fn set_status(text: &str, kind: &str) {
    let s = json!({ "text": text, "kind": kind });
    *lock(&bot().status) = s.clone();
    emit("discord:status", s);
}
fn current(me: u64) -> bool { bot().run.load(Ordering::SeqCst) == me }

/* ───────────── what the user typed ───────────── */
/// A channel's ID from what was pasted: the ID itself, its link (…/channels/server/channel) or <#id>.
pub fn parse_channel(input: &str) -> Option<String> {
    let t = input.trim().trim_start_matches("<#").trim_end_matches('>').trim_end_matches('/');
    let last = t.rsplit('/').next().unwrap_or("");
    let ok = (15..=22).contains(&last.len()) && last.chars().all(|c| c.is_ascii_digit());
    ok.then(|| last.to_string())
}

/// The token as Discord shows it (people sometimes copy "Bot " in front, or quotes around it).
pub fn clean_token(input: &str) -> String {
    let t = input.trim().trim_matches(|c| c == '"' || c == '\'').trim();
    let t = t.strip_prefix("Bot ").or_else(|| t.strip_prefix("bot ")).unwrap_or(t);
    t.trim().to_string()
}

fn is_mod(perms: u64) -> bool {
    perms & (ADMINISTRATOR | MANAGE_GUILD | MANAGE_MESSAGES | MODERATE_MEMBERS) != 0
}

/// the slash commands, as Discord lists them when you type "/"
fn commands() -> Value {
    let plain = |name: &str, description: &str| json!({ "name": name, "description": description, "type": 1 });
    json!([
        plain("nowplaying", "the song that's playing right now"),
        { "name": "sr", "type": 1, "description": "request a song: from the library, or YouTube",
          "options": [{ "type": 3, "name": "song", "description": "a song name or a YouTube link", "required": true, "max_length": 300 }] },
        plain("queue", "the next requested songs"),
        plain("skip", "skip the song that's playing (mods)"),
        plain("wrongsong", "take back your last request"),
        plain("uptime", "how long the stream has been live"),
        plain("aboutme", "where the music comes from"),
    ])
}

/* ───────────── settings ───────────── */
fn settings() -> (bool, String, String) {
    let c = config::get("discord");
    let enabled = c.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
    let channel = c.get("channel").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let token = secrets::unseal(c.get("token").unwrap_or(&Value::Null));
    (enabled, token, channel)
}

pub fn start_saved() {
    let (enabled, token, _) = settings();
    let me = bot().run.fetch_add(1, Ordering::SeqCst) + 1;
    lock(&bot().guilds).clear();
    if !enabled { return set_status("off", "off"); }
    if token.is_empty() { return set_status("paste your bot's token", "warn"); }
    *lock(&bot().token) = token;
    set_status("connecting to Discord…", "wait");
    tauri::async_runtime::spawn(async move { keep_connected(me).await });
}

enum After { Retry, Stop }

async fn keep_connected(me: u64) {
    let mut wait = 5u64;
    loop {
        if !current(me) { return; }
        set_status("connecting to Discord…", "wait");
        let started = std::time::Instant::now();
        let after = connect(me).await;
        if !current(me) { return; }
        lock(&bot().guilds).clear();
        if let After::Stop = after { return; }
        // a connection that lasted a while starts over from a short wait
        if started.elapsed() > Duration::from_secs(120) { wait = 5; }
        tokio::time::sleep(Duration::from_secs(wait)).await;
        wait = (wait * 2).min(60);
    }
}

fn guild_count_status() {
    let n = lock(&bot().guilds).len();
    let name = lock(&bot().me).1.clone();
    let who = if name.is_empty() { "the bot".to_string() } else { name };
    if n == 0 {
        set_status(&format!("{} is online, but not in a server yet: add it to your server", who), "wait");
    } else {
        let (_, _, channel) = settings();
        let wher = if channel.is_empty() { format!("{} server{}", n, if n == 1 { "" } else { "s" }) } else { "your channel".to_string() };
        set_status(&format!("{} is answering commands in {} ✓", who, wher), "on");
    }
}

/// One gateway connection, until it closes.
async fn connect(me: u64) -> After {
    let token = lock(&bot().token).clone();
    let (ws, _) = match tokio_tungstenite::connect_async(gateway()).await {
        Ok(x) => x,
        Err(e) => { set_status(&format!("couldn't reach Discord ({}), trying again soon", short(&e.to_string())), "warn"); return After::Retry; }
    };
    let (mut tx, mut rx) = ws.split();
    let mut seq: Value = Value::Null;
    let mut beat = Duration::from_secs(40);
    let mut next_beat = tokio::time::Instant::now() + beat;
    let mut acked = true;
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            msg = rx.next() => {
                let msg = match msg {
                    Some(Ok(m)) => m,
                    Some(Err(e)) => { set_status(&format!("lost Discord ({}), reconnecting", short(&e.to_string())), "warn"); return After::Retry; }
                    None => { set_status("lost Discord, reconnecting", "warn"); return After::Retry; }
                };
                let text = match msg {
                    Message::Text(t) => t,
                    Message::Close(frame) => return closed(frame.map(|f| u16::from(f.code)).unwrap_or(0)),
                    _ => continue,
                };
                let Ok(p) = serde_json::from_str::<Value>(&text) else { continue };
                if !p["s"].is_null() { seq = p["s"].clone(); }
                match p["op"].as_u64().unwrap_or(99) {
                    10 => {
                        // hello: how often to send a heartbeat, then who we are
                        beat = Duration::from_millis(p["d"]["heartbeat_interval"].as_u64().unwrap_or(41_250));
                        let first = beat.mul_f64(rand::random::<f64>());
                        next_beat = tokio::time::Instant::now() + first;
                        let identify = json!({ "op": 2, "d": {
                            "token": token, "intents": INTENTS,
                            "properties": { "os": std::env::consts::OS, "browser": "moonlit", "device": "moonlit" },
                        }});
                        if tx.send(Message::Text(identify.to_string())).await.is_err() { return After::Retry; }
                    }
                    11 => acked = true,
                    1 => { let _ = tx.send(Message::Text(json!({ "op": 1, "d": seq }).to_string())).await; }
                    7 => return After::Retry, // Discord asks us to reconnect
                    9 => { tokio::time::sleep(Duration::from_secs(2)).await; return After::Retry; } // session invalid
                    0 => dispatch(p["t"].as_str().unwrap_or(""), &p["d"]).await,
                    _ => {}
                }
            }
            _ = tokio::time::sleep_until(next_beat) => {
                if !acked { set_status("Discord stopped answering, reconnecting", "warn"); return After::Retry; }
                acked = false;
                if tx.send(Message::Text(json!({ "op": 1, "d": seq }).to_string())).await.is_err() { return After::Retry; }
                next_beat = tokio::time::Instant::now() + beat;
            }
            _ = tick.tick() => {
                if !current(me) { let _ = tx.send(Message::Close(None)).await; return After::Stop; }
            }
        }
    }
}

fn short(e: &str) -> String { e.chars().take(120).collect() }

fn closed(code: u16) -> After {
    let stop = |m: &str| { set_status(m, "warn"); After::Stop };
    match code {
        4004 => stop("Discord didn't take the token. copy it again (Bot → Reset Token) and save"),
        4013 | 4012 | 4011 | 4010 => stop(&format!("Discord closed the connection (code {}). update moonlit", code)),
        _ => { set_status("Discord closed the connection, reconnecting", "warn"); After::Retry }
    }
}

async fn dispatch(kind: &str, d: &Value) {
    match kind {
        "READY" => {
            let id = d["application"]["id"].as_str().or(d["user"]["id"].as_str()).unwrap_or("").to_string();
            let name = d["user"]["username"].as_str().unwrap_or("").to_string();
            *lock(&bot().me) = (id, name);
            emit("discord:status", lock(&bot().status).clone()); // the page refreshes the invite link
            guild_count_status();
        }
        "GUILD_CREATE" => {
            let Some(id) = d["id"].as_str() else { return };
            lock(&bot().guilds).insert(id.to_string(), Guild { owner: d["owner_id"].as_str().unwrap_or("").to_string() });
            guild_count_status();
            let id = id.to_string();
            tauri::async_runtime::spawn(async move { add_commands(&id).await });
        }
        "GUILD_UPDATE" => {
            let Some(id) = d["id"].as_str() else { return };
            lock(&bot().guilds).insert(id.to_string(), Guild { owner: d["owner_id"].as_str().unwrap_or("").to_string() });
        }
        "GUILD_DELETE" => {
            if let Some(id) = d["id"].as_str() { lock(&bot().guilds).remove(id); }
            guild_count_status();
        }
        "INTERACTION_CREATE" => on_command(d).await,
        _ => {}
    }
}

/// puts the slash commands in a server (they show up right away there)
async fn add_commands(guild: &str) {
    let app = lock(&bot().me).0.clone();
    let token = lock(&bot().token).clone();
    if app.is_empty() || token.is_empty() { return; }
    let res = http().put(format!("{}/applications/{}/guilds/{}/commands", api(), app, guild))
        .header("Authorization", format!("Bot {}", token)).json(&commands()).send().await;
    match res {
        Ok(r) if r.status().is_success() => {}
        Ok(r) if r.status().as_u16() == 403 => set_status("the bot can't add its / commands: add it to your server again with the link below", "warn"),
        Ok(r) => set_status(&format!("couldn't add the / commands (Discord said {})", r.status().as_u16()), "warn"),
        Err(e) => set_status(&format!("couldn't add the / commands ({})", short(&e.to_string())), "warn"),
    }
}

async fn on_command(d: &Value) {
    if d["type"].as_u64() != Some(2) { return; } // only slash commands
    let id = d["id"].as_str().unwrap_or("").to_string();
    let token = d["token"].as_str().unwrap_or("").to_string();
    let Some(guild_id) = d["guild_id"].as_str() else { return };
    if id.is_empty() || token.is_empty() { return; }
    let channel = d["channel_id"].as_str().unwrap_or("");
    let (_, _, only) = settings();
    if !only.is_empty() && only != channel {
        // only the person who asked sees this
        let body = json!({ "type": 4, "data": { "content": format!("I only answer in <#{}>.", only), "flags": 64, "allowed_mentions": { "parse": [] } } });
        let _ = http().post(format!("{}/interactions/{}/{}/callback", api(), id, token)).json(&body).send().await;
        return;
    }
    let cmd = d["data"]["name"].as_str().unwrap_or("").to_string();
    let args: String = d["data"]["options"].as_array().into_iter().flatten()
        .find(|o| o["name"] == "song").and_then(|o| o["value"].as_str()).unwrap_or("").trim().chars().take(300).collect();
    // "thinking…" first: Discord wants an answer within 3 seconds, downloads take longer
    let deferred = http().post(format!("{}/interactions/{}/{}/callback", api(), id, token)).json(&json!({ "type": 5 })).send().await;
    if !deferred.map(|r| r.status().is_success()).unwrap_or(false) { return; }
    let to = json!({ "token": token });
    // nothing should stay "thinking…": after 14 minutes (Discord allows 15), say so
    let t = token.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(14 * 60)).await;
        if !lock(&bot().answered).remove(&t) { say(&json!({ "token": t }), "couldn't answer that one, sorry.").await; }
        lock(&bot().answered).remove(&t);
    });
    if cmd == "nowplaying" {
        return say(&to, &chat::reply_for(&overlay::get().now())).await;
    }
    if !["sr", "queue", "skip", "wrongsong", "uptime", "aboutme"].contains(&cmd.as_str()) {
        return say(&to, "moonlit doesn't know that command.").await;
    }
    let user = if d["member"]["user"].is_object() { &d["member"]["user"] } else { &d["user"] };
    let author_id = user["id"].as_str().unwrap_or("").to_string();
    let owner = lock(&bot().guilds).get(guild_id).map(|g| !g.owner.is_empty() && g.owner == author_id).unwrap_or(false);
    let perms = d["member"]["permissions"].as_str().and_then(|p| p.parse::<u64>().ok()).unwrap_or(0);
    let name = [&d["member"]["nick"], &user["global_name"], &user["username"]]
        .iter().find_map(|v| v.as_str().filter(|s| !s.is_empty())).unwrap_or("someone").to_string();
    // the player answers these (it knows the library, the queue and OBS), back to this command
    emit("chat:command", json!({
        "cmd": cmd, "args": args,
        "user": { "id": format!("discord:{}", author_id), "name": name, "mod": owner || is_mod(perms), "owner": owner },
        "to": { "discord": to },
    }));
}

/* ───────────── answering ───────────── */
fn http() -> reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| reqwest::Client::builder()
        .user_agent(concat!("DiscordBot (https://github.com/elliesxofc/musicplayer, ", env!("CARGO_PKG_VERSION"), ")"))
        .timeout(Duration::from_secs(20))
        .build().unwrap_or_default()).clone()
}

/// The answer to a slash command (Discord allows 2000 characters; longer answers go in parts).
/// The first fills in the "thinking…" message, more come after it. Nobody gets pinged, not even
/// by an @everyone inside a song's name.
pub async fn say(to: &Value, text: &str) {
    let token = to["token"].as_str().unwrap_or("").to_string();
    let app = lock(&bot().me).0.clone();
    let ok = |s: &str| !s.is_empty() && s.len() < 1000 && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    if !ok(&token) || app.is_empty() { return; }
    let text: String = text.chars().take(4000).collect();
    for part in chat::split_message(&text, 1900) {
        let first = lock(&bot().answered).insert(token.clone());
        let body = json!({ "content": part, "allowed_mentions": { "parse": [] } });
        let hook = format!("{}/webhooks/{}/{}", api(), app, token);
        for _attempt in 0..2 {
            let req = if first { http().patch(format!("{}/messages/@original", hook)) } else { http().post(&hook) };
            match req.json(&body).send().await {
                Ok(r) if r.status().is_success() => break,
                Ok(r) if r.status().as_u16() == 429 => {
                    let v: Value = r.json().await.unwrap_or(Value::Null);
                    let secs = v["retry_after"].as_f64().unwrap_or(1.0).clamp(0.1, 10.0);
                    tokio::time::sleep(Duration::from_secs_f64(secs)).await;
                }
                Ok(r) => { set_status(&format!("couldn't answer a command (Discord said {})", r.status().as_u16()), "warn"); return; }
                Err(e) => { set_status(&format!("couldn't answer a command ({})", short(&e.to_string())), "warn"); return; }
            }
        }
    }
}

/* ───────────── what the page asks ───────────── */
#[tauri::command]
pub fn discord_get() -> Value {
    let (enabled, token, channel) = settings();
    let app = lock(&bot().me).0.clone();
    let invite = if app.is_empty() { String::new() } else {
        format!("https://discord.com/oauth2/authorize?client_id={}&scope=bot+applications.commands&permissions={}", app, INVITE_PERMISSIONS)
    };
    json!({ "enabled": enabled, "hasToken": !token.is_empty(), "channel": channel, "invite": invite, "status": lock(&bot().status).clone() })
}

// token: a new one to save, '' to forget it, or left out to keep the saved one
#[tauri::command]
pub fn discord_set(next: Value) -> Value {
    let Some(next) = next.as_object() else { return Value::Null };
    let mut c = config::get("discord");
    if !c.is_object() { c = json!({}); }
    if let Some(b) = next.get("enabled").and_then(|v| v.as_bool()) { c["enabled"] = json!(b); }
    if let Some(s) = next.get("token").and_then(|v| v.as_str()) {
        let t = clean_token(s);
        c["token"] = if t.is_empty() { Value::Null } else { secrets::seal(&t) };
    }
    if let Some(s) = next.get("channel").and_then(|v| v.as_str()) {
        let s = s.trim();
        match parse_channel(s) {
            Some(id) => c["channel"] = json!(id),
            None if s.is_empty() => c["channel"] = json!(""),
            None => {
                set_status("that channel isn't a channel link or ID (right-click the channel → Copy Link)", "warn");
                return discord_get();
            }
        }
    }
    config::set("discord", c);
    start_saved();
    discord_get()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channels() {
        assert_eq!(parse_channel("https://discord.com/channels/111111111111111111/222222222222222222").as_deref(), Some("222222222222222222"));
        assert_eq!(parse_channel(" 222222222222222222 ").as_deref(), Some("222222222222222222"));
        assert_eq!(parse_channel("<#222222222222222222>").as_deref(), Some("222222222222222222"));
        assert_eq!(parse_channel("general"), None);
        assert_eq!(parse_channel(""), None);
    }

    #[test]
    fn tokens() {
        assert_eq!(clean_token(" Bot abc.def.ghi "), "abc.def.ghi");
        assert_eq!(clean_token("\"abc.def\""), "abc.def");
    }

    #[test]
    fn mods() {
        assert!(!is_mod(1024 | 2048));
        assert!(is_mod(MANAGE_MESSAGES | 1024));
        assert!(is_mod(ADMINISTRATOR));
    }

    #[test]
    fn command_list() {
        let c = commands();
        let names: Vec<&str> = c.as_array().unwrap().iter().map(|x| x["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["nowplaying", "sr", "queue", "skip", "wrongsong", "uptime", "aboutme"]);
        for x in c.as_array().unwrap() { assert!(x["description"].as_str().unwrap().len() <= 100); }
    }
}
