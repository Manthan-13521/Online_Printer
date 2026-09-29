# PrintGo V2 — Disaster Recovery & Operational Procedures

This document outlines explicit, safe recovery procedures for common operational scenarios.

---

## 1. Windows PC Replacement / Hardware Failure

If the shop's counter computer fails or is replaced:

1. Ensure the new computer is connected to the physical printer (USB or Local Wi-Fi network).
2. Download and run `PrintGo-Setup.exe` on the new computer.
3. Open the shop's **Admin Portal** $\rightarrow$ **Printer** $\rightarrow$ **Generate Pairing Code**.
4. Click `⚡ Connect This PC Automatically` (or enter the 8-character code).
5. In Admin Portal, click **"Revoke"** on the old agent entry to purge stale authorization credentials.
6. Verify printer status shows `ONLINE`, select it as the **Default Production Printer**, and send a **Test Print**.

_Note: All historical orders, pricing, and shop settings are safely stored in Cloudflare D1 and are completely unaffected by a PC replacement._

---

## 2. Printer Replacement / Upgrading Printer

If the shop replaces their printer (e.g. from an old HP to a new Brother or Canon):

1. Install standard Windows manufacturer drivers on the shop counter PC.
2. In Windows, verify the printer can print a Windows test page.
3. Restart PrintGo Agent via Control Center or wait 30 seconds for the next pulse.
4. Open Admin Portal $\rightarrow$ **Printer**.
5. The new printer will automatically appear in the list under the agent.
6. Click **"Set as Default Production Printer"**.
7. Click **"Test Print"** to verify PrintGo prints through SumatraPDF to the new hardware.

---

## 3. Lost Admin Password

If the shop owner forgets their Admin password:

1. The developer runs the bootstrap script against the shop's production D1 database:
   ```bash
   pnpm admin:bootstrap -- --remote --database printgo-production --login <admin-username>
   ```
2. The script securely prompts for a new password, generates a PBKDF2 salt and hash with 100,000 iterations, updates the database, and revokes all existing sessions.
3. The shop owner logs in with the new password.

---

## 4. Razorpay API Key Rotation

If Razorpay keys expire or need rotation:

1. Log in to the shop's Razorpay Dashboard $\rightarrow$ Generate a new Key ID and Key Secret.
2. The developer runs:
   ```bash
   pnpm shop:configure
   ```
3. Select Option 2 ("Razorpay Credentials"), enter the new Key ID and Secret with masked input.
4. Secrets are securely bound in Cloudflare Worker environment.
5. In Admin Portal, place a controlled test order to verify payments capture seamlessly.

---

## 5. Unblocking Stuck Print Spooler Jobs

If paper runs out mid-job or the Windows Print Spooler experiences a queue block:

> [!CAUTION]
> **DO NOT manually delete files from `C:\Windows\System32\spool\PRINTERS\*`.**
> Blanket deletion of spooler files destroys active, queued, or held print jobs belonging to other applications (accounting, POS, office software) and obliterates print audit logs. Always use controlled queue inspection and targeted job cancellation.

### Safe Queue Recovery Procedure:

1. **Inspect Print Queue**: In Windows, open **Settings $\rightarrow$ Bluetooth & Devices $\rightarrow$ Printers & Scanners** $\rightarrow$ select your printer $\rightarrow$ **Open print queue**.
2. **Identify Specific PrintGo Job**: Locate the specific document corresponding to the PrintGo job (identifiable by document name and timestamp).
3. **Targeted Job Cancellation**:
   - Right-click only the stalled PrintGo print job $\rightarrow$ select **Cancel**.
   - If the job status remains "Deleting...", restart the spooler safely without deleting spool files:
     ```powershell
     Restart-Service -Name Spooler -Force
     ```
4. **Preserve Spooler Evidence**: Do not wipe event logs. Windows Spooler Event 307 (Print succeeded) and Event 308 (Print failed) are preserved in `Microsoft-Windows-PrintService/Operational` to verify job outcomes.
5. **Recover in Admin Portal**:
   - Open PrintGo Admin Portal $\rightarrow$ **Live Orders**.
   - For orders in `PRINT_BLOCKED` or `ADMIN_ACTION_REQUIRED`, choose the appropriate recovery action:
     - **Mark as Printed**: Advances order to `COMPLETED` if paper physically came out before the block.
     - **Retry Print**: Resubmits remaining unprinted steps to the spooler without duplicate printing of already finished steps.
     - **Download Customer PDF**: Allows the counter operator to print the file directly from Windows if the spooler driver has an unresolvable hardware defect.
