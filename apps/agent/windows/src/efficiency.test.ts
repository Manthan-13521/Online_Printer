import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { AgentDaemon } from "./agent-daemon";
import type { AgentClient } from "./agent-client";
import { WindowsPrinterAdapter } from "./printing/windows-printer-adapter";
import type { CredentialStore } from "./storage/credential-store";
vi.mock("./storage/status-file", () => ({
  writeAgentStatus: vi.fn(() => Promise.resolve()),
}));
const credentials = {
  agentId: "synthetic",
  agentSecret: "synthetic",
  serverUrl: "https://synthetic.invalid",
  displayName: "Synthetic",
};
const store = { load: () => Promise.resolve(credentials) } as CredentialStore;
const printer = JSON.stringify({
  Name: "Synthetic",
  Default: true,
  PrinterStatus: 3,
  DetectedErrorState: 2,
  Color: false,
  CapabilityDescriptions: ["Simplex"],
  PrinterPaperNames: ["A4"],
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("Agent efficiency", () => {
  it("runs a 15-hour equivalent with bounded requests, discovery and memory", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(1_000_000);
    let calls = 0,
      reports = 0,
      launches = 0;
    const adapter = new WindowsPrinterAdapter(() => {
      launches++;
      return Promise.resolve(printer);
    });
    const client = {
      sendHeartbeat: (
        _url: string,
        _id: string,
        _secret: string,
        report: { printers?: unknown },
      ) => {
        calls++;
        if (report.printers) reports++;
        return Promise.resolve({
          acknowledged: true,
          serverTimeMs: Date.now(),
          onlinePrintingEnabled: true,
        });
      },
    } as unknown as AgentClient;
    const daemon = new AgentDaemon({
      credentialStore: store,
      printerAdapter: adapter,
      client,
      onStatusChange: () => undefined,
    });
    const cpu = process.cpuUsage(),
      heapStart = process.memoryUsage().heapUsed,
      start = performance.now();
    let peakHeap = heapStart;
    await daemon.start();
    for (let i = 1; i < 10800; i++) {
      vi.setSystemTime(1_000_000 + i * 5000);
      await daemon.pulse();
      if (i % 100 === 0)
        peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    }
    daemon.stop();
    const used = process.cpuUsage(cpu);
    expect(calls).toBe(10800);
    expect(reports).toBe(1);
    expect(launches).toBe(900);
    expect(peakHeap - heapStart).toBeLessThan(64 * 1024 * 1024);
    mkdirSync("docs/evidence/efficiency-v2", { recursive: true });
    writeFileSync(
      "docs/evidence/efficiency-v2/agent-idle.json",
      JSON.stringify(
        {
          label:
            "SIMULATED 15-hour Agent; mocked PowerShell and HTTP, measured Mac process resources",
          calls,
          reports,
          powerShellInvocations: launches,
          processCpuMs: (used.user + used.system) / 1000,
          wallMs: performance.now() - start,
          heapStart,
          peakHeap,
          rss: process.memoryUsage().rss,
        },
        null,
        2,
      ) + "\n",
    );
  });
  it("backs off on errors, recovers promptly and pauses at 30s when printing is off", async () => {
    vi.useFakeTimers();
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue({
        acknowledged: true,
        serverTimeMs: 1,
        onlinePrintingEnabled: false,
      });
    const daemon = new AgentDaemon({
      credentialStore: store,
      printerAdapter: new WindowsPrinterAdapter(() => Promise.resolve(printer)),
      client: { sendHeartbeat: send } as unknown as AgentClient,
      random: () => 1,
      onStatusChange: () => undefined,
    });
    await daemon.start();
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(59999);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(3);
    daemon.stop();
  });
});
