# Account Order Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix account display order (currently alphabetical instead of add-order) and the autoswitch reorder wizard silently discarding user input.

**Architecture:** Introduce `${RELAY_DIR}/order` as the single persisted source of truth for account ordering. A self-healing reader (bash `list_account_names()` and a duplicated Python `read_order()` at each embedded-Python call site) replaces every `sorted()`/`sort` call over credential filenames. `cmd_add`/`cmd_save`/`cmd_remove`/`cmd_rename` keep the order file in sync. Separately, fix the broken stdin+heredoc pipe in the autoswitch config wizard (argv instead of stdin) and extract a shared `prompt_reorder()` function used by both the wizard and a new standalone `relay reorder` command.

**Tech Stack:** bash 3.2 (macOS-compatible), Python 3 (embedded heredocs), no formal test framework — verification is manual shell scripts run via Bash tool.

**Reference:** `docs/plans/2026-07-09-account-order-fix-design.md` (validated design). Note: line numbers in that doc are stale — this plan uses current line numbers (re-verified 2026-07-10 after the warmup-scheduling feature landed and shifted everything).

---

### Task 0: Confirm working state

**Step 1:** Verify no uncommitted changes are lost.

Run: `git -C /Users/ds-anxing/GitHub/relay status --short`
Expected: only known untracked docs (`docs/plans/2026-07-04-account-lock-cycling.md`, `docs/superpowers/`), no unexpected modifications to `relay`.

**Step 2:** Confirm current `relay` line anchors haven't drifted further.

Run:
```bash
grep -n "^list_account_names\|^cmd_add()\|^cmd_save()\|^cmd_remove()\|^cmd_rename()\|^render_table\|^def load_config\|^cmd_lock()\|^_warmup_ensure_config\|^cmd_autoswitch_config\|^cmd_help\|^CMD=\"" relay
```
Expected output (line numbers must match, or stop and re-read the file before continuing):
```
103:list_account_names() {
160:render_table() {
657:cmd_add() {
705:cmd_save() {
813:cmd_remove() {
892:cmd_rename() {
1209:def load_config():
1307:cmd_autoswitch_config() {
1654:cmd_lock() {
1748:_warmup_ensure_config() {
2119:cmd_help() {
2167:CMD="${1:-}"
```
(Exact numbers may differ slightly by a line or two if the file changed again — re-run the grep and adjust every task below accordingly before editing.)

---

### Task 1: Add `ORDER_FILE` constant and self-healing `list_account_names()`

**Files:**
- Modify: `relay:11-15` (add constant)
- Modify: `relay:102-109` (rewrite `list_account_names`)

**Step 1: Write a manual reproduction check (documents current broken behavior)**

```bash
export RELAY_TEST_HOME=$(mktemp -d)/relayhome
mkdir -p "${RELAY_TEST_HOME}/.claude-relay/credentials"
touch "${RELAY_TEST_HOME}/.claude-relay/credentials/zebra.json"
touch "${RELAY_TEST_HOME}/.claude-relay/credentials/apple.json"
HOME="${RELAY_TEST_HOME}" /Users/ds-anxing/GitHub/relay/relay list --no-usage
rm -rf "$(dirname "${RELAY_TEST_HOME}")"
```
Expected (current, buggy behavior): `apple` listed before `zebra` purely because "a" < "z" alphabetically — there is no way to make `zebra` (added first) show as #1 today. This confirms the bug exists before the fix.

**Step 2: Add the constant**

Current (relay:11-15):
```bash
RELAY_DIR="${HOME}/.claude-relay"
CREDS_STORE="${RELAY_DIR}/credentials"
META_STORE="${RELAY_DIR}/meta"
CURRENT_FILE="${RELAY_DIR}/current"
UPDATE_CACHE="${RELAY_DIR}/.update_cache"
```

New:
```bash
RELAY_DIR="${HOME}/.claude-relay"
CREDS_STORE="${RELAY_DIR}/credentials"
META_STORE="${RELAY_DIR}/meta"
CURRENT_FILE="${RELAY_DIR}/current"
ORDER_FILE="${RELAY_DIR}/order"
UPDATE_CACHE="${RELAY_DIR}/.update_cache"
```

**Step 3: Rewrite `list_account_names()`**

Current (relay:102-109):
```bash
# list accounts sorted, one per line (bash 3.2 compatible)
list_account_names() {
  local f
  for f in "${CREDS_STORE}"/*.json; do
    [[ -f "${f}" ]] || continue
    basename "${f}" .json
  done | sort
}
```

