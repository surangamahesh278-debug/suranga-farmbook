@echo off
setlocal
title Suranga FarmBook
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
if errorlevel 1 (
  echo.
  echo FarmBook could not start. Please check that Windows PowerShell is available.
  pause
)
endlocal
