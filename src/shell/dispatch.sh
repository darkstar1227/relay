_maybe_redeploy_daemon

# ══════════════════════════════════════════════════════════════════
# Dispatch — single entry point, no fall-through
# ══════════════════════════════════════════════════════════════════
CMD="${1:-}"
[[ $# -gt 0 ]] && shift

case "${CMD}" in
  "")               cmd_quick "$@" ;;
  add)              cmd_add "$@" ;;
  add-force)
    [[ -n "${1:-}" ]] && rm -f "$(account_creds "$1")" "$(account_meta "$1")"
    cmd_add "$@" ;;
  save)             cmd_save "$@" ;;
  refresh)          cmd_refresh "$@" ;;
  refresh-all)      cmd_refresh_all ;;
  switch|sw|use)
    if [[ -z "${1:-}" ]]; then cmd_quick
    elif [[ "${1}" =~ ^[0-9]+$ ]]; then
      name=$(account_by_index "$1") || { err "No account at index $1"; cmd_quick --no-usage; exit 1; }
      do_switch "${name}"
    else
      account_exists "$1" || { err "Account '$1' not found"; cmd_quick --no-usage; exit 1; }
      do_switch "$1"
    fi ;;
  list|ls)          cmd_list "$@" ;;
  status|st)        cmd_status ;;
  remove|rm|del)    cmd_remove "$@" ;;
  rename|mv)        cmd_rename "$@" ;;
  reorder)          cmd_reorder "$@" ;;
  provider|prov)
    sub="${1:-}"
    [[ -n "${1:-}" ]] && shift
    case "${sub}" in
      add)    cmd_provider_add "$@" ;;
      list|ls) cmd_provider_list ;;
      remove|rm) cmd_provider_remove "$@" ;;
      codex-models) cmd_provider_codex_models "$@" ;;
      *) err "usage: relay provider <add|list|remove|codex-models> ..."; exit 1 ;;
    esac ;;
  proxy|px)
    sub="${1:-}"
    [[ -n "${1:-}" ]] && shift
    case "${sub}" in
      init)   cmd_proxy_init ;;
      start)  cmd_proxy_start "$@" ;;
      stop)   cmd_proxy_stop "$@" ;;
      status) cmd_proxy_status "$@" ;;
      log)    cmd_proxy_log "$@" ;;
      bridge)
        bsub="${1:-}"
        [[ -n "${1:-}" ]] && shift
        case "${bsub}" in
          set-command) cmd_proxy_bridge_set_command "$@" ;;
          *) err "usage: relay proxy bridge set-command '<cmd>'"; exit 1 ;;
        esac ;;
      *) err "usage: relay proxy <init|start|stop|status|log|bridge> ..."; exit 1 ;;
    esac ;;
  run)              cmd_run "$@" ;;
  sessions|sess)    cmd_sessions ;;
  autoswitch|as)    cmd_autoswitch "$@" ;;
  lock)             cmd_lock "$@" ;;
  unlock)           cmd_unlock "$@" ;;
  warmup)           cmd_warmup "$@" ;;
  version|--version|-V) cmd_version ;;
  update)           cmd_update ;;
  install)          cmd_install ;;
  uninstall)        cmd_uninstall ;;
  continue|cont|c)
    if [[ -n "${1:-}" ]]; then
      account_exists "$1" && do_switch "$1"
    fi
    require_claude
    exec "${REAL_CLAUDE}" --continue ;;
  help|--help|-h)   cmd_help ;;
  *)
    # numeric → switch by index; name → switch by name; else → error
    if [[ "${CMD}" =~ ^[0-9]+$ ]]; then
      name=$(account_by_index "${CMD}") || { err "No account at index ${CMD}"; cmd_quick --no-usage; exit 1; }
      do_switch "${name}"
    elif account_exists "${CMD}"; then
      do_switch "${CMD}"
    else
      err "Unknown command or account: ${CMD}"
      cmd_quick --no-usage
      printf "  ${D}Run ${CY}relay help${R}${D} for usage${R}\n\n"
      exit 1
    fi ;;
esac
