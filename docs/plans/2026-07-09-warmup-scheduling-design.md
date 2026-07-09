<!-- /autoplan restore point: /Users/ds-anxing/.gstack/projects/darkstar1227-relay/main-autoplan-restore-20260709-164944.md -->
# Warmup Scheduling Design

**Goal:** Add a feature to `relay` that automatically switches to a specified account at a specified daily time and sends a minimal non-interactive ping to Claude, so the 5-hour usage session starts before the user actually begins working.

**Architecture:** Extends the existing `autoswitch` daemon (single Python heredoc inside the `relay` bash script). Reuses existing daemon primitives (`do_switch`, `log_event`, `notify`, `load_config`) rather than building a parallel scheduling system.

---

## Data model

New `warmup` array in `~/.claude-relay/autoswitch.json`, alongside `order`/`thresholds`/`locks`:

```json
{
  "order": ["work", "personal"],
  "thresholds": {"work": 80, "personal": 80},
  "locks": [],
  "warmup": [
    {"account": "work", "time": "06:00"},
    {"account": "personal", "time": "11:00"}
  ]
}
```

- Multiple entries per account are allowed (e.g. warm up twice a day).
- `time` is local 24hr `HH:MM`.
- Independent of `order`/`thresholds` — works even for a single-account setup with no autoswitch cycling enabled.

New state file `~/.claude-relay/warmup_state.json`, keyed by `"<account>|<HH:MM>"`:

```json
{
  "work|06:00": {"date": "2026-07-09", "status": "ok"},
  "personal|11:00": {"date": "2026-07-08", "status": "missed"}
}
```

`status` ∈ `ok`, `ping_failed`, `missed`, `already_active`. One record per key per day — once a key has a record for today, it's not touched again until the next day. `missing_account` is not a stored status — see below: it never writes to this file at all, so a pending-but-not-yet-existing account retries every poll within the grace window with zero state persisted.

