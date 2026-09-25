import { hashPassword, hashSessionToken, verifyPassword } from "@printgo/auth";
import { beforeEach, describe, expect, it } from "vitest";

import type {
  AdminAuthRepository,
  AdminRecord,
  AuditRecord,
  NewSessionRecord,
  SessionRecord,
} from "./repository";
import { AdminAuthService, AuthError } from "./service";

const NOW = 2_000_000_000_000;

class MemoryRepository implements AdminAuthRepository {
  admin: AdminRecord | null = null;
  sessions = new Map<
    string,
    NewSessionRecord & { revokedAtMs: number | null }
  >();
  audits: AuditRecord[] = [];

  findAdminByLogin(loginIdentifier: string): Promise<AdminRecord | null> {
    return Promise.resolve(
      this.admin?.loginIdentifier === loginIdentifier ? this.admin : null,
    );
  }

  findSession(tokenHash: string): Promise<SessionRecord | null> {
    const session = this.sessions.get(tokenHash);
    if (!session || !this.admin) return Promise.resolve(null);
    return Promise.resolve({
      id: session.id,
      adminId: session.adminId,
      loginIdentifier: this.admin.loginIdentifier,
      isAdminActive: this.admin.isActive,
      expiresAtMs: session.expiresAtMs,
      revokedAtMs: session.revokedAtMs,
    });
  }

  createSession(session: NewSessionRecord, audit: AuditRecord): Promise<void> {
    this.sessions.set(session.tokenHash, { ...session, revokedAtMs: null });
    this.audits.push(audit);
    return Promise.resolve();
  }

  revokeSession(
    tokenHash: string,
    revokedAtMs: number,
    audit: AuditRecord,
  ): Promise<void> {
    const session = this.sessions.get(tokenHash);
    if (session) session.revokedAtMs = revokedAtMs;
    this.audits.push(audit);
    return Promise.resolve();
  }

  revokeAllSessions(
    adminId: string,
    revokedAtMs: number,
    audit: AuditRecord,
  ): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.adminId === adminId && session.revokedAtMs === null)
        session.revokedAtMs = revokedAtMs;
    }
    this.audits.push(audit);
    return Promise.resolve();
  }

  changePasswordAndRotateSession(input: {
    adminId: string;
    passwordHash: string;
    changedAtMs: number;
    session: NewSessionRecord;
    audit: AuditRecord;
  }): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.adminId === input.adminId && session.revokedAtMs === null) {
        session.revokedAtMs = input.changedAtMs;
      }
    }
    this.audits.push(input.audit);
    if (this.admin) this.admin.passwordHash = input.passwordHash;
    this.sessions.set(input.session.tokenHash, {
      ...input.session,
      revokedAtMs: null,
    });
    return Promise.resolve();
  }
}

