
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

  hdr "Add account: ${name}"
  warn "Complete the browser login then return to this terminal"
  echo ""

  # Record the token before login to detect whether a real new login occurred
  local tok_before; tok_before=$(kc_read 2>/dev/null | \
    _relay_data access-token 2>/dev/null || echo "")

  "${REAL_CLAUDE}" /login || true

  local kc_creds tok_after
  kc_creds=$(kc_read 2>/dev/null)
  tok_after=$(printf '%s' "${kc_creds}" | \
    _relay_data access-token 2>/dev/null || echo "")

  if [[ -z "${kc_creds}" ]]; then
    err "No credentials found after login"
    log "If login succeeded, run: ${B}relay save ${name}${R}"
    exit 1
  fi

  if [[ -n "${tok_before}" ]] && [[ "${tok_before}" == "${tok_after}" ]]; then
    err "Login did not complete (token unchanged)"
    warn "Run relay add from a regular Terminal — browser login is not available inside Claude Code"
    log "To save the current account under a new name: ${B}relay save ${name}${R}"
    exit 1
  fi

  printf '%s' "${kc_creds}" > "$(account_creds "${name}")"
  chmod 600 "$(account_creds "${name}")"
  save_meta_email "${name}"
  add_to_order "${name}"
  echo "${name}" > "${CURRENT_FILE}"
  ok "Account '${B}${name}${R}' added  ${D}$(get_meta_email "${name}")${R}"
}

cmd_save() {
  local name="${1:-}"
  [[ -z "${name}" ]] && { err "usage: relay save <name>"; exit 1; }
  hdr "Save current account as: ${name}"

  local saved=0
  local kc; kc=$(kc_read 2>/dev/null)
  if [[ -n "${kc}" ]]; then
    printf '%s' "${kc}" > "$(account_creds "${name}")"
    chmod 600 "$(account_creds "${name}")"
    if [[ "$(uname)" == "Darwin" ]]; then ok "Saved from Keychain"
    else ok "Saved from ~/.claude/.credentials.json"
    fi
    saved=1
  fi
  [[ ${saved} -eq 0 ]] && { err "No credentials found — log in first with: claude /login"; exit 1; }

  save_meta_email "${name}"
  add_to_order "${name}"
  echo "${name}" > "${CURRENT_FILE}"
  ok "Account '${B}${name}${R}' saved  ${D}$(get_meta_email "${name}")${R}"
}

cmd_refresh() {
  local name="${1:-}"
  [[ -z "${name}" ]] && { err "usage: relay refresh <name>"; exit 1; }
  account_exists "${name}" || { err "Account '${name}' not found"; exit 1; }
  require_claude
  hdr "Refresh account: ${name}"
  warn "Complete the browser login then return to this terminal"
  echo ""

  local tok_before; tok_before=$(kc_read 2>/dev/null | \
    _relay_data access-token 2>/dev/null || echo "")

  "${REAL_CLAUDE}" /login || true

  local kc_creds tok_after
  kc_creds=$(kc_read 2>/dev/null)
  tok_after=$(printf '%s' "${kc_creds}" | \
    _relay_data access-token 2>/dev/null || echo "")

  if [[ -z "${kc_creds}" ]]; then
    err "No credentials found after login"
    exit 1
  fi

  if [[ -n "${tok_before}" ]] && [[ "${tok_before}" == "${tok_after}" ]]; then
    err "Login did not complete (token unchanged)"
    warn "Run relay refresh from a regular Terminal — browser login is not available inside Claude Code"
    exit 1
  fi

  printf '%s' "${kc_creds}" > "$(account_creds "${name}")"
  chmod 600 "$(account_creds "${name}")"
  save_meta_email "${name}"
  echo "${name}" > "${CURRENT_FILE}"
  ok "Account '${B}${name}${R}' refreshed  ${D}$(get_meta_email "${name}")${R}"
}

