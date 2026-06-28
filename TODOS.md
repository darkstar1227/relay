# TODOS

## P2 — Refresh-token rotation race

**What:** Add a per-account file lock around `try_refresh()` to prevent concurrent refresh attempts.

**Why:** The relay CLI (fetch() in ThreadPoolExecutor) and the autoswitch daemon can both call try_refresh() on the same account simultaneously. If Anthropic uses single-use refresh tokens (OAuth best practice), whichever caller gets there second will fail — the refresh token was already consumed. The second caller returns None → account shows "⚠ expired" for one render cycle even though the account is actually healthy.

**Current behavior on race loss:** The losing caller returns `name, 'expired'`, showing "⚠ expired — run relay refresh" — incorrect UX since the account was just refreshed.

**Fix:** Before `try_refresh(name, cred_path)`, acquire a per-account lock file (`{creds_dir}/{name}.refresh.lock`). Release after write. Use `fcntl.flock()` on macOS/Linux.

**Context:** There's no evidence Anthropic currently rotates refresh tokens, but OAuth 2.0 RFC 6749 §6 recommends it. This becomes load-bearing if they enable rotation.

**Depends on:** T3 (try_refresh() wired into fetch())

---

## P3 — Cache file lock

**What:** Add a file lock around `save_cache()` to prevent concurrent JSON write corruption.

**Why:** `fetch()` runs in `ThreadPoolExecutor` with up to 6 workers. Each thread calls `save_cache(c)` which does `json.dump(c, f)`. Multiple threads writing to the same file concurrently can produce a partial/corrupt JSON. The dict `c` is shared across threads (same `_cache` global), so two threads may interleave their writes to `usage_cache.json`.

**Fix:** Wrap `save_cache()` with `fcntl.flock()` (macOS/Linux) or a `threading.Lock()` at minimum. The threading.Lock() covers in-process concurrency; fcntl covers cross-process (daemon also writes to the same cache file).

**Context:** Daemon writes to the same `usage_cache.json`. The corruption risk is low (cache is non-critical — worst case is one stale/missing usage entry) but the fix is trivial.

**Depends on:** T3 (after try_refresh() lands)
