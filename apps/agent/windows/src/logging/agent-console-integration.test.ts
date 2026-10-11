import { describe, expect, it, vi } from "vitest";
import { AgentLogger } from "./agent-logger.js";
import { AgentDaemon } from "../agent-daemon.js";
import type { AgentClient } from "../agent-client.js";
import type { PrinterAdapter } from "../printing/printer-adapter.js";
import type { CredentialStore } from "../storage/credential-store.js";

describe("PrintGo Windows Agent Console Logging Integration", () => {
  function createMockSetup(level: "normal" | "debug") {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const daemonLogs: string[] = [];

    const logger = new AgentLogger({
      level,
      stdout: (m) => stdout.push(m),
      stderr: (m) => stderr.push(m),
    });

    const mockClient = {
      sendHeartbeat: vi.fn().mockResolvedValue({
        acknowledged: true,
        serverTimeMs: Date.now(),
        onlinePrintingEnabled: true,
      }),
    } as unknown as AgentClient;

    const mockStore = {
      load: vi.fn().mockResolvedValue({
        agentId: "6e4c7d0c-9b72-43a3-b907-5a907f6f2158",
        agentSecret: "secret-token-test",
        serverUrl: "https://api.printgo.shop",
        displayName: "BHAVESH (PrintGo Agent)",
      }),
      verifyReadiness: vi.fn().mockResolvedValue(true),
    } as unknown as CredentialStore;

    const mockAdapter = {
      listPrinters: vi.fn().mockResolvedValue([
        {
          id: "printer-thermal-1",
          displayName: "Thermal Receipt",
          status: "ONLINE",
          isDefault: true,
          isEligibleForProductionPrint: true,
        },
      ]),
      getStatus: vi.fn().mockResolvedValue({ availability: "ONLINE" }),
      getCapabilities: vi.fn().mockResolvedValue({
        colour: false,
        duplex: false,
        paperSizes: ["A4"],
      }),
    } as unknown as PrinterAdapter;

    const daemon = new AgentDaemon({
      client: mockClient,
      credentialStore: mockStore,
      printerAdapter: mockAdapter,
      logger,
      onStatusChange: (msg) => {
        daemonLogs.push(msg);
        logger.handleDaemonStatus(msg);
      },
    });

    return { daemon, logger, stdout, stderr, daemonLogs };
  }

  it("produces clean, minimal console output in NORMAL mode during startup and connection", async () => {
    const { daemon, stdout, daemonLogs } = createMockSetup("normal");

    await daemon.start();

    // Verify console output is minimal and contains only important events
    expect(stdout).toEqual([
      "[PGO] Starting...",
      "[PGO] Connected",
      "[PGO] Printer ready",
    ]);

    // Verify daemon.log / disk logging retains the full diagnostic messages
    expect(daemonLogs).toContain(
      "Starting heartbeat daemon for agent 6e4c7d0c-9b72-43a3-b907-5a907f6f2158 (BHAVESH (PrintGo Agent))...",
    );
    expect(daemonLogs).toContain("AGENT_CONNECTED");
    expect(daemonLogs).toContain("PRINTER_READY");

    daemon.stop();
  });

  it("emits Printing and Print completed lifecycle events cleanly in NORMAL mode", () => {
    const stdout: string[] = [];
    const logger = new AgentLogger({
      level: "normal",
      stdout: (m) => stdout.push(m),
    });

    // Simulate print execution flow
    logger.handleDaemonStatus("PRINT_EVENT printing");
    logger.handleDaemonStatus(
      "PRINT_TIMING step=55602a6f-8310-4813-8096-98408f5ea97f event=preparation_start atMs=1791630710959",
    );
    logger.handleDaemonStatus(
      "PRINT_TIMING step=55602a6f-8310-4813-8096-98408f5ea97f event=submission_start atMs=1791630712449",
    );
    logger.handleDaemonStatus(
      "PRINT_TIMING step=55602a6f-8310-4813-8096-98408f5ea97f event=spool_captured atMs=1791630717114",
    );
    logger.handleDaemonStatus(
      "PRINT_TIMING step=55602a6f-8310-4813-8096-98408f5ea97f event=step_acknowledged atMs=1791630719612",
    );
    logger.handleDaemonStatus("PRINT_EVENT completed");

    // Only essential events appear; all PRINT_TIMING telemetry is hidden from console
    expect(stdout).toEqual(["[PGO] Printing...", "[PGO] Print completed"]);
  });

  it("produces compact technical telemetry in DEBUG mode (PRINTGO_LOG_LEVEL=debug)", () => {
    const stdout: string[] = [];
    const logger = new AgentLogger({
      level: "debug",
      stdout: (m) => stdout.push(m),
    });

    logger.handleDaemonStatus(
      "PRINT_TIMING step=55602a6f-8310-4813-8096-98408f5ea97f event=preparation_start atMs=1791630710959",
    );
    logger.handleDaemonStatus(
      "PRINT_TIMING step=55602a6f-8310-4813-8096-98408f5ea97f event=submission_start atMs=1791630712449",
    );
    logger.handleDaemonStatus(
      "PRINT_TIMING step=55602a6f-8310-4813-8096-98408f5ea97f event=sumatra_start atMs=1791630715859",
    );
    logger.handleDaemonStatus(
      "PRINT_TIMING step=55602a6f-8310-4813-8096-98408f5ea97f event=spool_captured atMs=1791630717114",
    );
    logger.handleDaemonStatus(
      "PRINT_TIMING step=55602a6f-8310-4813-8096-98408f5ea97f event=adapter_return atMs=1791630717455",
    );
    logger.handleDaemonStatus(
      "PRINT_TIMING step=55602a6f-8310-4813-8096-98408f5ea97f event=spool_identity_persisted atMs=1791630717951",
    );
    logger.handleDaemonStatus(
      "PRINT_TIMING step=55602a6f-8310-4813-8096-98408f5ea97f event=step_acknowledged atMs=1791630719612",
    );

    expect(stdout).toEqual([
      "[PGO] P_T s=55602a6f E=p_s t=1791630710959",
      "[PGO] P_T s=55602a6f E=sub_s t=1791630712449",
      "[PGO] P_T s=55602a6f E=sum_s t=1791630715859",
      "[PGO] P_T s=55602a6f E=sp_c t=1791630717114",
      "[PGO] P_T s=55602a6f E=ad_r t=1791630717455",
      "[PGO] P_T s=55602a6f E=sp_i_p t=1791630717951",
      "[PGO] P_T s=55602a6f E=st_a t=1791630719612",
    ]);
  });

  it("handles errors clearly without polluting the console with polling loops", () => {
    const stderr: string[] = [];
    const logger = new AgentLogger({
      level: "normal",
      stderr: (m) => stderr.push(m),
    });

    logger.handleDaemonStatus(
      "Error: SumatraPDF failed with exit code 1 on order 55602a6f-8310-4813-8096-98408f5ea97f",
    );

    expect(stderr).toEqual([
      "[PGO] Error: SumatraPDF failed with exit code 1 on order 55602a6f",
    ]);
    // Full UUID was shortened to 8 characters for privacy
    expect(stderr[0]).not.toContain("55602a6f-8310-4813-8096-98408f5ea97f");
  });
});
