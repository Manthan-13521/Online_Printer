# Agent, Cloudflare, branding and print efficiency report

Development pass: 28–29 September 2026. PHYSICAL/WINDOWS VERIFICATION: PENDING. BHAVESH was unavailable; no network rescans, SSH attempts, real charges, physical printing or production deployment were performed.

## Baseline and changes

Baseline source and API measurements are saved under `evidence/efficiency/baseline-*`. Existing commercial-hardening edits were preserved.

| Metric                                       | Before                                                                   | After                                                                                                        | Evidence category                                |
| -------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Agent idle requests/hour                     | 120                                                                      | 720                                                                                                          | Code + accelerated Agent test                    |
| Agent idle requests/15 hours                 | 1,800                                                                    | 10,800                                                                                                       | Code + accelerated Agent/API tests               |
| Persisted unchanged heartbeats/hour          | 120                                                                      | 60                                                                                                           | Code + local SQLite                              |
| Persisted unchanged heartbeats/15 hours      | 1,800                                                                    | 900                                                                                                          | Code + local SQLite                              |
| Unchanged printer-row writes                 | 0 for reported unchanged printers; removed printers repeatedly rewritten | 0, including repeatedly missing/offline printers                                                             | Repository + API regression                      |
| Printer reports/15 hours                     | 1,800 full payloads                                                      | 1 startup report; later reports only on change                                                               | Accelerated Agent test                           |
| PowerShell launches/hour, one stable printer | 126 (120 discovery + 6 capability)                                       | 126                                                                                                          | Code + injected executor; no Windows measurement |
| Idle request SQL                             | 14 statements at baseline startup                                        | 3 per stable pulse; one extra statement on liveness persistence                                              | Actual local handlers                            |
| Dashboard visible requests/hour              | 1,080                                                                    | 120                                                                                                          | Three calls/10s → one call/30s                   |
| Dashboard hidden requests/hour               | 1,080                                                                    | 0                                                                                                            | Visibility regression                            |
| Live Orders visible requests/hour            | 180                                                                      | 90 after unchanged-response backoff; 180 while changing                                                      | 12-hour fake-clock regression                    |
| Customer tracking                            | 15s initially, 30s after two minutes, terminal stop                      | Preserved; duplicate focus requests guarded; terminal state resets per order; expired/invalid tracking stops | Browser regression                               |
| Customer config per app mount                | 1                                                                        | 1, shared branding across routes                                                                             | Source + browser tests                           |

The higher pulse frequency improves paid-job pickup. It does not multiply PowerShell launches or heartbeat writes. Discovery was already every 30 seconds in this checkout; no reduction from that baseline is falsely claimed. Configurable Agent constructor intervals are range-checked.

## Resource measurements

Accelerated 15-hour Agent simulation: 10,800 HTTP calls, 1 full printer report, 1,890 injected PowerShell invocations. Measured Mac process CPU 101.39 ms; wall 115.67 ms; peak sampled heap 19.89 MiB; sampled RSS 93.03 MiB. These are accelerated test-process resources, not actual 15-hour Windows idle consumption. The predeclared heap-growth limit is 64 MiB. Actual idle Windows CPU/RAM remain pending.

Logs have no routine per-pulse success messages. The CLI writes sanitized logs with one rotated backup (1 MiB each), bounded pending messages, and no phone/PDF/signed-URL payloads. The Control Center continues reading `agent-status.json`; it does not own a second cloud polling loop.

## Free-tier daily models

MODELED, not Cloudflare billing telemetry. Includes both Admin screens visible all day, visits, uploads, payments, tracking, two print steps, preflights and retention.

| Orders/day | Worker requests/day | D1 reads/day | D1 writes/day | R2 A/month | R2 B/month | Normal R2 GB |
| ---------- | ------------------: | -----------: | ------------: | ---------: | ---------: | -----------: |
| 60         |              18,585 |      641,400 |        18,440 |      1,920 |     14,670 |       0.0092 |
| 800        |              42,450 |    2,518,040 |       206,400 |     25,230 |    195,600 |       0.1224 |
| 1000       |              48,900 |    3,025,240 |       257,200 |     31,530 |    244,500 |        0.153 |

