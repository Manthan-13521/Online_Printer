import type { WorkerEnv } from "../env";

export async function wakeAgent(env: WorkerEnv): Promise<void> {
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
