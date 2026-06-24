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

