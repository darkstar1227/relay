# LiteLLM Provider Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `relay` manage LiteLLM-backed model providers (add/list/use/off/remove) alongside its existing subscription-account switching, plus a `relay run <name>` command that launches a single `claude` session pinned to a specific account or provider without touching any global state.

**Architecture:** Subscription accounts (unchanged) swap OAuth credentials into Keychain/`credentials.json`. Providers (new) are a second, mutually-exclusive global mode that merges/clears four keys in `${CLAUDE_DIR}/settings.json`'s `env` block via embedded-Python JSON read-modify-write — same pattern the script already uses everywhere else for JSON. `relay run` bypasses both global mechanisms for a one-off session: for an account it's sugar for switch-then-exec; for a provider it uses `claude --settings '<inline JSON>'`, a session-scoped CLI override verified (see design doc) to be immune to concurrent global-state changes.

**Tech Stack:** bash 3.2 (macOS-compatible), Python 3 (embedded heredocs via `${PY}`), no formal test framework — verification is manual/scripted shell runs via the Bash tool, following this repo's existing convention (see `docs/plans/2026-07-10-account-order-fix-implementation.md`).

**Reference:** `docs/plans/2026-07-24-litellm-provider-design.md` (approved design, includes live verification of the `--settings` mechanism against a real LiteLLM-shaped test server).

## Global Constraints

- macOS bash 3.2 compatible — no associative arrays, no `mapfile`, use the `${arr[@]+"${arr[@]}"}` idiom for any array that might be empty under `set -u` (this script runs with `set -u`).
- Reuse `${PY}` (already-resolved python3 path, relay:23-26) for all JSON handling — never invoke `python3` directly.
- Reuse the existing `CLAUDE_DIR="${HOME}/.claude"` constant (relay:17) for all Claude Code config paths — never hardcode `~/.claude` again.
- New credential-shaped files follow the existing convention: `chmod 600`, stored under `${RELAY_DIR}` (relay:11).
- Never blind-overwrite `${CLAUDE_DIR}/settings.json` — always JSON read-modify-write, preserving unrelated keys, and abort with a clear error on malformed JSON rather than clobbering the file.
- Match existing message styling: `ok()`/`warn()`/`err()`/`log()`/`hdr()` helpers (relay:57-61), color vars `R`/`B`/`D`/`GR`/`YL`/`RD`/`CY`/`MG` (relay:54-55).
- Line numbers cited below are current as of this plan's writing (2026-07-24, against the file committed in `21be725`/`b746cc7`). **Task 0** re-verifies them before any edits — if they've drifted, stop and re-grep before continuing.

---

### Task 0: Confirm working state and re-verify line anchors

**Files:** none modified — verification only.

- [ ] **Step 1: Confirm no unexpected local changes**

Run: `git -C /Users/ds-anxing/GitHub/relay status --short`
Expected: only already-known untracked/modified entries (`CLAUDE.md` modified, `AGENTS.md`, `openwiki/`, `.github/workflows/openwiki-update.yml` untracked) — no unexpected changes to `relay` itself.

- [ ] **Step 2: Re-verify function/constant line anchors**

Run:
```bash
cd /Users/ds-anxing/GitHub/relay
grep -n "^RELAY_DIR=\|^CREDS_STORE=\|^CLAUDE_DIR=\|^PY=\|^R=\$'\|^log()\|^ok()\|^warn()\|^err()\|^hdr()\|^current_name\|^account_creds\|^account_meta\|^account_exists\|^list_account_names\|^require_claude\|^do_switch\|^_do_switch_locked\|^cmd_quick\|^_cmd_status_once\|^cmd_status\|^cmd_add\|^cmd_help\|^CMD=\"\|^case \"\${CMD}\"" relay
```
Expected output (line numbers must match exactly, or stop and re-read the file before continuing with later tasks):
```
11:RELAY_DIR="${HOME}/.claude-relay"
12:CREDS_STORE="${RELAY_DIR}/credentials"
17:CLAUDE_DIR="${HOME}/.claude"
23:PY="/usr/bin/python3"
54:R=$'\033[0m'; B=$'\033[1m'; D=$'\033[2m'
57:log()  { printf "  ${CY}→${R} %s\n" "$*"; }
58:ok()   { printf "  ${GR}✓${R} %s\n" "$*"; }
59:warn() { printf "  ${YL}⚠${R} %s\n" "$*"; }
60:err()  { printf "  ${RD}✗${R} %s\n" "$*" >&2; }
61:hdr()  { printf "\n${B}${MG}  %s${R}\n  ${D}─────────────────────────────────────${R}\n" "$*"; }
98:current_name()   { [[ -f "${CURRENT_FILE}" ]] && cat "${CURRENT_FILE}" || echo ""; }
99:account_creds()  { echo "${CREDS_STORE}/$1.json"; }
100:account_meta()   { echo "${META_STORE}/$1"; }
101:account_exists() { [[ -f "$(account_creds "$1")" ]]; }
106:list_account_names() {
263:require_claude() {
516:do_switch() {
520:_do_switch_locked() {
563:cmd_quick() {
609:_cmd_status_once() {
712:cmd_status() {
787:cmd_add() {
2353:cmd_help() {
2404:CMD="${1:-}"
2407:case "${CMD}" in
```
(Exact numbers may drift by a line or two if the file changed since — re-run the grep and adjust every task below accordingly before editing.)

---

### Task 1: Provider storage constants and accessor helpers

**Files:**
- Modify: `relay:11-18` (add constants)
- Modify: `relay:93-94` (add `mkdir -p`/`chmod` for the new store)
- Modify: `relay:98-101` (add accessor functions alongside the account ones)

**Interfaces:**
- Produces: `PROVIDERS_STORE`, `ACTIVE_PROVIDER_FILE`, `CLAUDE_SETTINGS` (constants); `provider_file(name)`, `provider_exists(name)`, `list_provider_names()`, `active_provider_name()`, `_provider_field(name, key)`, `_provider_discover(name)` (functions) — used by every later task in this plan.

- [ ] **Step 1: Add constants**

Current (relay:11-18):
```bash
RELAY_DIR="${HOME}/.claude-relay"
CREDS_STORE="${RELAY_DIR}/credentials"
META_STORE="${RELAY_DIR}/meta"
CURRENT_FILE="${RELAY_DIR}/current"
ORDER_FILE="${RELAY_DIR}/order"
UPDATE_CACHE="${RELAY_DIR}/.update_cache"
CLAUDE_DIR="${HOME}/.claude"
CLAUDE_JSON="${HOME}/.claude.json"
```

New:
```bash
RELAY_DIR="${HOME}/.claude-relay"
CREDS_STORE="${RELAY_DIR}/credentials"
META_STORE="${RELAY_DIR}/meta"
CURRENT_FILE="${RELAY_DIR}/current"
ORDER_FILE="${RELAY_DIR}/order"
UPDATE_CACHE="${RELAY_DIR}/.update_cache"
PROVIDERS_STORE="${RELAY_DIR}/providers"
ACTIVE_PROVIDER_FILE="${RELAY_DIR}/active_provider"
CLAUDE_DIR="${HOME}/.claude"
CLAUDE_JSON="${HOME}/.claude.json"
CLAUDE_SETTINGS="${CLAUDE_DIR}/settings.json"
```

- [ ] **Step 2: Create the providers directory at startup**