cmd_refresh_all() {
  hdr "Refresh all accounts (silent OAuth)"
  local names=()
  while IFS= read -r f; do
    names+=("$(basename "${f%.json}")")
  done < <(find "${CREDS_STORE}" -maxdepth 1 -name '*.json' 2>/dev/null | sort)
  [[ ${#names[@]} -eq 0 ]] && { warn "No accounts found"; return 0; }
  _relay_data refresh-all "${CREDS_STORE}" "${#names[@]}" "${names[@]}"
}

cmd_remove() {
  local name="${1:-}"
  [[ -z "${name}" ]] && { err "usage: relay remove <name>"; exit 1; }
  account_exists "${name}" || { err "Account '${name}' not found"; exit 1; }
  printf "\n  ${YL}Delete '${B}${name}${R}${YL}'? (y/N) ${R}"
  read -r c
  [[ "${c}" = "y" || "${c}" = "Y" ]] || { log "cancelled"; return 0; }
  rm -f "$(account_creds "${name}")" "$(account_meta "${name}")"
  remove_from_order "${name}"
  # Drop the deleted account from autoswitch's order/thresholds/locks too, so
  # rotation never picks a target with no credential file on disk. Warmup
  # entries are left untouched — deleting an account shouldn't force the user
  # to redo unrelated warmup config.
  [[ -f "${RELAY_DIR}/autoswitch.json" ]] && _relay_data autoswitch-prune-account "${RELAY_DIR}/autoswitch.json" "${name}"
  if [[ "$(current_name)" == "${name}" ]]; then
    rm -f "${CURRENT_FILE}"
    local next; next=$(list_account_names | head -1)
    if [[ -n "${next}" ]]; then
      do_switch "${next}"
    fi
  fi
  ok "Deleted '${name}' (sessions are unaffected)"
}

cmd_sessions() {
  hdr "Sessions (shared across all accounts)"
  local base="${CLAUDE_DIR}/projects"
  [[ -d "${base}" ]] || { warn "No sessions found"; return 0; }
  _relay_data sessions "${base}" || return $?
  log "${CY}claude -c${R} resume last  ${D}|${R}  ${CY}claude -r${R} pick one  ${D}|${R}  ${CY}claude --resume <id>${R}"
  _check_update_bg
  _show_update_notice
}

cmd_install() {
  local script_path; script_path="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  local target="/usr/local/bin/relay"

  hdr "Install relay"

  if rm -f "${target}" 2>/dev/null && cp "${script_path}" "${target}" 2>/dev/null && chmod 755 "${target}" 2>/dev/null; then
    ok "Installed at ${target}"
    log "Run ${CY}relay help${R} to verify"
  elif sudo rm -f "${target}" 2>/dev/null && sudo cp "${script_path}" "${target}" 2>/dev/null && sudo chmod 755 "${target}" 2>/dev/null; then
    ok "Installed at ${target} (via sudo)"
  else
    warn "Cannot write to /usr/local/bin — installing to ~/bin instead"
    mkdir -p "${HOME}/bin"
    rm -f "${HOME}/bin/relay" 2>/dev/null
    cp "${script_path}" "${HOME}/bin/relay" && chmod 755 "${HOME}/bin/relay"
    ok "Installed at ${HOME}/bin/relay"
    echo ""
    warn "Make sure ~/bin is in your PATH (.zshrc / .bashrc):"
    printf "  ${CY}echo 'export PATH=\"\$HOME/bin:\$PATH\"' >> ~/.zshrc && source ~/.zshrc${R}\n"
  fi

  echo ""
  hdr "First-time setup"
  printf "  ${B}1. Add your first account${R}\n"
  printf "  ${CY}relay add personal${R}   ${D}# opens browser login${R}\n\n"
  printf "  ${B}2. (optional) Add more accounts${R}\n"
  printf "  ${CY}relay add work${R}\n"
  printf "  ${CY}relay add backup${R}\n\n"
  printf "  ${B}3. Switch inside Claude Code${R}\n"
  printf "  ${CY}!relay${R}        ${D}# menu + usage${R}\n"
  printf "  ${CY}!relay 2${R}      ${D}# switch to account #2${R}\n"
  printf "  ${CY}!relay work${R}   ${D}# switch to named account${R}\n\n"
}

cmd_rename() {
  local old="${1:-}" new="${2:-}"
  [[ -z "${old}" || -z "${new}" ]] && { err "usage: relay rename <old-name> <new-name>"; exit 1; }
  case "${new}" in
    *[!a-zA-Z0-9_-]*) err "name must contain only letters, numbers, underscores, or hyphens"; exit 1 ;;
  esac
  account_exists "${old}" || { err "Account '${old}' not found"; exit 1; }
  account_exists "${new}" && { err "Account '${new}' already exists"; exit 1; }

  mv "$(account_creds "${old}")" "$(account_creds "${new}")"
  [[ -f "$(account_meta "${old}")" ]] && mv "$(account_meta "${old}")" "$(account_meta "${new}")"
  rename_in_order "${old}" "${new}"
  [[ "$(current_name)" == "${old}" ]] && echo "${new}" > "${CURRENT_FILE}"
  ok "Renamed '${B}${old}${R}' → '${B}${new}${R}'"
}
