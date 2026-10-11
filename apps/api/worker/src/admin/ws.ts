import type { WorkerEnv } from "../env";
import { error } from "../http";
import { readAdminCookie } from "../auth/cookies";
import { D1AdminAuthRepository } from "../auth/repository";
import { AdminAuthService } from "../auth/service";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function handleAdminWebSocket(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  const isProduction = env.APP_ENV === "production";
  const url = new URL(request.url);
  const rawCookie = readAdminCookie(request, isProduction);
  const authHeader = request.headers.get("Authorization");
  const bearerMatch = /^Bearer (.+)$/iu.exec(authHeader ?? "");
  const bearerToken = bearerMatch ? bearerMatch[1] : null;
  const subprotocol = request.headers.get("Sec-WebSocket-Protocol");
  const queryToken = url.searchParams.get("token");
  const token = bearerToken || rawCookie || subprotocol || queryToken;

  if (!token) {
    return error(
      401,
      "ADMIN_UNAUTHORIZED",
      "Admin session required.",
      NO_STORE,
    );
  }

  const sessions = new AdminAuthService(new D1AdminAuthRepository(env.DB));
  try {
    await sessions.requireSession(token);
  } catch {
    return error(401, "ADMIN_UNAUTHORIZED", "Invalid admin session.", NO_STORE);
  }

  const id = env.AGENT_ROOM.idFromName("shop");
  const room = env.AGENT_ROOM.get(id);
  const newReq = new Request("http://do/connect", request);
  return room.fetch(newReq);
}