Current (relay:93-94):
```bash
mkdir -p "${CREDS_STORE}" "${META_STORE}" "${CLAUDE_DIR}"
chmod 700 "${RELAY_DIR}" "${CREDS_STORE}" 2>/dev/null || true
```

New:
```bash
mkdir -p "${CREDS_STORE}" "${META_STORE}" "${PROVIDERS_STORE}" "${CLAUDE_DIR}"
chmod 700 "${RELAY_DIR}" "${CREDS_STORE}" "${PROVIDERS_STORE}" 2>/dev/null || true
```

- [ ] **Step 3: Add accessor functions**

Current (relay:98-101):
```bash
current_name()   { [[ -f "${CURRENT_FILE}" ]] && cat "${CURRENT_FILE}" || echo ""; }
account_creds()  { echo "${CREDS_STORE}/$1.json"; }
account_meta()   { echo "${META_STORE}/$1"; }
account_exists() { [[ -f "$(account_creds "$1")" ]]; }
```

New:
```bash
current_name()   { [[ -f "${CURRENT_FILE}" ]] && cat "${CURRENT_FILE}" || echo ""; }
account_creds()  { echo "${CREDS_STORE}/$1.json"; }
account_meta()   { echo "${META_STORE}/$1"; }
account_exists() { [[ -f "$(account_creds "$1")" ]]; }

provider_file()   { echo "${PROVIDERS_STORE}/$1.json"; }
provider_exists() { [[ -f "$(provider_file "$1")" ]]; }
active_provider_name() { [[ -f "${ACTIVE_PROVIDER_FILE}" ]] && cat "${ACTIVE_PROVIDER_FILE}" || echo ""; }

# list providers alphabetically, one per line (bash 3.2 compatible)
list_provider_names() {
  local f
  for f in "${PROVIDERS_STORE}"/*.json; do
    [[ -f "${f}" ]] || continue
    basename "${f}" .json
  done | sort
}

# read one string field from a provider's JSON file; "" if absent
_provider_field() {
  "${PY}" -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],"") or "")' "$(provider_file "$1")" "$2"
}

# "1" if the provider has discover_models truthy, else ""
_provider_discover() {
  "${PY}" -c 'import json,sys; print("1" if json.load(open(sys.argv[1])).get("discover_models") else "")' "$(provider_file "$1")"
}
```

- [ ] **Step 4: Verify manually**

```bash
export RELAY_TEST_HOME=$(mktemp -d)/relayhome
HOME="${RELAY_TEST_HOME}" bash -c '
  source <(sed -n "1,101p" /Users/ds-anxing/GitHub/relay/relay)
  mkdir -p "${PROVIDERS_STORE}"
  printf "%s" "{\"base_url\":\"http://localhost:4000\",\"auth_token\":\"sk-test\",\"model\":\"claude-sonnet-4-5\",\"discover_models\":true}" > "$(provider_file demo)"
  echo "exists: $(provider_exists demo && echo yes || echo no)"
  echo "list: $(list_provider_names)"
  echo "active (should be empty): [$(active_provider_name)]"
  echo "base_url: $(_provider_field demo base_url)"
  echo "model: $(_provider_field demo model)"
  echo "discover: [$(_provider_discover demo)]"
'
rm -rf "$(dirname "${RELAY_TEST_HOME}")"
```
Expected:
```
exists: yes
list: demo
active (should be empty): []
base_url: http://localhost:4000
model: claude-sonnet-4-5
discover: [1]
```
(`source <(sed -n "1,101p" ...)` pulls in just the constants/helpers defined through line 101 — later tasks' verification steps use the same technique with an updated line range as functions are added below line 101.)

- [ ] **Step 5: Commit**

```bash
cd /Users/ds-anxing/GitHub/relay
git add relay
git commit -m "$(cat <<'EOF'
feat: add provider storage constants and accessor helpers

Scaffolding for LiteLLM provider support — no user-facing commands yet.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Namespace collision guard on `cmd_add`

**Files:**
- Modify: `relay:787-798` (`cmd_add`)

**Interfaces:**
- Consumes: `provider_exists(name)` from Task 1.

- [ ] **Step 1: Add the collision check**

Current (relay:787-798):
```bash
cmd_add() {
  local name="${1:-}"
  [[ -z "${name}" ]] && { err "usage: relay add <name>"; exit 1; }
  case "${name}" in
    *[!a-zA-Z0-9_-]*) err "name must contain only letters, numbers, underscores, or hyphens"; exit 1 ;;
  esac
  require_claude
  if account_exists "${name}"; then
    warn "Account '${name}' already exists"
    log "To re-login: ${B}relay add-force ${name}${R}"
    return 0
  fi
```

New:
```bash
cmd_add() {
  local name="${1:-}"
  [[ -z "${name}" ]] && { err "usage: relay add <name>"; exit 1; }
  case "${name}" in
    *[!a-zA-Z0-9_-]*) err "name must contain only letters, numbers, underscores, or hyphens"; exit 1 ;;
  esac
  if provider_exists "${name}"; then
    err "'${name}' is already a LiteLLM provider — pick a different account name"
    exit 1
  fi
  require_claude
  if account_exists "${name}"; then
    warn "Account '${name}' already exists"
    log "To re-login: ${B}relay add-force ${name}${R}"
    return 0
  fi
```

- [ ] **Step 2: Verify manually**

```bash
export RELAY_TEST_HOME=$(mktemp -d)/relayhome
mkdir -p "${RELAY_TEST_HOME}/.claude-relay/providers"
printf '{"base_url":"http://localhost:4000","auth_token":"sk-test"}' > "${RELAY_TEST_HOME}/.claude-relay/providers/taken.json"
HOME="${RELAY_TEST_HOME}" /Users/ds-anxing/GitHub/relay/relay add taken
rm -rf "$(dirname "${RELAY_TEST_HOME}")"
```
Expected: `✗ 'taken' is already a LiteLLM provider — pick a different account name`, exit code 1, and no browser login attempted (command returns immediately).

- [ ] **Step 3: Commit**

```bash
cd /Users/ds-anxing/GitHub/relay
git add relay
git commit -m "$(cat <<'EOF'
feat: reject relay add when the name is already a provider

Keeps account and provider names in disjoint namespaces so relay run
can dispatch on name alone without ambiguity.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `relay provider add`

**Files:**
- Modify: `relay` — add `cmd_provider_add()` immediately before `cmd_add()` (currently relay:787).

**Interfaces:**
- Consumes: `provider_exists`, `account_exists`, `provider_file` (Task 1).
- Produces: `cmd_provider_add(name, ...)` — not yet wired to dispatch (Task 12 wires `relay provider ...`).

- [ ] **Step 1: Add the function**

Insert immediately before `cmd_add() {` (relay:787):
```bash
cmd_provider_add() {
  local name="${1:-}"
  [[ -z "${name}" ]] && { err "usage: relay provider add <name> --base-url <url> --token <token> [--model <model>] [--discover-models]"; exit 1; }
  shift
  case "${name}" in
    *[!a-zA-Z0-9_-]*) err "name must contain only letters, numbers, underscores, or hyphens"; exit 1 ;;
  esac
  if account_exists "${name}"; then
    err "'${name}' is already an account — pick a different provider name"
    exit 1
  fi
  if provider_exists "${name}"; then
    warn "Provider '${name}' already exists"
    log "To change it: relay provider remove ${name} && relay provider add ${name} ..."
    return 0
  fi

  local base_url="" token="" model="" discover=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --base-url) base_url="${2:-}"; shift 2 ;;
      --token) token="${2:-}"; shift 2 ;;
      --model) model="${2:-}"; shift 2 ;;
      --discover-models) discover=1; shift ;;
      *) err "unknown option: $1"; exit 1 ;;
    esac
  done

  [[ -z "${base_url}" ]] && { err "--base-url is required"; exit 1; }
  [[ -z "${token}" ]] && { err "--token is required"; exit 1; }
  case "${base_url}" in
    http://*|https://*) ;;
    *) err "--base-url must start with http:// or https://"; exit 1 ;;
  esac

  "${PY}" -c '
import json, sys, os
path, base_url, token, model, discover = sys.argv[1:6]
d = {"base_url": base_url, "auth_token": token}
if model:
    d["model"] = model
if discover == "1":
    d["discover_models"] = True
with open(path, "w") as f:
    json.dump(d, f)
os.chmod(path, 0o600)
' "$(provider_file "${name}")" "${base_url}" "${token}" "${model}" "${discover}"

  ok "Provider '${B}${name}${R}' added  ${D}${base_url}${R}"
}

cmd_add() {
```

- [ ] **Step 2: Verify manually**

```bash
export RELAY_TEST_HOME=$(mktemp -d)/relayhome
HOME="${RELAY_TEST_HOME}" bash -c '
  source /Users/ds-anxing/GitHub/relay/relay 2>/dev/null || true
' 2>/dev/null
# The line above would run the whole script (and hit dispatch); instead call the
# function directly via a small driver that only sources definitions:
HOME="${RELAY_TEST_HOME}" bash -c '
  export HOME
  RELAY_SOURCE_ONLY=1
  eval "$(sed -n "1,2402p" /Users/ds-anxing/GitHub/relay/relay)"
  cmd_provider_add mylitellm --base-url http://localhost:4000 --token sk-test --model claude-sonnet-4-5 --discover-models
  echo "---"
  cat "$(provider_file mylitellm)"
  echo
  echo "perms: $(stat -f "%Lp" "$(provider_file mylitellm)" 2>/dev/null || stat -c "%a" "$(provider_file mylitellm)")"
'
rm -rf "$(dirname "${RELAY_TEST_HOME}")"
```
Expected:
```
✓ Provider 'mylitellm' added  http://localhost:4000
---
{"base_url": "http://localhost:4000", "auth_token": "sk-test", "model": "claude-sonnet-4-5", "discover_models": true}
perms: 600
```
Also test the required-flag errors:
```bash
export RELAY_TEST_HOME=$(mktemp -d)/relayhome
HOME="${RELAY_TEST_HOME}" bash -c '
  eval "$(sed -n "1,2402p" /Users/ds-anxing/GitHub/relay/relay)"
  cmd_provider_add badurl --base-url notaurl --token sk-test
'
rm -rf "$(dirname "${RELAY_TEST_HOME}")"
```
Expected: `✗ --base-url must start with http:// or https://`, exit 1, no file created.

**Note on the test driver:** `eval "$(sed -n "1,2402p" relay)"` sources every top-level statement and function definition up through just before the `CMD="${1:-}"` dispatch line, without ever executing the dispatch `case` block — this is how every task in this plan calls individual `cmd_*`/helper functions directly without triggering the real CLI dispatch or requiring a subcommand round-trip. Re-check the exact line number against Task 0's `CMD="${1:-}"` anchor (2404) before using — the range should end at (that anchor's line − 2), i.e. the blank line before `_maybe_redeploy_daemon`.

