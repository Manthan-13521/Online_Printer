# Isolated stress audit

Run from the repository root with Node 22 and installed dependencies:

```sh
node scripts/stress-runner.mjs --local --duration 7200 --concurrency 8 --rps 1 --scenario soak
```

The runner bundles the unchanged API, runs its actual repositories against disposable SQLite with all migrations, and mocks R2, Razorpay and physical spooling. All outbound fetches are blocked except the in-memory Razorpay substitute. Synthetic credentials exist only in the disposable `.tmp/stress` database/process. No production configuration is loaded. `--base-url` accepts the synthetic origin only; staging is deliberately locked until an isolated target and a request budget have been verified.

`--rps` controls flow starts, not HTTP requests: each flow may make several requests. `--concurrency` bounds active flows without an unbounded pending queue. Saturated arrivals are counted as skipped. `--agents` supports 1–5. Other scenarios can be selected with `--scenario abuse` or a descriptive name for a constant workload. `--output` separates independent runs.

Acceptance thresholds are written before the first request. Unexpected HTTP errors must remain below 0.1%; intentional 4xx responses count as expected successes. Report latency per route. Investigate memory growth in recovery and distinguish retained data from leaks. Never call local process CPU Cloudflare CPU, returned SQLite rows D1 scanned rows, or table changes D1 billable writes (indexes add writes).

Progress is atomic every ten seconds; cumulative checkpoints every five minutes plus final. Histograms have fixed memory and 0.1 ms buckets through 6 seconds; larger observations retain exact maximum but saturate percentile buckets. Each route records SQL statement count, returned rows, changed table rows and SQLite execution duration. Process CPU attribution overlaps under concurrency, so route CPU is diagnostic only. Active resource types expose timer counts. A request taking over 30 seconds is counted as a timeout observation, not forcibly cancelled.

A full local run demonstrates handler/SQLite behavior only. It does not verify Cloudflare CPU, deployed R2 signing/privacy, frontend browser behavior, Windows rendering, provider delivery, or production quota metadata. Logs contain aggregate counters, route labels and generic failure codes, never request bodies, cookies, signed URLs or raw tokens. Keep final JSON/reports; remove only this harness's disposable `.tmp/stress` data after verification.
