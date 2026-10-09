# Architecture Review: Cloudflare Free Tier Instant Wake-Up

I have completed the requested READ-ONLY research and architecture review, independently verifying Cloudflare's current Free Tier limits and evaluating the four proposed approaches.

### Cloudflare Free Tier Limits Verification

Cloudflare **does** now offer Durable Objects (DO) on the Workers Free plan, specifically with the SQLite storage backend.

- **Worker/DO Requests:** 100,000 per day combined limit.
- **Compute Duration:** 13,000 GB-s per day.
- **D1 Reads:** 5,000,000 per day.
- **D1 Writes:** 100,000 per day.

This invalidates the previous report's assumption that Durable Objects are strictly paid. However, the 10ms CPU limit per request on standard Workers is still a strict barrier for long-polling or standard WebSockets without DO.

---

### 1. Cloudflare Durable Objects + WebSockets with Hibernation

**How it works:** The Agent holds a WebSocket connection to a singleton `AgentRoom` DO. When a payment webhook arrives, it updates D1 securely, then sends a fire-and-forget RPC call to the DO. The DO broadcasts a `WAKE_UP` message. The Agent receives it and immediately triggers a standard `POST /api/agent/pulse` to pull the job.

- **Worker/DO Requests:** ~1,440/day (60s fallback polls) + small overhead for WS connections and webhooks. Very safe (limit 100k).
- **Durable Object Usage:** 1 instance (Singleton). Uses the Free Tier SQLite backend. DO hibernation ensures idle WS connections don't consume GB-s.
- **D1 Reads/Writes:** Normal operations. No polling loops.
- **Free-tier compatibility:** YES.
- **Estimated latency:** 10–50ms (Near-instant).
- **Reliability & Reconnect:** High. If the WS drops, the 60s HTTP polling acts as a safety net.
- **Idempotency & Safety:** **100% Safe.** The WS only sends a stateless ping. The actual job claiming and DB locking still happens via the atomic `POST /api/agent/pulse` HTTP endpoint. Razorpay idempotency is completely isolated from the WS.
- **Implementation Complexity:** **Medium–High.** Requires adding a DO class, `wrangler.jsonc` bindings, webhook RPC integration, and a WS client in the Agent.

---

### 2. WebSocket Connection (Standard Worker) + 60s Fallback

**How it works:** A standard Worker isolate accepts a WebSocket. Since isolates cannot talk to each other natively, the Worker must run a `setInterval` loop to poll D1 every few seconds while holding the WS open.

- **The Blocker:** Cloudflare enforces a **10ms CPU limit per connection** for WebSockets on standard Workers. Every D1 query consumes ~0.2ms CPU. A long-lived WS doing 4 queries a minute will accumulate CPU time and hit the 10ms limit within ~12 minutes, crashing the connection.
- **Conclusion:** Incompatible with Cloudflare Free limits.

---

### 3. Alternative Secure Push Architectures

- **Server-Sent Events (SSE):** Suffers from the exact same cross-isolate and CPU accumulation limitations as standard WebSockets.
- **External Pub/Sub (Redis, Pusher, AWS SQS):** Strictly violates the `AGENTS.md` invariant: "Zero Paid Cloud Infrastructure".
- **Conclusion:** No viable alternatives exist that are both free and reliable without DO.

---

### 4. Existing 15-Second Adaptive Polling

**How it works:** The Agent simply makes a standard HTTP POST every 15 seconds when idle.

- **Worker Requests:** 5,760 per day. (Limit 100k — Uses 5.7%).
- **D1 Writes:** The Worker already throttles D1 heartbeat writes to 60s, so D1 writes remain at 1,440 per day. (Limit 100k).
- **D1 Reads:** 5,760 per day. (Limit 5 Million — Uses 0.1%).
- **Free-tier compatibility:** YES.
- **Estimated latency:** Up to 15 seconds.
- **Reliability:** Extremely high. Stateless HTTP handles NAT, offline states, and disconnects flawlessly.
- **Implementation Complexity:** **Zero.** The simplest possible architecture.

---

## Recommendation

Both **Option 1 (DO WebSockets)** and **Option 4 (15s polling)** are highly production-safe and well within Cloudflare's Free Tier limits.

**Recommendation: Stick with 15-second polling (Option 4).**
Although 5,760 requests/day sounds higher than 1,440, it only consumes **~5% of your daily Free Tier quota**. 15 seconds is generally fast enough for walk-in retail printing, and it maintains absolute architectural simplicity without introducing Durable Objects, WebSockets, or RPC error handling.

If strict sub-second wake-up is absolutely critical for your shop's customer experience, **Option 1 (DO WebSockets)** is viable and safe to implement on the Free Tier, provided you accept the medium implementation complexity.

Please let me know which of the two viable paths you'd prefer to take!
