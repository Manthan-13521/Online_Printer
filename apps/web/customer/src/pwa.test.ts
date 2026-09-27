import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
}

interface WebAppManifest {
  name: string;
  short_name: string;
  display: string;
  start_url: string;
  theme_color: string;
  icons: ManifestIcon[];
}

describe("Customer PWA installation and service worker config", () => {
  const publicDir = resolve(__dirname, "../public");
  const indexHtmlPath = resolve(__dirname, "../index.html");

  it("provides a valid manifest.webmanifest with required PWA metadata", () => {
    const rawManifest = readFileSync(
      resolve(publicDir, "manifest.webmanifest"),
      "utf8",
    );
    const manifest = JSON.parse(rawManifest) as WebAppManifest;

    expect(manifest.name).toBe("PrintGo");
    expect(manifest.short_name).toBe("PrintGo");
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    expect(manifest.theme_color).toBe("#164e63");
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);

    const icon192 = manifest.icons.find((icon) => icon.sizes === "192x192");
    const icon512 = manifest.icons.find((icon) => icon.sizes === "512x512");

    expect(icon192).toBeDefined();
    expect(icon512).toBeDefined();
  });

  it("ensures sw.js explicitly bypasses /api/ requests to prevent PII caching", () => {
    const swContent = readFileSync(resolve(publicDir, "sw.js"), "utf8");

    expect(swContent).toContain('url.pathname.startsWith("/api/")');
    expect(swContent).toContain("return;");
  });

  it("includes PWA link tags in index.html", () => {
    const html = readFileSync(indexHtmlPath, "utf8");

    expect(html).toContain('rel="manifest"');
    expect(html).toContain('href="/manifest.webmanifest"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('name="theme-color"');
  });
});
