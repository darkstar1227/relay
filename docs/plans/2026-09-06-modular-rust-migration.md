# Relay migration and SRE comparison

## Accepted delivery sequence

1. Split Bash/Python sources, assemble the existing single-file release, add
   isolated regression tests and validate the exact npm tarball in CI.
2. **Stop for user acceptance of stage one.** Only after acceptance, replace
   Relay's internal Python with a modular Rust core while retaining Bash and
   the current Windows PowerShell CLI.
3. After both stages, write `docs/reports/sre-v2.9.0-vs-rust-core.md` comparing
   the baseline and completed implementation. A fully Rust cross-platform CLI
   is future work, not part of these two stages.

No Superpowers workflow is used. Preserve unrelated workspace changes and
generated OpenWiki pages. Do not publish or bump versions as part of local
implementation.

## Baseline and stage-one acceptance

The verified published baseline is `v2.9.0`, commit
`b40c791cab7ece474119071db8f15f840453dab0`, including `relay proxy`.
The stage-one executable must match its original bytes except for the generated
source notice. Source assembly must be deterministic; the existing single-file
manual installation/update and npm runtime layout remain usable.

Acceptance addendum: the user delegated acceptance and requested working updates.
The initial split satisfied byte identity, but acceptance exposed existing update
failure reporting, standalone version and symlink defects. Targeted updater and
daemon redeploy fixes are included in stage one and tested separately; byte
identity is no longer the final candidate's acceptance condition. The full Rust
core remains stage two.

Stage-one acceptance requires source checks, isolated behavior tests, baseline
comparison and local package installation results. Report CI platforms separately
from locally executed checks. Keep the existing public version `2.9.0` until an
explicit release is requested.

## Stage-two design

Implementation started on 2026-09-08 after the user accepted stage-one remote
installation checks and requested "開始rust core". The first opt-in migration
slice and outstanding work are tracked in
[`../development-rust-core.md`](../development-rust-core.md). This is not a
stage-two completion or release declaration.

Synchronization addendum: another session advanced HEAD to v2.9.1 (`9c70db9`)
during stage two. The user requested synchronization; the current candidate
retains its Codex model rotation and restores the assembly/CI/Windows acceptance
changes that were not in that commit. The original v2.9.0 SRE baseline remains
unchanged; v2.9.1 is an additional compatibility checkpoint. No new version or
release was created by this migration session.

- Replace every inline/heredoc Python call and Python daemon startup with
  explicit Rust core operations: structured data, provider settings, sessions,
  version/update queries and downloads, usage/cache/refresh, presentation,
  account locking, automation configuration and the daemon.
- Use named internal subcommands, stdin JSON for structured inputs and stderr
  diagnostics; maintain the existing public CLI output and argument boundaries.
  Check an explicit core protocol/version handshake. Never implement arbitrary
  code evaluation as a compatibility interface.
- Centralize account writes and refresh under the compatible POSIX flock
  protocol. Re-read credentials after acquiring the lock, retain unknown JSON
  fields and use private, atomic file replacement. Test the rotation race rather
  than assuming a rewrite fixes it.
- Preserve state schemas, ordering, thresholds and local-time warmup behavior.
  LiteLLM remains external. Windows stays PowerShell until the later full CLI
  project; do not introduce Windows automation feature parity here.
- Publish platform-specific `@dst-justin/relay-core-{darwin,linux}-{x64,arm64}`
  packages with OS/CPU selection and exact-version optional dependencies from
  the main package. Use musl Linux artifacts; keep TLS verification enabled.
  Missing/mismatched npm cores produce an actionable error, not a Python fallback
  or implicit source compilation.
- Retain old single-file upgrade entrypoints. The first manual bootstrap uses
  Shell to fetch and checksum the matching Release core without Node/Python/Rust.
  Later updates stage script and binary as one versioned installation, validate
  before switching, and retain the prior working version on failure.
- Persist the daemon outside npx caches. Migrate launchd/systemd/cron definitions
  only for previously enabled services, confirm startup and restore the previous
  deployment if migration fails.
- CI builds and tests all target artifacts, publishes the platform packages and
  Release assets before the main package, and validates rerun consistency.
  Confirm permission to publish the new package names before a real release.

## SRE assessment after both stages

Deliver a Markdown report and reproducible measurement commands/fixtures.
Identify baseline commit, candidate commit/worktree diff, artifact hashes,
hardware, OS, toolchain, test date and sampling conditions. Keep baseline,
stage-one and Rust-core measurements separate so packaging refactors are not
mistaken for runtime improvements.

| Dimension | Evidence to collect |
| --- | --- |
| Latency | CLI startup and list/status timings; cached and controlled HTTP cases; report sample count, median, p95 and failures |
| Resources | CLI/daemon CPU and peak/steady RSS, subprocess count, binary/install size; distinguish cold and warm runs |
| Consistency | Concurrent refresh/switch, token rotation, lock release after termination, atomic state writes |
| Failure recovery | 401/429/timeouts, invalid cache/config, interrupted downloads, checksum mismatch, daemon restart and failed migration rollback |
| Observability | Existing versus new logs, error classification, actionable diagnostics and missing telemetry |
| Delivery | Reproducible assembly, exact artifact testing, platform-package version pairing, installation/update/rollback checks |
| Portability | macOS/Linux architecture results and Windows non-regression; separate native execution from cross-compilation |
| Operational burden | Runtime dependencies, module boundaries, test coverage of critical flows and release coordination |

Use identical synthetic inputs, temporary state and controlled network responses
for comparative measurements. Default to 5 warmups and 30 measured runs per CLI
scenario with old/new runs interleaved. Measure the daemon over the same bounded
idle and active intervals; report interval length and poll settings. Record
errors as failures instead of dropping slow or failed samples.

Do not claim production uptime, SLA/SLO attainment, MTTR or real API performance
from local tests. Mark unavailable evidence UNKNOWN / not measured. Distinguish
measured findings, static analysis and planned improvements, and include
regressions and limitations. The final SRE report is intentionally deferred until
the Rust core is implemented and verified.
