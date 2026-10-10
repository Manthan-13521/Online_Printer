import type { WorkerEnv } from "../env";
import { error, ok } from "../http";
import { guardAdminOrigin, withAdminCors } from "../admin/http";
import { readAdminCookie } from "../auth/cookies";
import { AdminAuthService, AuthError } from "../auth/service";
import { D1AdminAuthRepository } from "../auth/repository";

export const MAX_LOGO_BYTES = 1024 * 1024;

export function detectLogoMime(
  bytes: Uint8Array,
): "image/png" | "image/jpeg" | "image/webp" | null {
  if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) return null;
  const at = (offset: number, text: string) =>
    offset + text.length <= bytes.length &&
    [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0));

  // PNG: 8-byte signature + IHDR chunk
  if (
    bytes.length >= 33 &&
    bytes[0] === 137 &&
    bytes[1] === 80 &&
    bytes[2] === 78 &&
    bytes[3] === 71 &&
    bytes[4] === 13 &&
    bytes[5] === 10 &&
    bytes[6] === 26 &&
    bytes[7] === 10 &&
    at(12, "IHDR")
  ) {
    return "image/png";
  }

  // JPEG: SOI marker (0xFF, 0xD8, 0xFF)
  if (
    bytes.length >= 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  ) {
    return "image/jpeg";
  }

  // WebP: RIFF .... WEBP
  if (
    bytes.length >= 20 &&
    at(0, "RIFF") &&
    at(8, "WEBP") &&
    (at(12, "VP8 ") || at(12, "VP8L") || at(12, "VP8X"))
  ) {
    return "image/webp";
  }

  return null;
}

export function validLogo(bytes: Uint8Array, mime?: string): boolean {
  const detected = detectLogoMime(bytes);
  if (!detected) return false;
  if (!mime) return true;
  const lower = mime.toLowerCase();
  if (
    detected === "image/png" &&
    (lower.includes("png") || lower.includes("octet-stream"))
  )
    return true;
  if (
    detected === "image/jpeg" &&
    (lower.includes("jpeg") ||
      lower.includes("jpg") ||
      lower.includes("octet-stream"))
  )
    return true;
  if (
    detected === "image/webp" &&
    (lower.includes("webp") || lower.includes("octet-stream"))
  )
    return true;
  return false;
}

async function readLogo(request: Request): Promise<Uint8Array | null> {
  if (Number(request.headers.get("content-length")) > MAX_LOGO_BYTES)
    return null;
  const reader = (
    request.body as ReadableStream<Uint8Array> | null
  )?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > MAX_LOGO_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export async function handleBrandingRequest(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const publicMatch = /^\/api\/branding\/logo\/([0-9a-f-]{36})$/u.exec(
    url.pathname,
  );
  if (request.method === "GET" && publicMatch) {
    const key = `branding/${publicMatch[1]}`;
    const selected = await env.DB.prepare(
      "SELECT logo_key FROM installation WHERE id = 1 AND logo_key = ?",
    )
      .bind(key)
      .first();
    if (!selected)
      return error(404, "NOT_FOUND", "Logo not found.", {
        "Cache-Control": "no-store",
      });
    if (request.headers.get("if-none-match") === `"${publicMatch[1]}"`)
      return new Response(null, {
        status: 304,
        headers: {
          ETag: `"${publicMatch[1]}"`,
          "Cache-Control": "public, max-age=300",
        },
      });
    const logo = await env.PDF_BUCKET.get(key);
    if (!logo)
      return error(404, "NOT_FOUND", "Logo not found.", {
        "Cache-Control": "no-store",
      });
    return new Response(logo.body, {
      headers: {
        "Content-Type":
          logo.httpMetadata?.contentType ?? "application/octet-stream",
        "Cache-Control": "public, max-age=300",
        ETag: `"${publicMatch[1]}"`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  }
  const guard = guardAdminOrigin(request, env.ADMIN_ALLOWED_ORIGIN);
  if (guard) return guard;
  let response: Response;
  try {
    const session = await new AdminAuthService(
      new D1AdminAuthRepository(env.DB),
    ).requireSession(readAdminCookie(request, env.APP_ENV === "production"));
    if (!(
      (request.method === "PUT" &&
        url.pathname === "/api/admin/branding/logo") ||
      (request.method === "POST" &&
        url.pathname === "/api/admin/branding/logo/remove")
    )) {
      response = error(404, "NOT_FOUND", "Endpoint not found.");
    } else {
      const previous = await env.DB.prepare(
        "SELECT logo_key FROM installation WHERE id = 1",
      ).first<{ logo_key: string | null }>();
      if (!previous)
        return withAdminCors(
          error(503, "CONFIG_UNAVAILABLE", "Shop settings unavailable."),
          env.ADMIN_ALLOWED_ORIGIN,
        );
      let key: string | null = null;
      if (request.method === "PUT") {
        const rawMime = request.headers.get("content-type") ?? "";
        const bytes = await readLogo(request);
        if (!bytes)
          return withAdminCors(
            error(413, "LOGO_TOO_LARGE", "Choose an image up to 1 MB."),
            env.ADMIN_ALLOWED_ORIGIN,
          );
        const detectedMime = detectLogoMime(bytes);
        if (!detectedMime || !validLogo(bytes, rawMime))
          return withAdminCors(
            error(
              400,
              "INVALID_LOGO",
              "Choose a valid PNG, JPEG or WebP image.",
            ),
            env.ADMIN_ALLOWED_ORIGIN,
          );
        key = `branding/${crypto.randomUUID()}`;
        await env.PDF_BUCKET.put(key, bytes, {
          httpMetadata: { contentType: detectedMime },
        });
      }
      let changed: D1Result[];
      try {
        changed = await env.DB.batch([
          env.DB.prepare(
            "UPDATE installation SET logo_key = ?, updated_at_ms = ? WHERE id = 1 AND logo_key IS ?",
          ).bind(key, Date.now(), previous.logo_key),
          env.DB.prepare(
            "INSERT INTO audit_logs (id,actor_type,actor_id,action,entity_type,entity_id,created_at_ms) SELECT ?, 'ADMIN', ?, 'SHOP_LOGO_UPDATED', 'INSTALLATION', '1', ? WHERE changes() = 1",
          ).bind(crypto.randomUUID(), session.admin.id, Date.now()),
        ]);
      } catch (caught) {
        if (key) await env.PDF_BUCKET.delete(key);
        throw caught;
      }
      if (changed[0]?.meta.changes !== 1) {
        if (key) await env.PDF_BUCKET.delete(key);
        response = error(
          409,
          "SETTINGS_CHANGED",
          "Shop logo changed. Refresh and try again.",
        );
      } else {
        // Keys are unique per replacement: deleting an old key cannot remove a newer logo.
        if (previous.logo_key?.startsWith("branding/"))
          await env.PDF_BUCKET.delete(previous.logo_key);
        response = ok(
          {
            logoUrl: key ? `/api/branding/logo/${key.slice(9)}` : null,
            message: key ? "Shop logo saved." : "Shop logo removed.",
          },
          200,
          { "Cache-Control": "no-store" },
        );
      }
    }
  } catch (caught) {
    response =
      caught instanceof AuthError
        ? error(
            401,
            caught.code,
            "Your session has expired. Please sign in again.",
          )
        : error(
            500,
            "BRANDING_FAILED",
            "Logo update could not be completed. Refresh before retrying.",
          );
  }
  return withAdminCors(response, env.ADMIN_ALLOWED_ORIGIN);
}
