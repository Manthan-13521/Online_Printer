import {
  apiFailure,
  apiSuccess,
  type ApiResponse,
} from "@printgo/api-contract";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
} as const;

export function jsonResponse<T>(
  body: ApiResponse<T>,
  status = 200,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

export function ok<T>(data: T, status = 200, headers?: HeadersInit): Response {
  return jsonResponse(apiSuccess(data), status, headers);
}

export function error(
  status: number,
  code: string,
  message: string,
  headers?: HeadersInit,
): Response {
  return jsonResponse(apiFailure(code, message), status, headers);
}
