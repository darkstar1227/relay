
cmd_provider_add() {
  local name="${1:-}"
  [[ -z "${name}" ]] && { err "usage: relay provider add <name> --base-url <url> --token <token> [--model <model>] [--subagent-model <model>] [--no-discover-models] [--codex]"; exit 1; }
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

  # Discovery defaults on: without a pinned --model there's nothing else to
  # route with, and with one it's still useful for `relay provider list` /
  # future switches, so opt-out (--no-discover-models) rather than opt-in.
  local base_url="" token="" model="" subagent_model="" discover=1 agent="claude"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --base-url) base_url="${2:-}"; shift 2 ;;
      --token) token="${2:-}"; shift 2 ;;
      --model) model="${2:-}"; shift 2 ;;
      --subagent-model) subagent_model="${2:-}"; shift 2 ;;
      --discover-models) discover=1; shift ;;
      --no-discover-models) discover=0; shift ;;
      --codex) agent="codex"; shift ;;
      *) err "unknown option: $1"; exit 1 ;;
    esac
  done

  [[ -z "${base_url}" ]] && { err "--base-url is required"; exit 1; }
  [[ -z "${token}" ]] && { err "--token is required"; exit 1; }
  case "${base_url}" in
    http://*|https://*) ;;
    *) err "--base-url must start with http:// or https://"; exit 1 ;;
  esac

  # Codex CLI has no gateway-model-discovery equivalent — it always needs an
  # explicit model, and CLAUDE_CODE_SUBAGENT_MODEL is a Claude-Code-only concept.
  if [[ "${agent}" == "codex" ]]; then
    if [[ -z "${model}" ]]; then
      err "--codex requires --model <model> — Codex CLI has no model-discovery fallback"
      exit 1
    fi
    if [[ "${discover}" == "1" ]]; then
      warn "--discover-models has no effect with --codex (no gateway model discovery in Codex) — ignoring"
      discover=0
    fi
    if [[ -n "${subagent_model}" ]]; then
      warn "--subagent-model has no effect with --codex (Claude-Code-only) — ignoring"
      subagent_model=""
    fi
  fi

  RELAY_PROVIDER_PATH="$(provider_file "${name}")" \
  RELAY_PROVIDER_BASE_URL="${base_url}" \
  RELAY_PROVIDER_TOKEN="${token}" \
  RELAY_PROVIDER_MODEL="${model}" \
  RELAY_PROVIDER_SUBAGENT_MODEL="${subagent_model}" \
  RELAY_PROVIDER_DISCOVER="${discover}" \
  RELAY_PROVIDER_AGENT="${agent}" \
  _relay_data provider-add || return $?

  ok "Provider '${B}${name}${R}' added  ${D}${base_url}${R}"
}

cmd_provider_list() {
  hdr "LiteLLM providers"
  local names; names=$(list_provider_names)
  if [[ -z "${names}" ]]; then
    warn "No providers configured — add one with: relay provider add <name> --base-url <url> --token <token>"
    return 0
  fi
  local name base_url model subagent_model agent info
  while IFS= read -r name; do
    [[ -z "${name}" ]] && continue
    base_url=$(_provider_field "${name}" base_url) || return $?
    model=$(_provider_field "${name}" model) || return $?
    subagent_model=$(_provider_field "${name}" subagent_model) || return $?
    agent=$(_provider_field "${name}" agent) || return $?
    info="${base_url}"
    [[ -n "${model}" ]] && info="${info}  model=${model}"
    [[ -n "${subagent_model}" ]] && info="${info}  subagent_model=${subagent_model}"
    [[ "${agent}" == "codex" ]] && info="${info}  agent=codex"
    printf "    %-16s ${D}%s${R}\n" "${name}" "${info}"
  done <<< "${names}"
}

cmd_provider_codex_models() {
  local name="${1:-}"
  [[ -z "${name}" ]] && { err "usage: relay provider codex-models <name> [model1,model2,...]"; exit 1; }
  shift
  provider_exists "${name}" || { err "Provider '${name}' not found"; exit 1; }

  local csv="${1:-}"
  if [[ -z "${csv}" ]]; then
    local list; list=$(_relay_data codex-models-get "$(provider_file "${name}")") || return $?
    if [[ -z "${list}" ]]; then
      warn "Provider '${name}' has no codex_models set"
      log "Set one with: relay provider codex-models ${name} model-a,model-b,model-c"
    else
      printf '%s\n' "${list//,/$'\n'}"
    fi
    return 0
  fi

  _relay_data codex-models-set "$(provider_file "${name}")" "${csv}" || return $?
  ok "Provider '${B}${name}${R}' codex_models set — 'relay run ${name} --codex' rotates through them on each call"
}

cmd_provider_remove() {
  local name="${1:-}"
  [[ -z "${name}" ]] && { err "usage: relay provider remove <name>"; exit 1; }
  provider_exists "${name}" || { err "Provider '${name}' not found"; exit 1; }
  printf "\n  ${YL}Delete provider '${B}${name}${R}${YL}'? (y/N) ${R}"
  read -r c
  [[ "${c}" = "y" || "${c}" = "Y" ]] || { log "cancelled"; return 0; }
  rm -f "$(provider_file "${name}")"
  ok "Deleted provider '${name}'"
}

# ══════════════════════════════════════════════════════════════════
# Local proxies — manual-only process supervision (LiteLLM + a
# user-supplied "bridge" command). Never started by the autoswitch
# daemon or any other relay command — only `relay proxy start ...`
# launches these, and they do not survive reboot (no launchd/systemd
# registration). Relay supervises the bridge process but does not
# implement or ship any token-bridging logic itself — that command is
# entirely user-supplied via `relay proxy bridge set-command`.
# ══════════════════════════════════════════════════════════════════
