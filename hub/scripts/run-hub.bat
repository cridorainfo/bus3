@echo off
REM AdKerala Hub — the everyday launcher for this bus PC. Run scripts\setup-first-time.bat once
REM before ever using this for the first time; that's what sets HUB_CLOUD_URL/HUB_CLOUD_HTTP/
REM HUB_TRANSPORT persistently, so nothing needs to be retyped or configured here every time.
REM
REM Opens ONLY the passenger-facing Display View on this PC — that's the only screen meant to
REM be shown at an unattended kiosk. The Control Panel is for the driver/conductor's own phone,
REM not this PC — this script just prints its URL.

cd /d "%~dp0.."

if not exist node_modules (
    echo Dependencies aren't installed yet on this PC.
    echo Run scripts\setup-first-time.bat first, then try this again.
    pause
    exit /b 1
)

if "%HUB_CLOUD_URL%"=="" (
    echo WARNING: HUB_CLOUD_URL isn't set for this Windows account — the Hub is about to try
    echo reaching a LOCAL test cloud instead of your real server, which won't work. Run
    echo scripts\setup-first-time.bat first — or press Ctrl+C now to cancel.
    echo Continuing in 8 seconds anyway...
    timeout /t 8
)

echo Starting Hub...
start "AdKerala Hub" cmd /k "npm start"

REM give the server a moment to bind before opening the browser
timeout /t 5 /nobreak >nul

call "%~dp0_launch-kiosk-browser.bat" "http://localhost:3000/display/"

echo.
echo Passenger Display View opened on this PC — full screen, no browser chrome (app mode).
echo.
echo Driver/conductor phone (Control Panel) is opened on their own phone, not here:
echo.
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /c:"IPv4 Address"') do (
    set "PCIP=%%A"
    goto :gotip
)
:gotip
set PCIP=%PCIP: =%
echo   http://%PCIP%:3000/panel/
echo.
echo Hub is running in its own window — close that window (or Ctrl+C in it) to stop it.
