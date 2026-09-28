================================================================================
PRINTGO WINDOWS AGENT - HARDWARE TESTING GUIDE
================================================================================

This package contains the standalone PrintGo Windows Agent distribution for pairing
a physical Windows PC + connected receipt/document printer to the PrintGo system.

--------------------------------------------------------------------------------
1. PREREQUISITES ON THE WINDOWS PC
--------------------------------------------------------------------------------
A. Windows 10 or 11 (64-bit).
B. Physical printer connected via USB or Wi-Fi.
   - Verify printer appears in Windows "Settings > Bluetooth & devices > Printers & scanners".
   - Print a Windows Test Page from Windows settings to verify printer driver works.
C. SumatraPDF installed on Windows (REQUIRED for deterministic PDF rendering):
   - Download the official SumatraPDF installer or portable 64-bit EXE from:
     https://www.sumatrapdfreader.org/download-free-pdf-viewer
   - Install SumatraPDF, OR place SumatraPDF.exe directly in this folder or vendor/ folder.
D. Internet access to connect to PrintGo API:
   - Default Production API: https://printgo-api.printgo-worker.workers.dev

--------------------------------------------------------------------------------
2. HOW TO RUN THE AGENT
--------------------------------------------------------------------------------
OPTION 1: Run PrintGo-Agent.exe directly (If precompiled EXE is present)
   - Double click "run-agent.bat", or open PowerShell / Command Prompt and run:
     .\PrintGo-Agent.exe

OPTION 2: Run via Node.js (If Node 22 is installed on Windows)
   - Double click "run-agent.bat", or run:
     node bundle.cjs

OPTION 3: Compile PrintGo-Agent.exe directly on Windows
   - Double click "build-exe.bat". It will bundle Node into PrintGo-Agent.exe.

--------------------------------------------------------------------------------
3. STEP-BY-STEP PAIRING & TEST PROCEDURE
--------------------------------------------------------------------------------
STEP 1: Open the PrintGo Admin Dashboard
   - URL: https://printgo-admin.pages.dev (or your local admin instance).
   - Log in with shop admin credentials.
   - Go to "Printers" tab / section.
   - Click "Add PrintGo Agent" or "Generate Pairing Code".
   - Note the pairing code (format: XXXX-XXXX, valid for 10 minutes).

STEP 2: Launch the Agent
   - Launch "run-agent.bat" or "PrintGo-Agent.exe".
   - If not previously paired, the agent prompts:
     "Enter pairing code from PrintGo Admin (format: XXXX-XXXX, or press Enter to skip): "
   - Type the code and press Enter.
   - (Alternatively, run: .\PrintGo-Agent.exe --pair XXXX-XXXX)

STEP 3: Verify Successful Pairing in Terminal
   - The terminal will report:
     "[PrintGo Agent] Initiating pairing with https://printgo-api.printgo-worker.workers.dev..."
     "[PrintGo Agent] Pairing successful. Agent ID: ... Token stored securely via Windows DPAPI."
     "[PrintGo Agent] Discovering local printers via PowerShell / WMI..."
     "[PrintGo Agent] Synchronized printer status with PrintGo Cloud."
     "[PrintGo Agent] Daemon running. Listening for print jobs..."

STEP 4: Verify in PrintGo Admin UI
   - Check the Admin Dashboard:
     - The Agent should show ONLINE with a green indicator.
     - Your connected printer model should appear in the printer list.
     - Printer status should show ONLINE and READY.

STEP 5: Print Diagnostic / Identification Test Page
   - In PrintGo Admin UI, select the printer and click "Print Test Page" or
     "Print Identification Sheet".
   - Watch the agent terminal:
     "[PrintGo Agent] Received diagnostic/test print request..."
     "[PrintGo Agent] Spooling PDF via SumatraPDF..."
     "[PrintGo Agent] Spool job completed successfully."
   - Confirm the physical printer produces the diagnostic sheet with correct margins!

--------------------------------------------------------------------------------
4. COMMAND-LINE OPTIONS & ENVIRONMENT VARIABLES
--------------------------------------------------------------------------------
Flags:
  --pair <CODE>       Pair immediately using the specified pairing code (XXXX-XXXX).
  --server <URL>      Override PrintGo backend API URL.
                      (Default: https://printgo-api.printgo-worker.workers.dev)
  --name <NAME>       Override local agent display name.
  --clear             Erase stored DPAPI credentials and unpair this agent.
  --version, -v       Print agent version and exit.
  --help, -h          Show help message and exit.

Configuration File (printgo-config.json):
  Can be placed next to PrintGo-Agent.exe:
  {
    "serverUrl": "https://printgo-api.printgo-worker.workers.dev",
    "displayName": "Shop Counter PC"
  }

Environment Variables:
  PRINTGO_PAIR_CODE   Pairing code (alternative to --pair flag).
  PRINTGO_SERVER_URL  API server URL (alternative to --server flag).
  PRINTGO_SUMATRA_PATH Full path to SumatraPDF.exe if installed in non-standard path.

--------------------------------------------------------------------------------
5. SECURITY & RETENTION POLICIES APPLIED
--------------------------------------------------------------------------------
- Windows DPAPI: Cloud agent bearer token is encrypted at rest using Windows DPAPI
  CryptProtectData (tied to the local Windows user profile). No plaintext secrets.
- Deterministic Printing: SumatraPDF is used with explicit page dimensions, preventing
  silent Windows scaling or dialog popups.
- Temporary File Zeroing: Any downloaded customer PDF is processed in a secure
  temp directory and deleted immediately upon spool completion.
================================================================================
