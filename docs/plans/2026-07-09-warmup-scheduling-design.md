# Warmup Scheduling Design

**Goal:** Add a feature to `relay` that automatically switches to a specified account at a specified daily time and sends a minimal non-interactive ping to Claude, so the 5-hour usage session starts before the user actually begins working.

**Architecture:** Extends the existing `autoswitch` daemon (single Python heredoc inside the `relay` bash script). Reuses existing daemon primitives (`do_switch`, `log_event`, `notify`, `load_config`) rather than building a parallel scheduling system.

---

## Data model

New `warmup` array in `~/.claude-relay/autoswitch.json`, alongside `order`/`thresholds`/`locks`:

```json
{
  "order": ["work", "personal"],
  "thresholds": {"work": 80, "personal": 80},
  "locks": [],
  "warmup": [
    {"account": "work", "time": "06:00"},
    {"account": "personal", "time": "11:00"}
  ]
}
```

- Multiple entries per account are allowed (e.g. warm up twice a day).
- `time` is local 24hr `HH:MM`.
- Independent of `order`/`thresholds` — works even for a single-account setup with no autoswitch cycling enabled.

New state file `~/.claude-relay/warmup_state.json`, keyed by `"<account>|<HH:MM>"`:

```json
{
  "work|06:00": {"date": "2026-07-09", "status": "ok"},
  "personal|11:00": {"date": "2026-07-08", "status": "missed"}
}
```

`status` ∈ `ok`, `ping_failed`, `missed`, `missing_account`. One record per key per day — once a key has a record for today, it's not touched again until the next day.

Also new file `~/.claude-relay/claude_bin`, written at daemon start time with the absolute path to the `claude` executable (resolved by the bash script via `command -v claude`, same as existing `REAL_CLAUDE`). The daemon's Python process may run under launchd/systemd/cron with a minimal `PATH`, so it can't reliably re-resolve `claude` itself — it reads this file, falling back to `shutil.which('claude')`.

## CLI commands

```
relay warmup add <account> <HH:MM>     # add a schedule entry; account must exist; HH:MM validated
relay warmup remove <account> [HH:MM]  # no time = remove all entries for account; with time = remove that one entry
relay warmup list                      # show account / time / most recent status
```

- `add`/`remove` on a missing `autoswitch.json` writes the full default config (same shape the daemon auto-generates for 2+ accounts) plus the `warmup` field, so cycling isn't silently disabled by a partial write.
- `remove` on a non-existent entry warns but doesn't error.
- Invalid `HH:MM` (e.g. `6:00`, `25:00`) is rejected with a format hint.
- `list` output example:
  ```
  work       06:00   最後: 2026-07-09 成功
  personal   11:00   最後: 2026-07-08 錯過
  new_acct   09:00   尚未觸發
  ```

## Daemon logic

`load_config()` is adjusted so that a `warmup` field in `autoswitch.json` is still surfaced even when the auto-default path would otherwise return `None` (fewer than 2 accounts). `main()` calls `check_warmup(cfg.get('warmup', []))` before bailing out on missing `order`, so warmup fires independently of cycling.

```python
def check_warmup(entries):
    if not entries: return
    state = load_warmup_state()
    now = datetime.datetime.now()
    today = now.strftime('%Y-%m-%d')
    changed = False
    for entry in entries:
        acct, hhmm = entry.get('account'), entry.get('time')
        if not acct or not hhmm: continue
        key = f'{acct}|{hhmm}'
        if (state.get(key) or {}).get('date') == today:
            continue
        try:
            h, m = map(int, hhmm.split(':'))
            scheduled = now.replace(hour=h, minute=m, second=0, microsecond=0)
        except: continue
        if now < scheduled:
            continue
        if (now - scheduled).total_seconds() > 900:  # 15 min grace window
            state[key] = {'date': today, 'status': 'missed'}
            log_event('warmup_missed', account=acct, time=hhmm)
            changed = True; continue
        if not os.path.exists(os.path.join(CREDS_DIR, acct + '.json')):
            state[key] = {'date': today, 'status': 'missing_account'}
            changed = True; continue
        ok = do_warmup(acct)
        state[key] = {'date': today, 'status': 'ok' if ok else 'ping_failed'}
        changed = True
    if changed: save_warmup_state(state)

def get_claude_bin():
    try:
        p = open(os.path.join(RELAY_DIR, 'claude_bin')).read().strip()
        if p and os.path.exists(p): return p
    except: pass
    return shutil.which('claude') or 'claude'

def do_warmup(acct):
    do_switch(acct)
    log_event('warmup_switch', account=acct)
    try:
        r = subprocess.run([get_claude_bin(), '-p', 'ping', '--output-format', 'text'],
                            capture_output=True, timeout=120)
        ok = (r.returncode == 0)
        log_event('warmup_ping', account=acct, ok=ok)
        notify('relay', f'warmup: switched to {acct} 並完成 5hr session 預熱' if ok
                         else f'warmup: {acct} ping 失敗')
        return ok
    except Exception as e:
        log_event('warmup_ping', account=acct, ok=False, err=str(e))
        return False
```

Key behaviors:
- **No catch-up firing.** If the daemon didn't check in within 15 minutes of the scheduled time (offline, sleeping laptop, etc.), that day's slot is marked `missed` and skipped — it does not fire late.
- **Once per key per day.** The `date` field on a state record gates all outcomes (`ok`/`ping_failed`/`missed`/`missing_account`) equally, so a fired-but-failed ping also isn't retried until tomorrow.
- **Ping cost.** `claude -p "ping" --output-format text` is a minimal one-shot non-interactive call — no interactive session, exits immediately after the response.
- All outcomes are logged via the existing `log_event`/`autoswitch.log` and surfaced via the existing `notify()` desktop notification, matching current switch-event UX.

## Testing plan

1. `bash -n relay` syntax check.
2. Create 2 fake accounts, `relay warmup add acctA 06:00`, verify it lands in `autoswitch.json`.
3. Seed a schedule 5 minutes in the past, start the daemon, confirm `warmup_switch`/`warmup_ping` appear in `autoswitch.log` and a notification fires.
4. Seed a schedule 20 minutes in the past, confirm it's marked `missed` and does not fire.
5. `relay warmup list` shows correct status per entry.
6. Run the daemon twice within the same day, confirm no duplicate firing (gated by `date`).
