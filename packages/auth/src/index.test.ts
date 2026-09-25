import { describe, expect, it } from "vitest";

import {
  ADMIN_SESSION_TOKEN_BYTES,
  createSessionToken,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from "./index";

describe("password hashing", () => {
  it("verifies the correct password and rejects the wrong one", async () => {
    const hash = await hashPassword("a correct horse battery");
    await expect(verifyPassword("a correct horse battery", hash)).resolves.toBe(
      true,
    );
    await expect(verifyPassword("not the password", hash)).resolves.toBe(false);
  });

  it("uses a unique salt and never embeds the password", async () => {
    const password = "the same long password";
    const first = await hashPassword(password);
    const second = await hashPassword(password);
    expect(first).not.toBe(second);
    expect(first).not.toContain(password);
  });

  it.each(["", "garbage", "pbkdf2-sha256$v=1$i=1$bad$bad"])(
    "fails safely for malformed hash %j",
    async (storedHash) => {
      await expect(verifyPassword("some password", storedHash)).resolves.toBe(
        false,
      );
    },
  );
});

describe("session tokens", () => {
  it("creates a high-entropy raw token and a distinct deterministic hash", async () => {
    const session = await createSessionToken();
    expect(session.rawToken).toHaveLength(
      Math.ceil((ADMIN_SESSION_TOKEN_BYTES * 8) / 6),
    );
    expect(session.tokenHash).not.toBe(session.rawToken);
    await expect(hashSessionToken(session.rawToken)).resolves.toBe(
      session.tokenHash,
    );
  });
});
