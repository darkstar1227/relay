
cmd_reorder() {
  hdr "reorder accounts"

  local accounts=()
  local name
  while IFS= read -r name; do accounts+=("${name}"); done < <(list_account_names)

  if [[ ${#accounts[@]} -eq 0 ]]; then
    err "No accounts found. Run: relay add <name>"
    exit 1
  fi

  local order_str; order_str=$(prompt_reorder "${accounts[@]}") || return $?

  if [[ -z "${order_str}" ]]; then
    err "No valid order given — nothing changed"
    exit 1
  fi

  local order_arr=()
  IFS=',' read -ra order_arr <<< "${order_str}"

  local account ordered found
  for account in ${accounts[@]+"${accounts[@]}"}; do
    found=0
    for ordered in ${order_arr[@]+"${order_arr[@]}"}; do
      [[ "${ordered}" == "${account}" ]] && { found=1; break; }
    done
    [[ "${found}" -eq 0 ]] && order_arr+=("${account}")
  done

  order_str=""
  for ordered in ${order_arr[@]+"${order_arr[@]}"}; do
    if [[ -z "${order_str}" ]]; then
      order_str="${ordered}"
    else
      order_str="${order_str},${ordered}"
    fi
  done

  printf '%s\n' "${order_arr[@]}" > "${ORDER_FILE}"
  ok "Order saved to ${ORDER_FILE}"

  local cfg="${RELAY_DIR}/autoswitch.json"
  if [[ -f "${cfg}" ]]; then
    _relay_data reorder "${cfg}" "${order_str}" || return $?
    ok "Also updated order in ${cfg}"
  fi
}

cmd_lock() {
  local name="${1:-}"
  local cfg="${RELAY_DIR}/autoswitch.json"

  # No argument: show lock status
  if [[ -z "${name}" ]]; then
    hdr "Account locks"
    if [[ ! -f "${cfg}" ]]; then
      warn "No autoswitch config. Run: relay autoswitch config"
      return 0
    fi
    _relay_data lock-list "${cfg}"
    return $?
  fi

  account_exists "${name}" || { err "Account '${name}' not found"; exit 1; }

  # Ensure config file exists (create auto-default if missing)
  if [[ ! -f "${cfg}" ]]; then
    _relay_data lock-default-config "${CREDS_STORE}" "${cfg}" || return $?
    ok "Created default autoswitch config: ${cfg}"
  fi

  _relay_data lock-add "${cfg}" "${name}" || return $?
  ok "Locked '${B}${name}${R}' — won't be switched back to when over threshold"
}

cmd_unlock() {
  local name="${1:-}"
  [[ -z "${name}" ]] && { err "usage: relay unlock <name>"; exit 1; }
  local cfg="${RELAY_DIR}/autoswitch.json"
  [[ ! -f "${cfg}" ]] && { warn "No autoswitch config — nothing to unlock"; return 0; }

  _relay_data unlock "${cfg}" "${name}" || return $?
  ok "Unlocked '${B}${name}${R}'"
}
