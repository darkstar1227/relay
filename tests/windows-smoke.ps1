param([Parameter(Mandatory = $true)][string]$RelayPath)
$ErrorActionPreference = 'Stop'
if (-not $env:RELAY_TEST_HOME -or $HOME -ne $env:RELAY_TEST_HOME) {
    throw 'Refusing Windows tests without an isolated PowerShell HOME'
}

# Loading the installed script checks its actual encoding and 5.1 syntax.
. $RelayPath help *> $null

# Replace only HTTP transport; exercise the real refresh and persistence code.
function Invoke-RestMethod {
    param($Uri, $Method, $Body, $ContentType, $Headers, $TimeoutSec)
    if ($Uri -ne 'https://api.anthropic.com/v1/oauth/token') { throw 'Unexpected HTTP request' }
    if ($Body -notmatch 'grant_type=refresh_token') { throw 'Missing refresh grant' }
    return $script:RefreshReply
}

$checked = 0
foreach ($expires in @($null, 0, 120)) {
    $script:RefreshReply = [pscustomobject]@{access_token='new-token'; refresh_token='rotated'; expires_in=$expires}
    $credPath = Join-Path $CREDS_STORE 'fixture.json'
    $original = @{claudeAiOauth=@{accessToken='old'; refreshToken='refresh'}; preserved='fixture'}
    [IO.File]::WriteAllText($credPath, ($original | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
    $before = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $token = Invoke-TokenRefresh $credPath
    $after = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($token -ne 'new-token') { throw 'Refresh failed' }
    $saved = Get-Content $credPath -Raw | ConvertFrom-Json
    $expected = 3600
    if ($null -ne $expires) { $expected = $expires }
    if ($saved.claudeAiOauth.expiresAt -lt ($before + $expected * 1000) -or
        $saved.claudeAiOauth.expiresAt -gt ($after + $expected * 1000)) { throw 'Incorrect expiry fallback' }
    if ($saved.preserved -ne 'fixture' -or $saved.claudeAiOauth.refreshToken -ne 'rotated') { throw 'Credential fields lost' }
    $checked++
}
Write-Output "Windows PowerShell $($PSVersionTable.PSVersion): installed script and $checked refresh cases passed"
