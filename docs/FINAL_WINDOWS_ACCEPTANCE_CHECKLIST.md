# Final Windows acceptance checklist

Current gate: **PHYSICAL/WINDOWS VERIFICATION: PENDING**. BHAVESH was offline during repository preparation. This checklist authorizes no unattended prints or payments. A technician and owner must supervise the session, explicitly authorize each paid test, and record actual results. Blank evidence means NOT VERIFIED.

## Evidence header

Record date/time zone, Git commit plus local diff hash, Node/pnpm versions on the build PC, Windows build, installer/Agent/Control Center/Sumatra SHA-256, signature status, shop deployment identity, driver version, and operator initials. Keep customer names, phone numbers, pairing links, secrets and PDF contents out of shared evidence. Use test identities and fixture identifiers. Keep exact printer names locally; refer to printer aliases in exported evidence.

## 1. Build and installation — zero sheets

- [ ] Use a Windows build workstation with the locked dependencies, .NET Framework C# compiler, Windows SDK signtool on PATH, and Inno Setup 6. Supply an independently reviewed portable Sumatra executable and its matching `PRINTGO_SUMATRA_SHA256`; do not download an arbitrary binary in the installer build.
- [ ] Run `pnpm windows:verify --build`. Compilation failure must stop packaging. Check `installer/dist/build-manifest.json`; no placeholder EXEs, no fabricated release URL, no silent use of an old Setup.
- [ ] Inspect Authenticode and trusted checksums for all binaries. A checksum proves integrity relative to its reference, not publisher authenticity. Resolve signing/reputation and third-party distribution obligations before commercial distribution.
- [ ] Manually install the reviewed `installer/dist/PrintGo-Setup.exe` as the intended shop Windows user. Current source installs per-user in `%LOCALAPPDATA%\Programs\PrintGo`; DPAPI belongs to this Windows user. Do not elevate into a different user account.
- [ ] Verify Start menu/desktop launch, files, uninstall entry, optional startup registration and `printgo://` handling. No Node installation, command prompt or API URL entry should be required of the owner.
- [ ] Existing machine-wide installation migration is NOT VERIFIED. Do not delete old credentials or automatically migrate between Windows users.

## 2. Connection and startup — zero sheets

- [ ] In the correct shop Admin, create a one-time pairing code. Use **Connect This PC Automatically**, or **Copy Connection Link** then paste into Control Center. Verify the link resolves to this shop, is rejected if malformed/expired/reused, and does not appear in support exports.
- [ ] Verify `%LOCALAPPDATA%\PrintGo\agent-credentials.dat` exists. Do not open/decrypt/export its contents. Confirm credential protection through real Windows pairing and same-user restart; mocked tests are insufficient.
- [ ] Verify Control Center does not claim success on failed pairing and does not wait forever for a daemon started by pairing.
- [ ] Sign out/in after the queue is empty and reconciled. Confirm one Agent instance, startup under the same Windows account, heartbeat restored, and saved configuration retained.
- [ ] Stale status must become stale/offline, never “ready” just because the UI refreshed. Confirm production selection in Admin; Windows default is not production authority.
- [ ] Re-pair/replacement: pause new orders, reconcile all queued/active/uncertain jobs and exact spool IDs, revoke/replace using the existing Admin flow, then connect a replacement PC. No resetting credentials or deleting journals to force recovery. Current owner maintenance flow remains PARTIAL: running Agent/re-pair/restart is conservatively deferred.

## 3. Printer selection and diagnostic — one sheet

- [ ] Discover printers; reject virtual/ineligible devices. Select and enable the intended physical production printer in Admin. Confirm driver A4, colour/monochrome and duplex capabilities rather than assuming them.
- [ ] Owner explicitly requests exactly **one diagnostic test page**. Record request ID, spool ID, driver/Event 307 evidence if available, and physically count one sheet. No duplicate physical print.
- [ ] Confirm unavailable/unknown/error status is shown truthfully. No background diagnostic printing.

## 4. Branding and identification sheets — five sheets

Use three distinct authorized one-page, one-copy, simplex test orders. Reuse synthetic customer details, not live customer data. Inspect server-authoritative quotes and verified payment states; do not manually mark unpaid orders paid.

| Case        | Sheets | Required observation                                                             |
| ----------- | -----: | -------------------------------------------------------------------------------- |
| ID disabled |      1 | Only the customer page; no hidden cover sheet; no duplicate physical print.      |
| ID FIRST    |      2 | Exactly one ID sheet followed by one customer page; no duplicate physical print. |
| ID LAST     |      2 | Exactly one customer page followed by one ID sheet; no duplicate physical print. |

- [ ] Shop name appears in Admin/customer branding and installed PWA. Test optional logo present, removed and invalid input without extra prints; compare icon/manifest after refresh and PWA relaunch.
- [ ] ID page: correct shop name/logo if supported by the selected setting, large job code, enabled customer fields and notes, timestamp and print settings; long text wraps/clips safely. Confirm optional full phone appears only on the explicitly configured physical sheet, never support logs.
- [ ] Settings survive reload and affect the intended subsequent order. A changed setting must not cause an already submitted step to print twice.
- [ ] Physically record ordering, page orientation, legibility and output tray sequence. Software tests cannot establish these.

