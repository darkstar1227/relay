use crate::{http, Result};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
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
    let wrote = validator
        .stdin
        .take()
        .ok_or("cannot open validator input")?
        .write_all(&content);
    let valid = validator
        .wait()
        .map_err(|_| "cannot wait for syntax validation")?;
    if wrote.is_err() || !valid.success() {
        return Err("downloaded script failed Bash syntax validation");
    }
    let path = Path::new(path);
    let parent = path.parent().ok_or("invalid script path")?;
    let (temporary, mut file) = (0..128)
        .find_map(|_| {
            let candidate = parent.join(format!(
                ".relay-update-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            options
                .open(&candidate)
                .ok()
                .map(|file| (Temporary(candidate), file))
        })
        .ok_or("cannot create private download file")?;
    file.write_all(&content)
        .map_err(|_| "cannot write download")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o755))
            .map_err(|_| "cannot set script mode")?;
    }
    file.sync_all().map_err(|_| "cannot sync download")?;
    drop(file);
    fs::rename(&temporary.0, path).map_err(|_| "cannot install downloaded script")?;
    #[cfg(unix)]
    fs::File::open(parent)
        .and_then(|dir| dir.sync_all())
        .map_err(|_| "script replaced but directory sync failed")?;
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