**Multiple accounts scheduled at/near the same time (user-raised, revised in this review).** `check_warmup()`'s `for entry in entries` loop processes due entries one at a time within a single poll — each does its own switch → ping → restore before the next entry starts, so N accounts due in the same poll cycle never interfere with each other's credentials, but do serialize: worst case N × 30s of daemon-loop blocking in that one poll (negligible against a 15-minute grace window for any realistic N of a handful of accounts). **Cheaper fix for the common sub-case (user-raised):** if the scheduled account is already the currently active account when its slot comes due, skip the switch/ping/restore dance entirely — mark `already_active` and move on. This is a different, near-zero-cost check than the CEO-phase-rejected "is the window still fresh" idea (decision #6, which needed a `five_hour` timestamp lookup); this one only compares against `CURRENT_FILE`, which `check_warmup()` already has to read.

Also new file `~/.claude-relay/claude_bin`, written at daemon start time with the absolute path to the `claude` executable (resolved by the bash script via `command -v claude`, same as existing `REAL_CLAUDE`). The daemon's Python process may run under launchd/systemd/cron with a minimal `PATH`, so it can't reliably re-resolve `claude` itself — it reads this file, falling back to `shutil.which('claude')`.

## CLI commands

```
relay warmup add <account> <HH:MM>     # add a schedule entry; account must exist; HH:MM validated
relay warmup remove <account> [HH:MM]  # no time = remove all entries for account; with time = remove that one entry
relay warmup list                      # show account / time / most recent status
relay warmup pause                     # suspend all warmup firing without deleting entries (e.g. vacation)
relay warmup resume                    # re-enable
relay warmup test <account>            # fire do_warmup() once immediately, bypassing the schedule — self-diagnosis
```

`pause`/`resume` toggle a top-level `"warmup_enabled": false` field in `autoswitch.json` (defaults to `true`/absent = enabled). `check_warmup()` in the daemon returns immediately if `cfg.get('warmup_enabled', True)` is `False` — entries and their state stay intact, so resuming picks up exactly where the schedule left off (today's already-fired/missed keys still apply if resumed same day).

**Health visibility (added per CEO review — missed firings were otherwise silent).** `relay status`'s existing summary output gains one line when `warmup` entries exist. **Correction (caught by Eng review — Codex):** `warmup_state.json` only ever holds one record per key (today's), so it cannot answer "missed how many of the last 7 days." The health line instead parses the last 7 days of `warmup_missed`/`warmup_ping` events out of the existing `autoswitch.log` JSONL (already timestamped, already written by `log_event()` — no new schema), grouped by account+time key, and prints a warning (e.g. `⚠ warmup: work 06:00 missed 4/7 days`) if 3+ of the last 7 matching log entries are `missed`/`ping_failed`. Silent when healthy or when the log doesn't go back 7 days yet.

**Command surface note (Eng review — Codex):** existing autoswitch diagnostics live under `cmd_autoswitch_status()`, not `relay status`. This health line is added to `relay status` anyway (not `relay autoswitch status`) because warmup is meant to work independently of autoswitch cycling being enabled at all (see Data model) — a user with warmup but no cycling would never run `relay autoswitch status`.

- `add`/`remove` on a missing `autoswitch.json` writes the full default config (same shape the daemon auto-generates for 2+ accounts) plus the `warmup` field, so cycling isn't silently disabled by a partial write.
- `remove` on a non-existent entry warns but doesn't error.
- Invalid `HH:MM` (e.g. `6:00`, `25:00`) is rejected with a format hint.

**Literal CLI copy (added per DX review — both voices flagged that error/disclosure text was never drafted, only described).** `relay` error messages are a single terse `err "..."` line (existing style, e.g. `cmd_lock`'s `err "Account '${name}' not found"`) — warmup follows the same convention, not a problem/cause/fix triad:

```
err "Invalid time '${input}' — expected HH:MM, 00:00–23:59 (e.g. 06:00)"
err "Account '${name}' not found — run 'relay list' to see accounts, or 'relay add ${name}' first"
warn "No warmup entries for '${name}'"                          # remove on nonexistent entry
```

**Disclosure copy (added per DX review — literal wording drafted, not just "must state plainly").** Printed once on `relay warmup add` success, and as the opening line of the README's Warmup section:

> "Warmup runs a real, non-interactive `claude -p ping` call to Anthropic's API on your machine in the background at the scheduled time — it does not send your credentials anywhere, and it does not increase your weekly usage cap. It only starts your rolling 5-hour usage window earlier."

**Daemon-not-running guard rail (added per DX review — both voices independently flagged this as the single biggest first-run failure mode: a schedule that silently never fires because the daemon was never started).** `relay warmup add`'s success output checks whether the autoswitch daemon is installed (same check `cmd_autoswitch_status()` already uses — lock file / launchd plist / systemd unit / crontab entry) and appends a warning line if not:

```
✓ warmup: work will fire at 06:00
⚠ background daemon isn't running — this won't fire until you run: relay autoswitch start
```

- `list` output example (now includes pause state, daemon running state, and the `already_active` outcome):
  ```
  ⏸ warmup paused — run 'relay warmup resume' to re-enable
  daemon: not running — run 'relay autoswitch start'

  work       06:00   最後: 2026-07-09 成功
  personal   11:00   最後: 2026-07-08 錯過
  new_acct   09:00   尚未觸發
  current    07:00   最後: 2026-07-09 已在該帳號，跳過 ping
  ```
  The `⏸`/`daemon:` header lines only appear when relevant (paused, or daemon not installed) — silent otherwise, matching the existing `relay status` convention of no noise in the healthy case.

**Self-diagnosis command (added per DX review — Claude subagent, low severity, small enough to include).** `relay warmup test <account>` runs `do_warmup(account)` once immediately, bypassing the schedule/grace-window check entirely — lets a user verify their setup works without waiting for the real clock time or hand-editing state files (which is otherwise the only way, per the testing plan's own step 3).

## Daemon logic

`load_config()` is adjusted so that a `warmup` field in `autoswitch.json` is still surfaced even when the auto-default path would otherwise return `None` (fewer than 2 accounts).

**Correction (caught by CEO review's independent subagent):** `main()`'s existing `cfg = load_config(); if not cfg: time.sleep(60); continue` (relay:1062-1064) short-circuits *before* any `order` check — so for a single-account setup with no explicit config file, `cfg` itself is `None` and the loop never reaches a warmup call placed after that point, contradicting this design's own goal of warmup working without cycling enabled. Fix: read `warmup` from a raw JSON load of `autoswitch.json` (or from `cfg` only when non-`None`, falling back to a raw parse when `cfg is None`) and call `check_warmup()` *before* the `if not cfg: continue` line, not after it.

**Pre-implementation verification — DONE, 2026-07-09.** Verified directly against the `/api/oauth/usage` endpoint (bypassing the CLI's own cache) on the `work` account, timed right as its existing window expired: before ping, `five_hour.resets_at` = `2026-07-09T12:39:59Z`, `utilization` = 100%. After `claude -p "ping"`, `five_hour.resets_at` = `2026-07-09T17:39:59Z` (a full 5h later, anchored to the ping), `utilization` = 2% (just the ping's own cost). Confirms the core assumption: pinging when no window is active starts a fresh 5-hour window anchored to that moment. Feature mechanism is sound — implementation can proceed.

**Disclosure requirement (CEO review gate):** `relay warmup add`'s output and the README section for this feature must state plainly that warmup fires a real, non-interactive API call to Anthropic in the background — not just a local credential swap. This keeps the automation transparent to the user, consistent with Anthropic officially supporting scripted/automated Claude Code CLI use on the user's own machine (see legal-and-compliance docs) — warmup does not extract or relay OAuth tokens off-device, and does not increase the account's weekly usage cap, it only shifts when the rolling 5-hour window's boundary falls.

`main()` calls `check_warmup(...)` at the corrected insertion point above, so warmup fires independently of cycling.

**Credential-write locking (added per Eng review — Codex, High).** `do_switch()`/`kc_write()`/`try_refresh_daemon()` all mutate the same live credential store (keychain on macOS, `~/.claude/.credentials.json` on Linux) and `CURRENT_FILE`, and today only a single-instance daemon lock exists — nothing prevents a CLI-invoked `relay switch`, a threshold-triggered autoswitch cycle, and a warmup firing from interleaving their writes if they land in the same few hundred milliseconds. This was always a latent risk in the existing code, but warmup adds a new *scheduled* (not user-initiated) writer, meaningfully raising the odds of collision. Fix: add a cross-process file lock (`${RELAY_DIR}/credential.lock`, `fcntl.flock()` on macOS/Linux) around every credential-mutating call site — `do_switch()` (both the bash and Python versions), `try_refresh_daemon()`'s keychain write, and the new `do_warmup()`. This is a small, mechanical addition (wrap existing call sites, no new logic) but touches both the bash and Python halves of `relay`, so it's listed as its own Eng-phase task in the implementation plan, not folded silently into `do_warmup()`.

**`claude_bin` wiring (added per Eng review — Codex, Medium).** The design says this file is "written at daemon start" but doesn't say where. Concretely: in `cmd_autoswitch_start()` (relay, near the `REAL_CLAUDE` resolution at the top of the file), before extracting the daemon heredoc or installing the launchd/systemd/cron service, validate `[[ -n "${REAL_CLAUDE}" ]]` and `[[ "${REAL_CLAUDE}" != "$0" ]]` (guard against pointing at the relay wrapper itself), then `echo "${REAL_CLAUDE}" > "${RELAY_DIR}/claude_bin"`. If `REAL_CLAUDE` is empty, `cmd_autoswitch_start()` prints a warning that warmup will fall back to `shutil.which('claude')` at ping time and may fail if `claude` isn't on the daemon's `PATH`.

**Ping timeout (revised per Eng review — Claude subagent, Medium).** `do_warmup()` runs `subprocess.run(...)` synchronously inside the daemon's single-threaded main loop, blocking usage polling and other warmup entries for the call's duration. Rather than adding background-thread complexity (unjustified for a once-a-day, sub-minute operation), shrink the timeout from 120s to 30s — a `-p ping` call has no reason to take longer, and a 30s block is negligible against the 15-minute grace window. Document that warmup entries scheduled within ~1 minute of each other may cause the second to run slightly late (still normally within grace).

**`missing_account` no longer terminal for the day (revised per Eng review — Codex, Medium).** Original design marked `missing_account` with today's date, blocking retry until tomorrow — hostile if the account appears mid-window (e.g. user is mid-`relay add` when the scheduled time hits). Revised: on `missing_account`, do NOT write a `state[key]` gate — leave the key unset so the next poll retries. If the account still doesn't exist by the time the 15-minute grace window elapses, the entry naturally falls through to the existing `missed` path (which does gate for the day) via the grace-window check that runs first in `check_warmup()`'s loop body.

**Malformed `autoswitch.json` (added per Eng review — Claude subagent, Medium).** `load_config()`'s bare `except:` silently falls back to the auto-default (which omits `warmup`), so a JSON syntax error disables warmup with zero signal. Fix: on that exception path, call `log_event('config_parse_error', error=str(e))` before falling back, so `autoswitch.log` (and therefore the `relay status` health line, which reads that log) surfaces the problem instead of just going quiet.

**CLI dispatch location (Eng review — Codex, Low).** New `relay warmup add/remove/list/pause/resume` subcommands are added to the existing top-level `case "${CMD}"` dispatch block (relay, near the `autoswitch|as)` case), with corresponding help text added alongside the existing command list in `cmd_help()`.

```python
def check_warmup(entries):
    if not entries: return
    state = load_warmup_state()
    now = datetime.datetime.now()
    today = now.strftime('%Y-%m-%d')
    changed = False
    for entry in entries:
        acct, hhmm = entry.get('account'), entry.get('time')
        if not acct or not hhmm: continue
        key = f'{acct}|{hhmm}'
        if (state.get(key) or {}).get('date') == today:
            continue
        try:
            h, m = map(int, hhmm.split(':'))
            scheduled = now.replace(hour=h, minute=m, second=0, microsecond=0)
        except: continue
        if now < scheduled:
            continue
        if (now - scheduled).total_seconds() > 900:  # 15 min grace window
            state[key] = {'date': today, 'status': 'missed'}
            log_event('warmup_missed', account=acct, time=hhmm)
            changed = True; continue
        if not os.path.exists(os.path.join(CREDS_DIR, acct + '.json')):
            log_event('warmup_pending', account=acct, reason='missing_account')
            continue  # deliberately no state[key] write — retries every poll until grace window elapses (see #18)
        current_now = open(CURRENT_FILE).read().strip() if os.path.exists(CURRENT_FILE) else ''
        if acct == current_now:
            # Already the active account — a real session is presumably already
            # running for it, so pinging would be redundant. No switch, no API call.
            state[key] = {'date': today, 'status': 'already_active'}
            log_event('warmup_skip', account=acct, reason='already_active')
            changed = True; continue
        ok = do_warmup(acct)
        state[key] = {'date': today, 'status': 'ok' if ok else 'ping_failed'}
        changed = True
    if changed: save_warmup_state(state)

def get_claude_bin():
    try:
        p = open(os.path.join(RELAY_DIR, 'claude_bin')).read().strip()
        if p and os.path.exists(p): return p
    except: pass
    return shutil.which('claude') or 'claude'

def do_warmup(acct):
    current_before = open(CURRENT_FILE).read().strip() if os.path.exists(CURRENT_FILE) else ''
    do_switch(acct)
    log_event('warmup_switch', account=acct)
    try:
        r = subprocess.run([get_claude_bin(), '-p', 'ping', '--output-format', 'text'],
                            capture_output=True, timeout=30)
        ok = (r.returncode == 0)
        log_event('warmup_ping', account=acct, ok=ok)
        notify('relay', f'warmup: {acct} 已完成 5hr session 預熱' if ok
                         else f'warmup: {acct} ping 失敗')
        return ok
    except Exception as e:
        log_event('warmup_ping', account=acct, ok=False, err=str(e))
        return False
    finally:
        # Restore whatever account was active before warmup fired (Eng review, D5) —
        # warmup pre-warms a session in the background, it does not change what the
        # user is actively working on.
        if current_before and current_before != acct and os.path.exists(os.path.join(CREDS_DIR, current_before + '.json')):
            do_switch(current_before)
            log_event('warmup_restore', account=current_before)
```

Key behaviors:
- **No catch-up firing.** If the daemon didn't check in within 15 minutes of the scheduled time (offline, sleeping laptop, etc.), that day's slot is marked `missed` and skipped — it does not fire late.
- **Once per key per day.** The `date` field on a state record gates `ok`/`ping_failed`/`missed`/`already_active` equally, so a fired-but-failed ping also isn't retried until tomorrow. `missing_account` is the one exception — it never writes a state record, so it isn't gated at all (see the correction above).
- **Ping cost.** `claude -p "ping" --output-format text` is a minimal one-shot non-interactive call — no interactive session, exits immediately after the response.
- All outcomes are logged via the existing `log_event`/`autoswitch.log` and surfaced via the existing `notify()` desktop notification, matching current switch-event UX.

## Documentation (added per DX review — Claude subagent: plan never mentioned README, despite CLAUDE.md making a README changelog entry mandatory for every version bump)

- New `## Warmup` section in README.md, parallel to the existing `## Autoswitch` section, opening with the disclosure copy above.
- A row/mention in whatever account-management command table already exists in README.md.
- The version bump that ships this feature must follow CLAUDE.md's existing publish checklist: `## Changelog` entry in README.md + GitHub release notes.

## Testing plan

1. `bash -n relay` syntax check.
2. Create 2 fake accounts, `relay warmup add acctA 06:00`, verify it lands in `autoswitch.json`.
3. Seed a schedule 5 minutes in the past, start the daemon, confirm `warmup_switch`/`warmup_ping` appear in `autoswitch.log` and a notification fires.
4. Seed a schedule 20 minutes in the past, confirm it's marked `missed` and does not fire.
5. `relay warmup list` shows correct status per entry.
6. Run the daemon twice within the same day, confirm no duplicate firing (gated by `date`).
7. **(added, Eng review)** Kill the daemon (`SIGKILL`) mid-write of `warmup_state.json` (or `autoswitch.json`/`usage_cache.json` via the same shared atomic-write helper below); restart; confirm no truncated/corrupt file and no duplicate same-day firing.
8. **(added, Eng review)** Corrupt `autoswitch.json` with a syntax error; start the daemon; confirm `config_parse_error` appears in `autoswitch.log` (not silent) and warmup entries are correctly reported as inactive via `relay warmup list`.
9. **(added, Eng review)** Schedule two warmup entries 1 minute apart; confirm the second still fires within its grace window despite the first's ping call blocking the loop.
10. **(added, Eng review)** Run `relay switch` (CLI) at the same moment the daemon fires a warmup ping for a different scheduled account; confirm the credential lock serializes the two writes and neither corrupts the keychain/`current` file.
11. **(added, Eng review)** `relay warmup add acctA 09:00` while `acctA` doesn't exist yet, then `relay add acctA` before the 15-minute grace window elapses; confirm it fires instead of being stuck in `missing_account` until tomorrow.
12. **(added, Eng review)** `relay warmup pause` mid-day with a still-pending entry, then `relay warmup resume` before its scheduled time passes; confirm it still fires today.
13. **(pre-implementation gate, CEO review) — DONE, 2026-07-09.** Verified `claude -p "ping"` advances the `five_hour` window (see verification note in Daemon logic above).

**Shared atomic-write helper (Eng review — both voices independently flagged non-atomic `json.dump` writes as a corruption risk; `warmup_state.json` is a second instance of the pre-existing `usage_cache.json` P3 TODO).** Add one `save_json_atomic(path, data)` helper to the daemon (write to `path + '.tmp'`, then `os.replace()`) and route `save_warmup_state()`, `save_cache()`, and `autoswitch.json` writes through it, rather than adding a third ad-hoc non-atomic writer. This folds the existing TODOS.md P3 cache-lock item into this implementation instead of leaving it as a separate, indefinitely-deferred task.

**DST note (Eng review — Claude subagent, low-medium, informational only, no code change required at this scope):** `now.replace(hour=h, minute=m, ...)` uses naive local time; on the "spring forward" DST transition, a schedule landing inside the skipped wall-clock hour won't trigger that day. Documented here rather than fixed — timezone/DST handling was already deferred to TODOS.md (see Decision Audit Trail #7) and this is a sub-case of that same deferral.

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|-----------------|-----------|-----------|----------|
| 1 | CEO/Step0 | Mode = SELECTIVE EXPANSION (feature enhancement on existing daemon) | Mechanical | — | Context-dependent default for "enhancement on existing system" | — |
| 2 | CEO/0A | Accept all 3 premises (window pre-warm shifts real capacity; pain is real; switch+ping is the right mechanism) | User-confirmed gate | — | User explicitly confirmed via AskUserQuestion | — |
| 3 | CEO/0C-bis | Approach A (extend existing daemon) over B (separate cron) / C (native `at`/systemd-timer) | Mechanical | P1, P5 | Highest code reuse, lowest risk, matches existing design doc | B: race with daemon's own account switching; C: no Windows support, `at` often disabled |
| 4 | CEO/0D | Add `relay warmup pause`/`resume` toggle to scope | Taste (borderline, but net small) | P2 | Real use case (vacation/travel), same file, <1 day CC effort | — |
| 5 | CEO/0D | Skip ping-failure auto-retry | Mechanical | — | Already decided by user during brainstorming session | Deferred permanently, not revisited |
| 6 | CEO/0D | Skip "already warm" pre-check before pinging | Mechanical | P3 | Ping cost is near-zero; querying five_hour timestamps to detect "already warm" adds complexity disproportionate to the problem | Rejected |
| 7 | CEO/0D | Defer timezone-aware scheduling | Mechanical | P3 | Not in original scope discussion; local wall-clock is fine for a single machine; edge case for future multi-timezone users | Deferred to TODOS.md |
| 8 | CEO/DualVoices | Fix `check_warmup()` insertion point (was gated behind `if not cfg: continue`, breaking the single-account case) | CONFIRMED (both voices independently flagged the underlying assumption gap; Claude subagent found the exact line) | — | Real implementation bug in the design's own code snippet | — |
| 9 | CEO/DualVoices | Quota/ToS risk of automated warmup ping | User-confirmed after research | — | WebSearch confirmed: publicly documented technique, official CLI automation is ToS-exempt from the "no automated access" clause, does not raise the weekly cap (only shifts 5hr window boundary). User accepted residual risk + required explicit disclosure in CLI output/README | — |
| 10 | CEO/DualVoices | Require manual verification (ping actually resets `five_hour` window) before implementation begins | User-confirmed gate | — | Both voices independently flagged this as unverified core assumption | — |
| 11 | CEO/DualVoices | Add warmup health indicator to `relay status` (missed/failed count, last 7 days) | User-confirmed, added to scope | P2 | Silent failure risk (Claude subagent finding); same file, small diff | — |
| 12 | CEO/DualVoices | Do not revisit no-retry decision despite Codex's objection | Mechanical | — | Already settled by user in brainstorming session prior to CEO review; not re-litigated | Rejected |
| 13 | CEO/DualVoices | Native OS scheduler (systemd-timer/launchd) as alternative to daemon polling | Deferred to TODOS.md | P3 | Both voices question the current daemon-polling approach's reliability, but reworking is a bigger change than this review's scope; worth reconsidering if polling proves flaky in practice | Deferred |

## Eng Review — Dual Voices Consensus

```
ENG DUAL VOICES — CONSENSUS TABLE:
═══════════════════════════════════════════════════════════════
  Dimension                           Claude  Codex  Consensus
  ──────────────────────────────────── ─────── ─────── ─────────
  1. Architecture sound?               質疑     質疑    DISAGREE→實為CONFIRMED（不同角度，同根：共享可變帳號狀態缺乏跨行程鎖）
  2. Test coverage sufficient?         質疑     —      CONFIRMED（Claude 列出 6 項缺口，已納入測試計畫）
  3. Performance risks addressed?      質疑     —      CONFIRMED（daemon 迴圈阻塞，已縮短 timeout）
  4. Security threats covered?         同意     —      CONFIRMED（無新注入面，small hardening added）
  5. Error paths handled?              質疑     質疑    CONFIRMED（malformed config、missing_account 皆已修正）
  6. Deployment risk manageable?       —       質疑    CONFIRMED（claude_bin 佈線位置已明確化）
═══════════════════════════════════════════════════════════════
```

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|-----------------|-----------|-----------|----------|
| 14 | Eng/DualVoices | Add cross-process credential lock (`credential.lock`) around all live-credential writes | CONFIRMED, added to scope | P1 (zero silent failures) | Codex identified concrete collision path between warmup's do_switch and existing switch/refresh/autoswitch writers | — |
| 15 | Eng/DualVoices | Fix 7-day health indicator to read from `autoswitch.log` instead of `warmup_state.json` | CONFIRMED, mechanical fix | P5 (explicit, DRY) | `warmup_state.json`'s one-record-per-key schema literally cannot answer the 7-day question as originally designed — self-inflicted defect from CEO-phase scope addition | — |
| 16 | Eng/DualVoices | Restore previously-active account after warmup ping completes | User-confirmed (D5) | — | Both voices/user agreed warmup should not silently change what the user is actively working on | Rejected: "leave switched" option |
| 17 | Eng/DualVoices | Shrink ping subprocess timeout 120s → 30s | CONFIRMED, mechanical | P3 (pragmatic) | Reduces daemon-loop blocking without needing async/threading complexity | Rejected: background-thread ping (over-engineered for a once-daily sub-minute op) |
| 18 | Eng/DualVoices | `missing_account` no longer gates for the full day — retries until grace window elapses | CONFIRMED, mechanical | P1 | Codex: harsh for common CLI workflow (account added mid-window) | — |
| 19 | Eng/DualVoices | Add shared atomic-write helper, route `warmup_state.json`/`usage_cache.json`/`autoswitch.json` through it | CONFIRMED, added to scope | P1, P4 (DRY) | Both voices independently flagged non-atomic writes; folds in the pre-existing TODOS.md P3 cache-lock item rather than leaving a third instance of the same bug | — |
| 20 | Eng/DualVoices | Log `config_parse_error` on malformed `autoswitch.json` instead of silently falling back | CONFIRMED, mechanical | P1 | Claude subagent: silent failure violates CEO review's own Prime Directive #1 | — |
| 21 | Eng/DualVoices | Specify exact `claude_bin` write location + validation in `cmd_autoswitch_start()` | CONFIRMED, mechanical | P5 | Codex: plan named the file but not where/when it's written, or what happens if `REAL_CLAUDE` is empty | — |
| 22 | Eng/DualVoices | Document DST edge case, no code fix at this scope | Deferred (folds into existing TODOS.md timezone deferral, decision #7) | P3 | Sub-case of already-deferred timezone item | Deferred |
| 23 | Eng/UserRaised | Skip switch/ping/restore when the scheduled account is already the active account | User-confirmed | P3 (pragmatic, near-zero cost) | Cheaper than the CEO-phase-rejected "is window still fresh" check (#6) — only compares against `CURRENT_FILE`, no extra API/timestamp lookup | — |
| 24 | Eng/UserRaised | Multiple same-time entries serialize (N × ≤30s) within one poll rather than running in parallel | CONFIRMED, documented as accepted behavior | P3 | Negligible against 15-min grace window for realistic account counts; parallelizing would add locking/threading complexity disproportionate to the problem | Rejected: concurrent/threaded warmup firing |

## DX Review — Dual Voices Consensus

```
DX DUAL VOICES — CONSENSUS TABLE:
═══════════════════════════════════════════════════════════════
  Dimension                           Claude  Codex  Consensus
  ──────────────────────────────────── ─────── ─────── ─────────
  1. Getting started < 5 min?          質疑     質疑    CONFIRMED（daemon 未啟動時排程靜默失效，兩者皆列為最大新手風險）
  2. API/CLI naming guessable?         同意     同意    CONFIRMED
  3. Error messages actionable?        質疑     質疑    CONFIRMED（原設計只描述行為，未給實際文字）
  4. Docs findable & complete?         質疑     質疑    CONFIRMED（README 完全沒被提及；disclosure 文字未定稿）
  5. Upgrade path safe?                —       —      N/A（無破壞性變更，純新增欄位/指令）
  6. Dev environment friction-free?    質疑     質疑    CONFIRMED（list 應顯示 paused/daemon 狀態）
═══════════════════════════════════════════════════════════════
```

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|-----------------|-----------|-----------|----------|
| 25 | DX/DualVoices | Add daemon-not-running warning to `warmup add` success output + `list` header | CONFIRMED, added to scope | P1 (zero silent failures — same CEO prime directive) | Both voices independently named this the single biggest first-run failure mode | — |
| 26 | DX/DualVoices | Draft literal error-message copy matching existing terse `err "..."` style, not a triad | CONFIRMED, mechanical | P5 (explicit, consistent with existing code) | Plan described behavior but never text; existing `relay` convention is one-line `err`, not problem/cause/fix | Rejected: verbose multi-line error format (inconsistent with codebase) |
| 27 | DX/DualVoices | Draft literal disclosure copy, print on `warmup add` + as README section opener | CONFIRMED, mechanical | P1 | Both voices flagged "must state plainly" as underspecified without actual wording | — |
| 28 | DX/DualVoices | `list` shows pause banner + daemon running/not-running header when relevant | CONFIRMED, added to scope | P1 | Both voices noted missing state visibility; silent when healthy (no added noise) | — |
| 29 | DX/UserRaised(via review) | Add `relay warmup test <account>` self-diagnosis command | CONFIRMED, added to scope | P2 (small, same file, real gap — testing plan's own step 3 otherwise requires hand-editing state files) | Claude subagent finding | — |
| 30 | DX/DualVoices | Add README `## Warmup` section + Changelog entry to scope (mandatory per CLAUDE.md publish checklist) | CONFIRMED, added to scope | P1 | Claude subagent: plan never mentioned README despite this repo's own CLAUDE.md requiring it for every version bump | — |

## GSTACK REVIEW REPORT

Run via `/autoplan` on 2026-07-09, branch `main`, commit range starting `ec29c47`.

| Phase | Voices | Status | Findings (confirmed) | Critical/High |
|---|---|---|---|---|
| CEO | Codex + Claude subagent | issues_open→resolved | 13 decisions logged (#1–13) | 2 (quota/ToS optics — researched, accepted; core assumption unverified — gated as pre-implementation step) |
| Eng | Codex + Claude subagent | issues_open→resolved | 11 decisions logged (#14–24, incl. 2 user-raised) | 3 (credential race, 7-day health schema defect, account-switch UX) |
| DX | Codex + Claude subagent | issues_open→resolved | 6 decisions logged (#25–30) | 2 (daemon-not-running silent failure, missing README/disclosure copy) |

**VERDICT:** APPROVED. Design is implementation-ready. The one pre-implementation gate — verifying `claude -p "ping"` actually advances the `five_hour` window — is DONE (2026-07-09, direct API check on the `work` account: `resets_at` jumped a full 5h forward, utilization reset to 2%, timed right as the prior window expired). Everything else in this report is already folded into the design above.

**Notable finding surfaced regardless of consensus:** Codex (single voice) flagged quota/ToS optics risk. Researched via WebSearch — publicly documented technique, official CLI automation is ToS-exempt, doesn't raise the weekly cap. User accepted the residual risk with a disclosure requirement attached (decision #9, #27).

**Scope added beyond original brainstorm design:** `relay warmup pause/resume/test`, credential-write locking, restore-previous-account behavior, `relay status` health line (log-derived), `already_active` skip, atomic-write helper (also resolves the pre-existing TODOS.md P3 cache-corruption item), literal CLI/disclosure copy, README + Changelog requirement.

**Deferred to TODOS.md:** timezone/DST-aware scheduling (P3).

NO UNRESOLVED DECISIONS
