import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface ExecutionJournalEntry {
  orderId: string;
  attemptId: string;
  stepId: string;
  spoolerJobId: string | null;
  updatedAtMs: number;
}

export class ExecutionJournalStore {
  private readonly filePath: string;

  constructor(customPath?: string) {
    const base =
      process.platform === "win32"
        ? (process.env.LOCALAPPDATA ??
          process.env.APPDATA ??
          path.join(process.env.USERPROFILE ?? "C:\\", "AppData", "Local"))
        : path.join(os.homedir(), ".printgo");
    this.filePath =
      customPath ?? path.join(base, "PrintGo", "active-print.json");
  }

  async load(): Promise<ExecutionJournalEntry | null> {
    try {
      const value: unknown = JSON.parse(
        await fs.readFile(this.filePath, "utf8"),
      );
      if (!value || typeof value !== "object") return null;
      const row = value as Record<string, unknown>;
      if (
        ["orderId", "attemptId", "stepId"].some(
          (key) => typeof row[key] !== "string",
        )
      )
        return null;
      return {
        orderId: row.orderId as string,
        attemptId: row.attemptId as string,
        stepId: row.stepId as string,
        spoolerJobId:
          typeof row.spoolerJobId === "string" ? row.spoolerJobId : null,
        updatedAtMs: typeof row.updatedAtMs === "number" ? row.updatedAtMs : 0,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(entry: ExecutionJournalEntry): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), {
      recursive: true,
      mode: 0o700,
    });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(entry), {
      mode: 0o600,
      flag: "w",
    });
    await fs.rename(temporary, this.filePath);
  }

  async clear(): Promise<void> {
    await fs.unlink(this.filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
