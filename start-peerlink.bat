@echo off
setlocal
cd /d "%~dp0"

echo.
echo   Starting PeerLink from source...
echo.

if not exist "node_modules\electron" (
  echo   Dependencies are missing. Running "npm install" first...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo   npm install failed.
    pause
    exit /b 1
  )
)

if not exist "dist\renderer\index.html" (
  echo   Building the app ^(first run only^)...
  call npm run build
  if errorlevel 1 (
    echo   Build failed.
    pause
    exit /b 1
  )
)

call npx electron .
