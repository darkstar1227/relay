#!/usr/bin/env pwsh
# ─────────────────────────────────────────────────────────────────────────────
# relay.ps1 — multi-account switcher for Claude Code  (Windows / PowerShell 5.1+)
# Usage: relay [command] [args...]
#   relay list          show accounts with usage
#   relay add <name>    add account via browser login
#   relay 2 / relay work  switch by index or name
# ─────────────────────────────────────────────────────────────────────────────
param(
    [Parameter(Position = 0)] [string]$Cmd  = "",
    [Parameter(Position = 1, ValueFromRemainingArguments = $true)] [string[]]$Rest = @()
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$RELAY_DIR    = Join-Path $HOME ".claude-relay"
$CREDS_STORE  = Join-Path $RELAY_DIR "credentials"
$META_STORE   = Join-Path $RELAY_DIR "meta"
$CURRENT_FILE = Join-Path $RELAY_DIR "current"
$CLAUDE_DIR   = Join-Path $HOME ".claude"
$LIVE_CREDS   = Join-Path $CLAUDE_DIR ".credentials.json"

# ── ANSI colors ───────────────────────────────────────────────────────────────
$e  = [char]27
$R  = "$e[0m"; $B = "$e[1m"; $D = "$e[2m"
$CY = "$e[36m"; $GR = "$e[32m"; $YL = "$e[33m"; $RD = "$e[31m"; $MG = "$e[35m"

# Enable VT processing on legacy Windows Console (no-op in Windows Terminal / pwsh)
if ($env:OS -eq "Windows_NT") {
    try {
        Add-Type -Name VTEnable -Namespace Win32 -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int h);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out uint m);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h, uint m);
'@ -ErrorAction SilentlyContinue
        $h = [Win32.VTEnable]::GetStdHandle(-11); $m = 0u
        [Win32.VTEnable]::GetConsoleMode($h, [ref]$m) | Out-Null
        [Win32.VTEnable]::SetConsoleMode($h, ($m -bor 4)) | Out-Null
    } catch {}
}

function fLog($t)  { Write-Host "  ${CY}->  ${R}$t" }
function fOk($t)   { Write-Host "  ${GR}✓${R} $t" }
function fWarn($t) { Write-Host "  ${YL}⚠${R} $t" }
function fErr($t)  { Write-Host "  ${RD}✗${R} $t" }
function fHdr($t)  {
    Write-Host ""
    Write-Host "  ${B}${MG}${t}${R}"
    Write-Host "  ${D}─────────────────────────────────────${R}"
}

# ── Directory setup ───────────────────────────────────────────────────────────
foreach ($d in @($CREDS_STORE, $META_STORE, $CLAUDE_DIR)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory $d -Force | Out-Null }
}

# ── Core helpers ──────────────────────────────────────────────────────────────
function Get-CurrentName {
    if (Test-Path $CURRENT_FILE) { ([System.IO.File]::ReadAllText($CURRENT_FILE)).Trim() }
    else { "" }
}
function Get-CredsPath($n) { Join-Path $CREDS_STORE "$n.json" }
function Get-MetaPath($n)  { Join-Path $META_STORE $n }
function Test-Account($n)  { Test-Path (Get-CredsPath $n) }

function Get-AccountNames {
    if (-not (Test-Path $CREDS_STORE)) { return @() }
    @(Get-ChildItem $CREDS_STORE -Filter "*.json" | ForEach-Object { $_.BaseName } | Sort-Object)
}

function Get-AccountByIndex([int]$i) {
    $names = Get-AccountNames
    if ($i -lt 1 -or $i -gt $names.Count) { return $null }
    $names[$i - 1]
}

# Write UTF-8 without BOM (JSON files must not have BOM)
function Write-NoBOM($path, $content) {
    [System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))
}

function Get-First($arr)         { $arr | Where-Object { $_ -ne '--no-usage' } | Select-Object -First 1 }
function Get-Second($arr)        { $arr | Where-Object { $_ -ne '--no-usage' } | Select-Object -Skip 1 -First 1 }

# ── Live credential store ──────────────────────────────────────────────────────
# Claude Code on Windows stores OAuth credentials at $HOME\.claude\.credentials.json
function Read-LiveCreds {
    if (Test-Path $LIVE_CREDS) { return [System.IO.File]::ReadAllText($LIVE_CREDS).Trim() }
    return $null
}

function Get-Token($json) {
    try { return ($json | ConvertFrom-Json).claudeAiOauth.accessToken } catch { return "" }
}

