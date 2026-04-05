@echo off
:: Comrade Claw + Cognee Startup Script
:: Run at boot via Task Scheduler (as current user, not SYSTEM)

echo [%date% %time%] Starting Comrade Claw services... >> "%~dp0startup.log"

:: ─── Start Cognee HTTP API ──────────────────────────────────────────────────
:: Persistent Python service on localhost:8001
:: Must start before Claw so knowledge graph tools are available

cd /d E:\AI\cognee-mcp
start /b "" "E:\AI\cognee-mcp\.venv\Scripts\python.exe" http-api.py >> "%~dp0startup.log" 2>&1

:: Wait for Cognee to be ready
echo [%date% %time%] Waiting for Cognee HTTP API... >> "%~dp0startup.log"
:wait_cognee
timeout /t 2 /nobreak >nul
curl -s http://127.0.0.1:8001/health >nul 2>&1
if %errorlevel% neq 0 goto wait_cognee
echo [%date% %time%] Cognee ready on port 8001 >> "%~dp0startup.log"

:: ─── Start Comrade Claw ────���────────────────���───────────────────────────────
:: Node.js Discord bot + scheduler + MCP servers

cd /d E:\AI\CClaw
start /b "" "C:\Program Files\nodejs\node.exe" --tls-cipher-list=DEFAULT src/index.js >> "%~dp0startup.log" 2>&1

echo [%date% %time%] Comrade Claw started >> "%~dp0startup.log"
