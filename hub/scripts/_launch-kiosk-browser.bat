@echo off
REM Shared helper — launches Edge/Chrome in true kiosk mode (--kiosk) pointed at %1: no tabs, no
REM address bar, no bookmarks bar, no menu, AND the Windows taskbar hidden — --kiosk is
REM Chromium's purpose-built flag for exactly this (unlike --app + --start-fullscreen, which
REM does hide browser chrome but does NOT reliably hide the taskbar). Used by both
REM start-kiosk.bat (auto-boot) and run-hub.bat (manual run), so there's exactly one place that
REM knows how to find/launch the browser.
REM
REM Usage: call _launch-kiosk-browser.bat "http://localhost:3000/display/"

set KIOSK_URL=%~1
if "%KIOSK_URL%"=="" (
    echo _launch-kiosk-browser.bat: no URL given.
    exit /b 1
)

REM Common to both browsers: autoplays announcement/ad audio without needing a user gesture
REM (there's no one to click anything on an unattended kiosk), and suppresses the "didn't shut
REM down correctly" restore-session bubble that can otherwise pop up over the passenger display
REM after a power loss mid-route.
set COMMON_FLAGS=--autoplay-policy=no-user-gesture-required --disable-session-crashed-bubble --disable-pinch --overscroll-history-navigation=0 --noerrdialogs --no-first-run

REM Neither Edge nor Chrome is normally added to PATH by their installers, so `where` alone
REM would falsely report "not found" even when installed — check their actual install
REM locations directly instead (covers both possible Edge/Chrome Program Files layouts).
set EDGE_EXE=
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set EDGE_EXE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set EDGE_EXE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe

set CHROME_EXE=
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set CHROME_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set CHROME_EXE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe

if not "%EDGE_EXE%"=="" (
    REM --edge-kiosk-type=fullscreen is Edge-specific — without it, Edge's --kiosk defaults to a
    REM more limited "kiosk browsing" mode that can still leave some taskbar/UI visible.
    start "" "%EDGE_EXE%" --kiosk "%KIOSK_URL%" --edge-kiosk-type=fullscreen %COMMON_FLAGS%
    exit /b 0
)

if not "%CHROME_EXE%"=="" (
    start "" "%CHROME_EXE%" --kiosk "%KIOSK_URL%" %COMMON_FLAGS%
    exit /b 0
)

echo Neither Edge nor Chrome found at their usual install locations — edit this script with the full exe path for whatever's installed on this PC.
exit /b 1
