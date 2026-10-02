# PrintGo V2 — Real-World Manual Test Report

**Execution Date**: 2026-10-02  
**Test Mode**: Interactive Human-in-the-Loop Manual Real-World Testing  
**Current Baseline Commit**: `d114709`

---

## 1. Environment & Target Baseline

| Component              | Target URL / Address                             | Status                        |
| :--------------------- | :----------------------------------------------- | :---------------------------- |
| **Admin PWA**          | `https://printgo-admin.pages.dev`                | ✅ Online (HTTP 200)          |
| **Customer PWA**       | `https://printgo-customer.pages.dev`             | ✅ Online (HTTP 200)          |
| **API Worker**         | `https://printgo-api.printgo-worker.workers.dev` | ✅ Online (`/health` OK)      |
| **Worker Logs**        | Cloudflare `wrangler tail`                       | 🟢 Actively Streaming         |
| **Windows Agent Host** | `192.168.1.7:22` (`printgo-windows`)             | 🟢 Persistent Daemon Running  |
| **Agent Logs**         | `%LOCALAPPDATA%\PrintGo\daemon.log`              | 🟢 Active 5s Polling          |

---

## 2. Test Phase Tracking

- [ ] **Phase A**: Admin Manual Testing (Settings, Pricing, Add-ons, Discounts, Priority, Identification, Branding, Fallback, Storage/Privacy, Manual Orders, UI/UX, Error & Loading states)
- [ ] **Phase B**: Customer Manual Testing (Upload, Config, Review, Payment Simulation, Tracking)
- [ ] **Phase C**: Windows Agent & Real Hardware Dispatch (Hardware spooling, thermal/laser dispatch)

---

## 3. Findings & Incident Log

| # | Timestamp | Scenario / Area | Issue Summary | Root Cause | Fix Applied | Verification Status |
| :- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | 2026-10-02 18:07 IST | Admin Pricing / Addons Form | Radio buttons for "Pricing" & "Handling" rendered as giant overlapping circles covering label text | Global `input` rule had `width: 100%` and `min-height: 2.85rem` without excluding radio/checkbox | Scoped `input:not([type="checkbox"]):not([type="radio"])` and set fixed `1.15rem` radio sizes & alignment in `apps/web/admin/src/styles.css` | 🟡 Ready for User Retest on Staging |

---

## 4. Retest & Verification Details

### Finding 1: Radio Buttons Overlapping Text in Add-on Service Form
- **Issue**: In Safari/WebKit, opening "New Service" under Pricing & Add-on Services displayed giant blue and white circles (~48px) overlapping the text "Fixed Price", "Staff Priced", "Automatic", "Print Automatically + Finishing", and "Manual Printing Required".
- **Expected**: Standard compact radio buttons neatly aligned to the left of each text option with clean spacing.
- **Actual**: Giant circles overlapping text due to global `input` CSS rules.
- **Root Cause**: `apps/web/admin/src/styles.css` applied `width: 100%`, `min-height: 2.85rem`, and `padding: 0.7rem 0.8rem` to all `input` elements without excluding `type="radio"` or `type="checkbox"`.
- **Fix**: Scoped text-input rules with `:not([type="checkbox"]):not([type="radio"])`, added dedicated `width: 1.15rem; height: 1.15rem; flex-shrink: 0;` styling for radios and checkboxes, and improved `.radio-group` / `.radio-label` spacing.
- **Tests**: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build` all passed (exit 0).
- **Deployment**: Deployed in commit `d114709` to `https://printgo-admin.pages.dev`.
