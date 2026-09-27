# PrintGo V2 — Comprehensive Codebase Map & Architectural Blueprint

## 1. System Architecture Overview

PrintGo V2 is an online-to-offline print automation platform purpose-built for a single physical print shop. It operates with high reliability on **Cloudflare's 100% Free Tier** combined with an on-premises **Windows Agent** running adjacent to the physical printer hardware.

```mermaid
flowchart TD
    subgraph Clients["Clients (Cloudflare Pages CDN)"]
        CustPWA["Customer PWA (Mobile/Desktop)"]
        AdminPWA["Admin PWA (Shop Operator)"]
    end

    subgraph Edge["Cloudflare Edge (Free Tier)"]
        PagesCDN["Pages CDN (Static Assets / 0 Worker Cost)"]
        Worker["Cloudflare Worker (printgo-api)"]
        D1[("Cloudflare D1 (SQLite Database)")]
        R2[("Cloudflare R2 (Private PDF Storage)")]
    end

    subgraph Shop["Physical Print Shop"]
        Agent["Windows Print Agent (Node.js/EXE Daemon)"]
        Spooler["Windows Print Spooler (Win32)"]
        Printer["Physical Laser / Thermal Printer"]
    end

    subgraph External["External Gateways"]
        Razorpay["Razorpay Payment Gateway"]
    end

    CustPWA -->|Static HTML/JS| PagesCDN
    AdminPWA -->|Static HTML/JS| PagesCDN
    CustPWA -->|Direct Signed Upload PUT| R2
    CustPWA -->|Dynamic API /api/customer/*| Worker
    AdminPWA -->|Dynamic API /api/admin/*| Worker
    Worker -->|Read / Write State| D1
    Worker -->|Signed URLs & Verifications| R2
    Worker -->|Create Order / Verify Webhook| Razorpay
    Agent -->|Outbound Polling & Heartbeat| Worker
    Agent -->|Direct Signed Download GET| R2
    Agent -->|Silent CLI Printing| Spooler
    Spooler -->|Physical Raw Print Data| Printer
```

---

## 2. Monorepo Directory Map & Ownership

```
Printe_Go_/
├── apps/
│   ├── web/customer/              # Customer-facing React PWA
│   │   ├── public/                # Static assets, icons, manifest, _routes.json, _redirects
│   │   ├── src/
│   │   │   ├── api.ts             # Typed HTTP client for /api/customer/*
│   │   │   ├── App.tsx            # Main upload wizard & quote review interface
│   │   │   ├── TrackingPage.tsx   # Live order tracking with backoff polling
│   │   │   └── pdf.ts             # In-browser PDF page counting & validation
│   ├── web/admin/                 # Shop Operator React PWA
│   │   ├── public/                # Static assets, icons, manifest, _routes.json, _redirects
│   │   ├── src/
│   │   │   ├── api.ts             # Typed HTTP client for /api/admin/* (cookie-auth)
│   │   │   ├── App.tsx            # Admin router, login gate, layout navigation
│   │   │   ├── LiveOrdersPage.tsx # Live order queue monitor with visibility-aware poll
│   │   │   ├── PricingPage.tsx    # Print rates and service charges editor
│   │   │   └── PrinterPage.tsx    # Agent pairing & printer hardware monitor
│   ├── api/worker/                # Cloudflare Worker Backend
│   │   ├── src/
│   │   │   ├── router.ts          # Root HTTP dispatcher & CORS handler
│   │   │   ├── customer/          # Customer endpoints & database repository
│   │   │   ├── admin/             # Admin endpoints, auth middleware & repository
│   │   │   ├── agent/             # Agent pairing, heartbeat & claim repository
│   │   │   ├── printing/          # Print job dispatch, lifecycle queries & repository
│   │   │   ├── payments/          # Razorpay order creation, webhooks & verification
│   │   │   └── storage/           # S3-compatible R2 presigning & verification
│   └── agent/windows/             # On-premises Windows Print Service
│       ├── src/
│       │   ├── index.ts           # Agent daemon entrypoint & CLI commands
│       │   ├── agent-daemon.ts    # Polling loop, heartbeat & job claim runner
│       │   ├── agent-client.ts    # HTTPS client talking to Worker /api/agent/*
│       │   ├── storage/           # DPAPI Windows credential encryption store
│       │   └── printing/          # SumatraPDF execution, Win32 CIM & spool monitor
├── packages/
│   ├── domain/                    # State machines, order transitions, pure business logic
│   ├── validation/                # Zod schemas for all API payloads and entities
│   ├── api-contract/              # Shared TypeScript interfaces for HTTP requests/responses
│   ├── pricing/                   # Authoritative quote calculation rules
│   ├── auth/                      # PBKDF2 password hashing & session management
│   └── shared/                    # Common utility functions (formatters, units)
├── database/
│   └── migrations/                # D1 SQL migration files (0001 - 0007)
├── scripts/                       # Local runner, D1 validation, packaging scripts
└── docs/                          # Technical specifications and architecture guides
```

---

## 3. End-to-End Core Workflows

### 3.1 Customer Upload & Quoting

```mermaid
sequenceDiagram
    autonumber
    actor C as Customer
    participant W as Customer PWA
    participant API as Worker API
    participant D1 as D1 Database
    participant R2 as Private R2

    C->>W: Selects PDF & Enters Name/Phone
    W->>W: Parses page count locally (pdfjs)
    W->>API: POST /api/customer/drafts (name, phone, pages)
    API->>D1: INSERT INTO orders (status='DRAFT', expires_in=10m)
    API-->>W: Returns draftToken & pre-signed R2 PUT URL
    W->>R2: Direct HTTP PUT (Customer PDF File)
    W->>API: POST /api/customer/drafts/complete
    API->>R2: HEAD check (verifies file size & mime type)
    API->>D1: UPDATE orders SET status='UPLOADED'
    W->>API: POST /api/customer/quote (pages, copies, color, duplex)
    API->>API: Evaluates @printgo/pricing rules
    API-->>W: Returns Authoritative Rupee Quote
```

