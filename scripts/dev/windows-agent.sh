#!/usr/bin/env bash
set -euo pipefail

HOST="${PRINTGO_REMOTE_HOST:-printgo-windows}"
AGENT_DIR="C:\\PrintGo\\agent"

action="${1:-help}"

case "$action" in
  status)
    echo "=== PrintGo Agent Process & Service Status on $HOST ==="
    ssh "$HOST" "powershell -NoProfile -ExecutionPolicy Bypass -Command -" << 'EOF'
Write-Host "[Process Status]" -ForegroundColor Cyan
$procs = Get-Process -Name *PrintGo-Agent* -ErrorAction SilentlyContinue
if ($procs) {
    $procs | Select-Object Id, ProcessName, WorkingSet64, StartTime | Format-Table -AutoSize | Out-String | Write-Host
} else {
    Write-Host "No PrintGo-Agent process is currently running." -ForegroundColor Yellow
}

Write-Host "`n[Status File Report]" -ForegroundColor Cyan
$statusPath = Join-Path $env:LOCALAPPDATA 'PrintGo\agent-status.json'
if (Test-Path $statusPath) {
    try {
        $json = Get-Content -Path $statusPath -Raw | ConvertFrom-Json
        Write-Host "Operational State: $($json.operationalState)"
        Write-Host "Agent Version:     $($json.agentVersion)"
        Write-Host "Server URL:        $($json.serverUrl)"
        Write-Host "Agent ID:          $($json.agentId)"
        Write-Host "Display Name:      $($json.displayName)"
        if ($json.lastHeartbeatMs) {
            $hbTime = (Get-Date '1970-01-01 00:00:00Z').AddMilliseconds($json.lastHeartbeatMs).ToLocalTime()
            Write-Host "Last Heartbeat:    $hbTime"
        }
        Write-Host "Printers Count:    $($json.printers.Count)"
    } catch {
        Write-Host "Could not parse status JSON file." -ForegroundColor Red
    }
} else {
    Write-Host "Status file not found at: $statusPath" -ForegroundColor Yellow
}
EOF
    ;;

  start)
    echo "=== Starting PrintGo Agent on $HOST ==="
    ssh "$HOST" "powershell -NoProfile -ExecutionPolicy Bypass -Command -" << 'EOF'
$procs = Get-Process -Name *PrintGo-Agent* -ErrorAction SilentlyContinue
if ($procs) {
    Write-Host "PrintGo-Agent is already running (PID: $($procs.Id))." -ForegroundColor Yellow
    exit 0
}

$exePath = "C:\PrintGo\agent\PrintGo-Agent.exe"
if (-not (Test-Path $exePath)) {
    Write-Error "PrintGo-Agent.exe not found at C:\PrintGo\agent\PrintGo-Agent.exe. Please deploy first."
    exit 1
}

Write-Host "Launching PrintGo-Agent detached process..." -ForegroundColor Green
$result = ([wmiclass]'win32_process').Create($exePath, "C:\PrintGo\agent", $null)
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
$procs = Get-Process -Name *PrintGo-Agent* -ErrorAction SilentlyContinue
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
