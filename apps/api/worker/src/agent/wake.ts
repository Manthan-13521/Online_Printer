import type { WorkerEnv } from "../env";

export function wakeAgent(env: WorkerEnv): void {
  try {
    const id = env.AGENT_ROOM.idFromName("shop");
    const room = env.AGENT_ROOM.get(id);
    const req = new Request("http://do/wake", { method: "POST" });
    // Fire and forget without blocking
    void room.fetch(req).catch(() => {
      // Ignored
    });
  } catch {
    // Ignored
  }
}

export function probeAgentPrinter(env: WorkerEnv, printerId: string): void {
  try {
    const id = env.AGENT_ROOM.idFromName("shop");
    const room = env.AGENT_ROOM.get(id);
    const req = new Request("http://do/probe", {
      method: "POST",
      body: JSON.stringify({ printerId }),
      headers: { "Content-Type": "application/json" },
    });
    void room.fetch(req).catch(() => {
      // Ignored
    });
  } catch {
    // Ignored
  }
}

export function notifyAdmin(
  env: WorkerEnv,
  payload?: Record<string, unknown>,
): void {
  try {
    const id = env.AGENT_ROOM.idFromName("shop");
    const room = env.AGENT_ROOM.get(id);
    const req = new Request("http://do/notify-admin", {
      method: "POST",
      body: JSON.stringify(payload ?? { type: "ADMIN_ORDER_UPDATE" }),
      headers: { "Content-Type": "application/json" },
    });
    // Fire and forget without blocking
    void room.fetch(req).catch(() => {
      // Ignored
    });
  } catch {
    // Ignored
  }
}
