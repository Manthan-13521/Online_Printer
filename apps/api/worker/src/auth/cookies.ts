const PRODUCTION_COOKIE_NAME = "__Host-printgo_admin";
const DEVELOPMENT_COOKIE_NAME = "printgo_admin_dev";

export function adminCookieName(isProduction: boolean): string {
  return isProduction ? PRODUCTION_COOKIE_NAME : DEVELOPMENT_COOKIE_NAME;
}

export function readAdminCookie(
  request: Request,
  isProduction: boolean,
): string | null {
  const name = adminCookieName(isProduction);
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() === name) {
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
  const attributes = [
    `${adminCookieName(isProduction)}=${rawToken}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor((expiresAtMs - nowMs) / 1000))}`,
  ];
  if (isProduction) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearAdminCookie(isProduction: boolean): string {
  const attributes = [
    `${adminCookieName(isProduction)}=`,
    "HttpOnly",
    "Path=/",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (isProduction) attributes.push("Secure");
  return attributes.join("; ");
}
