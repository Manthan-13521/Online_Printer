import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readAgentStatus,
  writeAgentStatus,
  type AgentStatusData,
} from "./status-file.js";

describe("status-file", () => {
  it("atomically writes and reads status data", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "printgo-status-test-"),
    );
    const filePath = path.join(tempDir, "agent-status.json");

    const sample: AgentStatusData = {
      operationalState: "ONLINE",
      agentVersion: "2.1.0",
      agentId: "test-agent-id",
      displayName: "Shop PC",
      serverUrl: "https://printgo-api.example.workers.dev",
      lastHeartbeatMs: Date.now(),
      printers: [
        {
          name: "HP Laser",
          displayName: "HP Laser MFP",
          status: "ONLINE",
          statusReason: null,
          isDefault: true,
          isEligible: true,
        },
      ],
      updatedAtMs: Date.now(),
    };

    await writeAgentStatus(sample, filePath);
    const read = await readAgentStatus(filePath);

    expect(read).not.toBeNull();
    expect(read?.agentId).toBe("test-agent-id");
    expect(read?.printers[0]?.name).toBe("HP Laser");
    expect(read?.operationalState).toBe("ONLINE");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns null if status file does not exist", async () => {
    const missing = path.join(os.tmpdir(), `missing-${Date.now()}.json`);
    const read = await readAgentStatus(missing);
    expect(read).toBeNull();
  });
});
