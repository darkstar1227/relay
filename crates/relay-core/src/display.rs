use crate::{storage, Result};
use chrono::{DateTime, Local, TimeZone};
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    env, fs,
    io::{BufRead, BufReader},
    path::Path,
};

const R: &str = "\x1b[0m";
const B: &str = "\x1b[1m";
const D: &str = "\x1b[2m";
const CY: &str = "\x1b[36m";
const GR: &str = "\x1b[32m";
const YL: &str = "\x1b[33m";

fn array(value: Option<&Value>) -> Result<&[Value]> {
    match value {
        None => Ok(&[]),
        Some(Value::Array(a)) => Ok(a),
        _ => Err("expected a JSON array"),
    }
}

fn string(value: Option<&Value>) -> Result<&str> {
    value
        .and_then(Value::as_str)
        .ok_or("expected a JSON string")
}

fn py(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => "None".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => if *b { "True" } else { "False" }.into(),
        Some(v) => v.to_string(),
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
    }
}

fn tail(path: &Path, count: usize) -> Result<VecDeque<String>> {
    let file = fs::File::open(path).map_err(|_| "cannot open event log")?;
    let mut lines = VecDeque::new();
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|_| "cannot read event log")?;
        if lines.len() == count {
            lines.pop_front();
        }
        lines.push_back(line);
    }
    Ok(lines)
}

fn lock_list(cfg: &Value) -> Result<String> {
    let locks = array(cfg.get("locks"))?;
    let mut out = String::new();
    if locks.is_empty() {
        out = format!("  {D}No accounts locked.{R}\n");
    }
    for name in locks {
        out += &format!("  {YL}🔒{R}  {B}{}{R}\n", string(Some(name))?);
    }
    out.push('\n');
    Ok(out)
}

fn warmup_list(cfg: &Value, state_path: &Path) -> Result<String> {
    let mut out = String::new();
    if cfg.get("warmup_enabled").is_some() && !truthy(cfg.get("warmup_enabled")) {
        out += &format!("  {YL}⏸ warmup paused{R} — run 'relay warmup resume' to re-enable\n");
    }
    let entries = array(cfg.get("warmup"))?;
    if entries.is_empty() {
        out += "  No warmup entries. Run: relay warmup add <account> <HH:MM>\n";
        return Ok(out);
    }
    let state = storage::read(state_path).unwrap_or(Value::Null);
    for entry in entries {
        let account = string(entry.get("account"))?;
        let time = string(entry.get("time"))?;
        let record = state.get(format!("{account}|{time}"));
        if truthy(record) {
            let record = record.ok_or("invalid warmup record")?;
            let status = match record.get("status").and_then(Value::as_str) {
                Some("ok") => "成功".into(),
                Some("ping_failed") => "ping 失敗".into(),
                Some("missed") => "錯過".into(),
                Some("missing_account") => "帳號不存在".into(),
                _ => py(record.get("status")),
            };
            out += &format!(
                "  {account:<12} {time}   最後: {} {status}\n",
                py(record.get("date"))
            );
        } else {
            out += &format!("  {account:<12} {time}   尚未觸發\n");
        }
    }
    Ok(out)
}

fn summary(cfg: &Value) -> Result<String> {
    let mut out = String::new();
    for (i, name) in array(cfg.get("order"))?.iter().enumerate() {
        let name = string(Some(name))?;
        let threshold = cfg
            .get("thresholds")
            .and_then(|t| t.get(name))
            .map(|v| py(Some(v)))
            .unwrap_or("?".into());
        out += &format!(
            "    {D}{}.{R} {name:<14} → switch at {CY}{threshold}%{R}\n",
            i + 1
        );
    }
    let poll = cfg.get("poll").ok_or("missing poll configuration")?;
    for field in ["low_minutes", "high_minutes", "high_threshold"] {
        if poll.get(field).is_none() {
            return Err("missing poll field");
        }
    }
    out += &format!(
        "\n    {D}polling: {}min normal / {}min fast (fast above {}%){R}\n",
        py(poll.get("low_minutes")),
        py(poll.get("high_minutes")),
        py(poll.get("high_threshold"))
    );
    Ok(out)
}

