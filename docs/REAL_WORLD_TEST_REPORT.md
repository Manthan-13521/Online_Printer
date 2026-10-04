# PrintGo V2 — Real-World Manual Test Report

**Execution Date**: 2026-10-04  
**Test Mode**: Interactive Human-in-the-Loop Manual Real-World Testing  
**Current Baseline Commit**: `bf8df14`  

---

## 1. Environment & Target Baseline

| Component | Target URL / Address | Status |
| :--- | :--- | :--- |
| **Admin PWA** | `https://printgo-admin.pages.dev` | 🟢 Online (HTTP 200) |
| **Customer PWA** | `https://printgo-customer.pages.dev` | 🟢 Online (HTTP 200) |
| **API Worker** | `https://printgo-api.printgo-worker.workers.dev` | 🟢 Online (`/health` OK) |
| **Windows Agent Host** | `192.168.1.6:22` (`printgo-windows`) | 🟢 Online (`PrintGo-Agent.exe` PID 20328) |
| **Printer Queue** | `HPF80DACE6151A(HP Laser MFP 131 133 135-138)` | 🟢 Online (Reachable at 192.168.1.12) |
| **Worker Logs** | Cloudflare `wrangler tail` | 🟢 Streaming |

---

## 2. Test Phase Tracking

- [x] **Phase A**: Admin Configuration & Settings (Baseline verified)
- [x] **Phase B / Live Test**: Live Customer Upload & End-to-End Payment / Printing
  - Order 1: `PG-N24AZD` (blank.pdf, ₹21.00)
  - Order 2: `PG-GZ3ZHS` (blank.pdf, ₹1.00)

---

## 3. Incident Investigation & Evidence Log

### Incident 1: "Uploaded file and paid, not printed" & "Not able to pay also, printer is on"
- **Reported Time**: 2026-10-04 13:41:29 IST
- **Orders Involved**:
  1. `PG-N24AZD` (`e039938c-d519-43de-bee4-63841da386fe`)
  2. `PG-GZ3ZHS` (`a0950f50-2e71-46b1-94f2-8fcccd3ca5f9`)

#### Chronology & Forensic Evidence:
1. **At 13:09 – 13:11 IST**:
   - Order `PG-N24AZD` was paid online (₹21.00).
   - The Windows Agent attempted to spool the print job. However, the HP network printer was temporarily unreachable over port 9100 (`Network printer unreachable at 192.168.1.12`).
   - The pre-submission readiness probe threw an error, and the Agent safely reported `UNCERTAIN` to prevent unverified double printing.
   - The order status transitioned to `COMPLETION_UNKNOWN` ("Waiting for Staff").
   - The Agent process on Windows then stopped heartbeating (>90s elapsed), causing D1 to flag `AGENT_OFFLINE`.

2. **At 13:37 – 13:42 IST**:
   - Customer uploaded a second file `blank.pdf` (Order `PG-GZ3ZHS`, ₹1.00) and attempted to pay.
   - Payment was blocked with an agent-offline safeguard (`PaymentReadiness: AGENT_OFFLINE`).
   - **Expected Behavior**: To protect customers from paying when prints cannot be completed, the system prevents payment initiation when the Windows Agent daemon is offline.

3. **At 13:43:15 IST**:
   - The Windows Agent was started/reconnected (`PrintGo-Agent.exe` PID 20328).
   - Agent reported healthy heartbeat and detected HP Laser MFP as `ONLINE`.
   - The Customer was immediately able to pay for Order `PG-GZ3ZHS` (`paid_at_ms: 1791101713778` at 13:45:13 IST).

4. **At 13:45 – 13:48 IST**:
   - Both queued print jobs were automatically processed and submitted to SumatraPDF:
     - **Order `PG-N24AZD`**:
       - Step 1 (Customer Document) -> Spool Job 24 `SUCCEEDED` (finished at 13:44:42 IST)
       - Step 2 (Identification Sheet) -> Spool Job 25 `SUCCEEDED` (finished at 13:46:00 IST)
     - **Order `PG-GZ3ZHS`**:
       - Step 1 (Customer Document) -> Spool Job 26 `SUCCEEDED` (finished at 13:47:21 IST)
       - Step 2 (Identification Sheet) -> Spool Job 27 `SUCCEEDED` (finished at 13:48:15 IST)
   - Both orders transitioned to **`AWAITING_FINISHING`** (Finishing) because both orders include the add-on service `STAPPLE PLS` (`POST_PRINT` mode), requiring the shop staff to staple the documents before marking them ready for pickup.

#### Root Causes Identified:
1. **Initial non-printing of Order 1**: The HP network printer was temporarily unreachable/sleeping at `192.168.1.12` when the job arrived at 13:09 IST, which properly triggered safety fallback `COMPLETION_UNKNOWN`.
2. **Inability to pay for Order 2**: The Windows Agent process had stopped running on the host machine. The server-side financial protection mechanism strictly disallows charging customer payments when no active Agent heartbeat is received within 90 seconds.
3. **Current Status `AWAITING_FINISHING`**: Both orders printed completely on hardware. They are waiting in Admin for the shop owner to complete the post-print add-on service (`STAPPLE PLS`).
