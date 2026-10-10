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
  private readonly legacyPath: string;
  private readonly lanesDir: string;

  constructor(customPath?: string) {
    const base =
      process.platform === "win32"
        ? (process.env.LOCALAPPDATA ??
          process.env.APPDATA ??
          path.join(process.env.USERPROFILE ?? "C:\\", "AppData", "Local"))
        : path.join(os.homedir(), ".printgo");

    if (customPath) {
      this.legacyPath = customPath;
      this.lanesDir = path.join(path.dirname(customPath), "active-prints");
    } else {
      this.legacyPath = path.join(base, "PrintGo", "active-print.json");
      this.lanesDir = path.join(base, "PrintGo", "active-prints");
    }
  }

  private lanePath(orderId: string): string {
    const safeOrderId = orderId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.lanesDir, `lane-${safeOrderId}.json`);
  }

  private parseEntry(raw: string): ExecutionJournalEntry | null {
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object") return null;
      const row = value as Record<string, unknown>;
      if (
        ["orderId", "attemptId", "stepId"].some(
          (key) => typeof row[key] !== "string",
        )
      ) {
        return null;
      }
      return {
        orderId: row.orderId as string,
        attemptId: row.attemptId as string,
        stepId: row.stepId as string,
        spoolerJobId:
          typeof row.spoolerJobId === "string" ? row.spoolerJobId : null,
        updatedAtMs: typeof row.updatedAtMs === "number" ? row.updatedAtMs : 0,
      };
    } catch {
      return null;
    }
  }

  async migrateLegacy(): Promise<ExecutionJournalEntry | null> {
    try {
      const raw = await fs.readFile(this.legacyPath, "utf8");
      const entry = this.parseEntry(raw);
      if (entry) {
        await this.save(entry);
        await fs.unlink(this.legacyPath).catch(() => undefined);
        return entry;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // Corrupted legacy file: rename to quarantine rather than losing it blindly
        await fs
          .rename(this.legacyPath, `${this.legacyPath}.corrupt-${Date.now()}`)
          .catch(() => undefined);
      }
    }
    return null;
  }

  async load(orderId?: string): Promise<ExecutionJournalEntry | null> {
    if (orderId) {
      try {
        const raw = await fs.readFile(this.lanePath(orderId), "utf8");
        const entry = this.parseEntry(raw);
        if (entry) return entry;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      // Check legacy path as fallback
      try {
        const raw = await fs.readFile(this.legacyPath, "utf8");
        const entry = this.parseEntry(raw);
        if (entry && entry.orderId === orderId) return entry;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return null;
    }

    // No orderId specified: first check legacy path
    try {
      const raw = await fs.readFile(this.legacyPath, "utf8");
      const entry = this.parseEntry(raw);
      if (entry) return entry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    // Then check any active lane file
    const all = await this.listAll();
    return all[0] ?? null;
  }

  async save(entry: ExecutionJournalEntry): Promise<void> {
    await fs.mkdir(this.lanesDir, { recursive: true, mode: 0o700 });
    const targetFile = this.lanePath(entry.orderId);
    const temporary = `${targetFile}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify(entry);

    await fs.writeFile(temporary, payload, { mode: 0o600, flag: "w" });
    await fs.rename(temporary, targetFile);

    // Keep legacy file updated for backward compatibility
    await fs.mkdir(path.dirname(this.legacyPath), {
      recursive: true,
      mode: 0o700,
    });
    const legacyTmp = `${this.legacyPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(legacyTmp, payload, { mode: 0o600, flag: "w" });
    await fs.rename(legacyTmp, this.legacyPath).catch(() => undefined);
  }

  async clear(orderId?: string): Promise<void> {
    if (orderId) {
      await fs
        .unlink(this.lanePath(orderId))
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      // If legacy file matches this orderId, clean it up too
      try {
        const raw = await fs.readFile(this.legacyPath, "utf8");
        const entry = this.parseEntry(raw);
        if (entry && entry.orderId === orderId) {
          await fs.unlink(this.legacyPath).catch(() => undefined);
        }
      } catch {
        // Ignored
      }
      return;
    }

    // Clear all
    await fs.unlink(this.legacyPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });

    try {
      const files = await fs.readdir(this.lanesDir);
      await Promise.all(
        files
          .filter((f) => f.startsWith("lane-") && f.endsWith(".json"))
          .map((f) =>
            fs.unlink(path.join(this.lanesDir, f)).catch(() => undefined),
          ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async listAll(): Promise<ExecutionJournalEntry[]> {
    const map = new Map<string, ExecutionJournalEntry>();

    try {
      const files = await fs.readdir(this.lanesDir);
      for (const file of files) {
        if (!file.startsWith("lane-") || !file.endsWith(".json")) continue;
        try {
          const raw = await fs.readFile(path.join(this.lanesDir, file), "utf8");
          const entry = this.parseEntry(raw);
          if (entry) map.set(entry.orderId, entry);
        } catch {
          // Ignore unreadable individual lane file
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    try {
      const raw = await fs.readFile(this.legacyPath, "utf8");
      const entry = this.parseEntry(raw);
      if (entry && !map.has(entry.orderId)) {
        map.set(entry.orderId, entry);
      }
    } catch {
      // Ignored
    }

    return Array.from(map.values());
  }
}