fn health(cfg_path: &Path, log_path: &Path) -> Result<String> {
    let cfg = match storage::read(cfg_path) {
        Ok(cfg) => cfg,
        Err(_) => return Ok(String::new()),
    };
    let entries = array(cfg.get("warmup"))?;
    let mut counts: HashMap<String, (u64, u64)> = HashMap::new();
    let key = |entry: &Value| format!("{}|{}", py(entry.get("account")), py(entry.get("time")));
    for line in tail(log_path, 2000).unwrap_or_default() {
        let rec: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match rec.get("event").and_then(Value::as_str) {
            Some("warmup_missed") => {
                let count = counts.entry(key(&rec)).or_default();
                count.0 += 1;
                count.1 += 1;
            }
            Some("warmup_ping") => {
                for entry in entries {
                    if entry.get("account") == rec.get("account") {
                        let count = counts.entry(key(entry)).or_default();
                        count.0 += 1;
                        if !truthy(rec.get("ok")) {
                            count.1 += 1;
                        }
                    }
                }
            }
            _ => (),
        }
    }
    let mut out = String::new();
    for entry in entries {
        if let Some((total, bad)) = counts.get(&key(entry)) {
            if *total >= 3 && *bad >= 3 {
                out += &format!(
                    "  {YL}⚠ warmup: {} {} missed {bad}/{total} recent{R}\n",
                    py(entry.get("account")),
                    py(entry.get("time"))
                );
            }
        }
    }
    Ok(out)
}

fn status(cfg: &Value, path: &Path, current: &str) -> Result<String> {
    let order = array(cfg.get("order"))?;
    let locks = array(cfg.get("locks"))?;
    let home = env::var_os("HOME").ok_or("HOME is required")?;
    let cache = storage::read(&Path::new(&home).join(".claude-relay/usage_cache.json"))
        .unwrap_or(Value::Null);
    let threshold = |name: &str| cfg.get("thresholds").and_then(|t| t.get(name));
    let utilization = |name: &str| {
        cache
            .get(name)
            .and_then(|v| v.pointer("/data/five_hour/utilization"))
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
            .map(f64::trunc)
    };
    let mut out = format!(
        "  {B}{:<4} {:<14} {:<12} {:<14} {:<6}{R}\n  {D}{}{R}\n",
        "order",
        "account",
        "threshold",
        "cached usage",
        "lock",
        "─".repeat(58)
    );
    let mut previous_over = true;
    for (i, value) in order.iter().enumerate() {
        let name = string(Some(value))?;
        let cur = name == current;
        let marker = if cur {
            format!("{GR}●{R}")
        } else {
            " ".into()
        };
        let ncol = if cur { format!("{GR}{B}") } else { B.into() };
        let thr = threshold(name).filter(|v| !v.is_null());
        let thr_s = thr
            .map(|v| format!("{}%", py(Some(v))))
            .unwrap_or_else(|| format!("{D}skipped{R}"));
        let util = utilization(name);
        let mut util_s = util
            .map(|u| format!("{u:.0}%"))
            .unwrap_or_else(|| format!("{D}—{R}"));
        let over = match (thr.and_then(Value::as_f64), util) {
            (Some(t), Some(u)) => u >= t,
            _ => false,
        };
        if over {
            util_s += &format!(" {YL}⚠ over{R}");
        }
        let next = if !cur && !over && previous_over {
            format!(" {CY}← next{R}")
        } else {
            String::new()
        };
        let lock = if locks.contains(value) {
            format!(" {YL}🔒{R}")
        } else {
            String::new()
        };
        out += &format!(
            "  {marker} {D}{:<2}{R}{ncol}{name:<14}{R} {thr_s:<12} {util_s}{next}{lock}\n",
            i + 1
        );
        previous_over &= over;
    }
    // Preserve last-switch semantics, including ignoring a corrupt tail.
    let log = path
        .parent()
        .unwrap_or(Path::new("."))
        .join("autoswitch.log");
    if let Ok(text) = fs::read_to_string(log) {
        for line in text.lines().rev() {
            let rec: Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => break,
            };
            if rec.get("event").and_then(Value::as_str) == Some("switch") {
                if let (Some(from), Some(to)) = (rec.get("frm"), rec.get("to")) {
                    out += &format!(
                        "\n  {B}Last switch:{R} {} → {}\n",
                        py(Some(from)),
                        py(Some(to))
                    );
                }
                break;
            }
        }
    }
    Ok(out)
}

