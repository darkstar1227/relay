# Warmup Scheduling Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `relay warmup add/remove/list/pause/resume/test` so a scheduled account automatically gets switched-to and pinged at a chosen daily time, pre-warming its rolling 5-hour usage window before the user starts real work.

**Architecture:** All changes live in the single `relay` bash script. The daemon logic (Python, in the `DAEMON_EOF` heredoc) gets a new `check_warmup()`/`do_warmup()` pair plus a shared atomic-write helper and a cross-process credential lock. The bash side gets a `cmd_warmup` dispatcher (mirroring the existing `cmd_autoswitch` dispatcher pattern) and one line added to `cmd_autoswitch_start()`.

**Tech Stack:** Bash 3.2-compatible, Python 3 stdlib only (`fcntl`, `json`, `subprocess`, `datetime`, `os`, `shutil`). No test framework exists in this repo — verification is `bash -n` + manual daemon/CLI invocation + log inspection, per the existing project convention.

**No automated tests exist in this codebase.** Every "test" step below is a manual command + expected output, matching how the rest of `relay` is verified (see CLAUDE.md, TODOS.md — no `test/` directory anywhere in this repo). Steps are written as "do X, observe Y" rather than `pytest`-style assertions.

---

## Before you start

Read `docs/plans/2026-07-09-warmup-scheduling-design.md` in full — it has the reasoning behind every decision below (dual-model CEO/Eng/DX review, a completed empirical verification that `claude -p ping` really does start a fresh 5-hour window, and a full decision audit trail). This implementation plan is the "how", that file is the "why".

Line numbers below were re-checked against the current `relay` file on 2026-07-09 — re-grep the function names if they've drifted since:

```bash
grep -n "^def do_switch\|^def load_config\|^def main\|^cmd_autoswitch_start\|^cmd_help\|^cmd_lock\|^do_switch()\|^case \"\\\${CMD}\"" relay
```

---

## Task 1: Atomic JSON-write helper (daemon)

**Files:**
- Modify: `relay` (inside `DAEMON_EOF` heredoc, near `def save_cache(c):` at relay:936-939)

**Why first:** Tasks 2 and 3 both need to write JSON files safely under concurrent access. Landing this first means later tasks call one already-tested helper instead of duplicating write logic.

**Step 1: Add the helper next to the existing cache functions**

Find this in `relay` (inside the daemon heredoc):

```python
def save_cache(c):
    try:
        with open(CACHE_FILE, 'w') as f: json.dump(c, f)
    except: pass
```

Replace with:

```python
def save_json_atomic(path, data):
    try:
        tmp = path + '.tmp'
        with open(tmp, 'w') as f: json.dump(data, f)
        os.replace(tmp, path)
    except: pass

def save_cache(c):
    save_json_atomic(CACHE_FILE, c)
```

**Step 2: Verify syntax**

Run: `bash -n relay`
Expected output: nothing (silent success). A non-zero exit or any printed error means a typo — fix before continuing.

**Step 3: Manual verification the cache still works**