New:
```bash
# list accounts in canonical add-order, one per line (bash 3.2 compatible).
# Self-healing: drops names whose credential file is gone, appends any
# credential file not yet tracked (alphabetically), and rewrites ORDER_FILE.
list_account_names() {
  local on_disk=() name f

  while IFS= read -r name; do
    on_disk+=("${name}")
  done < <(for f in "${CREDS_STORE}"/*.json; do [[ -f "${f}" ]] || continue; basename "${f}" .json; done | sort)

  local ordered=()
  if [[ -f "${ORDER_FILE}" ]]; then
    while IFS= read -r name; do
      [[ -z "${name}" ]] && continue
      account_exists "${name}" && ordered+=("${name}")
    done < "${ORDER_FILE}"
  fi

  local acct tracked
  for acct in ${on_disk[@]+"${on_disk[@]}"}; do
    tracked=0
    for name in ${ordered[@]+"${ordered[@]}"}; do
      [[ "${name}" == "${acct}" ]] && { tracked=1; break; }
    done
    [[ "${tracked}" -eq 0 ]] && ordered+=("${acct}")
  done

  if [[ ${#ordered[@]} -gt 0 ]]; then
    printf '%s\n' "${ordered[@]}" > "${ORDER_FILE}"
    printf '%s\n' "${ordered[@]}"
  else
    : > "${ORDER_FILE}"
  fi
}
```

Note the `${on_disk[@]+"${on_disk[@]}"}` idiom (not plain `"${on_disk[@]}"`) — required because this script runs under `set -u` on bash 3.2, where expanding an empty array raises "unbound variable". The same idiom is already used elsewhere in this file (e.g. `"${passthrough[@]+"${passthrough[@]}"}"` in `cmd_list`).

**Step 4: Verify self-healing behavior manually**

```bash
export RELAY_TEST_HOME=$(mktemp -d)/relayhome
mkdir -p "${RELAY_TEST_HOME}/.claude-relay/credentials"
touch "${RELAY_TEST_HOME}/.claude-relay/credentials/zebra.json"
touch "${RELAY_TEST_HOME}/.claude-relay/credentials/apple.json"

HOME="${RELAY_TEST_HOME}" bash -c '
  RELAY_DIR="${HOME}/.claude-relay"
  CREDS_STORE="${RELAY_DIR}/credentials"
  ORDER_FILE="${RELAY_DIR}/order"
  account_exists() { [[ -f "${CREDS_STORE}/$1.json" ]]; }
  '"$(sed -n '/^list_account_names() {/,/^}/p' /Users/ds-anxing/GitHub/relay/relay)"'
  echo "--- first call (no order file yet, should be alphabetical: apple, zebra) ---"
  list_account_names
  echo "--- order file now contains ---"
  cat "${ORDER_FILE}"
  echo "--- simulate real add-order: prepend a manually-crafted order ---"
  printf "zebra\napple\n" > "${ORDER_FILE}"
  echo "--- second call (should now respect zebra, apple) ---"
  list_account_names
  echo "--- remove zebra credential file, call again (self-heal should drop it) ---"
  rm "${CREDS_STORE}/zebra.json"
  list_account_names
'
rm -rf "$(dirname "${RELAY_TEST_HOME}")"
```
Expected:
- First call prints `apple` then `zebra` (alphabetical bootstrap).
- After manually writing `zebra\napple` to the order file, second call prints `zebra` then `apple` (order file wins).
- After deleting `zebra.json`, third call prints only `apple` (self-heal dropped the missing entry).

**Step 5: Commit**

```bash
git add relay
git commit -m "fix: persist account order instead of sorting filenames alphabetically"
```

---

### Task 2: Wire order-file maintenance into add/save/remove/rename

**Files:**
- Modify: `relay:102-109` area — add three new helper functions right after `list_account_names()`
- Modify: `relay:657-703` (`cmd_add`)
- Modify: `relay:705-725` (`cmd_save`)
- Modify: `relay:813-823` (`cmd_remove`)
- Modify: `relay:892-905` (`cmd_rename`)

**Step 1: Add the three helpers after `list_account_names()`**

