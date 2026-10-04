@echo off
REM Double-click helper: runs the publish script with Windows PowerShell.
REM Execution policy is bypassed for this one run only; nothing is changed machine-wide.
setlocal
cd /d "%~dp0"

echo.
echo   Publishing PeerLink to GitHub...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish-to-github.ps1" %*
set EXITCODE=%ERRORLEVEL%

echo.
if not "%EXITCODE%"=="0" (
  echo   The script stopped with exit code %EXITCODE%. Read the messages above.
) else (
  echo   Done. Press any key to close.
)
pause >nul
endlocal
