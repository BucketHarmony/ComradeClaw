@echo off
:: Registers Comrade Claw startup script with Windows Task Scheduler
:: Run this ONCE as Administrator

echo Creating scheduled task "ComradeClaw" to run at logon...

schtasks /create ^
  /tn "ComradeClaw" ^
  /tr "\"%~dp0startup.cmd\"" ^
  /sc onlogon ^
  /rl highest ^
  /f

if %errorlevel% equ 0 (
    echo.
    echo Task created successfully.
    echo Comrade Claw + Cognee will start automatically at login.
    echo.
    echo To run now:  schtasks /run /tn "ComradeClaw"
    echo To remove:   schtasks /delete /tn "ComradeClaw" /f
    echo To check:    schtasks /query /tn "ComradeClaw"
) else (
    echo.
    echo Failed to create task. Make sure you're running as Administrator.
)

pause
