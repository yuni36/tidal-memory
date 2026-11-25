@echo off
chcp 65001 >nul 2>&1
title Tidal Stop
set "ROOT=%~dp0"
echo Stopping processes started from this folder only...
echo   %ROOT%
echo.

REM start.bat launches "cmd /c cd /d <ROOT> && python/node ...": the real server
REM runs as a child of the .venv launcher and its own command line has only
REM relative paths, so match the cmd shell by absolute ROOT + script name and
REM kill the whole process tree (taskkill /T). Absolute-path launches also match.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root = [regex]::Escape($env:ROOT);" ^
  "$scripts = 'chroma_server|chat_relay[\\/]app\.py|bridge\.py|server\.js';" ^
  "$procs = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.Name -match '^(cmd|python|pythonw|node)\.exe$' -and $_.CommandLine -match $root -and $_.CommandLine -match $scripts });" ^
  "if ($procs.Count -eq 0) { Write-Host 'Nothing running for this folder.' }" ^
  "else { $procs | ForEach-Object { Write-Host ('STOP ' + $_.Name + ' ' + $_.ProcessId); taskkill /PID $_.ProcessId /T /F 2>&1 | Out-Null } };" ^
  "Start-Sleep -Milliseconds 800;" ^
  "foreach ($port in 7707,3011,3013) {" ^
  "  $c = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1;" ^
  "  if ($c) { $pn = (Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue).ProcessName;" ^
  "    Write-Host ('WARN port ' + $port + ' still listening -> PID ' + $c.OwningProcess + ' ' + $pn);" ^
  "    Write-Host ('     maybe started from another folder. If it is yours: taskkill /PID ' + $c.OwningProcess + ' /T /F') }" ^
  "}"

echo.
echo Done.
ping -n 3 127.0.0.1 >nul 2>&1