- [ ] **Step 3: Commit**

```bash
cd /Users/ds-anxing/GitHub/relay
git add relay
git commit -m "$(cat <<'EOF'
feat: add cmd_provider_add for configuring LiteLLM providers

Stores base_url/auth_token/model/discover_models as chmod-600 JSON,
matching the existing per-account credential file convention.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `relay provider list`

**Files:**
- Modify: `relay` — add `cmd_provider_list()` immediately after `cmd_provider_add()` (Task 3).

**Interfaces:**
- Consumes: `list_provider_names`, `active_provider_name`, `_provider_field` (Task 1).

- [ ] **Step 1: Add the function**

```bash
cmd_provider_list() {
  hdr "LiteLLM providers"
  local names; names=$(list_provider_names)
  if [[ -z "${names}" ]]; then
    warn "No providers configured — add one with: relay provider add <name> --base-url <url> --token <token>"
    return 0
  fi
  local active; active=$(active_provider_name)
  local name base_url model info
  while IFS= read -r name; do
    [[ -z "${name}" ]] && continue
    base_url=$(_provider_field "${name}" base_url)
    model=$(_provider_field "${name}" model)
    info="${base_url}"
    [[ -n "${model}" ]] && info="${info}  model=${model}"
    if [[ "${name}" == "${active}" ]]; then
      printf "  ${GR}${B}✓ %-16s${R} ${D}%s${R}\n" "${name}" "${info}"
    else
      printf "    %-16s ${D}%s${R}\n" "${name}" "${info}"
    fi
  done <<< "${names}"
}
```

- [ ] **Step 2: Verify manually**

```bash
export RELAY_TEST_HOME=$(mktemp -d)/relayhome
HOME="${RELAY_TEST_HOME}" bash -c '
  eval "$(sed -n "1,2402p" /Users/ds-anxing/GitHub/relay/relay)"
  cmd_provider_add mylitellm --base-url http://localhost:4000 --token sk-test --model claude-sonnet-4-5
  cmd_provider_add other --base-url http://localhost:5000 --token sk-other
  printf "%s" "mylitellm" > "${ACTIVE_PROVIDER_FILE}"
  cmd_provider_list
'
rm -rf "$(dirname "${RELAY_TEST_HOME}")"
```
Expected: header, then `mylitellm` marked with `✓` and showing `http://localhost:4000  model=claude-sonnet-4-5`, `other` unmarked showing `http://localhost:5000`.

Also verify the empty case:
```bash
export RELAY_TEST_HOME=$(mktemp -d)/relayhome
HOME="${RELAY_TEST_HOME}" bash -c '
  eval "$(sed -n "1,2402p" /Users/ds-anxing/GitHub/relay/relay)"
  cmd_provider_list
'
rm -rf "$(dirname "${RELAY_TEST_HOME}")"
```
Expected: `⚠ No providers configured — add one with: relay provider add <name> --base-url <url> --token <token>`.

- [ ] **Step 3: Commit**

```bash
cd /Users/ds-anxing/GitHub/relay
git add relay
git commit -m "$(cat <<'EOF'
feat: add relay provider list

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: settings.json env merge/clear helpers

**Files:**
- Modify: `relay` — add `PROVIDER_ENV_KEYS`, `_settings_env_merge()`, `_settings_env_clear()` near the other helper functions (immediately after `require_claude`, currently relay:263-267).

**Interfaces:**
- Consumes: `CLAUDE_SETTINGS` (Task 1), `${PY}`.
- Produces: `_settings_env_merge(KEY=VALUE...)` (returns non-zero and prints to stderr on malformed JSON), `_settings_env_clear()` (removes exactly `PROVIDER_ENV_KEYS` from the `env` block, no-op if file/keys absent) — consumed by Tasks 6, 7, 9.

This is the highest-risk piece (it edits a file Claude Code itself depends on), so its own verification step covers: fresh file, pre-existing unrelated keys, malformed JSON, and idempotent clear.

- [ ] **Step 1: Add the constant and both functions**

Insert immediately after `require_claude() { ... }` (relay:263-267):
```bash
PROVIDER_ENV_KEYS=(ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_MODEL CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY)

