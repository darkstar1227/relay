cmd_quick() {
  _check_update_bg
  _sync_current_creds
  render_table quick "${CREDS_STORE}" "${META_STORE}" "$(current_name)" "$@"
  _show_update_notice
}

cmd_list() {
  # -f / --follow: live-refresh mode
  local follow=0
  local passthrough=()
  for arg in "$@"; do
    if [[ "${arg}" == "-f" || "${arg}" == "--follow" ]]; then
      follow=1
    else
      passthrough+=("${arg}")
    fi
  done

  if [[ "${follow}" -eq 1 ]]; then
    local interval=30
    trap 'tput cnorm 2>/dev/null; printf "\n  \033[2mExited relay list -f\033[0m\n\n"; exit 0' INT TERM
    tput civis 2>/dev/null || true
    while true; do
      printf '\033[2J\033[H'
      hdr "Account List"
      printf "  ${D}live · refreshes every ${interval}s · Ctrl+C to exit${R}\n\n"
      _sync_current_creds
      render_table full "${CREDS_STORE}" "${META_STORE}" "$(current_name)" "${passthrough[@]+"${passthrough[@]}"}"
      echo ""
      ok "Inside Claude Code: ${CY}!relay <index>${R} to switch"
      printf "\n  ${D}updated $(date '+%H:%M:%S')${R}\n"
      sleep "${interval}"
    done
    return
  fi

  _check_update_bg
  hdr "Account List"
  _sync_current_creds
  render_table full "${CREDS_STORE}" "${META_STORE}" "$(current_name)" "$@"
  echo ""
  ok "Inside Claude Code: ${CY}!relay <index>${R} to switch"
  _show_update_notice
}

_cmd_status_once() {
  _sync_current_creds
  local current; current=$(current_name)
  hdr "Current Status"
  if [[ -z "${current}" ]]; then
    warn "No account set (using system default)"
  elif ! account_exists "${current}"; then
    warn "Recorded account '${current}' no longer exists"
  else
    _relay_data status-once "$(account_creds "${current}")" "${current}" "$(get_meta_email "${current}")" || return $?
  fi
  local n=0
  [[ -d "${CLAUDE_DIR}/projects" ]] && \
    n=$(find "${CLAUDE_DIR}/projects" -name "*.jsonl" 2>/dev/null | wc -l | tr -d ' ')
  printf "\n  ${B}Sessions:${R} %s (shared across all accounts in ~/.claude/projects/)\n" "${n}"
}

cmd_status() {
  local follow=0
  for arg in "$@"; do
    [[ "${arg}" == "-f" || "${arg}" == "--follow" ]] && follow=1
  done

  if [[ "${follow}" -eq 1 ]]; then
    local interval=30
    trap 'tput cnorm 2>/dev/null; printf "\n  \033[2mExited relay status -f\033[0m\n\n"; exit 0' INT TERM
    tput civis 2>/dev/null || true
    while true; do
      printf '\033[2J\033[H'
      printf "  ${D}live · refreshes every ${interval}s · Ctrl+C to exit${R}\n\n"
      _cmd_status_once
      printf "\n  ${D}updated $(date '+%H:%M:%S')${R}\n"
      sleep "${interval}"
    done
    return
  fi

  _cmd_status_once
  _check_update_bg
  _show_update_notice

  # Warmup health (only prints when relevant — silent otherwise)
  if [[ -f "${RELAY_DIR}/autoswitch.json" ]] && [[ -f "${RELAY_DIR}/autoswitch.log" ]]; then
    _relay_data warmup-health "${RELAY_DIR}/autoswitch.json" "${RELAY_DIR}/autoswitch.log"
  fi
}
