@echo off
setlocal
cls
echo ===================================================
echo           PrintGo Windows Agent Launcher
echo ===================================================
echo.
echo  1. Start PrintGo Agent
echo  2. Reset Pairing Credentials
echo  3. Exit
echo.
set /p choice="Select an option (press Enter for 1): "

if "%choice%"=="2" goto :reset_pairing
if "%choice%"=="3" goto :done
REM Default: option 1 — start agent

:start_agent
REM Check for PrintGo-Agent.exe first, then fallback to node bundle.cjs
if exist "%~dp0PrintGo-Agent.exe" (
    echo Launching PrintGo-Agent.exe...
    echo.
    "%~dp0PrintGo-Agent.exe"
) else if exist "%~dp0bundle.cjs" (
    echo PrintGo-Agent.exe not found. Launching via Node.js...
    where node >nul 2>nul
    if %errorlevel% neq 0 (
        echo [ERROR] Node.js is not installed or not in PATH.
        echo Please install Node.js 22 LTS or run PrintGo-Agent.exe.
        pause
        exit /b 1
    )
    node "%~dp0bundle.cjs"
) else (
    echo [ERROR] Neither PrintGo-Agent.exe nor bundle.cjs found in %~dp0
    pause
    exit /b 1
)
if %errorlevel% neq 0 (
    echo.
    echo Agent exited with error code %errorlevel%.
)
pause
goto :done

:reset_pairing
echo.
echo Resetting pairing credentials...
if exist "%~dp0PrintGo-Agent.exe" (
    "%~dp0PrintGo-Agent.exe" --reset-pairing
) else if exist "%~dp0bundle.cjs" (
    where node >nul 2>nul
    if %errorlevel% neq 0 (
        echo [ERROR] Node.js is not installed or not in PATH.
        pause
        exit /b 1
    )
    node "%~dp0bundle.cjs" --reset-pairing
) else (
    echo [ERROR] Neither PrintGo-Agent.exe nor bundle.cjs found in %~dp0
    pause
    exit /b 1
)
echo.
echo Pairing credentials reset. Launch option 1 to pair again.
pause
goto :done

:done
endlocal
