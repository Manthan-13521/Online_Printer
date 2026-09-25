# Development

## Workspace rules

- The four root architecture documents are the project constitution and must be read before each major phase.
- Keep browser, Worker, Windows, and shared-package responsibilities separate.
- Put code in `shared` only when it is environment-neutral and genuinely reused.
- Do not import browser or Node APIs into domain and contract packages.
- Phase-specific features and migrations belong in their scheduled phase.

## Setup

Use Node.js 22+ and the pnpm version declared in the root `package.json`.

```bash
corepack enable
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Web and Worker development servers are intentionally separate so their production boundaries remain visible. Start them with the root `dev:*` commands.

## Environment strategy

Committed example files contain placeholders only. Create ignored local files beside them:

| Component    | Template                            | Local file   | Intended contents               |
| ------------ | ----------------------------------- | ------------ | ------------------------------- |
| Customer web | `apps/web/customer/.env.example`    | `.env.local` | Public API URL only             |
| Admin web    | `apps/web/admin/.env.example`       | `.env.local` | Public API URL only             |
| Worker       | `apps/api/worker/.dev.vars.example` | `.dev.vars`  | Local backend secrets           |
| Agent        | `apps/agent/windows/.env.example`   | `.env.local` | Local API/pairing configuration |

Frontend variables prefixed with `VITE_` are public. Razorpay secrets, session signing material, Agent credentials, and Cloudflare credentials must never be placed in frontend files. Production Worker secrets will be configured through Cloudflare secret management during deployment, not committed configuration.

## Cloudflare resources

The Worker config is safe for local development and contains no account IDs or resource IDs. D1 and R2 binding names are reserved in TypeScript as `DB` and `PDF_BUCKET`; actual shop-owned resources and environment-specific bindings are added in their implementation/deployment phases. Customer and Admin Vite outputs are suitable for separate Cloudflare Pages projects.

## Verification policy

Run targeted tests while implementing a phase, then all five root quality commands before declaring that phase complete. Capacity/free-tier simulation is specifically reserved for Phase 16 and does not replace normal functional testing.
