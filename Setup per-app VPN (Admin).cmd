@echo off
:: ---------------------------------------------------------------------------
::  FreeVPN — one-click setup for "VPN for chosen apps only"
::  Installs ProxiFyre + the Windows Packet Filter driver (needs admin).
::  Double-click this file; it self-elevates via a UAC prompt.
:: ---------------------------------------------------------------------------

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator rights...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-perapp.ps1"

echo.
echo Press any key to close.
pause >nul
