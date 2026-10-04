#!/usr/bin/env bash
set -euo pipefail

HOST="${PRINTGO_REMOTE_HOST:-printgo-windows}"

echo "============================================================"
echo "          PrintGo Windows Environment & Agent Status"
echo "============================================================"
echo "Target Host: $HOST"

# 1. SSH Reachability check
if ! ssh -o BatchMode=yes -o ConnectTimeout=3 "$HOST" "hostname" >/dev/null 2>&1; then
  echo "Windows Reachable: NO"
  echo "SSH Connection:    FAILED"
  echo "Please check that the Windows laptop is online and on the same LAN."
  exit 1
fi

echo "Windows Reachable: YES"
echo "SSH Connection:    OK"

# 2. Comprehensive Remote Inspection
ssh "$HOST" "powershell -NoProfile -ExecutionPolicy Bypass -Command -" << 'EOF'
$os = (Get-CimInstance Win32_OperatingSystem).Caption
$hostname = $env:COMPUTERNAME
Write-Host "Hostname:          $hostname"
Write-Host "Operating System:  $os"

$exePath = "C:\PrintGo\agent\PrintGo-Agent.exe"
if (Test-Path $exePath) {
    $hash = (Get-FileHash -Path $exePath -Algorithm SHA256).Hash.Substring(0, 16) + '...'
    $mtime = (Get-Item $exePath).LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "Agent Installed:   YES (SHA256: $hash | Modified: $mtime)"
} else {
    Write-Host "Agent Installed:   NO (Run deploy-agent-windows.sh)" -ForegroundColor Yellow
}

$procs = Get-Process -Name *PrintGo-Agent* -ErrorAction SilentlyContinue
if ($procs) {
    $pidList = ($procs | ForEach-Object { $_.Id }) -join ', '
    $startTime = $procs[0].StartTime.ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "Agent Process:     RUNNING (PID: $pidList | Started: $startTime)" -ForegroundColor Green
} else {
    Write-Host "Agent Process:     STOPPED" -ForegroundColor Yellow
}

$statusPath = Join-Path $env:LOCALAPPDATA 'PrintGo\agent-status.json'
if (Test-Path $statusPath) {
    try {
        $json = Get-Content -Path $statusPath -Raw | ConvertFrom-Json
        Write-Host "Operational State: $($json.operationalState)"
        Write-Host "Agent Version:     $($json.agentVersion)"
        Write-Host "Server URL:        $($json.serverUrl)"
        Write-Host "Display Name:      $($json.displayName)"
        if ($json.lastHeartbeatMs) {
            $hbTime = (Get-Date '1970-01-01 00:00:00Z').AddMilliseconds($json.lastHeartbeatMs).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss')
            Write-Host "Last Heartbeat:    $hbTime"
        }
    } catch {
        Write-Host "Status JSON Parse: Error" -ForegroundColor Red
    }
}

Write-Host "`n--- Printer Discovery ---" -ForegroundColor Cyan
$printers = Get-CimInstance Win32_Printer -ErrorAction SilentlyContinue
if ($printers) {
    $printers | Select-Object Name, PortName, PrinterStatus, WorkOffline | Format-Table -AutoSize | Out-String | Write-Host
} else {
    Write-Host "No printers discovered." -ForegroundColor Yellow
}

Write-Host "--- Latest Log / Error Diagnostic ---" -ForegroundColor Cyan
$logPath = Join-Path $env:LOCALAPPDATA 'PrintGo\daemon.log'
if (Test-Path $logPath) {
    $lastLines = Get-Content -Path $logPath -Tail 5
    $lastLines | ForEach-Object { Write-Host "  $_" }
} else {
    Write-Host "  (No log file created yet)"
}
EOF

echo "============================================================"