# ── Email meta ────────────────────────────────────────────────────────────────
function Get-EmailFromClaude {
    $f = Join-Path $HOME ".claude.json"
    if (-not (Test-Path $f)) { return "" }
    try { return (Get-Content $f -Raw | ConvertFrom-Json).oauthAccount.emailAddress } catch { return "" }
}

function Get-MetaEmail($n) {
    $f = Get-MetaPath $n
    if (Test-Path $f) { return [System.IO.File]::ReadAllText($f).Trim() }
    return "—"
}

function Save-MetaEmail($n) {
    $email = Get-EmailFromClaude
    if ($email) { Write-NoBOM (Get-MetaPath $n) $email }
}

# ── Usage API ─────────────────────────────────────────────────────────────────
function Get-Usage($tok) {
    try {
        return Invoke-RestMethod "https://api.anthropic.com/api/oauth/usage" `
            -Headers @{ Authorization = "Bearer $tok"; "User-Agent" = "relay/2.0" } `
            -TimeoutSec 6
    } catch { return $null }
}

function New-Bar([int]$pct, [int]$w = 10) {
    $f = [int]([Math]::Round($pct / 100.0 * $w))
    $c = if ($pct -lt 50) { $GR } elseif ($pct -lt 80) { $YL } else { $RD }
    return "${c}[$('█' * $f)$('░' * ($w - $f))]${R}"
}

function New-ResetStr($iso) {
    try {
        $ts = [System.DateTimeOffset]::Parse($iso)
        $s  = ($ts - [System.DateTimeOffset]::UtcNow).TotalSeconds
        if ($s -le 0) { return "resetting" }
        $h = [int]($s / 3600); $m = [int](($s % 3600) / 60)
        return "${h}h$($m.ToString('00'))m"
    } catch { return "—" }
}

function New-5hrStr($u) {
    if (-not $u -or -not $u.five_hour) { return "—" }
    $fh  = $u.five_hour
    $pct = if ($null -ne $fh.utilization) { [int]$fh.utilization } else { 0 }
    $t   = if ($fh.resets_at) { New-ResetStr $fh.resets_at } else { "—" }
    $c   = if ($pct -lt 50) { $GR } elseif ($pct -lt 80) { $YL } else { $RD }
    "$(New-Bar $pct) ${c}$($pct.ToString().PadLeft(3))%${R} ${D}($t)${R}"
}

function New-7dStr($u) {
    if (-not $u -or -not $u.seven_day -or $null -eq $u.seven_day.utilization) { return "—" }
    $pct = [int]$u.seven_day.utilization
    $f   = [int]([Math]::Round($pct / 100.0 * 8))
    $c   = if ($pct -lt 50) { $GR } elseif ($pct -lt 80) { $YL } else { $RD }
    "${c}[$('█' * $f)$('░' * (8 - $f))]${R} ${c}${pct}%${R}"
}

# ── Sync live → snapshot ──────────────────────────────────────────────────────
function Sync-Creds {
    $cur = Get-CurrentName
    if (-not $cur -or -not (Test-Account $cur)) { return }
    $live = Read-LiveCreds
    if ($live) { Write-NoBOM (Get-CredsPath $cur) $live }
}

# ── Table rendering ───────────────────────────────────────────────────────────
function Show-Table([string]$mode, [bool]$noUsage = $false) {
    $names = Get-AccountNames
    if (-not $names) {
        fWarn "No accounts yet. Run: ${B}relay add <name>${R}"
        return
    }
    $cur   = Get-CurrentName
    $usage = @{}

    if (-not $noUsage) {
        Write-Host "  ${D}fetching usage...${R}" -NoNewline
        foreach ($n in $names) {
            $tok = Get-Token (Get-Content (Get-CredsPath $n) -Raw -ErrorAction SilentlyContinue)
            $usage[$n] = if ($tok) { Get-Usage $tok } else { $null }
        }
        Write-Host "`r$(' ' * 25)`r" -NoNewline
    }

    if ($mode -eq 'quick') {
        Write-Host ""
        Write-Host "  ${B}${MG}relay${R} ${D}— switch account${R}"
        Write-Host "  ${D}$('─' * 45)${R}"
        for ($i = 0; $i -lt $names.Count; $i++) {
            $n     = $names[$i]; $isCur = ($n -eq $cur)
            $marker = if ($isCur) { "${GR}${B}●${R}" } else { "${D}$($i+1)${R}" }
            $nc     = if ($isCur) { "${GR}${B}" } else { $B }
            $u5     = if (-not $noUsage) { New-5hrStr $usage[$n] } else { "" }
            Write-Host "  $marker  ${nc}$($n.PadRight(12))${R}  ${D}$((Get-MetaEmail $n).PadRight(26))${R}  $u5"
        }
        Write-Host ""
        Write-Host "  ${D}switch:${R} ${CY}relay <index or name>${R}   ${D}details:${R} ${CY}relay status${R}"
        Write-Host ""
    } else {
        Write-Host "  ${B}$('#'.PadRight(3))$('account'.PadRight(13)) $('email'.PadRight(28)) 5hr usage                   7d usage${R}"
        Write-Host "  ${D}$('─' * 80)${R}"
        for ($i = 0; $i -lt $names.Count; $i++) {
            $n     = $names[$i]; $isCur = ($n -eq $cur)
            $marker = if ($isCur) { "${GR}●${R}" } else { " " }
            $nc     = if ($isCur) { "${GR}${B}" } else { $B }
            $u5     = if (-not $noUsage) { New-5hrStr $usage[$n] } else { "—" }
            $u7     = if (-not $noUsage) { New-7dStr  $usage[$n] } else { "—" }
            Write-Host "  $marker ${D}$($i+1) ${R}${nc}$($n.PadRight(12))${R} $((Get-MetaEmail $n).PadRight(28)) $u5  $u7"
        }
        Write-Host ""
    }
}

