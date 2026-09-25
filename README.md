# PrintGo V2

PrintGo V2 is a production-oriented online printing system installed separately for each print/xerox shop. Customers will upload a PDF, choose print settings, pay the shop through Razorpay, track the job, and collect the printed output. Each shop owns its Cloudflare infrastructure, Razorpay account, production data, Windows computer, and printer; the developer retains the private source repository.

The project is currently in **Phase 0 — Repository and Specification Freeze**. No production business workflow has been implemented yet.

## Source of truth

Read these documents before each major phase:

- [`00_PROJECT_INDEX.md`](./00_PROJECT_INDEX.md)
- [`01_TECHNICAL_ARCHITECTURE.md`](./01_TECHNICAL_ARCHITECTURE.md)
- [`02_PRODUCT_REQUIREMENTS_AND_UX.md`](./02_PRODUCT_REQUIREMENTS_AND_UX.md)
- [`03_BUILD_PHASES_AND_AI_HANDOFF.md`](./03_BUILD_PHASES_AND_AI_HANDOFF.md)

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
database/               Future D1 migrations and development seeds
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
pnpm dev:customer
```

Other entry points are `pnpm dev:admin`, `pnpm dev:worker`, and `pnpm dev:agent`.

Copy only the relevant `.env.example` or `.dev.vars.example` file to its ignored local counterpart. Never commit real Razorpay credentials, session keys, Cloudflare credentials, Agent secrets, or production tokens.

## Quality commands

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

See [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md) for workspace details and [`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md) for foundational data conventions.

## Deployment boundary

Production resources are provisioned later and belong to the individual shop. Phase 0 does not provision Cloudflare Pages, Worker, D1, R2, Razorpay, or Windows installation resources.
