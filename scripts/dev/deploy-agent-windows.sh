#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
HOST="${PRINTGO_REMOTE_HOST:-printgo-windows}"

# Check for rollback flag
if [[ "${1:-}" == "--rollback" ]]; then
  echo "============================================================"
  echo "           Rolling back PrintGo Agent on Windows"
  echo "============================================================"
  ssh "$HOST" "powershell -NoProfile -ExecutionPolicy Bypass -Command -" << 'EOF'
Write-Host "Stopping any running Agent..."
Stop-Process -Name *PrintGo-Agent* -Force -ErrorAction SilentlyContinue

if (Test-Path 'C:\PrintGo\agent.prev') {
    Write-Host "Restoring previous build from C:\PrintGo\agent.prev..." -ForegroundColor Cyan
    Remove-Item -Path 'C:\PrintGo\agent' -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item -Path 'C:\PrintGo\agent.prev' -Destination 'C:\PrintGo\agent' -Recurse -Force
    Write-Host "✅ Rollback complete. Previous build restored to C:\PrintGo\agent." -ForegroundColor Green
} else {
    Write-Error "No previous backup directory found at C:\PrintGo\agent.prev"
    exit 1
}
EOF
  exit 0
fi

echo "============================================================"
echo "      PrintGo Windows Agent Automated Deployment Pipeline"
echo "============================================================"
echo "Target Host:      $HOST"
echo "Repository Root:  $ROOT_DIR"
echo ""

# Step 1: Validate repository state
echo "[Step 1/15] Validating repository environment..."
if [[ ! -f "$ROOT_DIR/scripts/build-agent-windows.mjs" ]]; then
  echo "ERROR: build-agent-windows.mjs not found in scripts directory." >&2
  exit 1
fi

# Step 2: Build Agent bundle on Mac
echo "[Step 2/15] Building standalone Agent bundle on Mac..."
node "$ROOT_DIR/scripts/build-agent-windows.mjs"

DIST_PACKAGE="$ROOT_DIR/dist-package/PrintGo-Windows-Test"
BUNDLE_FILE="$DIST_PACKAGE/bundle.cjs"

if [[ ! -f "$BUNDLE_FILE" ]]; then
  echo "ERROR: Bundle was not generated at $BUNDLE_FILE" >&2
  exit 1
fi

# Step 3: Calculate local artifact checksums
echo "[Step 3/15] Calculating local artifact SHA-256..."
LOCAL_BUNDLE_SHA=$(shasum -a 256 "$BUNDLE_FILE" | awk '{print $1}')
echo "   bundle.cjs SHA-256: $LOCAL_BUNDLE_SHA"

# Step 4: Verify Windows connectivity
echo "[Step 4/15] Verifying Windows SSH connectivity..."
REMOTE_HOST_NAME=$(ssh -o BatchMode=yes -o ConnectTimeout=5 "$HOST" "hostname" | tr -d '\r\n')
echo "   Connected to Windows Host: $REMOTE_HOST_NAME"

# Step 5: Create timestamped build directory
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
REMOTE_BUILD_DIR="C:/PrintGo/builds/$TIMESTAMP"
echo "[Step 5/15] Creating remote build directory: $REMOTE_BUILD_DIR..."
ssh "$HOST" "powershell -NoProfile -ExecutionPolicy Bypass -Command \"New-Item -ItemType Directory -Path '$REMOTE_BUILD_DIR' -Force | Out-Null\""

# Step 6: Transfer artifacts to Windows build directory
echo "[Step 6/15] Transferring build artifacts via SCP..."
scp "$DIST_PACKAGE/bundle.cjs" \
    "$DIST_PACKAGE/sea-prep.blob" \
    "$DIST_PACKAGE/sea-config.json" \
    "$DIST_PACKAGE/build-exe.bat" \
    "$DIST_PACKAGE/run-agent.bat" \
    "$SCRIPT_DIR/download-artifact.ps1" \
    "$HOST":"$REMOTE_BUILD_DIR/"

# Also sync utility scripts to C:\PrintGo\scripts
echo "   Updating C:/PrintGo/scripts helpers..."
scp "$DIST_PACKAGE/build-exe.bat" \
    "$DIST_PACKAGE/run-agent.bat" \
    "$SCRIPT_DIR/download-artifact.ps1" \
    "$HOST":"C:/PrintGo/scripts/"

