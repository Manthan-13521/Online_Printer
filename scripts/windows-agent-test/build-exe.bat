@echo off
setlocal
echo ===================================================
echo       Build Native PrintGo-Agent.exe on Windows
echo ===================================================

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is required to compile PrintGo-Agent.exe.
    pause
    exit /b 1
)

echo 1. Generating SEA preparation blob...
node --experimental-sea-config sea-config.json

echo 2. Copying Node.js executable template...
for /f "delims=" %%i in ('where node') do set NODE_PATH=%%i & goto :found_node
:found_node
echo Using Node binary at: %NODE_PATH%
copy "%NODE_PATH%" "%~dp0PrintGo-Agent.exe" /Y

echo 3. Injecting SEA blob via postject...
npx --yes postject "%~dp0PrintGo-Agent.exe" NODE_SEA_BLOB "%~dp0sea-prep.blob" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

echo.
echo ===================================================
echo PrintGo-Agent.exe build completed successfully!
echo You can now run PrintGo-Agent.exe or run-agent.bat
echo ===================================================
if "%1"=="/silent" goto :done
if "%1"=="--silent" goto :done
pause
:done
