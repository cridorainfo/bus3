@echo off
REM Double-click this once to set up this bus PC — installs dependencies and persists this PC's
REM cloud connection settings (see setup-first-time.ps1 for what it actually does). Only needs
REM to be run once, ever, per PC. After this finishes, use run-hub.bat every time you actually
REM want to start the Hub.
REM
REM Pass along any of setup-first-time.ps1's parameters, e.g.:
REM   setup-first-time.bat -Transport mock

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-first-time.ps1" %*
echo.
pause
