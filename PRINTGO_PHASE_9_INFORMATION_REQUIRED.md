# PRINTGO — PHASE 9: PRE-EXECUTION INFORMATION REQUIRED & SIGN-OFF CHECKLIST

**Author:** Principal QA Architect & Production Reliability Auditor  
**Methodology:** PONYTAIL Evidence-First Verification  
**Status:** AWAITING USER APPROVAL  
**Date:** October 12, 2026

---

## 1. Purpose of this Checklist

Before commencing the execution of Phase 9 testing sessions, this document outlines the exact parameters, hardware boundaries, and environmental assumptions that require your review and explicit authorization.

---

## 2. Information Required Checklist

Please review each section below and provide confirmation or adjustments:

### [ ] 1. Strict Virtualization & Zero-Physical Printing Confirmation

- **Status:** **MANDATORY SAFEGUARD**
- **Condition:** All five printers (P1: B&W Simplex, P2: B&W Duplex, P3: Color Simplex, P4: Color Duplex, P5: Offline) will be executed strictly via in-memory virtual simulation (`VirtualTestPrinterAdapter`).
- **Confirmation Needed:** Please confirm that **NO physical printer** is authorized or to be accessed, and that virtual simulation is the agreed test standard for all printer routing, queueing, and failure tests.

---

### [ ] 2. Shop Configuration & Policy Settings

- **Shop Name:** `PrintGo Xerox & Document Centre` (or specify preferred shop display name).
- **Default Production Printer:** Assigned to **P1** (`Simulated-BW-Simplex`), with fallback configured to **P2** (`Simulated-BW-Duplex`).
- **Cash Payment Policy:** `cash_orders_enabled = 1` (Active in shop settings to allow cash order testing).
- **Identification Sheet Configuration:**
  - Enabled: `true`
  - Placement: `FIRST` (Sheet prints before customer document)
  - Trigger Condition: Minimum order amount ₹20.00 (`id_sheet_min_amount_paise = 2000`)
- **Add-on Services Configured:**
  - Add-on 1: `Spiral Binding` (`FIXED_PRICE`, ₹40.00 online, handling mode `POST_PRINT`)
  - Add-on 2: `Certificate Bond Paper` (`STAFF_PRICED`, staff charges at pickup, handling mode `MANUAL_PRINT`)

---

### [ ] 3. Payment Gateway & Sandbox Credentials

- **Provider:** Razorpay Test Mode / In-Memory Razorpay Client Simulator.
- **Key ID & Secret:** Mock credentials (`rzp_test_virtual_key`, `mock_secret_hmac`) with strict HMAC-SHA256 signature verification.
- **Currency:** `INR` (Indian Rupee), amounts calculated in paise.
- **Confirmation Needed:** Confirm local simulated webhook and verify callback testing is approved.

---

### [ ] 4. Test Workload & Capacity Scaling Targets

- **Session 1–5 Functional Runs:** 10 to 25 orders per test scenario.
- **Session 6 Full-Day Soak Simulation:**
  - Standard Shop Day: **60 orders** over modeled 15 hours.
  - Stress / High-Volume Peak: **500 orders** burst simulation.
- **Confirmation Needed:** Confirm whether 60-order standard day and 500-order stress targets match your desired capacity model.

---

### [ ] 5. Permission for Execution Sign-Off

- **Strict Rule Observed:** As instructed, **zero test execution has commenced.** All discovery and test planning is complete.
- **Action Required:** Once you review the four reports and confirm the items in this checklist, reply with your approval to proceed to Phase 9 test execution.
