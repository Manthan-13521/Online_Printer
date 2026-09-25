# Admin Authentication

PrintGo V1 has one active shop admin per isolated deployment. Authentication is enforced by the Worker and D1, not by React. There is no registration, staff/role system, external identity provider, or multi-shop selector.

## Passwords

Passwords accept passphrases from 12 through 128 characters and are never trimmed. Login identifiers are trimmed and normalized to lowercase for creation and lookup.

`@printgo/auth` stores passwords as:

```text
pbkdf2-sha256$v=1$i=600000$<16-byte-base64url-salt>$<32-byte-base64url-hash>
```

It uses Worker Web Crypto PBKDF2-HMAC-SHA-256, a fresh cryptographically random salt, 600,000 iterations, and constant-time byte comparison. The version and work factor are encoded so a later implementation can verify and upgrade old hashes without changing the table.

## Bootstrap

There is no public registration endpoint. For local development:

```bash
pnpm db:setup:local
pnpm admin:bootstrap
```

The second command defaults to login `admin` and prompts for the password with terminal echo disabled. A custom synthetic login can be supplied as `pnpm admin:bootstrap -- dev-admin`. The command builds the auth package, hashes the password in memory, applies a temporary mode-`0600` SQL file, deletes that file, and never prints the password. Re-running it resets the single admin and revokes existing sessions.

Production bootstrap will use the same hash and singleton model against the shop's provisioned D1 during a deployment phase. Production credentials must be handed over through an out-of-band secure channel and must not enter Git, migrations, seeds, command arguments, or logs.

## Sessions and cookies

Login generates 32 cryptographically random bytes. The raw base64url token is returned only in an HttpOnly cookie; D1 stores its SHA-256 digest. Protected requests hash the cookie and perform an indexed session/admin lookup, then reject missing, unknown, expired, revoked, or inactive-admin sessions.

Sessions last 12 hours. Expiry is enforced in D1-backed authorization even if the browser retains an old cookie. Requests do not write `last_seen_at_ms`, avoiding a D1 write per page/API call.

Production uses:

```text
__Host-printgo_admin; HttpOnly; Secure; SameSite=Strict; Path=/
```

It sets no `Domain`. Local HTTP development uses `printgo_admin_dev` without `Secure`; the other attributes are unchanged. Production Admin and API endpoints must be deployed on the same schemeful site for `SameSite=Strict` cookie behavior.

## Origin protection

The Worker compares browser `Origin` exactly with `ADMIN_ALLOWED_ORIGIN`. Every state-changing Admin request requires that origin. Preflight responses allow only that origin, credentials, `Content-Type`, and `GET`/`POST`; arbitrary origins are never reflected and credentialed wildcard CORS is prohibited.

The local Worker trusts `http://localhost:5174`. Production must set one exact HTTPS Admin origin. JSON auth bodies are limited to 2 KiB and non-JSON login/password-change bodies are rejected.

## Password changes and logout

Changing the password verifies the current password, writes a fresh password hash, revokes every old session, and atomically creates a fresh 12-hour session for the current browser. Logout revokes the current session and is idempotent. “Log out all sessions” revokes every active session and clears the current cookie.

Successful login, logout, password change, and all-session revocation create minimal `audit_logs` rows. Credentials and token material are never logged.

## Admin PWA

The PWA calls `/api/admin/auth/me` before rendering the protected shell, so protected content does not flicker on screen. All API requests use cookie credentials and surface network failures separately from invalid credentials. The service worker precaches static application assets only; `/api/*` is denied as a navigation fallback and has no runtime cache. Sensitive mutations are never queued for offline replay.
