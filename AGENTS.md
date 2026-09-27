# AGENTS.md — AI Agent Quick Navigation & Architectural Guide

## 1. System Identity & Mission

PrintGo V2 is an online-to-offline print automation platform designed for a **single physical print shop**. It runs on **100% Cloudflare Free-Tier infrastructure** (Worker, D1, R2, Pages) paired with an on-premise **Windows Print Agent** driving local thermal/laser printers via SumatraPDF and PowerShell CIM.

---

## 2. Hard Invariants (DO NOT VIOLATE)

1. **Single Shop Model Only**:
   - Do NOT introduce multi-tenancy, tenant IDs, organization schemas, or foreign keys for multi-shop routing.
2. **Zero Paid Cloud Infrastructure**:
   - Do NOT introduce Redis, Celery, Kafka, AWS SQS, PostgreSQL, Supabase, Docker VMs, Kubernetes, or paid Cloudflare add-ons. The system must operate within the Cloudflare Free Tier indefinitely.
3. **Server-Side Financial & Print Authority**:
   - Clients NEVER compute final quotes or verify payments.
   - All pricing is calculated server-side in `@printgo/pricing` via atomic D1 state.
   - All Razorpay webhooks and payment captures are verified on the Cloudflare Worker via cryptographic HMAC-SHA256.
4. **Windows Agent Security**:
   - Authentication tokens on Windows MUST be encrypted using Windows DPAPI (`powershell -Command ... ProtectedData`).
   - The Agent NEVER exposes an open HTTP server or inbound listening ports. All communication with the Cloudflare Worker is outbound HTTPS.
5. **Private R2 Storage & Signed Direct Uploads**:
   - The R2 bucket is strictly private (public access disabled).
   - Customers upload PDFs directly via short-lived pre-signed PUT URLs. Customer files NEVER pass through Worker memory during upload.
6. **Strict Retention & Privacy Lifecycles**:
   - Unpaid uploads deleted after **10 minutes**.
   - Failed/cancelled payments deleted after **30 minutes**.
   - Completed print jobs deleted from R2 after **1 hour**.
   - Customer PII (name, phone, notes) erased from D1 after **5 hours**.
   - Windows Agent deletes downloaded PDFs **immediately** after spooling.

---

## 3. Monorepo Structure & Boundaries

```
Printe_Go_/
├── apps/
│   ├── web/customer/          # Customer PWA (React 18 + Vite) - Upload & Live Tracking
│   ├── web/admin/             # Admin PWA (React 18 + Vite) - Dashboard, Orders, Settings
│   ├── api/worker/            # Cloudflare Worker (Hono-compatible router, D1 repos, R2, Auth)
│   └── agent/windows/         # Windows Agent (Node.js daemon + CLI, DPAPI, SumatraPDF)
├── packages/
│   ├── domain/                # State machine, job codes, domain constants, pure types
│   ├── validation/            # Zod validation schemas for all requests and configurations
│   ├── api-contract/          # Shared HTTP endpoint definitions, request/response interfaces
│   ├── pricing/               # Authoritative pricing rules, page rate bands, surcharges
│   ├── auth/                  # Admin PBKDF2 password hashing & session token management
│   └── shared/                # Universal helpers (file size formatting, dates)
├── database/
│   └── migrations/            # D1 SQLite migrations (0001 through 0007)
├── scripts/                   # Local setup, validation, packaging, capacity calculators
└── docs/                      # Comprehensive technical architecture & operation manuals
```

---

## 4. Common Commands & Verification Pipeline

Always run the full verification pipeline before submitting code changes:

| Action                | Command                                         | Purpose                                              |
| :-------------------- | :---------------------------------------------- | :--------------------------------------------------- |
| **Run All Tests**     | `pnpm test`                                     | Runs Vitest across all 56 test suites (~393 tests)   |
| **Type Check**        | `pnpm typecheck`                                | Checks TypeScript across root and all packages       |
| **Lint**              | `pnpm lint`                                     | Strict ESLint check (0 warnings allowed)             |
| **Format Check**      | `pnpm format:check`                             | Prettier code style validation                       |
| **Validate D1**       | `pnpm db:validate`                              | Applies and validates all SQL migrations on local D1 |
| **Build All**         | `pnpm build`                                    | Compiles packages and web PWAs                       |
| **Build Windows EXE** | `pnpm build:agent:windows`                      | Packages standalone Windows EXE via esbuild + sea    |
| **Capacity Check**    | `node scripts/calculate-free-tier-capacity.mjs` | Models Cloudflare Free resource consumption          |

---

## 5. Key File Locations

- **Customer API Routes**: `apps/api/worker/src/customer/routes.ts`
- **Admin API Routes**: `apps/api/worker/src/admin/routes.ts`
- **Agent API Routes**: `apps/api/worker/src/agent/routes.ts`
- **Order State Machine**: `packages/domain/src/order-transitions.ts`
- **Payment Verification**: `apps/api/worker/src/payments/service.ts`
- **Windows Printer Driver**: `apps/agent/windows/src/printing/windows-printer-adapter.ts`
- **D1 Schema & Migrations**: `database/migrations/`
- **Static Pages Config**: `apps/web/*/public/_routes.json` and `_redirects`
