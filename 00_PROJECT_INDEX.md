# PrintGo V2 — Project Index

**Status:** Architecture finalized for initial build  
**Primary goal:** Build a simple, reliable, user-friendly online printing system that can be sold as a one-time installation to individual print/xerox shops.

---

## 1. Product model

PrintGo V2 is **not a centralized SaaS for many shops**.

The commercial and technical model is:

> **One shop = one isolated PrintGo installation + one-time software/setup sale + shop-owned production infrastructure.**

The developer/vendor keeps the private source code.

Each shop owns and pays for its own:

- Cloudflare account/infrastructure
- Razorpay account
- domain, if the shop wants a custom domain
- printer(s)
- Windows computer
- internet connection
- any third-party charges beyond free tiers

PrintGo is designed so a shop can continue operating without routing print files or payments through the developer's personal infrastructure.

---

## 2. Initial engineering target

Per shop:

- **1,000–1,300 customer print jobs per month**
- approximately **2 MB average uploaded PDF**
- PDF-only uploads
- configurable maximum PDF upload size
- temporary PDF storage only
- customer payments go directly to the shop's Razorpay account

This is a **design and testing target**, not a promise that third-party free tiers will remain unchanged forever.

Before selling/deploying a shop installation, current Cloudflare and Razorpay limits/terms must be checked.

---

## 3. Final technology stack

### Customer + Admin Web App

- React
- TypeScript
- Vite
- Progressive Web App (PWA)
- Cloudflare Pages

### Backend/API

- Cloudflare Worker
- TypeScript
- Cloudflare Worker Secrets for sensitive server credentials
- server-side validation for price, payment, job transitions, uploads and admin actions

### Database

- Cloudflare D1
- stores metadata only
- **never stores the actual customer PDF**

### Temporary PDF Storage

- Cloudflare R2
- private bucket
- short-lived signed access
- strict deletion rules

### Payments

- Razorpay
- each shop uses **its own Razorpay account**
- payment must be verified server-side
- webhook/signature verification required
- frontend success alone is never accepted as proof of payment

### Printing

- PrintGo Windows Agent
- TypeScript/Node.js Windows application
- packaged as a Windows desktop/background agent
- printer/spooler functionality isolated behind a printer adapter so the print engine can be changed without rewriting business logic
- automatically starts with Windows after installation
- securely paired to one shop

### Source Control

- private GitHub repository
- shop does not receive source repository access
- production secrets never committed to Git

---

## 4. Core system flow

```text
Customer Browser / Phone
        |
        v
Cloudflare Pages
React + TypeScript PWA
        |
        v
Cloudflare Worker API
        |
        +-------- Cloudflare D1
        |         orders / payments / pricing /
        |         settings / printer status / events
        |
        +-------- Cloudflare R2
        |         temporary private PDFs only
        |
        +-------- Razorpay
                  shop-owned payment account

                        |
                        v
                Windows PrintGo Agent
                        |
                        v
                  Windows Spooler
                        |
                        v
                      Printer
```

---

## 5. Documents in this pack

### `01_TECHNICAL_ARCHITECTURE.md`

The technical source of truth:

- services
- data ownership
- upload/payment flow
- printing flow
- cleanup
- security
- failure handling
- state machine
- free-tier-conscious design rules

### `02_PRODUCT_REQUIREMENTS_AND_UX.md`

The product source of truth:

- customer experience
- admin experience
- pricing behavior
- upload limits
- printer status
- failed-print behavior
- retention rules
- job identification sheet
- usability requirements

### `03_BUILD_PHASES_AND_AI_HANDOFF.md`

The implementation roadmap:

- what gets built first
- phase boundaries
- acceptance criteria
- rules for future AI coding sessions
- decisions that should not be casually changed

---

## 6. Non-negotiable product principles

1. **User-friendly first.**  
   A customer should be able to upload, configure, pay and track without training.

2. **Admin-friendly first.**  
   A normal shop owner should be able to operate PrintGo without understanding Cloudflare, databases or code.

3. **No unnecessary customer account.**  
   Customers use name + phone + private tracking link/job code.

4. **No payment when online printing is disabled.**

5. **No new upload when online printing is disabled.**

6. **Do not accept a new paid print job when the system does not have a usable online printer/agent.**

7. **Price is calculated server-side.**

8. **Payment is verified server-side.**

9. **PDFs are temporary.**

10. **Printed-document failures must be visible to the admin.**

11. **Never blindly duplicate a Windows print job after a paper jam/no-paper/offline condition.**

12. **One shop's production data and payments must not be mixed with another shop.**

---

## 7. Explicitly excluded from the initial version

Do not add these unless the product requirements are intentionally revised:

- staff/employee role system
- separate Owner + Staff accounts
- QR-code page/generator
- customer login/accounts
- loyalty points
- coupons
- native Android/iOS customer apps
- delivery system
- complex inventory
- document editor
- Word/PPT conversion
- AI features
- multi-shop centralized SaaS
- Redis
- Kafka
- Kubernetes
- permanent PDF storage

---

## 8. Product definition

The core promise of PrintGo V2 is:

> **Upload → choose settings → calculate correct price → verify printer availability → pay → print reliably → identify the customer's output → track status → delete the PDF safely.**

If a future feature does not materially improve this workflow, it should normally wait until after the first stable release.