describe("AdminAuthService", () => {
  let repository: MemoryRepository;
  let service: AdminAuthService;

  beforeEach(async () => {
    repository = new MemoryRepository();
    repository.admin = {
      id: "10000000-0000-4000-8000-000000000001",
      loginIdentifier: "admin",
      passwordHash: await hashPassword("correct password"),
      isActive: true,
    };
    service = new AdminAuthService(repository, () => NOW);
  });

  it("logs in, persists only the token hash, and accepts the session", async () => {
    const issued = await service.login("admin", "correct password");
    const stored = [...repository.sessions.values()][0];
    expect(stored?.tokenHash).not.toBe(issued.rawToken);
    expect(stored?.tokenHash).toBe(await hashSessionToken(issued.rawToken));
    await expect(
      service.requireSession(issued.rawToken),
    ).resolves.toMatchObject({
      admin: { loginIdentifier: "admin" },
    });
    expect(repository.audits[0]?.action).toBe("ADMIN_LOGIN_SUCCESS");
  });

  it.each([
    ["missing", "correct password"],
    ["admin", "wrong password"],
  ])(
    "uses the same failure for unknown and wrong credentials",
    async (login, password) => {
      await expect(service.login(login, password)).rejects.toMatchObject({
        code: "AUTH_INVALID_CREDENTIALS",
      });
    },
  );

  it("denies an inactive admin at login and during an existing session", async () => {
    const issued = await service.login("admin", "correct password");
    if (repository.admin) repository.admin.isActive = false;
    await expect(
      service.login("admin", "correct password"),
    ).rejects.toBeInstanceOf(AuthError);
    await expect(service.requireSession(issued.rawToken)).rejects.toMatchObject(
      { code: "AUTH_SESSION_EXPIRED" },
    );
  });

  it("rejects missing, random, expired, and revoked sessions", async () => {
    await expect(service.requireSession(null)).rejects.toMatchObject({
      code: "AUTH_SESSION_REQUIRED",
    });
    await expect(service.requireSession("random-token")).rejects.toMatchObject({
      code: "AUTH_SESSION_EXPIRED",
    });
    const issued = await service.login("admin", "correct password");
    const stored = [...repository.sessions.values()][0];
    if (stored) stored.expiresAtMs = NOW;
    await expect(service.requireSession(issued.rawToken)).rejects.toMatchObject(
      { code: "AUTH_SESSION_EXPIRED" },
    );
    if (stored) {
      stored.expiresAtMs = NOW + 1;
      stored.revokedAtMs = NOW;
    }
    await expect(service.requireSession(issued.rawToken)).rejects.toMatchObject(
      { code: "AUTH_SESSION_EXPIRED" },
    );
  });

  it("logs out idempotently and invalidates the session", async () => {
    const issued = await service.login("admin", "correct password");
    await service.logout(issued.rawToken);
    await service.logout(issued.rawToken);
    await expect(service.requireSession(issued.rawToken)).rejects.toMatchObject(
      { code: "AUTH_SESSION_EXPIRED" },
    );
  });

  it("revokes all active sessions for the admin", async () => {
    const first = await service.login("admin", "correct password");
    const second = await service.login("admin", "correct password");
    const required = await service.requireSession(first.rawToken);
    await service.revokeAllSessions(required);
    await expect(service.requireSession(first.rawToken)).rejects.toMatchObject({
      code: "AUTH_SESSION_EXPIRED",
    });
    await expect(service.requireSession(second.rawToken)).rejects.toMatchObject(
      {
        code: "AUTH_SESSION_EXPIRED",
      },
    );
    expect(repository.audits.at(-1)?.action).toBe("ADMIN_SESSIONS_REVOKED");
  });

  it("changes the password, revokes old sessions, and issues a fresh session", async () => {
    const old = await service.login("admin", "correct password");
    const required = await service.requireSession(old.rawToken);
    const fresh = await service.changePassword(
      required,
      "correct password",
      "new secure password",
    );
    await expect(service.requireSession(old.rawToken)).rejects.toMatchObject({
      code: "AUTH_SESSION_EXPIRED",
    });
    await expect(service.requireSession(fresh.rawToken)).resolves.toMatchObject(
      { admin: { id: repository.admin?.id } },
    );
    await expect(
      verifyPassword("correct password", repository.admin?.passwordHash ?? ""),
    ).resolves.toBe(false);
    await expect(
      verifyPassword(
        "new secure password",
        repository.admin?.passwordHash ?? "",
      ),
    ).resolves.toBe(true);
  });

  it("rejects an incorrect current password without changing the hash", async () => {
    const issued = await service.login("admin", "correct password");
    const required = await service.requireSession(issued.rawToken);
    const originalHash = repository.admin?.passwordHash;
    await expect(
      service.changePassword(
        required,
        "incorrect password",
        "new secure password",
      ),
    ).rejects.toMatchObject({ code: "AUTH_CURRENT_PASSWORD_INVALID" });
    expect(repository.admin?.passwordHash).toBe(originalHash);
  });
});
