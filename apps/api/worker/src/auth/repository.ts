export interface AdminRecord {
  id: string;
  loginIdentifier: string;
  passwordHash: string;
  isActive: boolean;
}

export interface SessionRecord {
  id: string;
  adminId: string;
  loginIdentifier: string;
  isAdminActive: boolean;
  expiresAtMs: number;
  revokedAtMs: number | null;
}

export interface NewSessionRecord {
  id: string;
  adminId: string;
  tokenHash: string;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface AuditRecord {
  id: string;
  actorId: string;
  action: string;
  entityId: string;
  createdAtMs: number;
}

export interface AdminAuthRepository {
  findAdminByLogin(loginIdentifier: string): Promise<AdminRecord | null>;
  findSession(tokenHash: string): Promise<SessionRecord | null>;
  createSession(session: NewSessionRecord, audit: AuditRecord): Promise<void>;
  revokeSession(
    tokenHash: string,
    revokedAtMs: number,
    audit: AuditRecord,
  ): Promise<void>;
  revokeAllSessions(
    adminId: string,
    revokedAtMs: number,
    audit: AuditRecord,
  ): Promise<void>;
  changePasswordAndRotateSession(input: {
    adminId: string;
    passwordHash: string;
    changedAtMs: number;
    session: NewSessionRecord;
    audit: AuditRecord;
  }): Promise<void>;
}

interface AdminRow {
  id: string;
  login_identifier: string;
  password_hash: string;
  is_active: number;
}

interface SessionRow {
  id: string;
  admin_id: string;
  login_identifier: string;
  is_active: number;
  expires_at_ms: number;
  revoked_at_ms: number | null;
}

function auditStatement(
  db: D1Database,
  audit: AuditRecord,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_logs
       (id, actor_type, actor_id, action, entity_type, entity_id, created_at_ms)
       VALUES (?, 'ADMIN', ?, ?, 'ADMIN_SESSION', ?, ?)`,
    )
    .bind(
      audit.id,
      audit.actorId,
      audit.action,
      audit.entityId,
      audit.createdAtMs,
    );
}

function insertSessionStatement(
  db: D1Database,
  session: NewSessionRecord,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO admin_sessions
       (id, admin_id, token_hash, created_at_ms, expires_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      session.id,
      session.adminId,
      session.tokenHash,
      session.createdAtMs,
      session.expiresAtMs,
    );
}

export class D1AdminAuthRepository implements AdminAuthRepository {
  constructor(private readonly db: D1Database) {}

  async findAdminByLogin(loginIdentifier: string): Promise<AdminRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, login_identifier, password_hash, is_active
         FROM admins WHERE login_identifier = ? LIMIT 1`,
      )
      .bind(loginIdentifier)
      .first<AdminRow>();
    return row
      ? {
          id: row.id,
          loginIdentifier: row.login_identifier,
          passwordHash: row.password_hash,
          isActive: row.is_active === 1,
        }
      : null;
  }

  async findSession(tokenHash: string): Promise<SessionRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT s.id, s.admin_id, s.expires_at_ms, s.revoked_at_ms,
                a.login_identifier, a.is_active
         FROM admin_sessions s
         JOIN admins a ON a.id = s.admin_id
         WHERE s.token_hash = ? LIMIT 1`,
      )
      .bind(tokenHash)
      .first<SessionRow>();
    return row
      ? {
          id: row.id,
          adminId: row.admin_id,
          loginIdentifier: row.login_identifier,
          isAdminActive: row.is_active === 1,
          expiresAtMs: row.expires_at_ms,
          revokedAtMs: row.revoked_at_ms,
        }
      : null;
  }

  async createSession(
    session: NewSessionRecord,
    audit: AuditRecord,
  ): Promise<void> {
    await this.db.batch([
      insertSessionStatement(this.db, session),
      auditStatement(this.db, audit),
    ]);
  }

  async revokeSession(
    tokenHash: string,
    revokedAtMs: number,
    audit: AuditRecord,
  ): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE admin_sessions SET revoked_at_ms = ?
           WHERE token_hash = ? AND revoked_at_ms IS NULL`,
        )
        .bind(revokedAtMs, tokenHash),
      auditStatement(this.db, audit),
    ]);
  }

  async revokeAllSessions(
    adminId: string,
    revokedAtMs: number,
    audit: AuditRecord,
  ): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE admin_sessions SET revoked_at_ms = ?
           WHERE admin_id = ? AND revoked_at_ms IS NULL`,
        )
        .bind(revokedAtMs, adminId),
      auditStatement(this.db, audit),
    ]);
  }

  async changePasswordAndRotateSession(input: {
    adminId: string;
    passwordHash: string;
    changedAtMs: number;
    session: NewSessionRecord;
    audit: AuditRecord;
  }): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE admins
           SET password_hash = ?, password_changed_at_ms = ?, updated_at_ms = ?
           WHERE id = ?`,
        )
        .bind(
          input.passwordHash,
          input.changedAtMs,
          input.changedAtMs,
          input.adminId,
        ),
      this.db
        .prepare(
          `UPDATE admin_sessions SET revoked_at_ms = ?
           WHERE admin_id = ? AND revoked_at_ms IS NULL`,
        )
        .bind(input.changedAtMs, input.adminId),
      insertSessionStatement(this.db, input.session),
      auditStatement(this.db, input.audit),
    ]);
  }
}