# ── Switch account ────────────────────────────────────────────────────────────
function Invoke-Switch($name) {
    $cur = Get-CurrentName
    if ($cur -eq $name) { fOk "Already on account '${B}${name}${R}'"; return }

    # Back up live token before switching (Claude Code refreshes tokens in-place)
    if ($cur -and (Test-Account $cur)) {
        $live = Read-LiveCreds
        if ($live) { Write-NoBOM (Get-CredsPath $cur) $live }
    }

    Write-NoBOM $CURRENT_FILE $name
    Write-NoBOM $LIVE_CREDS ([System.IO.File]::ReadAllText((Get-CredsPath $name)))

    $email = Get-MetaEmail $name
    Write-Host ""
    Write-Host "  ${GR}${B}✓ switched -> ${name}${R}  ${D}${email}${R}"
    Write-Host "  ${D}Restart claude to apply. Resume last session: ${CY}claude -c${R}"
    Write-Host ""
}

# ─────────────────────────────────────────────────────────────────────────────
# Commands
# ─────────────────────────────────────────────────────────────────────────────

function cmd_quick([bool]$noUsage) { Sync-Creds; Show-Table 'quick' $noUsage }

function cmd_list([bool]$noUsage) {
    fHdr "Account List"; Sync-Creds; Show-Table 'full' $noUsage
    Write-Host ""; fOk "Run ${CY}relay <index>${R} to switch"
}

function cmd_status {
    Sync-Creds; $cur = Get-CurrentName; fHdr "Current Status"
    if (-not $cur)                { fWarn "No account set (using system default)"; return }
    if (-not (Test-Account $cur)) { fWarn "Recorded account '$cur' no longer exists"; return }

    Write-Host "  ${B}Account:${R} ${GR}${B}${cur}${R}"
    Write-Host "  ${B}Email:${R}   $(Get-MetaEmail $cur)"

    $tok = Get-Token (Get-Content (Get-CredsPath $cur) -Raw)
    if (-not $tok) { Write-Host ""; fWarn "No access token — please log in again"; return }

    $u = Get-Usage $tok
    if (-not $u) { Write-Host ""; fErr "Usage query failed"; return }

    $fh = $u.five_hour
    if ($fh) {
        $pct = if ($null -ne $fh.utilization) { [int]$fh.utilization } else { 0 }
        $c   = if ($pct -lt 50) { $GR } elseif ($pct -lt 80) { $YL } else { $RD }
        Write-Host ""
        Write-Host "  ${B}5hr usage:${R}"
        Write-Host "    $(New-Bar $pct 24) ${c}${B}${pct}%${R}"
        Write-Host "    ${D}$(if ($fh.resets_at) { New-ResetStr $fh.resets_at } else { '—' })${R}"
    }
    $sd = $u.seven_day
    if ($sd -and $null -ne $sd.utilization) {
        $pct = [int]$sd.utilization
        $c   = if ($pct -lt 50) { $GR } elseif ($pct -lt 80) { $YL } else { $RD }
        Write-Host ""
        Write-Host "  ${B}7d usage:${R}"
        Write-Host "    $(New-Bar $pct 24) ${c}${pct}%${R}"
        if ($sd.resets_at) { Write-Host "    ${D}$(New-ResetStr $sd.resets_at)${R}" }
    }
    Write-Host ""
    $u5pct = if ($fh -and $null -ne $fh.utilization) { [int]$fh.utilization } else { 0 }
    if     ($u5pct -ge 90) { Write-Host "  ${RD}${B}⚠  Approaching limit — consider switching: relay <other>${R}" }
    elseif ($u5pct -ge 70) { Write-Host "  ${YL}⚡ Usage is high — watch for rate limits${R}" }
    else                   { fOk "Usage is normal" }

    $projDir = Join-Path $CLAUDE_DIR "projects"
    $n = if (Test-Path $projDir) {
        @(Get-ChildItem $projDir -Recurse -Filter "*.jsonl" -ErrorAction SilentlyContinue).Count
    } else { 0 }
    Write-Host ""
    Write-Host "  ${B}Sessions:${R} $n (shared across all accounts in $projDir)"
}