# merge KEY=VALUE pairs into ${CLAUDE_SETTINGS}'s "env" object, preserving
# every other key in the file. Creates the file if absent.
_settings_env_merge() {
  "${PY}" - "${CLAUDE_SETTINGS}" "$@" <<'EOF'
import json, sys, os

path = sys.argv[1]
pairs = sys.argv[2:]

if os.path.exists(path):
    raw = open(path).read().strip()
    try:
        data = json.loads(raw) if raw else {}
    except json.JSONDecodeError as e:
        print(f"settings.json is not valid JSON: {e}", file=sys.stderr)
        sys.exit(1)
else:
    data = {}

if not isinstance(data, dict):
    print("settings.json root is not a JSON object", file=sys.stderr)
    sys.exit(1)

env = data.get("env")
if not isinstance(env, dict):
    env = {}
for pair in pairs:
    k, _, v = pair.partition("=")
    env[k] = v
data["env"] = env

with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
EOF
}

# remove exactly PROVIDER_ENV_KEYS from ${CLAUDE_SETTINGS}'s "env" object,
# leaving every other key (including unrelated env entries) untouched.
# No-op if the file doesn't exist or none of the keys are present.
_settings_env_clear() {
  "${PY}" - "${CLAUDE_SETTINGS}" "${PROVIDER_ENV_KEYS[@]}" <<'EOF'
import json, sys, os

path = sys.argv[1]
keys = sys.argv[2:]

if not os.path.exists(path):
    sys.exit(0)
raw = open(path).read().strip()
if not raw:
    sys.exit(0)
try:
    data = json.loads(raw)
except json.JSONDecodeError as e:
    print(f"settings.json is not valid JSON: {e}", file=sys.stderr)
    sys.exit(1)

if not isinstance(data, dict):
    print("settings.json root is not a JSON object", file=sys.stderr)
    sys.exit(1)

env = data.get("env")
if isinstance(env, dict):
    changed = False
    for k in keys:
        if k in env:
            del env[k]
            changed = True
    if changed:
        data["env"] = env
        with open(path, "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
EOF
}
```

- [ ] **Step 2: Verify — fresh file (doesn't exist yet)**

```bash
export RELAY_TEST_HOME=$(mktemp -d)/relayhome
HOME="${RELAY_TEST_HOME}" bash -c '
  eval "$(sed -n "1,2402p" /Users/ds-anxing/GitHub/relay/relay)"
  _settings_env_merge "ANTHROPIC_BASE_URL=http://localhost:4000" "ANTHROPIC_AUTH_TOKEN=sk-test"
  cat "${CLAUDE_SETTINGS}"
'
rm -rf "$(dirname "${RELAY_TEST_HOME}")"
```
Expected: valid JSON `{"env": {"ANTHROPIC_BASE_URL": "http://localhost:4000", "ANTHROPIC_AUTH_TOKEN": "sk-test"}}` (formatting may vary, keys/values must match).

- [ ] **Step 3: Verify — preserves unrelated existing keys, then clears cleanly**

```bash
export RELAY_TEST_HOME=$(mktemp -d)/relayhome
mkdir -p "${RELAY_TEST_HOME}/.claude"
printf '%s' '{"env":{"FOO":"bar"},"model":"opus"}' > "${RELAY_TEST_HOME}/.claude/settings.json"
HOME="${RELAY_TEST_HOME}" bash -c '
  eval "$(sed -n "1,2402p" /Users/ds-anxing/GitHub/relay/relay)"
  _settings_env_merge "ANTHROPIC_BASE_URL=http://localhost:4000" "ANTHROPIC_AUTH_TOKEN=sk-test"
  echo "--- after merge ---"
  cat "${CLAUDE_SETTINGS}"
  echo
  _settings_env_clear
  echo "--- after clear ---"
  cat "${CLAUDE_SETTINGS}"
'
rm -rf "$(dirname "${RELAY_TEST_HOME}")"
```
Expected: after merge, `env` has `FOO`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and `model: "opus"` survives at the top level. After clear, `env` has only `FOO` again, `model: "opus"` still present — i.e. exactly the 4 provider keys were touched, nothing else.

- [ ] **Step 4: Verify — malformed JSON aborts instead of clobbering**

```bash
export RELAY_TEST_HOME=$(mktemp -d)/relayhome
mkdir -p "${RELAY_TEST_HOME}/.claude"
printf '%s' '{not valid json' > "${RELAY_TEST_HOME}/.claude/settings.json"
HOME="${RELAY_TEST_HOME}" bash -c '
  eval "$(sed -n "1,2402p" /Users/ds-anxing/GitHub/relay/relay)"
  _settings_env_merge "ANTHROPIC_BASE_URL=http://localhost:4000" "ANTHROPIC_AUTH_TOKEN=sk-test"
  echo "exit: $?"
  cat "${CLAUDE_SETTINGS}"
'
rm -rf "$(dirname "${RELAY_TEST_HOME}")"
```
Expected: `settings.json is not valid JSON: ...` on stderr, non-zero exit, and the file's content is **unchanged** (`{not valid json`) — confirms no partial write happened.

- [ ] **Step 5: Verify — clear is a no-op when nothing to clear**

```bash
export RELAY_TEST_HOME=$(mktemp -d)/relayhome
HOME="${RELAY_TEST_HOME}" bash -c '
  eval "$(sed -n "1,2402p" /Users/ds-anxing/GitHub/relay/relay)"
  _settings_env_clear
  echo "exit: $?"
  ls "${CLAUDE_SETTINGS}" 2>&1
'
rm -rf "$(dirname "${RELAY_TEST_HOME}")"
```
Expected: exit 0, `ls` reports the file does not exist (never created by a no-op clear).

- [ ] **Step 6: Commit**

```bash
cd /Users/ds-anxing/GitHub/relay
git add relay
git commit -m "$(cat <<'EOF'
feat: add settings.json env merge/clear helpers for provider mode

JSON read-modify-write against ${CLAUDE_DIR}/settings.json's env block,
scoped to exactly the 4 LiteLLM-routing keys. Aborts on malformed JSON
instead of risking a clobber; preserves every unrelated key.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `relay provider use`

**Files:**
- Modify: `relay` — add `cmd_provider_use()` after `cmd_provider_list()` (Task 4).

**Interfaces:**
- Consumes: `provider_exists`, `_provider_field`, `_provider_discover` (Task 1), `_settings_env_merge` (Task 5).

- [ ] **Step 1: Add the function**

```bash
cmd_provider_use() {
  local name="${1:-}"
  [[ -z "${name}" ]] && { err "usage: relay provider use <name>"; exit 1; }
  provider_exists "${name}" || { err "Provider '${name}' not found"; exit 1; }

  local base_url token model discover
  base_url=$(_provider_field "${name}" base_url)
  token=$(_provider_field "${name}" auth_token)
  model=$(_provider_field "${name}" model)
  discover=$(_provider_discover "${name}")

  local pairs=("ANTHROPIC_BASE_URL=${base_url}" "ANTHROPIC_AUTH_TOKEN=${token}")
  [[ -n "${model}" ]] && pairs+=("ANTHROPIC_MODEL=${model}")
  [[ -n "${discover}" ]] && pairs+=("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1")

  _settings_env_merge "${pairs[@]}" || { err "Failed to update ${CLAUDE_SETTINGS}"; exit 1; }
  printf '%s' "${name}" > "${ACTIVE_PROVIDER_FILE}"

  printf "\n  ${GR}${B}⚡ provider active → %s${R}  ${D}%s${R}\n" "${name}" "${base_url}"
  printf "  ${D}Active sessions pick up the switch on next message. New session: ${CY}claude -c${R}\n\n"
}
```

Note: this does **not** touch `${CURRENT_FILE}` or Keychain — the subscription account stays exactly as it was, just dormant while provider mode routes requests. This is what lets `relay provider off` hand control back without any account switch logic.

- [ ] **Step 2: Verify manually**

```bash
export RELAY_TEST_HOME=$(mktemp -d)/relayhome
mkdir -p "${RELAY_TEST_HOME}/.claude"
printf '%s' '{"env":{"FOO":"bar"}}' > "${RELAY_TEST_HOME}/.claude/settings.json"
HOME="${RELAY_TEST_HOME}" bash -c '
  eval "$(sed -n "1,2402p" /Users/ds-anxing/GitHub/relay/relay)"
  cmd_provider_add mylitellm --base-url http://localhost:4000 --token sk-test --model claude-sonnet-4-5 --discover-models
  cmd_provider_use mylitellm
  echo "--- settings.json ---"
  cat "${CLAUDE_SETTINGS}"
  echo
  echo "--- active_provider ---"
  cat "${ACTIVE_PROVIDER_FILE}"
'
rm -rf "$(dirname "${RELAY_TEST_HOME}")"
```
Expected: `env` now has `FOO` (preserved), `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1"`; `active_provider` file contains `mylitellm`.

- [ ] **Step 3: Commit**

```bash
cd /Users/ds-anxing/GitHub/relay
git add relay
git commit -m "$(cat <<'EOF'
feat: add relay provider use

Merges the provider's routing keys into settings.json's env block and
records it as the active provider. Subscription credentials are left
untouched — they simply go dormant while provider mode is active.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `relay provider off`

**Files:**
- Modify: `relay` — add `cmd_provider_off()` after `cmd_provider_use()` (Task 6).

**Interfaces:**
- Consumes: `active_provider_name` (Task 1), `_settings_env_clear` (Task 5).

- [ ] **Step 1: Add the function**

```bash
cmd_provider_off() {
  local active; active=$(active_provider_name)
  if [[ -z "${active}" ]]; then
    warn "No provider is currently active"
    return 0
  fi
  _settings_env_clear || { err "Failed to update ${CLAUDE_SETTINGS}"; exit 1; }
  rm -f "${ACTIVE_PROVIDER_FILE}"
  ok "Provider mode off — subscription account resumes"
}
```

- [ ] **Step 2: Verify manually**

```bash
export RELAY_TEST_HOME=$(mktemp -d)/relayhome
mkdir -p "${RELAY_TEST_HOME}/.claude"
printf '%s' '{"env":{"FOO":"bar"}}' > "${RELAY_TEST_HOME}/.claude/settings.json"
HOME="${RELAY_TEST_HOME}" bash -c '
  eval "$(sed -n "1,2402p" /Users/ds-anxing/GitHub/relay/relay)"
  cmd_provider_add mylitellm --base-url http://localhost:4000 --token sk-test
  cmd_provider_use mylitellm
  cmd_provider_off
  echo "--- settings.json ---"
  cat "${CLAUDE_SETTINGS}"
  echo
  echo "active_provider exists: $([[ -f "${ACTIVE_PROVIDER_FILE}" ]] && echo yes || echo no)"
'
rm -rf "$(dirname "${RELAY_TEST_HOME}")"
```
Expected: `env` back to just `{"FOO": "bar"}`, `active_provider exists: no`.

Also verify the "nothing active" case:
```bash
export RELAY_TEST_HOME=$(mktemp -d)/relayhome
HOME="${RELAY_TEST_HOME}" bash -c '
  eval "$(sed -n "1,2402p" /Users/ds-anxing/GitHub/relay/relay)"
  cmd_provider_off
'
rm -rf "$(dirname "${RELAY_TEST_HOME}")"
```
Expected: `⚠ No provider is currently active`, exit 0.

- [ ] **Step 3: Commit**

```bash
cd /Users/ds-anxing/GitHub/relay
git add relay
git commit -m "$(cat <<'EOF'
feat: add relay provider off

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `relay provider remove`

**Files:**
- Modify: `relay` — add `cmd_provider_remove()` after `cmd_provider_off()` (Task 7).

**Interfaces:**
- Consumes: `provider_exists`, `active_provider_name` (Task 1), `cmd_provider_off` (Task 7).

- [ ] **Step 1: Add the function**

```bash
cmd_provider_remove() {
  local name="${1:-}"
  [[ -z "${name}" ]] && { err "usage: relay provider remove <name>"; exit 1; }
  provider_exists "${name}" || { err "Provider '${name}' not found"; exit 1; }
  printf "\n  ${YL}Delete provider '${B}${name}${R}${YL}'? (y/N) ${R}"
  read -r c
  [[ "${c}" = "y" || "${c}" = "Y" ]] || { log "cancelled"; return 0; }
  if [[ "$(active_provider_name)" == "${name}" ]]; then
    cmd_provider_off
  fi
  rm -f "$(provider_file "${name}")"
  ok "Deleted provider '${name}'"
}
```

- [ ] **Step 2: Verify manually**

```bash
export RELAY_TEST_HOME=$(mktemp -d)/relayhome
HOME="${RELAY_TEST_HOME}" bash -c '
  eval "$(sed -n "1,2402p" /Users/ds-anxing/GitHub/relay/relay)"
  cmd_provider_add mylitellm --base-url http://localhost:4000 --token sk-test
  cmd_provider_use mylitellm
  echo "y" | cmd_provider_remove mylitellm
  echo "file exists: $(provider_exists mylitellm && echo yes || echo no)"
  echo "active_provider exists: $([[ -f "${ACTIVE_PROVIDER_FILE}" ]] && echo yes || echo no)"
'
rm -rf "$(dirname "${RELAY_TEST_HOME}")"
```
Expected: `file exists: no`, `active_provider exists: no` (removing the active provider also cleared its settings.json keys via the `off` path).

- [ ] **Step 3: Commit**

```bash
cd /Users/ds-anxing/GitHub/relay
git add relay
git commit -m "$(cat <<'EOF'
feat: add relay provider remove

Runs the off cleanup first if the provider being removed is active, so
settings.json never keeps a dangling override for a deleted provider.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Mutual exclusion — clear provider state on account switch

**Files:**
- Modify: `relay:520-528` (`_do_switch_locked`)

**Interfaces:**
- Consumes: `active_provider_name` (Task 1), `_settings_env_clear` (Task 5).

- [ ] **Step 1: Add the provider-clearing step**

Current (relay:520-528):
```bash
_do_switch_locked() {
  local name="$1"
  local current; current=$(current_name)

  if [[ "${current}" == "${name}" ]]; then
    ok "Already on account '${B}${name}${R}'"
    return 0
  fi
```

New:
```bash
_do_switch_locked() {
  local name="$1"
  local current; current=$(current_name)

  if [[ -n "$(active_provider_name)" ]]; then
    _settings_env_clear
    rm -f "${ACTIVE_PROVIDER_FILE}"
  fi

  if [[ "${current}" == "${name}" ]]; then
    ok "Already on account '${B}${name}${R}'"
    return 0
  fi
```

This runs unconditionally (even in the early-return "already on this account" branch) so that switching accounts always exits provider mode, regardless of whether the underlying account selection actually changed.

- [ ] **Step 2: Verify manually**

This test needs a real account credential file (contents don't matter — `do_switch`/`_do_switch_locked` will attempt to write it to Keychain on macOS). To verify the provider-clearing behavior **without** touching the real system Keychain, stub `kc_write`/`kc_read` for the duration of the test:

```bash
export RELAY_TEST_HOME=$(mktemp -d)/relayhome
mkdir -p "${RELAY_TEST_HOME}/.claude"
printf '%s' '{"env":{"FOO":"bar"}}' > "${RELAY_TEST_HOME}/.claude/settings.json"
HOME="${RELAY_TEST_HOME}" bash -c '
  eval "$(sed -n "1,2402p" /Users/ds-anxing/GitHub/relay/relay)"
  # stub the Keychain-touching functions for this test only
  kc_write() { :; }
  kc_read() { echo "{}"; }

  cmd_provider_add mylitellm --base-url http://localhost:4000 --token sk-test
  cmd_provider_use mylitellm
  echo "before switch — active: $(active_provider_name)"

  mkdir -p "${CREDS_STORE}"
  printf "%s" "{}" > "$(account_creds work)"
  add_to_order work
  do_switch work

  echo "after switch — active: [$(active_provider_name)]"
  echo "settings.json: $(cat "${CLAUDE_SETTINGS}")"
'
rm -rf "$(dirname "${RELAY_TEST_HOME}")"
```
Expected: `before switch — active: mylitellm`, `after switch — active: []`, and `settings.json` shows `env` back to just `{"FOO": "bar"}`.

- [ ] **Step 3: Commit**

```bash
cd /Users/ds-anxing/GitHub/relay
git add relay
git commit -m "$(cat <<'EOF'
feat: clear active provider state on subscription account switch

Enforces mutual exclusion — relay <account> now always exits provider
mode (clearing settings.json's env overrides and active_provider),
even when switching to the account already recorded as current.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: `relay run <name>`

**Files:**
- Modify: `relay` — add `cmd_run()` after `cmd_provider_remove()` (Task 8).

**Interfaces:**
- Consumes: `account_exists`, `provider_exists`, `_provider_field`, `require_claude`, `do_switch`, `REAL_CLAUDE`.

- [ ] **Step 1: Add the function**

```bash
cmd_run() {
  local name="${1:-}"
  [[ -z "${name}" ]] && { err "usage: relay run <name> [-- <claude args...>]"; exit 1; }
  shift
  [[ "${1:-}" == "--" ]] && shift

  require_claude

  if account_exists "${name}"; then
    do_switch "${name}"
    exec "${REAL_CLAUDE}" "$@"
  elif provider_exists "${name}"; then
    local base_url token model discover settings_json
    base_url=$(_provider_field "${name}" base_url)
    token=$(_provider_field "${name}" auth_token)
    model=$(_provider_field "${name}" model)
    discover=$(_provider_discover "${name}")

    settings_json=$("${PY}" -c '
import json, sys
base_url, token, model, discover = sys.argv[1:5]
env = {"ANTHROPIC_BASE_URL": base_url, "ANTHROPIC_AUTH_TOKEN": token}
if model:
    env["ANTHROPIC_MODEL"] = model
if discover == "1":
    env["CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"] = "1"
print(json.dumps({"env": env}))
' "${base_url}" "${token}" "${model}" "${discover}")

    exec "${REAL_CLAUDE}" --settings "${settings_json}" "$@"
  else
    err "Unknown account or provider: ${name}"
    exit 1
  fi
}
```

Note: the provider branch never reads or writes `${CLAUDE_SETTINGS}`, `${ACTIVE_PROVIDER_FILE}`, or Keychain — this is what makes it independent of whatever `relay provider use/off` or `relay <account>` state exists globally, verified live during design (see `docs/plans/2026-07-24-litellm-provider-design.md`, "Verification performed during design").

- [ ] **Step 2: Verify the provider branch against a real stand-in proxy**

```bash
mkdir -p /tmp/relay-run-test && cd /tmp/relay-run-test
cat > fake_proxy.py <<'EOF'
import http.server, json, sys

class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        self.rfile.read(length)
        auth = self.headers.get('Authorization', '')
        print(f"HIT path={self.path} auth={auth}", file=sys.stderr, flush=True)
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({"id":"msg_test","type":"message","role":"assistant","content":[{"type":"text","text":"hello from run test"}],"model":"claude-sonnet-4-5","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}).encode())
    def log_message(self, fmt, *args):
        pass

http.server.HTTPServer(('127.0.0.1', 8935), H).serve_forever()
EOF
nohup python3 fake_proxy.py > proxy.log 2>&1 &
sleep 1

export RELAY_TEST_HOME=$(mktemp -d)/relayhome
mkdir -p "${RELAY_TEST_HOME}/.claude"
# seed a conflicting global provider override to prove `run` ignores it
printf '%s' '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:1","ANTHROPIC_AUTH_TOKEN":"wrong-token"}}' > "${RELAY_TEST_HOME}/.claude/settings.json"

HOME="${RELAY_TEST_HOME}" bash -c '
  eval "$(sed -n "1,2402p" /Users/ds-anxing/GitHub/relay/relay)"
  cmd_provider_add mylitellm --base-url http://127.0.0.1:8935 --token run-token-456
  cmd_run mylitellm -- -p "say hi"
' 2>&1

echo "=== proxy log ==="
cat proxy.log
pkill -f fake_proxy.py
rm -rf "$(dirname "${RELAY_TEST_HOME}")" /tmp/relay-run-test
```
Expected: stdout includes `hello from run test`; proxy.log shows `HIT path=/v1/messages... auth=Bearer run-token-456` — confirms `relay run <provider>` reached the right proxy with the right token, ignoring the conflicting global `settings.json` seeded beforehand.

- [ ] **Step 3: Verify dispatch resolution and passthrough args (account branch, without touching real Keychain)**

Stub both `do_switch` and `REAL_CLAUDE` so this test never touches the real Keychain or launches the real `claude`:
```bash
export RELAY_TEST_HOME=$(mktemp -d)/relayhome
mkdir -p "${RELAY_TEST_HOME}/.claude-relay/credentials"
printf '%s' '{}' > "${RELAY_TEST_HOME}/.claude-relay/credentials/work.json"

cat > /tmp/fake-claude <<'EOF'
#!/usr/bin/env bash
echo "FAKE_CLAUDE ARGS: $*"
EOF
chmod +x /tmp/fake-claude

HOME="${RELAY_TEST_HOME}" bash -c '
  eval "$(sed -n "1,2402p" /Users/ds-anxing/GitHub/relay/relay)"
  do_switch() { echo "do_switch called with: $1"; }
  REAL_CLAUDE=/tmp/fake-claude
  cmd_run work -- --resume abc123
'
rm -f /tmp/fake-claude
rm -rf "$(dirname "${RELAY_TEST_HOME}")"
```
Expected:
```
do_switch called with: work
FAKE_CLAUDE ARGS: --resume abc123
```
Confirms `cmd_run` resolves `work` as an account, calls `do_switch` before launching, and passes through only the args after `--`.

Also confirm the "neither" error path:
```bash
export RELAY_TEST_HOME=$(mktemp -d)/relayhome
HOME="${RELAY_TEST_HOME}" bash -c '
  eval "$(sed -n "1,2402p" /Users/ds-anxing/GitHub/relay/relay)"
  REAL_CLAUDE=/bin/true
  cmd_run nonexistent
  echo "exit: $?"
'
rm -rf "$(dirname "${RELAY_TEST_HOME}")"
```
Expected: `✗ Unknown account or provider: nonexistent`, `exit: 1`.

- [ ] **Step 4: Commit**

```bash
cd /Users/ds-anxing/GitHub/relay
git add relay
git commit -m "$(cat <<'EOF'
feat: add relay run for one-off account/provider launches

For an account, sugar for relay <account> + exec claude. For a
provider, uses claude --settings with an inline JSON env block —
verified immune to whatever global settings.json/active_provider
state exists, so it never disturbs (or is disturbed by) other
terminals' global switches.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Status banner on `relay status` / `relay quick`

**Files:**
- Modify: `relay` — add `_provider_banner()` near `_sync_current_creds` (currently relay:556-560, immediately before `cmd_quick`).
- Modify: `relay:563-568` (`cmd_quick`)
- Modify: `relay:609-611` (start of `_cmd_status_once`, shared by both `relay status` and `relay status -f`)

**Interfaces:**
- Consumes: `active_provider_name`, `_provider_field` (Task 1).

- [ ] **Step 1: Add the banner helper**

Insert immediately before `cmd_quick() {` (relay:563):
```bash
_provider_banner() {
  local active; active=$(active_provider_name)
  [[ -z "${active}" ]] && return 0
  local base_url; base_url=$(_provider_field "${active}" base_url)
  printf "\n  ${YL}⚡ litellm:${R} ${B}%s${R} ${D}(%s)${R}\n" "${active}" "${base_url}"
}

cmd_quick() {
```

- [ ] **Step 2: Wire into `cmd_quick`**

Current (relay:563-568):
```bash
cmd_quick() {
  _check_update_bg
  _sync_current_creds
  render_table quick "${CREDS_STORE}" "${META_STORE}" "$(current_name)" "$@"
  _show_update_notice
}
```

New:
```bash
cmd_quick() {
  _check_update_bg
  _provider_banner
  _sync_current_creds
  render_table quick "${CREDS_STORE}" "${META_STORE}" "$(current_name)" "$@"
  _show_update_notice
}
```

- [ ] **Step 3: Wire into `_cmd_status_once`**

Current (relay:609-611):
```bash
_cmd_status_once() {
  _sync_current_creds
  local current; current=$(current_name)
```

New:
```bash
_cmd_status_once() {
  _provider_banner
  _sync_current_creds
  local current; current=$(current_name)
```

- [ ] **Step 4: Verify manually**

```bash
export RELAY_TEST_HOME=$(mktemp -d)/relayhome
HOME="${RELAY_TEST_HOME}" bash -c '
  eval "$(sed -n "1,2402p" /Users/ds-anxing/GitHub/relay/relay)"
  cmd_provider_add mylitellm --base-url http://localhost:4000 --token sk-test
  cmd_provider_use mylitellm
  cmd_quick --no-usage
'
rm -rf "$(dirname "${RELAY_TEST_HOME}")"
```
Expected: `⚡ litellm: mylitellm (http://localhost:4000)` banner printed before the (empty) account table.

Also confirm no banner when no provider is active:
```bash
export RELAY_TEST_HOME=$(mktemp -d)/relayhome
HOME="${RELAY_TEST_HOME}" bash -c '
  eval "$(sed -n "1,2402p" /Users/ds-anxing/GitHub/relay/relay)"
  cmd_quick --no-usage
' | head -3
rm -rf "$(dirname "${RELAY_TEST_HOME}")"
```
Expected: no `⚡ litellm:` line anywhere in the output.

- [ ] **Step 5: Commit**

```bash
cd /Users/ds-anxing/GitHub/relay
git add relay
git commit -m "$(cat <<'EOF'
feat: show active LiteLLM provider banner in relay status/quick

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Dispatch wiring and `relay help`

**Files:**
- Modify: `relay:2404-2459` (dispatch `case` block)
- Modify: `relay:2353-2397` (`cmd_help`)

**Interfaces:**
- Consumes: `cmd_provider_add/list/use/off/remove` (Tasks 3, 4, 6, 7, 8), `cmd_run` (Task 10).

- [ ] **Step 1: Add the `provider` and `run` cases**

Current (relay:2407-2429, excerpt):
```bash
case "${CMD}" in
  "")               cmd_quick "$@" ;;
  add)              cmd_add "$@" ;;
  add-force)
    [[ -n "${1:-}" ]] && rm -f "$(account_creds "$1")" "$(account_meta "$1")"
    cmd_add "$@" ;;
  save)             cmd_save "$@" ;;
  refresh)          cmd_refresh "$@" ;;
  refresh-all)      cmd_refresh_all ;;
  switch|sw|use)
    if [[ -z "${1:-}" ]]; then cmd_quick
    elif [[ "${1}" =~ ^[0-9]+$ ]]; then
      name=$(account_by_index "$1") || { err "No account at index $1"; cmd_quick --no-usage; exit 1; }
      do_switch "${name}"
    else
      account_exists "$1" || { err "Account '$1' not found"; cmd_quick --no-usage; exit 1; }
      do_switch "$1"
    fi ;;
  list|ls)          cmd_list "$@" ;;
  status|st)        cmd_status ;;
  remove|rm|del)    cmd_remove "$@" ;;
  rename|mv)        cmd_rename "$@" ;;
  reorder)          cmd_reorder "$@" ;;
