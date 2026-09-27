declare const secretValueBrand: unique symbol;

/** Marks values that must never be logged or sent to an unauthorized client. */
export type SecretValue = string & { readonly [secretValueBrand]: true };

export interface AuthenticatedAgent {
  agentId: string;
  authenticatedAt: string;
}

export interface AuthenticatedAdmin {
  adminId: string;
  sessionId: string;
  authenticatedAt: string;
}

export const PASSWORD_HASH_VERSION = 1;
export const PASSWORD_PBKDF2_ITERATIONS = 100_000;
export const PASSWORD_SALT_BYTES = 16;
export const PASSWORD_HASH_BYTES = 32;
export const ADMIN_SESSION_TOKEN_BYTES = 32;
export const ADMIN_SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

const PASSWORD_HASH_ALGORITHM = "PBKDF2";
const PASSWORD_HASH_DIGEST = "SHA-256";
const PASSWORD_HASH_PREFIX = "pbkdf2-sha256";

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    return Uint8Array.from(atob(padded), (character) =>
      character.charCodeAt(0),
    );
  } catch {
    return null;
  }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function derivePasswordBytes(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    PASSWORD_HASH_ALGORITHM,
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: PASSWORD_HASH_ALGORITHM,
      hash: PASSWORD_HASH_DIGEST,
      salt,
      iterations,
    },
    key,
    PASSWORD_HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES));
  const derived = await derivePasswordBytes(
    password,
    salt,
    PASSWORD_PBKDF2_ITERATIONS,
  );
  return [
    PASSWORD_HASH_PREFIX,
    `v=${PASSWORD_HASH_VERSION}`,
    `i=${PASSWORD_PBKDF2_ITERATIONS}`,
    encodeBase64Url(salt),
    encodeBase64Url(derived),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const parts = storedHash.split("$");
  if (
    parts.length !== 5 ||
    parts[0] !== PASSWORD_HASH_PREFIX ||
    parts[1] !== `v=${PASSWORD_HASH_VERSION}`
  ) {
    return false;
  }
  const iterationPart = parts[2];
  if (!iterationPart || !/^i=\d+$/u.test(iterationPart)) return false;
  const iterations = Number(iterationPart.slice(2));
  const salt = parts[3] ? decodeBase64Url(parts[3]) : null;
  const expected = parts[4] ? decodeBase64Url(parts[4]) : null;
  if (
    !Number.isSafeInteger(iterations) ||
    iterations < 10_000 ||
    iterations > 100_000 ||
    salt?.length !== PASSWORD_SALT_BYTES ||
    expected?.length !== PASSWORD_HASH_BYTES
  ) {
    return false;
  }
  try {
    const actual = await derivePasswordBytes(password, salt, iterations);
    return constantTimeEqual(actual, expected);
  } catch {
    return false;
  }
}

export interface SessionToken {
  rawToken: string;
  tokenHash: string;
}

export async function createSessionToken(): Promise<SessionToken> {
  const rawToken = encodeBase64Url(
    crypto.getRandomValues(new Uint8Array(ADMIN_SESSION_TOKEN_BYTES)),
  );
  return { rawToken, tokenHash: await hashSessionToken(rawToken) };
}

export async function hashSessionToken(rawToken: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(rawToken),
  );
  return encodeBase64Url(new Uint8Array(digest));
}
