#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# relay v2 — multi-account switcher for Claude Code
#   !relay          account menu + usage
#   !relay 2        switch by index
#   !relay work     switch by name
# compatible with macOS bash 3.2 / Linux / WSL
# ─────────────────────────────────────────────────────────────────────
set -u

RELAY_DIR="${HOME}/.claude-relay"
CREDS_STORE="${RELAY_DIR}/credentials"
META_STORE="${RELAY_DIR}/meta"
CURRENT_FILE="${RELAY_DIR}/current"
ORDER_FILE="${RELAY_DIR}/order"
UPDATE_CACHE="${RELAY_DIR}/.update_cache"
PROVIDERS_STORE="${RELAY_DIR}/providers"
PROXY_DIR="${RELAY_DIR}/proxy"
PROXY_LITELLM_CONFIG="${PROXY_DIR}/litellm-config.yaml"
PROXY_LITELLM_PID="${PROXY_DIR}/litellm.pid"
PROXY_LITELLM_LOG="${PROXY_DIR}/litellm.log"
PROXY_BRIDGE_CMD="${PROXY_DIR}/bridge.cmd"
PROXY_BRIDGE_PID="${PROXY_DIR}/bridge.pid"
PROXY_BRIDGE_LOG="${PROXY_DIR}/bridge.log"
CLAUDE_DIR="${HOME}/.claude"
CLAUDE_JSON="${HOME}/.claude.json"
CLAUDE_SETTINGS="${CLAUDE_DIR}/settings.json"
REAL_CLAUDE=$(command -v claude 2>/dev/null || echo "")
REAL_CODEX=$(command -v codex 2>/dev/null || echo "")
# macOS: /usr/bin/python3 uses the system TLS stack (correct certs);
# /usr/local/bin/python3 (Homebrew/standalone) often lacks bundled certs → SSL failures
if [[ "$(uname)" == "Darwin" ]] && [[ -x "/usr/bin/python3" ]]; then
  PY="/usr/bin/python3"
else
  PY=$(command -v python3 || command -v python || echo "")
fi

# Credential helpers — macOS Keychain or Linux file fallback
# Claude Code on macOS: Keychain service "Claude Code-credentials"
# Claude Code on Linux: ~/.claude/.credentials.json
CC_KC_SVC="Claude Code-credentials"
LINUX_CREDS="${CLAUDE_DIR}/.credentials.json"

kc_read() {
  if [[ "$(uname)" == "Darwin" ]]; then
    security find-generic-password -s "${CC_KC_SVC}" -a "$(whoami)" -w 2>/dev/null
  else
    [[ -f "${LINUX_CREDS}" ]] && cat "${LINUX_CREDS}" || echo ""
  fi
}

kc_write() {
  local content="$1"
  if [[ "$(uname)" == "Darwin" ]]; then
    local user; user=$(whoami)
    security delete-generic-password -s "${CC_KC_SVC}" -a "${user}" >/dev/null 2>&1 || true
    security add-generic-password -s "${CC_KC_SVC}" -a "${user}" -w "${content}" >/dev/null 2>&1
  else
    printf '%s' "${content}" > "${LINUX_CREDS}"
    chmod 600 "${LINUX_CREDS}"
  fi
}

R=$'\033[0m'; B=$'\033[1m'; D=$'\033[2m'
CY=$'\033[36m'; GR=$'\033[32m'; YL=$'\033[33m'; RD=$'\033[31m'; MG=$'\033[35m'

log()  { printf "  ${CY}→${R} %s\n" "$*"; }
ok()   { printf "  ${GR}✓${R} %s\n" "$*"; }
warn() { printf "  ${YL}⚠${R} %s\n" "$*"; }
err()  { printf "  ${RD}✗${R} %s\n" "$*" >&2; }
hdr()  { printf "\n${B}${MG}  %s${R}\n  ${D}─────────────────────────────────────${R}\n" "$*"; }

with_credential_lock() (
  # Subshell confines descriptors and traps; the callback only changes files.
  local lockfile="${RELAY_DIR}/credential.lock"
  local lockdir holder_pid="" status ready="" timeout="${RELAY_LOCK_TIMEOUT_SECONDS:-30}"
  case "${timeout}" in ''|*[!0-9]*) err "Invalid credential lock timeout"; return 1 ;; esac
  [[ "${timeout}" -ge 1 && "${timeout}" -le 300 ]] || { err "Invalid credential lock timeout"; return 1; }
  lockdir=$(mktemp -d "${TMPDIR:-/tmp}/relay-lock.XXXXXXXX") || { err "Cannot create credential lock directory"; return 1; }
  trap 'if [[ -n "${holder_pid}" ]]; then kill "${holder_pid}" 2>/dev/null || true; wait "${holder_pid}" 2>/dev/null || true; fi; rm -f "${lockdir}/ready" "${lockdir}/release"; rmdir "${lockdir}" 2>/dev/null || true' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP
  mkfifo "${lockdir}/ready" "${lockdir}/release" || { err "Cannot create credential lock pipes"; return 1; }
  # RDWR opens do not block if the holder fails before opening its ends.
  exec 3<> "${lockdir}/ready" 4<> "${lockdir}/release" || return 1
  _relay_credential_holder "${lockfile}" "${lockdir}/ready" "${lockdir}/release" 3>&- 4>&- &
  holder_pid=$!
  if ! IFS= read -r -t "${timeout}" ready <&3 || [[ "${ready}" != ready ]] || ! kill -0 "${holder_pid}" 2>/dev/null; then
    err "Credential lock unavailable or timed out; operation cancelled"
    return 1
  fi
  "$@"
  status=$?
  # Cleanup terminates the holder even if it failed or stopped reading.
  return "${status}"
)

mkdir -p "${CREDS_STORE}" "${META_STORE}" "${PROVIDERS_STORE}" "${CLAUDE_DIR}" "${PROXY_DIR}"
chmod 700 "${RELAY_DIR}" "${CREDS_STORE}" "${PROVIDERS_STORE}" "${PROXY_DIR}" 2>/dev/null || true

[[ -z "${PY}" && -z "${RELAY_CORE_BIN:-}" ]] && { err "python3 is required without Rust core"; exit 1; }
