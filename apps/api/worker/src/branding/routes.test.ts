import { describe, expect, it } from "vitest";
import { detectLogoMime, validLogo } from "./routes";

describe("detectLogoMime & validLogo", () => {
  it("detects and validates PNG images correctly", () => {
    // Standard 33-byte minimal valid PNG header with IHDR chunk
    const pngHeader = new Uint8Array([
      137,
      80,
      78,
      71,
      13,
      10,
      26,
      10,
      0,
      0,
      0,
      13, // Chunk length 13
      73,
      72,
      68,
      82, // IHDR
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      1,
      8,
      6,
      0,
      0,
      0, // data
      0x1f,
      0x15,
      0xc4,
      0x89, // CRC
    ]);

    expect(detectLogoMime(pngHeader)).toBe("image/png");
    expect(validLogo(pngHeader, "image/png")).toBe(true);
    // Even if client header was combined like "application/json, image/png"
    expect(validLogo(pngHeader, "application/json, image/png")).toBe(true);
    // Even if client sent empty MIME
    expect(validLogo(pngHeader, "")).toBe(true);
  });

  it("detects and validates JPEG images correctly", () => {
    const jpegBytes = new Uint8Array([
      255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
      255, 217,
    ]);
    expect(detectLogoMime(jpegBytes)).toBe("image/jpeg");
    expect(validLogo(jpegBytes, "image/jpeg")).toBe(true);
    expect(validLogo(jpegBytes, "image/jpg")).toBe(true);
  });

  it("detects and validates WebP images correctly", () => {
    // RIFF (4 bytes) + size (4 bytes) + WEBP (4 bytes) + VP8  (4 bytes) + chunk size (4 bytes)
    const webpBytes = new Uint8Array([
      0x52,
      0x49,
      0x46,
      0x46, // RIFF
      12,
      0,
      0,
      0,
      0x57,
      0x45,
      0x42,
      0x50, // WEBP
      0x56,
      0x50,
      0x38,
      0x20, // VP8_
      0,
      0,
      0,
      0,
    ]);
    expect(detectLogoMime(webpBytes)).toBe("image/webp");
    expect(validLogo(webpBytes, "image/webp")).toBe(true);
  });

  it("rejects non-image files or arbitrary bytes", () => {
    const randomBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(detectLogoMime(randomBytes)).toBeNull();
    expect(validLogo(randomBytes, "image/png")).toBe(false);
  });
});