Run: `./relay list --no-usage` (uses existing account data, doesn't touch cache) then `./relay list` (populates cache via `save_cache`)
Expected: no errors, `~/.claude-relay/usage_cache.json` exists and is valid JSON — verify with `python3 -m json.tool ~/.claude-relay/usage_cache.json > /dev/null && echo OK`.

**Step 4: Commit**

```bash
git add relay
git commit -m "refactor: atomic JSON writes for daemon cache (resolves TODOS.md P3 cache-lock item)"
```

---

## Task 2: Cross-process credential-write lock

**Files:**
- Modify: `relay` — bash `do_switch()` at relay:356-384
- Modify: `relay` — Python `do_switch()` (daemon) at relay:920-929
- Modify: `relay` — Python `try_refresh_daemon()` at relay:942-968 (the `kc_write(content)` call inside it)

**Why:** `do_switch()` exists in both bash (CLI-invoked) and Python (daemon-invoked) forms, and both mutate the same keychain/`CURRENT_FILE`. Nothing currently prevents a CLI switch and a daemon-triggered switch (autoswitch cycling, or the warmup feature Task 3 is about to add) from interleaving. This task adds the lock as a standalone change so it can be verified against *existing* switch/autoswitch behavior before warmup code depends on it.

**Step 1: Add a bash lock helper near the top of `relay`, after the existing `err`/`warn`/`ok`/`log` definitions (relay:56-60)**

```bash
with_credential_lock() {
  # Serializes credential/CURRENT_FILE writes across all relay processes
  # (CLI switch, autoswitch daemon, warmup). Uses flock(1) if available,
  # falls back to a simple mkdir-based lock on systems without it.
  local lockfile="${RELAY_DIR}/credential.lock"
  if command -v flock >/dev/null 2>&1; then
    (
      flock -x 200
      "$@"
    ) 200>"${lockfile}"
  else
    local lockdir="${lockfile}.d"
    while ! mkdir "${lockdir}" 2>/dev/null; do sleep 0.05; done
    trap 'rmdir "${lockdir}" 2>/dev/null' RETURN
    "$@"
  fi
}
```

**Step 2: Wrap the body of bash `do_switch()` (relay:356-384)**

Find:

```bash
do_switch() {
  local name="$1"
  local current; current=$(current_name)

  if [[ "${current}" == "${name}" ]]; then
    ok "Already on account '${B}${name}${R}'"
    return 0
  fi

  # Back up the current account's live token before switching
  # (Claude Code refreshes tokens in-place; the snapshot may be stale)
  if [[ -n "${current}" ]] && account_exists "${current}"; then
    local live; live=$(kc_read 2>/dev/null)
    [[ -n "${live}" ]] && printf '%s' "${live}" > "$(account_creds "${current}")"
  fi

  echo "${name}" > "${CURRENT_FILE}"

  # Write the target account's credentials into the store Claude Code reads
  local content; content=$(cat "$(account_creds "${name}")")
  kc_write "${content}" || warn "Credential write failed — switch may not take effect"

  local email; email=$(get_meta_email "${name}")
  printf "\n  ${GR}${B}✓ switched → %s${R}  ${D}%s${R}\n" "${name}" "${email}"
  printf "  ${D}Active sessions pick up the switch on next message. New session: ${CY}claude -c${R}\n\n"

  # ponytail: sentinel lets autoswitch daemon skip this account until threshold hit
  printf '{"account":"%s","ts":%s}' "${name}" "$(date +%s)" > "${RELAY_DIR}/manual_switch"
}
```

Replace with:

```bash
do_switch() {
  with_credential_lock _do_switch_locked "$1"
}

_do_switch_locked() {
  local name="$1"
  local current; current=$(current_name)

  if [[ "${current}" == "${name}" ]]; then
    ok "Already on account '${B}${name}${R}'"
    return 0
  fi

  # Back up the current account's live token before switching
  # (Claude Code refreshes tokens in-place; the snapshot may be stale)
  if [[ -n "${current}" ]] && account_exists "${current}"; then
    local live; live=$(kc_read 2>/dev/null)
    [[ -n "${live}" ]] && printf '%s' "${live}" > "$(account_creds "${current}")"
  fi

  echo "${name}" > "${CURRENT_FILE}"

  # Write the target account's credentials into the store Claude Code reads
  local content; content=$(cat "$(account_creds "${name}")")
  kc_write "${content}" || warn "Credential write failed — switch may not take effect"

  local email; email=$(get_meta_email "${name}")
  printf "\n  ${GR}${B}✓ switched → %s${R}  ${D}%s${R}\n" "${name}" "${email}"
  printf "  ${D}Active sessions pick up the switch on next message. New session: ${CY}claude -c${R}\n\n"

  # ponytail: sentinel lets autoswitch daemon skip this account until threshold hit
  printf '{"account":"%s","ts":%s}' "${name}" "$(date +%s)" > "${RELAY_DIR}/manual_switch"
}
```

**Step 3: Add the equivalent Python-side lock in the daemon heredoc**

Find, near the top of the daemon heredoc (after the `RELAY_DIR`/`CONFIG_FILE`/etc constants, relay:833-841):

```python
CACHE_TTL    = 120  # seconds — same as render_table
```

Add right after it:

```python
CREDENTIAL_LOCK = os.path.join(RELAY_DIR, 'credential.lock')

import fcntl
from contextlib import contextmanager

@contextmanager
def credential_lock():
    with open(CREDENTIAL_LOCK, 'a') as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)
```

**Step 4: Wrap Python `do_switch()` (relay:920-929)**

Find:

```python
def do_switch(name):
    cred = os.path.join(CREDS_DIR, name + '.json')
    current = open(CURRENT_FILE).read().strip() if os.path.exists(CURRENT_FILE) else ''
    if current and os.path.exists(os.path.join(CREDS_DIR, current + '.json')):
        live = kc_read()
        if live:
            with open(os.path.join(CREDS_DIR, current + '.json'), 'w') as f: f.write(live)
    with open(CURRENT_FILE, 'w') as f: f.write(name)
    content = open(cred).read()
    kc_write(content)
```

Replace with:

```python
def do_switch(name):
    with credential_lock():
        cred = os.path.join(CREDS_DIR, name + '.json')
        current = open(CURRENT_FILE).read().strip() if os.path.exists(CURRENT_FILE) else ''
        if current and os.path.exists(os.path.join(CREDS_DIR, current + '.json')):
            live = kc_read()
            if live:
                with open(os.path.join(CREDS_DIR, current + '.json'), 'w') as f: f.write(live)
        with open(CURRENT_FILE, 'w') as f: f.write(name)
        content = open(cred).read()
        kc_write(content)
```

**Step 5: Wrap the keychain write inside `try_refresh_daemon()` (relay:942-968)**

Find the line (inside `try_refresh_daemon`):

```python
        if name == current:
            kc_write(content)  # critical: update keychain so do_switch() doesn't clobber
```

Replace with:

```python
        if name == current:
            with credential_lock():
                kc_write(content)  # critical: update keychain so do_switch() doesn't clobber
```

**Step 6: Verify syntax**

Run: `bash -n relay`
Expected: silent success.

**Step 7: Manual verification — existing switch behavior unaffected**

```bash
./relay add-force testacct 2>&1 | head -1   # skip if you don't want a real login; alternatively use an existing account
./relay switch <existing-account-name>
```

Expected: identical output/behavior to before this change (a `✓ switched → ...` line). The lock is invisible when there's no contention.

**Step 8: Manual verification — lock actually serializes**

```bash
( ./relay switch accountA & ./relay switch accountB & wait )
```

Expected: both complete without error, no corrupted `~/.claude-relay/current` file (check with `cat ~/.claude-relay/current` — should contain exactly one valid account name, not garbled/concatenated text).

**Step 9: Commit**

```bash
git add relay
git commit -m "fix: add cross-process credential lock around do_switch/try_refresh_daemon"
```

---

## Task 3: Daemon warmup engine

**Files:**
- Modify: `relay` — `load_config()` at relay:1029-1044
- Modify: `relay` — `main()` at relay:1046-1118
- Modify: `relay` — daemon heredoc, add new functions near `do_switch()`/`try_refresh_daemon()`

**Step 1: Fix `load_config()` so `warmup` survives the auto-default path**

Find (relay:1029-1044):

```python
def load_config():
    try:
        return json.load(open(CONFIG_FILE))
    except:
        # Auto-default: 2+ accounts → enable with 80% threshold, no explicit config needed
        if not os.path.isdir(CREDS_DIR):
            return None
        accounts = sorted(f[:-5] for f in os.listdir(CREDS_DIR) if f.endswith('.json'))
        if len(accounts) < 2:
            return None
        return {
            'order': accounts,
            'thresholds': {a: 80 for a in accounts},
            'locks': [],
            'poll': {'low_minutes': 10, 'high_minutes': 2, 'high_threshold': 50}
        }
```

Replace with:

```python
def load_raw_config():
    """Read autoswitch.json's raw contents, or {} if missing/corrupt. Used so
    'warmup' entries work even when load_config()'s auto-default path (which
    omits 'warmup') would otherwise apply."""
    try:
        return json.load(open(CONFIG_FILE))
    except FileNotFoundError:
        return {}
    except Exception as e:
        log_event('config_parse_error', error=str(e))
        return {}

def load_config():
    try:
        return json.load(open(CONFIG_FILE))
    except:
        # Auto-default: 2+ accounts → enable with 80% threshold, no explicit config needed
        if not os.path.isdir(CREDS_DIR):
            return None
        accounts = sorted(f[:-5] for f in os.listdir(CREDS_DIR) if f.endswith('.json'))
        if len(accounts) < 2:
            return None
        return {
            'order': accounts,
            'thresholds': {a: 80 for a in accounts},
            'locks': [],
            'poll': {'low_minutes': 10, 'high_minutes': 2, 'high_threshold': 50}
        }
```

**Step 2: Add `WARMUP_STATE_FILE` constant**

Find (relay:840-841):

```python
CACHE_FILE   = os.path.join(RELAY_DIR, 'usage_cache.json')
CACHE_TTL    = 120  # seconds — same as render_table
```

Add a line after:

```python
CACHE_FILE   = os.path.join(RELAY_DIR, 'usage_cache.json')
CACHE_TTL    = 120  # seconds — same as render_table
WARMUP_STATE_FILE = os.path.join(RELAY_DIR, 'warmup_state.json')
```

**Step 3: Add the warmup functions, right after `do_switch()` (relay:920-929, after Task 2's edit)**

```python
def load_warmup_state():
    try: return json.load(open(WARMUP_STATE_FILE))
    except: return {}

def save_warmup_state(s):
    save_json_atomic(WARMUP_STATE_FILE, s)

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
        if current_before and current_before != acct and os.path.exists(os.path.join(CREDS_DIR, current_before + '.json')):
            do_switch(current_before)
            log_event('warmup_restore', account=current_before)

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
            continue  # deliberately no state[key] write — retries every poll until grace window elapses
        current_now = open(CURRENT_FILE).read().strip() if os.path.exists(CURRENT_FILE) else ''
        if acct == current_now:
            state[key] = {'date': today, 'status': 'already_active'}
            log_event('warmup_skip', account=acct, reason='already_active')
            changed = True; continue
        ok = do_warmup(acct)
        state[key] = {'date': today, 'status': 'ok' if ok else 'ping_failed'}
        changed = True
    if changed: save_warmup_state(state)
```

Note: `datetime` is already imported at the top of the daemon heredoc (relay:831, `import json, os, sys, time, datetime, ...`) and `shutil` needs to be added there too — see next step.

**Step 4: Add the `shutil` import**

Find (relay:831):

```python
import json, os, sys, time, datetime, urllib.request, urllib.error, platform, subprocess, signal
```

Replace with:

```python
import json, os, sys, time, datetime, urllib.request, urllib.error, platform, subprocess, signal, shutil
```

**Step 5: Call `check_warmup()` from `main()` before the `if not cfg: continue` short-circuit**

Find (relay:1062-1064, start of the `while True:` loop body after the token-refresh block):

```python
        cfg = load_config()
        if not cfg:
            time.sleep(60); continue
```

Replace with:

```python
        cfg = load_config()
        raw_cfg = load_raw_config()
        if raw_cfg.get('warmup_enabled', True):
            check_warmup(raw_cfg.get('warmup', []))
        if not cfg:
            time.sleep(60); continue
```

**Step 6: Verify syntax**

Run: `bash -n relay`
Expected: silent success.

**Step 7: Manual verification — single-account warmup fires**

```bash
mkdir -p ~/.claude-relay
python3 -c "
import json, datetime
now = datetime.datetime.now()
soon = (now.replace(second=0, microsecond=0))
hhmm = soon.strftime('%H:%M')
cfg = {'warmup': [{'account': 'personal', 'time': hhmm}]}
json.dump(cfg, open('/tmp/test_autoswitch.json', 'w'))
print('scheduled for', hhmm)
"
cp ~/.claude-relay/autoswitch.json ~/.claude-relay/autoswitch.json.bak 2>/dev/null || true
cp /tmp/test_autoswitch.json ~/.claude-relay/autoswitch.json
```

Then extract and run the daemon directly (not via launchd, for a quick foreground test):

```bash
./relay autoswitch start   # or manually: python3 <(sed -n '/^  cat > "\${AUTOSWITCH_DAEMON}"/,/^DAEMON_EOF$/p' relay | sed '1d;$d')
sleep 90
cat ~/.claude-relay/autoswitch.log | tail -10
```

Expected: `warmup_switch`, `warmup_ping`, `warmup_restore` (if a different account was active) JSON lines in `autoswitch.log` within the 15-minute grace window. Restore config: `mv ~/.claude-relay/autoswitch.json.bak ~/.claude-relay/autoswitch.json` (or delete if there was no prior config), then `./relay autoswitch stop`.

**Step 8: Manual verification — missed entry doesn't fire late**

Same setup but schedule `hhmm` 20 minutes in the past instead of "now". Confirm `autoswitch.log` gets a `warmup_missed` entry and no `warmup_switch`/`warmup_ping`.

**Step 9: Manual verification — malformed config logs, doesn't crash**

```bash
echo '{not valid json' > ~/.claude-relay/autoswitch.json
# run one daemon poll iteration manually, or start it briefly
grep config_parse_error ~/.claude-relay/autoswitch.log
```

Expected: a `config_parse_error` line appears; daemon does not crash (check it's still running: `cat ~/.claude-relay/autoswitch.lock` and `kill -0 <pid>`).

**Step 10: Commit**

```bash
git add relay
git commit -m "feat: daemon warmup engine (check_warmup/do_warmup), fixes single-account insertion point"
```

---

## Task 4: Wire `claude_bin` into `cmd_autoswitch_start()`

**Files:**
- Modify: `relay` — `cmd_autoswitch_start()` at relay:1229-1231

**Step 1: Add the validation + write before daemon extraction**

Find (relay:1229-1231):

```bash
cmd_autoswitch_start() {
  [[ -f "${RELAY_DIR}/autoswitch.json" ]] || {
    err "No config found. Run: relay autoswitch config"
    exit 1
  }

  hdr "autoswitch — start"
  _extract_daemon
```

Replace with:

```bash
cmd_autoswitch_start() {
  [[ -f "${RELAY_DIR}/autoswitch.json" ]] || {
    err "No config found. Run: relay autoswitch config"
    exit 1
  }

  hdr "autoswitch — start"

  if [[ -n "${REAL_CLAUDE}" ]] && [[ "${REAL_CLAUDE}" != "$0" ]]; then
    echo "${REAL_CLAUDE}" > "${RELAY_DIR}/claude_bin"
  else
    warn "Could not resolve 'claude' binary — warmup will fall back to PATH lookup at ping time"
  fi

  _extract_daemon
```

**Step 2: Verify syntax**

Run: `bash -n relay`
Expected: silent success.

**Step 3: Manual verification**

```bash
./relay autoswitch start
cat ~/.claude-relay/claude_bin
```

Expected: prints an absolute path to a `claude` executable (e.g. `/opt/homebrew/bin/claude`). Then `./relay autoswitch stop` to clean up.

**Step 4: Commit**

```bash
git add relay
git commit -m "feat: write claude_bin path on autoswitch start, for daemon PATH-independent lookup"
```

---

## Task 5: CLI — `relay warmup` command family

**Files:**
- Modify: `relay` — add `cmd_warmup()` dispatcher + `cmd_warmup_add/remove/list/pause/resume/test`, placed after `cmd_unlock()` (relay:1490 area, right before `cmd_version` or wherever `cmd_lock`/`cmd_unlock` end — grep `^cmd_unlock` and insert after its closing brace)
- Modify: `relay` — top-level `case "${CMD}"` dispatch (relay:1777-1827), add a `warmup)` case
- Modify: `relay` — `cmd_help()` (relay:1732+), add a Warmup section

**Step 1: Add the dispatcher + subcommands**

Insert after `cmd_unlock()`'s closing brace (find it via `grep -n "^cmd_unlock" relay` then locate its matching `}`):

```bash
cmd_warmup() {
  local sub="${1:-}"; [[ $# -gt 0 ]] && shift
  case "${sub}" in
    add)     cmd_warmup_add "$@" ;;
    remove|rm) cmd_warmup_remove "$@" ;;
    list|ls) cmd_warmup_list ;;
    pause)   cmd_warmup_pause ;;
    resume)  cmd_warmup_resume ;;
    test)    cmd_warmup_test "$@" ;;
    *)       cmd_warmup_list ;;
  esac
}

_warmup_ensure_config() {
  local cfg="${RELAY_DIR}/autoswitch.json"
  if [[ ! -f "${cfg}" ]]; then
    "${PY}" - "${CREDS_STORE}" "${cfg}" <<'PYEOF'
import json, sys, os
creds_dir, cfg_path = sys.argv[1], sys.argv[2]
accounts = sorted(f[:-5] for f in os.listdir(creds_dir) if f.endswith('.json')) if os.path.isdir(creds_dir) else []
config = {
    'order': accounts,
    'thresholds': {a: 80 for a in accounts},
    'locks': [],
    'poll': {'low_minutes': 10, 'high_minutes': 2, 'high_threshold': 50},
    'warmup': []
}
json.dump(config, open(cfg_path, 'w'), indent=2)
PYEOF
  fi
}

_warmup_daemon_running() {
  local pid; pid=$(cat "${RELAY_DIR}/autoswitch.lock" 2>/dev/null || echo "")
  [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null
}

_warmup_valid_time() {
  [[ "$1" =~ ^([0-1][0-9]|2[0-3]):[0-5][0-9]$ ]]
}

cmd_warmup_add() {
  local name="${1:-}" hhmm="${2:-}"
  if [[ -z "${name}" || -z "${hhmm}" ]]; then
    err "usage: relay warmup add <account> <HH:MM>"
    exit 1
  fi
  account_exists "${name}" || {
    err "Account '${name}' not found — run 'relay list' to see accounts, or 'relay add ${name}' first"
    exit 1
  }
  _warmup_valid_time "${hhmm}" || {
    err "Invalid time '${hhmm}' — expected HH:MM, 00:00–23:59 (e.g. 06:00)"
    exit 1
  }

  _warmup_ensure_config
  local cfg="${RELAY_DIR}/autoswitch.json"

  "${PY}" - "${cfg}" "${name}" "${hhmm}" <<'PYEOF'
import json, sys
cfg_path, name, hhmm = sys.argv[1], sys.argv[2], sys.argv[3]
cfg = json.load(open(cfg_path))
entries = cfg.get('warmup', [])
if not any(e.get('account') == name and e.get('time') == hhmm for e in entries):
    entries.append({'account': name, 'time': hhmm})
cfg['warmup'] = entries
json.dump(cfg, open(cfg_path, 'w'), indent=2)
PYEOF

  ok "warmup: ${name} will fire at ${hhmm}"
  echo "  Warmup runs a real, non-interactive 'claude -p ping' call to Anthropic's API"
  echo "  on your machine in the background at the scheduled time — it does not send"
  echo "  your credentials anywhere, and it does not increase your weekly usage cap."
  echo "  It only starts your rolling 5-hour usage window earlier."
  if ! _warmup_daemon_running; then
    warn "background daemon isn't running — this won't fire until you run: relay autoswitch start"
  fi
}

cmd_warmup_remove() {
  local name="${1:-}" hhmm="${2:-}"
  if [[ -z "${name}" ]]; then
    err "usage: relay warmup remove <account> [HH:MM]"
    exit 1
  fi
  local cfg="${RELAY_DIR}/autoswitch.json"
  [[ -f "${cfg}" ]] || { warn "No warmup entries for '${name}'"; return 0; }

  "${PY}" - "${cfg}" "${name}" "${hhmm}" <<'PYEOF'
import json, sys
cfg_path, name, hhmm = sys.argv[1], sys.argv[2], (sys.argv[3] or None)
cfg = json.load(open(cfg_path))
entries = cfg.get('warmup', [])
if hhmm:
    remaining = [e for e in entries if not (e.get('account') == name and e.get('time') == hhmm)]
else:
    remaining = [e for e in entries if e.get('account') != name]
removed = len(entries) - len(remaining)
cfg['warmup'] = remaining
json.dump(cfg, open(cfg_path, 'w'), indent=2)
print(removed)
PYEOF
  ok "Removed warmup entries for '${name}'"
}

cmd_warmup_list() {
  local cfg="${RELAY_DIR}/autoswitch.json"
  hdr "warmup"

  if _warmup_daemon_running; then :; else
    printf "  ${YL}daemon: not running${R} — run 'relay autoswitch start'\n"
  fi

  [[ -f "${cfg}" ]] || { warn "No warmup entries. Run: relay warmup add <account> <HH:MM>"; return 0; }

  "${PY}" - "${cfg}" "${RELAY_DIR}/warmup_state.json" <<'PYEOF'
import json, sys
cfg = json.load(open(sys.argv[1]))
if not cfg.get('warmup_enabled', True):
    print('  \033[33m⏸ warmup paused\033[0m — run \'relay warmup resume\' to re-enable')
entries = cfg.get('warmup', [])
if not entries:
    print('  No warmup entries. Run: relay warmup add <account> <HH:MM>')
    sys.exit(0)
try:
    state = json.load(open(sys.argv[2]))
except Exception:
    state = {}
labels = {
    'ok': '成功', 'ping_failed': 'ping 失敗', 'missed': '錯過',
    'missing_account': '帳號不存在', 'already_active': '已在該帳號，跳過 ping',
}
for e in entries:
    acct, hhmm = e.get('account'), e.get('time')
    rec = state.get(f'{acct}|{hhmm}')
    if rec:
        status = labels.get(rec.get('status'), rec.get('status'))
        print(f"  {acct:<12} {hhmm}   最後: {rec.get('date')} {status}")
    else:
        print(f"  {acct:<12} {hhmm}   尚未觸發")
PYEOF
}

cmd_warmup_pause() {
  _warmup_ensure_config
  local cfg="${RELAY_DIR}/autoswitch.json"
  "${PY}" - "${cfg}" <<'PYEOF'
import json, sys
cfg_path = sys.argv[1]
cfg = json.load(open(cfg_path))
cfg['warmup_enabled'] = False
json.dump(cfg, open(cfg_path, 'w'), indent=2)
PYEOF
  ok "warmup paused — entries kept, run 'relay warmup resume' to re-enable"
}

cmd_warmup_resume() {
  local cfg="${RELAY_DIR}/autoswitch.json"
  [[ -f "${cfg}" ]] || { err "No warmup config. Run: relay warmup add <account> <HH:MM> first"; exit 1; }
  "${PY}" - "${cfg}" <<'PYEOF'
import json, sys
cfg_path = sys.argv[1]
cfg = json.load(open(cfg_path))
cfg['warmup_enabled'] = True
json.dump(cfg, open(cfg_path, 'w'), indent=2)
PYEOF
  ok "warmup resumed"
}

cmd_warmup_test() {
  local name="${1:-}"
  [[ -z "${name}" ]] && { err "usage: relay warmup test <account>"; exit 1; }
  account_exists "${name}" || { err "Account '${name}' not found"; exit 1; }
  hdr "warmup — test"
  log "Switching to '${name}', pinging, then restoring your current account..."
  "${PY}" - "${name}" <<'PYEOF'
import sys, os
sys.path.insert(0, os.path.expanduser('~/.claude-relay'))
PYEOF
  warn "relay warmup test requires the daemon module — run this from an environment where the daemon has been extracted (relay autoswitch start at least once), then re-run this command."
}
```

**Step 2: Add the top-level dispatch case**

Find (relay:1799-1800):

```bash
  lock)             cmd_lock "$@" ;;
  unlock)           cmd_unlock "$@" ;;
```

Replace with:

```bash
  lock)             cmd_lock "$@" ;;
  unlock)           cmd_unlock "$@" ;;
  warmup)           cmd_warmup "$@" ;;
```

**Step 3: Add help text**

Find, in `cmd_help()`, the end of the Autoswitch section (around relay:1758-1761, after the `autoswitch status` line):

```bash
  printf "  %-32s %s\n" "  relay autoswitch status"   "daemon state + thresholds"
```

Add after it:

```bash
  printf "  %-32s %s\n" "  relay autoswitch status"   "daemon state + thresholds"
  echo ""
  printf "  ${B}Warmup${R}\n"
  printf "  %-32s %s\n" "  relay warmup add <acct> <HH:MM>" "pre-warm an account's 5hr window daily"
  printf "  %-32s %s\n" "  relay warmup remove <acct> [HH:MM]" "remove a warmup schedule"
  printf "  %-32s %s\n" "  relay warmup list"         "show scheduled warmups + last result"
  printf "  %-32s %s\n" "  relay warmup pause/resume" "suspend/re-enable without deleting"
```

**Step 4: Verify syntax**

Run: `bash -n relay`
Expected: silent success.

**Step 5: Manual verification — the full CLI flow**

```bash
./relay warmup add nonexistent-account 06:00   # expect: err about account not found, exit 1
./relay warmup add <real-account> 6:00          # expect: err about invalid time format, exit 1
./relay warmup add <real-account> 06:00         # expect: ok message + disclosure text + daemon-not-running warning if applicable
./relay warmup list                             # expect: shows the entry, "尚未觸發"
./relay warmup pause
./relay warmup list                             # expect: "⏸ warmup paused" banner
./relay warmup resume
./relay warmup remove <real-account>
./relay warmup list                             # expect: "No warmup entries"
```

**Step 6: Note on `cmd_warmup_test`**

`relay warmup test <account>` as drafted above is a stub — the daemon's `do_warmup()` lives inside the extracted Python heredoc file (`AUTOSWITCH_DAEMON` path), not directly callable from bash. If you want the full self-diagnosis command working end-to-end, extract it as its own follow-up task: locate `_extract_daemon`'s target path (grep `AUTOSWITCH_DAEMON=` in `relay`), then shell out to `"${py}" -c "import sys; sys.path.insert(0, '...'); from autoswitch_daemon import do_warmup; do_warmup('${name}')"` after ensuring the daemon file has been extracted at least once. This is a nice-to-have (decision #29 in the design doc, P2) — do not block the rest of the feature on it; ship with the stub warning if time-constrained, and file a TODOS.md entry to finish it.

**Step 7: Commit**

```bash
git add relay
git commit -m "feat: relay warmup add/remove/list/pause/resume CLI"
```

---

## Task 6: `relay status` warmup health line

**Files:**
- Modify: `relay` — `cmd_status()` at relay:548 (find the end of its existing output, before it returns)

**Step 1: Read `cmd_status()` to find the right insertion point**

Run: `sed -n '548,620p' relay` and locate where the function's main output loop ends, before its closing brace.

**Step 2: Add the health check**

Insert this snippet near the end of `cmd_status()` (after existing usage output, before the closing `}`):

```bash
  # Warmup health (only prints when relevant — silent otherwise)
  if [[ -f "${RELAY_DIR}/autoswitch.json" ]] && [[ -f "${RELAY_DIR}/autoswitch.log" ]]; then
    "${PY}" - "${RELAY_DIR}/autoswitch.json" "${RELAY_DIR}/autoswitch.log" <<'PYEOF'
import json, sys
from collections import defaultdict

cfg_path, log_path = sys.argv[1], sys.argv[2]
try:
    cfg = json.load(open(cfg_path))
except Exception:
    sys.exit(0)
entries = cfg.get('warmup', [])
if not entries:
    sys.exit(0)

counts = defaultdict(lambda: {'total': 0, 'bad': 0})
try:
    with open(log_path) as f:
        lines = f.readlines()[-2000:]
except Exception:
    lines = []

for line in lines:
    try:
        rec = json.loads(line)
    except Exception:
        continue
    ev = rec.get('event')
    if ev == 'warmup_missed':
        key = f"{rec.get('account')}|{rec.get('time')}"
        counts[key]['total'] += 1
        counts[key]['bad'] += 1
    elif ev == 'warmup_ping':
        acct = rec.get('account')
        for e in entries:
            if e.get('account') == acct:
                key = f"{acct}|{e.get('time')}"
                counts[key]['total'] += 1
                if not rec.get('ok'):
                    counts[key]['bad'] += 1

R='\033[0m'; YL='\033[33m'
for e in entries:
    key = f"{e.get('account')}|{e.get('time')}"
    c = counts.get(key)
    if c and c['total'] >= 3 and c['bad'] >= 3:
        print(f"  {YL}⚠ warmup: {e.get('account')} {e.get('time')} missed {c['bad']}/{c['total']} recent{R}")
PYEOF
  fi
```

**Step 3: Verify syntax**

Run: `bash -n relay`
Expected: silent success.

**Step 4: Manual verification**

```bash
# With no warmup entries or a healthy log:
./relay status   # expect: no extra warmup line

# Seed autoswitch.log with 3 missed entries for a scheduled account, then:
for i in 1 2 3; do echo '{"ts":1000000000,"event":"warmup_missed","account":"work","time":"06:00"}' >> ~/.claude-relay/autoswitch.log; done
./relay status   # expect: "⚠ warmup: work 06:00 missed 3/3 recent"
```

Clean up the test log line afterward if it's not representative of real data: `git checkout` doesn't apply (it's a runtime file, not tracked) — just remove the injected lines with a text editor if you want a clean log.

**Step 5: Commit**

```bash
git add relay
git commit -m "feat: warmup health warning in relay status"
```

---

## Task 7: Documentation

**Files:**
- Modify: `README.md`
- Modify: `TODOS.md` (mark the P3 cache-lock item resolved)

**Step 1: Read the current README structure**

Run: `grep -n "^## " README.md` to find the existing `## Autoswitch` section and the account-management command table, so the new section matches existing heading style and placement.

**Step 2: Add a `## Warmup` section**

Insert it immediately after the existing `## Autoswitch` section (same heading level `##`), opening with:

```markdown
## Warmup

Warmup runs a real, non-interactive `claude -p ping` call to Anthropic's API on your machine in the background at the scheduled time — it does not send your credentials anywhere, and it does not increase your weekly usage cap. It only starts your rolling 5-hour usage window earlier.

```bash
relay warmup add <account> <HH:MM>     # e.g. relay warmup add work 06:00
relay warmup remove <account> [HH:MM]
relay warmup list
relay warmup pause / resume
```

Requires the autoswitch daemon to be running (`relay autoswitch start`) — `relay warmup add` warns if it isn't.
```

**Step 3: Add a row to whatever account-management table already exists, referencing `relay warmup`**

**Step 4: Mark the TODOS.md P3 cache-lock item resolved**

Open `TODOS.md`, find the `## P3 — Cache file lock` section, and either delete it or prepend `**RESOLVED (2026-07-09, warmup implementation):** see Task 1 of docs/plans/2026-07-09-warmup-scheduling-implementation.md — save_json_atomic() now used by save_cache().` above it.

**Step 5: Commit**

```bash
git add README.md TODOS.md
git commit -m "docs: warmup README section, mark P3 cache-lock TODO resolved"
```

**Step 6: Version bump (per CLAUDE.md's mandatory publish checklist — do this last, once all prior tasks are committed and manually verified end-to-end)**

```bash
npm version minor   # new feature
```

Then add a `### vX.Y.0 — YYYY-MM-DD` entry to README.md's `## Changelog` section describing the warmup feature, and follow the rest of CLAUDE.md's publish checklist (push tags, `npm publish`, `gh release create`) when ready to ship — this is a separate, deliberate step, not automatic at the end of this plan.

---

## Task order and dependencies

```
Task 1 (atomic writes) ──┐
                          ├──> Task 3 (warmup engine) ──> Task 5 (CLI) ──> Task 6 (status line) ──> Task 7 (docs)
Task 2 (credential lock) ┘                                     ↑
                                                    Task 4 (claude_bin wiring) ──┘
```

Tasks 1 and 2 are independent of each other and of everything else — either can go first. Task 3 depends on both (it calls `save_json_atomic`/`credential_lock`). Task 4 is independent but should land before Task 5's `add` command is manually tested end-to-end (so the daemon-not-running warning path and the real thing both get exercised). Task 6 depends on Task 3's log event names existing. Task 7 depends on everything else being functionally complete.
