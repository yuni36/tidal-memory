@echo off
chcp 65001 >nul 2>&1
title Tidal Starter
setlocal EnableDelayedExpansion

set "ROOT=%~dp0"
cd /d "%ROOT%"

REM ---- RELAY_SECRET：环境变量 > sidecar > 开发默认 0 ----
if not defined RELAY_SECRET set RELAY_SECRET=0
if exist "%ROOT%chat_relay\.relay_secret" (
  set /p RELAY_SECRET=<"%ROOT%chat_relay\.relay_secret"
)

echo ========================================
echo   Tidal — start (this folder only)
echo ========================================
echo.

REM ---- 依赖自检（缺则打印命令后退出，不瞎启）----
if not exist "%ROOT%.venv\Scripts\python.exe" (
  echo [FAIL] 缺少 .venv
  echo   在本目录执行:
  echo     python -m venv .venv
  echo     .\.venv\Scripts\python.exe -m pip install -r requirements.txt
  pause
  exit /b 1
)

set "NODE_EXE="
where node.exe >nul 2>&1 && for /f "delims=" %%i in ('where node.exe') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE if exist "%ROOT%tools\nodejs\node.exe" (
  set "PATH=%ROOT%tools\nodejs;!PATH!"
  set "NODE_EXE=%ROOT%tools\nodejs\node.exe"
  echo [info] 使用项目内便携 Node: tools\nodejs
)
if not defined NODE_EXE (
  echo [FAIL] 找不到 node.exe（需要 Node 22+）
  echo   1^) 安装 Node 22+ 后重开终端；或
  echo   2^) 把便携版解压到项目 tools\nodejs\ 目录
  pause
  exit /b 1
)

if not exist "%ROOT%memory_service\node_modules" (
  echo [FAIL] 缺少 memory_service\node_modules
  echo   执行:
  echo     cd memory_service
  echo     npm install
  echo     cd ..
  pause
  exit /b 1
)

for %%S in (ai_brain chat_relay memory_service) do (
  if not exist "%ROOT%%%S\.env" (
    if exist "%ROOT%%%S\.env.example" (
      echo [info] 复制 %%S\.env.example -^> %%S\.env （请自行填入测试 Key）
      copy /Y "%ROOT%%%S\.env.example" "%ROOT%%%S\.env" >nul
    ) else (
      echo [WARN] 缺少 %%S\.env
    )
  )
)

echo [0/4] 只停止本目录残留进程...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root = [regex]::Escape($env:ROOT);" ^
  "$scripts = 'chroma_server|chat_relay[\\/]app\.py|bridge\.py|server\.js';" ^
  "$procs = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.Name -match '^(cmd|python|pythonw|node)\.exe$' -and $_.CommandLine -match $root -and $_.CommandLine -match $scripts });" ^
  "if ($procs.Count -gt 0) { $procs | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>&1 | Out-Null } }"
timeout /t 2 /nobreak >nul
echo.

if not exist "%ROOT%chat_relay\data" mkdir "%ROOT%chat_relay\data"
if not exist "%ROOT%memory_service\data" mkdir "%ROOT%memory_service\data"

echo [1/4] ChromaDB :7707 ...
start "Tidal-Chroma" /min cmd /c "set PYTHONIOENCODING=utf-8&& cd /d "%ROOT%" && .\.venv\Scripts\python.exe -u memory_service\chroma_server.py"
set CHROMA_RETRY=0
:wait_chroma
curl.exe -sf http://127.0.0.1:7707/health >nul 2>&1
if not errorlevel 1 goto chroma_ready
set /a CHROMA_RETRY+=1
if %CHROMA_RETRY% geq 20 goto chroma_timeout
timeout /t 1 /nobreak >nul
goto wait_chroma
:chroma_ready
echo   OK (%CHROMA_RETRY%s)
goto chroma_done
:chroma_timeout
echo   WARNING: Chroma 超时（向量检索可能降级）
:chroma_done

echo [2/4] Chat Relay :3011 ...
start "Tidal-Relay" /min cmd /c "set PYTHONIOENCODING=utf-8&& set RELAY_SECRET=%RELAY_SECRET%&& cd /d "%ROOT%" && .\.venv\Scripts\python.exe -u chat_relay\app.py"
set RELAY_RETRY=0
:wait_relay
curl.exe -sf http://127.0.0.1:3011/healthz >nul 2>&1
if errorlevel 1 goto relay_retry
curl.exe -sf http://127.0.0.1:3011/app/history -H "Authorization: Bearer %RELAY_SECRET%" >nul 2>&1
if errorlevel 1 goto relay_retry
goto relay_ready
:relay_retry
set /a RELAY_RETRY+=1
if %RELAY_RETRY% geq 25 goto relay_timeout
timeout /t 1 /nobreak >nul
goto wait_relay
:relay_ready
echo   OK (%RELAY_RETRY%s)
goto relay_done
:relay_timeout
echo   WARNING: Relay 超时
:relay_done

echo [3/4] Memory :3013 ...
start "Tidal-Memory" /min cmd /c "set RELAY_SECRET=%RELAY_SECRET%&& cd /d "%ROOT%memory_service" && "%NODE_EXE%" server.js"
set MEM_RETRY=0
:wait_mem
curl.exe -sf http://127.0.0.1:3013/healthz >nul 2>&1
if not errorlevel 1 goto mem_ready
set /a MEM_RETRY+=1
if %MEM_RETRY% geq 25 goto mem_timeout
timeout /t 1 /nobreak >nul
goto wait_mem
:mem_ready
echo   OK (%MEM_RETRY%s)
goto mem_done
:mem_timeout
echo   WARNING: Memory 超时
:mem_done

echo [4/4] AI Brain ...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root = [regex]::Escape($env:ROOT);" ^
  "if (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -match $root -and $_.CommandLine -match 'bridge\.py' }) { exit 1 } else { exit 0 }"
if errorlevel 1 (
  echo   Brain 已在本目录运行，跳过
  goto brain_done
)
start "Tidal-Brain" /min cmd /c "set PYTHONIOENCODING=utf-8&& set RELAY_SECRET=%RELAY_SECRET%&& cd /d "%ROOT%" && .\.venv\Scripts\python.exe -u ai_brain\bridge.py"
timeout /t 3 /nobreak >nul
:brain_done

echo.
echo ========================================
echo   Started. Open: http://127.0.0.1:3011
echo   登录密钥默认: %RELAY_SECRET%
echo   停止: 双击 stop.bat （只停本目录）
echo ========================================
pause
endlocal
