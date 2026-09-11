do_switch() {
  with_credential_lock _do_switch_locked "$@"
}

_do_switch_locked() {
  local name="$1"
  local current; current=$(current_name)

  if [[ "${current}" == "${name}" ]]; then
    ok "Already on account '${B}${name}${R}'"
    return 0
  fi

  # Back up the current account's live token before switching
  # (Claude Code refreshes tokens in-place; the snapshot may be stale)
  if [[ -n "${current}" ]] && account_exists "${current}"; then
    local live; live=$(kc_read 2>/dev/null)
    [[ -n "${live}" ]] && printf '%s' "${live}" > "$(account_creds "${current}")"
  fi

  echo "${name}" > "${CURRENT_FILE}"

  # Write the target account's credentials into the store Claude Code reads
  local content; content=$(cat "$(account_creds "${name}")")
  kc_write "${content}" || warn "Credential write failed — switch may not take effect"

  local email; email=$(get_meta_email "${name}")
  printf "\n  ${GR}${B}✓ switched → %s${R}  ${D}%s${R}\n" "${name}" "${email}"
  printf "  ${D}Active sessions pick up the switch on next message. New session: ${CY}claude -c${R}\n\n"

  # ponytail: sentinel lets autoswitch daemon skip this account until threshold hit
  printf '{"account":"%s","ts":%s}' "${name}" "$(date +%s)" > "${RELAY_DIR}/manual_switch"
}

# ══════════════════════════════════════════════════════════════════
# Commands
# ══════════════════════════════════════════════════════════════════

# Sync the current account's token from credential store to its snapshot file
# before displaying usage — prevents showing stale/expired tokens as "—"
_sync_current_creds() {
  if [[ -n "${RELAY_CORE_BIN:-}" ]]; then
    _relay_data sync-current
    return $?
  fi
  local cur; cur=$(current_name)
  [[ -z "${cur}" ]] || ! account_exists "${cur}" && return
  local live; live=$(kc_read 2>/dev/null)
  [[ -n "${live}" ]] && printf '%s' "${live}" > "$(account_creds "${cur}")"
}
