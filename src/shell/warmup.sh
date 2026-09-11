
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
    _relay_data warmup-ensure-config "${CREDS_STORE}" "${cfg}" || return $?
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

  _warmup_ensure_config || return $?
  local cfg="${RELAY_DIR}/autoswitch.json"

  _relay_data warmup-add "${cfg}" "${name}" "${hhmm}" || return $?

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

  local removed
  if ! removed=$(_relay_data warmup-remove "${cfg}" "${name}" "${hhmm}"); then
    err "Failed to remove warmup entries for '${name}'"
    return 1
  fi
  if [[ "${removed}" -eq 0 ]]; then
    if [[ -n "${hhmm}" ]]; then
      warn "No warmup entries for '${name}' at ${hhmm}"
    else
      warn "No warmup entries for '${name}'"
    fi
    return 0
  fi
  ok "Removed warmup entries for '${name}'"
}

cmd_warmup_list() {
  local cfg="${RELAY_DIR}/autoswitch.json"
  hdr "warmup"

  if _warmup_daemon_running; then :; else
    printf "  ${YL}daemon: not running${R} — run 'relay autoswitch start'\n"
  fi

  [[ -f "${cfg}" ]] || { warn "No warmup entries. Run: relay warmup add <account> <HH:MM>"; return 0; }

  _relay_data warmup-list "${cfg}" "${RELAY_DIR}/warmup_state.json"
}

cmd_warmup_pause() {
  _warmup_ensure_config || return $?
  local cfg="${RELAY_DIR}/autoswitch.json"
  _relay_data warmup-pause "${cfg}" || return $?
  ok "warmup paused — entries kept, run 'relay warmup resume' to re-enable"
}

cmd_warmup_resume() {
  local cfg="${RELAY_DIR}/autoswitch.json"
  [[ -f "${cfg}" ]] || { err "No warmup config. Run: relay warmup add <account> <HH:MM> first"; exit 1; }
  _relay_data warmup-resume "${cfg}" || return $?
  ok "warmup resumed"
}

cmd_warmup_test() {
  local name="${1:-}"
  [[ -z "${name}" ]] && { err "usage: relay warmup test <account>"; exit 1; }
  account_exists "${name}" || { err "Account '${name}' not found"; exit 1; }
  hdr "warmup — test"
  log "Switching to '${name}', pinging, then restoring your current account..."
  _relay_data warmup-test "${name}" || return $?
  warn "relay warmup test requires the daemon module — run this from an environment where the daemon has been extracted (relay autoswitch start at least once), then re-run this command."
}
