# PrintGo V2

PrintGo V2 is a production-oriented online printing system installed separately for each print/xerox shop. Customers will upload a PDF, choose print settings, pay the shop through Razorpay, track the job, and collect the printed output. Each shop owns its Cloudflare infrastructure, Razorpay account, production data, Windows computer, and printer; the developer retains the private source repository.

The project has completed **Phase 5 — Razorpay Payment, Verified Job Creation &
Customer Job Code**. The Customer PWA validates and uploads PDFs, receives a
server-priced review, opens Razorpay Test/Live checkout only after a fresh
server recalculation, and shows a human job code only after captured-payment
verification. Tracking, Agent connectivity, and printing remain scheduled for
later phases; production payment creation currently fails closed until Phase 7
supplies real printer readiness.

## Source of truth

Read these documents before each major phase:

- [`00_PROJECT_INDEX.md`](./00_PROJECT_INDEX.md)
- [`01_TECHNICAL_ARCHITECTURE.md`](./01_TECHNICAL_ARCHITECTURE.md)
- [`02_PRODUCT_REQUIREMENTS_AND_UX.md`](./02_PRODUCT_REQUIREMENTS_AND_UX.md)
- [`03_BUILD_PHASES_AND_AI_HANDOFF.md`](./03_BUILD_PHASES_AND_AI_HANDOFF.md)

Phase documentation: [`docs/CUSTOMER_UPLOAD.md`](./docs/CUSTOMER_UPLOAD.md) and
[`docs/PAYMENTS.md`](./docs/PAYMENTS.md).

## Repository layout

```text
apps/web/customer       Customer React/Vite PWA
apps/web/admin          Admin React/Vite PWA
apps/api/worker         Cloudflare Worker API
apps/agent/windows      Windows Agent foundation
packages/domain         Shared domain vocabulary
packages/validation     Shared validation primitives
packages/pricing        Money/pricing foundations
packages/auth           Shared auth-safe types
packages/shared         Deliberately generic utilities
packages/api-contract   Shared API response contracts
database/               D1 migrations and synthetic development seeds
docs/                   Focused engineering conventions
tests/                  Future cross-workspace/integration tests
scripts/                Future repeatable project scripts
```

## Prerequisites

- Node.js 22 or newer
- pnpm 12 (Corepack can provide the version declared in `package.json`)

## Local development

```bash
corepack enable
pnpm install
pnpm db:setup:local
pnpm admin:bootstrap
pnpm dev:worker
pnpm dev:admin
```

The bootstrap command prompts without terminal echo and never commits or prints the password. The default local login identifier is `admin`; pass a different identifier as `pnpm admin:bootstrap -- dev-admin`. Open `http://localhost:5174/admin` after both development servers start. Other entry points are `pnpm dev:customer` and `pnpm dev:agent`.

Copy only the relevant `.env.example` or `.dev.vars.example` file to its ignored local counterpart. Never commit real Razorpay credentials, session keys, Cloudflare credentials, Agent secrets, or production tokens.

## Quality commands

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

See [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md) for workspace details,
[`docs/ADMIN_AUTH.md`](./docs/ADMIN_AUTH.md) for authentication,
[`docs/PRICING.md`](./docs/PRICING.md) for authoritative pricing,
[`docs/PAYMENTS.md`](./docs/PAYMENTS.md) for Razorpay and readiness setup,
[`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md) for foundational conventions,
and [`docs/DATA_MODEL.md`](./docs/DATA_MODEL.md) for the finalized D1 model.

Validate the migration and deterministic development seed against local Cloudflare D1 with:

```bash
pnpm db:validate
```

## Deployment boundary

One production deployment represents exactly one shop. It has one domain/site, Worker, D1 database, R2 environment, and shop-owned Razorpay account; it may have multiple Agents and printers. Separate shop deployments reuse the private source code but share no production data. Production resources are provisioned in later phases.