Insert immediately after the closing `}` of `list_account_names` (from Task 1):
```bash
# append name to ORDER_FILE if not already tracked (used by add/save)
add_to_order() {
  local name="$1"
  touch "${ORDER_FILE}"
  grep -Fxq "${name}" "${ORDER_FILE}" 2>/dev/null && return 0
  echo "${name}" >> "${ORDER_FILE}"
}

# remove name's line from ORDER_FILE (used by remove)
remove_from_order() {
  local name="$1"
  [[ -f "${ORDER_FILE}" ]] || return 0
  local tmp="${ORDER_FILE}.tmp.$$"
  grep -Fxv "${name}" "${ORDER_FILE}" > "${tmp}" 2>/dev/null || : > "${tmp}"
  mv "${tmp}" "${ORDER_FILE}"
}

# rename a tracked entry in place, preserving its position (used by rename)
rename_in_order() {
  local old="$1" new="$2"
  [[ -f "${ORDER_FILE}" ]] || return 0
  local tmp="${ORDER_FILE}.tmp.$$"
  awk -v old="${old}" -v new="${new}" '{ print ($0 == old) ? new : $0 }' "${ORDER_FILE}" > "${tmp}"
  mv "${tmp}" "${ORDER_FILE}"
}
```

**Step 2: Hook `cmd_add`**

Current (relay:698-702):
```bash
  printf '%s' "${kc_creds}" > "$(account_creds "${name}")"
  chmod 600 "$(account_creds "${name}")"
  save_meta_email "${name}"
  echo "${name}" > "${CURRENT_FILE}"
  ok "Account '${B}${name}${R}' added  ${D}$(get_meta_email "${name}")${R}"
```
New:
```bash
  printf '%s' "${kc_creds}" > "$(account_creds "${name}")"
  chmod 600 "$(account_creds "${name}")"
  save_meta_email "${name}"
  add_to_order "${name}"
  echo "${name}" > "${CURRENT_FILE}"
  ok "Account '${B}${name}${R}' added  ${D}$(get_meta_email "${name}")${R}"
```

**Step 3: Hook `cmd_save`**

Current (relay:722-724):
```bash
  save_meta_email "${name}"
  echo "${name}" > "${CURRENT_FILE}"
  ok "Account '${B}${name}${R}' saved  ${D}$(get_meta_email "${name}")${R}"
```
New:
```bash
  save_meta_email "${name}"
  add_to_order "${name}"
  echo "${name}" > "${CURRENT_FILE}"
  ok "Account '${B}${name}${R}' saved  ${D}$(get_meta_email "${name}")${R}"
```

**Step 4: Hook `cmd_remove`**

Current (relay:820-822):
```bash
  rm -f "$(account_creds "${name}")" "$(account_meta "${name}")"
  [[ "$(current_name)" == "${name}" ]] && rm -f "${CURRENT_FILE}"
  ok "Deleted '${name}' (sessions are unaffected)"
```
New:
```bash
  rm -f "$(account_creds "${name}")" "$(account_meta "${name}")"
  remove_from_order "${name}"
  [[ "$(current_name)" == "${name}" ]] && rm -f "${CURRENT_FILE}"
  ok "Deleted '${name}' (sessions are unaffected)"
```

**Step 5: Hook `cmd_rename`**

Current (relay:901-903):
```bash
  mv "$(account_creds "${old}")" "$(account_creds "${new}")"
  [[ -f "$(account_meta "${old}")" ]] && mv "$(account_meta "${old}")" "$(account_meta "${new}")"
  [[ "$(current_name)" == "${old}" ]] && echo "${new}" > "${CURRENT_FILE}"
```
New:
```bash
  mv "$(account_creds "${old}")" "$(account_creds "${new}")"
  [[ -f "$(account_meta "${old}")" ]] && mv "$(account_meta "${old}")" "$(account_meta "${new}")"
  rename_in_order "${old}" "${new}"
  [[ "$(current_name)" == "${old}" ]] && echo "${new}" > "${CURRENT_FILE}"
```

**Step 6: Verify helpers manually**

