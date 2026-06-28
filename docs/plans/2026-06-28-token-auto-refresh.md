# Token Auto-Refresh Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make relay silently refresh expired OAuth access tokens during `relay list`, `relay status`, and the autoswitch daemon, so users never see "⚠ token expired" when the silent refresh would succeed.

**Architecture:** Wire the existing `try_refresh(name, cred_path)` function (relay:183) into `fetch()` (relay:229), `cmd_status()` heredoc (relay:401), and the autoswitch daemon. The daemon also gets a proactive 30-min refresh loop via `last_refresh_ts`. relay.ps1 gets a Windows PowerShell equivalent. A new `relay refresh-all` command lets users refresh all accounts explicitly.

**Tech Stack:** Bash (relay script), Python (inline heredoc blocks), PowerShell (relay.ps1). No new dependencies. Python stdlib: `urllib.request`, `urllib.parse`, `datetime`, `json`.

---

## Key Files

| File | What changes |
|------|-------------|
| `relay` (lines 229–263) | Replace `fetch()` with new design |
| `relay` (lines 401–422) | Patch `cmd_status()` heredoc |
| `relay` (lines 670–895) | Extend `_extract_daemon()` with `try_refresh_daemon()` + proactive loop |
| `relay` (new function) | Add `cmd_refresh_all()` with dispatch case |
| `relay.ps1` | Add `Invoke-TokenRefresh` + wire into `Show-Table` |
| `TODOS.md` | Already created — contains P2 refresh-token race, P3 cache lock |

## Review Log (already done — do NOT redo)

- `/office-hours` design doc: `~/.gstack/projects/darkstar1227-relay/office-hours-design-token-refresh-20260628.md`
- `/plan-ceo-review` plan: `~/.gstack/projects/darkstar1227-relay/ceo-plans/2026-06-28-token-auto-refresh.md`
- `/plan-eng-review` completed: 6 findings, all resolved, 0 unresolved decisions

---

## Task 1: Replace `fetch()` in relay (CORE — do this first)

**Files:**
- Modify: `relay` (lines 229–263 — the `fetch(name)` function inside `render_table()` heredoc)

**Background:** `fetch()` is called by `ThreadPoolExecutor` (relay:270) for every account in parallel. It currently returns `name, 'expired'` when `expiresAt` is in the past or a 401 is received. The new version calls `try_refresh()` instead.

The existing `try_refresh(name, cred_path)` at relay:183 already handles the OAuth POST — it's a wiring problem, not a mechanism problem.

**Step 1: Read the current fetch() to understand the exact text to replace**

Open `relay`, find lines 229–263:
```python
def fetch(name):
    cred_path = os.path.join(creds_dir, name + '.json')
    try:
        d = json.load(open(cred_path))
        oauth = d.get('claudeAiOauth') or {}
        tok = oauth.get('accessToken', '')
        if not tok:
            return name, None

        # Short-circuit: token is locally known to be expired
        expires_at_ms = oauth.get('expiresAt', 0)
        now_ms = datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000
        if expires_at_ms and now_ms > expires_at_ms:
            return name, 'expired'

        # Check cache
        c = load_cache()
        entry = c.get(name)
        if entry and now_ms / 1000 - entry.get('ts', 0) < CACHE_TTL:
            return name, entry.get('data')

        req = urllib.request.Request(
            'https://api.anthropic.com/api/oauth/usage',
            headers={'Authorization': 'Bearer ' + tok, 'User-Agent': 'relay/2.0'})
        with urllib.request.urlopen(req, timeout=6) as r:
            data = json.loads(r.read())
        c[name] = {'ts': now_ms / 1000, 'data': data}
        save_cache(c)
        return name, data
    except urllib.error.HTTPError as e:
        if e.code == 401:
            return name, 'expired'
        return name, None
    except Exception:
        return name, None
```

**Step 2: Replace with the new implementation**

Replace the entire `def fetch(name):` function with:

