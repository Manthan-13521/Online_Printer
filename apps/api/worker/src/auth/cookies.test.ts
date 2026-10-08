import { describe, expect, it } from "vitest";

import {
  adminCookieName,
  clearAdminCookie,
  createAdminCookie,
  readAdminCookie,
} from "./cookies";

describe("admin session cookies", () => {
  it("uses a compliant hardened production cookie with Partitioned and SameSite=None", () => {
    const cookie = createAdminCookie("raw-token", 50_000, 1_000, true);
    expect(adminCookieName(true)).toBe("__Host-printgo_admin");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Partitioned");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain=");
  });

  it("uses a non-Secure development cookie and clears it consistently", () => {
    const devCookie = createAdminCookie("token", 50_000, 1_000, false);
    expect(devCookie).not.toContain("Secure");
    expect(devCookie).toContain("SameSite=Lax");
    expect(clearAdminCookie(false)).toContain("Max-Age=0");
    const request = new Request("http://localhost", {
      headers: { cookie: "other=x; printgo_admin_dev=the-token" },
    });
    expect(readAdminCookie(request, false)).toBe("the-token");
  });

  it("extracts token from Authorization Bearer header with priority over cookies", () => {
    const requestWithBearer = new Request("https://admin.example.test", {
      headers: {
        authorization: "Bearer bearer-token-123",
        cookie: "__Host-printgo_admin=cookie-token-456",
      },
    });
    expect(readAdminCookie(requestWithBearer, true)).toBe("bearer-token-123");

    const requestBearerOnly = new Request("https://admin.example.test", {
      headers: {
        authorization: "Bearer bearer-only-789",
      },
    });
    expect(readAdminCookie(requestBearerOnly, true)).toBe("bearer-only-789");
  });
});
