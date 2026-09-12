mod config;
mod credential_lock;
mod daemon;
mod data;
mod display;
mod download;
mod http;
mod oauth;
mod ordering;
mod storage;
mod update_query;
mod usage;

use std::env;

type Result<T> = std::result::Result<T, &'static str>;

fn run(args: &[String]) -> Result<()> {
    let (operation, args) = args.split_first().ok_or("missing operation")?;
    // These operations implement the POSIX shell/service contract. Reject on
    // other platforms before HTTP, signal registration or filesystem changes.
    if !cfg!(unix) && matches!(operation.as_str(), "daemon" | "download-update") {
        return Err("operation requires POSIX");
    }
    match operation.as_str() {
        "artifact-info" if args.is_empty() => {
            println!(
                "{}",
                serde_json::json!({
                    "version": env!("RELAY_VERSION"), "protocol": 1,
                    "target": env!("RELAY_TARGET"), "profile": env!("RELAY_PROFILE"),
                    "test_fixtures": cfg!(feature = "test-fixtures")
                })
            );
            Ok(())
        }
        "download-update" => download::run(args),
        "daemon" => daemon::run(args),
        #[cfg(feature = "test-fixtures")]
        "daemon-step" if args.is_empty() => {
            daemon::tick(&std::sync::atomic::AtomicBool::new(false)).map(|_| ())
        }
        "sync-current" if args.is_empty() => oauth::sync_current(),
        "render-table" | "status-once" | "refresh-all" => usage::run(operation, args),
        "latest-version" | "check-update-bg" => update_query::run(args),
        "credential-lock" => credential_lock::run(args),
        "protocol" if args.is_empty() => {
            println!("relay-core 1 {}", env!("RELAY_VERSION"));
            Ok(())
        }
        "provider-field" | "provider-discover" | "access-token" | "format-json"
        | "read-version" | "account-email" | "provider-add" | "run-settings" => {
            data::run(operation, args)
        }
        "reorder"
        | "lock-add"
        | "unlock"
        | "warmup-add"
        | "warmup-remove"
        | "warmup-pause"
        | "warmup-resume"
        | "autoswitch-prune-account"
        | "lock-default-config"
        | "warmup-ensure-config"
        | "config-save"
        | "codex-models-get"
        | "codex-models-set"
        | "codex-model-pick" => config::run(operation, args),
        "prompt-reorder" | "reorder-chain" => ordering::run(operation, args),
        "lock-list"
        | "warmup-list"
        | "warmup-health"
        | "autoswitch-config-summary"
        | "autoswitch-status"
        | "autoswitch-log"
        | "sessions" => display::run(operation, args),
        // Preserve the existing stub: the shell prints the warning; no API call.
        "warmup-test" if args.len() == 1 => Ok(()),
        _ => Err("unknown operation or invalid arguments"),
    }
}

fn main() {
    if let Err(message) = run(&env::args().skip(1).collect::<Vec<_>>()) {
        // Never print parser input, tokens, environment values, or file contents.
        eprintln!("relay-core: {message}");
        std::process::exit(1);
    }
}
