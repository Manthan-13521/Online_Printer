import { describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/unbound-method -- Vitest inspects method mocks without invoking them. */

import type { WorkerEnv } from "../env";
import type { AdminAuthActions } from "./routes";
import { handleAdminAuthRequest } from "./routes";

const admin = {
  id: "10000000-0000-4000-8000-000000000001",
  loginIdentifier: "admin",
};
const required = {
  sessionId: "session-id",
  admin,
  tokenHash: "token-hash",
};

function service(): AdminAuthActions {
  return {
    login: vi.fn().mockResolvedValue({
      admin,
      rawToken: "new-raw-token",
      expiresAtMs: Date.now() + 60_000,
    }),
    requireSession: vi.fn().mockResolvedValue(required),
    logout: vi.fn().mockResolvedValue(undefined),
    revokeAllSessions: vi.fn().mockResolvedValue(undefined),
    changePassword: vi.fn().mockResolvedValue({
      admin,
      rawToken: "rotated-token",
      expiresAtMs: Date.now() + 60_000,
    }),
  };
}

const env = {
  APP_ENV: "production",
  ADMIN_ALLOWED_ORIGIN: "https://admin.example.test",
} as WorkerEnv;

function post(
  path: string,
  origin = env.ADMIN_ALLOWED_ORIGIN,
  body = {},
): Request {
  return new Request(`https://api.example.test${path}`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      cookie: "__Host-printgo_admin=raw-token",
    },
    body: JSON.stringify(body),
  });
}

describe("admin auth routes", () => {
  it("logs in with a secure cookie and safe profile", async () => {
    const actions = service();
    const response = await handleAdminAuthRequest(
      post("/api/admin/auth/login", undefined, {
        loginIdentifier: " ADMIN ",
        password: "correct password",
      }),
      env,
      actions,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(
      "__Host-printgo_admin=new-raw-token",
    );
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(await response.json()).toEqual({ ok: true, data: { admin } });
    expect(actions.login).toHaveBeenCalledWith("admin", "correct password");
  });

  it("restores an authenticated profile through me", async () => {
    const actions = service();
    const response = await handleAdminAuthRequest(
      new Request("https://api.example.test/api/admin/auth/me", {
        headers: {
          origin: env.ADMIN_ALLOWED_ORIGIN,
          cookie: "__Host-printgo_admin=raw-token",
        },
      }),
      env,
      actions,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { admin } });
  });

  it.each(["/api/admin/auth/logout", "/api/admin/auth/change-password"])(
    "rejects an untrusted origin for %s",
    async (path) => {
      const actions = service();
      const response = await handleAdminAuthRequest(
        post(path, "https://evil.example"),
        env,
        actions,
      );
      expect(response.status).toBe(403);
      expect(actions.logout).not.toHaveBeenCalled();
      expect(actions.changePassword).not.toHaveBeenCalled();
    },
  );

  it("allows trusted logout and clears the cookie idempotently", async () => {
    const actions = service();
    const response = await handleAdminAuthRequest(
      post("/api/admin/auth/logout"),
      env,
      actions,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(actions.logout).toHaveBeenCalledWith("raw-token");
  });
});
