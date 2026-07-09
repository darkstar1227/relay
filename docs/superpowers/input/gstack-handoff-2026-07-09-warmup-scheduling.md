# Gstack Handoff: Warmup Scheduling

_Source plan: docs/plans/2026-07-09-warmup-scheduling-design.md_
_Bridged: 2026-07-09_

## Overview

Adds a `relay warmup` feature that automatically switches to a specified Claude account at a specified daily time and fires a minimal non-interactive `claude -p ping`, so the account's rolling 5-hour usage window starts before the user actually begins working — shifting the window boundary to align with real work hours instead of whenever the user happens to send their first message. Extends the existing `autoswitch` daemon inside the single-file `relay` bash script rather than building a parallel scheduler.

## Goal

Let a `relay` user pre-warm a chosen account's 5-hour usage window at a chosen time of day, without manually remembering to send a throwaway message every morning.

## Success Metrics

- `relay warmup add/remove/list/pause/resume/test` all work and are wired into the existing top-level command dispatch and `cmd_help()`.
- A scheduled entry actually fires within a 15-minute grace window of its `HH:MM`, switches to the target account, pings, and restores the previously-active account.
- A scheduled entry that's missed (daemon offline past the grace window) is marked `missed`, not silently dropped, and does not fire late.
- No duplicate firing for the same account+time within the same calendar day.
- `relay status` shows a warmup health warning line only when 3+ of the last 7 days' attempts for an entry were `missed`/`ping_failed` — silent otherwise.
- `relay warmup add` warns if the autoswitch daemon isn't installed/running (the plan's single biggest identified first-run failure mode).
- Concurrent credential writes (CLI switch, autoswitch cycling, warmup firing) never corrupt the keychain/`current` file — verified via a lock.
- `bash -n relay` passes; all 13 testing-plan scenarios in the source plan pass.
- README gets a new `## Warmup` section with the disclosure copy; CLAUDE.md's mandatory Changelog/release-notes step is followed on the version bump that ships this.

## Scope

- New `warmup` array field in `~/.claude-relay/autoswitch.json` (account/time pairs).
- New `~/.claude-relay/warmup_state.json` (one record per `account|HH:MM` key per day: `ok`/`ping_failed`/`missed`/`missing_account`/`already_active`).
- New `~/.claude-relay/claude_bin` file, written by `cmd_autoswitch_start()`, giving the daemon a reliable absolute path to the `claude` binary regardless of the daemon's runtime `PATH`.
- Daemon (`DAEMON_EOF` Python heredoc inside `relay`): `check_warmup()`, `do_warmup()`, `get_claude_bin()`, called from `main()` *before* the existing `if not cfg: continue` short-circuit so it works even without autoswitch cycling enabled.
- Cross-process credential lock (`${RELAY_DIR}/credential.lock`, `fcntl.flock()`) wrapping every credential-mutating call site: `do_switch()` (bash + Python versions), `try_refresh_daemon()`'s keychain write, `do_warmup()`.
- Shared atomic-write helper (`save_json_atomic()`: write to `.tmp` + `os.replace()`) used by `save_warmup_state()`, `save_cache()`, and `autoswitch.json` writes — this also resolves the pre-existing TODOS.md P3 item about `usage_cache.json` corruption.
- CLI: `relay warmup add|remove|list|pause|resume|test`, added to the existing top-level `case "${CMD}"` dispatch and `cmd_help()`.
- `relay status` gains a warmup health line (parsed from `autoswitch.log`, not a new schema).
- `load_config()` adjusted so a `warmup` field survives even when the 2-accounts auto-default path would otherwise return `None`.
- `log_event('config_parse_error', ...)` added to `load_config()`'s exception path.
- README `## Warmup` section + CLAUDE.md-mandated Changelog/release entry on ship.

## Non-Goals