```python
def fetch(name, _retried=False):
    cred_path = os.path.join(creds_dir, name + '.json')
    was_refreshed = False
    try:
        d = json.load(open(cred_path))
        oauth = d.get('claudeAiOauth') or {}
        tok = oauth.get('accessToken', '')
        if not tok:
            return name, None

        expires_at_ms = oauth.get('expiresAt', 0)
        now_ms = datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000
        # Pre-emptive: refresh 5 minutes before expiry (300000ms)
        if expires_at_ms and now_ms > expires_at_ms - 300000:
            new_tok = try_refresh(name, cred_path)
            if new_tok:
                tok = new_tok
                was_refreshed = True
            elif now_ms > expires_at_ms:
                return name, 'expired'
            # else: pre-emptive window, refresh failed, token still valid — fall through

        c = load_cache()
        entry = c.get(name)
        if entry and now_ms / 1000 - entry.get('ts', 0) < CACHE_TTL and not was_refreshed:
            return name, entry.get('data')

        req = urllib.request.Request(
            'https://api.anthropic.com/api/oauth/usage',
            headers={'Authorization': 'Bearer ' + tok, 'User-Agent': 'relay/2.0'})
        with urllib.request.urlopen(req, timeout=6) as r:
            data = json.loads(r.read())
        c[name] = {'ts': now_ms / 1000, 'data': data}
        save_cache(c)
        return name, data
    except urllib.error.HTTPError as e:
        if e.code == 401 and not _retried:
            new_tok = try_refresh(name, cred_path)
            if new_tok:
                return fetch(name, _retried=True)
            return name, 'expired'
        return name, None
    except Exception:
        return name, None
```

**Step 3: Manual verification — expired token auto-refreshes**

```bash
# Pick any account (e.g. "work")
CRED=~/.claude-relay/credentials/work.json

# Read current expiresAt
python3 -c "import json; d=json.load(open('$CRED')); print(d['claudeAiOauth'].get('expiresAt'))"

# Set expiresAt to 1 minute ago (past)
python3 -c "
import json, time
d = json.load(open('$CRED'))
d['claudeAiOauth']['expiresAt'] = int(time.time() * 1000) - 60000
open('$CRED', 'w').write(json.dumps(d))
print('expiresAt set to past')
"

# Run relay list — should show usage (not "⚠ token expired")
relay list

# Verify expiresAt was updated (should now be ~1hr from now)
python3 -c "
import json, time
d = json.load(open('$CRED'))
exp = d['claudeAiOauth'].get('expiresAt', 0)
print(f'expiresAt: {exp}')
print(f'minutes from now: {(exp/1000 - time.time())/60:.0f}')
"
```

Expected: `relay list` shows usage bars, not "⚠ token expired". expiresAt is ~60 minutes in the future.

**Step 4: Manual verification — dead refreshToken shows hint correctly**

```bash
# Corrupt the refreshToken
python3 -c "
import json
d = json.load(open('$CRED'))
d['claudeAiOauth']['refreshToken'] = 'dead'
d['claudeAiOauth']['expiresAt'] = int(__import__('time').time() * 1000) - 60000
open('$CRED', 'w').write(json.dumps(d))
print('refreshToken set to dead, expiresAt set to past')
"

relay list
```

Expected: account shows `⚠ token expired` and hint to run `relay refresh work`.

> **Restore the account after testing:** `relay add work` or `relay refresh work`

**Step 5: Commit**

```bash
git add relay
git commit -m "feat: auto-refresh expired tokens in relay list

Wire try_refresh() into fetch(): pre-emptive 5-min refresh, 401
reactive retry with _retried guard, was_refreshed flag for cache
invalidation."
```

---

## Task 2: Patch `cmd_status()` to also auto-refresh

