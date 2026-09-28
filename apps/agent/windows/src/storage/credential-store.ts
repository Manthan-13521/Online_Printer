import { execFile } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
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
  verifyReadiness?(): Promise<void>;
}

function parseCredentials(json: string): AgentCredentials {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Credential file has an invalid structure.");
  }
  const record = value as Record<string, unknown>;
  const agentId = record.agentId;
  const agentSecret = record.agentSecret;
  const serverUrl = record.serverUrl;
  const displayName = record.displayName;
  const required = ["agentId", "agentSecret", "serverUrl", "displayName"];
  if (
    required.some(
      (key) =>
        typeof record[key] !== "string" || record[key].trim().length === 0,
    ) ||
    typeof agentSecret !== "string" ||
    agentSecret.length < 30 ||
    agentSecret.length > 80 ||
    typeof agentId !== "string" ||
    typeof serverUrl !== "string" ||
    typeof displayName !== "string"
  ) {
    throw new Error("Credential file has invalid or incomplete fields.");
  }
  return {
    agentId,
    agentSecret,
    serverUrl,
    displayName,
  };
}

export type PowerShellExecutor = (
  script: string,
  inputData: string,
) => Promise<string>;

function getPowerShellExecutable(): string {
  if (process.platform === "win32") {
    const systemRoot =
      process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
    const canonical = path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    if (fsSync.existsSync(canonical)) {
      return canonical;
    }
  }
  return "powershell.exe";
}

export function defaultExecPowerShell(
  script: string,
  inputData: string,
): Promise<string> {
  const executable = getPowerShellExecutable();
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
      { maxBuffer: 2 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const stderrText = stderr.trim();
          reject(
            new Error(
              `Windows DPAPI PowerShell error: ${error.message}${stderrText ? ` (diagnostic: ${stderrText})` : ""}`,
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

const DPAPI_SCRIPT_PREAMBLE = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName 'System.Security' -ErrorAction Stop
} catch {
  try {
    Add-Type -AssemblyName 'System.Security.Cryptography.ProtectedData' -ErrorAction Stop
  } catch {
    $null = [System.Reflection.Assembly]::LoadWithPartialName('System.Security')
  }
}

if (-not ([System.Management.Automation.PSTypeName]'System.Security.Cryptography.ProtectedData').Type) {
  [Console]::Error.WriteLine("DPAPI_UNAVAILABLE: System.Security.Cryptography.ProtectedData could not be loaded into PowerShell AppDomain.")
  exit 2
}
`.trim();

/**
 * Windows DPAPI credential store using CurrentUser scope.
 * Only the logged-in Windows user running the service/process can decrypt the stored secret.
 */
export class WindowsDpapiCredentialStore implements CredentialStore {
  private readonly filePath: string;
  private readonly execPowerShell: PowerShellExecutor;

  constructor(customFilePath?: string, execPowerShell?: PowerShellExecutor) {
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
    this.execPowerShell = execPowerShell ?? defaultExecPowerShell;
  }

  async protect(plainText: string): Promise<string> {
    const plainBase64 = Buffer.from(plainText, "utf8").toString("base64");
    const psScript = `
${DPAPI_SCRIPT_PREAMBLE}

$inputBase64 = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($inputBase64)) {
  [Console]::Error.WriteLine("DPAPI_EMPTY_INPUT: Input data was empty.")
  exit 1
}

try {
  $plainBytes = [Convert]::FromBase64String($inputBase64.Trim())
  $cipherBytes = [System.Security.Cryptography.ProtectedData]::Protect(
    $plainBytes,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  [Console]::Out.Write([Convert]::ToBase64String($cipherBytes))
} catch {
  [Console]::Error.WriteLine("DPAPI_PROTECT_FAILED: $($_.Exception.Message)")
  exit 3
}
`.trim();

    const stdout = await this.execPowerShell(psScript, plainBase64);
    const protectedBase64 = stdout.trim();
    if (!protectedBase64) {
      throw new Error("Windows DPAPI returned empty ciphertext.");
    }
    return protectedBase64;
  }

  async unprotect(protectedBase64: string): Promise<string> {
    if (!protectedBase64.trim()) {
      throw new Error("Cannot unprotect empty ciphertext.");
    }
    const psScript = `
${DPAPI_SCRIPT_PREAMBLE}

$inputBase64 = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($inputBase64)) {
  [Console]::Error.WriteLine("DPAPI_EMPTY_INPUT: Input data was empty.")
  exit 1
}

try {
  $cipherBytes = [Convert]::FromBase64String($inputBase64.Trim())
  $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $cipherBytes,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  [Console]::Out.Write([Convert]::ToBase64String($plainBytes))
} catch {
  [Console]::Error.WriteLine("DPAPI_UNPROTECT_FAILED: $($_.Exception.Message)")
  exit 3
}
`.trim();

    const stdout = await this.execPowerShell(psScript, protectedBase64);
    const trimmed = stdout.trim();
    if (!trimmed) {
      throw new Error("Windows DPAPI returned empty plaintext.");
    }
    return Buffer.from(trimmed, "base64").toString("utf8");
  }

  async verifyReadiness(): Promise<void> {
    try {
      const probe = "printgo-dpapi-readiness-probe-" + Date.now();
      const encrypted = await this.protect(probe);
      const decrypted = await this.unprotect(encrypted);
      if (decrypted !== probe) {
        throw new Error(
          "Windows DPAPI self-test probe mismatch during verification.",
        );
      }
    } catch (err: unknown) {
      throw new Error(
        `Windows DPAPI credential encryption is unavailable on this machine: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  async load(): Promise<AgentCredentials | null> {
    try {
      const protectedBase64 = await fs.readFile(this.filePath, "utf8");
      if (!protectedBase64.trim()) return null;

      const json = await this.unprotect(protectedBase64);
      if (!json) return null;
      return parseCredentials(json);
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
    const protectedBase64 = await this.protect(rawJson);

    await fs.mkdir(path.dirname(this.filePath), {
      recursive: true,
      mode: 0o700,
    });
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
      filePath ??
      path.join(os.homedir(), ".printgo", "agent-credentials.local.json");
  }

  async load(): Promise<AgentCredentials | null> {
    try {
      const data = await fs.readFile(this.filePath, "utf8");
      return parseCredentials(data);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  async save(credentials: AgentCredentials): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), {
      recursive: true,
      mode: 0o700,
    });
    await fs.writeFile(this.filePath, JSON.stringify(credentials, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async verifyReadiness(): Promise<void> {
    return Promise.resolve();
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