function cmd_add($name, [bool]$force = $false) {
    if (-not $name) { fErr "usage: relay add <name>"; exit 1 }
    if ($name -notmatch '^[a-zA-Z0-9_-]+$') {
        fErr "name must contain only letters, numbers, underscores, or hyphens"; exit 1
    }
    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
        fErr "claude not found — install from https://claude.ai/download"; exit 1
    }
    if (-not $force -and (Test-Account $name)) {
        fWarn "Account '$name' already exists"
        fLog "To re-login: ${B}relay add-force $name${R}"; return
    }
    fHdr "Add account: $name"
    fWarn "Complete the browser login then return to this terminal"
    Write-Host ""

    $tokBefore = ""
    $before = Read-LiveCreds
    if ($before) { try { $tokBefore = Get-Token $before } catch {} }

    & claude /login

    $after = Read-LiveCreds
    if (-not $after) {
        fErr "No credentials found after login"
        fLog "If login succeeded, run: ${B}relay save $name${R}"; exit 1
    }
    $tokAfter = Get-Token $after
    if ($tokBefore -and $tokBefore -eq $tokAfter) {
        fErr "Login did not complete (token unchanged)"
        fWarn "Run relay add from a regular terminal outside Claude Code"
        fLog "To save the current account: ${B}relay save $name${R}"; exit 1
    }

    Write-NoBOM (Get-CredsPath $name) $after
    Save-MetaEmail $name
    Write-NoBOM $CURRENT_FILE $name
    fOk "Account '${B}${name}${R}' added  ${D}$(Get-MetaEmail $name)${R}"
}

function cmd_save($name) {
    if (-not $name) { fErr "usage: relay save <name>"; exit 1 }
    fHdr "Save current account as: $name"
    $creds = Read-LiveCreds
    if (-not $creds) {
        fErr "No credentials found — log in first with: claude /login"; exit 1
    }
    Write-NoBOM (Get-CredsPath $name) $creds
    fOk "Saved from $LIVE_CREDS"
    Save-MetaEmail $name
    Write-NoBOM $CURRENT_FILE $name
    fOk "Account '${B}${name}${R}' saved  ${D}$(Get-MetaEmail $name)${R}"
}

function cmd_remove($name) {
    if (-not $name) { fErr "usage: relay remove <name>"; exit 1 }
    if (-not (Test-Account $name)) { fErr "Account '$name' not found"; exit 1 }
    Write-Host "  ${YL}Delete '${B}${name}${R}${YL}'? (y/N) ${R}" -NoNewline
    $c = Read-Host
    if ($c -notmatch '^[yY]$') { fLog "cancelled"; return }
    Remove-Item (Get-CredsPath $name) -Force -ErrorAction SilentlyContinue
    Remove-Item (Get-MetaPath  $name) -Force -ErrorAction SilentlyContinue
    if ((Get-CurrentName) -eq $name) { Remove-Item $CURRENT_FILE -Force -ErrorAction SilentlyContinue }
    fOk "Deleted '$name' (sessions are unaffected)"
}

function cmd_rename($old, $new) {
    if (-not $old -or -not $new) { fErr "usage: relay rename <old-name> <new-name>"; exit 1 }
    if ($new -notmatch '^[a-zA-Z0-9_-]+$') {
        fErr "name must contain only letters, numbers, underscores, or hyphens"; exit 1
    }
    if (-not (Test-Account $old)) { fErr "Account '$old' not found"; exit 1 }
    if (Test-Account $new)        { fErr "Account '$new' already exists"; exit 1 }
    Rename-Item (Get-CredsPath $old) "$new.json"
    if (Test-Path (Get-MetaPath $old)) { Rename-Item (Get-MetaPath $old) $new }
    if ((Get-CurrentName) -eq $old) { Write-NoBOM $CURRENT_FILE $new }
    fOk "Renamed '${B}${old}${R}' → '${B}${new}${R}'"
}

