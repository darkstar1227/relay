# Rust core migration: implementation progress

Status: **in progress, development opt-in only** (2026-09-08).
Latest: all five remaining Python programs now have Rust implementations and
adapters, including daemon deployment. Production named operations total 40.
HEAD was synchronized again to 2.9.2 (`81121a7`), preserving Codex `/v1` behavior.
Default releases still use Python until platform packaging, paired updates and
native rollout validation are complete. See [stages 05–07](reports/sre-stages.md)
for current acceptance; version/count statements below describe earlier slices.
Stage-one macOS/Windows/Linux installation results apply to that earlier
artifact, not to this worktree's Rust implementation. Neither the Rust core
migration nor its final SRE comparison is complete. This session did not publish.
The first slice used 2.9.0. During the second slice another session advanced HEAD
to 2.9.1 (`9c70db9`); the user requested synchronization. This worktree now retains
that release's Codex rotation feature plus the prior assembly/updater/Windows
acceptance fixes. No additional version bump was performed here.

## Build and test

```sh
npm run build
npm test
npm run test:core
npm run build:core
RELAY_CORE_BIN="$PWD/target/release/relay-core" ./relay provider list
```

Use a disposable HOME with synthetic credentials for migration testing.
`test:core` creates its own fixtures and also runs existing CLI/daemon tests
with the explicit core path. Python remains required by the unmigrated runtime
and serves as a differential oracle for migrated operations.

Cargo.lock pins Rust dependencies. The crate declares Rust 1.89 minimum;
local validation uses Rust 1.96.1, not an MSRV test. The existing reusable CI
calls `core.yml` on macOS/Linux before the package job. It checks formatting,
Clippy, migration tests and release compilation. CI has been configured, not
executed remotely by this session. No new platform npm packages are published.

## Local verification on 2026-09-08

Latest follow-up: credential-lock fail-closed handling and Rust HTTP version
queries are implemented. Current counts are 44 default tests, 7 Rust HTTP tests,
25 core adapter tests and 20 Rust-path CLI/daemon/lock tests, all passing locally.
The earlier snapshot table below is historical. Per-stage evidence and remaining
risks are retained in the [SRE stage index](reports/sre-stages.md).

Host: macOS arm64, Node 22.20.0, Rust 1.96.1.

| Check | Result |
| --- | --- |
| Core differential/failure/concurrency/adapter tests | 25 passed, 0 failed |
| Existing CLI/daemon tests with explicit Rust core | 15 passed, 0 failed; unmigrated operations still Python |
| Complete default-path regression suite | 39 passed, 0 failed (includes a static Windows 5.1 source guard) |
| Local npm tarball installation | Passed on macOS arm64; default Python path, not platform-core packaging |
| `cargo build --release --locked` | Passed |
| `cargo fmt --all -- --check` | Passed |
| `cargo clippy --locked --all-targets -- -D warnings` | Passed |
| `git diff --check` | Passed |
| v2.9.0 baseline (`b40c791`) versus synchronized candidate | Existing account/daemon suite: 15/15 passed for each |
| v2.9.1 baseline (`9c70db9`) versus synchronized candidate | Existing account/daemon suite: 15/15 passed for each |

The test sets overlap; do not add their counts as unique behavioral coverage.
No new Rust artifact has been executed on cf-windows or ds-home, and this
slice provides no production-uptime or real OAuth measurements. Local synthetic
performance results are now recorded in [the interim SRE comparison](reports/rust-core-sre-comparison.md),
with [verification and remaining risks](reports/rust-core-validation.md).
The Windows guard checks source constraints only, not native execution of the
new artifact. The baseline comparison accepts `--baseline <commit-sha>` and
uses each revision's own package version in its isolated fixtures.

## Internal boundary

`src/shell/core-data.sh` routes 34 operations through named interfaces, including
the dedicated background credential holder.
`RELAY_CORE_BIN` must be an absolute executable path. At startup it must return
exactly `relay-core 1 2.9.1` for `protocol`. `build.rs` reads package.json and
requests recompilation when it changes, so protocol version does not depend on
a manually maintained Rust constant.
Missing, failed or mismatched explicitly selected binaries stop execution.
An operation failure is not retried with Python. With no explicit selection,
the stage-one Python implementation remains the default until distribution,
bootstrap and all operations are ready. This is a temporary migration switch,
not the planned final missing-core fallback policy.

| Module | Migrated operations |
| --- | --- |
| `data.rs` | `provider-field`, `provider-discover`, `account-email`, `access-token`, `format-json`, `read-version`, `provider-add`, `run-settings` |
| `config.rs` | `reorder`, `lock-add`, `unlock`, `warmup-add`, `warmup-remove`, `warmup-pause`, `warmup-resume`, `lock-default-config`, `warmup-ensure-config`, `config-save`, `codex-models-get`, `codex-models-set`, `codex-model-pick` |
| `ordering.rs` | `prompt-reorder`, `reorder-chain` |
| `display.rs` | `lock-list`, `warmup-list`, `warmup-health`, `autoswitch-config-summary`, `autoswitch-status`, `autoswitch-log`, `sessions` |
| dispatcher | `warmup-test` retains the existing no-op/warning; it is not a working warmup test |
| `storage.rs` | private atomic JSON replacement and serialized read-modify-write |
| `credential_lock.rs` | POSIX `credential-lock` FIFO holder, interoperable with the Python daemon's flock |
| `update_query.rs` | `latest-version`, `check-update-bg`; bounded HTTP metadata query with GitHub/npm fallback |

No arbitrary code evaluation is implemented by the Rust binary. JSON stream
operations use stdin; file operations accept paths and small scalar arguments.
Provider/settings creation currently retains the old environment-variable
adapter to keep tokens out of process arguments. A uniform structured-input
contract remains work for subsequent slices.

