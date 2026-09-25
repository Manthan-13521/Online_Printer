import { error, ok } from "./http";

export function routeRequest(request: Request): Response {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return ok({ service: "printgo-api", status: "available" });
  }

  return error(404, "NOT_FOUND", "The requested resource was not found.");
}
