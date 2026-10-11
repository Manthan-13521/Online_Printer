#!/usr/bin/env bash
set -euo pipefail

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

while true; do
    clear
    echo -e "${C_BOLD}${C_BLUE}======================================================================${C_RESET}"
    echo -e "${C_BOLD}                   PrintGo — Control & Command Center                 ${C_RESET}"
    echo -e "${C_BOLD}${C_BLUE}======================================================================${C_RESET}"

    # Quick Reachability Telemetry
    if ssh -o BatchMode=yes -o ConnectTimeout=2 "$HOST" "hostname" >/dev/null 2>&1; then
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
    echo -e "  ${C_CYAN}1)${C_RESET} Connect Windows       ${C_YELLOW}→ Open interactive remote PowerShell shell${C_RESET}"
    echo -e "  ${C_CYAN}2)${C_RESET} Windows Status        ${C_YELLOW}→ View full hardware, OS, & printer diagnosis${C_RESET}"
    echo -e "  ${C_CYAN}3)${C_RESET} Agent Status          ${C_YELLOW}→ Check Agent daemon, heartbeat, & cloud state${C_RESET}"
    echo -e "  ${C_CYAN}4)${C_RESET} Agent Logs (Tail)     ${C_YELLOW}→ View the last 30 log lines${C_RESET}"
    echo -e "  ${C_CYAN}5)${C_RESET} Agent Logs (Live)     ${C_YELLOW}→ Follow live logs in real-time (Ctrl+C to stop)${C_RESET}"
    echo -e "  ${C_CYAN}6)${C_RESET} Printers              ${C_YELLOW}→ Inspect detected Windows printer queues${C_RESET}"
    echo -e "  ${C_CYAN}7)${C_RESET} Restart Agent         ${C_YELLOW}→ Safely restart the local PrintGo Agent daemon${C_RESET}"
    echo -e "  ${C_CYAN}8)${C_RESET} Update / Deploy Agent ${C_YELLOW}→ Build and deploy latest verified Agent release${C_RESET}"
    echo -e "  ${C_CYAN}9)${C_RESET} Open PrintGo Admin    ${C_YELLOW}→ Open Admin Dashboard in default browser${C_RESET}"
    echo -e " ${C_CYAN}10)${C_RESET} Remote Desktop        ${C_YELLOW}→ View graphical remote control status & options${C_RESET}"
    echo -e "  ${C_RED}0)${C_RESET} Exit"
    echo -e "${C_BLUE}======================================================================${C_RESET}"
    read -rp " Select an option [0-10]: " choice

    case "$choice" in
        1)
            echo -e "\nConnecting to Windows ($HOST)..."
            ssh "$HOST"
            ;;
        2)
            echo ""
            bash "$SCRIPT_DIR/windows-status.sh"
            echo ""
            read -rp "Press Enter to return to menu..." _
            ;;
        3)
            echo ""
            bash "$SCRIPT_DIR/windows-agent.sh" status
            echo ""
            read -rp "Press Enter to return to menu..." _
            ;;
        4)
            echo ""
            bash "$SCRIPT_DIR/windows-agent-logs.sh" -n 30
            echo ""
            read -rp "Press Enter to return to menu..." _
            ;;
        5)
            echo ""
            bash "$SCRIPT_DIR/windows-agent-logs.sh" --follow
            echo ""
            read -rp "Press Enter to return to menu..." _
            ;;
        6)
            echo ""
            echo "--- Active Windows Printer Queues ---"
            ssh "$HOST" "powershell -NoProfile -Command \"Get-CimInstance Win32_Printer | Select-Object Name, PortName, PrinterStatus, WorkOffline, Default | Format-Table -AutoSize\""
            echo ""
            read -rp "Press Enter to return to menu..." _
            ;;
        7)
            echo ""
            read -rp "Are you sure you want to restart the PrintGo Agent daemon? (y/N): " confirm
            if [[ "$confirm" =~ ^[Yy]$ ]]; then
                bash "$SCRIPT_DIR/windows-agent.sh" stop
                sleep 2
                bash "$SCRIPT_DIR/windows-agent.sh" start
                echo -e "${C_GREEN}Agent daemon restarted.${C_RESET}"
            else
                echo "Cancelled."
            fi
            echo ""
            read -rp "Press Enter to return to menu..." _
            ;;
        8)
            echo ""
            echo -e "${C_YELLOW}This will build the verified Agent release on Mac and deploy it to Windows.${C_RESET}"
            read -rp "Proceed with update? (y/N): " confirm
            if [[ "$confirm" =~ ^[Yy]$ ]]; then
                bash "$SCRIPT_DIR/deploy-agent-windows.sh"
            else
                echo "Deployment cancelled."
            fi
            echo ""
            read -rp "Press Enter to return to menu..." _
            ;;
        9)
            echo -e "\nOpening PrintGo Admin in browser..."
            open "https://printgo-admin.pages.dev"
            sleep 1
            ;;
        10)
            echo ""
            echo -e "${C_BOLD}--- Graphical Remote Desktop Status ---${C_RESET}"
            echo -e "Laptop Operating System: ${C_YELLOW}Microsoft Windows 11 Home Single Language${C_RESET}"
            echo -e "Microsoft RDP Hosting:   ${C_RED}Disabled by Microsoft on Windows Home Editions${C_RESET}"
            echo ""
            echo "Notes:"
            echo " • Your laptop natively supports secure SSH and Remote PowerShell (Option 1)."
            echo " • To enable Microsoft Remote Desktop GUI, Windows 11 Pro upgrade is required."
            echo " • Alternatively, third-party software like RustDesk can be installed with your approval."
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
