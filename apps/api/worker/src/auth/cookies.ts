const PRODUCTION_COOKIE_NAME = "__Host-printgo_admin";
const DEVELOPMENT_COOKIE_NAME = "printgo_admin_dev";

export function adminCookieName(isProduction: boolean): string {
  return isProduction ? PRODUCTION_COOKIE_NAME : DEVELOPMENT_COOKIE_NAME;
}

export function readAdminCookie(
  request: Request,
  isProduction: boolean,
): string | null {
  const authHeader = request.headers.get("authorization");
  if (authHeader) {
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
    if (match && match[1]) {
      return match[1];
    }
  }

  const name = adminCookieName(isProduction);
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const cookieKey = pair.slice(0, separator).trim();
    if (
      cookieKey === name ||
      cookieKey === PRODUCTION_COOKIE_NAME ||
      cookieKey === DEVELOPMENT_COOKIE_NAME ||
      cookieKey === "printgo_admin"
    ) {
      return pair.slice(separator + 1).trim() || null;
    }
  }
  return null;
}

export function createAdminCookie(
  rawToken: string,
  expiresAtMs: number,
  nowMs: number,
  isProduction: boolean,
): string {
  const sameSite = isProduction ? "SameSite=None" : "SameSite=Lax";
  const attributes = [
    `${adminCookieName(isProduction)}=${rawToken}`,
    "HttpOnly",
    "Path=/",
    sameSite,
    `Max-Age=${Math.max(0, Math.floor((expiresAtMs - nowMs) / 1000))}`,
  ];
  if (isProduction) {
    attributes.push("Secure");
    attributes.push("Partitioned");
  }
  return attributes.join("; ");
}

export function clearAdminCookie(isProduction: boolean): string {
  const sameSite = isProduction ? "SameSite=None" : "SameSite=Lax";
  const attributes = [
    `${adminCookieName(isProduction)}=`,
    "HttpOnly",
    "Path=/",
    sameSite,
    "Max-Age=0",
  ];
  if (isProduction) {
    attributes.push("Secure");
    attributes.push("Partitioned");
  }
  return attributes.join("; ");
}