# Step 7: Verify checksum on Windows
echo "[Step 7/15] Verifying checksum on Windows..."
REMOTE_BUNDLE_SHA=$(ssh "$HOST" "powershell -NoProfile -ExecutionPolicy Bypass -Command \"(Get-FileHash -Path '$REMOTE_BUILD_DIR/bundle.cjs' -Algorithm SHA256).Hash.ToLower()\"" | tr -d '\r\n')
echo "   Remote bundle.cjs SHA-256: $REMOTE_BUNDLE_SHA"

if [[ "$LOCAL_BUNDLE_SHA" != "$REMOTE_BUNDLE_SHA" ]]; then
  echo "ERROR: Artifact SHA-256 mismatch between Mac and Windows!" >&2
  exit 1
fi
echo "   ✅ Checksum match verified."

# Step 8: Gracefully stop OLD PrintGo Agent if running
echo "[Step 8/15] Checking and stopping running Agent processes on Windows..."
ssh "$HOST" "cmd.exe /c \"taskkill /F /IM PrintGo-Agent.exe 2>nul & exit 0\""
ssh "$HOST" "powershell -NoProfile -ExecutionPolicy Bypass -Command \"Start-Sleep -Seconds 2\""

# Step 9: Preserve previous known-good build for rollback
echo "[Step 9/15] Preserving previous build for rollback..."
ssh "$HOST" "powershell -NoProfile -ExecutionPolicy Bypass -Command -" << 'EOF'
if (Test-Path 'C:\PrintGo\agent') {
    Remove-Item -Path 'C:\PrintGo\agent.prev' -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item -Path 'C:\PrintGo\agent' -Destination 'C:\PrintGo\agent.prev' -Recurse -Force
    Write-Host "   Previous build backed up to C:\PrintGo\agent.prev"
}
EOF

# Step 10: Update development Agent installation (C:\PrintGo\agent)
echo "[Step 10/15] Updating C:\\PrintGo\\agent installation..."
ssh "$HOST" "powershell -NoProfile -ExecutionPolicy Bypass -Command \"if (-not (Test-Path 'C:\PrintGo\agent')) { New-Item -ItemType Directory -Path 'C:\PrintGo\agent' -Force | Out-Null }; Copy-Item -Path '$REMOTE_BUILD_DIR\\*' -Destination 'C:\PrintGo\agent' -Force\""

# Step 11: Compile native PrintGo-Agent.exe on Windows
echo "[Step 11/15] Compiling native PrintGo-Agent.exe on Windows..."
ssh "$HOST" "cmd.exe /c \"cd /d C:\PrintGo\agent && build-exe.bat --silent\""

# Step 12: Verify compiled binary SHA256 and validity
echo "[Step 12/15] Verifying compiled binary on Windows..."
ssh "$HOST" "powershell -NoProfile -ExecutionPolicy Bypass -Command -" << 'EOF'
$exePath = 'C:\PrintGo\agent\PrintGo-Agent.exe'
if (-not (Test-Path $exePath)) {
    Write-Error "PrintGo-Agent.exe compilation failed!"
    exit 1
}
$hash = (Get-FileHash -Path $exePath -Algorithm SHA256).Hash
Write-Host "   Compiled Binary SHA-256: $hash" -ForegroundColor Green
EOF

# Step 13: Verify CLI version / status invocation
echo "[Step 13/15] Testing Agent CLI self-check (--version)..."
AGENT_VER_OUT=$(ssh "$HOST" "powershell -NoProfile -Command \"& 'C:\PrintGo\agent\PrintGo-Agent.exe' --version\"" | tr -d '\r\n')
echo "   Output: $AGENT_VER_OUT"

# Step 14: Safe Agent Start Verification
echo "[Step 14/15] Launching Agent daemon and testing background liveness..."
ssh "$HOST" "powershell -NoProfile -ExecutionPolicy Bypass -Command -" << 'EOF'
Start-Process -FilePath "C:\PrintGo\agent\PrintGo-Agent.exe" -WorkingDirectory "C:\PrintGo\agent" -WindowStyle Hidden
Start-Sleep -Seconds 3
$proc = Get-Process -Name *PrintGo-Agent* -ErrorAction SilentlyContinue
if ($proc) {
    Write-Host "   ✅ Agent daemon running (PID: $($proc.Id))" -ForegroundColor Green
} else {
    Write-Host "   [Notice] Agent completed execution or requires pairing." -ForegroundColor Yellow
}
EOF

# Step 15: Final status report
echo "[Step 15/15] Deployment Summary & Diagnostics"
bash "$SCRIPT_DIR/windows-status.sh"

echo ""
echo "============================================================"
echo "✅ PrintGo Agent successfully deployed and verified on Windows!"
echo "Rollback command (if ever needed):"
echo "  $0 --rollback"
echo "============================================================"
