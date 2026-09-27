import type { AdminProfile } from "@printgo/api-contract";
import {
  ADMIN_SESSION_LIFETIME_MS,
  createSessionToken,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from "@printgo/auth";

import type {
  AdminAuthRepository,
  AdminRecord,
  AuditRecord,
  NewSessionRecord,
} from "./repository";

const DUMMY_PASSWORD_HASH =
  "pbkdf2-sha256$v=1$i=100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export type AuthErrorCode =
  | "AUTH_INVALID_CREDENTIALS"
  | "AUTH_SESSION_REQUIRED"
  | "AUTH_SESSION_EXPIRED"
  | "AUTH_CURRENT_PASSWORD_INVALID";

export class AuthError extends Error {
  constructor(readonly code: AuthErrorCode) {
    super(code);
    this.name = "AuthError";
  }
}

export interface IssuedSession {
  admin: AdminProfile;
  rawToken: string;
  expiresAtMs: number;
}

export interface RequiredSession {
  sessionId: string;
  admin: AdminProfile;
  tokenHash: string;
}

function profile(
  admin: Pick<AdminRecord, "id" | "loginIdentifier">,
): AdminProfile {
  return { id: admin.id, loginIdentifier: admin.loginIdentifier };
}

function audit(
  adminId: string,
  action: string,
  entityId: string,
  now: number,
): AuditRecord {
  return {
    id: crypto.randomUUID(),
    actorId: adminId,
    action,
    entityId,
    createdAtMs: now,
  };
}

export class AdminAuthService {
  constructor(
    private readonly repository: AdminAuthRepository,
    private readonly now: () => number = Date.now,
  ) {}

  private async newSession(
    adminId: string,
    now: number,
  ): Promise<{ rawToken: string; row: NewSessionRecord }> {
    const token = await createSessionToken();
    return {
      rawToken: token.rawToken,
      row: {
        id: crypto.randomUUID(),
        adminId,
        tokenHash: token.tokenHash,
        createdAtMs: now,
        expiresAtMs: now + ADMIN_SESSION_LIFETIME_MS,
      },
    };
  }

  async login(
    loginIdentifier: string,
    password: string,
  ): Promise<IssuedSession> {
    const admin = await this.repository.findAdminByLogin(loginIdentifier);
    const passwordMatches = await verifyPassword(
      password,
      admin?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );
    if (!admin || !admin.isActive || !passwordMatches) {
      throw new AuthError("AUTH_INVALID_CREDENTIALS");
    }
    const now = this.now();
    const session = await this.newSession(admin.id, now);
    await this.repository.createSession(
      session.row,
      audit(admin.id, "ADMIN_LOGIN_SUCCESS", session.row.id, now),
    );
    return {
      admin: profile(admin),
      rawToken: session.rawToken,
      expiresAtMs: session.row.expiresAtMs,
    };
  }

  async requireSession(rawToken: string | null): Promise<RequiredSession> {
    if (!rawToken) throw new AuthError("AUTH_SESSION_REQUIRED");
    const tokenHash = await hashSessionToken(rawToken);
    const session = await this.repository.findSession(tokenHash);
    const now = this.now();
    if (
      !session ||
      session.revokedAtMs !== null ||
      session.expiresAtMs <= now ||
      !session.isAdminActive
    ) {
      throw new AuthError("AUTH_SESSION_EXPIRED");
    }
    return {
      sessionId: session.id,
      admin: { id: session.adminId, loginIdentifier: session.loginIdentifier },
      tokenHash,
    };
  }

  async logout(rawToken: string | null): Promise<void> {
    if (!rawToken) return;
    const tokenHash = await hashSessionToken(rawToken);
    const session = await this.repository.findSession(tokenHash);
    if (!session || session.revokedAtMs !== null) return;
    const now = this.now();
    await this.repository.revokeSession(
      tokenHash,
      now,
      audit(session.adminId, "ADMIN_LOGOUT", session.id, now),
    );
  }

  async revokeAllSessions(required: RequiredSession): Promise<void> {
    const now = this.now();
    await this.repository.revokeAllSessions(
      required.admin.id,
      now,
      audit(
        required.admin.id,
        "ADMIN_SESSIONS_REVOKED",
        required.admin.id,
        now,
      ),
    );
  }

  async changePassword(
    required: RequiredSession,
    currentPassword: string,
    newPassword: string,
  ): Promise<IssuedSession> {
    const admin = await this.repository.findAdminByLogin(
      required.admin.loginIdentifier,
    );
    if (
      !admin ||
      !(await verifyPassword(currentPassword, admin.passwordHash))
    ) {
      throw new AuthError("AUTH_CURRENT_PASSWORD_INVALID");
    }
    const now = this.now();
    const passwordHash = await hashPassword(newPassword);
    const session = await this.newSession(admin.id, now);
    await this.repository.changePasswordAndRotateSession({
      adminId: admin.id,
      passwordHash,
      changedAtMs: now,
      session: session.row,
      audit: audit(admin.id, "ADMIN_PASSWORD_CHANGED", admin.id, now),
    });
    return {
      admin: profile(admin),
      rawToken: session.rawToken,
      expiresAtMs: session.row.expiresAtMs,
    };
  }
}
