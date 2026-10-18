import type {
  AdminAgentDetails,
  AdminPrinterDetails,
  AdminTestPrintDetails,
} from "@printgo/api-contract";
import { formatRelativeTime } from "../utils/formatters";
import {
  formatSimpleCapabilities,
  friendlyPrinterMessage,
  isVirtualPrinter,
} from "./printer-helpers";

export interface PrinterCardProps {
  printer: AdminPrinterDetails;
  isDefault: boolean;
  isAgentOnline: boolean;
  activeAgent: AdminAgentDetails | null;
  testPrint: AdminTestPrintDetails | null | undefined;
  isTesting: boolean;
  togglingPrinterId: string | null;
  settingDefaultId: string | null;
  checkingHealthId: string | null;
  requestingTestPrintId: string | null;
  displayedPrinters: AdminPrinterDetails[];
  onOpenTestPrintMenu: (printer: AdminPrinterDetails) => void;
  onOpenSettings: (printer: AdminPrinterDetails) => void;
  onOpenVerification: (printer: AdminPrinterDetails) => void;
  onRequestTestPrint: (
    printer: AdminPrinterDetails,
    type: "STANDARD",
  ) => void | Promise<void>;
  onTogglePrinter: (printer: AdminPrinterDetails) => void | Promise<void>;
  onSetDefault: (printer: AdminPrinterDetails) => void | Promise<void>;
  onCheckHealth: (printerId: string) => void | Promise<void>;
}

