_proxy_pidfile() {
  case "$1" in
    litellm) echo "${PROXY_LITELLM_PID}" ;;
    bridge)  echo "${PROXY_BRIDGE_PID}" ;;
    *) err "unknown proxy '$1' — expected 'litellm' or 'bridge'"; exit 1 ;;
  esac
}

_proxy_logfile() {
  case "$1" in
    litellm) echo "${PROXY_LITELLM_LOG}" ;;
    bridge)  echo "${PROXY_BRIDGE_LOG}" ;;
    *) err "unknown proxy '$1' — expected 'litellm' or 'bridge'"; exit 1 ;;
  esac
}

_proxy_pid_alive() {
  local pidfile; pidfile=$(_proxy_pidfile "$1")
  [[ -f "${pidfile}" ]] || return 1
  local pid; pid=$(cat "${pidfile}" 2>/dev/null)
  [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null
}

cmd_proxy_init() {
  if [[ -f "${PROXY_LITELLM_CONFIG}" ]]; then
    warn "Config already exists: ${PROXY_LITELLM_CONFIG}"
    log "Edit it directly, or delete it and re-run 'relay proxy init' to regenerate."
    return 0
  fi

  local example_name example_base_url example_model
  example_name=$(list_provider_names | head -1)
  if [[ -n "${example_name}" ]]; then
    example_base_url=$(_provider_field "${example_name}" base_url)
    example_model=$(_provider_field "${example_name}" model)
    [[ -z "${example_model}" ]] && example_model="pinned-model-alias"
  else
    example_name="my-provider"
    example_base_url="https://your-gateway.example.com"
    example_model="pinned-model-alias"
  fi

  cat > "${PROXY_LITELLM_CONFIG}" <<EOF
# relay proxy — local LiteLLM config template.
# This file is scaffolded once by 'relay proxy init' and never overwritten
# automatically — edit it directly for your own setup.
#
# Start it with: relay proxy start litellm
# Stop it with:  relay proxy stop litellm

model_list:
  - model_name: ${example_name}
    litellm_params:
      model: openai/${example_model}
      api_base: ${example_base_url}
      api_key: os.environ/RELAY_PROXY_${example_name//-/_}_KEY

# ─────────────────────────────────────────────────────────────────
# WARNING: adding a "chatgpt" (ChatGPT/Codex subscription) provider
# entry below reuses your personal OpenAI/ChatGPT login session as an
# API credential. Doing so may violate OpenAI's Terms of Service for
# your account (account suspension has been reported for this kind of
# use) — this is your decision to make, not something relay sets up
# for you. See LiteLLM's own docs for the provider's config keys:
# https://docs.litellm.ai/docs/providers/chatgpt
#
# - model_name: codex-subscription
#   litellm_params:
#     model: chatgpt/<model>
#     # ... additional chatgpt-provider keys per LiteLLM's docs go here
# ─────────────────────────────────────────────────────────────────
EOF
  chmod 600 "${PROXY_LITELLM_CONFIG}"
  ok "Wrote template: ${PROXY_LITELLM_CONFIG}"
  log "Edit it to add real providers/keys, then: relay proxy start litellm"
}

cmd_proxy_start() {
  local name="${1:-}"
  shift || true
  case "${name}" in
    litellm)
      require_litellm
      [[ -f "${PROXY_LITELLM_CONFIG}" ]] || { err "No config found — run 'relay proxy init' first"; exit 1; }
      if _proxy_pid_alive litellm; then
        warn "litellm is already running (pid $(cat "${PROXY_LITELLM_PID}"))"
        return 0
      fi
      local port=4000
      [[ "${1:-}" == "--port" ]] && { port="${2:-4000}"; }
      nohup litellm --config "${PROXY_LITELLM_CONFIG}" --port "${port}" > "${PROXY_LITELLM_LOG}" 2>&1 &
      disown
      echo $! > "${PROXY_LITELLM_PID}"
      ok "Started litellm on port ${port} (pid $(cat "${PROXY_LITELLM_PID}")) — log: ${PROXY_LITELLM_LOG}"
      ;;
    bridge)
      [[ -f "${PROXY_BRIDGE_CMD}" ]] || { err "No bridge command registered — run: relay proxy bridge set-command '<cmd>'"; exit 1; }
      if _proxy_pid_alive bridge; then
        warn "bridge is already running (pid $(cat "${PROXY_BRIDGE_PID}"))"
        return 0
      fi
      nohup bash -c "$(cat "${PROXY_BRIDGE_CMD}")" > "${PROXY_BRIDGE_LOG}" 2>&1 &
      disown
      echo $! > "${PROXY_BRIDGE_PID}"
      ok "Started bridge (pid $(cat "${PROXY_BRIDGE_PID}")) — log: ${PROXY_BRIDGE_LOG}"
      ;;
    *) err "usage: relay proxy start <litellm|bridge>"; exit 1 ;;
  esac
}

cmd_proxy_stop() {
  local name="${1:-}"
  case "${name}" in
    litellm|bridge) ;;
    *) err "usage: relay proxy stop <litellm|bridge>"; exit 1 ;;
  esac
  local pidfile; pidfile=$(_proxy_pidfile "${name}")
  if ! _proxy_pid_alive "${name}"; then
    warn "${name} is not running"
    rm -f "${pidfile}"
    return 0
  fi
  kill "$(cat "${pidfile}")" 2>/dev/null
  rm -f "${pidfile}"
  ok "Stopped ${name}"
}

cmd_proxy_status() {
  local names="${1:-litellm bridge}"
  local name
  for name in ${names}; do
    if _proxy_pid_alive "${name}"; then
      printf "    %-10s ${GR}running${R}  ${D}pid $(cat "$(_proxy_pidfile "${name}")")${R}\n" "${name}"
    else
      printf "    %-10s ${D}stopped${R}\n" "${name}"
    fi
  done
}

cmd_proxy_log() {
  local name="${1:-}"
  case "${name}" in
    litellm|bridge) ;;
    *) err "usage: relay proxy log <litellm|bridge>"; exit 1 ;;
  esac
  local logfile; logfile=$(_proxy_logfile "${name}")
  [[ -f "${logfile}" ]] || { err "No log file yet: ${logfile}"; exit 1; }
  tail -f "${logfile}"
}

cmd_proxy_bridge_set_command() {
  local cmd="${1:-}"
  [[ -z "${cmd}" ]] && { err "usage: relay proxy bridge set-command '<shell command>'"; exit 1; }
  printf '%s' "${cmd}" > "${PROXY_BRIDGE_CMD}"
  chmod 600 "${PROXY_BRIDGE_CMD}"
  ok "Bridge command registered — start it with: relay proxy start bridge"
}

