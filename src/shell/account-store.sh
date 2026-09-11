current_name()   { [[ -f "${CURRENT_FILE}" ]] && cat "${CURRENT_FILE}" || echo ""; }
account_creds()  { echo "${CREDS_STORE}/$1.json"; }
account_meta()   { echo "${META_STORE}/$1"; }
account_exists() { [[ -f "$(account_creds "$1")" ]]; }

provider_file()   { echo "${PROVIDERS_STORE}/$1.json"; }
provider_exists() { [[ -f "$(provider_file "$1")" ]]; }

# list providers alphabetically, one per line (bash 3.2 compatible)
list_provider_names() {
  local f
  for f in "${PROVIDERS_STORE}"/*.json; do
    [[ -f "${f}" ]] || continue
    basename "${f}" .json
  done | sort
}

# read one string field from a provider's JSON file; "" if absent
_provider_field() {
  _relay_data provider-field "$(provider_file "$1")" "$2"
}

# "1" if the provider has discover_models truthy, else ""
_provider_discover() {
  _relay_data provider-discover "$(provider_file "$1")"
}

# escape a value for embedding as a TOML basic string in a `codex -c key="value"` arg
_toml_str() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '"%s"' "${s}"
}

# list accounts in canonical add-order, one per line (bash 3.2 compatible).
# Self-healing: drops names whose credential file is gone, appends any
# credential file not yet tracked (alphabetically), and rewrites ORDER_FILE.
list_account_names() {
  local on_disk=() name f

  while IFS= read -r name; do
    on_disk+=("${name}")
  done < <(for f in "${CREDS_STORE}"/*.json; do [[ -f "${f}" ]] || continue; basename "${f}" .json; done | sort)

  local ordered=()
  if [[ -f "${ORDER_FILE}" ]]; then
    local existing already
    while IFS= read -r name; do
      [[ -z "${name}" ]] && continue
      account_exists "${name}" || continue
      already=0
      for existing in ${ordered[@]+"${ordered[@]}"}; do
        [[ "${existing}" == "${name}" ]] && { already=1; break; }
      done
      [[ "${already}" -eq 0 ]] && ordered+=("${name}")
    done < "${ORDER_FILE}"
  fi

  local acct tracked
  for acct in ${on_disk[@]+"${on_disk[@]}"}; do
    tracked=0
    for name in ${ordered[@]+"${ordered[@]}"}; do
      [[ "${name}" == "${acct}" ]] && { tracked=1; break; }
    done
    [[ "${tracked}" -eq 0 ]] && ordered+=("${acct}")
  done

  if [[ ${#ordered[@]} -gt 0 ]]; then
    printf '%s\n' "${ordered[@]}" > "${ORDER_FILE}"
    printf '%s\n' "${ordered[@]}"
  else
    : > "${ORDER_FILE}"
  fi
}

# append name to ORDER_FILE if not already tracked (used by add/save)
add_to_order() {
  local name="$1"
  touch "${ORDER_FILE}"
  grep -Fxq "${name}" "${ORDER_FILE}" 2>/dev/null && return 0
  echo "${name}" >> "${ORDER_FILE}"
}

# remove name's line from ORDER_FILE (used by remove)
remove_from_order() {
  local name="$1"
  [[ -f "${ORDER_FILE}" ]] || return 0
  local tmp="${ORDER_FILE}.tmp.$$"
  grep -Fxv "${name}" "${ORDER_FILE}" > "${tmp}" 2>/dev/null || : > "${tmp}"
  mv "${tmp}" "${ORDER_FILE}"
}

# rename a tracked entry in place, preserving its position (used by rename)
rename_in_order() {
  local old="$1" new="$2"
  [[ -f "${ORDER_FILE}" ]] || return 0
  local tmp="${ORDER_FILE}.tmp.$$"
  awk -v old="${old}" -v new="${new}" '{ print ($0 == old) ? new : $0 }' "${ORDER_FILE}" > "${tmp}"
  mv "${tmp}" "${ORDER_FILE}"
}

# interactive numbered reorder picker. Prints the account list + prompt to
# stderr (so it's visible even when the caller captures stdout), reads one
# line from stdin, resolves it to a comma-joined order, and echoes that
# order to stdout for the caller to capture.
prompt_reorder() {
  local accounts=("$@")
  echo "" >&2
  printf "  ${D}When an account hits its threshold, relay switches to the next one in order.${R}\n\n" >&2
  local i=1 acct
  for acct in "${accounts[@]}"; do
    printf "    ${D}%d${R}  %s\n" "${i}" "${acct}" >&2
    i=$((i+1))
  done
  echo "" >&2
  printf "  ${D}Type numbers in the order you want  (e.g. ${CY}2 1${D}, or ${CY}21${D} for <=9 accounts, or Enter to keep the order above):${R}\n" >&2
  printf "  > " >&2
  read -r order_input

  local order_str; order_str=$(_relay_data prompt-reorder "${order_input}" "${accounts[@]}") || return $?

  local chain; chain=$(echo "${order_str}" | _relay_data reorder-chain) || return $?
  printf "  ${D}Order: ${CY}%s${R}\n" "${chain}" >&2

  echo "${order_str}"
}

account_by_index() {
  local idx="$1" i=1 name
  while IFS= read -r name; do
    [[ "${i}" -eq "${idx}" ]] && { echo "${name}"; return 0; }
    i=$((i+1))
  done < <(list_account_names)
  return 1
}

# read the logged-in email from ~/.claude.json (written by Claude Code after login)
grab_email_from_claude_json() {
  [[ -f "${CLAUDE_JSON}" ]] || { echo ""; return; }
  _relay_data account-email "${CLAUDE_JSON}" 2>/dev/null
}

get_meta_email() {
  local f; f=$(account_meta "$1")
  [[ -f "${f}" ]] && cat "${f}" || echo "—"
}

save_meta_email() {
  local name="$1"
  local email
  email=$(grab_email_from_claude_json)
  [[ -n "${email}" ]] && echo "${email}" > "$(account_meta "${name}")"
}

require_account() {
  account_exists "$1" && return 0
  return 1
}

require_claude() {
  [[ -n "${REAL_CLAUDE}" ]] && return 0
  err "claude not found — install it with: npm i -g @anthropic-ai/claude-code"
  exit 1
}

require_codex() {
  [[ -n "${REAL_CODEX}" ]] && return 0
  err "codex not found — install it with: npm i -g @openai/codex"
  exit 1
}

require_litellm() {
  command -v litellm >/dev/null 2>&1 && return 0
  err "litellm not found — install it with: pip install 'litellm[proxy]'"
  exit 1
}

# ══════════════════════════════════════════════════════════════════
# Python core: parallel usage fetch + table rendering
# args: <mode: quick|full> <creds_dir> <meta_dir> <current_name> [--no-usage]
# ══════════════════════════════════════════════════════════════════