```

New (insert `provider` and `run` cases after `reorder`):
```bash
case "${CMD}" in
  "")               cmd_quick "$@" ;;
  add)              cmd_add "$@" ;;
  add-force)
    [[ -n "${1:-}" ]] && rm -f "$(account_creds "$1")" "$(account_meta "$1")"
    cmd_add "$@" ;;
  save)             cmd_save "$@" ;;
  refresh)          cmd_refresh "$@" ;;
  refresh-all)      cmd_refresh_all ;;
  switch|sw|use)
    if [[ -z "${1:-}" ]]; then cmd_quick
    elif [[ "${1}" =~ ^[0-9]+$ ]]; then
      name=$(account_by_index "$1") || { err "No account at index $1"; cmd_quick --no-usage; exit 1; }
      do_switch "${name}"
    else
      account_exists "$1" || { err "Account '$1' not found"; cmd_quick --no-usage; exit 1; }
      do_switch "$1"
    fi ;;
  list|ls)          cmd_list "$@" ;;
  status|st)        cmd_status ;;
  remove|rm|del)    cmd_remove "$@" ;;
  rename|mv)        cmd_rename "$@" ;;
  reorder)          cmd_reorder "$@" ;;
  provider|prov)
    sub="${1:-}"
    [[ -n "${1:-}" ]] && shift
    case "${sub}" in
      add)    cmd_provider_add "$@" ;;
      list|ls) cmd_provider_list ;;
      use)    cmd_provider_use "$@" ;;
      off)    cmd_provider_off ;;
      remove|rm) cmd_provider_remove "$@" ;;
      *) err "usage: relay provider <add|list|use|off|remove> ..."; exit 1 ;;
    esac ;;
  run)              cmd_run "$@" ;;
