# DRY-RUN SUMMARY: Polling Optimization & Instant Wake-Up

I have inspected the entire PrintGo polling architecture, the Windows Agent, Cloudflare Workers, and D1 database limitations. Below is the proposed dry-run plan for implementing the requested polling optimizations safely.

**Action Required:** Please read the blocker regarding **Instant Wake-up** and provide your decision before I begin code modifications.

---

## 1. Planned Interval Updates

I will update the codebase with the exact requested polling intervals:

- **Windows Agent active:** 6 seconds (`apps/agent/windows/src/agent-daemon.ts`)
- **Admin Dashboard:** 35 seconds (`apps/web/admin/src/DashboardPage.tsx`)
- **Admin Live Orders:** 40 seconds (`apps/web/admin/src/LiveOrdersPage.tsx`)
- **Customer Private Tracking:** 10s for the first minute, then 30s (`apps/web/customer/src/TrackingPage.tsx`)
- **Customer Public Tracking:** 20 seconds (`apps/web/customer/src/PublicTrackingPage.tsx`)
- **Local Windows Spooler Monitor:** 3 seconds (`apps/agent/windows/src/printing/spool-monitor.ts`)
- **Payment Verification:** Immediate (No changes needed, already webhook/server-driven)
- **Agent Heartbeat D1 Writes:** 65 seconds (The Worker's `nowMs - agent.lastHeartbeatAtMs >= 60_000` check in `apps/api/worker/src/agent/service.ts` will be adjusted to `65_000`, and I will ensure the dashboard's "offline" expiry threshold safely accommodates this longer write interval).

---

## 2. The "Instant Wake-up" Blocker (REPORTED)

The requirement states:

> _"Windows Agent idle: 60 seconds, with reliable instant wake-up for newly paid print jobs... Design instant wake-up to be reliable, secure and cost-efficient... If instant wake-up cannot be implemented safely within the architecture, do not fake it or silently replace it with polling; report the blocker."_

**The Blocker:**
True "instant wake-up" (Server-Sent Events / Long-Polling) without a paid coordination layer (like Cloudflare Durable Objects or Redis) cannot be safely implemented on the Cloudflare Workers Free Tier without introducing high risks of CPU exhaustion.

1. **No Cross-Isolate Communication:** Cloudflare Workers are stateless and isolated. A webhook request (Isolate A) processing a payment has no native, zero-cost way to asynchronously send an event to a long-polling request (Isolate B) held by the Windows Agent.
2. **Loop Polling Exhausts CPU Limits:** The only way for Isolate B to discover the payment while holding the connection open is to run a continuous `while` loop that checks D1 (e.g. `has_print_work`). However, the Free Tier strictly enforces a **10ms CPU time limit** per request. Executing repeated D1 queries within a single long-polling request will exceed this CPU limit, causing Cloudflare to crash the request.
3. **No Browser Triggers:** The customer browser cannot securely be trusted to release or trigger the jobs (as specified in your requirements).

**Because I am instructed not to fake instant wake-up or silently replace it with polling, I am reporting this architectural blocker.**

---

## 3. Decision Required

How would you like to proceed with the Windows Agent's idle behavior?

- **Option A: Adaptive Standard Polling (Recommended).** Instead of true instant wake-up + 60s fallback, the Agent simply polls every **5 to 6 seconds** over standard HTTP when idle.
  - _Why this works:_ 5-second polling generates ~17,280 requests per day. The Cloudflare Free Tier gives 100,000 requests per day. This fits perfectly, uses zero extra CPU time, completely avoids connection timeouts, and keeps D1 safe because the Worker already limits D1 heartbeat writes to 60+ seconds.
- **Option B: Strict 60-Second Polling.** The Agent strictly polls every 60 seconds when idle, accepting up to 60 seconds of latency between a customer paying and the print job starting.
- **Option C:** If you have an alternative acceptable workaround for Cloudflare Free Tier signaling, please let me know.

**Please approve the interval updates and select an option for the Agent's idle behavior. I will not push or commit any changes until explicitly authorized.**