- Ping-failure auto-retry (explicitly decided against during brainstorming, reconfirmed during review despite Codex's objection).
- "Is the window still fresh" pre-check via `five_hour` timestamp lookup before pinging (rejected as disproportionate complexity — the much cheaper `already_active`-vs-`CURRENT_FILE` check covers the common case instead).
- Timezone/DST-aware scheduling (deferred to TODOS.md as P3 — naive local time via `datetime.now()` is accepted for this scope).
- Parallel/threaded firing of multiple due warmup entries in the same poll (accepted: they serialize, worst case N × 30s, negligible against the 15-minute grace window).
- Native OS scheduler (`systemd-timer`/`launchd` one-shot jobs) as an alternative to daemon polling (deferred to TODOS.md — reconsider only if daemon polling proves flaky in practice).
- Any change to the 5-hour/weekly usage limit mechanics themselves — this feature only changes *when* a window starts, verified empirically to not increase total quota.

## Technical Constraints

- Single-file `relay` bash script containing an embedded Python 3 heredoc (`DAEMON_EOF`) for the daemon — bash and Python halves both need edits (locking touches both `do_switch()` variants).
- Cross-platform: macOS (Keychain via `security` CLI) and Linux (`~/.claude/.credentials.json`); Windows has a separate `relay.ps1`/`relay.cmd` not covered by this plan.
- Daemon runs under launchd (macOS), systemd user service (Linux), or a cron fallback — its `PATH` may not include `claude`, hence the `claude_bin` file.
- No new external dependencies — Python stdlib only (`fcntl`, `json`, `subprocess`, `datetime`, `os`, `shutil`).
- Must not break existing `autoswitch` cycling behavior (threshold-based account rotation) — warmup is additive and must restore whatever account was active before it fired.
- Existing code conventions to match: single-line `err "..."`/`warn "..."` messages (not multi-line problem/cause/fix blocks), `log_event()`/`notify()` for daemon-side signaling, JSON config files under `~/.claude-relay/`.

## Architecture Decisions

- **Extend the existing daemon rather than build a separate scheduler** (rejected alternatives: standalone cron job per entry — would duplicate 3-platform credential-switching logic and race with the daemon; native `at`/systemd-timer one-shot jobs — no Windows path, `at` often disabled by default).
- **Restore-after-ping, not leave-switched.** `do_warmup()` records `current_before`, and in a `finally` block switches back unless the warmed account was already current.
- **`already_active` skip is a `CURRENT_FILE` string comparison, not a usage-API check.** Distinct from and cheaper than the rejected "is window still fresh" idea.
- **Health indicator reads `autoswitch.log`, not `warmup_state.json`.** The state file only ever holds *today's* outcome per key — it structurally cannot answer a "last 7 days" question, so the 7-day health line must derive from the append-only log instead.
- **`missing_account` does not gate for the day.** Every other terminal status (`ok`, `ping_failed`, `missed`) writes `state[key] = {'date': today, ...}` to block re-firing; `missing_account` deliberately does NOT write, so the entry keeps retrying every poll until the 15-minute grace window elapses (at which point it falls through to `missed`, which does gate).
- **Ping timeout is 30s, not 120s**, to bound how long a single warmup firing can block the daemon's single-threaded main loop.
- **Disclosure is a literal, drafted sentence** (see below), not a vague "must mention this happens" requirement — printed on `warmup add` success and as the README section's opening line.

## File Structure Assumptions

- `relay` [EXISTING] — all changes land here: `load_config()`, `main()` (insertion point for `check_warmup()` before its `if not cfg: continue`), new `check_warmup()`/`do_warmup()`/`get_claude_bin()`/`save_json_atomic()` functions inside the `DAEMON_EOF` Python heredoc; `cmd_autoswitch_start()` (write `claude_bin`, validate `REAL_CLAUDE`); new `cmd_warmup_*()` bash functions; top-level `case "${CMD}"` dispatch; `cmd_help()`; `do_switch()` (both bash and Python versions get lock-wrapped); `cmd_status`/`render_table` (new health line).
- `README.md` [EXISTING] — new `## Warmup` section, account-management table row, `## Changelog` entry on version bump (per CLAUDE.md).
- `TODOS.md` [EXISTING] — already has the timezone/DST deferral entry added during review; the existing P3 cache-lock entry is effectively resolved by the new atomic-write helper (should be removed or marked resolved once implemented).
- `~/.claude-relay/autoswitch.json` [runtime config, not a repo file] — gains `warmup` array and `warmup_enabled` boolean.
- `~/.claude-relay/warmup_state.json` [NEW runtime file] — per-entry daily outcome.
- `~/.claude-relay/claude_bin` [NEW runtime file] — absolute path to `claude` binary.
- `~/.claude-relay/credential.lock` [NEW runtime lock file] — `fcntl.flock()` target.

## Proposed Implementation Areas

1. **Credential-write locking** — add `credential.lock` + `fcntl.flock()` wrapping around `do_switch()` (bash + Python), `try_refresh_daemon()`'s keychain write. Foundational: everything else in this feature writes credentials through `do_switch()`, so this should land first and be tested against existing switch/autoswitch behavior before warmup-specific code is added, since it changes shared code paths.
2. **Atomic JSON writes** — add `save_json_atomic()` to the daemon, migrate `save_cache()` and `autoswitch.json` writes onto it (resolves the existing TODOS.md P3 item). Small, isolated, no behavior change for existing features — safe to land independently and early.
3. **Daemon warmup engine** — `check_warmup()`, `do_warmup()`, `get_claude_bin()`, the `main()` insertion point fix, `load_config()`'s `warmup`-survives-auto-default fix, and the `config_parse_error` log line. This is the functional core; depends on areas 1 and 2 being in place first (it uses the lock and the atomic-write helper).
4. **CLI surface** — `relay warmup add/remove/list/pause/resume/test`, dispatch wiring, `cmd_help()` entry, the literal `err`/`warn` copy, the daemon-not-running guard rail, the disclosure copy on `add`. Depends on area 3 (calls into the same config shape and, for `test`, calls `do_warmup()` directly).
5. **`relay status` health line + docs** — the 7-day `autoswitch.log`-derived health warning in `render_table`/`cmd_status`, plus the README `## Warmup` section and Changelog entry. Depends on area 3 (log event names must exist first) and can land last.

## Verification Expectations

- `bash -n relay` after every area lands.
- Manual empirical check already done and does not need repeating: `claude -p "ping"` on an account confirmed to advance `five_hour.resets_at` by a full 5 hours when timed right after the prior window expired (verified 2026-07-09 against the live `/api/oauth/usage` endpoint, bypassing the CLI cache).
- The source plan's 13-item testing plan (docs/plans/2026-07-09-warmup-scheduling-design.md, "## Testing plan" section) is the authoritative test list — writing-plans should turn each into a concrete step, notably:
  - Kill daemon (`SIGKILL`) mid-write, restart, confirm no corrupt/truncated state file and no duplicate same-day firing.
  - Corrupt `autoswitch.json`, confirm `config_parse_error` in `autoswitch.log`, not silent.
  - Two entries 1 minute apart, confirm the second still fires within grace despite the first blocking the loop.
  - `relay switch` (CLI) concurrent with a daemon-fired warmup ping for a different account, confirm the lock prevents corruption.
  - `missing_account` → add the account before the grace window elapses → confirm it fires instead of waiting for tomorrow.
  - `pause` mid-day with a pending entry → `resume` before its time passes → confirm it still fires.
- No specific automated test framework is implied by the existing codebase (no `test/` directory referenced anywhere in the source plan or CLAUDE.md) — treat the testing plan as manual/scripted verification steps, not a request to introduce a new test framework.

## Open Questions / Explicit Assumptions

- [ASSUMPTION] The exact bash line numbers cited in the source plan (e.g. `relay:1062-1064`, `relay:1201`, `relay:1757`, `relay:1795-1826`) are approximate anchors from the review, not guaranteed current — the implementer should re-locate these by function name (`load_config`, `main`, `cmd_autoswitch_start`, `cmd_help`, the top-level `case` dispatch) rather than trusting line numbers, since the file may have shifted since the review.
- [ASSUMPTION] "Restore whatever account was active before" means comparing against `CURRENT_FILE`'s contents at the moment `do_warmup()` starts, not some other notion of "user's preferred account" — this matches the source plan's code snippet exactly.
- [ASSUMPTION] The README's existing structure (an "Autoswitch" section, an account-management command table) is assumed present based on the plan's references to it; the implementer should locate the actual existing README structure before drafting the new section, rather than assuming exact heading text.
- [OPEN] Whether the existing TODOS.md P3 "Cache file lock" entry should be deleted or marked resolved once the atomic-write helper ships — the source plan says this implementation "folds in" that item but doesn't explicitly say to remove the TODOS.md entry. Leave this as a small decision for whoever closes out the TODOS.md bookkeeping after implementation.
- [OPEN] Exact wording/formatting of the new README `## Warmup` section beyond the mandated opening disclosure sentence — the source plan gives the disclosure sentence verbatim but not the rest of the section's prose; writing-plans or the implementer should draft it consistent with the existing README's tone.
