//! Secrets kept in desktop.json (the chat bot's login, the Spotify connection), locked with
//! Windows' own protection (DPAPI: only your Windows account on this PC can unlock them).
//! Secrets saved by the Electron version of moonlit (Electron's safeStorage) are read too.

#[allow(unused_imports)]
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};

pub fn seal(text: &str) -> Value {
    if text.is_empty() {
        return Value::Null;
    }
    #[cfg(windows)]
    if let Some(enc) = dpapi::protect(text.as_bytes()) {
        return json!({ "dpapi": B64.encode(enc) });
    }
    json!({ "plain": text })
}

pub fn unseal(boxed: &Value) -> String {
    let Some(obj) = boxed.as_object() else { return String::new() };
    if let Some(p) = obj.get("plain").and_then(|v| v.as_str()) {
        return p.to_string();
    }
    #[cfg(windows)]
    {
        if let Some(d) = obj.get("dpapi").and_then(|v| v.as_str()) {
            return B64
                .decode(d)
                .ok()
                .and_then(|b| dpapi::unprotect(&b))
                .and_then(|b| String::from_utf8(b).ok())
                .unwrap_or_default();
        }
        if let Some(e) = obj.get("enc").and_then(|v| v.as_str()) {
            return electron::decrypt(e).unwrap_or_default();
        }
    }
    String::new()
}

#[cfg(windows)]
pub mod dpapi {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};

    fn run(data: &[u8], protect: bool) -> Option<Vec<u8>> {
        unsafe {
            let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
            let mut out = CRYPT_INTEGER_BLOB::default();
            let ok = if protect {
                CryptProtectData(&input, windows::core::w!("moonlit"), None, None, None, 0, &mut out)
            } else {
                CryptUnprotectData(&input, None, None, None, None, 0, &mut out)
            };
            ok.ok()?;
            let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            let _ = LocalFree(Some(HLOCAL(out.pbData as _)));
            Some(v)
        }
    }
    pub fn protect(data: &[u8]) -> Option<Vec<u8>> { run(data, true) }
    pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> { run(data, false) }
}

/// Electron's safeStorage on Windows: "v10" + 12-byte nonce + AES-256-GCM, with the key kept
/// (DPAPI-locked) in the old app's "Local State" file.
#[cfg(windows)]
mod electron {
    use super::*;
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};

    fn key() -> Option<Vec<u8>> {
        let dir = std::env::var_os("APPDATA")?;
        let text = std::fs::read_to_string(std::path::Path::new(&dir).join("moonlit").join("Local State")).ok()?;
        let v: Value = serde_json::from_str(&text).ok()?;
        let enc = B64.decode(v.pointer("/os_crypt/encrypted_key")?.as_str()?).ok()?;
        let enc = enc.strip_prefix(b"DPAPI")?;
        dpapi::unprotect(enc)
    }

    pub fn decrypt(b64: &str) -> Option<String> {
        let data = B64.decode(b64).ok()?;
        let rest = data.strip_prefix(b"v10")?;
        if rest.len() < 12 + 16 {
            return None;
        }
        let k = key()?;
        let cipher = Aes256Gcm::new_from_slice(&k).ok()?;
        let plain = cipher.decrypt(Nonce::from_slice(&rest[..12]), &rest[12..]).ok()?;
        String::from_utf8(plain).ok()
    }
}
