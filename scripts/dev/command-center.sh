#!/usr/bin/env bash

# PrintGo Command Center (Interactive Development & Operations Dashboard)
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$REPO_DIR/scripts/dev"
HOST="${PRINTGO_REMOTE_HOST:-printgo-windows}"

# Colors
C_RESET="\033[0m"
C_BOLD="\033[1m"
C_GREEN="\033[32m"
C_RED="\033[31m"
C_YELLOW="\033[33m"
C_CYAN="\033[36m"
C_BLUE="\033[34m"

# Detect if running directly on local Windows (Git Bash / MSYS)
IS_LOCAL_WINDOWS=false
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || -n "${WINDIR:-}" || -n "${LOCALAPPDATA:-}" ]]; then
    IS_LOCAL_WINDOWS=true
fi

# Locate local PrintGo-Agent.exe if on Windows
find_local_agent() {
    local candidates=(
        "/c/Program Files/PrintGo/PrintGo-Agent.exe"
        "${LOCALAPPDATA//\\//}/Programs/PrintGo/PrintGo-Agent.exe"
        "/c/Users/$USER/AppData/Local/Programs/PrintGo/PrintGo-Agent.exe"
        "/c/Users/$USERNAME/AppData/Local/Programs/PrintGo/PrintGo-Agent.exe"
        "/c/PrintGo/agent/PrintGo-Agent.exe"
    )
    for c in "${candidates[@]}"; do
        if [[ -f "$c" ]]; then
            echo "$c"
            return 0
        fi
    done
    echo ""
}

