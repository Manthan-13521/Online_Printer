import { describe, expect, it } from "vitest";

import {
  adminCookieName,
  clearAdminCookie,
  createAdminCookie,
  readAdminCookie,
} from "./cookies";

describe("admin session cookies", () => {
  it("uses a compliant hardened production cookie", () => {
    const cookie = createAdminCookie("raw-token", 50_000, 1_000, true);
    expect(adminCookieName(true)).toBe("__Host-printgo_admin");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain=");
  });

  it("uses a non-Secure development cookie and clears it consistently", () => {
    expect(createAdminCookie("token", 50_000, 1_000, false)).not.toContain(
      "Secure",
    );
    expect(clearAdminCookie(false)).toContain("Max-Age=0");
    const request = new Request("http://localhost", {
      headers: { cookie: "other=x; printgo_admin_dev=the-token" },
    });
    expect(readAdminCookie(request, false)).toBe("the-token");
  });
});