**Files:**
- Modify: `relay` (lines ~401–422, inside `cmd_status()` function's Python heredoc)

**Background:** `cmd_status()` has its OWN Python heredoc (relay:401) that makes its own usage API call — it does NOT use `fetch()` from `render_table()`. So Task 1 alone does NOT fix `relay status`. This was caught by the Codex outside voice review.

**Step 1: Find the heredoc in cmd_status()**

Open `relay`, find this block (starts around line 401):
```python
try:
    d = json.load(open(creds_path))
    tok = (d.get('claudeAiOauth') or {}).get('accessToken', '')
    if not tok:
        print(f'\n  {YL}⚠ No access token — please log in again{R}'); sys.exit(0)
    req = urllib.request.Request(
        'https://api.anthropic.com/api/oauth/usage',
        headers={'Authorization': 'Bearer ' + tok, 'User-Agent': 'relay/2.0'})
    with urllib.request.urlopen(req, timeout=8) as r:
        u = json.loads(r.read())
except Exception as e:
    print(f'\n  {RD}✗ Usage query failed: {e}{R}'); sys.exit(0)
```

**Step 2: Add try_refresh logic before the usage call**

Note: `creds_path` is `sys.argv[1]` in this heredoc. The file also needs `urllib.parse` imported — check the import line at the top of this heredoc.

Add `urllib.parse` to the import if missing, then replace the `try:` block with:

```python
import urllib.parse

def _try_refresh(cred_path):
    try:
        d2 = json.load(open(cred_path))
        oauth2 = d2.get('claudeAiOauth') or {}
        rt = oauth2.get('refreshToken', '')
        if not rt:
            return None
        params = urllib.parse.urlencode({'grant_type': 'refresh_token', 'refresh_token': rt}).encode()
        req2 = urllib.request.Request(
            'https://api.anthropic.com/token',
            data=params,
            headers={'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'relay/2.0'})
        with urllib.request.urlopen(req2, timeout=10) as r2:
            resp = json.loads(r2.read())
        oauth2['accessToken'] = resp['access_token']
        if 'refresh_token' in resp:
            oauth2['refreshToken'] = resp['refresh_token']
        oauth2['expiresAt'] = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000) + resp.get('expires_in', 3600) * 1000
        d2['claudeAiOauth'] = oauth2
        import os
        open(cred_path, 'w').write(json.dumps(d2))
        os.chmod(cred_path, 0o600)
        return oauth2['accessToken']
    except Exception:
        return None

try:
    d = json.load(open(creds_path))
    oauth = d.get('claudeAiOauth') or {}
    tok = oauth.get('accessToken', '')
    if not tok:
        print(f'\n  {YL}⚠ No access token — please log in again{R}'); sys.exit(0)

    expires_at_ms = oauth.get('expiresAt', 0)
    now_ms = datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000
    if expires_at_ms and now_ms > expires_at_ms - 300000:
        new_tok = _try_refresh(creds_path)
        if new_tok:
            tok = new_tok
        elif now_ms > expires_at_ms:
            print(f'\n  {YL}⚠ Token expired — run: relay refresh {name}{R}'); sys.exit(0)

    req = urllib.request.Request(
        'https://api.anthropic.com/api/oauth/usage',
        headers={'Authorization': 'Bearer ' + tok, 'User-Agent': 'relay/2.0'})
    with urllib.request.urlopen(req, timeout=8) as r:
        u = json.loads(r.read())
except Exception as e:
    print(f'\n  {RD}✗ Usage query failed: {e}{R}'); sys.exit(0)
```

> **Note:** `datetime` must be imported in this heredoc — check the top of the `cmd_status()` heredoc block. It already has `import json, sys, datetime, urllib.request` — add `import urllib.parse` on that line.

**Step 3: Manual verification**

```bash
# Set expiresAt to past on current account
CURRENT=$(cat ~/.claude-relay/current)
CRED=~/.claude-relay/credentials/$CURRENT.json
python3 -c "
import json, time
d = json.load(open('$CRED'))
d['claudeAiOauth']['expiresAt'] = int(time.time() * 1000) - 60000
open('$CRED', 'w').write(json.dumps(d))
print('done')
"

relay status
```

Expected: shows usage bars, NOT "✗ Usage query failed: HTTP Error 401".

**Step 4: Commit**

```bash
git add relay
git commit -m "feat: auto-refresh expired token in relay status

Mirrors Task 1's logic: expiresAt check + _try_refresh() inline
helper in cmd_status() heredoc. Codex caught this gap."
```

---

## Task 3: Add `try_refresh_daemon()` to the autoswitch daemon

**Files:**
- Modify: `relay` (the `_extract_daemon()` function, lines ~670–895 — the heredoc written to `~/.claude-relay/autoswitch-daemon.py`)

**Background:** The daemon runs as a background LaunchAgent/systemd service. It has its OWN Python file (extracted from the relay bash script). It has its own `fetch_usage()` (daemon:784) that currently returns `'expired'` without attempting refresh. Two things needed:
1. `try_refresh_daemon()` — inline refresh function that also calls `kc_write()` for the current account
2. `last_refresh_ts` proactive loop — refresh all accounts every 30 minutes at the top of the main loop

**Critical:** The daemon's `try_refresh_daemon()` MUST call `kc_write()` when refreshing the current account. If it doesn't, `do_switch()` (daemon:763) will read the OLD expired token from keychain and overwrite the refreshed file.

**Step 1: Add `try_refresh_daemon()` after `save_cache()` in the daemon heredoc**

Find `save_cache()` in the `_extract_daemon()` heredoc (around daemon line 779), then add after it:

```python
def try_refresh_daemon(name, cred_path):
    # ponytail: intentional copy of update_live_creds() logic — daemon is standalone
    try:
        d = json.load(open(cred_path))
        oauth = d.get('claudeAiOauth') or {}
        rt = oauth.get('refreshToken', '')
        if not rt:
            return None
        import urllib.parse
        params = urllib.parse.urlencode({'grant_type': 'refresh_token', 'refresh_token': rt}).encode()
        req = urllib.request.Request(
            'https://api.anthropic.com/token',
            data=params,
            headers={'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'relay/2.0'})
        with urllib.request.urlopen(req, timeout=10) as r:
            resp = json.loads(r.read())
        oauth['accessToken'] = resp['access_token']
        if 'refresh_token' in resp:
            oauth['refreshToken'] = resp['refresh_token']
        oauth['expiresAt'] = int(time.time() * 1000) + resp.get('expires_in', 3600) * 1000
        d['claudeAiOauth'] = oauth
        content = json.dumps(d)
        open(cred_path, 'w').write(content)
        os.chmod(cred_path, 0o600)
        current = open(CURRENT_FILE).read().strip() if os.path.exists(CURRENT_FILE) else ''
        if name == current:
            kc_write(content)  # critical: update keychain or do_switch() will clobber
        return oauth['accessToken']
    except Exception:
        return None
```

**Step 2: Modify `fetch_usage()` to call `try_refresh_daemon()` on expired token**

Find `fetch_usage()` in the daemon heredoc (around daemon:784). Replace the expiry check:

**Before:**
```python
        expires_at_ms = oauth.get('expiresAt', 0)
        now_ms = time.time() * 1000
        if expires_at_ms and now_ms > expires_at_ms: return 'expired'
```

**After:**
```python
        expires_at_ms = oauth.get('expiresAt', 0)
        now_ms = time.time() * 1000
        if expires_at_ms and now_ms > expires_at_ms - 300000:
            new_tok = try_refresh_daemon(name, cred_path)
            if new_tok:
                tok = new_tok
            elif now_ms > expires_at_ms:
                return 'expired'
```

**Step 3: Add `last_refresh_ts` proactive loop to `main()`**

Find `def main():` in the daemon heredoc (around daemon:834). Add `last_refresh_ts = 0` before the `while True:` loop, and add the proactive refresh check at the top of the loop:

**Before:**
```python
def main():
    check_single_instance()
    rotate_log()
    log_event('start')

    while True:
        cfg = load_config()
```

**After:**
```python
def main():
    check_single_instance()
    rotate_log()
    log_event('start')
    last_refresh_ts = 0

    while True:
        # Proactive refresh: every 30 minutes, refresh all account tokens
        if time.time() - last_refresh_ts > 1800:
            for cred_file in os.listdir(CREDS_DIR) if os.path.isdir(CREDS_DIR) else []:
                if cred_file.endswith('.json'):
                    acct = cred_file[:-5]
                    try_refresh_daemon(acct, os.path.join(CREDS_DIR, cred_file))
            last_refresh_ts = time.time()

        cfg = load_config()
```

**Step 4: Manual verification — daemon refreshes expired token**

```bash
# Restart daemon to pick up new code
relay autoswitch stop
relay autoswitch start

# Set a non-current account's token to expired
OTHER=$(cat ~/.claude-relay/credentials/*.json | python3 -c "
import sys, json, os, glob
current = open(os.path.expanduser('~/.claude-relay/current')).read().strip()
for f in glob.glob(os.path.expanduser('~/.claude-relay/credentials/*.json')):
    name = os.path.basename(f)[:-5]
    if name != current:
        print(name)
        break
" 2>/dev/null)

if [ -n "$OTHER" ]; then
  python3 -c "
import json, time
p = os.path.expanduser(f'~/.claude-relay/credentials/$OTHER.json')
d = json.load(open(p))
d['claudeAiOauth']['expiresAt'] = int(time.time() * 1000) - 60000
open(p, 'w').write(json.dumps(d))
print(f'Set $OTHER expiresAt to past')
"
fi

# Wait for one polling cycle (low_minutes default = 10, but proactive loop checks every 1800s)
# For a faster test: stop, edit last_refresh_ts to force immediate refresh, restart
# Or just run relay list and verify it works (Task 1 handles the CLI side)
relay list
```

**Step 5: Commit**

```bash
git add relay
git commit -m "feat: add try_refresh_daemon() to autoswitch daemon

Reactive: fetch_usage() now calls try_refresh_daemon() on expired token.
Proactive: main loop refreshes all accounts every 30 min via last_refresh_ts.
Critical: kc_write() called when refreshing current account to prevent
do_switch() from overwriting refreshed token with stale keychain value."
```

---

## Task 4: Add `relay refresh-all` command

**Files:**
- Modify: `relay` — add `cmd_refresh_all()` bash function + dispatch case

**Background:** A new command for users to explicitly refresh all accounts at once. Since `try_refresh()` is inside `render_table()`'s heredoc and not accessible to bash, `cmd_refresh_all()` needs its OWN self-contained Python heredoc with `try_refresh()` logic inline.

**Step 1: Add `cmd_refresh_all()` function**

Add this function after `cmd_refresh()` (around line 570), before `cmd_remove()`:

```bash
cmd_refresh_all() {
  hdr "Refresh all accounts (silent OAuth refresh)"
  local current; current=$(current_name)
  "${PY}" - "${RELAY_DIR}" "${current}" <<'EOF'
import json, os, sys, urllib.request, urllib.parse, datetime, subprocess, platform, glob

relay_dir, current = sys.argv[1], sys.argv[2]
creds_dir = os.path.join(relay_dir, 'credentials')
R='\033[0m'; B='\033[1m'; GR='\033[32m'; RD='\033[31m'; YL='\033[33m'; D='\033[2m'

def update_live_creds(content):
    # ponytail: intentional copy of update_live_creds() — this heredoc is standalone
    if platform.system() == 'Darwin':
        user = subprocess.run(['whoami'], capture_output=True, text=True).stdout.strip()
        svc = 'Claude Code-credentials'
        subprocess.run(['security', 'delete-generic-password', '-s', svc, '-a', user], capture_output=True)
        subprocess.run(['security', 'add-generic-password', '-s', svc, '-a', user, '-w', content], capture_output=True)
    else:
        live = os.path.join(os.path.expanduser('~'), '.claude', '.credentials.json')
        with open(live, 'w') as f: f.write(content)
        os.chmod(live, 0o600)

def try_refresh(name, cred_path):
    try:
        d = json.load(open(cred_path))
        oauth = d.get('claudeAiOauth') or {}
        rt = oauth.get('refreshToken', '')
        if not rt:
            return None, 'no refresh token'
        params = urllib.parse.urlencode({'grant_type': 'refresh_token', 'refresh_token': rt}).encode()
        req = urllib.request.Request(
            'https://api.anthropic.com/token',
            data=params,
            headers={'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'relay/2.0'})
        with urllib.request.urlopen(req, timeout=10) as r:
            resp = json.loads(r.read())
        oauth['accessToken'] = resp['access_token']
        if 'refresh_token' in resp:
            oauth['refreshToken'] = resp['refresh_token']
        oauth['expiresAt'] = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000) + resp.get('expires_in', 3600) * 1000
        d['claudeAiOauth'] = oauth
        content = json.dumps(d)
        with open(cred_path, 'w') as f: f.write(content)
        os.chmod(cred_path, 0o600)
        if name == current:
            update_live_creds(content)
        return resp['access_token'], None
    except Exception as e:
        return None, str(e)

names = sorted(os.path.basename(p)[:-5] for p in glob.glob(os.path.join(creds_dir, '*.json')))
if not names:
    print(f'  {YL}No accounts found{R}')
    sys.exit(0)

refreshed = 0
for name in names:
    cred_path = os.path.join(creds_dir, name + '.json')
    tok, err = try_refresh(name, cred_path)
    marker = f'{GR}✓{R}' if tok else f'{RD}✗{R}'
    label = f'{B}{name}{R}'
    if tok:
        refreshed += 1
        print(f'  {marker} {label} refreshed')
    else:
        print(f'  {marker} {label} {D}({err}){R}')

print(f'\n  {D}{refreshed}/{len(names)} refreshed{R}')
EOF
}
```

**Step 2: Add dispatch case**

Find the `case "${CMD}" in` block (around line 1461). Add after the `refresh)` line:

```bash
  refresh-all)      cmd_refresh_all ;;
```

**Step 3: Add to help output**

Find `cmd_help()` (around line 1422). Add a line in the commands section:
```bash
  printf "  %-32s %s\n" "  relay refresh-all"        "silently refresh all account tokens"
```

**Step 4: Manual verification**

```bash
relay refresh-all
```

Expected output:
```
  Refresh all accounts (silent OAuth refresh)
  ─────────────────────────────────────────
  ✓ personal refreshed
  ✓ work refreshed

  2/2 refreshed
```

**Step 5: Commit**

```bash
git add relay
git commit -m "feat: add relay refresh-all command

Silently refreshes all account tokens via OAuth refresh_token grant.
Self-contained Python heredoc (not reusing render_table block)."
```

---

## Task 5: Windows parity — add `Invoke-TokenRefresh` to relay.ps1

**Files:**
- Modify: `relay.ps1` (add function after `Get-Usage`, wire into `Show-Table`)

**Step 1: Add `Invoke-TokenRefresh` function**

Open `relay.ps1`. After `Get-Usage` (around line 121), add:

```powershell
function Invoke-TokenRefresh([string]$credPath) {
    try {
        $d      = Get-Content $credPath -Raw | ConvertFrom-Json
        $oauth  = $d.claudeAiOauth
        $rt     = $oauth.refreshToken
        if (-not $rt) { return $null }

        $body = "grant_type=refresh_token&refresh_token=$([Uri]::EscapeDataString($rt))"
        $resp = Invoke-RestMethod "https://api.anthropic.com/token" `
            -Method Post `
            -Body $body `
            -ContentType "application/x-www-form-urlencoded" `
            -Headers @{ "User-Agent" = "relay/2.0" } `
            -TimeoutSec 10

        $oauth.accessToken = $resp.access_token
        if ($resp.refresh_token) { $oauth.refreshToken = $resp.refresh_token }
        $oauth.expiresAt   = [long]([System.DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) + ($resp.expires_in ?? 3600) * 1000
        $d.claudeAiOauth   = $oauth
        $d | ConvertTo-Json -Depth 10 | Set-Content $credPath -NoNewline -Encoding UTF8
        return $resp.access_token
    } catch {
        return $null
    }
}
```

**Step 2: Wire into `Show-Table` — add expiry check before `Get-Usage`**

In `Show-Table` (around relay.ps1:174–179), find:
```powershell
        foreach ($n in $names) {
            $tok = Get-Token (Get-Content (Get-CredsPath $n) -Raw -ErrorAction SilentlyContinue)
            $usage[$n] = if ($tok) { Get-Usage $tok } else { $null }
        }