```

(The rest of the `case` block — `sessions`, `autoswitch`, `lock`, ..., the `*)` fallback — is unchanged.)

- [ ] **Step 2: Add help text**

Current (relay:2367-2369):
```bash
  printf "  %-32s %s\n" "  relay rename <old> <new>" "rename an account"
  printf "  %-32s %s\n" "  relay reorder"            "change account display/switch order"
  printf "  %-32s %s\n" "  relay list"               "full list with weekly usage"
```

New (add a line after `reorder`):
```bash
  printf "  %-32s %s\n" "  relay rename <old> <new>" "rename an account"
  printf "  %-32s %s\n" "  relay reorder"            "change account display/switch order"
  printf "  %-32s %s\n" "  relay run <name>"         "one-off session on an account or provider"
  printf "  %-32s %s\n" "  relay list"               "full list with weekly usage"
```

And add a new section — insert after the `Autoswitch` block (relay:2379-2383, right before the `Warmup` header):
```bash
  printf "  ${B}LiteLLM providers${R}\n"
  printf "  %-32s %s\n" "  relay provider add <name> --base-url <url> --token <token>" "add a provider"
  printf "  %-32s %s\n" "  relay provider list"      "list configured providers"
  printf "  %-32s %s\n" "  relay provider use <name>" "route all future sessions through this provider"
  printf "  %-32s %s\n" "  relay provider off"       "stop routing through a provider, resume subscription"
  printf "  %-32s %s\n" "  relay provider remove <name>" "delete a provider"
  echo ""
