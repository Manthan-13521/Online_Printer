import { sanitizeLogContent } from "../support/support-package.js";

export type LogLevel = "normal" | "debug";

/**
 * Type-safe abbreviations for high-frequency internal print timing events.
 * Preserves diagnostic meaning while drastically minimizing console noise.
 */
export const TIMING_EVENT_ABBREVIATIONS: Record<string, string> = {
  preparation_start: "p_s",
  submission_start: "sub_s",
  sumatra_start: "sum_s",
  spool_captured: "sp_c",
  adapter_return: "ad_r",
  spool_identity_persisted: "sp_i_p",
  step_acknowledged: "st_a",
  completion_reported: "c_r",
};

/**
 * Abbreviate timing event in a centralized, type-safe manner.
 * Unknown events are preserved verbatim for diagnostic accuracy.
 */
export function abbreviateTimingEvent(event: string): string {
  return TIMING_EVENT_ABBREVIATIONS[event] ?? event;
}

/**
 * Shorten an identifier (UUID or order ID) to the first 8 characters
 * to prevent leaking full identifiers in console output.
 */
export function shortenIdentifier(id: string): string {
  if (!id) return "";
  return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * Resolves the active log level from an environment variable or explicit setting.
 */
export function resolveLogLevel(envValue?: string): LogLevel {
  const normalized = (envValue ?? process.env.PRINTGO_LOG_LEVEL ?? "")
    .toLowerCase()
    .trim();
  return normalized === "debug" ? "debug" : "normal";
}

/**
 * Redacts private local user paths and full order IDs from console output,
 * on top of standard PrintGo data sanitization.
 */
export function sanitizeConsoleOutput(raw: string): string {
  let text = sanitizeLogContent(raw);

  // Redact Windows and Unix local user directories
  text = text
    .replace(/[a-zA-Z]:\\Users\\[^\\]+(?:\\[^\s"']*)?/gi, "[PATH]")
    .replace(/\/(?:Users|home)\/[^/\s"']+(?:\/[^\s"']*)?/gi, "[PATH]");

  // Shorten full UUIDs to 8 characters to prevent exposing full identifiers
  text = text.replace(
    /\b([0-9a-fA-F]{8})-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
    "$1",
  );

  return text;
}

/**
 * Format a timing debug line in compact technical notation.
 * Example: [PGO] P_T s=55602a6f E=p_s t=1791630710959
 */
export function formatTimingDebug(
  stepId: string,
  event: string,
  atMs: number | string,
): string {
  const s = shortenIdentifier(stepId);
  const E = abbreviateTimingEvent(event);
  return `[PGO] P_T s=${s} E=${E} t=${atMs}`;
}

export interface AgentLoggerOptions {
  level?: LogLevel;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
}

/**
 * Centralized, production-grade console logger for the PrintGo Windows Agent.
 *
 * Normal mode (default):
 *   [PGO] Starting...
 *   [PGO] Connected
 *   [PGO] Printer ready
 *   [PGO] Printing...
 *   [PGO] Print completed
 *
 * Debug mode (PRINTGO_LOG_LEVEL=debug):
 *   [PGO] P_T s=55602a6f E=p_s t=1791630710959
 *   [PGO] P_T s=55602a6f E=sp_c t=1791630717114
 */
export class AgentLogger {
  private level: LogLevel;
  private isStarted = false;
  private isConnected = false;
  private isPrinterReady = false;
  private readonly stdout: (message: string) => void;
  private readonly stderr: (message: string) => void;

  constructor(options?: AgentLoggerOptions) {
    this.level = options?.level ?? resolveLogLevel();
    this.stdout =
      options?.stdout ?? ((message: string) => console.log(message));
    this.stderr =
      options?.stderr ?? ((message: string) => console.error(message));
  }

  get isDebug(): boolean {
    return this.level === "debug";
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  starting(): void {
    if (!this.isStarted) {
      this.isStarted = true;
      this.stdout("[PGO] Starting...");
    }
  }

  connected(): void {
    if (!this.isConnected) {
      this.isConnected = true;
      this.stdout("[PGO] Connected");
    }
  }

  setDisconnected(): void {
    this.isConnected = false;
  }

  printerReady(): void {
    if (!this.isPrinterReady) {
      this.isPrinterReady = true;
      this.stdout("[PGO] Printer ready");
    }
  }

  setPrinterNotReady(): void {
    this.isPrinterReady = false;
  }

  printing(): void {
    this.stdout("[PGO] Printing...");
  }

  printCompleted(): void {
    this.stdout("[PGO] Print completed");
  }

  /**
   * Log timing telemetry.
   * In NORMAL mode, returns immediately with ZERO string formatting or memory allocation.
   */
  timing(stepId: string, event: string, atMs: number | string): void {
    if (!this.isDebug) return;
    this.stdout(formatTimingDebug(stepId, event, atMs));
  }

  debug(message: string): void {
    if (!this.isDebug) return;
    this.stdout(`[PGO] ${sanitizeConsoleOutput(message)}`);
  }

  info(message: string): void {
    this.stdout(`[PGO] ${sanitizeConsoleOutput(message)}`);
  }

  warn(message: string): void {
    this.stderr(`[PGO] ⚠️ ${sanitizeConsoleOutput(message)}`);
  }

  error(err: unknown): void {
    let rawMessage = err instanceof Error ? err.message : String(err);
    rawMessage = rawMessage.replace(/^(?:\[ERROR\]\s*|Error:\s*)/i, "");
    this.stderr(`[PGO] Error: ${sanitizeConsoleOutput(rawMessage)}`);
  }

  /**
   * Dispatches messages emitted by the internal daemon loop or executor.
   */
  handleDaemonStatus(rawMessage: string): void {
    // 1. High-frequency PRINT_TIMING telemetry:
    // Fast-path exit in normal mode to avoid formatting disabled debug messages.
    if (rawMessage.startsWith("PRINT_TIMING ")) {
      if (!this.isDebug) return;
      const match = /PRINT_TIMING step=([^\s]+) event=([^\s]+) atMs=(\d+)/.exec(
        rawMessage,
      );
      if (match && match[1] && match[2] && match[3]) {
        this.timing(match[1], match[2], match[3]);
      }
      return;
    }

    // 2. High-level agent lifecycle events
    if (rawMessage.startsWith("Starting heartbeat daemon for agent ")) {
      this.starting();
      return;
    }

    if (rawMessage === "AGENT_CONNECTED") {
      this.connected();
      return;
    }

    if (rawMessage === "PRINTER_READY") {
      this.printerReady();
      return;
    }

    if (rawMessage === "PRINT_EVENT printing") {
      this.printing();
      return;
    }

    if (rawMessage === "PRINT_EVENT completed") {
      this.printCompleted();
      return;
    }

    // 3. Errors and warnings
    if (
      rawMessage.startsWith("[ERROR]") ||
      rawMessage.startsWith("Error:") ||
      rawMessage.includes("fatal") ||
      rawMessage.includes("failed")
    ) {
      const clean = rawMessage.replace(/^\[ERROR\]\s*/, "");
      this.error(clean);
      return;
    }

    if (rawMessage.startsWith("WARNING:")) {
      const clean = rawMessage.replace(/^WARNING:\s*/, "");
      this.warn(clean);
      return;
    }

    // 4. In normal mode, repetitive polling/heartbeats and low-level daemon diagnostics are suppressed.
    if (!this.isDebug) return;

    this.debug(rawMessage);
  }
}

/**
 * Singleton instance for shared agent console logging.
 */
let defaultLogger: AgentLogger | null = null;

export function getAgentLogger(): AgentLogger {
  if (!defaultLogger) {
    defaultLogger = new AgentLogger();
  }
  return defaultLogger;
}

export function resetAgentLoggerForTesting(logger?: AgentLogger): void {
  defaultLogger = logger ?? null;
}
