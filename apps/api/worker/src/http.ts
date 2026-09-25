import {
  apiFailure,
  apiSuccess,
  type ApiResponse,
} from "@printgo/api-contract";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
} as const;

export function jsonResponse<T>(body: ApiResponse<T>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

export function ok<T>(data: T, status = 200): Response {
  return jsonResponse(apiSuccess(data), status);
}

export function error(status: number, code: string, message: string): Response {
  return jsonResponse(apiFailure(code, message), status);
}