```

- [ ] **Step 3: Verify manually**

```bash
export RELAY_TEST_HOME=$(mktemp -d)/relayhome
HOME="${RELAY_TEST_HOME}" /Users/ds-anxing/GitHub/relay/relay help 2>&1 | grep -A6 "LiteLLM providers"
HOME="${RELAY_TEST_HOME}" /Users/ds-anxing/GitHub/relay/relay provider list
HOME="${RELAY_TEST_HOME}" /Users/ds-anxing/GitHub/relay/relay provider add demo --base-url http://localhost:4000 --token sk-test
HOME="${RELAY_TEST_HOME}" /Users/ds-anxing/GitHub/relay/relay provider list
HOME="${RELAY_TEST_HOME}" /Users/ds-anxing/GitHub/relay/relay provider bogus 2>&1
echo "exit: $?"
rm -rf "$(dirname "${RELAY_TEST_HOME}")"
```
Expected: help text shows the new section; `provider list` shows empty then shows `demo` after `add`; `provider bogus` prints `✗ usage: relay provider <add|list|use|off|remove> ...` with exit 1.

- [ ] **Step 4: Commit**

```bash
cd /Users/ds-anxing/GitHub/relay
git add relay
git commit -m "$(cat <<'EOF'
feat: wire relay provider and relay run into the command dispatcher

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Documentation

