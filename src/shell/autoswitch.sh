
AUTOSWITCH_DAEMON="${RELAY_DIR}/autoswitch-daemon.py"
[[ -n "${RELAY_CORE_BIN:-}" ]] && AUTOSWITCH_DAEMON="${RELAY_DIR}/autoswitch-daemon.sh"
AUTOSWITCH_PLIST="${HOME}/Library/LaunchAgents/com.relay.autoswitch.plist"
AUTOSWITCH_SERVICE="${HOME}/.config/systemd/user/relay-autoswitch.service"

_extract_daemon() {
  local tmp; tmp=$(mktemp "${AUTOSWITCH_DAEMON}.new.XXXXXX") || return 1
  if [[ -n "${RELAY_CORE_BIN:-}" ]]; then
    # Immutable copied core: wrapper rollback retains the prior executable.
    local core_copy; core_copy=$(mktemp "${RELAY_DIR}/autoswitch-core.XXXXXXXX") || { rm -f "${tmp}"; return 1; }
    if ! cp "${RELAY_CORE_BIN}" "${core_copy}" || ! chmod 755 "${core_copy}"; then
      rm -f "${tmp}" "${core_copy}"; return 1
    fi
    printf '#!/usr/bin/env bash\nexec %q daemon\n' "${core_copy}" > "${tmp}"
  else
  cat > "${tmp}" <<'DAEMON_EOF'
{{python:autoswitch_daemon.py}}
DAEMON_EOF
  fi
  local status=$?
  if [[ ${status} -ne 0 ]] || ! chmod 755 "${tmp}" || ! mv "${tmp}" "${AUTOSWITCH_DAEMON}"; then
    rm -f "${tmp}"
    return 1
  fi
  _read_version > "${RELAY_DIR}/daemon_version"
}

# Restarts the already-installed daemon service in place (launchd/systemd/cron),
# without touching plist/service file contents. Used after a silent redeploy.
_restart_daemon_service() {
  if [[ "$(uname)" == "Darwin" ]] && [[ -f "${AUTOSWITCH_PLIST}" ]]; then
    launchctl unload "${AUTOSWITCH_PLIST}" 2>/dev/null || true
    launchctl load "${AUTOSWITCH_PLIST}"
  elif command -v systemctl >/dev/null 2>&1 && [[ -f "${AUTOSWITCH_SERVICE}" ]]; then
    systemctl --user restart relay-autoswitch
  else
    # cron fallback: no long-lived unit to restart — kill the running instance so
    # the next cron tick (daemon's own lock file) starts a fresh copy of the file
    # we just wrote via _extract_daemon.
    local pid; pid=$(cat "${RELAY_DIR}/autoswitch.lock" 2>/dev/null || echo "")
    [[ -n "${pid}" ]] && kill "${pid}" 2>/dev/null || true
  fi
}

