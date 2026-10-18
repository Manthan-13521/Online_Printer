import type { WorkerEnv } from "../env";

export async function wakeAgent(env: WorkerEnv): Promise<void> {
  if (!env.AGENT_ROOM) return;
  try {
    const id = env.AGENT_ROOM.idFromName("shop");
    const room = env.AGENT_ROOM.get(id);
    const req = new Request("http://do/wake", { method: "POST" });
    const res = await room.fetch(req);
    if (!res.ok) {
      console.warn(`[WAKE] AgentRoom /wake returned HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn("[WAKE] Failed to wake agent via Durable Object:", err);
  }
}

export async function probeAgentPrinter(
  env: WorkerEnv,
  printerId: string,
): Promise<void> {
  if (!env.AGENT_ROOM) return;
  try {
    const id = env.AGENT_ROOM.idFromName("shop");
    const room = env.AGENT_ROOM.get(id);
    const req = new Request("http://do/probe", {
      method: "POST",
      body: JSON.stringify({ printerId }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await room.fetch(req);
    if (!res.ok) {
      console.warn(`[PROBE] AgentRoom /probe returned HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn(
      "[PROBE] Failed to probe agent printer via Durable Object:",
      err,
    );
  }
}

export async function notifyAdmin(
  env: WorkerEnv,
  payload?: Record<string, unknown>,
): Promise<void> {
  if (!env.AGENT_ROOM) return;
  try {
    const id = env.AGENT_ROOM.idFromName("shop");
    const room = env.AGENT_ROOM.get(id);
    const req = new Request("http://do/notify-admin", {
      method: "POST",
      body: JSON.stringify(payload ?? { type: "ADMIN_ORDER_UPDATE" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await room.fetch(req);
    if (!res.ok) {
      console.warn(
        `[NOTIFY_ADMIN] AgentRoom /notify-admin returned HTTP ${res.status}`,
      );
    }
  } catch (err) {
    console.warn(
      "[NOTIFY_ADMIN] Failed to notify admin via Durable Object:",
      err,
    );
  }
}
