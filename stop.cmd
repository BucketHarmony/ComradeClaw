@echo off
:: Stop Comrade Claw + Cognee

echo Stopping Comrade Claw...
for /f "tokens=2" %%i in ('wmic process where "CommandLine like '%%src/index.js%%' and name='node.exe'" get ProcessId /format:list ^| findstr ProcessId') do (
    taskkill /pid %%i /f 2>nul
)

echo Stopping Cognee HTTP API...
for /f "tokens=2" %%i in ('wmic process where "CommandLine like '%%http-api.py%%'" get ProcessId /format:list ^| findstr ProcessId') do (
    taskkill /pid %%i /f 2>nul
)

echo Done.
