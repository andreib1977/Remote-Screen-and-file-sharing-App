@echo off
setlocal
cd /d "%~dp0"

echo.
echo   PeerLink signalling server
echo   ==========================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js was not found on this machine.
  echo   Install it from https://nodejs.org and run this script again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\ws" (
  echo   First run: installing the one dependency ^(ws^)...
  echo.
  call npm install --no-audit --no-fund --omit=dev
  if errorlevel 1 (
    echo.
    echo   npm install failed. Run "npm install" manually and try again.
    pause
    exit /b 1
  )
)

echo   Your local addresses:
for /f "usebackq tokens=2 delims=:" %%a in (`ipconfig ^| findstr /c:"IPv4 Address"`) do echo     ws://%%a:8787
echo.
echo   Tell everyone to put that address in PeerLink - Settings - Signalling server.
echo   Keep this window open while people connect. Press Ctrl+C to stop.
echo.

node server/signal.js --port 8787 --host 0.0.0.0
echo.
echo   Server stopped.
pause
