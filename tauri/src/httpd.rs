//! A very small HTTP/1.1 server helper for moonlit's local-only pages (the OBS overlay, the
//! Spotify sign-in answer, the library move). Only 127.0.0.1, only what those need.

use std::collections::HashMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

pub struct Request {
    pub method: String,
    pub path: String,
    pub query: HashMap<String, String>,
    pub headers: HashMap<String, String>,
    /// bytes of the body that arrived together with the headers
    pub early_body: Vec<u8>,
}

impl Request {
    pub fn q(&self, k: &str) -> Option<&str> {
        self.query.get(k).map(|s| s.as_str())
    }
    pub fn content_length(&self) -> usize {
        self.headers.get("content-length").and_then(|v| v.trim().parse().ok()).unwrap_or(0)
    }
}

pub fn parse_query(q: &str) -> HashMap<String, String> {
    url::form_urlencoded::parse(q.as_bytes()).into_owned().collect()
}

/// Reads the request line and headers (at most 32 KB).
pub async fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 4096];
    let end = loop {
        let n = tokio::time::timeout(std::time::Duration::from_secs(15), stream.read(&mut chunk)).await.ok()?.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        if buf.len() > 32 * 1024 {
            return None;
        }
    };
    let head = String::from_utf8_lossy(&buf[..end]).to_string();
    let early_body = buf[end + 4..].to_vec();
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let method = first.next()?.to_string();
    let target = first.next()?.to_string();
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), parse_query(q)),
        None => (target.clone(), HashMap::new()),
    };
    let mut headers = HashMap::new();
    for l in lines {
        if let Some((k, v)) = l.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    Some(Request { method, path, query, headers, early_body })
}

pub fn status_text(code: u16) -> &'static str {
    match code {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        _ => "Error",
    }
}

pub async fn respond(stream: &mut TcpStream, code: u16, headers: &[(&str, &str)], body: &[u8]) {
    let mut head = format!("HTTP/1.1 {} {}\r\nContent-Length: {}\r\nConnection: close\r\n", code, status_text(code), body.len());
    for (k, v) in headers {
        head.push_str(k);
        head.push_str(": ");
        head.push_str(v);
        head.push_str("\r\n");
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body).await;
    let _ = stream.flush().await;
    let _ = stream.shutdown().await;
}
