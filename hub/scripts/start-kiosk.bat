@echo off
REM AdKerala Display View kiosk launcher (spec 4.1/16).
REM Put a shortcut to this .bat in:
REM   shell:startup   (Win+R -> shell:startup)
REM so the Display View comes up full-screen with no window chrome on every boot, no login.

REM Give the Hub's Windows service a moment to finish starting before the browser hits it.
timeout /t 8 /nobreak >nul

REM Disable sleep/screen-timeout while on AC power (kiosk must never blank/lock).
powercfg /change monitor-timeout-ac 0
powercfg /change standby-timeout-ac 0

set HUB_URL=http://localhost:3000/display/

where msedge >nul 2>nul
if %ERRORLEVEL%==0 (
    start "" msedge --kiosk %HUB_URL% --edge-kiosk-type=fullscreen --no-first-run
    goto :eof
)

where chrome >nul 2>nul
if %ERRORLEVEL%==0 (
    start "" chrome --kiosk %HUB_URL% --noerrdialogs --disable-infobars --no-first-run
    goto :eof
)

echo Neither msedge nor chrome found on PATH — install one or edit this script with the full exe path.