```

Replace with:
```powershell
        foreach ($n in $names) {
            $credPath = Get-CredsPath $n
            $raw = Get-Content $credPath -Raw -ErrorAction SilentlyContinue
            if ($raw) {
                $cred = $raw | ConvertFrom-Json
                $expAt = [long]($cred.claudeAiOauth.expiresAt ?? 0)
                $nowMs = [long]([System.DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
                if ($expAt -gt 0 -and $nowMs -gt ($expAt - 300000)) {
                    $newTok = Invoke-TokenRefresh $credPath
                    if ($newTok) { $raw = Get-Content $credPath -Raw }
                }
            }
            $tok = Get-Token $raw
            $usage[$n] = if ($tok) { Get-Usage $tok } else { $null }
        }
```

**Step 3: Manual verification (Windows only)**

On a Windows machine with relay installed:
```powershell
# Set expiresAt to past
$cred = "~\.claude-relay\credentials\work.json"
$d = Get-Content $cred | ConvertFrom-Json
$d.claudeAiOauth.expiresAt = [long]([System.DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) - 60000
$d | ConvertTo-Json -Depth 10 | Set-Content $cred

relay list
```

Expected: account shows usage bars, not expired warning.

> If no Windows machine available, skip manual test and note in commit message.

**Step 4: Commit**

```bash
git add relay.ps1
git commit -m "feat: add token auto-refresh to relay.ps1 (Windows parity)

Invoke-TokenRefresh POSTs to /token endpoint. Show-Table checks
expiresAt and calls Invoke-TokenRefresh before Get-Usage."
```

---

## Task 6: Add marker comments at keychain-write sites (housekeeping)

**Files:**
- Modify: `relay` (two sites in `_extract_daemon()` heredoc)

**Step 1: Find `kc_write()` in the daemon heredoc (relay ~line 751)**

Add one-line comment above the function:
```python
# ponytail: intentional copy of update_live_creds() — daemon is a standalone extracted script
def kc_write(content):
```

**Step 2: Commit**

```bash
git add relay
git commit -m "chore: add intentional-copy marker at daemon keychain-write sites"
```

---

## Task 7: Version bump, changelog, release, publish

**Step 1: Verify all manual tests pass**

Run through each verification from Tasks 1–5. Confirm no regressions in `relay list`, `relay switch`, `relay status`, `relay autoswitch status`.

**Step 2: Bump version**

```bash
npm version minor
# This updates package.json to v2.2.0 and creates git tag v2.2.0
```

**Step 3: Add changelog entry to README.md**

Add to the `## Changelog` section:
```markdown
### v2.2.0 — 2026-06-28
- Auto-refresh expired OAuth tokens in `relay list`, `relay status`, and autoswitch daemon
- Pre-emptive refresh: tokens refreshed 5 minutes before expiry (no more expiry surprises mid-session)
- `relay refresh-all` — new command to silently refresh all account tokens at once
- Autoswitch daemon: proactive 30-min token refresh loop + reactive refresh on expired token
- Windows: `relay.ps1` now auto-refreshes tokens via `Invoke-TokenRefresh`
- `TODOS.md` created with P2 (refresh-token rotation race) and P3 (cache file lock) for future work
```

**Step 4: Push tags and publish**

```bash
git push && git push --tags
npm publish --access public
```

**Step 5: Create GitHub release**

```bash
gh release create v2.2.0 --title "v2.2.0" --notes "$(cat <<'EOF'
## Token Auto-Refresh

relay now silently refreshes expired OAuth access tokens — no more "⚠ token expired" interruptions.

### What's new
- **Auto-refresh in relay list**: expired tokens are refreshed inline before displaying usage
- **Auto-refresh in relay status**: current account token refreshed before usage query
- **Pre-emptive refresh**: tokens refreshed 5 minutes before expiry, not just after
- **relay refresh-all**: new command to refresh all account tokens at once
- **Daemon reactive**: autoswitch daemon refreshes expired tokens before switch decisions
- **Daemon proactive**: daemon refreshes all tokens every 30 minutes
- **Windows parity**: relay.ps1 now includes Invoke-TokenRefresh

`relay refresh <name>` (browser login) is now reserved for truly dead accounts — when the refresh token itself expires after 30 days of no use.
EOF
)"
```

---

## Execution Handoff

Plan complete and saved to `docs/plans/2026-06-28-token-auto-refresh.md`.

**Two execution options:**

**1. Subagent-Driven (this session)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Parallel Session (separate)** — Open new session with `superpowers:executing-plans`, batch execution with checkpoints.

Which approach?