Base minimum: **6 physical sheets total** (1 diagnostic + 1 ID-off + 2 FIRST + 2 LAST). An additional **1–2 sheets only if needed** for a distinct recovery/driver uncertainty test must be justified in the record. Do not run 800 orders or 100-copy stress tests on hardware. Tests reused across observations should not print again.

## 5. T1–T8 latency — use the same paid test orders

| Marker | Actual evidence to capture                                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| T1     | Worker confirms authenticated payment capture/verification and durable paid transition. Provider acceptance alone is insufficient. |
| T2     | Agent receives the claimed job/step.                                                                                               |
| T3     | Private signed download validated; ID preparation finished if applicable.                                                          |
| T4     | Durable SUBMISSION_STARTED boundary committed before physical submission.                                                          |
| T5     | Sumatra process begins (`sumatra_start`).                                                                                          |
| T6     | Exact spool ID captured/persisted, or documented fast-despool/Event 307 observation.                                               |
| T7     | Spool observation and Worker completion acknowledgement, recorded separately if times differ.                                      |
| T8     | Human observes final physical sheet out. This timestamp cannot be inferred from T6/T7.                                             |

Record raw UTC timestamps, clock offset/uncertainty between Worker and PC, per-step timings, and missing markers as NOT VERIFIED. Existing logs provide preparation/submission/Sumatra/spool markers; payment, claim, download completion, Worker acknowledgement and physical output need correlated observations. Do not fabricate unavailable timing points or put full URLs/PII in the record. Derive T2−T1 queue wait, T4−T2 preparation, T6−T5 submission, T8−T1 end-to-end only when both endpoints are actually measured. FIRST/LAST require two step records, not one blended spool identity.

## 6. Failure and maintenance checks

Pause intake where necessary. Use already planned jobs when safe. Never clear the spooler or delete a journal to make a check pass.

| Trigger                                                   | Required outcome and evidence                                                                                                                                               |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Printer offline before submission                         | Readiness failure blocks submission; no duplicate physical print.                                                                                                           |
| Paper out/jam after spool acceptance                      | Preserve the exact spool identity; operator resolves the physical condition; no automatic blind resubmit; no duplicate physical print.                                      |
| Internet interruption before claim                        | No claim means no print; reconnect resumes safely; no duplicate physical print.                                                                                             |
| Internet interruption after submission                    | Retain durable boundary/spool ID; reconcile without second submission; no duplicate physical print.                                                                         |
| Agent interrupted after submission                        | Only under a supervised fault test: recovery retains uncertain work and requires existing operator resolution; no duplicate physical print.                                 |
| Restart/re-pair/update while Agent runs or journal exists | Controls defer, no process kill, no credential overwrite by owner UI, no duplicate physical print.                                                                          |
| Idle upgrade/uninstall                                    | Technician maintenance only after reconciliation; installer blocks while Agent/Control Center/Sumatra runs; verify rollback/pairing retention; no duplicate physical print. |
| Replacement PC                                            | Revoke/reconcile old device before new device takes work; no duplicate physical print.                                                                                      |

Installer guards are conservative process/journal checks, not a transactional upgrade lock. Race-free maintenance, graceful stop, updater integration and replacement workflow remain commercial gates; do not imply they are complete.

## 7. Real resource observation and support — zero additional sheets

Run from a technician checkout after manual installation/pairing:

```powershell
pnpm windows:verify --observe-seconds 3600
```

Owner daily operation never needs this command. Without Node on the hardware PC, copy the reviewed script and run it as the technician:

```powershell
powershell.exe -NoProfile -File .\scripts\windows-hardware-acceptance.ps1 -ObserveSeconds 3600
```

The script only reads local Windows state and writes `.tmp/windows-acceptance/acceptance-*.json`. It does not contact Cloudflare or other hosts, enable Event 307 logging, launch the Agent, print, change pairing or clear queues. Missing permission/logging/component is NOT VERIFIED, not a pass. Review the generated report alongside this checklist. Inspect preexisting Event 307 entries without exporting document or owner fields; unrelated print events do not prove completion of a test order.

- [ ] Record actual elapsed observation, idle and loaded intervals, Agent/Control Center/Sumatra working set/private bytes, per-PID CPU deltas, handles, process counts, and PowerShell starts. Windows event-subscription failure leaves launch count NOT VERIFIED. Observer PowerShell is included in snapshots; short-lived processes may evade memory/CPU sampling.
- [ ] CPU core percentage = 100 × process CPU-seconds delta / elapsed wall-seconds. Machine percentage also divides by logical CPUs. New/exited PIDs require separate accounting; do not subtract cumulative CPU across different PIDs.
- [ ] Compare first/last/peak resources, post-job stabilization and crash/restart behavior. A ten-second check is not a one-hour soak; a one-hour check is not an overnight soak.
- [ ] Export support ZIP through Control Center. Unzip and search all entries for test canaries: PDF content, names, phones, presigned URLs, keys, tokens and DPAPI content must be absent. Current export retains anonymous printer status and allowlisted timing fields, not arbitrary raw logs.
- [ ] Complete `docs/PRODUCTION_COUNTER_ACCEPTANCE_TEMPLATE.md` before making production cost claims.

Final operator decision: READY / PARTIAL / BLOCKED / NOT VERIFIED per component. Physical verdict, actual sheets and remaining anomalies must be signed off separately. No commercial release until blockers are resolved.