## State and error behavior

- Configuration updates acquire a stable `<config>.lock` sidecar, then re-read
  the JSON before modifying it. All migrated config writers use that lock.
- Default initialization checks existence again inside the lock, so a late
  initializer cannot erase a concurrent mutation. The order and config files
  are individually atomic replacements, not a two-file transaction.
- Interactive autoswitch settings now parse stdin before replacing the old
  file, merge settings under the same lock, and retain locks, warmup entries
  and unknown fields. A small `config_save.py` compatibility adapter preserves
  this safety fix on the default Python path during migration.
- Codex rotation matches the synchronized 2.9.1 feature, including pinned-model
  precedence, cursor reset and comma-list trimming. Rust picks serialize under
  the provider sidecar lock; a 30-process test verifies exact 10/10/10 rotation.
- Display differential tests compare exact ANSI output, including the existing
  next-account marker, health warning denominator and last-2000-line window.
  Session and event timestamps are tested against Python in UTC, Asia/Taipei
  and America/Los_Angeles across DST transitions. Chrono uses machine-local
  time, not a new UTC scheduling policy; see [Chrono Local](https://docs.rs/chrono/latest/chrono/struct.Local.html).
- Writes serialize before disk mutation, create a same-directory `0600`
  temporary file exclusively, sync it, atomically rename it and sync the parent
  directory on Unix. Ordinary failed writes clean up the temporary file.
  Abrupt termination may leave a private temporary file; scavenging is not yet
  implemented. Failure to sync the directory **after rename** reports that
  replacement happened but durability was not confirmed.
- Serde JSON uses `preserve_order` and `arbitrary_precision`, retaining unknown
  fields, insertion order and large JSON integers. Formatting uses literal UTF-8
  rather than Python's default ASCII escapes; parity is semantic JSON equality,
  not byte equality. See the [Serde JSON configuration](https://github.com/serde-rs/json/blob/master/Cargo.toml).
- Errors are short stderr diagnostics; parser inputs, credentials and environment
  values are not included. Invalid config types fail without truncating the old
  file. Optional Claude email metadata retains its empty-result behavior.
- `File::lock` requires Rust 1.89. Tests also verify interoperability with Python
  `fcntl.flock`, including release after holder termination. See the
  [Rust file-lock API](https://doc.rust-lang.org/std/fs/struct.File.html#method.lock).

The configuration sidecar is **not** `credential.lock`. Except for the new
`config_save.py` adapter, the old Python config/provider writers do not
participate in this configuration lock yet.
Concurrent Rust config writers are covered; mixed old/new writer safety is
not claimed. Do not use the development opt-in against an active real daemon.

## Remaining stage-two work

1. The five program ports are implemented. Python remains as the default adapter
   and differential oracle; remove it only after production rollout acceptance.
2. Credential locking, token re-read, concurrent rotation, usage/cache/refresh,
   rendering, updater networking and daemon ports now have regression evidence.
   See `reports/sre-v2.9.0-vs-rust-core.md` for exact coverage and limitations;
   passing fixtures is not exhaustive production acceptance.
3. Preserve the tested state schemas, output and local-time warmup behavior as
   the remaining distribution work is integrated.
4. Persistent Rust daemon deployment, enabled-service migration and rollback.
5. Exact-version platform packages, verified manual bootstrap, paired script/core
   updates and release ordering. Remove the transitional Python path only when
   all of these work without Python on supported POSIX targets.
6. Native/cross-architecture acceptance, Windows PowerShell non-regression and
   the planned old/stage-one/Rust SRE Markdown report with measured limitations.

The full cross-platform Rust public CLI remains a later project.

## Offline paired installer (2026-09-11)

`scripts/pair-install.cjs` now implements an explicit, offline POSIX installation
into a new/empty managed directory. It consumes **trusted, already unpacked**
main and native-core npm artifacts; local SHA256 checks detect corruption, not
publisher authenticity. It does not fetch artifacts, install global commands,
change npm's default runtime, or migrate existing services.

```sh
node scripts/pair-install.cjs install /absolute/unpacked-main /absolute/unpacked-core /absolute/new-managed-directory
/absolute/new-managed-directory/relay version
node scripts/pair-install.cjs rollback /absolute/new-managed-directory
```

Each candidate has its own immutable `releases/release-<id>/main` and `core`
directories. The installer verifies main/core versions, native metadata,
checksums, the actual core handshake and a shell startup probe before replacing
one `active.json` file. That file contains both current and previous release IDs.
The launcher reads it once per invocation, so a concurrent update cannot mix a
new script with an old binary. Rollback revalidates retained artifact bytes
before activating them. No automatic release garbage collection is performed.

The destination lock fails closed. A process crash can leave `.install-lock`;
inspect for a still-running installer before manually recovering that exact
lock. A failed commit attempt retains the candidate because a directory-sync
failure can occur after the activation rename; do not assume every reported
filesystem error means activation did not happen. Inspect `active.json` before
recovery. There is no claim of tested power-loss recovery.

Run `cargo build --release --locked` then `npm run test:core-pair`.
The six cases cover install/update/rollback, invalid versions and corrupted
artifacts, retained-release tampering, unmanaged destinations/install locks,
startup failure and an injected activation rename failure. Local macOS arm64
passed; POSIX CI now includes this suite after release build but has not been
triggered. A same-version second artifact tests activation mechanics; actual
cross-version release artifacts and Linux native execution remain to validate.

This installer does not yet supply registry optionalDependencies, a Node-free
manual bootstrap, public `relay update` integration or automatic daemon service
migration. The previously published report remains a dated snapshot, not proof
that these later integration steps are complete.
