import {
  validateAgentHeartbeatInput,
  validateAgentPairInput,
  validateReportCommandInput,
} from "@printgo/validation";

import type { WorkerEnv } from "../env";
import { error, ok } from "../http";
import { D1AgentRepository } from "./repository";
import { AgentError, AgentService } from "./service";
import { createPrintingService } from "../printing/routes";

const MAX_JSON_BYTES = 32 * 1024;
const NO_STORE = { "Cache-Control": "no-store" } as const;

function bearerToken(request: Request): string | null {
  const match = /^Bearer ([A-Za-z0-9_-]{30,80})$/u.exec(
    request.headers.get("Authorization") ?? "",
  );
  return match?.[1] ?? null;
}

async function readJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("Content-Length") ?? 0);
  if (length > MAX_JSON_BYTES) throw new SyntaxError("Body too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) {
    throw new SyntaxError("Body too large");
  }
  return text.length === 0 ? {} : JSON.parse(text);
}

function mapAgentError(caught: unknown): Response {
  if (caught instanceof AgentError) {
    if (caught.code === "AGENT_UNAUTHORIZED") {
      return error(
        401,
        "AGENT_UNAUTHORIZED",
        "Agent authentication failed. The agent may have been revoked.",
        NO_STORE,
      );
    }
    if (
      caught.code === "PAIR_CODE_INVALID" ||
      caught.code === "PAIR_CODE_EXPIRED" ||
      caught.code === "PAIR_CODE_ALREADY_USED"
    ) {
      return error(
        400,
        caught.code,
        "The pairing code is invalid, expired, or has already been used.",
        NO_STORE,
      );
    }
    if (
      caught.code === "AGENT_NOT_FOUND" ||
      caught.code === "PRINTER_NOT_FOUND" ||
      caught.code === "COMMAND_NOT_FOUND"
    ) {
      return error(404, caught.code, "Requested resource not found.", NO_STORE);
    }
  }
  if (caught instanceof SyntaxError) {
    return error(400, "INVALID_JSON", "Malformed JSON request body.", NO_STORE);
  }
  return error(
    500,
    "AGENT_REQUEST_FAILED",
    "Agent request could not be completed.",
    NO_STORE,
  );
}

export async function handleAgentRequest(
  request: Request,
  env: WorkerEnv,
  service: AgentService = new AgentService(
    new D1AgentRepository(env.DB),
    Date.now,
    createPrintingService(env),
  ),
): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (request.method === "POST" && pathname === "/api/agent/pair") {
    try {
      const rawBody = await readJson(request);
      const validation = validateAgentPairInput(rawBody);
      if (!validation.ok) {
        return error(
          400,
          "VALIDATION_ERROR",
          validation.issues[0]?.message ?? "Invalid pair request.",
          NO_STORE,
        );
      }
      const result = await service.pair(validation.value);
      return ok(result, 201, NO_STORE);
    } catch (caught) {
      return mapAgentError(caught);
    }
  }

  if (request.method === "GET" && pathname === "/api/agent/ws") {
    const token = request.headers.get("Sec-WebSocket-Protocol"); // Client sends token as subprotocol
    if (!token) {
      return error(401, "AGENT_UNAUTHORIZED", "Agent token required", NO_STORE);
    }
    try {
      // Very lightweight auth verify before accepting connection
      await service.verifyTokenOnly(token);
    } catch {
      return error(401, "AGENT_UNAUTHORIZED", "Invalid token", NO_STORE);
    }
    const id = env.AGENT_ROOM.idFromName("shop");
    const room = env.AGENT_ROOM.get(id);
    const newReq = new Request("http://do/connect", request);
    return room.fetch(newReq);
  }

  if (
    request.method === "POST" &&
    (pathname === "/api/agent/heartbeat" || pathname === "/api/agent/pulse")
  ) {
    const token = bearerToken(request);
    if (!token) {
      return error(
        401,
        "AGENT_UNAUTHORIZED",
        "Agent authentication token required.",
        NO_STORE,
      );
    }
    try {
      const rawBody = await readJson(request);
      const reportPrinters = pathname === "/api/agent/heartbeat";
      const validation = validateAgentHeartbeatInput(
        !reportPrinters && typeof rawBody === "object" && rawBody !== null
          ? { ...rawBody, printers: [] }
          : rawBody,
      );
      if (!validation.ok) {
        return error(
          400,
          "VALIDATION_ERROR",
          validation.issues[0]?.message ?? "Invalid heartbeat payload.",
          NO_STORE,
        );
      }
      const result = await service.heartbeat(
        token,
        validation.value,
        reportPrinters,
      );
      return ok(result, 200, NO_STORE);
    } catch (caught) {
      return mapAgentError(caught);
    }
  }

  const reportMatch = /^\/api\/agent\/commands\/([^/]+)\/report$/u.exec(
    pathname,
  );
  if (request.method === "POST" && reportMatch) {
    const token = bearerToken(request);
    if (!token) {
      return error(
        401,
        "AGENT_UNAUTHORIZED",
        "Agent authentication token required.",
        NO_STORE,
      );
    }
    try {
      const commandId = decodeURIComponent(reportMatch[1] ?? "");
      const rawBody = await readJson(request);
      const validation = validateReportCommandInput(rawBody);
      if (!validation.ok) {
        return error(
          400,
          "VALIDATION_ERROR",
          validation.issues[0]?.message ?? "Invalid command report payload.",
          NO_STORE,
        );
      }
      const result = await service.reportCommand(
        token,
        commandId,
        validation.value,
      );
      return ok(result, 200, NO_STORE);
    } catch (caught) {
      return mapAgentError(caught);
    }
  }

  return error(404, "NOT_FOUND", "Endpoint not found.", NO_STORE);
}
