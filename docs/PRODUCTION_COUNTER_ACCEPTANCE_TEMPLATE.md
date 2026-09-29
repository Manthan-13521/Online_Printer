# Production counter acceptance record

Status: NOT VERIFIED. This is a measurement template, not a production test result. Developer-only; no owner-facing quota controls. Same codebase targets 50–60 orders/day on Free and 800+ orders/day software throughput with an appropriate approved infrastructure plan when limits require it. No paid add-on is introduced by this preparation.

Record shop deployment/database identity (no secrets), release hash, UTC date boundary/time zone, counter source and aggregation lag, concurrent traffic sources, test fixture IDs, actual payment authorization and operator. Use the same deployment/counter window before and after. Cloudflare quotas here remain planning inputs from the existing model; check provider/account limits at the measurement date.

## Counter table — fill actual numbers

| Counter / unit                           | Idle start | Idle end | Idle other/CLI usage | Test start | Test end | Test other/CLI usage |
| ---------------------------------------- | ---------- | -------- | -------------------- | ---------- | -------- | -------------------- |
| Workers requests / count                 |            |          |                      |            |          |                      |
| D1 rows read / rows                      |            |          |                      |            |          |                      |
| D1 rows written including indexes / rows |            |          |                      |            |          |                      |
| R2 Class A / operations                  |            |          |                      |            |          |                      |
| R2 Class B / operations                  |            |          |                      |            |          |                      |
| D1 storage / bytes, point in time        |            |          |                      |            |          |                      |
| R2 storage / bytes, point in time        |            |          |                      |            |          |                      |

Idle duration I = ____ seconds (**at least 3600**); test duration T = ____ seconds; completed test orders N = ____; failed/abandoned visits = ____; pages/copies and ID steps = ____; retention horizon observed = ____.

For request/row/operation counters C:

- Idle rate B = (idle end − idle start − independently attributable idle CLI/other usage) / I.
- Observed test delta D = test end − test start.
- Order-attributable estimate A = D − B×T − independently attributable test CLI/other usage.
- Marginal per order = A / N, only for N > 0 and comparable baseline/workload.
- Daily projection = idle rate × operating seconds + marginal per order × intended orders + separately measured visits/failures/retention not already included.

Keep raw deltas, signed residuals and attribution assumptions. Do not clamp a negative residual to zero; it indicates noise, lag or a bad baseline. Cron/retention costs may land later: include their matching window or report them separately. Do not double subtract cron already included in B. Local SQLite changed rows are not Cloudflare billable D1 index writes. Do not use CLI query counts as customer traffic.

Workers CPU: record sampled CPU-ms distribution (count, mean/p50/p95/max) from actual requests and distinguish CPU from wall latency. Do not infer CPU from request count or subtract percentiles as though additive. If aggregate CPU-ms exists, rate calculations require complete counts and matched samples. An absent metric stays NOT VERIFIED.

Storage: report snapshots in bytes and MiB (bytes / 2^20), plus retained growth over a stated period. R2 GB-month requires time-integrated byte occupancy under the provider's unit convention; a snapshot is not monthly usage. D1 retained history grows even when PII is erased; no indefinite free-storage guarantee.

## Developer warnings

At **65%** of each current daily Workers requests, D1 read and D1 write allowance, record a warning and inspect attribution/trends before growth. The local model emits the same threshold. This is a developer operating procedure; there is no central monitoring service or owner quota UI. Existing planning limits: 100,000 requests/day, 5,000,000 D1 rows read/day, 100,000 D1 rows written/day; verify applicable limits before relying on these numbers.

60/day model: 18,585 requests, 641,400 reads, 16,700 writes/day. 800/day model: 42,450 requests, 2,518,040 reads, 183,200 writes/day. Thus 800/day software capacity does **not** imply D1 Free write capacity. Do not remove financial/durable print writes to force that conclusion. Update forecasts from this measured record, keeping the model and production measurements separately labeled.

Final measured verdict: ____; evidence paths: ____; unresolved attribution/lag: ____; reviewer/date: ____.
