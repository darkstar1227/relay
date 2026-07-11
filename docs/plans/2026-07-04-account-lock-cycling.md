# Account Lock & Ordered Cycling Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add per-account locks that prevent locked+over-threshold accounts from being selected during cycling, change daemon to auto-default with 2+ accounts, and make cycling follow the `order` array sequence.

**Architecture:** All changes are inside the single `relay` bash script. The daemon section is an extracted Python heredoc (`DAEMON_EOF`). Lock state lives in `autoswitch.json` under a new `"locks": [...]` key. render_table reads `autoswitch.json` from `relay_dir` to display lock badges.

**Tech Stack:** Bash, Python 3 (heredocs), JSON (`autoswitch.json` at `~/.claude-relay/autoswitch.json`)

---

## Task 1: Daemon — auto-default config for 2+ accounts

**File:** `relay` — daemon heredoc, function `load_config()` at line ~1011

**What it does now:**
```python
def load_config():
    try: return json.load(open(CONFIG_FILE))
    except: return None
```
Returns `None` when no `autoswitch.json` exists → daemon sleeps and does nothing.

**Step 1: Replace `load_config()` in the daemon heredoc**

Find and replace the function (it's inside the `DAEMON_EOF` heredoc):

```python
def _read_order(creds_dir):
    order_file = os.path.join(os.path.dirname(creds_dir), 'order')
    on_disk = set(f[:-5] for f in os.listdir(creds_dir) if f.endswith('.json')) if os.path.isdir(creds_dir) else set()
    ordered = []
    if os.path.exists(order_file):
        for line in open(order_file):
            n = line.strip()
            if n in on_disk and n not in ordered:
                ordered.append(n)
    for n in sorted(on_disk):
        if n not in ordered:
            ordered.append(n)
    with open(order_file, 'w') as f:
        f.write('\n'.join(ordered) + ('\n' if ordered else ''))
    return ordered

def load_config():
    try:
        return json.load(open(CONFIG_FILE))
    except:
        # Auto-default: 2+ accounts → enable with 80% threshold, no explicit config needed
        if not os.path.isdir(CREDS_DIR):
            return None
        accounts = _read_order(CREDS_DIR)
        if len(accounts) < 2:
            return None
        return {
            'order': accounts,
            'thresholds': {a: 80 for a in accounts},
            'locks': [],
            'poll': {'low_minutes': 10, 'high_minutes': 2, 'high_threshold': 50}
        }
```

Note: `accounts` must come from the persisted `~/.claude-relay/order` file (via `_read_order`), not a plain alphabetical `sorted()` of the credentials directory — otherwise a user's saved account order is silently discarded the first time this auto-default path fires. This snippet reflects the actual fixed implementation as of the `docs/plans/2026-07-10-account-order-fix-implementation.md` work.

**Step 2: Verify syntax**

```bash
bash -n relay && echo "syntax OK"
```
Expected: `syntax OK`

**Step 3: Commit**

```bash
git add relay
git commit -m "feat: daemon auto-defaults to 80% threshold when 2+ accounts exist"
```

---

## Task 2: Daemon — ordered cycling + lock filtering

**File:** `relay` — daemon main loop, lines ~1060–1082

**What it does now:** finds accounts under threshold first, falls back to least-used. No concept of locks or order sequence.

**Step 1: Add `locks` extraction after `thresholds` line**

After `thresholds = cfg.get('thresholds', {})` add:
```python
locks = cfg.get('locks', [])
```

**Step 2: Add `is_blocked()` helper after `get_utilization()` function**

Add after `def get_utilization(usage_data):` block:
```python
def is_blocked(name, thr_map, locks_list, usage_map):
    """True if account is locked AND at or over its threshold — skip as switch target."""
    if name not in locks_list:
        return False
    util = get_utilization(usage_map.get(name))
    threshold = thr_map.get(name, 80)
    return util is not None and util >= threshold
```

**Step 3: Replace the candidate selection block**

Find the block from `candidates = ...` to the end of `do_switch(target)` / `time.sleep(sleep_sec)` before the final `time.sleep(sleep_sec)`. Replace with:

```python
        # Ordered cycling: walk order[] from current position, skip blocked accounts
        idx = order.index(current) if current in order else 0
        target = None
        for i in range(1, len(order)):
            candidate = order[(idx + i) % len(order)]
            if not is_blocked(candidate, thresholds, locks, usage):
                target = candidate
                break

        if target is None:
            # All candidates are locked + over threshold — stay put
            log_event('all_blocked', current=current)
            notify('relay', 'All accounts at limit — staying on current account')
            time.sleep(sleep_sec)
            continue

        target_util = get_utilization(usage.get(target))
        log_event('switch', frm=current, to=target, usage=cur_util)
        notify('relay', f'switched {current} → {target} ({current} at {cur_util}%)')
        do_switch(target)
        time.sleep(sleep_sec)
```

**Step 4: Verify syntax**

```bash
bash -n relay && echo "syntax OK"
```

**Step 5: Manual smoke-test the logic**

```bash
# Create a minimal test config and confirm daemon reads it
cat ~/.claude-relay/autoswitch.json 2>/dev/null || echo "(no config — auto-default will apply)"
```

**Step 6: Commit**

```bash
git add relay
git commit -m "feat: ordered cycling with lock filtering in autoswitch daemon"
```

---

## Task 3: `relay lock` / `relay unlock` commands

**File:** `relay` — add `cmd_lock()` and `cmd_unlock()` bash functions, wire into `case` dispatcher

**Step 1: Add `cmd_lock()` after `cmd_autoswitch()` block**

```bash
cmd_lock() {
  local name="${1:-}"
  local cfg="${RELAY_DIR}/autoswitch.json"

  # No argument: show lock status
  if [[ -z "${name}" ]]; then
    hdr "Account locks"
    if [[ ! -f "${cfg}" ]]; then
      warn "No autoswitch config. Run: relay autoswitch config"
      return 0
    fi
    "${PY}" - "${cfg}" <<'PYEOF'
import json, sys
cfg = json.load(open(sys.argv[1]))
locks = cfg.get('locks', [])
R='\033[0m'; B='\033[1m'; D='\033[2m'; GR='\033[32m'; YL='\033[33m'
if not locks:
    print(f'  {D}No accounts locked.{R}')
else:
    for name in locks:
        print(f'  {YL}🔒{R}  {B}{name}{R}')
print()
PYEOF
    return 0
  fi

  account_exists "${name}" || { err "Account '${name}' not found"; exit 1; }

  # Ensure config file exists (create auto-default if missing)
  if [[ ! -f "${cfg}" ]]; then
    "${PY}" - "${CREDS_STORE}" "${cfg}" <<'PYEOF'
import json, sys, os
creds_dir, cfg_path = sys.argv[1], sys.argv[2]
order_file = os.path.join(os.path.dirname(creds_dir), 'order')
on_disk = set(f[:-5] for f in os.listdir(creds_dir) if f.endswith('.json'))
accounts = []
if os.path.exists(order_file):
    for line in open(order_file):
        n = line.strip()
        if n in on_disk and n not in accounts:
            accounts.append(n)
for n in sorted(on_disk):
    if n not in accounts:
        accounts.append(n)
with open(order_file, 'w') as f:
    f.write('\n'.join(accounts) + ('\n' if accounts else ''))
config = {
    'order': accounts,
    'thresholds': {a: 80 for a in accounts},
    'locks': [],
    'poll': {'low_minutes': 10, 'high_minutes': 2, 'high_threshold': 50}
}
json.dump(config, open(cfg_path, 'w'), indent=2)
PYEOF
    ok "Created default autoswitch config: ${cfg}"
  fi

  "${PY}" - "${cfg}" "${name}" <<'PYEOF'
import json, sys
cfg_path, name = sys.argv[1], sys.argv[2]
cfg = json.load(open(cfg_path))
locks = cfg.get('locks', [])
if name in locks:
    print(f"  already locked: {name}")
    sys.exit(0)
locks.append(name)
cfg['locks'] = locks
json.dump(cfg, open(cfg_path, 'w'), indent=2)
PYEOF
  ok "Locked '${B}${name}${R}' — won't be switched back to when over threshold"
}

cmd_unlock() {
  local name="${1:-}"
  [[ -z "${name}" ]] && { err "usage: relay unlock <name>"; exit 1; }
  local cfg="${RELAY_DIR}/autoswitch.json"
  [[ ! -f "${cfg}" ]] && { warn "No autoswitch config — nothing to unlock"; return 0; }

  "${PY}" - "${cfg}" "${name}" <<'PYEOF'
import json, sys
cfg_path, name = sys.argv[1], sys.argv[2]
cfg = json.load(open(cfg_path))
locks = cfg.get('locks', [])
if name not in locks:
    print(f"  not locked: {name}")
    sys.exit(0)
locks.remove(name)
cfg['locks'] = locks
json.dump(cfg, open(cfg_path, 'w'), indent=2)
PYEOF
  ok "Unlocked '${B}${name}${R}'"
}
```

**Step 2: Wire into the `case` dispatcher**

Find the `case "${CMD}" in` block near the bottom of the file. Add before the final `*)` catch-all:

```bash
  lock)           cmd_lock "$@" ;;
  unlock)         cmd_unlock "$@" ;;
```

**Step 3: Verify syntax**

```bash
bash -n relay && echo "syntax OK"
```

**Step 4: Test lock/unlock flow**

```bash
# list accounts first
relay list --no-usage

# lock an account (use a real account name from your list)
relay lock <name>          # should print: ✓ Locked '<name>'

# view locks
relay lock                 # should show the locked account with 🔒

# unlock
relay unlock <name>        # should print: ✓ Unlocked '<name>'

# view again
relay lock                 # should print: No accounts locked.
```

**Step 5: Commit**

```bash
git add relay
git commit -m "feat: relay lock / relay unlock commands"
```

---

## Task 4: Show lock badge in `relay list` and `relay status`

**File:** `relay` — `render_table` heredoc (Python, starts around line 131)

The `render_table` Python code already has access to `relay_dir = os.path.dirname(creds_dir)`. We can read `autoswitch.json` from there to get the locks list.

**Step 1: Add locks loading after `relay_dir` line in the render_table heredoc**

Find `relay_dir = os.path.dirname(creds_dir)` and add below it:

```python
# Load locks from autoswitch config (best-effort, no error if missing)
_locks = []
try:
    _as_cfg = json.load(open(os.path.join(relay_dir, 'autoswitch.json')))
    _locks = _as_cfg.get('locks', [])
except Exception:
    pass
```

**Step 2: Add lock badge in the `quick` mode row (single-account line)**

In the `quick` mode `for i, name in enumerate(names, 1):` loop, find where `cur` marker is rendered and append a lock indicator. The row currently renders something like:

```python
cur = name == current
marker = ...
```

Add after the `cur` assignment:

```python
lock_badge = f' {YL}🔒{R}' if name in _locks else ''
```

Then append `{lock_badge}` at the end of the row's print statement.

**Step 3: Add lock badge in the `full` mode row**

Same pattern — find the full-mode row render and append `{lock_badge}`.

**Step 4: Verify syntax**

```bash
bash -n relay && echo "syntax OK"
```

**Step 5: Smoke-test display**

```bash
relay lock <name>
relay list --no-usage    # should show 🔒 next to the locked account
relay unlock <name>
relay list --no-usage    # 🔒 should be gone
```

**Step 6: Commit**

```bash
git add relay
git commit -m "feat: show lock badge in relay list for locked accounts"
```

---

## Task 5: Show lock column in `relay autoswitch status`

**File:** `relay` — `cmd_autoswitch_status()` Python heredoc (lines ~1310–1366)

**Step 1: Add `locks` extraction in the status heredoc**

After `thresholds = cfg.get('thresholds', {})` add:
```python
locks = cfg.get('locks', [])
```

**Step 2: Update the header row to include lock column**

Change:
```python
print(f'  {B}{"order":<4} {"account":<14} {"threshold":<12} {"cached usage":<14}{R}')
print(f'  {D}{"─"*52}{R}')
```
To:
```python
print(f'  {B}{"order":<4} {"account":<14} {"threshold":<12} {"cached usage":<14} {"lock":<6}{R}')
print(f'  {D}{"─"*58}{R}')
```

**Step 3: Add lock indicator in the per-account row**

After `next_s = ''` block, add:
```python
lock_s = f' {YL}🔒{R}' if name in locks else ''
```

Then append `{lock_s}` to the `print(f'  {marker} ...')` line.

**Step 4: Add lock commands to the bottom hints**

After the `relay autoswitch log` hint line, add:
```bash
printf "  %-34s %s\n" "  ${CY}relay lock <name>${R}"      "lock account (no cycling back)"
printf "  %-34s %s\n" "  ${CY}relay unlock <name>${R}"    "remove lock"
```

**Step 5: Verify syntax and smoke-test**

```bash
bash -n relay && echo "syntax OK"
relay lock <name>
relay autoswitch status   # should show 🔒 in the lock column
```

**Step 6: Commit**

```bash
git add relay
git commit -m "feat: show lock status in relay autoswitch status panel"
```

---

## Task 6: Help text + version bump + release

**File:** `relay` — `cmd_help()` function and `package.json`

**Step 1: Add lock commands to help text**

In `cmd_help()`, after the `relay status -f` line, add:

```bash
printf "  %-32s %s\n" "  relay lock <name>"        "prevent account from cycling back when over limit"
printf "  %-32s %s\n" "  relay unlock <name>"       "remove lock"
printf "  %-32s %s\n" "  relay lock"                "show locked accounts"
```

**Step 2: Add changelog entry to README.md**

Add at the top of the `## Changelog` section:

```markdown
### v2.2.7 — 2026-07-04
- `relay lock <name>` / `relay unlock <name>`: lock an account so it won't be cycled back to when over its usage threshold
- `relay lock` (no args): show locked accounts
- Autoswitch daemon now auto-enables with default 80% threshold when 2+ accounts exist — no config required
- Cycling follows `order` sequence; locked+over-threshold accounts are skipped; if all candidates are blocked, stays on current account and notifies
- Lock badge (🔒) shown in `relay list` and `relay autoswitch status`
```

**Step 3: Bump version**

```bash
git stash
npm version patch   # → v2.2.7
git stash pop
```

**Step 4: Final syntax check**

```bash
bash -n relay && echo "syntax OK"
```

**Step 5: Commit + tag + push**

```bash
git add relay README.md
git commit -m "feat: relay lock/unlock, daemon auto-default, ordered cycling"
git tag -d v2.2.7 && git tag v2.2.7 HEAD
git push && git push --tags
```

**Step 6: Create GitHub release**

```bash
gh release create v2.2.7 --title "v2.2.7" --notes "$(cat <<'EOF'
- \`relay lock <name>\` / \`relay unlock <name>\`: lock an account so it won't be cycled back to when over its usage threshold
- \`relay lock\` (no args): show locked accounts
- Autoswitch daemon now auto-enables with default 80% threshold when 2+ accounts exist — no config required
- Cycling follows \`order\` sequence; locked+over-threshold accounts are skipped; if all candidates are blocked, stays on current account and notifies
- Lock badge (🔒) shown in \`relay list\` and \`relay autoswitch status\`
EOF
)"
```

---

## Quick Reference: Key locations in `relay`

| What | Where |
|------|-------|
| `load_config()` in daemon | inside `DAEMON_EOF` heredoc, ~line 1011 |
| Daemon main loop (selection) | ~lines 1060–1082 |
| `render_table` heredoc start | ~line 131 (`render_table()` bash function) |
| `cmd_autoswitch_status` Python heredoc | ~line 1310 |
| `cmd_autoswitch()` dispatcher | ~line 1407 |
| `case "${CMD}"` dispatcher | ~line 1670 |
| `cmd_help()` | ~line 1613 |
