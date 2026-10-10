#!/usr/bin/env bash
set -euo pipefail

# PrintGo Windows Host Discovery & Config Sync
# Resolves Windows laptop IP and ensures ~/.ssh/config is up-to-date.

SSH_CONFIG="$HOME/.ssh/config"
TARGET_HOSTNAME="BHAVESH"

# Check if current host in ssh config is reachable
if ssh -o BatchMode=yes -o ConnectTimeout=2 printgo-windows "hostname" >/dev/null 2>&1; then
    CURRENT_IP=$(ssh printgo-windows "powershell -NoProfile -Command \"(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { \$_.InterfaceAlias -match 'Wi-Fi|Ethernet' }).IPAddress\"" 2>/dev/null | tr -d '\r\n')
    echo "Windows host ($TARGET_HOSTNAME) is online at $CURRENT_IP."
    exit 0
fi

echo "Stored host not reachable. Discovering Windows laptop on local network..."

FOUND_IP=""

# Try mDNS first
MDNS_IP=$(ping -c 1 bhavesh.local 2>/dev/null | grep -Eo '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -n 1 || true)
if [[ -n "$MDNS_IP" ]] && nc -z -G 1 "$MDNS_IP" 22 2>/dev/null; then
    FOUND_IP="$MDNS_IP"
fi

# Fallback: scan active ARP entries for open SSH with correct key
if [[ -z "$FOUND_IP" ]]; then
    for candidate in $(arp -a | grep -Eo '([0-9]{1,3}\.){3}[0-9]{1,3}' | sort -u); do
        if nc -z -G 1 "$candidate" 22 2>/dev/null; then
            if ssh -i "$HOME/.ssh/printgo_windows_ed25519" -o BatchMode=yes -o ConnectTimeout=2 -o StrictHostKeyChecking=accept-new "MANTH@$candidate" "hostname" 2>/dev/null | grep -q "$TARGET_HOSTNAME"; then
                FOUND_IP="$candidate"
                break
            fi
        fi
    done
fi

if [[ -n "$FOUND_IP" ]]; then
    echo "Found $TARGET_HOSTNAME at $FOUND_IP. Updating $SSH_CONFIG..."
    # Update HostName in ~/.ssh/config for Host printgo-windows
    awk -v ip="$FOUND_IP" '
        /^Host printgo-windows$/ { in_host=1; print; next }
        in_host && /^[[:space:]]*HostName[[:space:]]+/ { print "    HostName " ip; in_host=0; next }
        /^[[:space:]]*Host[[:space:]]+/ && !/^Host printgo-windows$/ { in_host=0 }
        { print }
    ' "$SSH_CONFIG" > "${SSH_CONFIG}.tmp" && mv "${SSH_CONFIG}.tmp" "$SSH_CONFIG"
    echo "Updated printgo-windows to $FOUND_IP."
else
    echo "ERROR: Could not locate Windows laptop on the local network."
    exit 1
fi
