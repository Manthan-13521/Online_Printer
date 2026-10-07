# INCIDENT AUDIT COMPLETE: YES

## PAYMENT
- payment actually confirmed: YES
- D1 payment state: PAID
- D1 order state: QUEUED (for PG-YP3D8T) and COMPLETION_UNKNOWN (for PG-BVK4E5)
- customer incorrectly shows Pay Again: YES
- payment root cause: The Razorpay Webhook correctly transitions the order to `QUEUED`. However, if the frontend payment success handler is missed, the customer clicking "Try Again" triggers `customerApi.createPayment`, which calls `createCheckout`. This hits `requireDraft` and `validateDraftState`, which strictly throws `PAYMENT_STATE_INVALID` because the order is no longer in `PAYMENT_PENDING` (it is `QUEUED`). The frontend catches this as a 400 error, displays a generic message, and fails to navigate the customer to the tracking page.

## QUEUE
- paid order entered queue: YES
- queue blocked: YES
- blocking order/state: The agent is offline/looping and failing to connect, leaving QUEUED orders untouched. Also, previously claimed jobs (like PG-BVK4E5) entered `PRINT_OUTCOME_UNCERTAIN` and fell into the `COMPLETION_UNKNOWN` state. The queue query `work` check explicitly omits `COMPLETION_UNKNOWN`, so they remain orphaned without triggering recovery.
- queue root cause: The `recoverExpiredClaims` and `work` queries omit `COMPLETION_UNKNOWN` (added in a later migration but missing from active queue queries). Moreover, the Agent is failing to heartbeat successfully because the Worker throws an unhandled 500 `AGENT_REQUEST_FAILED` exception during `service.heartbeat()` processing, blocking any job claims.

## WINDOWS AGENT
- actual running version/build: 2.1.0 (PrintGo-Agent.exe modified 2026-10-07 05:35:48)
- expected version/build: 2.1.0
- stale Agent: NO
- duplicate Agent: YES (Three orphaned `PrintGo-ControlCenter.exe` processes running simultaneously under `BHAVESH\MANTH`)
- EXE launches: YES (but loops on network failure)
- exact EXE error: `Agent communication failed: Agent request could not be completed.; retrying with bounded backoff.`
- Agent authenticated: YES (token exists, though heartbeat fails with 500 later)
- Agent heartbeat works: NO (Server returns 500)
- print spooler submitted: NO (currently; previously it submitted PG-BVK4E5 before crashing)
- Windows root cause: The Agent encounters a 500 error on every heartbeat request. This causes bounded backoff and eventual daemon death. Meanwhile, multiple stale `PrintGo-ControlCenter.exe` instances are running in the background.

## NETWORK BOUNDARY
- Heartbeat: FAIL (Worker throws unhandled exception -> 500 `AGENT_REQUEST_FAILED`)
- Next Job Request: NOT REACHED (Blocked by failing heartbeat)
- Signed PDF Download: NOT REACHED
- Windows Spooler Submit: NOT REACHED
- First failure boundary: Heartbeat API call (`/api/agent/heartbeat`)

## CLEAN REINSTALL PLAN
1. Run `Stop-Process -Name "PrintGo*" -Force` to forcefully terminate all stale `PrintGo-Agent` and `PrintGo-ControlCenter` instances.
2. Back up `C:\Users\MANTH\AppData\Local\PrintGo\agent-credentials.dat` to preserve the installation authorization.
3. Clean the `C:\PrintGo\agent\` and `C:\PrintGo\installer\` directories of old EXEs.
4. Download the latest `PrintGo-Agent.exe` to `C:\PrintGo\agent\`.
5. Restore the credentials to `C:\Users\MANTH\AppData\Local\PrintGo\agent-credentials.dat`.
6. Configure the `PrintGo Agent` Windows Service/Startup Task to point strictly to the single new executable.
7. Start the Agent and monitor `%LOCALAPPDATA%\PrintGo\daemon.log` for successful heartbeat and claim.
