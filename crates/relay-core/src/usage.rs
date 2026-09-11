use crate::{oauth, storage, Result};
use serde_json::Value;
use std::path::Path;

const R: &str = "\x1b[0m";
const B: &str = "\x1b[1m";
const D: &str = "\x1b[2m";
const GR: &str = "\x1b[32m";
const YL: &str = "\x1b[33m";
const RD: &str = "\x1b[31m";
const CY: &str = "\x1b[36m";
const MG: &str = "\x1b[35m";
fn number(v: &Value) -> i64 {
    v.as_f64().unwrap_or(0.0) as i64
}
fn color(u: i64) -> &'static str {
    if u < 50 {
        GR
    } else if u < 80 {
        YL
    } else {
        RD
    }
}
fn bar(u: i64, width: usize) -> String {
    // Python uses ties-to-even; bound malformed upstream utilization allocations.
    let full = (u as f64 / 100.0 * width as f64)
        .round_ties_even()
        .clamp(0.0, 1000.0) as usize;
    format!(
        "{}{}",
        "█".repeat(full),
        "░".repeat(width.saturating_sub(full))
    )
}
fn reset(value: &Value, detailed: bool) -> String {
    let Some(iso) = value.as_str() else {
        return "—".into();
    };
    let Ok(time) = chrono::DateTime::parse_from_rfc3339(iso) else {
        return "—".into();
    };
    let seconds = (time.timestamp_millis() - oauth::now_ms()) / 1000;
    if seconds <= 0 {
        return if detailed {
            "resetting now"
        } else {
            "resetting"
        }
        .into();
    }
    if detailed {
        format!("resets in {}h {:02}m", seconds / 3600, seconds % 3600 / 60)
    } else {
        format!("{}h{:02}m", seconds / 3600, seconds % 3600 / 60)
    }
}
fn expired(value: &Value) -> bool {
    value.as_str() == Some("expired")
}
fn u5(value: &Value) -> String {
    if expired(value) {
        return format!("{YL}⚠ token expired{R}");
    }
    if !value.is_object() || value.as_object().is_some_and(|v| v.is_empty()) {
        return "—".into();
    }
    let u = number(&value["five_hour"]["utilization"]);
    let c = color(u);
    format!(
        "{c}[{}]{R} {c}{u:3}%{R} {D}({}){R}",
        bar(u, 10),
        reset(&value["five_hour"]["resets_at"], false)
    )
}
fn u7(value: &Value, name: &str) -> String {
    if expired(value) {
        return format!("{YL}relay refresh {name}{R}");
    }
    if value["seven_day"]["utilization"].is_null() {
        return "—".into();
    }
    let u = number(&value["seven_day"]["utilization"]);
    let c = color(u);
    format!("{c}[{}]{R} {c}{u}%{R}", bar(u, 8))
}

fn table(args: &[String]) -> Result<()> {
    if args.len() < 4 {
        return Err("invalid table arguments");
    }
    let mode = &args[0];
    let creds = Path::new(&args[1]);
    let meta = Path::new(&args[2]);
    let current = &args[3];
    let no_usage = args[4..].iter().any(|s| s == "--no-usage");
    let names = oauth::names(creds)?;
    if names.is_empty() {
        println!("  {YL}⚠{R} No accounts yet. Run: {B}relay add <name>{R}");
        return Ok(());
    }
    let config = storage::read(
        &creds
            .parent()
            .ok_or("invalid account directory")?
            .join("autoswitch.json"),
    )
    .unwrap_or(Value::Null);
    let mut usage = vec![Value::Null; names.len()];
    if !no_usage {
        eprint!("  {D}fetching usage...{R}\r");
        // Bounded six-worker batches retain deterministic display order.
        for (base, chunk) in names.chunks(6).enumerate() {
            let results = std::thread::scope(|scope| {
                let workers: Vec<_> = chunk
                    .iter()
                    .map(|name| {
                        let path = creds.join(format!("{name}.json"));
                        scope.spawn(move || oauth::usage(&path, true, true).unwrap_or(Value::Null))
                    })
                    .collect();
                workers
                    .into_iter()
                    .map(|w| w.join().unwrap_or(Value::Null))
                    .collect::<Vec<_>>()
            });
            for (i, value) in results.into_iter().enumerate() {
                usage[base * 6 + i] = value;
            }
        }
        eprint!("{}\r", " ".repeat(30));
    }
    if mode == "quick" {
        println!(
            "\n  {B}{MG}relay{R} {D}— switch account{R}\n  {D}{}{R}",
            "─".repeat(45)
        );
    } else {
        println!(
            "  {B}{:<3}{:<13} {:<28} {:<34} 7d usage{R}\n  {D}{}{R}",
            "#",
            "account",
            "email",
            "5hr usage",
            "─".repeat(88)
        );
    }
    for (i, name) in names.iter().enumerate() {
        let active = name == current;
        let ncol = if active { format!("{GR}{B}") } else { B.into() };
        let mut email = oauth::text(&meta.join(name));
        if email.is_empty() {
            email = "—".into();
        }
        let locked = config["locks"]
            .as_array()
            .is_some_and(|v| v.iter().any(|s| s.as_str() == Some(name)));
        let badge = if locked {
            format!(" {YL}🔒{R}")
        } else {
            String::new()
        };
        if mode == "quick" {
            let marker = if active {
                format!("{GR}{B}●{R}")
            } else {
                format!("{D}{}{R}", i + 1)
            };
            let usage = if no_usage {
                String::new()
            } else {
                u5(&usage[i])
            };
            println!("  {marker}  {ncol}{name:<12}{R}  {D}{email:<26}{R}  {usage}{badge}");
        } else {
            let marker = if active {
                format!("{GR}●{R}")
            } else {
                " ".into()
            };
            let (five, seven) = if no_usage {
                ("—".into(), "—".into())
            } else {
                (u5(&usage[i]), u7(&usage[i], name))
            };
            println!(
                "  {marker} {D}{:<2}{R}{ncol}{name:<12}{R} {email:<28} {five:<52} {seven}{badge}",
                i + 1
            );
        }
    }
    println!();
    if mode == "quick" {
        println!(
            "  {D}switch:{R} {CY}!relay <index or name>{R}   {D}details:{R} {CY}!relay status{R}\n"
        );
    } else {
        let count = usage
            .iter()
            .filter(|v| v["five_hour"]["utilization"].as_f64().unwrap_or(0.0) >= 80.0)
            .count();
        if count > 0 {
            println!("  {RD}⚠ {count} account(s) above 80% usage{R}");
        }
    }
    Ok(())
}

