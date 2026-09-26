# Development

For the private R2 boundary, see `docs/CUSTOMER_UPLOAD.md`. For Razorpay Test
Mode configuration, payment verification, and the development-only readiness
bypass, see `docs/PAYMENTS.md`. For the code-plus-private-token tracking model,
browser fragment handling, and customer-safe response boundary, see
`docs/CUSTOMER_TRACKING.md`.

## Workspace rules

- The four root architecture documents are the project constitution and must be read before each major phase.
- Keep browser, Worker, Windows, and shared-package responsibilities separate.
- Put code in `shared` only when it is environment-neutral and genuinely reused.
- Do not import browser or Node APIs into domain and contract packages.
- Phase-specific features and migrations belong in their scheduled phase.
- One production deployment is one shop. Do not introduce tenant routing, runtime shop switching, shared multi-shop storage, or `shop_id` columns solely for isolation.

## Setup

Use Node.js 22+ and the pnpm version declared in the root `package.json`.

```bash
corepack enable
pnpm install
pnpm db:setup:local
pnpm admin:bootstrap
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm db:validate
```

Web and Worker development servers are intentionally separate so their production boundaries remain visible. For Admin development, run `pnpm dev:worker` and `pnpm dev:admin` in separate terminals, then open `http://localhost:5174/admin`. The Worker uses persistent local D1 state in `.wrangler/local` and trusts only the configured Admin development origin.

After signing in, `/admin/shop-settings` and `/admin/pricing` load current configuration from the Worker. Both screens use deliberate saves: browser edits remain local until submitted, and the Worker validates the complete request. Pricing is stored in integer paise even though the Admin enters rupees. The pricing save updates all eight print rates, all four fixed file-size charges, and its audit event in one D1 batch.

`pnpm db:setup:local` creates the local schema and deterministic non-credential seed. Run `pnpm admin:bootstrap` next. It reads a 12–128 character password without terminal echo, hashes it before calling Wrangler, and removes its mode-`0600` temporary SQL file. It defaults to login `admin`; use `pnpm admin:bootstrap -- dev-admin` for another synthetic identifier. Re-running it resets the single admin and revokes existing sessions.

## Environment strategy

Committed example files contain placeholders only. Create ignored local files beside them:

| Component    | Template                            | Local file   | Intended contents                  |
| ------------ | ----------------------------------- | ------------ | ---------------------------------- |
| Customer web | `apps/web/customer/.env.example`    | `.env.local` | Public API URL only                |
| Admin web    | `apps/web/admin/.env.example`       | `.env.local` | Public API URL only                |
| Worker       | `apps/api/worker/.dev.vars.example` | `.dev.vars`  | R2/Razorpay secrets and local gate |
| Agent        | `apps/agent/windows/.env.example`   | `.env.local` | Local API/pairing configuration    |

Frontend variables prefixed with `VITE_` are public. Razorpay secrets, Agent credentials, and Cloudflare credentials must never be placed in frontend files. Admin sessions are opaque random tokens and do not require a signing secret. Production Worker secrets will be configured through Cloudflare secret management during deployment, not committed configuration.

## Cloudflare resources

The main Worker config contains no account IDs or resource IDs. `wrangler.dev.jsonc` contains only a local placeholder D1 ID and non-secret development origin. Actual shop-owned resources and the production origin are added during deployment. Each production deployment receives its own D1/R2 resources. Customer and Admin Vite outputs are suitable for separate Cloudflare Pages projects.

## Verification policy

Run targeted tests while implementing a phase, then all required root quality
commands before declaring that phase complete. Capacity/free-tier simulation is
specifically reserved for Phase 16 and does not replace normal functional
testing.

For customer tracking, test the private API with both the job code and bearer
token. A job-code-only request is intentionally invalid. Browser tests should
also cover fragment consumption, `sessionStorage` refresh restoration, generic
invalid/expired handling, completed jobs after file deletion, and network
failure. The PWA service worker has no `/api` runtime cache, and private tracking
responses must remain `no-store`.

For Phase 3 configuration changes, also verify an authenticated settings and pricing update against local D1, reload both resources, and run a calculation through `@printgo/pricing`. The V1 single-admin assumption means optimistic conflict detection is not currently implemented; related pricing rows are nevertheless committed atomically.

For Windows Agent development, use `pnpm dev:agent` or `pnpm --filter @printgo/windows-agent dev -- --pair <CODE> --server http://localhost:8787 --name "Local Dev PC"`. On non-Windows platforms, the development adapter simulates printers and the plaintext development credential store writes a mode-`0600` file to `~/.printgo/agent-credentials.local.json`; both fallbacks are forbidden in production. Real Windows discovery, DPAPI, SumatraPDF submission, and physical identification-sheet output require a Windows host and are not exercised on macOS/Linux. See `docs/IDENTIFICATION_SHEET.md` for the Phase 9 local-only subsystem and verify `/admin/printers` for pairing, live status, capabilities, revocation, and diagnostic test-print state.