60-order headroom: Workers 81.42%, reads 87.17%, writes 81.56%. Every critical daily resource is below 50% in this model. The 800/1,000-order write envelopes exceed the Free quota; successful software simulation does not establish free-tier operation at those volumes.

Official limits, query/index details, assumptions and storage-growth constraints: [runtime budget](CLOUDFLARE_RUNTIME_BUDGET.md).

## Software simulation and stress

Real Worker handlers and repositories, disposable migrated SQLite, mock Razorpay/R2/spooler. No actual payment or printing. The business clock advances across 15 hours. Bursts of 10, 25 and 50 paid orders use concurrent claims and a single selected Agent. Repeated responses for an existing claim are renewals, not new claims. The assertions reject duplicate attempts, lost jobs, unfinished steps, price changes across ID modes, webhook replay changes and cleanup-budget overruns.

Thresholds were recorded before workloads: zero duplicate attempts/lost jobs/incorrect states/unexpected HTTP responses, sampled process RSS <512 MiB, each route's local p95 <250 ms. Resource measurements include the in-process database/fixtures; this is not Agent-only memory.

| Orders | Result | Duplicate attempts | Lost jobs | Incorrect states | Sampled peak RSS MiB | Overall local API p95 ms | Local orders/sec |
| ------ | ------ | -----------------: | --------: | ---------------: | -------------------: | -----------------------: | ---------------: |
| 800    | PASS   |                  0 |         0 |                0 |               141.66 |                     78.2 |            46.54 |
| 1000   | PASS   |                  0 |         0 |                0 |               185.12 |                     78.9 |            45.96 |

The tests drain the synthetic queue with fixed-size batches. They do not reproduce physical paper throughput, an actual 15-hour soak, WAN failures or deployed Worker CPU. Full per-route timing, SQL and R2 counts are in `evidence/efficiency/scale-results.json`.

## Branding and identification sheet

- Shop name remains required; the existing `shop_name` field is reused. Logo remains optional.
- Upload/replace/remove uses authenticated, origin-checked Admin endpoints. PNG/JPEG/WebP MIME and signatures are checked under a streaming 256 KiB cap. Unique keys plus conditional replacement avoid deleting a concurrently selected logo.
- Public access resolves only the selected `branding/` asset; no bucket listing. Retention never touches this namespace. A cached old logo can remain visible for at most its five-minute cache lifetime.
- Customer upload/review/success/tracking share the shop header. Dashboard shows shop name/logo, readiness, queue/attention, today's completed orders and identification setting.
- Browser title and runtime install manifest use the shop name with stable app identity/scope. Packaged fallback icons remain PrintGo icons. Browser/OS install-name refresh is not hardware-verified.
- Identification ON/OFF and FIRST/LAST remain the existing settings. The claimed plan retains its sheet even if the setting changes during that order.
- Physical sheet: shop name at top, large job code, full phone, order details, no logo, fixed A4/B&W/simplex/one copy. Full phone is confined to the authenticated Agent sheet payload and local PDF; public tracking remains masked. Older Agent compatibility retains the masked field.
- Quoted pages/copies/amount/payment remain unchanged by the operational sheet. Unit tests and actual API simulations verify this.
- The synthetic PDF was rendered and visually inspected. Existing ASCII PDF font fallback remains; non-Latin typography needs separate font support.

## Print-step latency and safety

The baseline daemon used a 30-second interval. A completed step could wait for the next timer; the first startup pulse could also delay initial timer installation until execution returned. The adapter additionally allows up to 25 seconds to find the spool job, waits up to 5 seconds for Sumatra exit, and searches up to 1 second post-exit. Local spool observation uses one-second checks for up to 15 seconds. These mechanisms explain possible software delays; none establishes the exact cause of the previously perceived hardware gap.

