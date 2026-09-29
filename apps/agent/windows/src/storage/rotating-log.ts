import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sanitizeLogContent } from "../support/support-package.js";

/** Two bounded files; serial writes and bounded pending messages. No request payloads. */
export class RotatingLog {
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  constructor(
    private readonly file: string,
    private readonly maximumBytes = 1_048_576,
  ) {}
  write(message: string): Promise<void> {
    if (this.pending >= 100) return this.queue;
    this.pending++;
    const line = `${new Date().toISOString()} ${sanitizeLogContent(message)
      .replace(/[\r\n]/g, " ")
      .slice(0, 2048)}\n`;
    const operation = this.queue
      .then(async () => {
        await fs.mkdir(path.dirname(this.file), {
          recursive: true,
          mode: 0o700,
        });
        const size = await fs
          .stat(this.file)
          .then((s) => s.size)
          .catch((err: NodeJS.ErrnoException) => {
            if (err.code === "ENOENT") return 0;
            throw err;
          });
        if (size + Buffer.byteLength(line) > this.maximumBytes) {
          await fs.rm(`${this.file}.1`, { force: true });
          await fs
            .rename(this.file, `${this.file}.1`)
            .catch((err: NodeJS.ErrnoException) => {
              if (err.code !== "ENOENT") throw err;
            });
        }
        await fs.appendFile(this.file, line, { mode: 0o600 });
      })
      .finally(() => {
        this.pending--;
      });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
