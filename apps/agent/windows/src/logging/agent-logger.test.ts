import { describe, expect, it } from "vitest";
import {
  AgentLogger,
  abbreviateTimingEvent,
  formatTimingDebug,
  resolveLogLevel,
  sanitizeConsoleOutput,
  shortenIdentifier,
} from "./agent-logger.js";

describe("AgentLogger - Compact Logging", () => {
  describe("abbreviateTimingEvent", () => {
    it("abbreviates known timing events accurately", () => {
      expect(abbreviateTimingEvent("preparation_start")).toBe("p_s");
      expect(abbreviateTimingEvent("submission_start")).toBe("sub_s");
      expect(abbreviateTimingEvent("sumatra_start")).toBe("sum_s");
      expect(abbreviateTimingEvent("spool_captured")).toBe("sp_c");
      expect(abbreviateTimingEvent("adapter_return")).toBe("ad_r");
      expect(abbreviateTimingEvent("spool_identity_persisted")).toBe("sp_i_p");
      expect(abbreviateTimingEvent("step_acknowledged")).toBe("st_a");
      expect(abbreviateTimingEvent("completion_reported")).toBe("c_r");
    });

    it("preserves unknown timing events for diagnostic safety", () => {
      expect(abbreviateTimingEvent("custom_driver_hook")).toBe(
        "custom_driver_hook",
      );
      expect(abbreviateTimingEvent("spooler_timeout_retry")).toBe(
        "spooler_timeout_retry",
      );
    });
  });

  describe("shortenIdentifier", () => {
    it("shortens UUIDs to the first 8 characters", () => {
      expect(shortenIdentifier("55602a6f-8310-4813-8096-98408f5ea97f")).toBe(
        "55602a6f",
      );
      expect(shortenIdentifier("040ba306-132b-4d5d-b9d7-0fbc10959e12")).toBe(
        "040ba306",
      );
    });

    it("handles short or empty identifiers safely", () => {
      expect(shortenIdentifier("short")).toBe("short");
      expect(shortenIdentifier("")).toBe("");
    });
  });

  describe("resolveLogLevel", () => {
    it("defaults to normal mode", () => {
      expect(resolveLogLevel()).toBe("normal");
      expect(resolveLogLevel("")).toBe("normal");
      expect(resolveLogLevel("info")).toBe("normal");
    });

    it("detects debug mode case-insensitively", () => {
      expect(resolveLogLevel("debug")).toBe("debug");
      expect(resolveLogLevel("DEBUG")).toBe("debug");
      expect(resolveLogLevel("  Debug  ")).toBe("debug");
    });
  });

  describe("sanitizeConsoleOutput", () => {
    it("redacts customer phone numbers, names, and emails", () => {
      const sanitized = sanitizeConsoleOutput(
        'customerName: "Ramesh Kumar" phone: +919876543210 email: ramesh@example.com',
      );
      expect(sanitized).not.toContain("Ramesh Kumar");
      expect(sanitized).not.toContain("9876543210");
      expect(sanitized).not.toContain("ramesh@example.com");
      expect(sanitized).toContain("[REDACTED_PHONE]");
      expect(sanitized).toContain("[REDACTED_EMAIL]");
    });

    it("redacts credentials, bearer tokens, and secrets", () => {
      const sanitized = sanitizeConsoleOutput(
        "bearer secretTokenValue123456 agentSecret: 'superSecretKey123'",
      );
      expect(sanitized).not.toContain("secretTokenValue123456");
      expect(sanitized).not.toContain("superSecretKey123");
      expect(sanitized).toContain("[REDACTED_TOKEN]");
      expect(sanitized).toContain("[REDACTED_AGENT_SECRET]");
    });

    it("redacts local private paths on Windows and macOS/Linux", () => {
      const winPath =
        "Failed reading C:\\Users\\Administrator\\AppData\\Local\\PrintGo\\daemon.log";
      const macPath = "Opened /Users/bhavesh/Documents/invoice.pdf";
      expect(sanitizeConsoleOutput(winPath)).toContain("[PATH]");
      expect(sanitizeConsoleOutput(winPath)).not.toContain("Administrator");
      expect(sanitizeConsoleOutput(macPath)).toContain("[PATH]");
      expect(sanitizeConsoleOutput(macPath)).not.toContain("bhavesh");
    });

    it("shortens full UUIDs in console output", () => {
      const log =
        "Processing order 55602a6f-8310-4813-8096-98408f5ea97f step 040ba306-132b-4d5d-b9d7-0fbc10959e12";
      const sanitized = sanitizeConsoleOutput(log);
      expect(sanitized).not.toContain("55602a6f-8310-4813-8096-98408f5ea97f");
      expect(sanitized).toContain("55602a6f");
      expect(sanitized).toContain("040ba306");
    });
  });

  describe("formatTimingDebug", () => {
    it("formats compact technical logs matching prompt specifications", () => {
      expect(
        formatTimingDebug(
          "55602a6f-8310-4813-8096-98408f5ea97f",
          "preparation_start",
          1791630710959,
        ),
      ).toBe("[PGO] P_T s=55602a6f E=p_s t=1791630710959");

      expect(
        formatTimingDebug(
          "55602a6f-8310-4813-8096-98408f5ea97f",
          "spool_captured",
          1791630717114,
        ),
      ).toBe("[PGO] P_T s=55602a6f E=sp_c t=1791630717114");
    });
  });

  describe("Normal Mode (Default)", () => {
    it("displays only important lifecycle events with [PGO] prefix", () => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const logger = new AgentLogger({
        level: "normal",
        stdout: (m) => stdout.push(m),
        stderr: (m) => stderr.push(m),
      });

      logger.starting();
      logger.connected();
      logger.printerReady();
      logger.printing();
      logger.printCompleted();

      expect(stdout).toEqual([
        "[PGO] Starting...",
        "[PGO] Connected",
        "[PGO] Printer ready",
        "[PGO] Printing...",
        "[PGO] Print completed",
      ]);
      expect(stderr).toHaveLength(0);
    });

    it("suppresses PRINT_TIMING telemetry in normal mode", () => {
      const stdout: string[] = [];
      const logger = new AgentLogger({
        level: "normal",
        stdout: (m) => stdout.push(m),
      });

      logger.handleDaemonStatus(
        "PRINT_TIMING step=55602a6f-8310-4813-8096-98408f5ea97f event=preparation_start atMs=1791630710959",
      );
      logger.handleDaemonStatus(
        "PRINT_TIMING step=55602a6f-8310-4813-8096-98408f5ea97f event=spool_captured atMs=1791630717114",
      );

      expect(stdout).toHaveLength(0);
    });

    it("deduplicates Connected and Printer ready to avoid repetitive polling messages", () => {
      const stdout: string[] = [];
      const logger = new AgentLogger({
        level: "normal",
        stdout: (m) => stdout.push(m),
      });

      logger.connected();
      logger.connected();
      logger.connected();

      logger.printerReady();
      logger.printerReady();

      expect(stdout).toEqual(["[PGO] Connected", "[PGO] Printer ready"]);
    });

    it("displays errors and warnings clearly", () => {
      const stderr: string[] = [];
      const logger = new AgentLogger({
        level: "normal",
        stderr: (m) => stderr.push(m),
      });

      logger.warn("Printer paper low on tray 1");
      logger.error(new Error("Spooler service unreachable"));

      expect(stderr).toEqual([
        "[PGO] ⚠️ Printer paper low on tray 1",
        "[PGO] Error: Spooler service unreachable",
      ]);
    });

    it("suppresses internal debug messages in normal mode", () => {
      const stdout: string[] = [];
      const logger = new AgentLogger({
        level: "normal",
        stdout: (m) => stdout.push(m),
      });

      logger.debug("Executing heartbeat pulse");
      logger.handleDaemonStatus("Received instant wake-up notification");
      logger.handleDaemonStatus(
        "Physical device 'USB001' is busy with order 123",
      );

      expect(stdout).toHaveLength(0);
    });
  });

  describe("Debug Mode (PRINTGO_LOG_LEVEL=debug)", () => {
    it("outputs compact technical timing logs in debug mode", () => {
      const stdout: string[] = [];
      const logger = new AgentLogger({
        level: "debug",
        stdout: (m) => stdout.push(m),
      });

      logger.handleDaemonStatus(
        "PRINT_TIMING step=55602a6f-8310-4813-8096-98408f5ea97f event=preparation_start atMs=1791630710959",
      );
      logger.handleDaemonStatus(
        "PRINT_TIMING step=55602a6f-8310-4813-8096-98408f5ea97f event=spool_captured atMs=1791630717114",
      );

      expect(stdout).toEqual([
        "[PGO] P_T s=55602a6f E=p_s t=1791630710959",
        "[PGO] P_T s=55602a6f E=sp_c t=1791630717114",
      ]);
    });

    it("preserves unknown events in debug mode", () => {
      const stdout: string[] = [];
      const logger = new AgentLogger({
        level: "debug",
        stdout: (m) => stdout.push(m),
      });

      logger.handleDaemonStatus(
        "PRINT_TIMING step=040ba306-132b-4d5d-b9d7-0fbc10959e12 event=custom_preflight_hook atMs=1791630720000",
      );

      expect(stdout).toEqual([
        "[PGO] P_T s=040ba306 E=custom_preflight_hook t=1791630720000",
      ]);
    });

    it("displays diagnostics in debug mode with [PGO] prefix", () => {
      const stdout: string[] = [];
      const logger = new AgentLogger({
        level: "debug",
        stdout: (m) => stdout.push(m),
      });

      logger.debug("WebSocket connection opened on endpoint /api/agent/ws");

      expect(stdout).toEqual([
        "[PGO] WebSocket connection opened on endpoint /api/agent/ws",
      ]);
    });
  });
});