fn status(args: &[String]) -> Result<()> {
    let [path, name, email] = args else {
        return Err("invalid status arguments");
    };
    println!("  {B}Account:{R} {GR}{B}{name}{R}\n  {B}Email:{R}   {email}");
    let path = Path::new(path);
    if storage::read(path).ok().is_some_and(|v| {
        v["claudeAiOauth"]["accessToken"]
            .as_str()
            .unwrap_or_default()
            .is_empty()
    }) {
        println!("\n  {YL}⚠ No access token — please log in again{R}");
        return Ok(());
    }
    let data = match oauth::usage(path, false, false) {
        Ok(v) if expired(&v) => {
            println!("\n  {YL}⚠ Token expired — run: relay refresh {name}{R}");
            return Ok(());
        }
        Ok(v) => v,
        Err(_) => {
            println!("\n  {RD}✗ Usage query failed: request unavailable{R}");
            return Ok(());
        }
    };
    let u = number(&data["five_hour"]["utilization"]);
    let c = color(u);
    println!(
        "\n  {B}5hr usage:{R}\n    {c}[{}]{R} {c}{B}{u}%{R}\n    {D}{}{R}",
        bar(u, 24),
        reset(&data["five_hour"]["resets_at"], true)
    );
    if !data["seven_day"]["utilization"].is_null() {
        let u = number(&data["seven_day"]["utilization"]);
        let c = color(u);
        println!("\n  {B}7d usage:{R}\n    {c}[{}]{R} {c}{u}%{R}", bar(u, 24));
        if data["seven_day"]["resets_at"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
        {
            println!("    {D}{}{R}", reset(&data["seven_day"]["resets_at"], true));
        }
    }
    println!();
    if u >= 90 {
        println!("  {RD}{B}⚠  Approaching limit — consider switching: !relay <other>{R}");
    } else if u >= 70 {
        println!("  {YL}⚡ Usage is high — watch for rate limits{R}");
    } else {
        println!("  {GR}✓  Usage is normal{R}");
    }
    Ok(())
}

pub fn run(op: &str, args: &[String]) -> Result<()> {
    match op {
        "render-table" => table(args),
        "status-once" => status(args),
        "refresh-all" => {
            if args.len() < 2 {
                return Err("invalid refresh arguments");
            }
            let n: usize = args[1].parse().map_err(|_| "invalid account count")?;
            if n != args.len() - 2 {
                return Err("invalid account count");
            }
            for name in &args[2..] {
                let path = Path::new(&args[0]).join(format!("{name}.json"));
                let value = storage::read(&path).unwrap_or(Value::Null);
                if oauth::refresh(&path, &value, true).is_ok() {
                    println!("  {GR}✓{R}  {B}{name}{R}  refreshed");
                } else {
                    println!("  {YL}⚠{R}  {B}{name}{R}  refresh failed (token may already be fresh or refreshToken expired)");
                }
            }
            println!();
            Ok(())
        }
        _ => Err("unknown usage operation"),
    }
}
