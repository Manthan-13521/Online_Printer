@echo off
setlocal
echo ===================================================
echo           PrintGo Windows Agent Launcher
echo ===================================================

REM Check for PrintGo-Agent.exe first, then fallback to node bundle.cjs
if exist "%~dp0PrintGo-Agent.exe" (
    echo Launching PrintGo-Agent.exe...
    "%~dp0PrintGo-Agent.exe" %*
) else if exist "%~dp0bundle.cjs" (
    echo PrintGo-Agent.exe not found. Launching via Node.js...
    where node >nul 2>nul
    if %errorlevel% neq 0 (
        echo [ERROR] Node.js is not installed or not in PATH.
        echo Please install Node.js 22 LTS or run PrintGo-Agent.exe.
        pause
        exit /b 1
    )
    node "%~dp0bundle.cjs" %*
) else (
    echo [ERROR] Neither PrintGo-Agent.exe nor bundle.cjs found in %~dp0
    pause
    exit /b 1
)

if %errorlevel% neq 0 (
    echo Agent exited with error code %errorlevel%.
    pause
)
