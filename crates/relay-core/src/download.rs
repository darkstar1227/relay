use crate::{http, storage, Result};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
fn version_valid(version: &str) -> bool {
    if version.is_empty()
        || version.len() > 128
        || !version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-+".contains(&b))
    {
        return false;
    }
    let suffix_valid = |s: &str| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
    };
    let mut base = version;
    if let Some((prefix, build)) = base.split_once('+') {
        if !suffix_valid(build) {
            return false;
        }
        base = prefix;
    }
    if let Some((prefix, pre)) = base.split_once('-') {
        if !suffix_valid(pre) {
            return false;
        }
        base = prefix;
    }
    let parts: Vec<_> = base.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
}

pub fn run(args: &[String]) -> Result<()> {
    let [path, version] = args else {
        return Err("invalid download arguments");
    };
    if !version_valid(version) {
        return Err("invalid release version");
    }
    let url = format!("https://raw.githubusercontent.com/darkstar1227/relay/v{version}/relay");
    let (status, content) = http::request(&url, None, None, 15, 8 * 1024 * 1024)?;
    if !(200..300).contains(&status) {
        return Err("download HTTP status failed");
    }
    if !content.starts_with(b"#!/usr/bin/env bash\n") {
        return Err("download is not a relay Bash script");
    }
    let script = std::str::from_utf8(&content).map_err(|_| "download is not UTF-8")?;
    for line in script.lines() {
        if let Some(embedded) = line
            .strip_prefix("RELAY_BUILD_VERSION='")
            .and_then(|s| s.strip_suffix('\''))
        {
            if embedded != version {
                return Err("downloaded script version mismatch");
            }
        }
    }
    let mut validator = Command::new("/bin/bash")
        .arg("-n")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "cannot validate Bash syntax")?;
    // Write on a separate thread so a `bash -n` that doesn't drain stdin fast
    // enough (content can exceed the OS pipe buffer) can't deadlock us against
    // a full pipe while we're blocked in write_all on the parent thread.
    let mut stdin = validator
        .stdin
        .take()
        .ok_or("cannot open validator input")?;
    let to_write = content.clone();
    let writer = std::thread::spawn(move || stdin.write_all(&to_write));
    let valid = validator
        .wait()
        .map_err(|_| "cannot wait for syntax validation")?;
    let wrote = writer.join().map_err(|_| "validator writer thread panicked")?;
    if wrote.is_err() || !valid.success() {
        return Err("downloaded script failed Bash syntax validation");
    }
    let path = Path::new(path);
    // Reuses storage's atomic private-temp-file/rename/fsync sequence, then
    // marks the installed script executable.
    storage::write_bytes(path, &content)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))
            .map_err(|_| "cannot set script mode")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn release_version_shape() {
        for value in ["2.9.2", "2.9.2-rc.1", "2.9.2+build.1", "2.9.2-rc.1+build"] {
            assert!(super::version_valid(value));
        }
        for value in [
            "2.9",
            "2.9.2-",
            "2.9.2+",
            "2.9.2+a+b",
            "../2.9.2",
            "2.9.2\n",
        ] {
            assert!(!super::version_valid(value));
        }
    }
}
