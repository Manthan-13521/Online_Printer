# PrintGo V2 — Deployment & Infrastructure Guide

This guide describes how to deploy the single-shop PrintGo V2 system to a Cloudflare account.

> [!IMPORTANT]
> **Staging & Integration Status**: Real Windows Agent and physical printer hardware validation has **not** yet been performed. Real hardware validation is an acceptance gate scheduled for a dedicated pass on actual shop hardware. In accordance with PrintGo's fail-closed design, payment creation will reject live print requests with `PRINTER_NOT_READY` until an active paired Windows Agent reports an online, matching printer.

---

## 1. Deployment Architecture

PrintGo V2 adheres strictly to the single-shop invariant:

```text
ONE PrintGo Production Deployment
 = ONE Cloudflare Account
 = ONE Cloudflare Worker API (printgo-api)
 = ONE Cloudflare D1 Database (printgo-production)
 = ONE Private Cloudflare R2 Bucket (printgo-pdfs)
 = TWO Cloudflare Pages Projects (Customer PWA & Admin PWA)
 = ONE Shop Razorpay Account (Test / Live)
 = That Shop's Windows Agent(s) and Printer(s)
```

There is **no multi-tenancy**, no shared database between shops, and no centralized routing.

---

## 2. Cloudflare Resources Required

Provision the following resources within the shop's Cloudflare account:

| Resource Type         | Resource Name        | Purpose                                                         | Access Policy                                      |
| :-------------------- | :------------------- | :-------------------------------------------------------------- | :------------------------------------------------- |
| **Cloudflare Worker** | `printgo-api`        | Core backend API, state machine, auth, payment verification     | Private API / public HTTPS route                   |
| **Cloudflare D1**     | `printgo-production` | Metadata, orders, payments, audit events, print attempts        | Private binding only (`DB`)                        |
| **Cloudflare R2**     | `printgo-pdfs`       | Temporary customer PDF storage                                  | **Strictly PRIVATE** (No `r2.dev`, no public read) |
| **Cloudflare Pages**  | `printgo-customer`   | Customer-facing PWA (upload, quote, pay, track)                 | Public HTTPS                                       |
| **Cloudflare Pages**  | `printgo-admin`      | Shop owner Admin PWA (settings, pricing, printers, live orders) | Public HTTPS with secure cookie auth               |

---

## 3. Worker Bindings & Environment Variables

### Bindings

The Worker requires two native Cloudflare bindings configured in `wrangler.jsonc` (or via Cloudflare Dashboard):

- **`DB`**: D1 Database binding linked to `printgo-production` (ID: `<SHOP_D1_DATABASE_ID>`).
- **`PDF_BUCKET`**: R2 Bucket binding linked to `printgo-pdfs`.

### Environment Variables (Non-Secret)

Configured under `vars` in `wrangler.jsonc` or Cloudflare Dashboard:

| Variable Name             | Staging / Production Value                                                  | Description                                                         |
| :------------------------ | :-------------------------------------------------------------------------- | :------------------------------------------------------------------ |
| `APP_ENV`                 | `production`                                                                | Enables production security; disables all development test bypasses |
| `CUSTOMER_ALLOWED_ORIGIN` | `https://print.<shop-domain>.com` (or `https://printgo-customer.pages.dev`) | Exact origin allowed for customer CORS and R2 uploads               |
| `ADMIN_ALLOWED_ORIGIN`    | `https://admin.<shop-domain>.com` (or `https://printgo-admin.pages.dev`)    | Exact origin allowed for Admin cookie sessions and CORS             |
| `R2_ACCOUNT_ID`           | `<CLOUDFLARE_ACCOUNT_ID>`                                                   | Cloudflare Account ID used for presigning S3-compatible R2 URLs     |
| `R2_BUCKET_NAME`          | `printgo-pdfs`                                                              | Name of the private R2 bucket                                       |

> [!WARNING]
> Never set `PAYMENT_READINESS_DEV_BYPASS=true` in a production or public staging deployment. That flag is strictly for offline local test suites.

### Secrets (Configured via `wrangler secret put`)

Sensitive credentials must **never** be committed to Git or placed in plaintext files:

```bash
# 1. Cloudflare R2 S3-Compatible Token (Scoped to printgo-pdfs with Read & Write)
pnpm --filter @printgo/worker exec wrangler secret put R2_ACCESS_KEY_ID
pnpm --filter @printgo/worker exec wrangler secret put R2_SECRET_ACCESS_KEY

# 2. Razorpay Credentials (Test Mode for Staging, Live Mode for Production)
pnpm --filter @printgo/worker exec wrangler secret put RAZORPAY_KEY_ID
pnpm --filter @printgo/worker exec wrangler secret put RAZORPAY_KEY_SECRET
pnpm --filter @printgo/worker exec wrangler secret put RAZORPAY_WEBHOOK_SECRET
```

---

## 4. Database Setup & Remote Migrations

All D1 migrations must be executed in strict numerical sequence against the remote database:

```bash
# Run migrations in order on remote D1:
pnpm --dir apps/api/worker exec wrangler d1 execute printgo-production --remote \
  --file=database/migrations/0001_initial_schema.sql

pnpm --dir apps/api/worker exec wrangler d1 execute printgo-production --remote \
  --file=database/migrations/0002_customer_draft_upload.sql

pnpm --dir apps/api/worker exec wrangler d1 execute printgo-production --remote \
  --file=database/migrations/0003_payment_idempotency.sql

pnpm --dir apps/api/worker exec wrangler d1 execute printgo-production --remote \
  --file=database/migrations/0004_customer_tracking.sql

pnpm --dir apps/api/worker exec wrangler d1 execute printgo-production --remote \
  --file=database/migrations/0005_printer_test_commands.sql

pnpm --dir apps/api/worker exec wrangler d1 execute printgo-production --remote \
  --file=database/migrations/0006_paid_print_execution.sql
```

### Initial Admin Account Bootstrap

Once schema is applied, bootstrap the initial single-admin credentials using the interactive, zero-echo script or direct hashed insertion:

```bash
# Locally computes SHA-256 scrypt/PBKDF2 hash without logging password:
pnpm admin:bootstrap
```

---

## 5. R2 Bucket Configuration & CORS

1. **Private Access**: Confirm that **Public Access** (and `r2.dev` subdomain) is **Disabled**.
2. **CORS Configuration**: The browser performs direct presigned `PUT` uploads to R2. Apply the following CORS policy to `printgo-pdfs`:

```json
[
  {
    "AllowedOrigins": [
      "https://print.<shop-domain>.com",
      "https://printgo-customer.pages.dev"
    ],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type", "If-None-Match", "Cache-Control"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 300
  }
]
```

> [!NOTE]
> Do not use wildcard `*` origins. Only the exact customer-facing origin is permitted.

---

## 6. Frontend Applications (Cloudflare Pages)

Both web applications are Vite Progressive Web Apps (PWAs).

### Customer PWA (`apps/web/customer`)

- **Build Command**: `pnpm --filter @printgo/customer build`
- **Output Directory**: `apps/web/customer/dist`
- **Environment Variables**:
  - `VITE_API_BASE_URL`: `https://api.<shop-domain>.com` (or Worker URL `https://printgo-api.<account>.workers.dev`)

### Admin PWA (`apps/web/admin`)

- **Build Command**: `pnpm --filter @printgo/admin build`
- **Output Directory**: `apps/web/admin/dist`
- **Environment Variables**:
  - `VITE_API_BASE_URL`: `https://api.<shop-domain>.com` (or Worker URL `https://printgo-api.<account>.workers.dev`)

---

## 7. Razorpay Integration & Webhook Configuration

1. **Dashboard Setup**: In the shop's Razorpay Dashboard, generate API keys in **Test Mode** for staging, or **Live Mode** for production.
2. **Webhook Registration**:
   - URL: `https://api.<shop-domain>.com/api/webhooks/razorpay`
   - Secret: Generated random secret saved to Worker as `RAZORPAY_WEBHOOK_SECRET`
   - Active Events:
     - `payment.captured`
     - `order.paid`
     - `payment.failed`

---

## 8. Deployment Smoke Test Checklist

After deployment, perform these non-destructive verification checks:

1. **Health Check**:
   ```bash
   curl -i https://api.<shop-domain>.com/health
   # Expected: HTTP 200 {"ok":true,"data":{"service":"printgo-api","status":"available"}}
   ```
2. **Customer Configuration**:
   ```bash
   curl -i https://api.<shop-domain>.com/api/customer/config
   # Expected: HTTP 200 with shop settings and Cache-Control: no-store
   ```
3. **CORS & Origin Isolation**:
   ```bash
   curl -i -H "Origin: https://malicious.com" https://api.<shop-domain>.com/api/customer/config
   # Expected: No Access-Control-Allow-Origin header for untrusted origin
   ```
4. **Admin Protection**:
   ```bash
   curl -i https://api.<shop-domain>.com/api/admin/auth/me
   # Expected: HTTP 401 AUTH_SESSION_REQUIRED
   ```
5. **Customer Web App**: Visit customer URL in browser. App loads, reaches Worker, and displays shop name and upload box.
6. **Admin Web App**: Visit admin URL in browser. Sign in using bootstrapped credentials. Verify Settings, Pricing, Printer, and Live Orders pages render cleanly without mock data.
7. **Readiness Check**: In staging without a live Windows Agent, attempting to pay should fail closed with `NO_ONLINE_AGENT` / `NO_ONLINE_PRINTER`. This confirms fail-closed safety is active.

---

## 9. Rollback & Disaster Recovery

- **Worker API**: Rollback instantly via Cloudflare Dashboard (`Deployments` tab → select previous deployment → `Rollback`).
- **Pages**: Rollback via Pages dashboard (`Deployments` → previous commit → `Rollback`).
- **D1 Database**: D1 creates automatic daily backups. Manual snapshots can be taken via `wrangler d1 backup create printgo-production`.
- **R2 Storage**: R2 retains objects until logical/physical expiry. Never truncate or purge customer buckets manually.

---

## 10. Hardware Acceptance Prerequisites (Tomorrow)

Before conducting the physical printer acceptance test:

1. Connect target Windows 10/11 shop computer to network and power.
2. Verify shop printer drivers are installed and printer prints a Windows test page.
3. Install Node.js 22 LTS on Windows PC.
4. Pair Windows Agent with deployed Cloudflare Worker using one-time pair code from Admin Portal (`/admin/printer`).
5. Verify Agent pulses heartbeat every 30s and status displays `ONLINE` in Admin Portal.
6. Trigger remote diagnostic test print from Admin Portal to verify spooler correlation and physical output.
