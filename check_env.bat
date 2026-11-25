@echo off
chcp 65001 >nul 2>&1
set "ROOT=%~dp0"
cd /d "%ROOT%"
set ERR=0

echo === Tidal env check ===
if exist ".venv\Scripts\python.exe" (echo [OK] .venv) else (echo [MISS] .venv — python -m venv .venv ^& .\.venv\Scripts\python.exe -m pip install -r requirements.txt & set ERR=1)
where node.exe >nul 2>&1 && (echo [OK] node on PATH) || (
  if exist "tools\nodejs\node.exe" (echo [OK] portable node via tools\nodejs) else (echo [MISS] node.exe — install Node 22+ or unzip portable to tools\nodejs\ & set ERR=1)
)
if exist "memory_service\node_modules" (echo [OK] memory_service\node_modules) else (echo [MISS] npm install in memory_service & set ERR=1)
for %%S in (ai_brain chat_relay memory_service) do (
  if exist "%%S\.env" (echo [OK] %%S\.env) else (echo [MISS] %%S\.env — copy from .env.example then fill keys & set ERR=1)
)
if exist "LICENSE" (echo [OK] LICENSE) else (echo [MISS] LICENSE)
echo.
if %ERR%==0 (echo Ready. Run start.bat) else (echo Fix MISS items first.)
pause
