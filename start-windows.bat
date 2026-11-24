@echo off
rem Energy Monitoring Management - start on Windows. The first run installs what it needs (needs internet once).
cd /d "%~dp0"
where py >nul 2>nul && (set PY=py -3) || (set PY=python)
%PY% --version >nul 2>nul
if errorlevel 1 (
  echo Python is not installed. Install it from https://www.python.org/downloads/
  echo and tick "Add python.exe to PATH" on the first screen of the installer. Then run this file again.
  pause
  exit /b 1
)
if not exist .venv (
  echo First start: installing, this takes a minute...
  %PY% -m venv .venv
  .venv\Scripts\python -m pip install -r requirements.txt
)
.venv\Scripts\python run.py %*
pause