function cmd_sessions {
    fHdr "Sessions (shared across all accounts)"
    $base = Join-Path $CLAUDE_DIR "projects"
    if (-not (Test-Path $base)) { fWarn "No sessions found"; return }
    $total = 0
    foreach ($proj in Get-ChildItem $base -Directory -ErrorAction SilentlyContinue | Sort-Object Name) {
        $files = @(Get-ChildItem $proj.FullName -Filter "*.jsonl" -ErrorAction SilentlyContinue |
                   Sort-Object LastWriteTime -Descending)
        if (-not $files) { continue }
        Write-Host "  ${D}$($proj.Name)${R}"
        foreach ($f in $files) {
            $sz   = if ($f.Length -gt 1MB) { "$([int]($f.Length / 1MB))M" } else { "$([int]($f.Length / 1KB))K" }
            $mark = if ($total -eq 0) { "  ${GR}<- latest${R}" } else { "" }
            Write-Host "  ${CY}$($f.BaseName.PadRight(40))${R} $($f.LastWriteTime.ToString('MM/dd HH:mm').PadRight(12)) $sz$mark"
            $total++
        }
    }
    Write-Host ""
    Write-Host "  $total session(s)"
    fLog "${CY}claude -c${R} resume last  ${D}|${R}  ${CY}claude --resume <id>${R}"
}

function cmd_help {
    Write-Host ""
    Write-Host "  ${B}${CY}relay${R} ${D}v2 — multi-account switcher for Claude Code (Windows)${R}"
    Write-Host ""
    Write-Host "  ${B}Commands${R}"
    @(
        @("  relay <index|name>",      "switch to account by number or name"),
        @("  relay add <name>",        "add account via browser login"),
        @("  relay add-force <name>",  "force re-login for existing account"),
        @("  relay save <name>",       "save current login state as named account"),
        @("  relay list",              "full list with weekly usage"),
        @("  relay list --no-usage",   "list without querying API"),
        @("  relay status",            "detailed usage for current account"),
        @("  relay rename <old> <new>","rename an account"),
        @("  relay remove <name>",     "delete an account"),
        @("  relay sessions",          "show all sessions"),
        @("  relay help",              "show this help")
    ) | ForEach-Object { Write-Host ("  {0,-36} {1}" -f $_[0], $_[1]) }
    Write-Host ""
    Write-Host "  ${D}credentials: $LIVE_CREDS${R}"
    Write-Host "  ${D}after switching: claude -c to resume last session${R}"
    Write-Host ""
}

# ─────────────────────────────────────────────────────────────────────────────
# Dispatch
# ─────────────────────────────────────────────────────────────────────────────
$noUsage = $Rest -contains '--no-usage'

switch ($Cmd.ToLower()) {
    ""           { cmd_quick $noUsage }
    "list"       { cmd_list  $noUsage }
    "ls"         { cmd_list  $noUsage }
    "add"        { cmd_add   (Get-First $Rest) $false }
    "add-force"  { cmd_add   (Get-First $Rest) $true  }
    "save"       { cmd_save  (Get-First $Rest) }
    "status"     { cmd_status }
    "st"         { cmd_status }
    "remove"     { cmd_remove (Get-First $Rest) }
    "rm"         { cmd_remove (Get-First $Rest) }
    "del"        { cmd_remove (Get-First $Rest) }
    "rename"     { cmd_rename (Get-First $Rest) (Get-Second $Rest) }
    "mv"         { cmd_rename (Get-First $Rest) (Get-Second $Rest) }
    "sessions"   { cmd_sessions }
    "sess"       { cmd_sessions }
    "help"       { cmd_help }
    "--help"     { cmd_help }
    "-h"         { cmd_help }
    default {
        if ($Cmd -match '^\d+$') {
            $n = Get-AccountByIndex ([int]$Cmd)
            if (-not $n) { fErr "No account at index $Cmd"; cmd_quick $true; exit 1 }
            Invoke-Switch $n
        } elseif (Test-Account $Cmd) {
            Invoke-Switch $Cmd
        } else {
            fErr "Unknown command or account: $Cmd"
            cmd_quick $true
            Write-Host "  ${D}Run ${CY}relay help${R}${D} for usage${R}"
            exit 1
        }
    }
}