After change, a positively completed step triggers the next pulse immediately; it does not wait for the normal five-second poll. Fresh cached printer state avoids a discovery round trip between steps. Required durable `SUBMISSION_STARTED`, spool-ID persistence and final acknowledgement remain distinct. Local PDFs are removed after successful spooling rather than after monitoring finishes. An unreachable result endpoint retains the exact spool identity in the local journal.

No early two-step pipeline was enabled. The existing single-step journal and sequential server ownership rules do not prove safe recovery for two simultaneous in-flight submissions. The unsafe healthy-printer/uncorrelated-fast-despool success shortcut was removed: such a result becomes uncertain and requires review. BLOCKED keeps the same spool ID; uncertain work is never automatically retried.

Timing logs now identify step preparation, submission start, Sumatra process start, correlated spool capture, adapter return, durable spool acknowledgement and step acknowledgement. Step IDs connect T1–T4/T6–T8 across the two steps without PII. The current adapter does not wait for Event 307; T5 must be captured from the real Windows event log during the hardware run. No Event 307 wait was removed and no Event 307 completion is claimed.

Measured local ID PDF generation (200 samples, including cold first render): p50 0.067 ms, p95 0.114 ms, maximum 16.794 ms. Pre-generating it would not materially explain a 10-second gap, so no extra retained PII file/cache was introduced.

Old physical/software gap: user-reported ~10+ seconds, not measured in this pass. New scheduling delay after confirmed completion: zero configured timer delay, covered by completion scheduling code/tests. Actual safe-spool-acceptance to second submission <=1–2 seconds: NOT VERIFIED; no such claim is made. Safety boundaries were preserved and ambiguity handling tightened.

## Retention fixes

Completion previously changed upload retention only when its reason was NULL. Payment capture already sets an unresolved-failure reason, so completed uploads could retain the 24-hour deadline. Completion now replaces that reason with the one-hour deadline; migration 0010 repairs affected existing completed uploads. Five-hour PII purge remains. The scale tests verify all completed uploads and PII are cleaned in bounded passes.

## Reproduce and release gates

From `/Users/manthanjaiswal/Printe_Go_`:

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm db:validate
pnpm build
pnpm build:agent:windows
node scripts/efficiency-budget.mjs
node scripts/efficiency-audit.mjs
```

Validation results are recorded in `evidence/efficiency/validation.md`. Migration 0010 has only been applied to disposable local databases. It must precede deployment of the new Worker. Deploy compatible Worker and Agent versions together. No production settings, infrastructure or credentials were changed.

## Next hardware-session checklist

PHYSICAL/WINDOWS VERIFICATION: PENDING for every item below. Do not rescan or repeatedly SSH to BHAVESH while it is unavailable.

1. Build and run the actual Windows EXE/Control Center/installer; verify fresh install, DPAPI pairing, startup, reboot, upgrade and uninstall. Mac SEA output is not a verified Windows binary.
2. Measure real idle CPU/RSS over a shop day, PowerShell launches/hour, pulse timing and reconnect behavior.
3. Perform an explicitly authorized real paid order; verify 10-copy settings, physical page selection, ID OFF/FIRST/LAST, unmasked phone, shop name, no printed logo and unchanged customer charge.
4. Capture T1–T8, including Event 307 from PrintService logs. Correlate printer, spool ID, submission time and both documents. Measure actual transition latency.
5. Exercise paper out/jam/offline, fast despool, process crash between steps, network loss after spool capture, reboot and lease expiry. Confirm no duplicate physical submission and proper human review for uncertainty.
6. Verify installed customer/Admin PWA branding, logo replacement/removal and offline static behavior in supported browsers. Payment/tracking APIs must remain network-correct.
7. Measure deployed Worker CPU and D1 billed reads/writes in the shop account; review migration repair impact and quota headroom before release.
8. Keep commercial findings: no central licensing/superadmin; shop Cloudflare deployment is the control boundary. Windows packaging remains PARTIAL/NOT VERIFIED until exercised. Third-party license compliance remains unresolved; no definitive compliance claim is made.

Do not deploy solely because these automated tests pass.
