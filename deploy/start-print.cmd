@echo off
REM ============================================================
REM  Zeva Mandi & Grills - counter printing
REM  Starts the print bridge (port 8080) and exposes it through a
REM  Cloudflare quick tunnel so the website can print bills.
REM
REM  Keep this window open while the counter is running.
REM  Do not delete .print-token - the site uses it as the password.
REM ============================================================
setlocal
cd /d "%~dp0"

if not exist ".print-token" (
  echo WARNING: .print-token is missing. A new one will be created,
  echo but the website still has the old password - printing will fail
  echo with "unauthorised" until it is updated.
  node -e "console.log(require('crypto').randomBytes(24).toString('hex'))" > .print-token
)

set /p TOKEN=<.print-token

echo Starting print bridge on port 8080 ...
start "Zeva print bridge" /min cmd /c "set PRINT_BRIDGE_TOKEN=%TOKEN%&&node printer-bridge.js"

timeout /t 3 /nobreak >nul

echo.
echo Starting tunnel - the https://xxxx.trycloudflare.com address appears below.
echo If it differs from the one in the website settings, update PRINT_BRIDGE_URL
echo to https://^<that-address^>/print in Sites - Variables.
echo.
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:8080 --no-autoupdate

endlocal