```bash
export RELAY_TEST_HOME=$(mktemp -d)/relayhome
mkdir -p "${RELAY_TEST_HOME}/.claude-relay"
HOME="${RELAY_TEST_HOME}" bash -c '
  ORDER_FILE="'"${RELAY_TEST_HOME}"'/.claude-relay/order"
  '"$(sed -n '/^add_to_order() {/,/^}/p; /^remove_from_order() {/,/^}/p; /^rename_in_order() {/,/^}/p' /Users/ds-anxing/GitHub/relay/relay)"'
  add_to_order "personal"
  add_to_order "work"
  add_to_order "allen-work"
  add_to_order "work"   # idempotent, should not duplicate
  echo "--- after adds ---"; cat "${ORDER_FILE}"
  rename_in_order "work" "work-renamed"
  echo "--- after rename (position preserved) ---"; cat "${ORDER_FILE}"
  remove_from_order "personal"
  echo "--- after remove ---"; cat "${ORDER_FILE}"
'
rm -rf "$(dirname "${RELAY_TEST_HOME}")"
```
Expected:
- After adds: `personal`, `work`, `allen-work` (no duplicate `work`).
- After rename: `personal`, `work-renamed`, `allen-work` (position 2 preserved, not moved to end).
- After remove: `work-renamed`, `allen-work`.

**Step 7: Commit**

```bash
git add relay
git commit -m "fix: keep account order file in sync on add/save/remove/rename"
```

---

### Task 3: Fix `render_table`'s account ordering

