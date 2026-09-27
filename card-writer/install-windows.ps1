# openLN Card Bridge installer (Windows, PowerShell).
#
# Note: the simplest Windows path is the local HTTP mode, which needs no
# registry work at all:
#
#     py -3 bridge\openln-cardbridge.py --http
#
# then open http://127.0.0.1:17777. The steps below additionally register
# the native messaging host for the Chrome extension.

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridge = Join-Path $here "bridge\openln-cardbridge.py"

# launcher used by Chrome to start the bridge
$launcher = Join-Path $here "bridge\openln-cardbridge.cmd"
"@echo off`r`npython `"$bridge`" %*" | Set-Content -Encoding ASCII $launcher

# fill the host manifest with the launcher path (escaped for JSON)
$template = Join-Path $here "extension\com.openln.cardbridge.json.template"
$manifest = Join-Path $here "extension\com.openln.cardbridge.json"
(Get-Content $template -Raw) -replace "__BRIDGE_PATH__", ($launcher -replace "\\", "\\\\") |
  Set-Content -Encoding ASCII $manifest

# register for Chrome (and Chromium-based browsers read the same Chrome key
# only if they mirror it; add their own keys here if needed)
$key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.openln.cardbridge"
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name "(Default)" -Value $manifest

Write-Host "registered native messaging host: $manifest"
Write-Host "load the extension from: $here\extension  (chrome://extensions, Developer mode, Load unpacked)"
Write-Host ""
Write-Host "or run the local HTTP mode:  python `"$bridge`" --http   ->  http://127.0.0.1:17777"
