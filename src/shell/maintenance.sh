_script_path() {
  # Resolve relative links against each link's directory, not the caller's cwd.
  # macOS readlink has no portable -f option.
  local src="$0"
  local dir target hops=0
  while [[ -L "${src}" ]]; do
    hops=$((hops+1))
    [[ ${hops} -le 40 ]] || { err "Too many relay symlinks"; return 1; }
    dir=$(cd "$(dirname "${src}")" && pwd -P) || return 1
    target=$(readlink "${src}") || return 1
    case "${target}" in
      /*) src="${target}" ;;
      *) src="${dir}/${target}" ;;
    esac
  done
  dir=$(cd "$(dirname "${src}")" && pwd -P) || return 1
  printf '%s/%s\n' "${dir}" "$(basename "${src}")"
}

_script_dir() {
  local script; script=$(_script_path) || return 1
  dirname "${script}"
}

_read_version() {
  local pkg; pkg="$(_script_dir)/package.json"
  [[ -f "${pkg}" ]] && \
    _relay_data read-version "${pkg}" 2>/dev/null \
    || printf '%s\n' "${RELAY_BUILD_VERSION}"
}

cmd_version() {
  printf "relay %s\n" "$(_read_version)"
}

# ── Update notification helpers ───────────────────────────────────────────────
# Cache format: "<epoch>:<version>"  TTL = 24h
_check_update_bg() {
  (
    local ttl=86400
    if [[ -f "${UPDATE_CACHE}" ]]; then
      local cached; cached=$(cat "${UPDATE_CACHE}" 2>/dev/null)
      local ts="${cached%%:*}"
      local now; now=$(date +%s)
      [[ $(( now - ts )) -lt ${ttl} ]] && exit 0
    fi
    local ver
    ver=$(_relay_data check-update-bg 2>/dev/null)
    [[ -n "${ver}" ]] && printf '%s:%s' "$(date +%s)" "${ver}" > "${UPDATE_CACHE}"
  ) >/dev/null 2>&1 &
  disown 2>/dev/null || true
}

_show_update_notice() {
  local current; current=$(_read_version)
  local latest=""
  if [[ -f "${UPDATE_CACHE}" ]]; then
    local cached; cached=$(cat "${UPDATE_CACHE}" 2>/dev/null)
    latest="${cached#*:}"
  fi
  if [[ -n "${latest}" && "${latest}" != "${current}" ]]; then
    printf "\n  ${D}relay version: ${B}${current}${R}${D} → ${CY}${B}${latest}${R}${D} available — run ${CY}relay update${R}${D} to install${R}\n"
  else
    local ver_display="${latest:-${current}}"
    printf "\n  ${D}relay version: ${B}${ver_display}${R}${D} (up to date)${R}\n"
  fi
}

# Detect how relay was originally installed:
#   npm    — package.json present in script dir (npm unpacks the full package)
#   git    — .git dir present in script dir
#   direct — bare script copy (no package.json, no .git)
_detect_install_method() {
  local d; d=$(_script_dir)
  # .git check first: git clone has both .git AND package.json; npm publish strips .git
  if [[ -e "${d}/.git" ]];      then echo "git"
  elif [[ -f "${d}/package.json" ]]; then echo "npm"
  else                                  echo "direct"
  fi
}

cmd_update() {
  hdr "Update relay"

  local current; current=$(_read_version)
  log "Current version: ${B}${current}${R}"

  # Check latest version — GitHub first, npm registry as fallback
  local latest
  latest=$(_relay_data latest-version 2>/dev/null)

  if [[ -z "${latest}" ]]; then
    warn "Could not determine latest version — check your network"
    log "To update manually: ${CY}npm install -g @dst-justin/relay@latest${R}"
    return 1
  fi

  if [[ -n "${RELAY_CORE_BIN:-}" && "${latest}" != "${current}" ]]; then
    err "Rust development mode requires a matching script/core pair; automatic update is not enabled yet"
    return 1
  fi

  # Refresh cache with this live result so display commands reflect it immediately
  printf '%s:%s' "$(date +%s)" "${latest}" > "${UPDATE_CACHE}" 2>/dev/null || true

  if [[ "${current}" == "${latest}" ]]; then
    ok "Already up to date (${current})"; return 0
  else
    log "Latest available: ${B}${latest}${R}"
  fi

  local relay_dir; relay_dir=$(_script_dir)
  local method; method=$(_detect_install_method)

  case "${method}" in
    npm)
      local npm_cmd; npm_cmd=$(command -v npm 2>/dev/null)
      if [[ -n "${npm_cmd}" ]]; then
        log "Updating via npm (original install method)..."
        npm install -g "@dst-justin/relay@${latest}" || { err "npm update failed"; return 1; }
        local installed; installed=$(_read_version)
        [[ "${installed}" == "${latest}" ]] || { err "npm did not install the requested version ${latest}"; return 1; }
        ok "Updated to ${installed}"
      else
        err "npm not found — reinstall npm and retry"
        log "Or update manually: ${CY}npm install -g @dst-justin/relay@latest${R}"
        return 1
      fi ;;
    git)
      log "Updating via git pull (original install method)..."
      git -C "${relay_dir}" pull --ff-only || { err "git update failed"; return 1; }
      ok "Updated checkout to $(_read_version)" ;;
    direct)
      log "Updating via direct download (original install method)..."
      local script_path; script_path=$(_script_path) || return 1
      _relay_data download-update "${script_path}" "${latest}"
      local status=$?
      [[ ${status} -eq 0 ]] || { err "Direct update failed; existing relay retained"; return "${status}"; }
      ok "Updated ${script_path} to ${latest}" ;;
  esac
  # Invalidate update cache so next display shows fresh state
  rm -f "${UPDATE_CACHE}" 2>/dev/null || true
}

cmd_uninstall() {
  hdr "Uninstall relay"
  warn "This will remove the relay command and all account credential data"
  printf "\n  ${YL}Continue? (y/N) ${R}"
  read -r c
  [[ "${c}" = "y" || "${c}" = "Y" ]] || { log "cancelled"; return 0; }

  local removed=0
  for p in "/usr/local/bin/relay" "${HOME}/bin/relay"; do
    if [[ -L "${p}" || -f "${p}" ]]; then
      rm -f "${p}" 2>/dev/null || sudo rm -f "${p}" 2>/dev/null || warn "Could not remove ${p} (try sudo)"
      ok "Removed ${p}"
      removed=1
    fi
  done
  [[ ${removed} -eq 0 ]] && warn "No installed relay command found (delete the script file manually)"

  if [[ -d "${RELAY_DIR}" ]]; then
    rm -rf "${RELAY_DIR}"
    ok "Removed ${RELAY_DIR} (all account data)"
  fi

  printf "\n  ${GR}relay has been fully removed.${R}\n\n"
}
