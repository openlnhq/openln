@echo off
setlocal
title openLN card bridge
set "DIR=%USERPROFILE%\.openln-card-bridge"
if not exist "%DIR%" mkdir "%DIR%"

set "BASE="
for %%H in ("https://openln.com" "https://dev.openln.com") do (
  if not defined BASE (
    curl -fsS --max-time 60 "%%~H/card-writer/bridge/openln-cardbridge.py" -o "%DIR%\openln-cardbridge.py" >nul 2>&1
    if not errorlevel 1 set "BASE=%%~H"
  )
)
if not defined BASE (
  echo Could not download the card bridge. Check your connection and run this again.
  pause
  exit /b 1
)
curl -fsS --max-time 60 "%BASE%/card-writer/bridge/cardsim.py" -o "%DIR%\cardsim.py" >nul 2>&1

set "PY="
where py >nul 2>&1 && set "PY=py -3"
if not defined PY where python >nul 2>&1 && set "PY=python"
if not defined PY (
  echo Python 3 is required once. Install it from python.org, tick "Add python.exe to PATH", then run this file again.
  pause
  exit /b 1
)

if not exist "%DIR%\venv\Scripts\python.exe" (
  echo First run: creating a private Python environment, one time...
  %PY% -m venv "%DIR%\venv"
)
echo Installing the card reader library, one time...
"%DIR%\venv\Scripts\python.exe" -m pip install --quiet --disable-pip-version-check cryptography >nul 2>&1
"%DIR%\venv\Scripts\python.exe" -m pip install --quiet --disable-pip-version-check pyscard >nul 2>&1

echo.
echo ==============================================
echo  openLN card bridge is running.
echo  Keep this window open while you write cards.
echo  Go back to the openLN app and press Check again.
echo  Close this window to stop the bridge.
echo ==============================================
echo.
"%DIR%\venv\Scripts\python.exe" "%DIR%\openln-cardbridge.py" --http
echo The card bridge stopped.
pause