**Files:**
- Modify: `CLAUDE.md` (Architecture section)
- Modify: `README.md` (new subsection + Changelog entry)

**Interfaces:** none — documentation only, no behavior change.

- [ ] **Step 1: Update `CLAUDE.md`**

In the `## Architecture` bullet list (the one starting "Account display/switch order is persisted in `~/.claude-relay/order`..."), add a new bullet immediately after it:

```markdown
- LiteLLM provider mode: `~/.claude-relay/providers/<name>.json` (chmod 600, same convention as account credentials) stores `base_url`/`auth_token`/`model`/`discover_models` for each configured LiteLLM proxy. `relay provider use <name>` merges the corresponding `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_MODEL`/`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` keys into `${CLAUDE_DIR}/settings.json`'s `env` block (never the credential store) and records the active one in `~/.claude-relay/active_provider`; `relay provider off` reverses it. Mutually exclusive with subscription-account mode — switching one always clears the other's active marker. `relay run <name>` bypasses both global mechanisms for a single launch: for an account it's switch-then-exec; for a provider it uses `claude --settings '<inline JSON>'`, which is immune to concurrent global-state changes.
```

- [ ] **Step 2: Update `README.md`**

Add a new `## LiteLLM providers` section (placed after the existing account-management documentation, before `## Changelog` — check the file for the exact right spot at implementation time since its structure may have shifted). Content:

```markdown
## LiteLLM providers

Beyond subscription accounts, relay can route Claude Code through a [LiteLLM](https://docs.litellm.ai/) proxy — useful for supplementing subscription usage with other model providers.

```bash
relay provider add mylitellm --base-url http://localhost:4000 --token sk-your-litellm-key [--model claude-sonnet-4-5] [--discover-models]
relay provider list
relay provider use mylitellm   # routes every future `claude` launch through it
relay provider off             # stop routing, subscription account resumes
relay provider remove mylitellm
```

`--discover-models` lets Claude Code's `/model` picker show every model configured in your LiteLLM proxy's `config.yaml`, switchable live mid-session.

For a one-off session on a specific account or provider, without touching any global state:

```bash
relay run mylitellm -- -p "say hi"   # or any claude args
relay run work                       # same as relay work, then claude
```

Minimal LiteLLM `config.yaml`:
```yaml
model_list:
  - model_name: claude-sonnet-4-5
    litellm_params:
      model: openai/gpt-4o
      api_key: os.environ/OPENAI_API_KEY

general_settings:
  master_key: sk-your-litellm-master-key
```
```

- [ ] **Step 3: Bump version and add Changelog entry**

Per this repo's publish checklist (`CLAUDE.md`), this is a new feature → minor bump:
```bash
cd /Users/ds-anxing/GitHub/relay
npm version minor
```
This updates `package.json` and creates a git tag. Then add a `## Changelog` entry in `README.md` (find the current top entry to get the right version number and format):
```markdown
### v2.4.0 — 2026-07-24
- Add LiteLLM provider support: `relay provider add/list/use/off/remove` routes Claude Code through a LiteLLM proxy instead of a subscription account, via `${CLAUDE_DIR}/settings.json`'s env block (never touches Keychain/credentials).
- Add `relay run <name>` for a one-off session pinned to a specific account or provider, independent of any global switch.
```

- [ ] **Step 4: Verify**

```bash
grep -n "LiteLLM" /Users/ds-anxing/GitHub/relay/README.md /Users/ds-anxing/GitHub/relay/CLAUDE.md
grep -n "^version" /Users/ds-anxing/GitHub/relay/package.json
```
Expected: matches in both docs; `package.json` version bumped (e.g. `2.3.1` → `2.4.0`).

- [ ] **Step 5: Commit**

```bash
cd /Users/ds-anxing/GitHub/relay
git add CLAUDE.md README.md package.json
git commit -m "$(cat <<'EOF'
docs: document LiteLLM provider support and relay run

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

(Publishing to npm and creating the GitHub release are separate, explicit user-approved steps per this repo's publish checklist — not part of this implementation plan.)

---

## Plan self-review notes

- **Spec coverage:** every command in the design doc (`provider add/list/use/off/remove`, `run`, status banner, namespace collision guard, mutual exclusion, settings.json safety) maps to a task above (Tasks 2–12). The design doc's live `--settings` verification is re-run as Task 10's Step 2 against a fresh fake proxy, now also proving immunity to a *pre-seeded conflicting* global settings.json (stronger than the original design-time test, which only used shell-exported conflicts).
- **Known scope boundary (carried from design doc):** no `provider edit`/`update` command — change via remove + re-add.
- **Testing caution carried into this plan:** Task 9's verification stubs `kc_write`/`kc_read`, and Task 10's account-branch verification stubs `do_switch`/`REAL_CLAUDE` — both deliberately avoid ever calling the real macOS Keychain during automated verification, since that's a real system-wide side effect on the implementer's actual machine, not a sandboxed resource `HOME` override can isolate.
