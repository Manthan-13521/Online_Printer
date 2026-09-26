import type { AgentReportPrintStepRequest } from "@printgo/api-contract";

import type { WorkerEnv } from "../env";
import { error, ok } from "../http";
import { R2UploadSigner } from "../storage/r2-upload-signer";
import { D1PrintingRepository } from "./repository";
import { PrintingError, PrintingService } from "./service";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const MAX_JSON_BYTES = 8 * 1024;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function createPrintingService(env: WorkerEnv): PrintingService {
  return new PrintingService(
    new D1PrintingRepository(env.DB),
    new R2UploadSigner({
      accountId: env.R2_ACCOUNT_ID,
      bucketName: env.R2_BUCKET_NAME,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    }),
  );
}

function bearer(request: Request): string | null {
  return (
    /^Bearer ([A-Za-z0-9_-]{30,80})$/u.exec(
      request.headers.get("Authorization") ?? "",
    )?.[1] ?? null
  );
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES)
    throw new SyntaxError();
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SyntaxError();
  return value as Record<string, unknown>;
}

function shortText(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, maximum)
    : null;
}

export async function handleAgentPrintingRequest(
  request: Request,
  env: WorkerEnv,
  service: PrintingService = createPrintingService(env),
): Promise<Response> {
  const token = bearer(request);
  if (!token)
    return error(
      401,
      "AGENT_UNAUTHORIZED",
      "Agent authentication required.",
      NO_STORE,
    );
  const match =
    /^\/api\/agent\/print-jobs\/([^/]+)\/steps\/([^/]+)\/(start|submitted|result)$/u.exec(
      new URL(request.url).pathname,
    );
  if (request.method !== "POST" || !match)
    return error(404, "NOT_FOUND", "Endpoint not found.", NO_STORE);
  const orderId = decodeURIComponent(match[1] ?? "");
  const stepId = decodeURIComponent(match[2] ?? "");
  if (!UUID.test(orderId) || !UUID.test(stepId))
    return error(
      400,
      "VALIDATION_ERROR",
      "Invalid print job identifier.",
      NO_STORE,
    );
  try {
    const input = await body(request);
    const claimId = shortText(input.claimId, 100);
    if (!claimId)
      return error(
        400,
        "VALIDATION_ERROR",
        "Claim credential is required.",
        NO_STORE,
      );
    if (match[3] === "start")
      return ok(
        await service.startStep(token, orderId, stepId, claimId),
        200,
        NO_STORE,
      );
    if (match[3] === "submitted") {
      const spoolerJobId = shortText(input.spoolerJobId, 100);
      if (!spoolerJobId)
        return error(
          400,
          "VALIDATION_ERROR",
          "Spooler job ID is required.",
          NO_STORE,
        );
      return ok(
        await service.recordSubmission(
          token,
          orderId,
          stepId,
          claimId,
          spoolerJobId,
        ),
        200,
        NO_STORE,
      );
    }
    if (
      !["BLOCKED", "SUCCEEDED", "FAILED", "UNCERTAIN"].includes(
        String(input.status),
      )
    ) {
      return error(
        400,
        "VALIDATION_ERROR",
        "Invalid print result status.",
        NO_STORE,
      );
    }
    const report: AgentReportPrintStepRequest = {
      claimId,
      status: input.status as AgentReportPrintStepRequest["status"],
      spoolerJobId: shortText(input.spoolerJobId, 100),
      failureCode: [
        "PAPER_OUT",
        "PAPER_JAM",
        "OFFLINE",
        "NO_TONER",
        "TONER_LOW",
        "DOOR_OPEN",
        "USER_INTERVENTION",
        "PRINTER_ERROR",
        "UNKNOWN",
      ].includes(String(input.failureCode))
        ? String(input.failureCode)
        : input.failureCode == null
          ? null
          : "UNKNOWN",
      failureDetail: shortText(input.failureDetail, 500),
    };
    return ok(
      await service.recordResult(token, orderId, stepId, report),
      200,
      NO_STORE,
    );
  } catch (caught) {
    if (caught instanceof PrintingError) {
      if (caught.code === "AGENT_UNAUTHORIZED")
        return error(
          401,
          caught.code,
          "Agent authentication failed.",
          NO_STORE,
        );
      return error(
        caught.code === "PRINT_STEP_NOT_FOUND" ? 404 : 409,
        caught.code,
        "Print step could not be changed safely.",
        NO_STORE,
      );
    }
    if (caught instanceof SyntaxError)
      return error(
        400,
        "INVALID_JSON",
        "Malformed JSON request body.",
        NO_STORE,
      );
    return error(
      500,
      "PRINT_REQUEST_FAILED",
      "Print request could not be completed.",
      NO_STORE,
    );
  }
}