export function PrinterCard({
  printer: p,
  isDefault,
  isAgentOnline,
  activeAgent,
  testPrint: tp,
  isTesting,
  togglingPrinterId,
  settingDefaultId,
  checkingHealthId,
  requestingTestPrintId,
  displayedPrinters,
  onOpenTestPrintMenu,
  onOpenSettings,
  onOpenVerification,
  onRequestTestPrint,
  onTogglePrinter,
  onSetDefault,
  onCheckHealth,
}: PrinterCardProps) {
  const hasProblem =
    p.isPaused ||
    p.status === "BLOCKED" ||
    p.status === "ERROR" ||
    p.status === "OFFLINE" ||
    p.status === "UNKNOWN";

  return (
    <div
      style={{
        border: isDefault
          ? "2px solid #2563eb"
          : "1px solid var(--border-color, #cbd5e1)",
        backgroundColor: p.enabled
          ? isDefault
            ? "#f8faff"
            : "#ffffff"
          : "#f8fafc",
        borderRadius: "10px",
        padding: "1.25rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.85rem",
        boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
        opacity: p.enabled ? 1 : 0.8,
      }}
    >
      {/* Card Header: Name + Status Badge */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "0.5rem",
        }}
      >
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              flexWrap: "wrap",
            }}
          >
            <h3
              style={{
                margin: 0,
                fontSize: "1.15rem",
                fontWeight: 700,
                color: "var(--text-primary, #0f172a)",
              }}
            >
              {p.displayName}
            </h3>
            {isDefault && (
              <span
                style={{
                  fontSize: "0.75rem",
                  fontWeight: 700,
                  backgroundColor: "#dbeafe",
                  color: "#1d4ed8",
                  padding: "0.15rem 0.5rem",
                  borderRadius: "9999px",
                }}
              >
                Default
              </span>
            )}
            {(p.priority ?? 0) > 0 && (
              <span
                style={{
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  backgroundColor: "#fef3c7",
                  color: "#b45309",
                  padding: "0.15rem 0.5rem",
                  borderRadius: "9999px",
                }}
              >
                Priority {p.priority}
              </span>
            )}
            {p.physicalDeviceId && (
              <span
                style={{
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  backgroundColor: "#f1f5f9",
                  color: "#475569",
                  padding: "0.15rem 0.5rem",
                  borderRadius: "9999px",
                }}
                title={`Physical Connection: ${p.physicalDeviceId === "machine-2" ? "Machine 2" : p.physicalDeviceId === "machine-3" ? "Machine 3" : p.physicalDeviceId === "machine-4" ? "Machine 4" : p.physicalDeviceId === "machine-5" ? "Machine 5" : p.physicalDeviceId}`}
              >
                {p.physicalDeviceId === "machine-2"
                  ? "Machine 2"
                  : p.physicalDeviceId === "machine-3"
                    ? "Machine 3"
                    : p.physicalDeviceId === "machine-4"
                      ? "Machine 4"
                      : p.physicalDeviceId === "machine-5"
                        ? "Machine 5"
                        : p.physicalDeviceId}
              </span>
            )}
            {!p.enabled && (
              <span
                style={{
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  backgroundColor: "#e2e8f0",
                  color: "#475569",
                  padding: "0.15rem 0.5rem",
                  borderRadius: "9999px",
                }}
              >
                Disabled
              </span>
            )}
          </div>
          <div
            style={{
              marginTop: "0.4rem",
              display: "flex",
              flexWrap: "wrap",
              gap: "0.4rem",
              alignItems: "center",
            }}
          >
            {p.verifiedCapabilities &&
            !p.verifiedCapabilities.requiresReview ? (
              <span
                style={{
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  backgroundColor: "#ecfdf5",
                  color: "#065f46",
                  border: "1px solid #a7f3d0",
                  padding: "0.15rem 0.55rem",
                  borderRadius: "6px",
                }}
              >
                ✓ Verified:{" "}
                {[
                  p.verifiedCapabilities.verified.bw && "B&W",
                  p.verifiedCapabilities.verified.color && "Color",
                  p.verifiedCapabilities.verified.duplex && "Duplex",
                  p.verifiedCapabilities.verified.a4 && "A4",
                  p.verifiedCapabilities.verified.a3 && "A3",
                ]
                  .filter(Boolean)
                  .join(" • ")}
              </span>
            ) : (
              <span
                style={{
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  backgroundColor: "#fffbeb",
                  color: "#92400e",
                  border: "1px solid #fde68a",
                  padding: "0.15rem 0.55rem",
                  borderRadius: "6px",
                }}
              >
                {p.verifiedCapabilities?.requiresReview
                  ? "⚠ Hardware/Driver Changed — Needs Re-Verification"
                  : `⚠ Unverified: ${formatSimpleCapabilities(p.capabilities)}`}
              </span>
            )}
            {p.portName && (
              <span
                style={{
                  fontSize: "0.72rem",
                  color: "#64748b",
                }}
              >
                Port: {p.portName}
              </span>
            )}
            {p.fallbackPrinterId && (
              <span
                style={{
                  fontSize: "0.72rem",
                  color: "#64748b",
                }}
              >
                Fallback:{" "}
                {displayedPrinters.find((dp) => dp.id === p.fallbackPrinterId)
                  ?.displayName ?? "Configured"}
                {p.autoFallbackEnabled ? " (Auto)" : ""}
              </span>
            )}
          </div>
        </div>

        {/* Status Badge */}
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.35rem",
            padding: "0.25rem 0.65rem",
            borderRadius: "9999px",
            fontSize: "0.775rem",
            fontWeight: 600,
            whiteSpace: "nowrap",
            backgroundColor: !p.enabled
              ? "#e2e8f0"
              : !isAgentOnline
                ? "#fee2e2"
                : p.isPaused
                  ? "#fef3c7"
                  : p.status === "ONLINE"
                    ? "#dcfce7"
                    : "#fee2e2",
            color: !p.enabled
              ? "#475569"
              : !isAgentOnline
                ? "#991b1b"
                : p.isPaused
                  ? "#92400e"
                  : p.status === "ONLINE"
                    ? "#15803d"
                    : "#991b1b",
          }}
        >
          <span style={{ fontSize: "0.6rem" }}>●</span>
          {!p.enabled
            ? "Disabled"
            : !isAgentOnline
              ? "Agent Offline"
              : p.isPaused
                ? "Paused"
                : p.status === "ONLINE"
                  ? "Ready"
                  : p.status === "OFFLINE"
                    ? "Offline"
                    : p.status}
        </span>
      </div>

      {/* Problem Alert Box */}
      {hasProblem && (
        <div
          style={{
            padding: "0.6rem 0.75rem",
            backgroundColor: "#fef3c7",
            border: "1px solid #f59e0b",
            borderRadius: "6px",
            fontSize: "0.825rem",
            color: "#78350f",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "0.5rem",
          }}
        >
          <div>
            <strong>Problem: </strong>
            {friendlyPrinterMessage(p.status, p.statusReason || p.pausedReason)}
          </div>
          <button
            type="button"
            className="secondary-button compact"
            disabled={checkingHealthId === p.id}
            onClick={() => void onCheckHealth(p.id)}
            style={{ fontSize: "0.775rem" }}
          >
            {checkingHealthId === p.id ? "Checking…" : "Check Again"}
          </button>
        </div>
      )}

      {/* Test Print Banner */}
      {tp && (
        <div
          style={{
            padding: "0.5rem 0.75rem",
            borderRadius: "6px",
            fontSize: "0.8rem",
            backgroundColor:
              tp.status === "SUCCEEDED"
                ? "#dcfce7"
                : tp.status === "BLOCKED"
                  ? "#fef3c7"
                  : tp.status === "FAILED" || tp.status === "EXPIRED"
                    ? "#fee2e2"
                    : "#e0f2fe",
            color:
              tp.status === "SUCCEEDED"
                ? "#15803d"
                : tp.status === "BLOCKED"
                  ? "#92400e"
                  : tp.status === "FAILED" || tp.status === "EXPIRED"
                    ? "#991b1b"
                    : "#0369a1",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            {requestingTestPrintId === p.id ? (
              <span>Sending test page…</span>
            ) : tp.status === "PENDING" ? (
              <span>Waiting for Agent…</span>
            ) : tp.status === "CLAIMED" ? (
              <span>Agent claimed command…</span>
            ) : tp.status === "SUBMITTED" ? (
              <span>
                Submitted to printer…
                {tp.spoolerJobId ? ` (Job #${tp.spoolerJobId})` : ""}
              </span>
            ) : tp.status === "SUCCEEDED" ? (
              <span>
                Test page submitted successfully.{" "}
                <button
                  type="button"
                  className="text-button"
                  style={{
                    color: "#15803d",
                    fontWeight: 700,
                    textDecoration: "underline",
                    cursor: "pointer",
                  }}
                  onClick={() => onOpenVerification(p)}
                >
                  Verify Output & Certify →
                </button>
              </span>
            ) : tp.status === "BLOCKED" ? (
              <span>
                Printer needs attention:{" "}
                {friendlyPrinterMessage(tp.failureCode, tp.failureDetail)}
              </span>
            ) : tp.status === "FAILED" ? (
              <span>
                Test print failed: {tp.failureDetail || "Unknown error"}
              </span>
            ) : (
              <span>Test print timed out.</span>
            )}
          </div>
          {tp.finishedAt ? (
            <span style={{ fontSize: "0.7rem", opacity: 0.8 }}>
              {formatRelativeTime(tp.finishedAt)}
            </span>
          ) : null}
        </div>
      )}

      {/* Action Controls */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: "auto",
          paddingTop: "0.6rem",
          borderTop: "1px solid var(--border-color, #e2e8f0)",
          flexWrap: "wrap",
          gap: "0.5rem",
        }}
      >
        <div
          style={{
            display: "flex",
            gap: "0.4rem",
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            className="secondary-button compact"
            disabled={!activeAgent?.isOnline || Boolean(isTesting)}
            onClick={() => void onRequestTestPrint(p, "STANDARD")}
            title={!activeAgent?.isOnline ? "Agent is offline" : undefined}
          >
            {isTesting
              ? "Testing…"
              : tp
                ? "Try Test Print Again"
                : "Test Print"}
          </button>
          <button
            type="button"
            className="secondary-button compact"
            disabled={!activeAgent?.isOnline || Boolean(isTesting)}
            onClick={() => onOpenTestPrintMenu(p)}
            title="Choose diagnostic test type (Color, Duplex, A3, Standard)"
            style={{
              paddingLeft: "0.35rem",
              paddingRight: "0.35rem",
            }}
          >
            ▾
          </button>
          <button
            type="button"
            className="primary-button compact"
            style={{
              backgroundColor:
                p.verifiedCapabilities && !p.verifiedCapabilities.requiresReview
                  ? "#059669"
                  : "#d97706",
              borderColor: "transparent",
            }}
            onClick={() => onOpenVerification(p)}
          >
            {p.verifiedCapabilities && !p.verifiedCapabilities.requiresReview
              ? "Verify Hardware"
              : "Verify Hardware ⚠"}
          </button>
          <button
            type="button"
            className="secondary-button compact"
            onClick={() => onOpenSettings(p)}
          >
            Settings
          </button>
        </div>

        <div
          style={{
            display: "flex",
            gap: "0.4rem",
            alignItems: "center",
          }}
        >
          {!isDefault && p.enabled && !isVirtualPrinter(p) && (
            <button
              type="button"
              className="text-button"
              style={{
                fontSize: "0.8rem",
                color: "#2563eb",
                cursor: "pointer",
              }}
              disabled={settingDefaultId === p.id}
              onClick={() => void onSetDefault(p)}
            >
              {settingDefaultId === p.id ? "Setting…" : "Set Default"}
            </button>
          )}
          <button
            type="button"
            className="secondary-button compact"
            disabled={togglingPrinterId === p.id}
            onClick={() => void onTogglePrinter(p)}
          >
            {p.enabled ? "Disable" : "Enable"}
          </button>
        </div>
      </div>
    </div>
  );
}
