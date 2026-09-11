_run_history_dir() { printf '%s/run-history' "${RELAY_DIR}"; }

# Per-directory "last name run here" pointer so `relay run -c`/`--resume` can
# replay the same account/provider without retyping it — a crashed or
# Ctrl-C'd `relay run <provider>` has no other record of what backend that
# session used, since exec replaces the process before any trap could fire.
_run_history_key() { printf '%s' "${PWD}" | cksum | awk '{print $1}'; }

_run_record_last() {
  mkdir -p "$(_run_history_dir)"
  printf '%s' "$1" > "$(_run_history_dir)/$(_run_history_key)"
}

_run_last_name_for_cwd() {
  local f; f="$(_run_history_dir)/$(_run_history_key)"
  [[ -f "${f}" ]] && cat "${f}"
}

cmd_run() {
  local name="${1:-}"
  [[ -z "${name}" ]] && { err "usage: relay run <name> [--codex|--claude] [-- <args...>]"; exit 1; }

  case "${name}" in
    -c|--continue|-r|--resume)
      # Reuse the last account/provider run from this directory; leave "$@"
      # untouched so -c/--resume (and any session id after it) still reach claude.
      name=$(_run_last_name_for_cwd)
      [[ -z "${name}" ]] && { err "No previous 'relay run <name>' recorded for this directory — run 'relay run <name>' once first"; exit 1; }
      ;;
    *)
      shift
      ;;
  esac

  local agent_override=""
  case "${1:-}" in
    --codex) agent_override="codex"; shift ;;
    --claude) agent_override="claude"; shift ;;
  esac
  [[ "${1:-}" == "--" ]] && shift

  if account_exists "${name}"; then
    if [[ "${agent_override}" == "codex" ]]; then
      err "'${name}' is an account (Claude OAuth credential) — --codex is not valid for accounts"
      exit 1
    fi
    require_claude
    _run_record_last "${name}"
    do_switch "${name}"
    exec "${REAL_CLAUDE}" "$@"
  elif provider_exists "${name}"; then
    local agent="${agent_override}"
    if [[ -z "${agent}" ]]; then
      agent=$(_provider_field "${name}" agent) || return $?
    fi
    [[ -z "${agent}" ]] && agent="claude"

    _run_record_last "${name}"
    local base_url token model subagent_model discover settings_file
    base_url=$(_provider_field "${name}" base_url) || return $?
    token=$(_provider_field "${name}" auth_token) || return $?
    model=$(_provider_field "${name}" model) || return $?
    subagent_model=$(_provider_field "${name}" subagent_model) || return $?
    discover=$(_provider_discover "${name}") || return $?

    if [[ "${agent}" == "codex" ]]; then
      require_codex
      if [[ -z "${model}" ]]; then
        model=$(_relay_data codex-model-pick "$(provider_file "${name}")") || return $?
        [[ -n "${model}" ]] && ok "Rotated Codex model for '${name}': ${model}"
      fi
      [[ -z "${model}" ]] && { err "Provider '${name}' has no --model or codex_models set — Codex requires an explicit model (no discovery fallback)"; exit 1; }

      # Codex's Responses wire API always POSTs "${base_url}/responses" — the
      # OpenAI-style convention is a base_url that already ends in /v1, so
      # append it here unless the provider's base_url already has it.
      local codex_base_url="${base_url}"
      case "${codex_base_url}" in
        */v1) ;;
        *) codex_base_url="${codex_base_url%/}/v1" ;;
      esac

      local base_url_toml model_toml
      base_url_toml=$(_toml_str "${codex_base_url}")
      model_toml=$(_toml_str "${model}")

      local codex_args=(
        -c model_provider="relay"
        -c model_providers.relay.name="relay"
        -c "model_providers.relay.base_url=${base_url_toml}"
        -c model_providers.relay.env_key="RELAY_CODEX_API_KEY"
        -c model_providers.relay.wire_api="responses"
        -c model_providers.relay.stream_idle_timeout_ms=600000
        -c "model=${model_toml}"
      )
      RELAY_CODEX_API_KEY="${token}" exec "${REAL_CODEX}" "${codex_args[@]}" "$@"
    fi

    require_claude

    # Opportunistic cleanup: a prior `relay run <provider>` can't clean up
    # after itself (exec replaces the process, so no trap ever fires) —
    # sweep anything old enough that the session which created it has
    # almost certainly ended, so these don't accumulate indefinitely.
    find "${RELAY_DIR}" -maxdepth 1 -name '.run-settings.*' -mtime +1 -delete 2>/dev/null || true

    # Written to a chmod-600 file under RELAY_DIR (mktemp's default file
    # mode is already 0600) rather than passed inline via `claude`'s own
    # argv — the exec'd claude process's cmdline would otherwise expose
    # this provider's auth token to any local user via `ps`/`ps aux` for
    # the entire session lifetime.
    settings_file=$(mktemp "${RELAY_DIR}/.run-settings.XXXXXX")
    RELAY_RUN_BASE_URL="${base_url}" \
    RELAY_RUN_TOKEN="${token}" \
    RELAY_RUN_MODEL="${model}" \
    RELAY_RUN_SUBAGENT_MODEL="${subagent_model}" \
    RELAY_RUN_DISCOVER="${discover}" \
    RELAY_RUN_SETTINGS_FILE="${settings_file}" \
    _relay_data run-settings || return $?

    exec "${REAL_CLAUDE}" --settings "${settings_file}" "$@"
  else
    err "Unknown account or provider: ${name}"
    exit 1
  fi
}