# Runs on every invocation (cheap no-op unless autoswitch is actually running):
# if relay itself was updated (npm/git/direct) since the daemon file on disk was
# generated, silently regenerate it from the current script and restart it —
# so daemon-side fixes (warmup engine, credential lock, etc.) don't require the
# user to remember to run `relay autoswitch start` again after every update.
_maybe_redeploy_daemon() {
  # Core migration is explicit via autoswitch start; never silently repoint a
  # running Python service during a development-mode command.
  [[ -n "${RELAY_CORE_BIN:-}" ]] && return 0
  [[ -f "${AUTOSWITCH_DAEMON}" ]] || return 0
  local pid; pid=$(cat "${RELAY_DIR}/autoswitch.lock" 2>/dev/null || echo "")
  [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null || return 0

  local deployed; deployed=$(cat "${RELAY_DIR}/daemon_version" 2>/dev/null || echo "")
  local current; current=$(_read_version)
  [[ "${current}" == "unknown" ]] && return 0
  [[ "${deployed}" == "${current}" ]] && return 0

  local backup; backup=$(mktemp "${AUTOSWITCH_DAEMON}.backup.XXXXXX") || return 1
  cp -p "${AUTOSWITCH_DAEMON}" "${backup}" || { rm -f "${backup}"; return 1; }
  if ! _extract_daemon || ! _restart_daemon_service; then
    if mv "${backup}" "${AUTOSWITCH_DAEMON}"; then
      printf '%s\n' "${deployed}" > "${RELAY_DIR}/daemon_version"
      _restart_daemon_service >/dev/null 2>&1 || true
      err "Daemon redeploy failed; previous deployment restored. Check relay autoswitch status."
    else
      err "Daemon redeploy failed; could not restore ${backup}"
    fi
    return 1
  fi
  rm -f "${backup}"
  warn "relay updated to ${current} — autoswitch daemon redeployed and restarted"
}

cmd_autoswitch_config() {
  hdr "autoswitch — configure"

  local accounts=()
  local name
  while IFS= read -r name; do accounts+=("${name}"); done < <(list_account_names)

  if [[ ${#accounts[@]} -eq 0 ]]; then
    err "No accounts found. Run: relay add <name>"
    exit 1
  fi

  # ── Step 1: switch order ───────────────────────────────────────
  echo ""
  printf "  ${B}Step 1 / 3 — Switch order${R}\n"
  local order_str; order_str=$(prompt_reorder "${accounts[@]}") || return $?

  # ── Step 2: thresholds ────────────────────────────────────────
  echo ""
  printf "  ${B}Step 2 / 3 — Thresholds${R}\n"
  printf "  ${D}Autoswitch triggers when an account's 5-hr usage exceeds this %%.${R}\n"
  printf "  ${D}Enter a number (e.g. 70), or press Enter for default 80%%.${R}\n\n"

  local thresholds_json="{"
  local order_json="["
  local first=1
  IFS=',' read -ra order_arr <<< "${order_str}"
  for acct in "${order_arr[@]}"; do
    printf "  ${CY}%s${R} threshold [80%%]: " "${acct}"
    read -r val
    [[ -z "${val}" ]] && val="80"
    [[ ${first} -eq 0 ]] && { order_json+=","; thresholds_json+=","; }
    order_json+="\"${acct}\""
    thresholds_json+="\"${acct}\":${val}"
    first=0
  done
  order_json+="]"
  thresholds_json+="}"

  # ── Step 3: poll interval ─────────────────────────────────────
  echo ""
  printf "  ${B}Step 3 / 3 — Check interval${R}\n"
  printf "  ${D}How often the daemon checks usage. Switches to faster polling near the threshold.${R}\n\n"
  printf "  Normal check every N minutes [10]: "; read -r low_min; low_min="${low_min:-10}"
  printf "  Fast check every N minutes   [2]:  "; read -r high_min; high_min="${high_min:-2}"
  printf "  Switch to fast polling at    [50%%]: "; read -r high_thr; high_thr="${high_thr:-50}"

  local cfg_file="${RELAY_DIR}/autoswitch.json"
  printf '{"order":%s,"thresholds":%s,"poll":{"low_minutes":%s,"high_minutes":%s,"high_threshold":%s}}' \
    "${order_json}" "${thresholds_json}" "${low_min}" "${high_min}" "${high_thr}" \
    | _relay_data config-save "${cfg_file}" || return $?

  echo ""
  ok "Config saved to ${cfg_file}"
  echo ""
  _relay_data autoswitch-config-summary "${cfg_file}" || return $?
  echo ""
  log "Run ${CY}relay autoswitch start${R} to activate"
}

cmd_autoswitch_start() {
  [[ -f "${RELAY_DIR}/autoswitch.json" ]] || {
    err "No config found. Run: relay autoswitch config"
    exit 1
  }

  hdr "autoswitch — start"
  if [[ -n "${REAL_CLAUDE}" && "${REAL_CLAUDE}" != "$0" ]]; then
    echo "${REAL_CLAUDE}" > "${RELAY_DIR}/claude_bin"
  elif [[ -z "${REAL_CLAUDE}" ]]; then
    warn "claude not found; warmup will fall back to daemon PATH lookup and may fail"
  else
    warn "claude resolves to relay wrapper; warmup will fall back to daemon PATH lookup and may fail"
  fi

  _extract_daemon || { err "Could not deploy autoswitch daemon"; return 1; }
  log "Daemon extracted to ${AUTOSWITCH_DAEMON}"

  local py; py=$(command -v python3 || command -v python || echo "")
  [[ -n "${RELAY_CORE_BIN:-}" ]] && py="/bin/bash"
  [[ -z "${py}" ]] && { err "python3 required"; exit 1; }

  if [[ "$(uname)" == "Darwin" ]]; then
    mkdir -p "${HOME}/Library/LaunchAgents"
    cat > "${AUTOSWITCH_PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.relay.autoswitch</string>
    <key>ProgramArguments</key>
    <array>
        <string>${py}</string>
        <string>${AUTOSWITCH_DAEMON}</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>${RELAY_DIR}/autoswitch-daemon.log</string>
    <key>StandardErrorPath</key><string>${RELAY_DIR}/autoswitch-daemon.log</string>
</dict>
</plist>
PLIST
    launchctl unload "${AUTOSWITCH_PLIST}" 2>/dev/null || true
    launchctl load "${AUTOSWITCH_PLIST}"
    ok "Daemon started via launchd"

  elif command -v systemctl >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
    mkdir -p "${HOME}/.config/systemd/user"
    cat > "${AUTOSWITCH_SERVICE}" <<SVCEOF
[Unit]
Description=relay autoswitch daemon

[Service]
ExecStart="${py}" "${AUTOSWITCH_DAEMON}"
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
SVCEOF
    systemctl --user daemon-reload
    systemctl --user enable --now relay-autoswitch
    ok "Daemon started via systemd"

  else
    # ponytail: cron fallback — daemon's lock file prevents overlap
    local cron_entry="*/2 * * * * ${py} ${AUTOSWITCH_DAEMON}"
    ( crontab -l 2>/dev/null | grep -v "autoswitch-daemon"; echo "${cron_entry}" ) | crontab -
    ok "Daemon scheduled via cron (every 2 min)"
    warn "For persistent autoswitch, install systemd or use macOS"
  fi

  log "Run ${CY}relay autoswitch status${R} to verify"
}

cmd_autoswitch_stop() {
  hdr "autoswitch — stop"

  if [[ "$(uname)" == "Darwin" ]] && [[ -f "${AUTOSWITCH_PLIST}" ]]; then
    launchctl unload "${AUTOSWITCH_PLIST}" 2>/dev/null || true
    rm -f "${AUTOSWITCH_PLIST}"
    ok "Removed launchd job"

  elif command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now relay-autoswitch 2>/dev/null || true
    rm -f "${AUTOSWITCH_SERVICE}"
    systemctl --user daemon-reload
    ok "Removed systemd service"

  else
    crontab -l 2>/dev/null | grep -v "autoswitch-daemon" | crontab -
    ok "Removed cron entry"
  fi

  local pid; pid=$(cat "${RELAY_DIR}/autoswitch.lock" 2>/dev/null || echo "")
  if [[ -n "${pid}" ]]; then
    kill "${pid}" 2>/dev/null || true
  fi
  rm -f "${RELAY_DIR}/autoswitch.lock"
  ok "Daemon stopped"
}

cmd_autoswitch_status() {
  _check_update_bg
  hdr "autoswitch — status"

  local pid; pid=$(cat "${RELAY_DIR}/autoswitch.lock" 2>/dev/null || echo "")
  if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
    printf "  ${B}Daemon:${R}  ${GR}● running${R}  (pid ${pid})\n"
  else
    printf "  ${B}Daemon:${R}  ${D}○ stopped${R}\n"
  fi

  local cfg="${RELAY_DIR}/autoswitch.json"
  if [[ ! -f "${cfg}" ]]; then
    warn "No config. Run: relay autoswitch config"
    _show_update_notice
    return 0
  fi

  printf "  ${B}Config:${R}  ${D}%s${R}\n\n" "${cfg}"

  local current; current=$(current_name)

  _relay_data autoswitch-status "${cfg}" "${current}" || return $?

  echo ""
  printf "  ${D}────────────────────────────────────────${R}\n"
  printf "  %-34s %s\n" "  ${CY}relay autoswitch start${R}"  "start daemon"
  printf "  %-34s %s\n" "  ${CY}relay autoswitch stop${R}"   "stop daemon"
  printf "  %-34s %s\n" "  ${CY}relay autoswitch config${R}" "edit settings"
  printf "  %-34s %s\n" "  ${CY}relay autoswitch log${R}"    "switch history"
  printf "  %-34s %s\n" "  ${CY}relay lock <name>${R}"       "lock account (skip when over threshold)"
  printf "  %-34s %s\n" "  ${CY}relay unlock <name>${R}"     "remove lock"
  _show_update_notice
}

cmd_autoswitch_log() {
  _check_update_bg
  local log_file="${RELAY_DIR}/autoswitch.log"
  [[ -f "${log_file}" ]] || { warn "No log yet"; _show_update_notice; return 0; }

  hdr "autoswitch — log (last 20 events)"
  _relay_data autoswitch-log "${log_file}" || return $?
  _show_update_notice
}

cmd_autoswitch() {
  local sub="${1:-}"; [[ $# -gt 0 ]] && shift
  case "${sub}" in
    config)  cmd_autoswitch_config ;;
    start)   cmd_autoswitch_start ;;
    stop)    cmd_autoswitch_stop ;;
    status)  cmd_autoswitch_status ;;
    log)     cmd_autoswitch_log ;;
    *)
      if [[ ! -f "${RELAY_DIR}/autoswitch.json" ]]; then
        cmd_autoswitch_config
      else
        cmd_autoswitch_status
      fi
      ;;
  esac
}
