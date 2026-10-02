# PrintGo V2 — Real-World Manual Test Report

**Execution Date**: 2026-10-02  
**Test Mode**: Interactive Human-in-the-Loop Manual Real-World Testing  
**Current Baseline Commit**: `bf8df14`

---

## 1. Environment & Target Baseline

| Component              | Target URL / Address                             | Status                        |
| :--------------------- | :----------------------------------------------- | :---------------------------- |
| **Admin PWA**          | `https://printgo-admin.pages.dev`                | ✅ Online (HTTP 200)          |
| **Customer PWA**       | `https://printgo-customer.pages.dev`             | ✅ Online (HTTP 200)          |
| **API Worker**         | `https://printgo-api.printgo-worker.workers.dev` | ✅ Online (`/health` OK)      |
| **Worker Logs**        | Cloudflare `wrangler tail`                       | 🟢 Actively Streaming         |
| **Windows Agent Host** | `192.168.1.6:22` (`printgo-windows`)             | ⚠️ Unreachable (SSH timeout)  |
| **Agent Logs**         | Local daemon logs                                | ⏸️ Waiting for host reconnect |

---

## 2. Test Phase Tracking

- [ ] **Phase A**: Admin Manual Testing (Settings, Pricing, Add-ons, Discounts, Priority, Identification, Branding, Fallback, Storage/Privacy, Manual Orders, UI/UX, Error & Loading states)
- [ ] **Phase B**: Customer Manual Testing (Upload, Config, Review, Payment Simulation, Tracking)
- [ ] **Phase C**: Windows Agent & Real Hardware Dispatch (Hardware spooling, thermal/laser dispatch)

---

## 3. Findings & Incident Log

| #                             | Timestamp | Scenario / Area | Issue Summary | Root Cause | Fix Applied | Verification Status |
| :---------------------------- | :-------- | :-------------- | :------------ | :--------- | :---------- | :------------------ |
| _Waiting for tester feedback_ | —         | —               | —             | —          | —           | —                   |

---

## 4. Retest & Verification Details

_(Detailed entries will be recorded here for each reported problem following the schema: Issue, Expected, Actual, Evidence, Root Cause, Fix, Tests, Retest Status)._
