use crate::{http, storage, Result};
use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::Command;

const TOKEN: &str = "https://api.anthropic.com/v1/oauth/token";
const USAGE: &str = "https://api.anthropic.com/api/oauth/usage";
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
pub fn home() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("HOME is required")
}
pub fn text(path: &Path) -> String {
    fs::read_to_string(path)
        .unwrap_or_default()
        .trim()
        .to_owned()
}
pub fn state() -> Result<PathBuf> {
    Ok(home()?.join(".claude-relay"))
}
pub fn lock(dir: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(dir.join("credential.lock"))
        .map_err(|_| "cannot open credential lock")?;
    let started = std::time::Instant::now();
    while file.try_lock().is_err() {
        if started.elapsed() >= std::time::Duration::from_secs(30) {
            return Err("credential lock timed out");
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    Ok(file)
}
fn mac() -> bool {
    cfg!(target_os = "macos") && !http::fixture_mode()
}
pub fn live_read() -> Result<Value> {
    if mac() {
        let user = Command::new("whoami")
            .output()
            .map_err(|_| "cannot resolve credential owner")?;
        let user = String::from_utf8_lossy(&user.stdout);
        let result = Command::new("security")
            .args([
                "find-generic-password",
                "-s",
                "Claude Code-credentials",
                "-a",
                user.trim(),
                "-w",
            ])
            .output()
            .map_err(|_| "cannot read Keychain")?;
        if !result.status.success() {
            return Err("cannot read Keychain");
        }
        serde_json::from_slice(&result.stdout).map_err(|_| "invalid live credentials")
    } else {
        storage::read(&home()?.join(".claude/.credentials.json"))
    }
}
pub fn live_write(value: &Value) -> Result<()> {
    if mac() {
        let user = Command::new("whoami")
            .output()
            .map_err(|_| "cannot resolve credential owner")?;
        let user = String::from_utf8_lossy(&user.stdout);
        let content = serde_json::to_string(value).map_err(|_| "cannot encode credentials")?;
        // Retains the existing platform adapter; native Keychain API migration is pending.
        let result = Command::new("security")
            .args([
                "add-generic-password",
                "-U",
                "-s",
                "Claude Code-credentials",
                "-a",
                user.trim(),
                "-w",
                &content,
            ])
            .output()
            .map_err(|_| "cannot update Keychain")?;
        if !result.status.success() {
            return Err("cannot update Keychain");
        }
        Ok(())
    } else {
        storage::write(&home()?.join(".claude/.credentials.json"), value)
    }
}
pub fn refresh(path: &Path, observed: &Value, force: bool) -> Result<String> {
    let dir = path
        .parent()
        .and_then(Path::parent)
        .ok_or("invalid credential path")?;
    let _lock = lock(dir)?;
    let mut value = storage::read(path)?;
    let old = value["claudeAiOauth"]["accessToken"]
        .as_str()
        .unwrap_or_default();
    // Another process may already have rotated this single-use refresh token.
    if !old.is_empty()
        && (value["claudeAiOauth"]["accessToken"] != observed["claudeAiOauth"]["accessToken"]
            || value["claudeAiOauth"]["refreshToken"] != observed["claudeAiOauth"]["refreshToken"])
    {
        return Ok(old.to_owned());
    }
    let expires = value["claudeAiOauth"]["expiresAt"].as_i64().unwrap_or(0);
    if !force && expires > now_ms() + 300_000 && !old.is_empty() {
        return Ok(old.to_owned());
    }
    let refresh = value["claudeAiOauth"]["refreshToken"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("missing refresh token")?;
    let body = format!(
        "grant_type=refresh_token&refresh_token={}&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        http::encode(refresh)
    );
    let (status, response) = http::json(TOKEN, None, Some(body), 10)?;
    if !(200..300).contains(&status) {
        return Err("refresh request rejected");
    }
    let token = response["access_token"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("invalid refresh response")?
        .to_owned();
    let expiry = response
        .get("expires_in")
        .map_or(Some(3600), Value::as_i64)
        .ok_or("invalid expiry")?;
    let expires = expiry
        .checked_mul(1000)
        .and_then(|n| now_ms().checked_add(n))
        .ok_or("expiry overflow")?;
    let oauth = value
        .get_mut("claudeAiOauth")
        .and_then(Value::as_object_mut)
        .ok_or("invalid OAuth object")?;
    oauth.insert("accessToken".into(), json!(token));
    if let Some(refresh) = response.get("refresh_token") {
        if !refresh.is_string() {
            return Err("invalid rotated token");
        }
        oauth.insert("refreshToken".into(), refresh.clone());
    }
    oauth.insert("expiresAt".into(), json!(expires));
    storage::write(path, &value)?;
    if path.file_stem().and_then(|s| s.to_str()) == Some(text(&dir.join("current")).as_str()) {
        live_write(&value)?;
    }
    Ok(token)
}

pub fn usage(path: &Path, cache: bool, retry: bool) -> Result<Value> {
    let mut value = storage::read(path)?;
    let mut token = value["claudeAiOauth"]["accessToken"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("missing access token")?
        .to_owned();
    let expires = value["claudeAiOauth"]["expiresAt"].as_i64().unwrap_or(0);
    let mut refreshed = false;
    if expires != 0 && now_ms() > expires.saturating_sub(300_000) {
        match refresh(path, &value, false) {
            Ok(next) => {
                token = next;
                refreshed = true;
                value = storage::read(path)?;
            }
            Err(_) if now_ms() > expires => return Ok(json!("expired")),
            Err(_) => (),
        }
    }
    let dir = path
        .parent()
        .and_then(Path::parent)
        .ok_or("invalid credential path")?;
    let name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("invalid account name")?;
    let cache_path = dir.join("usage_cache.json");
    if cache && !refreshed {
        if let Ok(cached) = storage::read(&cache_path) {
            if let Some(ts) = cached[name]["ts"].as_f64() {
                if now_ms() as f64 / 1000.0 - ts < 120.0 {
                    return Ok(cached[name]["data"].clone());
                }
            }
        }
    }
    let (mut status, mut data) = http::json(USAGE, Some(&token), None, if cache { 6 } else { 8 })?;
    if status == 401 && retry {
        if let Ok(next) = refresh(path, &value, true) {
            (status, data) = http::json(USAGE, Some(&next), None, 6)?;
        }
    }
    if status == 401 {
        return Ok(json!("expired"));
    }
    if !(200..300).contains(&status) {
        return Err("usage request rejected");
    }
    if cache {
        let _lock = storage::lock_config(&cache_path)?;
        let mut cached = storage::read(&cache_path)
            .ok()
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        cached[name] = json!({"ts": now_ms() as f64 / 1000.0, "data":data});
        storage::write(&cache_path, &cached)?;
    }
    Ok(data)
}

pub fn names(creds: &Path) -> Result<Vec<String>> {
    let mut disk: Vec<String> = fs::read_dir(creds)
        .map_err(|_| "cannot list accounts")?
        .flatten()
        .filter_map(|e| {
            e.file_name()
                .to_str()
                .and_then(|s| s.strip_suffix(".json"))
                .map(str::to_owned)
        })
        .collect();
    disk.sort();
    let order = creds
        .parent()
        .ok_or("invalid account directory")?
        .join("order");
    let mut names = Vec::new();
    for name in text(&order)
        .lines()
        .map(str::trim)
        .chain(disk.iter().map(String::as_str))
    {
        if disk.iter().any(|s| s == name) && !names.iter().any(|s| s == name) {
            names.push(name.to_owned());
        }
    }
    storage::write_bytes(
        &order,
        (names.join("\n") + if names.is_empty() { "" } else { "\n" }).as_bytes(),
    )?;
    Ok(names)
}

pub fn switch(name: &str) -> Result<()> {
    let dir = state()?;
    let _lock = lock(&dir)?;
    switch_locked(&dir, name)
}

pub fn restore_if_current(expected: &str, name: &str) -> Result<bool> {
    let dir = state()?;
    let _lock = lock(&dir)?;
    if text(&dir.join("current")) != expected {
        return Ok(false);
    }
    switch_locked(&dir, name)?;
    Ok(true)
}

fn switch_locked(dir: &Path, name: &str) -> Result<()> {
    let current = text(&dir.join("current"));
    // Both callers hold credential.lock. The live store may contain a newer
    // token than this account's snapshot; same-account switching is a no-op.
    // Do not even read the snapshot or rewrite live/current in this case.
    if current == name {
        return Ok(());
    }
    let target = storage::read(&dir.join("credentials").join(format!("{name}.json")))?;
    if !current.is_empty()
        && dir
            .join("credentials")
            .join(format!("{current}.json"))
            .is_file()
    {
        if let Ok(live) = live_read() {
            storage::write(
                &dir.join("credentials").join(format!("{current}.json")),
                &live,
            )?;
        }
    }
    live_write(&target)?;
    storage::write_bytes(&dir.join("current"), name.as_bytes())
}

pub fn sync_current() -> Result<()> {
    let dir = state()?;
    let _lock = lock(&dir)?;
    let current = text(&dir.join("current"));
    let path = dir.join("credentials").join(format!("{current}.json"));
    if current.is_empty() || !path.is_file() {
        return Ok(());
    }
    if let Ok(live) = live_read() {
        storage::write(&path, &live)?;
    }
    Ok(())
}