**Files:**
- Modify: `relay:198` (inside `render_table`'s embedded Python)

**Step 1: Reproduce**

```bash
grep -n "names = sorted(os.path.basename" relay
```
Expected: one hit at line 198 — confirms the bug is still live in `render_table` before this task's fix.

**Step 2: Add a `read_order()` helper and replace the sort**

Current (relay:196-198):
```python
    except Exception:
        return '—'

names = sorted(os.path.basename(p)[:-5] for p in glob.glob(os.path.join(creds_dir, '*.json')))
```

New:
```python
    except Exception:
        return '—'

def read_order(creds_dir):
    relay_dir = os.path.dirname(creds_dir)
    order_file = os.path.join(relay_dir, 'order')
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

names = read_order(creds_dir)
```

**Step 3: Verify**

```bash
export RELAY_TEST_HOME=$(mktemp -d)/relayhome
mkdir -p "${RELAY_TEST_HOME}/.claude-relay/credentials" "${RELAY_TEST_HOME}/.claude-relay/meta"
touch "${RELAY_TEST_HOME}/.claude-relay/credentials/zebra.json"
touch "${RELAY_TEST_HOME}/.claude-relay/credentials/apple.json"
printf "zebra\napple\n" > "${RELAY_TEST_HOME}/.claude-relay/order"
HOME="${RELAY_TEST_HOME}" /Users/ds-anxing/GitHub/relay/relay list --no-usage
rm -rf "$(dirname "${RELAY_TEST_HOME}")"
```
Expected: table lists `zebra` as #1, `apple` as #2 (order-file order), not alphabetical.

**Step 4: Commit**

```bash
git add relay
git commit -m "fix: render_table uses persisted account order, not alphabetical sort"
```

---

### Task 4: Fix the autoswitch daemon's auto-default order

**Files:**
- Modify: `relay:1209-1224` (`load_config()` inside the embedded daemon heredoc, extracted to `~/.claude-relay/autoswitch-daemon.py`)

**Step 1: Reproduce**

```bash
grep -n "accounts = sorted(f\[:-5\] for f in os.listdir(CREDS_DIR)" relay
```
Expected: one hit inside `load_config()`.

**Step 2: Add `_read_order()` to the daemon script and use it in `load_config()`**

Current (relay:1209-1224):
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

New:
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

**Step 3: Verify by extracting the daemon script and exercising `_read_order` in isolation**

```bash
sed -n '/^_extract_daemon() {/,/^DAEMON_EOF/p' relay | sed '1d;$d' > /tmp/autoswitch-daemon-test.py
python3 -c "
import sys
src = open('/tmp/autoswitch-daemon-test.py').read().split('def main()')[0]
exec(src)
import tempfile, os
d = tempfile.mkdtemp()
os.makedirs(os.path.join(d, 'creds'))
open(os.path.join(d, 'creds', 'zebra.json'), 'w').close()
open(os.path.join(d, 'creds', 'apple.json'), 'w').close()
open(os.path.join(d, 'order'), 'w').write('zebra\napple\n')
print(_read_order(os.path.join(d, 'creds')))
"
```
Expected: `['zebra', 'apple']` (order-file order preserved, not `['apple', 'zebra']`).

**Step 4: Commit**

```bash
git add relay
git commit -m "fix: autoswitch daemon auto-default order respects persisted order file"
```

---

### Task 5: Fix `cmd_lock`'s and `_warmup_ensure_config`'s auto-default generators

**Files:**
- Modify: `relay:1684-1695` (inside `cmd_lock`)
- Modify: `relay:1751-1763` (`_warmup_ensure_config`)

**Step 1: Reproduce**

```bash
grep -n "accounts = sorted(f\[:-5\] for f in os.listdir(creds_dir)" relay
```
Expected: two hits (one in each function).

**Step 2: Fix `cmd_lock`'s generator**

Current (relay:1684-1695):
```python
    "${PY}" - "${CREDS_STORE}" "${cfg}" <<'PYEOF'
import json, sys, os
creds_dir, cfg_path = sys.argv[1], sys.argv[2]
accounts = sorted(f[:-5] for f in os.listdir(creds_dir) if f.endswith('.json'))
config = {
    'order': accounts,
    'thresholds': {a: 80 for a in accounts},
    'locks': [],
    'poll': {'low_minutes': 10, 'high_minutes': 2, 'high_threshold': 50}
}
json.dump(config, open(cfg_path, 'w'), indent=2)
PYEOF
```
New:
```python
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
```

**Step 3: Fix `_warmup_ensure_config`'s generator**

Current (relay:1751-1763):
```python
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
```
New:
```python
    "${PY}" - "${CREDS_STORE}" "${cfg}" <<'PYEOF'
import json, sys, os
creds_dir, cfg_path = sys.argv[1], sys.argv[2]
on_disk = set(f[:-5] for f in os.listdir(creds_dir) if f.endswith('.json')) if os.path.isdir(creds_dir) else set()
order_file = os.path.join(os.path.dirname(creds_dir), 'order')
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
    'poll': {'low_minutes': 10, 'high_minutes': 2, 'high_threshold': 50},
    'warmup': []
}
json.dump(config, open(cfg_path, 'w'), indent=2)
PYEOF
```

**Step 4: Verify**

```bash
export RELAY_TEST_HOME=$(mktemp -d)/relayhome
mkdir -p "${RELAY_TEST_HOME}/.claude-relay/credentials"
touch "${RELAY_TEST_HOME}/.claude-relay/credentials/zebra.json"
touch "${RELAY_TEST_HOME}/.claude-relay/credentials/apple.json"
printf "zebra\napple\n" > "${RELAY_TEST_HOME}/.claude-relay/order"
HOME="${RELAY_TEST_HOME}" /Users/ds-anxing/GitHub/relay/relay lock zebra
cat "${RELAY_TEST_HOME}/.claude-relay/autoswitch.json"
rm -rf "$(dirname "${RELAY_TEST_HOME}")"
```
Expected: `autoswitch.json`'s `"order"` field is `["zebra", "apple"]`, not `["apple", "zebra"]`.

**Step 5: Commit**

```bash
git add relay
git commit -m "fix: lock and warmup auto-default configs respect persisted account order"
```

---

### Task 6: Fix the autoswitch reorder wizard's stdin bug + add concatenated-digit shorthand

**Files:**
- Modify: `relay:102-109` area — add `prompt_reorder()` function after Task 2's helpers
- Modify: `relay:1319-1356` (`cmd_autoswitch_config` Step 1 — replaced by a call to `prompt_reorder`)

**Step 1: Reproduce the stdin bug**

```bash
accounts=(allen-work personal work)
PY=python3
order_input="312"
order_str=$(echo "${order_input}" | "${PY}" - "${accounts[@]}" <<'PYEOF'
import sys, re
raw = sys.stdin.read().strip()
accts = sys.argv[1:]
print("RAW SEEN BY PYTHON:", repr(raw))
if not raw:
    print(','.join(accts))
PYEOF
)
echo "order_str=[${order_str}]"
```
Expected: `RAW SEEN BY PYTHON: ''` — proves the piped input never reaches the script (heredoc redirection wins over the pipe), and the fallback branch (`if not raw`) always fires — this is exactly why the saved order matched the *original* unshuffled list regardless of what was typed.

**Step 2: Add `prompt_reorder()` function**

Insert after the `rename_in_order` helper from Task 2:
```bash
# interactive numbered reorder picker. Prints the account list + prompt to
# stderr (so it's visible even when the caller captures stdout), reads one
# line from stdin, resolves it to a comma-joined order, and echoes that
# order to stdout for the caller to capture.
prompt_reorder() {
  local accounts=("$@")
  echo "" >&2
  printf "  ${D}When an account hits its threshold, relay switches to the next one in order.${R}\n\n" >&2
  local i=1 acct
  for acct in "${accounts[@]}"; do
    printf "    ${D}%d${R}  %s\n" "${i}" "${acct}" >&2
    i=$((i+1))
  done
  echo "" >&2
  printf "  ${D}Type numbers in the order you want  (e.g. ${CY}2 1${D}, or ${CY}21${D} for <=9 accounts, or Enter to keep the order above):${R}\n" >&2
  printf "  > " >&2
  read -r order_input

  local order_str; order_str=$("${PY}" - "${order_input}" "${accounts[@]}" <<'PYEOF'
import sys, re
raw = sys.argv[1].strip()
accts = sys.argv[2:]
if not raw:
    result = accts
elif raw.isdigit() and not re.search(r'[\s,]', raw) and len(accts) <= 9:
    # concatenated shorthand, e.g. "312" -> [3, 1, 2], only unambiguous for <=9 accounts
    result = []
    for ch in raw:
        idx = int(ch) - 1
        if 0 <= idx < len(accts):
            result.append(accts[idx])
else:
    tokens = re.split(r'[\s,]+', raw)
    result = []
    for t in tokens:
        t = t.strip()
        if t.isdigit():
            idx = int(t) - 1
            if 0 <= idx < len(accts):
                result.append(accts[idx])
        elif t:
            result.append(t)
print(','.join(result))
PYEOF
)

  local chain; chain=$(echo "${order_str}" | "${PY}" -c "
import sys; names=sys.stdin.read().strip().split(',')
print(' -> '.join(names) + ' -> (cycle)')")
  printf "  ${D}Order: ${CY}%s${R}\n" "${chain}" >&2

  echo "${order_str}"
}
```

Note: the real `relay` file uses the literal `→` arrow character (not `->`) in the existing chain-display code and the literal `≤` character is optional — write the ASCII `<=`/`->` shown above verbatim, or match the file's existing `→` glyph for visual consistency with `cmd_autoswitch_config`'s current chain output. Either is fine functionally; prefer matching the existing `→` glyph since that's what the current code (and the user's screenshot) already shows.

