@echo off
:: relay.cmd — Windows CMD wrapper for relay.ps1
:: Passes all arguments through to the PowerShell implementation.
:: Requires PowerShell 5.1+ (built into Windows 10/11).
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0relay.ps1" %*
endlocal
