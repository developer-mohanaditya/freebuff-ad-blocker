@echo off
rem
rem Double-click launcher for Freebuff AdBlock for Desktop (Windows).
rem
rem Kept next to freebuff-adblock-desktop.ps1 inside the downloaded zip.
rem Double-clicking this opens a PowerShell window and runs the patch; the window
rem stays open afterwards so the output can be read.
rem
rem -ExecutionPolicy Bypass is not a convenience: a file saved from the browser
rem carries the mark-of-the-web, and the default RemoteSigned policy refuses to
rem run an unsigned script that came from the internet. The one-liner on the
rem install page never needs this, because `iex` runs a string rather than a file.
rem
rem If you would rather not bypass the policy, unblock the file instead:
rem   Unblock-File .\freebuff-adblock-desktop.ps1
rem

setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0freebuff-adblock-desktop.ps1" install

echo.
echo Press any key to close this window.
pause >nul
endlocal
