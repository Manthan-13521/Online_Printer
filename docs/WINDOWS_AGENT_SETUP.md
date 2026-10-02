# PrintGo V2 — Windows Print Agent Operations & Setup Manual

This guide details the installation, configuration, operational workflow, autostart, and maintenance of the PrintGo Windows Agent for physical print shops.

---

## 1. INSTALL

1. Download **`PrintGo-Agent-Setup.exe`** from your PrintGo Admin Portal or repository build (`dist/windows/PrintGo-Agent-Setup.exe`).
2. Double-click **`PrintGo-Agent-Setup.exe`**.
3. Follow the wizard steps (Installs to `%LOCALAPPDATA%\Programs\PrintGo` — **no administrator access required**).
4. Upon completion, the **PrintGo Control Center** launches automatically in the Windows notification area (System Tray).

> **Portable Option**: Alternatively, copy `PrintGo-Agent.exe` and `SumatraPDF.exe` together into any directory (e.g. `C:\PrintGo\agent`) and double-click `PrintGo-Agent.exe`.

---

## 2. CONNECT SHOP (Pairing)

To connect the Windows Agent to your Cloudflare PrintGo shop:

1. Open the PrintGo Admin PWA (`https://printgo-admin.pages.dev`).
2. Navigate to **Settings → Agent Connections**.
3. Click **Generate Pairing Code** to receive an 8-character pairing code (e.g., `ABCD-1234`) or a direct `printgo://` one-click connection link.
4. **Option A (One-Click Link)**: Click the link on the Windows shop laptop. The PrintGo Control Center will automatically capture the URL and complete pairing.
5. **Option B (Command Line / Manual)**:
   ```cmd
   PrintGo-Agent.exe --server "https://printgo-api.printgo-worker.workers.dev" --pair "ABCD-1234"
   ```
6. Agent credentials are securely encrypted on Windows using **Windows DPAPI** (`%LOCALAPPDATA%\PrintGo\agent-credentials.json`).

---

## 3. SELECT PRINTER

1. The PrintGo Agent automatically queries local Windows printer drivers via PowerShell CIM/WMI.
2. Open **PrintGo Control Center** from the system tray to view all detected physical and virtual printers.
3. The Agent filters out non-production virtual printers (e.g., _Microsoft Print to PDF_, _OneNote_) and selects the primary physical printer (e.g., _HP Laser MFP 131-138_ or _Xprinter XP-TT426B_).
4. If a network IP printer is used, ensure the printer is turned on and reachable on the local Wi-Fi / Ethernet subnet (`192.168.x.x`).

---

## 4. TEST

1. In the PrintGo Admin PWA under **Printer & Hardware Status**, click **Send Test Page**.
2. Alternatively, run a diagnostic self-check from Windows Command Prompt:
   ```cmd
   PrintGo-Agent.exe --status
   ```
3. The Agent will download a safe test PDF from Cloudflare R2, submit it to SumatraPDF silently, spool the pages to the physical printer, and confirm completion back to Cloudflare D1.

---

## 5. AUTOSTART

1. The installer automatically registers **PrintGo Control Center** in the Windows user session startup registry:
   - Key: `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
   - Command: `"C:\Users\<User>\AppData\Local\Programs\PrintGo\PrintGo-ControlCenter.exe" --minimized`
2. When the laptop boots or logs in:
   - Control Center starts in the background (tray icon).
   - It checks liveness and launches `PrintGo-Agent.exe`.
   - The Agent runs continuously in the background polling Cloudflare Worker every 5 seconds.
3. **No Mac Required**: The Mac is strictly for development/admin. The Windows laptop operates 100% independently.

---

## 6. UPDATE

1. When a new release is available, run the updated `PrintGo-Agent-Setup.exe`.
2. The installer will cleanly overwrite the binaries in `%LOCALAPPDATA%\Programs\PrintGo` without wiping your DPAPI-encrypted credentials.
3. Your shop pairing and printer configuration will remain intact.

---

## 7. UNINSTALL

1. Open **Windows Settings → Apps → Installed Apps**.
2. Locate **PrintGo for Windows** and click **Uninstall** (or run `unins000.exe` in `%LOCALAPPDATA%\Programs\PrintGo`).
3. To completely wipe pairing credentials, delete `%LOCALAPPDATA%\PrintGo` or run:
   ```cmd
   PrintGo-Agent.exe --clear
   ```

---

## 8. TROUBLESHOOTING

| Symptom                      | Cause                                           | Solution                                                                                    |
| :--------------------------- | :---------------------------------------------- | :------------------------------------------------------------------------------------------ |
| **"Printer Offline" on Web** | Printer turned off or TCP port 9100 unreachable | Turn on physical printer; verify IP assignment in router                                    |
| **"SumatraPDF Not Found"**   | Missing SumatraPDF executable                   | Ensure `SumatraPDF.exe` is in the same folder as `PrintGo-Agent.exe`                        |
| **"Agent Unauthorized"**     | Expired or revoked credentials                  | Run `PrintGo-Agent.exe --reset-pairing` and re-pair with a new code from Admin PWA          |
| **"Payment Blocked"**        | Safety circuit opened                           | PrintGo automatically blocks payments when physical printer is offline to protect customers |
