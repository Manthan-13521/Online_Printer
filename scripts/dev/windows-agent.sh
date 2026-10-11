#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${PRINTGO_REMOTE_HOST:-printgo-windows}"

# Check connection with auto-discovery fallback
if ! ssh -o BatchMode=yes -o ConnectTimeout=2 "$HOST" "hostname" >/dev/null 2>&1; then
  echo "Attempting automatic discovery of Windows laptop..."
  bash "$SCRIPT_DIR/discover-windows.sh" || true
fi

AGENT_DIR="C:\\PrintGo\\agent"

action="${1:-help}"

case "$action" in
  status)
    bash "$SCRIPT_DIR/windows-status.sh"
    ;;

  start)
    echo "=== Starting PrintGo Agent on $HOST ==="
    ssh "$HOST" "powershell -NoProfile -ExecutionPolicy Bypass -Command -" << 'EOF'
$procs = Get-Process -Name *PrintGo* -ErrorAction SilentlyContinue
if ($procs) {
    Write-Host "PrintGo-Agent is already running (PID: $($procs.Id))." -ForegroundColor Yellow
    exit 0
}

$exePath = "C:\Users\MANTH\AppData\Local\Programs\PrintGo\PrintGo-Agent.exe"
$workingDir = "C:\Users\MANTH\AppData\Local\Programs\PrintGo"
if (-not (Test-Path $exePath)) {
    $exePath = "C:\PrintGo\agent\PrintGo-Agent.exe"
    $workingDir = "C:\PrintGo\agent"
}
if (-not (Test-Path $exePath)) {
    Write-Error "PrintGo-Agent.exe not found at $exePath. Please deploy first."
    exit 1
}

Write-Host "Launching PrintGo-Agent detached process..." -ForegroundColor Green
$result = ([wmiclass]'win32_process').Create($exePath, $workingDir, $null)
if ($result.ReturnValue -eq 0) {
    Start-Sleep -Seconds 2
    $newProc = Get-Process -Id $result.ProcessId -ErrorAction SilentlyContinue
    if ($newProc) {
        Write-Host "✅ PrintGo-Agent started successfully (PID: $($result.ProcessId))." -ForegroundColor Green
    } else {
        Write-Host "⚠️ Process launched with PID $($result.ProcessId), checking logs..." -ForegroundColor Yellow
    }
} else {
    Write-Error "Failed to launch process via WMI. Return value: $($result.ReturnValue)"
    exit 1
}
EOF
    ;;

  stop)
    echo "=== Stopping PrintGo Agent on $HOST ==="
    ssh "$HOST" "powershell -NoProfile -ExecutionPolicy Bypass -Command -" << 'EOF'
$procs = Get-Process -Name *PrintGo* -ErrorAction SilentlyContinue
if ($procs) {
    foreach ($p in $procs) {
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    }
}
$procsAfter = Get-Process -Name *PrintGo* -ErrorAction SilentlyContinue
if (-not $procsAfter) {
    Write-Host "✅ PrintGo-Agent process terminated." -ForegroundColor Green
} else {
    foreach ($p in $procsAfter) {
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    }
    Write-Host "✅ PrintGo-Agent process force-killed." -ForegroundColor Green
}
EOF
    ;;

  restart)
    echo "=== Restarting PrintGo Agent on $HOST ==="
    bash "$0" stop
    sleep 2
    bash "$0" start
    ;;

  logs)
    shift || true
    DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    bash "$DIR/windows-agent-logs.sh" "$@"
    ;;

  *)
    echo "Usage: $0 {status|start|stop|restart|logs} [options]"
    exit 1
    ;;
esac
