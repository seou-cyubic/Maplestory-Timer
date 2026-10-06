@echo off
rem Astra Web launcher - double-click this file.
rem Starts the local server (or reuses a running one) and opens the browser.
cd /d "%~dp0"

where py >nul 2>nul
if not errorlevel 1 (
  py -3 -X utf8 tools\serve.py %*
  goto done
)
where python >nul 2>nul
if not errorlevel 1 (
  python -X utf8 tools\serve.py %*
  goto done
)
echo Python 3 is required: https://www.python.org/downloads/
pause
exit /b 1

:done
if errorlevel 1 pause
