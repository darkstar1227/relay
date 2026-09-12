use crate::Result;
use serde_json::Value;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

static NEXT: AtomicU64 = AtomicU64::new(0);

pub fn read(path: &Path) -> Result<Value> {
    let file = File::open(path).map_err(|_| "cannot open JSON file")?;
    serde_json::from_reader(file).map_err(|_| "invalid JSON file")
}

fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.write(true);
    #[cfg(unix)]
    options.mode(0o600);
    options
}

struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub fn write(path: &Path, value: &Value) -> Result<()> {
    // Serialize before touching disk; malformed data cannot truncate live state.
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| "cannot encode JSON")?;
    write_bytes(path, &bytes)
}

pub fn write_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let (temporary, mut file) = (0..128)
        .find_map(|_| {
            let name = format!(
                ".relay-write-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            );
            let candidate = parent.join(name);
            match private_options().create_new(true).open(&candidate) {
                Ok(file) => Some((Temporary(candidate), file)),
                Err(_) => None,
            }
        })
        .ok_or("cannot create private temporary file")?;
    file.write_all(bytes)
        .map_err(|_| "cannot write temporary file")?;
    file.sync_all().map_err(|_| "cannot sync temporary file")?;
    drop(file);
    fs::rename(&temporary.0, path).map_err(|_| "cannot replace JSON file")?;
    // The rename above already made the new contents durable and visible;
    // a directory-fsync failure here does not undo that, so it's best-effort.
    #[cfg(unix)]
    let _ = File::open(parent).and_then(|dir| dir.sync_all());
    Ok(())
}

/// Open (creating if needed) a private 0600 file and acquire an exclusive lock on it.
/// `timeout`: `None` blocks indefinitely; `Some(d)` polls and gives up after `d`.
pub fn open_locked_private(path: &Path, timeout: Option<Duration>) -> Result<File> {
    let file = private_options()
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|_| "cannot open lock file")?;
    match timeout {
        None => file.lock().map_err(|_| "cannot acquire lock")?,
        Some(timeout) => {
            let started = Instant::now();
            while file.try_lock().is_err() {
                if started.elapsed() >= timeout {
                    return Err("lock timed out");
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
    Ok(file)
}

/// Stable sidecar inode: never lock the file that atomic replacement renames.
/// This is a config lock, NOT the shared credential.lock protocol.
pub fn lock_config(path: &Path) -> Result<File> {
    let mut lock_path = path.as_os_str().to_owned();
    lock_path.push(".lock");
    let lock = private_options()
        .create(true)
        .truncate(false)
        .open(Path::new(&lock_path))
        .map_err(|_| "cannot open configuration lock")?;
    lock.lock()
        .map_err(|_| "cannot acquire configuration lock")?;
    Ok(lock)
}

pub fn update(path: &Path, mutate: impl FnOnce(&mut Value) -> Result<String>) -> Result<String> {
    let _lock = lock_config(path)?;
    let mut value = read(path)?;
    if !value.is_object() {
        return Err("configuration must be a JSON object");
    }
    let output = mutate(&mut value)?;
    write(path, &value)?;
    Ok(output)
}
