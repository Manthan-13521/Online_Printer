import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface AgentCredentials {
  agentId: string;
  agentSecret: string;
  serverUrl: string;
  displayName: string;
}

export interface CredentialStore {
  load(): Promise<AgentCredentials | null>;
  save(credentials: AgentCredentials): Promise<void>;
  clear(): Promise<void>;
}

function execPowerShellWithInput(
  command: string,
  inputData: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `PowerShell error: ${error.message} (stderr: ${stderr.trim()})`,
            ),
          );
        } else {
          resolve(stdout);
        }
      },
    );
    child.stdin?.end(inputData, "utf8");
  });
}

/**
 * Windows DPAPI credential store using CurrentUser scope.
 * Only the logged-in Windows user running the service/process can decrypt the stored secret.
 */
export class WindowsDpapiCredentialStore implements CredentialStore {
  private readonly filePath: string;

  constructor(customFilePath?: string) {
    if (customFilePath) {
      this.filePath = customFilePath;
    } else {
      const localAppData =
        process.env.LOCALAPPDATA ||
        process.env.APPDATA ||
        path.join(process.env.USERPROFILE || "C:\\", "AppData", "Local");
      this.filePath = path.join(
        localAppData,
        "PrintGo",
        "agent-credentials.dat",
      );
    }
  }

  async load(): Promise<AgentCredentials | null> {
    try {
      const protectedBase64 = await fs.readFile(this.filePath, "utf8");
      if (!protectedBase64.trim()) return null;

      const psScript = `
$inputBase64 = [Console]::In.ReadToEnd()
if (-not $inputBase64) { exit 1 }
$cipherBytes = [Convert]::FromBase64String($inputBase64.Trim())
$plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect($cipherBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[System.Text.Encoding]::UTF8.GetString($plainBytes)
      `.trim();

      const stdout = await execPowerShellWithInput(psScript, protectedBase64);

      const json = stdout.trim();
      if (!json) return null;
      return JSON.parse(json) as AgentCredentials;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw new Error(
        `Failed to load DPAPI credentials: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  async save(credentials: AgentCredentials): Promise<void> {
    const rawJson = JSON.stringify(credentials);
    const plainBase64 = Buffer.from(rawJson, "utf8").toString("base64");

    const psScript = `
$inputBase64 = [Console]::In.ReadToEnd()
if (-not $inputBase64) { exit 1 }
$plainBytes = [Convert]::FromBase64String($inputBase64.Trim())
$cipherBytes = [System.Security.Cryptography.ProtectedData]::Protect($plainBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($cipherBytes)
    `.trim();

    const stdout = await execPowerShellWithInput(psScript, plainBase64);

    const protectedBase64 = stdout.trim();
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, protectedBase64, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
}

/**
 * File-based credential store for development and testing environments (e.g. macOS / Linux).
 */
export class DevelopmentCredentialStore implements CredentialStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath =
      filePath ?? path.resolve(process.cwd(), ".agent-credentials.local.json");
  }

  async load(): Promise<AgentCredentials | null> {
    try {
      const data = await fs.readFile(this.filePath, "utf8");
      return JSON.parse(data) as AgentCredentials;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  async save(credentials: AgentCredentials): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(credentials, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
}

export function createDefaultCredentialStore(
  customPath?: string,
): CredentialStore {
  if (process.platform === "win32") {
    return new WindowsDpapiCredentialStore(customPath);
  }
  if (
    process.env.NODE_ENV === "production" ||
    process.env.APP_ENV === "production"
  ) {
    throw new Error(
      "Production PrintGo Agent requires Windows DPAPI credential storage. Development credential storage is forbidden in production.",
    );
  }
  return new DevelopmentCredentialStore(customPath);
}
