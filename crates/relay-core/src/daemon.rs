use crate::{http, oauth, storage, Result};
use chrono::{Local, Timelike};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

// Best-effort: a transient logging failure (disk full, permission change) must
// never take down the long-running daemon, so this swallows its own errors.
fn log(dir: &Path, event: &str, fields: Value) {
    let mut value = fields;
    value["ts"] = json!(oauth::now_ms() / 1000);
    value["event"] = json!(event);
    let mut options = OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let Ok(mut file) = options.open(dir.join("autoswitch.log")) {
        let _ = writeln!(file, "{value}");
    }
}
fn child(command: &mut Command, timeout: u64, stop: &AtomicBool) -> bool {
    let Ok(mut process) = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let started = Instant::now();
    loop {
        match process.try_wait() {
            Ok(Some(status)) => return status.success(),
            Err(_) => {
                let _ = process.kill();
                let _ = process.wait();
                return false;
            }
            _ => (),
        }
        if stop.load(Ordering::Relaxed) || started.elapsed() >= Duration::from_secs(timeout) {
            let _ = process.kill();
            let _ = process.wait();
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}
fn notify(message: &str, stop: &AtomicBool) {
    if http::fixture_mode() {
        return;
    }
    if cfg!(target_os = "macos") {
        let escaped = message.replace('\\', "\\\\").replace('"', "\\\"");
        child(
            Command::new("osascript").args([
                "-e",
                &format!("display notification \"{escaped}\" with title \"relay\""),
            ]),
            3,
            stop,
        );
    } else {
        child(
            Command::new("notify-send").args(["relay", message]),
            3,
            stop,
        );
    }
}
fn warmup(dir: &Path, config: &Value, stop: &AtomicBool) -> Result<()> {
    if config["warmup_enabled"].as_bool() == Some(false) {
        return Ok(());
    }
    let Some(entries) = config["warmup"].as_array() else {
        return Ok(());
    };
    let path = dir.join("warmup_state.json");
    let mut state = storage::read(&path)
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let now = Local::now();
    let today = now.format("%Y-%m-%d").to_string();
    let mut changed = false;
    for entry in entries {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let (Some(account), Some(time)) = (entry["account"].as_str(), entry["time"].as_str())
        else {
            continue;
        };
        let key = format!("{account}|{time}");
        if state[&key]["date"].as_str() == Some(&today) {
            continue;
        }
        let Some((hour, minute)) = time
            .split_once(':')
            .and_then(|(h, m)| Some((h.parse::<u32>().ok()?, m.parse::<u32>().ok()?)))
        else {
            continue;
        };
        if hour > 23 || minute > 59 {
            continue;
        }
        // Preserve local wall-clock schedule, including 15-minute grace period.
        let age = now.num_seconds_from_midnight() as i64 - (hour * 3600 + minute * 60) as i64;
        if age < 0 {
            continue;
        }
        if age > 900 {
            state[&key] = json!({"date":today,"status":"missed"});
            changed = true;
            log(dir, "warmup_missed", json!({"account":account,"time":time}));
            continue;
        }
        if !dir
            .join("credentials")
            .join(format!("{account}.json"))
            .is_file()
        {
            log(
                dir,
                "warmup_pending",
                json!({"account":account,"reason":"missing_account"}),
            );
            continue;
        }
        let before = oauth::text(&dir.join("current"));
        oauth::switch(account)?;
        log(dir, "warmup_switch", json!({"account":account}));
        let configured = oauth::text(&dir.join("claude_bin"));
        let binary = if !configured.is_empty() && Path::new(&configured).exists() {
            configured
        } else {
            "claude".into()
        };
        let ok = child(
            Command::new(binary).args(["-p", "ping", "--output-format", "text"]),
            30,
            stop,
        );
        log(dir, "warmup_ping", json!({"account":account,"ok":ok}));
        if !before.is_empty()
            && before != account
            && dir
                .join("credentials")
                .join(format!("{before}.json"))
                .is_file()
            && oauth::restore_if_current(account, &before)?
        {
            log(dir, "warmup_restore", json!({"account":before}));
        }
        state[&key] = json!({"date":today,"status":if ok { "ok" } else { "ping_failed" }});
        changed = true;
        notify(
            &format!(
                "warmup: {account} {}",
                if ok {
                    "已完成 5hr session 預熱"
                } else {
                    "ping 失敗"
                }
            ),
            stop,
        );
    }
    if changed {
        storage::write(&path, &state)?;
    }
    Ok(())
}
fn utilization(value: &Value) -> Option<i64> {
    value["five_hour"]["utilization"].as_f64().map(|n| n as i64)
}

pub fn tick(stop: &AtomicBool) -> Result<u64> {
    let dir = oauth::state()?;
    let config_path = dir.join("autoswitch.json");
    let raw = storage::read(&config_path);
    let cfg = match raw {
        Ok(v) if v.is_object() => v,
        _ => {
            if config_path.exists() {
                log(
                    &dir,
                    "config_parse_error",
                    json!({"error":"invalid configuration"}),
                );
            }
            let names = oauth::names(&dir.join("credentials"))?;
            if names.len() < 2 {
                return Ok(60);
            }
            let thresholds: serde_json::Map<String, Value> =
                names.iter().map(|s| (s.clone(), json!(80))).collect();
            json!({"order":names,"thresholds":thresholds})
        }
    };
    warmup(&dir, &cfg, stop)?;
    let Some(order) = cfg["order"].as_array() else {
        return Ok(60);
    };
    let names: Vec<&str> = order.iter().filter_map(Value::as_str).collect();
    if names.is_empty() {
        return Ok(60);
    }
    let current = oauth::text(&dir.join("current"));
    let mut usage = serde_json::Map::new();
    for name in &names {
        if stop.load(Ordering::Relaxed) {
            return Ok(0);
        }
        usage.insert(
            (*name).to_owned(),
            oauth::usage(
                &dir.join("credentials").join(format!("{name}.json")),
                true,
                false,
            )
            .unwrap_or(Value::Null),
        );
    }
    let cur = utilization(usage.get(&current).unwrap_or(&Value::Null));
    let high = cfg["poll"]["high_threshold"].as_i64().unwrap_or(50);
    let interval = if cur.is_some_and(|n| n >= high) {
        cfg["poll"]["high_minutes"].as_u64().unwrap_or(2)
    } else {
        cfg["poll"]["low_minutes"].as_u64().unwrap_or(10)
    };
    let sleep = interval.clamp(1, 1440) * 60;
    let threshold = cfg["thresholds"][&current].as_f64();
    let over = cur.zip(threshold).is_some_and(|(n, t)| n as f64 >= t);
    let manual = storage::read(&dir.join("manual_switch")).unwrap_or(Value::Null);
    if manual["account"].as_str() == Some(&current) {
        if over {
            let _ = fs::remove_file(dir.join("manual_switch"));
        } else {
            return Ok(sleep);
        }
    }
    if !over {
        return Ok(sleep);
    }
    // When `current` isn't in `names` (removed from order while still active),
    // every name is a legitimate rotation candidate — not just names[1..].
    let mut candidates: Box<dyn Iterator<Item = &str>> = match names.iter().position(|s| *s == current)
    {
        Some(index) => Box::new((1..names.len()).map(move |i| names[(index + i) % names.len()])),
        None => Box::new(names.iter().copied()),
    };
    let target = candidates
        .find(|name| {
            let locked = cfg["locks"]
                .as_array()
                .is_some_and(|v| v.iter().any(|n| n.as_str() == Some(*name)));
            let u = utilization(usage.get(*name).unwrap_or(&Value::Null));
            let threshold = cfg["thresholds"][*name].as_f64().unwrap_or(80.0);
            !(locked && u.is_some_and(|u| u as f64 >= threshold))
        });
    if let Some(target) = target {
        // Recheck the observed account inside credential.lock to avoid overriding a manual switch.
        if oauth::restore_if_current(&current, target)? {
            log(
                &dir,
                "switch",
                json!({"frm":current,"to":target,"usage":cur}),
            );
            notify(&format!("switched {current} → {target}"), stop);
        }
    } else {
        log(&dir, "all_blocked", json!({"current":current}));
        notify("All accounts at limit — staying on current account", stop);
    }
    Ok(sleep)
}

struct PidFile(PathBuf);
impl Drop for PidFile {
    fn drop(&mut self) {
        if oauth::text(&self.0) == std::process::id().to_string() {
            let _ = fs::remove_file(&self.0);
        }
    }
}
pub fn run(args: &[String]) -> Result<()> {
    if !args.is_empty() {
        return Err("invalid daemon arguments");
    }
    let stop = Arc::new(AtomicBool::new(false));
    for signal in [signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT] {
        signal_hook::flag::register(signal, Arc::clone(&stop))
            .map_err(|_| "cannot install signal handler")?;
    }
    let dir = oauth::state()?;
    let singleton = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join("autoswitch.instance.lock"))
        .map_err(|_| "cannot open instance lock")?;
    // The flock above is the sole source of truth for single-instance exclusivity.
    // A secondary PID+kill-0 check on autoswitch.lock is redundant and unsound:
    // once the process the stale PID belonged to exits, the OS can reassign that
    // PID to an unrelated process, making the check wrongly refuse startup.
    singleton.try_lock().map_err(|_| "daemon already running")?;
    let pid_path = dir.join("autoswitch.lock");
    storage::write_bytes(&pid_path, std::process::id().to_string().as_bytes())?;
    let _pid = PidFile(pid_path);
    let log_path = dir.join("autoswitch.log");
    let old = fs::read_to_string(&log_path).unwrap_or_default();
    let lines: Vec<_> = old.lines().collect();
    if lines.len() > 500 {
        storage::write_bytes(
            &log_path,
            (lines[lines.len() - 200..].join("\n") + "\n").as_bytes(),
        )?;
    }
    log(&dir, "start", json!({}));
    let mut last_refresh = 0;
    while !stop.load(Ordering::Relaxed) {
        if oauth::now_ms() - last_refresh > 1_800_000 {
            for name in oauth::names(&dir.join("credentials"))? {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                let path = dir.join("credentials").join(format!("{name}.json"));
                let value = storage::read(&path).unwrap_or(Value::Null);
                let _ = oauth::refresh(&path, &value, true);
            }
            last_refresh = oauth::now_ms();
        }
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let seconds = match tick(&stop) {
            Ok(s) => s,
            Err(_) => {
                log(&dir, "cycle_error", json!({"error":"cycle failed"}));
                60
            }
        };
        for _ in 0..seconds {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    log(&dir, "stop", json!({}));
    Ok(())
}
