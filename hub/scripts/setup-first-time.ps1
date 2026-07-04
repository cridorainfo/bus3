# AdKerala Hub - one-time setup for this bus PC. Run this ONCE before ever using run-hub.bat.
#
# Installs dependencies, generates placeholder audio if none exists yet, and - the part that
# actually fixes "pairing ID never shows up on the server" - persists this PC's cloud connection
# settings as User environment variables. Every future run (run-hub.bat, a plain terminal, a new
# PowerShell window) picks them up automatically from then on; nothing to retype, and nothing
# silently falls back to a local test address again.
#
# Usage (double-click setup-first-time.bat instead if you don't want to deal with PowerShell
# directly - it just calls this with the same defaults):
#   powershell -ExecutionPolicy Bypass -File setup-first-time.ps1
#   powershell -ExecutionPolicy Bypass -File setup-first-time.ps1 -Transport mock   (bench-testing, no ESP32 wired in yet)

param(
    [string]$CloudUrl = 'wss://cloud-production-9b7b.up.railway.app/hub-sync',
    [string]$CloudHttp = 'https://cloud-production-9b7b.up.railway.app',
    [ValidateSet('serial', 'mock')]
    [string]$Transport = 'serial'
)

$hubDir = Split-Path -Parent $PSScriptRoot
Set-Location $hubDir

Write-Host "[setup] Working in $hubDir"

Write-Host "[setup] Installing dependencies (this can take a minute)..."
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "[setup] npm install failed - fix that first, then re-run this script." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path "$hubDir\assets\audio\chime.wav")) {
    Write-Host "[setup] Generating placeholder audio (replace with real recordings before going live)..."
    npm run gen-audio
}

Write-Host "[setup] Setting persistent environment variables for this Windows account..."
[Environment]::SetEnvironmentVariable('HUB_CLOUD_URL', $CloudUrl, 'User')
[Environment]::SetEnvironmentVariable('HUB_CLOUD_HTTP', $CloudHttp, 'User')
[Environment]::SetEnvironmentVariable('HUB_TRANSPORT', $Transport, 'User')

Write-Host ""
Write-Host "[setup] Done. Set for this Windows account:" -ForegroundColor Green
Write-Host "  HUB_CLOUD_URL  = $CloudUrl"
Write-Host "  HUB_CLOUD_HTTP = $CloudHttp"
Write-Host "  HUB_TRANSPORT  = $Transport"
Write-Host ""
Write-Host "These are stored persistently (registry-backed User environment variables) - they"
Write-Host "survive reboots and apply to every future terminal/script run as this account, not"
Write-Host "just this session."
Write-Host ""
Write-Host "Next: close this window, then run scripts\run-hub.bat (open a NEW terminal if you're"
Write-Host "running commands by hand - an already-open terminal won't see these until reopened)."
Write-Host ""
Write-Host "If your ESP32/Arduino uses non-default USB IDs, also set HUB_ESP32_VID/HUB_ESP32_PID"
Write-Host "the same way (see DEPLOYMENT.md Part 2.3)."
