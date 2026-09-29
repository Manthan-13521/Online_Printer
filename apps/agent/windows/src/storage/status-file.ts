import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface PrinterStatusInfo {
  name: string;
  displayName: string;
  status: string;
  statusReason: string | null;
  isDefault: boolean;
  isEligible: boolean;
}

export interface AgentStatusData {
  operationalState: "ONLINE" | "OFFLINE" | "UNPAIRED" | "ERROR";
  agentVersion: string;
  agentId: string | null;
  displayName: string | null;
  serverUrl: string | null;
  lastHeartbeatMs: number | null;
  lastJobCode?: string | null;
  lastJobStatus?: string | null;
  lastJobMs?: number | null;
  printers: PrinterStatusInfo[];
  updatedAtMs: number;
}

export function getDefaultStatusFilePath(): string {
  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA ||
      process.env.APPDATA ||
      path.join(process.env.USERPROFILE || "C:\\", "AppData", "Local");
    return path.join(localAppData, "PrintGo", "agent-status.json");
  }
  return path.join(os.homedir(), ".printgo", "agent-status.json");
}

export async function writeAgentStatus(
  status: AgentStatusData,
  customPath?: string,
): Promise<void> {
  const filePath = customPath || getDefaultStatusFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp.${Date.now()}`;
  await fs.writeFile(tempPath, JSON.stringify(status, null, 2), "utf8");
  await fs.rename(tempPath, filePath);
}

export async function readAgentStatus(
  customPath?: string,
): Promise<AgentStatusData | null> {
  const filePath = customPath || getDefaultStatusFilePath();
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as AgentStatusData;
  } catch {
    return null;
  }
}
