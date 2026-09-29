import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RotatingLog } from "./rotating-log";
it("bounds files and strips full formatted phone numbers and signed URLs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "printgo-log-"));
  try {
    const file = join(dir, "daemon.log"),
      log = new RotatingLog(file, 256);
    for (let i = 0; i < 20; i++)
      await log.write(
        "status +91 98765 43210 https://example.invalid/a?X-Amz-Signature=abcdef",
      );
    for (const name of [file, `${file}.1`]) {
      expect((await stat(name)).size).toBeLessThanOrEqual(256);
      const text = await readFile(name, "utf8");
      expect(text).not.toContain("98765");
      expect(text).not.toContain("X-Amz-Signature");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