**Step 3: Replace `cmd_autoswitch_config`'s Step 1 with a call to `prompt_reorder`**

Current (relay:1319-1356):
```bash
  # ── Step 1: switch order ───────────────────────────────────────
  echo ""
  printf "  ${B}Step 1 / 3 — Switch order${R}\n"
  printf "  ${D}When an account hits its threshold, relay switches to the next one in order.${R}\n\n"
  local i=1
  for acct in "${accounts[@]}"; do
    printf "    ${D}%d${R}  %s\n" "${i}" "${acct}"
    i=$((i+1))
  done
  echo ""
  printf "  ${D}Type numbers in the order you want  (e.g. ${CY}2 1${D}  or just Enter to keep the order above):${R}\n"
  printf "  > "; read -r order_input

  # resolve numbers (space or comma) to names; empty = default order
  local order_str; order_str=$(echo "${order_input}" | "${PY}" - "${accounts[@]}" <<'PYEOF'
import sys, re
raw = sys.stdin.read().strip()
accts = sys.argv[1:]
if not raw:
    print(','.join(accts))
else:
    tokens = re.split(r'[\s,]+', raw)
    result = []
    for t in tokens:
        t = t.strip()
        if t.isdigit():
            idx = int(t) - 1
            if 0 <= idx < len(accts): result.append(accts[idx])
        elif t:
            result.append(t)
    print(','.join(result))
PYEOF
)
  # show resolved order as a visual chain
  local chain; chain=$(echo "${order_str}" | "${PY}" -c "
import sys; names=sys.stdin.read().strip().split(',')
print(' → '.join(names) + ' → (cycle)')")
  printf "  ${D}Order: ${CY}%s${R}\n" "${chain}"
```
New:
```bash
  # ── Step 1: switch order ───────────────────────────────────────
  echo ""
  printf "  ${B}Step 1 / 3 — Switch order${R}\n"
  local order_str; order_str=$(prompt_reorder "${accounts[@]}")
```

**Step 4: Verify the fix reproduces correctly**