### 3.2 Payment Verification & Order Queuing

```mermaid
sequenceDiagram
    autonumber
    actor C as Customer
    participant W as Customer PWA
    participant API as Worker API
    participant D1 as D1 Database
    participant RZP as Razorpay Gateway

    C->>W: Clicks 'Pay ₹XX.XX'
    W->>API: POST /api/customer/payments/create
    API->>RZP: POST /v1/orders (amount_paise, receipt)
    RZP-->>API: Returns rzp_order_id
    API->>D1: INSERT INTO payment_attempts
    API-->>W: Returns rzp_order_id & razorpay_key_id
    W->>RZP: Opens Razorpay Checkout Modal
    C->>RZP: Completes UPI/Card Payment
    RZP-->>W: Returns payment_id & signature
    W->>API: POST /api/customer/payments/verify (signature)
    API->>API: Verifies HMAC-SHA256 signature
    API->>D1: UPDATE orders SET status='QUEUED', generates Job Code
    API-->>W: Returns verified status & tracking jobCode (PG-XXXX)
    W->>W: Redirects to /track/PG-XXXX
```

### 3.3 Windows Agent Execution & Physical Printing

```mermaid
sequenceDiagram
    autonumber
    participant AG as Windows Agent
    participant API as Worker API
    participant D1 as D1 Database
    participant R2 as Private R2
    participant SP as Windows Spooler

    loop Every 30s Heartbeat
        AG->>API: POST /api/agent/heartbeat (printer status, capabilities)
        API->>D1: UPDATE agents (skips unchanged printer rows)
    end

    loop Active Job Polling
        AG->>API: POST /api/agent/jobs/claim
        API->>D1: SELECT oldest QUEUED order FOR UPDATE -> status='CLAIMED'
        API-->>AG: Returns job details + short-lived signed R2 GET URL
        AG->>R2: GET download PDF to secure local temp folder
        AG->>API: POST /api/agent/jobs/:id/events (status='SPOOLING')
        AG->>SP: Executes SumatraPDF -print-to -silent
        AG->>API: POST /api/agent/jobs/:id/events (status='PRINTING')
        AG->>SP: Monitors Win32_PrintJob spool state
        SP-->>AG: Spool cleared (physical print complete)
        AG->>API: POST /api/agent/jobs/:id/events (status='PRINTED')
        API->>D1: UPDATE orders SET status='PRINTED', updated_at_ms=now()
        AG->>AG: Securely deletes local temp PDF
    end
```

---

## 4. D1 Database Schema Map

| Table Name                  | Primary Role                           | Key Columns                                                                        |
| :-------------------------- | :------------------------------------- | :--------------------------------------------------------------------------------- |
| `installation`              | Single shop bootstrap metadata         | `id`, `shop_name`, `contact_phone`, `is_installed`                                 |
| `admin_users`               | Operator authentication                | `id`, `username`, `password_hash`, `salt`                                          |
| `admin_sessions`            | Active operator sessions               | `token_hash`, `user_id`, `expires_at_ms`                                           |
| `orders`                    | Core print order lifecycle             | `id`, `job_code`, `status`, `customer_name`, `total_amount_paise`, `updated_at_ms` |
| `order_files`               | Metadata for uploaded customer PDFs    | `order_id`, `r2_object_key`, `size_bytes`, `page_count`                            |
| `order_quotes`              | Authoritative quote snapshot           | `order_id`, `copies`, `paper_size`, `color_mode`, `sides`, `total_amount_paise`    |
| `payment_attempts`          | Razorpay attempts & verification       | `id`, `order_id`, `razorpay_order_id`, `razorpay_payment_id`, `status`             |
| `agents`                    | Registered on-premise Windows machines | `id`, `machine_name`, `auth_token_hash`, `last_heartbeat_at_ms`                    |
| `printers`                  | Physical printer devices               | `id`, `agent_id`, `display_name`, `status`, `capabilities_json`                    |
| `print_attempts`            | Execution attempts per order           | `id`, `order_id`, `agent_id`, `attempt_number`, `status`                           |
| `print_events`              | Granular audit timeline                | `id`, `order_id`, `event_type`, `payload_json`, `created_at_ms`                    |
| `print_rates`               | Rupee pricing rules per page/type      | `id`, `paper_size`, `color_mode`, `sides`, `price_paise_per_page`                  |
| `file_size_service_charges` | Banded surcharges based on file size   | `id`, `max_bytes`, `service_charge_paise`                                          |

---

## 5. Storage & Object Key Schema (Cloudflare R2)

All uploaded customer PDFs are stored in a **single private R2 bucket** with strict path partitioning:

```
r2-bucket/
└── drafts/
    └── {order_id}/
        └── document.pdf
```

- **Access Rules**:
  - Public bucket access is permanently disabled.
  - Upload access: Single-use signed PUT URL generated by Worker with 10-minute expiry.
  - Download access: Single-use signed GET URL generated exclusively for authenticated Windows Agents claiming that specific order.
  - Lifecycle: Enforced by retention policies (deleted 10 min if unpaid, 30 min if cancelled, 1 hr after physical printing).
