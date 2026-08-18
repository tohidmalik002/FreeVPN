@echo off
:: ---------------------------------------------------------------------------
::  FreeVPN — emergency disconnect
::  Force-stops the OpenVPN tunnel (openvpn.exe). Because the tunnel runs
::  elevated, this self-elevates via a UAC prompt first.
::
::  NOTE: this only kills FreeVPN's own `openvpn.exe` tunnel. It does NOT touch
::  "OpenVPN Connect" (your work client uses ovpnconnect.exe, not openvpn.exe).
:: ---------------------------------------------------------------------------

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator rights...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo Stopping the VPN tunnel...
taskkill /F /IM openvpn.exe >nul 2>&1
if %errorlevel% equ 0 (
    echo VPN tunnel stopped.
) else (
    echo No FreeVPN tunnel was running.
)

echo.
timeout /t 2 >nul
