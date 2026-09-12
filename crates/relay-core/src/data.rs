use crate::{storage, Result};
use serde_json::{Map, Value};
use std::{env, io, path::Path};

fn text(value: Option<&Value>) -> Result<&str> {
    match value {
        None | Some(Value::Null) => Ok(""),
        Some(Value::String(s)) => Ok(s),
        _ => Err("expected a JSON string field"),
    }
}

pub(crate) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
    }
}

fn from_stdin() -> Result<Value> {
    serde_json::from_reader(io::stdin().lock()).map_err(|_| "invalid stdin JSON")
}

fn env_required(name: &str) -> Result<String> {
    env::var(name).map_err(|_| "missing required environment variable")
}

fn provider_settings(run: bool) -> Result<()> {
    // Retain the existing shell environment boundary: secrets never enter argv.
    let prefix = if run { "RELAY_RUN" } else { "RELAY_PROVIDER" };
    let mut object = Map::new();
    for (suffix, provider_key, run_key) in [
        ("BASE_URL", "base_url", "ANTHROPIC_BASE_URL"),
        ("TOKEN", "auth_token", "ANTHROPIC_AUTH_TOKEN"),
        ("MODEL", "model", "ANTHROPIC_MODEL"),
        (
            "SUBAGENT_MODEL",
            "subagent_model",
            "CLAUDE_CODE_SUBAGENT_MODEL",
        ),
    ] {
        let name = format!("{prefix}_{suffix}");
        let required = matches!(suffix, "BASE_URL" | "TOKEN");
        let value = if required {
            env_required(&name)?
        } else {
            env::var(name).unwrap_or_default()
        };
        if required || !value.is_empty() {
            object.insert(
                if run { run_key } else { provider_key }.into(),
                Value::String(value),
            );
        }
    }
    if env::var(format!("{prefix}_DISCOVER")).unwrap_or_default() == "1" {
        if run {
            object.insert(
                "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY".into(),
                Value::String("1".into()),
            );
        } else {
            object.insert("discover_models".into(), Value::Bool(true));
        }
    }
    if !run && env::var("RELAY_PROVIDER_AGENT").unwrap_or_default() == "codex" {
        object.insert("agent".into(), Value::String("codex".into()));
    }
    let value = if run {
        let mut outer = Map::new();
        outer.insert("env".into(), Value::Object(object));
        Value::Object(outer)
    } else {
        Value::Object(object)
    };
    let path = env_required(if run {
        "RELAY_RUN_SETTINGS_FILE"
    } else {
        "RELAY_PROVIDER_PATH"
    })?;
    storage::write(Path::new(&path), &value)
}

pub fn run(operation: &str, args: &[String]) -> Result<()> {
    match (operation, args) {
        ("provider-field", [path, field]) => {
            let value = storage::read(Path::new(path))?;
            println!("{}", text(value.get(field))?);
        }
        ("provider-discover", [path]) => {
            let value = storage::read(Path::new(path))?;
            println!(
                "{}",
                if truthy(value.get("discover_models")) {
                    "1"
                } else {
                    ""
                }
            );
        }
        ("account-email", [path]) => {
            // Missing or corrupt Claude metadata has always been optional.
            let value = storage::read(Path::new(path)).unwrap_or(Value::Null);
            println!(
                "{}",
                text(value.pointer("/oauthAccount/emailAddress")).unwrap_or("")
            );
        }
        ("read-version", [path]) => {
            let value = storage::read(Path::new(path))?;
            let version = value
                .get("version")
                .and_then(Value::as_str)
                .ok_or("missing version string")?;
            println!("{version}");
        }
        ("access-token", []) => {
            let value = from_stdin()?;
            println!("{}", text(value.pointer("/claudeAiOauth/accessToken"))?);
        }
        ("format-json", []) => {
            let value = from_stdin()?;
            println!(
                "{}",
                serde_json::to_string_pretty(&value).map_err(|_| "cannot encode JSON")?
            );
        }
        ("provider-add", []) => provider_settings(false)?,
        ("run-settings", []) => provider_settings(true)?,
        _ => return Err("invalid operation arguments"),
    }
    Ok(())
}
