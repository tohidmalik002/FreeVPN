@echo off
:: ---------------------------------------------------------------------------
::  FreeVPN — launch as Administrator (OpenVPN needs admin to set up the adapter)
::  Double-click this file. It self-elevates via a UAC prompt, then builds and
::  runs the app from source.
:: ---------------------------------------------------------------------------

:: Already elevated?  `net session` only succeeds with admin rights.
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator rights...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"
echo Running as administrator. Starting FreeVPN...
echo.
call npm start

echo.
echo FreeVPN exited. Press any key to close.
pause >nul