```bash
accounts=(allen-work personal work)
PY=python3
order_input="312"
order_str=$("${PY}" - "${order_input}" "${accounts[@]}" <<'PYEOF'
import sys, re
raw = sys.argv[1].strip()
accts = sys.argv[2:]
if not raw:
    result = accts
elif raw.isdigit() and not re.search(r'[\s,]', raw) and len(accts) <= 9:
    result = []
    for ch in raw:
        idx = int(ch) - 1
        if 0 <= idx < len(accts):
            result.append(accts[idx])
else:
    tokens = re.split(r'[\s,]+', raw)
    result = []
    for t in tokens:
        t = t.strip()
        if t.isdigit():
            idx = int(t) - 1
            if 0 <= idx < len(accts):
                result.append(accts[idx])
        elif t:
            result.append(t)
print(','.join(result))
PYEOF
)
echo "order_str=[${order_str}]"
```
Expected: `order_str=[work,allen-work,personal]` — positions 3,1,2 of `allen-work,personal,work` resolve to `work,allen-work,personal`. This proves the shorthand "312" now actually resolves to the typed order, unlike before (Step 1 showed it used to be silently ignored).

Also verify space-separated input still works (same script, `order_input="3 1 2"`) — expect the identical result `work,allen-work,personal`.

**Step 5: Commit**

```bash
git add relay
git commit -m "fix: autoswitch reorder wizard no longer discards typed order; support concatenated digit shorthand"
```

---

### Task 7: Add standalone `relay reorder` command

**Files:**
- Modify: `relay:1654` area — add `cmd_reorder()` function before `cmd_lock()`
- Modify: `relay:2191` (dispatch case, after `rename|mv`)
- Modify: `relay:2133` (help text, after the `rename` line)

**Step 1: Add `cmd_reorder()`**

Insert immediately before `cmd_lock() {` (relay:1654):
```bash
cmd_reorder() {
  hdr "reorder accounts"

  local accounts=()
  local name
  while IFS= read -r name; do accounts+=("${name}"); done < <(list_account_names)

  if [[ ${#accounts[@]} -eq 0 ]]; then
    err "No accounts found. Run: relay add <name>"
    exit 1
  fi

  local order_str; order_str=$(prompt_reorder "${accounts[@]}")

  if [[ -z "${order_str}" ]]; then
    err "No valid order given — nothing changed"
    exit 1
  fi

  local order_arr=()
  IFS=',' read -ra order_arr <<< "${order_str}"
  printf '%s\n' "${order_arr[@]}" > "${ORDER_FILE}"
  ok "Order saved to ${ORDER_FILE}"

  local cfg="${RELAY_DIR}/autoswitch.json"
  if [[ -f "${cfg}" ]]; then
    "${PY}" - "${cfg}" "${order_str}" <<'PYEOF'
import json, sys
cfg_path, order_str = sys.argv[1], sys.argv[2]
cfg = json.load(open(cfg_path))
cfg['order'] = order_str.split(',')
json.dump(cfg, open(cfg_path, 'w'), indent=2)
PYEOF
    ok "Also updated order in ${cfg}"
  fi
}
```

**Step 2: Add dispatch entry**

Current (relay:2191):
```bash
  rename|mv)        cmd_rename "$@" ;;
```
New:
```bash
  rename|mv)        cmd_rename "$@" ;;
  reorder)          cmd_reorder "$@" ;;
```

**Step 3: Add help text entry**

Current (relay:2133):
```bash
  printf "  %-32s %s\n" "  relay rename <old> <new>" "rename an account"
```
New:
```bash
  printf "  %-32s %s\n" "  relay rename <old> <new>" "rename an account"
  printf "  %-32s %s\n" "  relay reorder"            "change account display/switch order"
```

**Step 4: Verify end-to-end**

```bash
export RELAY_TEST_HOME=$(mktemp -d)/relayhome
mkdir -p "${RELAY_TEST_HOME}/.claude-relay/credentials"
touch "${RELAY_TEST_HOME}/.claude-relay/credentials/personal.json"
touch "${RELAY_TEST_HOME}/.claude-relay/credentials/work.json"
touch "${RELAY_TEST_HOME}/.claude-relay/credentials/allen-work.json"
HOME="${RELAY_TEST_HOME}" /Users/ds-anxing/GitHub/relay/relay reorder <<< "312"
cat "${RELAY_TEST_HOME}/.claude-relay/order"
rm -rf "$(dirname "${RELAY_TEST_HOME}")"
```
Expected: `relay reorder` shows the numbered list (`1 allen-work, 2 personal, 3 work` — alphabetical bootstrap since no prior order file), accepts `312`, and `order` ends up as `work`, `allen-work`, `personal` (positions 3,1,2 resolved correctly).