while true; do
    clear
    echo -e "${C_BOLD}${C_BLUE}======================================================================${C_RESET}"
    echo -e "${C_BOLD}                   PrintGo — Control & Command Center                 ${C_RESET}"
    echo -e "${C_BOLD}${C_BLUE}======================================================================${C_RESET}"

    # Reachability Telemetry
    if [ "$IS_LOCAL_WINDOWS" = true ]; then
        WIN_NAME="${COMPUTERNAME:-$(hostname 2>/dev/null || echo "Windows-PC")}"
        WIN_USER="$(whoami 2>/dev/null || echo "$USERNAME")"
        echo -e " Windows Host:   ${C_GREEN}● ONLINE (Local Machine: ${WIN_NAME} | Account: ${WIN_USER})${C_RESET}"
    elif ssh -o BatchMode=yes -o ConnectTimeout=2 "$HOST" "hostname" >/dev/null 2>&1; then
        WIN_NAME=$(ssh -o BatchMode=yes -o ConnectTimeout=2 "$HOST" "hostname" 2>/dev/null | tr -d '\r\n')
        WIN_USER=$(ssh -o BatchMode=yes -o ConnectTimeout=2 "$HOST" "whoami" 2>/dev/null | tr -d '\r\n')
        echo -e " Windows Host:   ${C_GREEN}● ONLINE${C_RESET} (${WIN_NAME} | Account: ${WIN_USER})"
    else
        echo -e " Windows Host:   ${C_RED}○ OFFLINE${C_RESET} (Attempting discovery...)"
        bash "$SCRIPT_DIR/discover-windows.sh" >/dev/null 2>&1 || true
    fi

    echo -e " Cloudflare API: ${C_GREEN}● AVAILABLE${C_RESET} (https://printgo-api.printgo-worker.workers.dev)"
    echo -e " Admin Portal:   ${C_CYAN}https://printgo-admin.pages.dev${C_RESET}"
    echo -e "${C_BLUE}----------------------------------------------------------------------${C_RESET}"
    echo -e "${C_BOLD} ACTIONS:${C_RESET}"
    if [ "$IS_LOCAL_WINDOWS" = true ]; then
        echo -e "  ${C_CYAN}1)${C_RESET} Open PowerShell       ${C_YELLOW}→ Launch interactive PowerShell console${C_RESET}"
    else
        echo -e "  ${C_CYAN}1)${C_RESET} Connect Windows       ${C_YELLOW}→ Open interactive remote PowerShell shell${C_RESET}"
    fi
    echo -e "  ${C_CYAN}2)${C_RESET} Windows Status        ${C_YELLOW}→ View full hardware, OS, & printer diagnosis${C_RESET}"
    echo -e "  ${C_CYAN}3)${C_RESET} Agent Status          ${C_YELLOW}→ Check Agent daemon, heartbeat, & cloud state${C_RESET}"
    echo -e "  ${C_CYAN}4)${C_RESET} Agent Logs (Tail)     ${C_YELLOW}→ View the last 30 log lines${C_RESET}"
    echo -e "  ${C_CYAN}5)${C_RESET} Agent Logs (Live)     ${C_YELLOW}→ Follow live logs in real-time (Ctrl+C to stop)${C_RESET}"
    echo -e "  ${C_CYAN}6)${C_RESET} Printers              ${C_YELLOW}→ Inspect detected Windows printer queues${C_RESET}"
    echo -e "  ${C_CYAN}7)${C_RESET} Restart Agent         ${C_YELLOW}→ Safely restart the local PrintGo Agent daemon${C_RESET}"
    echo -e "  ${C_CYAN}8)${C_RESET} Pair Agent            ${C_YELLOW}→ Enter a pairing code from shop Admin${C_RESET}"
    echo -e "  ${C_CYAN}9)${C_RESET} Open PrintGo Admin    ${C_YELLOW}→ Open Admin Dashboard in default browser${C_RESET}"
    echo -e " ${C_CYAN}10)${C_RESET} System Info           ${C_YELLOW}→ View operating system & machine details${C_RESET}"
    echo -e "  ${C_RED}0)${C_RESET} Exit"
    echo -e "${C_BLUE}======================================================================${C_RESET}"
    read -rp " Select an option [0-10]: " choice

    case "$choice" in
        1)
            if [ "$IS_LOCAL_WINDOWS" = true ]; then
                echo -e "\nStarting PowerShell console (type 'exit' to return to menu)..."
                powershell.exe -NoLogo
            else
                echo -e "\nConnecting to Windows ($HOST)..."
                ssh "$HOST" || true
            fi
            ;;
        2)
            echo ""
            if [ "$IS_LOCAL_WINDOWS" = true ]; then
                powershell.exe -NoProfile -Command "
                    Write-Host 'OS: ' (Get-CimInstance Win32_OperatingSystem).Caption
                    Write-Host 'Hostname: ' \$env:COMPUTERNAME
                    Write-Host 'User: ' (whoami)
                    Get-Process -Name '*PrintGo*' -ErrorAction SilentlyContinue | Select-Object Id, ProcessName
                    Get-CimInstance Win32_Printer | Select-Object Name, PrinterStatus, DetectedErrorState, WorkOffline, Default | Format-Table -AutoSize
                " || true
            else
                bash "$SCRIPT_DIR/windows-status.sh" || true
            fi
            echo ""
            read -rp "Press Enter to return to menu..." _
            ;;
        3)
            echo ""
            if [ "$IS_LOCAL_WINDOWS" = true ]; then
                AGENT_BIN="$(find_local_agent)"
                if [[ -n "$AGENT_BIN" ]]; then
                    "$AGENT_BIN" --status || true
                else
                    echo -e "${C_YELLOW}PrintGo-Agent.exe not found in standard paths.${C_RESET}"
                fi
            else
                bash "$SCRIPT_DIR/windows-agent.sh" status || true
            fi
            echo ""
            read -rp "Press Enter to return to menu..." _
            ;;
        4)
            echo ""
            LOG_FILE=""
            if [ "$IS_LOCAL_WINDOWS" = true ]; then
                if [[ -n "${LOCALAPPDATA:-}" && -f "${LOCALAPPDATA//\\//}/PrintGo/daemon.log" ]]; then
                    LOG_FILE="${LOCALAPPDATA//\\//}/PrintGo/daemon.log"
                elif [[ -f "/c/Users/$USER/AppData/Local/PrintGo/daemon.log" ]]; then
                    LOG_FILE="/c/Users/$USER/AppData/Local/PrintGo/daemon.log"
                fi
                if [[ -n "$LOG_FILE" ]]; then
                    echo "Showing last 30 lines of $LOG_FILE:"
                    tail -n 30 "$LOG_FILE" || true
                else
                    echo "No local daemon.log found yet."
                fi
            else
                bash "$SCRIPT_DIR/windows-agent-logs.sh" -n 30 || true
            fi
            echo ""
            read -rp "Press Enter to return to menu..." _
            ;;
        5)
            echo ""
            LOG_FILE=""
            if [ "$IS_LOCAL_WINDOWS" = true ]; then
                if [[ -n "${LOCALAPPDATA:-}" && -f "${LOCALAPPDATA//\\//}/PrintGo/daemon.log" ]]; then
                    LOG_FILE="${LOCALAPPDATA//\\//}/PrintGo/daemon.log"
                elif [[ -f "/c/Users/$USER/AppData/Local/PrintGo/daemon.log" ]]; then
                    LOG_FILE="/c/Users/$USER/AppData/Local/PrintGo/daemon.log"
                fi
                if [[ -n "$LOG_FILE" ]]; then
                    echo "Following live logs (Press Ctrl+C to stop):"
                    tail -f "$LOG_FILE" || true
                else
                    echo "No local daemon.log found yet."
                fi
            else
                bash "$SCRIPT_DIR/windows-agent-logs.sh" --follow || true
            fi
            echo ""
            read -rp "Press Enter to return to menu..." _
            ;;
        6)
            echo ""
            echo "--- Active Windows Printer Queues ---"
            powershell.exe -NoProfile -Command "Get-CimInstance Win32_Printer | Select-Object Name, PortName, PrinterStatus, DetectedErrorState, WorkOffline, Default | Format-Table -AutoSize" || true
            echo ""
            read -rp "Press Enter to return to menu..." _
            ;;
        7)
            echo ""
            read -rp "Are you sure you want to restart the PrintGo Agent daemon? (y/N): " confirm
            if [[ "$confirm" =~ ^[Yy]$ ]]; then
                if [ "$IS_LOCAL_WINDOWS" = true ]; then
                    powershell.exe -NoProfile -Command "Stop-Process -Name 'PrintGo-Agent' -Force -ErrorAction SilentlyContinue"
                    sleep 1
                    AGENT_BIN="$(find_local_agent)"
                    if [[ -n "$AGENT_BIN" ]]; then
                        powershell.exe -NoProfile -Command "Start-Process '$AGENT_BIN' -WindowStyle Hidden"
                        echo -e "${C_GREEN}Local Agent daemon restarted.${C_RESET}"
                    else
                        echo -e "${C_YELLOW}PrintGo-Agent.exe could not be found to start.${C_RESET}"
                    fi
                else
                    bash "$SCRIPT_DIR/windows-agent.sh" stop || true
                    sleep 2
                    bash "$SCRIPT_DIR/windows-agent.sh" start || true
                    echo -e "${C_GREEN}Agent daemon restarted.${C_RESET}"
                fi
            else
                echo "Cancelled."
            fi
            echo ""
            read -rp "Press Enter to return to menu..." _
            ;;
        8)
            echo ""
            read -rp "Enter the 8-character pairing code from shop Admin (e.g. H8X2-9K4M): " pair_code
            if [[ -n "$pair_code" ]]; then
                AGENT_BIN="$(find_local_agent)"
                if [[ -n "$AGENT_BIN" ]]; then
                    echo "Pairing agent with code: $pair_code..."
                    "$AGENT_BIN" --pair "$pair_code" --server "https://printgo-api.printgo-worker.workers.dev" --name "$COMPUTERNAME" || true
                else
                    echo "PrintGo-Agent.exe not found."
                fi
            else
                echo "Pairing cancelled."
            fi
            echo ""
            read -rp "Press Enter to return to menu..." _
            ;;
        9)
            echo -e "\nOpening PrintGo Admin in default browser..."
            cmd.exe /c start "https://printgo-admin.pages.dev" 2>/dev/null || explorer.exe "https://printgo-admin.pages.dev" || true
            sleep 1
            ;;
        10)
            echo ""
            echo -e "${C_BOLD}--- System Information ---${C_RESET}"
            powershell.exe -NoProfile -Command "Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, OSArchitecture, TotalVisibleMemorySize | Format-List" || true
            echo ""
            read -rp "Press Enter to return to menu..." _
            ;;
        0)
            echo "Exiting PrintGo Command Center."
            exit 0
            ;;
        *)
            echo "Invalid selection. Please choose an option from 0 to 10."
            sleep 1
            ;;
    esac
done
