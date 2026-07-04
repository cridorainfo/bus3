@echo off
REM AdKerala Hub — one-click local test launcher.
REM Double-click this file (or run it from a terminal) to install deps if needed, start the
REM Hub, and open ONLY the passenger-facing Display View on this PC — that's the only screen
REM meant to be shown at the kiosk. The Control Panel (driver/conductor) and ESP32 Simulator
REM are opened on a phone/other device instead — this script just prints their URLs.
REM
REM Usage:
REM   run-dev.bat            -> mock transport (no ESP32/Uno needed, default)
REM   run-dev.bat serial     -> real hardware transport (ESP32/Uno must be plugged in)
REM
REM This is for local dev/testing only. For the actual bus PC, see install-service.js and
REM start-kiosk.bat instead (../../DEPLOYMENT.md Part 2.5).

cd /d "%~dp0.."

if not exist node_modules (
    echo Installing dependencies...
    call npm install
)

if not exist assets\audio\chime.wav (
    echo Generating placeholder audio...
    call npm run gen-audio
)

set HUB_RUN_TRANSPORT=mock
if /i "%~1"=="serial" set HUB_RUN_TRANSPORT=serial

echo Starting Hub in %HUB_RUN_TRANSPORT% mode...
start "AdKerala Hub" cmd /k "set HUB_TRANSPORT=%HUB_RUN_TRANSPORT% && npm start"

REM give the server a moment to bind before opening the browser tab
timeout /t 5 /nobreak >nul

start "" http://localhost:3000/display/

echo.
echo Passenger Display View opened on this PC.
echo.
echo Driver/conductor phone (Control Panel) and, in mock mode, the ESP32 Simulator are opened
echo on a phone or a second device instead of this PC — not launched here on purpose:
echo.
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /c:"IPv4 Address"') do (
    set "PCIP=%%A"
    goto :gotip
)
:gotip
set PCIP=%PCIP: =%
echo   Control Panel  (phone)  : http://%PCIP%:3000/panel/
if /i "%HUB_RUN_TRANSPORT%"=="mock" echo   ESP32 Simulator (phone/PC): http://%PCIP%:3000/sim/
echo   (or use http://localhost:3000/panel/ if testing from this same PC in another tab)
echo.
echo Hub is running in its own window — close that window (or Ctrl+C in it) to stop it.
