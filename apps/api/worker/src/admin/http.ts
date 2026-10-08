import { error } from "../http";

export function adminCorsHeaders(origin: string): Record<string, string> {
  return {
    "access-control-allow-credentials": "true",
    "access-control-allow-origin": origin,
    vary: "Origin",
  };
}

export function isAllowedAdminOrigin(
  origin: string,
  configuredOrigin: string,
): boolean {
  if (origin === configuredOrigin) return true;
  try {
    const parsed = new URL(origin);
    const parsedConfigured = new URL(configuredOrigin);
    if (parsed.origin === parsedConfigured.origin) return true;

    if (
      parsed.protocol === "https:" &&
      (parsed.hostname === "printgo-admin.pages.dev" ||
        parsed.hostname.endsWith(".printgo-admin.pages.dev"))
    ) {
      return true;
    }

    if (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
    ) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function resolveAdminCorsOrigin(
  requestOrOrigin: Request | string | null | undefined,
  configuredOrigin: string,
): string {
  const origin =
    typeof requestOrOrigin === "string"
      ? requestOrOrigin
      : requestOrOrigin instanceof Request
        ? requestOrOrigin.headers.get("origin")
        : null;

  if (origin && isAllowedAdminOrigin(origin, configuredOrigin)) {
    return origin;
  }
  return configuredOrigin;
}

export function withAdminCors(
  response: Response,
  origin: string,
  request?: Request,
): Response {
  const effectiveOrigin = request
    ? resolveAdminCorsOrigin(request.headers.get("origin"), origin)
    : origin;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(
    adminCorsHeaders(effectiveOrigin),
  )) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function guardAdminOrigin(
  request: Request,
  allowedOrigin: string,
): Response | null {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") {
    if (!origin || !isAllowedAdminOrigin(origin, allowedOrigin)) {
      return error(403, "ORIGIN_NOT_ALLOWED", "This request is not allowed.");
    }
    return new Response(null, {
      status: 204,
      headers: {
        ...adminCorsHeaders(origin),
        "access-control-allow-headers": "Content-Type, Authorization",
        "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
        "access-control-max-age": "600",
      },
    });
  }
  if (origin && !isAllowedAdminOrigin(origin, allowedOrigin)) {
    return error(403, "ORIGIN_NOT_ALLOWED", "This request is not allowed.");
  }
  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(request.method) &&
    (!origin || !isAllowedAdminOrigin(origin, allowedOrigin))
  ) {
    return error(403, "ORIGIN_REQUIRED", "This request is not allowed.");
  }
  return null;
}

export async function readAdminJson(
  request: Request,
  maximumBytes: number,
): Promise<unknown> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    throw new AdminRequestError("UNSUPPORTED_CONTENT_TYPE");
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new AdminRequestError("REQUEST_TOO_LARGE");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    throw new AdminRequestError("REQUEST_TOO_LARGE");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AdminRequestError("INVALID_JSON");
  }
}

export type AdminRequestErrorCode =
  "UNSUPPORTED_CONTENT_TYPE" | "REQUEST_TOO_LARGE" | "INVALID_JSON";

export class AdminRequestError extends Error {
  constructor(readonly code: AdminRequestErrorCode) {
    super(code);
    this.name = "AdminRequestError";
  }
}

export function adminRequestErrorResponse(caught: unknown): Response | null {
  if (!(caught instanceof AdminRequestError)) return null;
  if (caught.code === "UNSUPPORTED_CONTENT_TYPE") {
    return error(415, caught.code, "Send a JSON request.");
  }
  if (caught.code === "REQUEST_TOO_LARGE") {
    return error(413, caught.code, "The request is too large.");
  }
  return error(400, "VALIDATION_ERROR", "The request could not be read.");
}