fn event_log(path: &Path) -> Result<String> {
    let mut out = String::new();
    for line in tail(path, 20)? {
        let rec: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let ts = match rec.get("ts").and_then(Value::as_f64) {
            Some(n) if n.is_finite() => n.floor(),
            _ => continue,
        };
        let time = match Local.timestamp_opt(ts as i64, 0).single() {
            Some(t) => t.format("%m/%d %H:%M").to_string(),
            None => continue,
        };
        let usage = rec.get("usage").map(|v| py(Some(v))).unwrap_or("?".into());
        match rec.get("event").and_then(Value::as_str) {
            Some("switch") if rec.get("frm").is_some() && rec.get("to").is_some() => {
                out += &format!(
                    "  {D}{time}{R}  {GR}switch{R}     {} → {CY}{}{R}  ({usage}%)\n",
                    py(rec.get("frm")),
                    py(rec.get("to"))
                )
            }
            Some("all_over_threshold") if rec.get("selected").is_some() => {
                out += &format!(
                    "  {D}{time}{R}  {YL}all_over{R}   → {CY}{}{R}  ({usage}%) {YL}⚠{R}\n",
                    py(rec.get("selected"))
                )
            }
            Some("start") => out += &format!("  {D}{time}{R}  {D}daemon start{R}\n"),
            _ => (),
        }
    }
    Ok(out)
}

fn sessions(base: &Path) -> Result<String> {
    let mut projects = fs::read_dir(base)
        .map_err(|_| "cannot enumerate sessions")?
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|_| "cannot enumerate sessions")?;
    projects.sort_by_key(|e| e.file_name());
    let mut out = String::new();
    let mut total = 0;
    for project in projects {
        if !project.path().is_dir() {
            continue;
        }
        let mut files = Vec::new();
        for entry in
            fs::read_dir(project.path()).map_err(|_| "cannot enumerate project sessions")?
        {
            let entry = entry.map_err(|_| "cannot read session entry")?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| "invalid session filename")?;
            if name.starts_with('.') || !name.ends_with(".jsonl") {
                continue;
            }
            let metadata = fs::metadata(entry.path()).map_err(|_| "cannot inspect session")?;
            let time = metadata
                .modified()
                .map_err(|_| "cannot read session time")?;
            files.push((name, time, metadata.len()));
        }
        files.sort_by_key(|entry| std::cmp::Reverse(entry.1));
        if files.is_empty() {
            continue;
        }
        let name = project
            .file_name()
            .into_string()
            .map_err(|_| "invalid project name")?;
        out += &format!("\n  {D}{name}{R}\n");
        for (sid, time, size) in files {
            let sid = sid.strip_suffix(".jsonl").ok_or("invalid session suffix")?;
            let time: DateTime<Local> = time.into();
            let stamp = time.format("%m/%d %H:%M").to_string();
            let size = if size > 1_048_576 {
                format!("{:.1}M", size as f64 / 1_048_576.0)
            } else {
                format!("{}K", size / 1024)
            };
            let mark = if total == 0 {
                format!("  {GR}← latest{R}")
            } else {
                String::new()
            };
            out += &format!("  {CY}{sid:<40}{R} {stamp:<12} {size}{mark}\n");
            total += 1;
        }
    }
    out.push('\n');
    out += &if total == 0 {
        "  No sessions found\n".into()
    } else {
        format!("  {total} session(s)\n")
    };
    Ok(out)
}

pub fn run(operation: &str, args: &[String]) -> Result<()> {
    let out = match (operation, args) {
        ("lock-list", [path]) => lock_list(&storage::read(Path::new(path))?)?,
        ("warmup-list", [path, state]) => {
            warmup_list(&storage::read(Path::new(path))?, Path::new(state))?
        }
        ("autoswitch-config-summary", [path]) => summary(&storage::read(Path::new(path))?)?,
        ("warmup-health", [path, log]) => health(Path::new(path), Path::new(log))?,
        ("autoswitch-status", [path, current]) => {
            status(&storage::read(Path::new(path))?, Path::new(path), current)?
        }
        ("autoswitch-log", [path]) => event_log(Path::new(path))?,
        ("sessions", [path]) => sessions(Path::new(path))?,
        _ => return Err("invalid operation arguments"),
    };
    print!("{out}");
    Ok(())
}
