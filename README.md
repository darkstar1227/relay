# relay

A lightweight CLI tool for switching between multiple Claude Code accounts instantly.

## Platform Support

| Platform | Credential Storage |
|----------|--------------------|
| macOS | Keychain (`Claude Code-credentials`) |
| Linux / WSL | `~/.claude/.credentials.json` |
| Windows | `%USERPROFILE%\.claude\.credentials.json` |

## Requirements

- [`claude`](https://docs.anthropic.com/en/docs/claude-code) CLI installed
- macOS / Linux / WSL: `python3` available
- Windows: PowerShell 5.1+ (built into Windows 10/11)

---

## Installation

### npx (no install required)

Run once without installing anything permanently:

```bash
npx @dst-justin/relay install
```

This copies the `relay` script to `/usr/local/bin/relay` (or `~/bin/relay` as fallback). After that, use `relay` directly.

---

### npm (global install — recommended)

Requires Node.js 16+. Installs the `relay` command globally:

```bash
npm install -g @dst-justin/relay
```

To update later:

```bash
npm update -g @dst-justin/relay
# or from inside relay:
relay update
```

---

### macOS / Linux / WSL (manual, no Node.js)

```bash
git clone https://github.com/darkstar1227/relay.git
cd relay

# Make the script executable
chmod +x relay

# Install (copies script to /usr/local/bin)
./relay install
```

This copies the script to `/usr/local/bin/relay` (falls back to `~/bin/relay` if permissions are restricted).

#### Verify permissions

```bash
ls -l $(which relay)
# expected: -rwxr-xr-x ... or lrwxr-xr-x ...

ls -la ~/.claude-relay/
# expected: drwx------  ~/.claude-relay/
# expected: drwx------  ~/.claude-relay/credentials/
```

If any permissions are wrong:

```bash
chmod 700 ~/.claude-relay ~/.claude-relay/credentials
chmod 600 ~/.claude-relay/credentials/*.json
```

---

### Windows (CMD / PowerShell, manual)

If you prefer not to use npm, clone the repo and add it to PATH manually.

```powershell
git clone https://github.com/darkstar1227/relay.git
cd relay
```

**Add to PATH permanently:**

```powershell
$dir = (Get-Location).Path
[Environment]::SetEnvironmentVariable(
    "PATH",
    "$([Environment]::GetEnvironmentVariable('PATH','User'));$dir",
    "User"
)
```

Restart your terminal after running this.

**Allow the script to execute (first time only):**

```powershell
Unblock-File .\relay.ps1
```

**Verify:**

```powershell
relay help
```

---

## Quick Start

```bash
# Add your first account (opens browser — must run outside Claude Code)
relay add personal

# Add a second account
relay add work

# Switch accounts
relay 2        # by index
relay work     # by name
```

## Usage Inside Claude Code

Prefix commands with `!` to run them inline:

| Command | Description |
|---------|-------------|
| `!relay` | Account menu with 5-hour usage |
| `!relay 2` | Switch to account #2 |
| `!relay work` | Switch to account named "work" |
| `!relay status` | Detailed usage for current account |

## Account Management

| Command | Description |
|---------|-------------|
| `relay add <name>` | Add account via browser login |
| `relay add-force <name>` | Force re-login for existing account |
| `relay save <name>` | Save current login state as a named account |
| `relay rename <old> <new>` | Rename an account |
| `relay list` | Full list with weekly usage |
| `relay list --no-usage` | List without querying the API |
| `relay remove <name>` | Delete an account |
| `relay sessions` | Show all Claude Code sessions |
| `relay version` | Show current version |
| `relay update` | Check GitHub releases and update to the latest version |
| `relay uninstall` | Remove relay and all account data (macOS/Linux only) |
| `relay autoswitch config` | Interactive setup wizard |
| `relay autoswitch start` | Install and start background daemon |
| `relay autoswitch stop` | Stop and remove daemon |
| `relay autoswitch status` | Daemon state and per-account thresholds |
| `relay autoswitch log` | Recent auto-switch history |
| `relay warmup add <account> <HH:MM>` | Schedule an account warmup time |
| `relay warmup remove <account> [HH:MM]` | Remove one or all warmup times for an account |
| `relay warmup list` | Show configured warmup schedules |
| `relay warmup pause` / `relay warmup resume` | Temporarily pause or resume warmups |

## Autoswitch

relay can automatically switch accounts when a 5-hour usage threshold is hit.

**Setup:**

```bash
relay autoswitch config   # interactive wizard
relay autoswitch start    # install daemon (launchd / systemd / cron)
relay autoswitch status   # verify it's running
```

**Config file** (`~/.claude-relay/autoswitch.json`):

```json
{
  "order": ["work", "personal", "backup"],
  "thresholds": { "work": 70, "personal": 80 },
  "poll": { "low_minutes": 10, "high_minutes": 2, "high_threshold": 50 }
}
```

- Only accounts listed in `order` with a `thresholds` entry participate.
- No config file = autoswitch disabled entirely.
- Manual switches (`!relay work`) are respected until that account hits its threshold.
- If all accounts are over threshold, relay switches to the least-used one.

## Warmup

Warmup runs a real, non-interactive `claude -p ping` call to Anthropic's API on your machine in the background at the scheduled time — it does not send your credentials anywhere, and it does not increase your weekly usage cap. It only starts your rolling 5-hour usage window earlier.

Use warmup when you want an account's 5-hour usage window to start before you sit down to work.

```bash
relay warmup add <account> <HH:MM>     # e.g. relay warmup add work 06:00
relay warmup remove <account> [HH:MM]
relay warmup list
relay warmup pause
relay warmup resume
```

Warmup requires the autoswitch daemon to be running (`relay autoswitch start`) to actually fire. `relay warmup add` warns if the daemon is not running.

**Config shape** (`~/.claude-relay/autoswitch.json`):

```json
{
  "warmup_enabled": true,
  "warmup": [
    { "account": "work", "time": "06:00" },
    { "account": "personal", "time": "08:30" }
  ]
}
```

## How It Works

relay stores a snapshot of each account's OAuth credentials in `~/.claude-relay/credentials/`. Switching writes the target account's credentials back into the store that Claude Code reads from.

Sessions live in `~/.claude/projects/` and are shared across all accounts — after switching, use `claude -c` to resume the last session or `claude --resume <id>` to pick a specific one.

> **Note:** `relay add` must be run in a regular Terminal, not inside Claude Code, because the browser login flow is not available inside an active session.

## Files

```
~/.claude-relay/
├── credentials/   # Per-account credential snapshots (chmod 700 on Unix)
├── meta/          # Per-account email cache
└── current        # Name of the active account
```

### Windows-specific files

| File | Purpose |
|------|---------|
| `relay.ps1` | Full PowerShell implementation |
| `relay.cmd` | Thin CMD wrapper — delegates to `relay.ps1` |


---

## Changelog

### v2.2.7 — 2026-07-05
- `relay lock <name>` / `relay unlock <name>`: lock an account so it won't be cycled back to when over its usage threshold
- `relay lock` (no args): show locked accounts
- Autoswitch daemon now auto-enables with default 80% threshold when 2+ accounts exist — no config required
- Cycling follows `order` sequence; locked+over-threshold accounts are skipped; if all candidates are blocked, stays on current account and notifies
- Lock badge (🔒) shown in `relay list` and `relay autoswitch status`

### v2.2.6 — 2026-07-04
- `relay status -f` / `relay status --follow`: live-refresh current account status, same 30-second interval as `relay list -f`

### v2.2.5 — 2026-07-04
- `relay list -f` / `relay list --follow`: live-refresh mode — clears the screen and redraws the account table every 30 seconds, Ctrl+C to exit

### v2.2.4 — 2026-07-04
- Fix: `relay switch` from another terminal no longer gets clobbered by a concurrent `relay list` / `!relay` menu run. Root cause: `try_refresh()` in the parallel usage-fetch used a stale snapshot of the current account, causing it to write the old account's refreshed token back to keychain and undo the switch. Now reads `CURRENT_FILE` freshly at write time.
- Active sessions pick up an account switch on the next message without restarting

### v2.2.3 — 2026-06-28
- Fix OAuth token refresh: use correct endpoint (`/v1/oauth/token`), required `client_id`, and `anthropic-version: oauth-2025-04-20` header — `relay refresh-all` now works

### v2.2.0 — 2026-06-28
- Silent OAuth auto-refresh: `relay list` and `relay status` now silently refresh expired tokens using the stored `refreshToken` — no browser login needed for routine expiry
- Pre-emptive refresh: tokens are refreshed 5 minutes before expiry, not just after
- Autoswitch daemon now refreshes tokens proactively every 30 minutes and on expiry detection, ensuring the daemon never switches to a dead account
- New `relay refresh-all` command: silently refreshes all accounts via OAuth in one go
- Windows (`relay.ps1`): token refresh wired into `Show-Table` usage loop

### v2.1.1 — 2026-06-24
- Display current version and latest version at the end of `list`, `status`, `relay` (menu), `sessions`, and `help` commands
- Background version check (24h cache) — non-blocking, never slows down output
- `relay update` now detects original install method: uses `npm install -g` for npm installs, `git pull` for git clones, and direct GitHub download for bare script copies
- `npm install -g` post-install script automatically patches `~/.bashrc`, `~/.zshrc`, `~/.profile`, and fish `config.fish` if the npm bin dir is missing from PATH

### v2.1.3 — 2026-06-24
- `relay autoswitch` with no subcommand: auto-routes to config wizard (first time) or status panel (already configured)
- Autoswitch status and log panels now show version info and update notice at the bottom
- Status panel shows available commands inline

### v2.1.2 — 2026-06-24
- Improve autoswitch config wizard: 3-step flow with numbered account list, space-separated number input for order, visual chain preview (`work → personal → (cycle)`), and summary after save
- `relay update` now writes the live-fetched version to cache immediately, so display commands reflect the latest version without waiting 24h

### v2.1.0 — 2026-06-24
- Upgraded GitHub Actions workflow to `actions/checkout@v6` and `actions/setup-node@v6` (Node 24 runtime, removes Node 20 deprecation warning)

### v2.0.2 — 2026-06-23
- Skip `npm install` during `relay update` when already on the latest version or when version check fails

## License

MIT © [darkstar1227](https://github.com/darkstar1227)
