use crate::{storage, Result};
use serde_json::{json, Value};
use std::{fs, io, path::Path};

fn default_config(creds: &Path, path: &Path, warmup: bool) -> Result<()> {
    let _lock = storage::lock_config(path)?;
    // The shell's existence check can race another initializer or mutator.
    match fs::symlink_metadata(path) {
        Ok(_) => return Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => (),
        Err(_) => return Err("cannot inspect configuration file"),
    }
    let order_path = creds
        .parent()
        .ok_or("invalid credentials directory")?
        .join("order");
    let mut disk = Vec::new();
    match fs::read_dir(creds) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry.map_err(|_| "cannot enumerate credentials")?;
                let name = entry
                    .file_name()
                    .into_string()
                    .map_err(|_| "invalid account filename")?;
                if let Some(name) = name.strip_suffix(".json") {
                    disk.push(name.to_owned());
                }
            }
        }
        Err(e) if warmup && e.kind() == io::ErrorKind::NotFound => (),
        Err(_) => return Err("cannot enumerate credentials"),
    }
    disk.sort();
    disk.dedup();
    let old_order = match fs::read_to_string(&order_path) {
        Ok(s) => s,
        Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
        Err(_) => return Err("cannot read account order"),
    };
    let mut order = Vec::new();
    for name in old_order.lines().map(str::trim) {
        if disk.iter().any(|n| n == name) && !order.iter().any(|n| n == name) {
            order.push(name.to_owned());
        }
    }
    for name in disk {
        if !order.contains(&name) {
            order.push(name);
        }
    }
    let thresholds: serde_json::Map<String, Value> =
        order.iter().map(|n| (n.clone(), json!(80))).collect();
    let mut cfg = json!({"order": order, "thresholds": thresholds, "locks": [],
        "poll": {"low_minutes": 10, "high_minutes": 2, "high_threshold": 50}});
    if warmup {
        cfg["warmup"] = json!([]);
    }
    let order_text = order.join("\n") + if order.is_empty() { "" } else { "\n" };
    storage::write_bytes(&order_path, order_text.as_bytes())?;
    storage::write(path, &cfg)
}

fn models(cfg: &Value) -> Result<Vec<String>> {
    match cfg.get("codex_models") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(a)) => a
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .ok_or("model names must be strings")
            })
            .collect(),
        _ => Err("codex_models must be an array"),
    }
}

fn save(path: &Path) -> Result<()> {
    let incoming: Value =
        serde_json::from_reader(io::stdin().lock()).map_err(|_| "invalid stdin JSON")?;
    let object = incoming
        .as_object()
        .ok_or("configuration must be a JSON object")?;
    let _lock = storage::lock_config(path)?;
    let mut cfg = match fs::symlink_metadata(path) {
        Ok(_) => storage::read(path)?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => json!({}),
        Err(_) => return Err("cannot inspect configuration file"),
    };
    let target = cfg
        .as_object_mut()
        .ok_or("configuration must be a JSON object")?;
    for (key, value) in object {
        target.insert(key.clone(), value.clone());
    }
    storage::write(path, &cfg)
}

pub fn run(operation: &str, args: &[String]) -> Result<()> {
    match (operation, args) {
        ("lock-default-config" | "warmup-ensure-config", [creds, path]) => {
            return default_config(
                Path::new(creds),
                Path::new(path),
                operation == "warmup-ensure-config",
            )
        }
        ("config-save", [path]) => return save(Path::new(path)),
        ("codex-models-get", [path]) => {
            println!("{}", models(&storage::read(Path::new(path))?)?.join(","));
            return Ok(());
        }
        _ => (),
    }
    let expected = match operation {
        "warmup-pause" | "warmup-resume" | "codex-model-pick" => 1,
        "warmup-add" | "warmup-remove" => 3,
        _ => 2,
    };
    if args.len() != expected {
        return Err("invalid operation arguments");
    }
    let output = storage::update(Path::new(&args[0]), |cfg| {
        let mut output = String::new();
        match operation {
            "codex-models-set" => {
                cfg["codex_models"] = json!(args[1]
                    .split(',')
                    .map(str::trim)
                    .filter(|m| !m.is_empty())
                    .collect::<Vec<_>>());
                cfg["_codex_model_cursor"] = json!(-1);
            }
            "codex-model-pick" => {
                let models = models(cfg)?;
                output.push('\n');
                if !models.is_empty() {
                    let cursor = match cfg.get("_codex_model_cursor") {
                        None => -1,
                        Some(v) => v.as_i64().ok_or("model cursor must be an integer")?,
                    };
                    let index =
                        ((i128::from(cursor) + 1).rem_euclid(models.len() as i128)) as usize;
                    cfg["_codex_model_cursor"] = json!(index);
                    output = format!("{}\n", models[index]);
                }
            }
            "reorder" => cfg["order"] = json!(args[1].split(',').collect::<Vec<_>>()),
            "warmup-pause" | "warmup-resume" => {
                cfg["warmup_enabled"] = json!(operation == "warmup-resume")
            }
            "lock-add" | "unlock" => {
                if cfg.get("locks").is_none() {
                    cfg["locks"] = json!([]);
                }
                let locks = cfg["locks"]
                    .as_array_mut()
                    .ok_or("locks must be an array")?;
                let name = json!(args[1]);
                let index = locks.iter().position(|n| n == &name);
                match (operation, index) {
                    ("lock-add", Some(_)) => output = format!("  already locked: {}\n", args[1]),
                    ("lock-add", None) => locks.push(name),
                    ("unlock", Some(i)) => {
                        locks.remove(i);
                    }
                    _ => output = format!("  not locked: {}\n", args[1]),
                }
            }
            "warmup-add" | "warmup-remove" => {
                if cfg.get("warmup").is_none() {
                    cfg["warmup"] = json!([]);
                }
                let entries = cfg["warmup"]
                    .as_array_mut()
                    .ok_or("warmup must be an array")?;
                if entries.iter().any(|v| !v.is_object()) {
                    return Err("warmup entries must be objects");
                }
                let matches = |e: &Value| {
                    e.get("account").and_then(Value::as_str) == Some(&args[1])
                        && (e.get("time").and_then(Value::as_str) == Some(&args[2])
                            || (operation == "warmup-remove" && args[2].is_empty()))
                };
                if operation == "warmup-add" {
                    if !entries.iter().any(matches) {
                        entries.push(json!({"account": args[1], "time": args[2]}));
                    }
                } else {
                    let old_len = entries.len();
                    entries.retain(|e| !matches(e));
                    output = format!("{}\n", old_len - entries.len());
                }
            }
            _ => return Err("unknown configuration operation"),
        }
        Ok(output)
    })?;
    print!("{output}");
    Ok(())
}