**Step 5: Commit**

```bash
git add relay
git commit -m "feat: add standalone relay reorder command"
```

---

### Task 8: Migrate this repo's local install to the real add-order

**Files:**
- Modify: `~/.claude-relay/order` (not part of the repo — local machine state)

**Step 1: Confirm current (broken) state**

```bash
cat ~/.claude-relay/order 2>/dev/null || echo "(no order file yet — will be created alphabetically on next relay invocation)"
```

**Step 2: Write the corrected order**

Per the user-confirmed real add-order (`personal → work → allen-work`):
```bash
printf 'personal\nwork\nallen-work\n' > ~/.claude-relay/order
```

**Step 3: Verify**

```bash
/Users/ds-anxing/GitHub/relay/relay list --no-usage
```
Expected: `personal` is #1, `work` is #2, `allen-work` is #3.

```bash
cat ~/.claude-relay/autoswitch.json 2>/dev/null
```
If this file exists and its `"order"` doesn't match, run `/Users/ds-anxing/GitHub/relay/relay reorder` and type `1 2 3` (i.e., keep personal/work/allen-work) to sync it, or just press Enter if the numbered list already shows that order.

No commit — this step only touches local machine state under `~/.claude-relay`, not the repo.

---

### Task 9: Update `CLAUDE.md` architecture notes

**Files:**
- Modify: `CLAUDE.md:15` (Architecture section)

**Step 1: Add a bullet documenting the new order file**

Current (CLAUDE.md:15):
```markdown
- Credentials: macOS uses Keychain (service `Claude Code-credentials`); Linux uses `~/.claude/.credentials.json`. Relay's own per-account store lives at `~/.claude-relay/credentials/<name>.json`.
```
New:
```markdown
- Credentials: macOS uses Keychain (service `Claude Code-credentials`); Linux uses `~/.claude/.credentials.json`. Relay's own per-account store lives at `~/.claude-relay/credentials/<name>.json`.
- Account display/switch order is persisted in `~/.claude-relay/order` (one name per line, add-order) — this is the single source of truth for ordering; every listing/index/autoswitch-default path reads it instead of sorting filenames. Self-healing: stale entries are dropped and untracked credential files are appended automatically. Use `relay reorder` to change it.
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document the account order file in CLAUDE.md"
```

---

### Task 10: Full manual regression pass

**Step 1: Run the design doc's full testing plan end-to-end in one sandbox**

```bash
export RELAY_TEST_HOME=$(mktemp -d)/relayhome
mkdir -p "${RELAY_TEST_HOME}/.claude-relay/credentials" "${RELAY_TEST_HOME}/.claude-relay/meta"
R="/Users/ds-anxing/GitHub/relay/relay"

# 1. Fresh accounts out of alphabetical order
touch "${RELAY_TEST_HOME}/.claude-relay/credentials/z.json"
HOME="${RELAY_TEST_HOME}" "${R}" list --no-usage   # bootstraps order file with just z
touch "${RELAY_TEST_HOME}/.claude-relay/credentials/a.json"
echo "a" >> "${RELAY_TEST_HOME}/.claude-relay/order"
HOME="${RELAY_TEST_HOME}" "${R}" list --no-usage   # expect z first, a second

# 2. Simulate refresh overwrite — order must not change
echo '{}' > "${RELAY_TEST_HOME}/.claude-relay/credentials/z.json"
HOME="${RELAY_TEST_HOME}" "${R}" list --no-usage   # still z first

# 3. Remove
HOME="${RELAY_TEST_HOME}" "${R}" remove a <<< "y"
cat "${RELAY_TEST_HOME}/.claude-relay/order"        # expect only z

rm -rf "$(dirname "${RELAY_TEST_HOME}")"
```
Expected: matches the comments inline above at each step.

**Step 2: If any step fails, stop and fix before proceeding — do not mark this task done on a partial pass.**

**Step 3: No commit for this task** (verification only, no code change).

---

## Follow-ups (explicitly out of scope for this plan)

- Bumping `package.json` version / publishing to npm / changelog entry — per `CLAUDE.md`'s publish checklist, do this as a separate deliberate step when ready to ship, not bundled into this bugfix plan.
- `relay reorder` does not validate that the typed order covers every account (matches pre-existing `cmd_autoswitch_config` behavior) — if this turns out to be confusing in practice, file a follow-up rather than silently expanding scope here.
