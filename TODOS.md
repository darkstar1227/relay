# TODOS

## P2 — Refresh-token rotation race

**What:** Add a per-account file lock around `try_refresh()` to prevent concurrent refresh attempts.

**Why:** The relay CLI (fetch() in ThreadPoolExecutor) and the autoswitch daemon can both call try_refresh() on the same account simultaneously. If Anthropic uses single-use refresh tokens (OAuth best practice), whichever caller gets there second will fail — the refresh token was already consumed. The second caller returns None → account shows "⚠ expired" for one render cycle even though the account is actually healthy.

**Current behavior on race loss:** The losing caller returns `name, 'expired'`, showing "⚠ expired — run relay refresh" — incorrect UX since the account was just refreshed.

**Fix:** Before `try_refresh(name, cred_path)`, acquire a per-account lock file (`{creds_dir}/{name}.refresh.lock`). Release after write. Use `fcntl.flock()` on macOS/Linux.

**Context:** There's no evidence Anthropic currently rotates refresh tokens, but OAuth 2.0 RFC 6749 §6 recommends it. This becomes load-bearing if they enable rotation.

**Depends on:** T3 (try_refresh() wired into fetch())

---

## P3 — Warmup scheduling: `relay warmup test` is a non-functional stub

**What:** `relay warmup test <account>` (relay, `cmd_warmup_test()`) prints that it's switching/pinging/restoring, but never actually calls `do_warmup()` — it always ends in a warning explaining it's not wired up yet.

**Why:** `do_warmup()` lives inside the daemon's extracted Python heredoc (`_extract_daemon()`'s output file), not directly callable from the bash CLI process. Wiring this up needs either extracting the daemon module path and shelling out to it, or duplicating `do_warmup()`'s logic in the CLI's own Python invocations. Deferred at implementation time (2026-07-09) as a P2/nice-to-have per the implementation plan's Task 5 note — flagged again by the final `codex exec review` pass on the same date (the stub does print an honest warning rather than a silent false-positive, so severity is low, but it currently gives zero real self-diagnosis value).

**Fix:** Locate `AUTOSWITCH_DAEMON` path resolution (used by `_extract_daemon()`), ensure the daemon has been extracted at least once (run `_extract_daemon` if the file doesn't exist yet), then shell out via `"${py}" -c "import sys; sys.path.insert(0, '<dir>'); from <daemon_module> import do_warmup; do_warmup('<account>')"` or equivalent.

---

## P3 — Warmup scheduling: timezone awareness

**What:** `relay warmup` entries store `HH:MM` and are matched against `datetime.now()` (machine local time). No explicit timezone handling.

**Why:** Deferred from the warmup scheduling CEO review (2026-07-09) — not in original scope discussion, and a laptop's system clock already adjusts when the user travels, so the existing behavior is correct for the common case. Only becomes a real gap if someone runs the daemon on a machine that stays in a fixed timezone while the user's actual working hours shift (e.g. a home server, or explicit UTC scheduling needs).

**Fix (if ever needed):** Add an optional `tz` field per warmup entry, resolved via `zoneinfo`, defaulting to system local time when absent.

---

**RESOLVED (2026-07-09, warmup implementation):** see Task 1 of docs/plans/2026-07-09-warmup-scheduling-implementation.md — save_json_atomic() now used by save_cache().

## P3 — Cache file lock

**What:** Add a file lock around `save_cache()` to prevent concurrent JSON write corruption.

**Why:** `fetch()` runs in `ThreadPoolExecutor` with up to 6 workers. Each thread calls `save_cache(c)` which does `json.dump(c, f)`. Multiple threads writing to the same file concurrently can produce a partial/corrupt JSON. The dict `c` is shared across threads (same `_cache` global), so two threads may interleave their writes to `usage_cache.json`.

**Fix:** Wrap `save_cache()` with `fcntl.flock()` (macOS/Linux) or a `threading.Lock()` at minimum. The threading.Lock() covers in-process concurrency; fcntl covers cross-process (daemon also writes to the same cache file).

**Context:** Daemon writes to the same `usage_cache.json`. The corruption risk is low (cache is non-critical — worst case is one stale/missing usage entry) but the fix is trivial.

**Depends on:** T3 (after try_refresh() lands)
