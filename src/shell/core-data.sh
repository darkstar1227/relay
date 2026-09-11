# Transitional migration boundary. The published/default path stays Python until
# all operations and platform artifacts are ready. An explicitly selected core
# must match; core failures NEVER fall back to Python.
if [[ -n "${RELAY_CORE_BIN:-}" ]]; then
  case "${RELAY_CORE_BIN}" in
    /*) ;;
    *) err "RELAY_CORE_BIN must be an absolute path"; exit 1 ;;
  esac
  [[ -x "${RELAY_CORE_BIN}" ]] || { err "Rust core is missing or not executable; build it with cargo build --release --locked"; exit 1; }
  _relay_core_protocol=$("${RELAY_CORE_BIN}" protocol) || { err "Rust core handshake failed"; exit 1; }
  [[ "${_relay_core_protocol}" == "relay-core 1 ${RELAY_BUILD_VERSION}" ]] || {
    err "Rust core protocol/version mismatch; rebuild the matching core"
    exit 1
  }
  unset _relay_core_protocol
fi

_relay_credential_holder() {
  # Always called in a background child: exec makes $! the real lock holder.
  if [[ -n "${RELAY_CORE_BIN:-}" ]]; then
    exec "${RELAY_CORE_BIN}" credential-lock "$@"
  fi
  exec "${PY}" -c '{{python:with_credential_lock.py}}' "$@"
}

_relay_data() {
  local operation="$1"; shift
  if [[ -n "${RELAY_CORE_BIN:-}" ]]; then
    "${RELAY_CORE_BIN}" "${operation}" "$@"
    return $?
  fi
  case "${operation}" in
    download-update) "${PY}" - "$@" <<'PYEOF'
{{python:download_update.py}}
PYEOF
      ;;
    render-table) "${PY}" - "$@" <<'PYEOF'
{{python:render_table.py}}
PYEOF
      ;;
    status-once) "${PY}" - "$@" <<'PYEOF'
{{python:status_once.py}}
PYEOF
      ;;
    refresh-all) "${PY}" - "$@" <<'PYEOF'
{{python:refresh_all.py}}
PYEOF
      ;;
    latest-version) "${PY}" - "$@" <<'PYEOF'
{{python:latest_version.py}}
PYEOF
      ;;
    check-update-bg) "${PY}" - "$@" <<'PYEOF'
{{python:check_update_bg.py}}
PYEOF
      ;;
    config-save) "${PY}" -c '{{python:config_save.py}}' "$@" ;;
    lock-default-config) "${PY}" - "$@" <<'PYEOF'
{{python:lock_default_config.py}}
PYEOF
      ;;
    warmup-ensure-config) "${PY}" - "$@" <<'PYEOF'
{{python:warmup_ensure_config.py}}
PYEOF
      ;;
    prompt-reorder) "${PY}" - "$@" <<'PYEOF'
{{python:prompt_reorder.py}}
PYEOF
      ;;
    reorder-chain) "${PY}" -c "{{python:reorder_chain.py}}" "$@" ;;
    lock-list) "${PY}" - "$@" <<'PYEOF'
{{python:lock_list.py}}
PYEOF
      ;;
    warmup-list) "${PY}" - "$@" <<'PYEOF'
{{python:warmup_list.py}}
PYEOF
      ;;
    warmup-health) "${PY}" - "$@" <<'PYEOF'
{{python:warmup_health.py}}
PYEOF
      ;;
    warmup-test) "${PY}" - "$@" <<'PYEOF'
{{python:warmup_test.py}}
PYEOF
      ;;
    autoswitch-config-summary) "${PY}" - "$@" <<'PYEOF'
{{python:autoswitch_config_summary.py}}
PYEOF
      ;;
    autoswitch-status) "${PY}" - "$@" <<'PYEOF'
{{python:autoswitch_status.py}}
PYEOF
      ;;
    autoswitch-log) "${PY}" - "$@" <<'PYEOF'
{{python:autoswitch_log.py}}
PYEOF
      ;;
    sessions) "${PY}" - "$@" <<'PYEOF'
{{python:sessions.py}}
PYEOF
      ;;
    provider-field) "${PY}" -c '{{python:provider_field.py}}' "$@" ;;
    provider-discover) "${PY}" -c '{{python:provider_discover.py}}' "$@" ;;
    codex-models-get) "${PY}" -c '{{python:codex_models_get.py}}' "$@" ;;
    codex-models-set) "${PY}" -c '{{python:codex_models_set.py}}' "$@" ;;
    codex-model-pick) "${PY}" -c '{{python:codex_model_pick.py}}' "$@" ;;
    account-email) "${PY}" - "$@" <<'PYEOF'
{{python:grab_email_from_claude_json.py}}
PYEOF
      ;;
    access-token) "${PY}" -c "{{python:access_token.py}}" "$@" ;;
    format-json) "${PY}" -c '{{python:format_json.py}}' "$@" ;;
    read-version) "${PY}" -c '{{python:read_version.py}}' "$@" ;;
    provider-add) "${PY}" -c '
{{python:provider_add.py}}
' "$@" ;;
    run-settings) "${PY}" -c '
{{python:run_settings.py}}
' "$@" ;;
    reorder) "${PY}" - "$@" <<'PYEOF'
{{python:reorder.py}}
PYEOF
      ;;
    lock-add) "${PY}" - "$@" <<'PYEOF'
{{python:lock_add.py}}
PYEOF
      ;;
    unlock) "${PY}" - "$@" <<'PYEOF'
{{python:unlock.py}}
PYEOF
      ;;
    warmup-add) "${PY}" - "$@" <<'PYEOF'
{{python:warmup_add.py}}
PYEOF
      ;;
    warmup-remove) "${PY}" - "$@" <<'PYEOF'
{{python:warmup_remove.py}}
PYEOF
      ;;
    warmup-pause) "${PY}" - "$@" <<'PYEOF'
{{python:warmup_pause.py}}
PYEOF
      ;;
    warmup-resume) "${PY}" - "$@" <<'PYEOF'
{{python:warmup_resume.py}}
PYEOF
      ;;
    *) err "Unknown internal data operation"; return 1 ;;
  esac
}
