#!/usr/bin/env bash
set -euo pipefail

HOST="${PRINTGO_REMOTE_HOST:-printgo-windows}"
LINES="50"
FOLLOW=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--lines)
      LINES="$2"
      shift 2
      ;;
    -f|--follow)
      FOLLOW=1
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [-n <lines>] [-f|--follow]"
      echo "  -n, --lines <N>   Number of recent log lines to retrieve (default: 50)"
      echo "  -f, --follow      Follow/tail live log output"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [[ "$FOLLOW" -eq 1 ]]; then
  echo "--- Following live PrintGo Agent logs from $HOST (Ctrl+C to exit) ---"
  ssh -t "$HOST" "powershell -NoProfile -ExecutionPolicy Bypass -Command \"\$logFile = Join-Path \$env:LOCALAPPDATA 'PrintGo\\daemon.log'; if (Test-Path \$logFile) { Get-Content -Path \$logFile -Tail $LINES -Wait } else { Write-Error 'Log file not found at: '\$logFile; exit 1 }\""
else
  echo "--- Fetching recent $LINES lines of PrintGo Agent logs from $HOST ---"
  ssh "$HOST" "powershell -NoProfile -ExecutionPolicy Bypass -Command \"\$logFile = Join-Path \$env:LOCALAPPDATA 'PrintGo\\daemon.log'; if (Test-Path \$logFile) { Get-Content -Path \$logFile -Tail $LINES } else { Write-Host '[INFO] No daemon.log found at: '\$logFile }\""
fi
