import { afterEach, expect, it, vi } from "vitest";
import type { AgentClient } from "./agent-client";
import { AgentDaemon } from "./agent-daemon";
import type { PrinterAdapter } from "./printing/printer-adapter";
import type { CredentialStore } from "./storage/credential-store";
const state = vi.hoisted(() => ({ finished: () => {} }));
vi.mock("./paid-print-executor", () => ({
  PaidPrintExecutor: class {
    constructor(
      _client: unknown,
      _printer: unknown,
      _journal: unknown,
      _log: unknown,
      finished: () => void,
    ) {
      state.finished = finished;
    }
    handle() {
      state.finished();
      return Promise.resolve();
    }
  },
}));
vi.mock("./storage/status-file", () => ({
  writeAgentStatus: () => Promise.resolve(),
}));
afterEach(() => {
  vi.useRealTimers();
});
it("requests the next step immediately after confirmed success without another discovery", async () => {
  vi.useFakeTimers();
  const send = vi
    .fn()
    .mockResolvedValueOnce({
      acknowledged: true,
      printJob: { type: "PAID_PRINT_JOB" },
    })
    .mockResolvedValue({ acknowledged: true });
  const discovery = vi
    .fn()
    .mockResolvedValue([
      { id: "printer", displayName: "Printer", isDefault: true },
    ]);
  const daemon = new AgentDaemon({
    client: { sendHeartbeat: send } as unknown as AgentClient,
    credentialStore: {
      load: () =>
        Promise.resolve({
          agentId: "agent",
          agentSecret: "synthetic",
          serverUrl: "https://synthetic.invalid",
          displayName: "Agent",
        }),
    } as CredentialStore,
    printerAdapter: {
      listPrinters: discovery,
      getStatus: () => Promise.resolve({ availability: "ONLINE" }),
      getCapabilities: () =>
        Promise.resolve({ colour: false, duplex: false, paperSizes: ["A4"] }),
    } as unknown as PrinterAdapter,
    onStatusChange: () => undefined,
  });
  await daemon.start();
  expect(send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledTimes(2);
  expect(discovery).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(4999);
  expect(send).toHaveBeenCalledTimes(2);
  daemon.stop();
  expect(vi.getTimerCount()).toBe(0);
});
