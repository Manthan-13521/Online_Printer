import { startVisiblePolling } from "../../polling";
import type {
  AdminAgentDetails,
  AdminPrinterDetails,
  AdminTestPrintDetails,
} from "@printgo/api-contract";
import { useEffect, useState } from "react";

import { adminApi, AdminApiError, friendlyAdminError } from "./api";
import {
  getWindowsAgentReleaseConfig,
  buildAgentConnectionUrl,
} from "./agent-download";

function formatRelativeTime(dateString: string | null): string {
  if (!dateString) return "Never";
  const date = new Date(dateString);
  const now = new Date();
  const diffSeconds = Math.round((now.getTime() - date.getTime()) / 1000);

  if (diffSeconds < 5) return "Just now";
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return date.toLocaleDateString();
}

export function PrinterPage({
  onSessionExpired,
}: {
  onSessionExpired: (message: string) => void;
}) {
  const [agents, setAgents] = useState<AdminAgentDetails[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Pair code modal/banner state
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [pairExpiresAt, setPairExpiresAt] = useState<string | null>(null);
  const [generatingCode, setGeneratingCode] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  // Action busy states
  const [revokingAgentId, setRevokingAgentId] = useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [togglingPrinterId, setTogglingPrinterId] = useState<string | null>(
    null,
  );

  // Phase 8: Test print tracking per printer
  const [testPrints, setTestPrints] = useState<
    Record<string, AdminTestPrintDetails | null>
  >({});
  const [requestingTestPrintId, setRequestingTestPrintId] = useState<
    string | null
  >(null);
  const [settingDefaultId, setSettingDefaultId] = useState<string | null>(null);
  const [checkingHealthId, setCheckingHealthId] = useState<string | null>(null);

  async function handleCheckHealth(printerId: string) {
    setCheckingHealthId(printerId);
    setError(null);
    setNotice(null);
    try {
      const response = await adminApi.checkPrinterHealth(printerId);
      if (response.ok) {
        if (response.data.isPaused) {
          setError(response.data.message);
        } else {
          setNotice(response.data.message);
        }
        await loadPrinters();
      }
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    } finally {
      setCheckingHealthId(null);
    }
  }

  async function loadPrinters(isManual = false) {
    if (isManual) setRefreshing(true);
    setError(null);
    try {
      const response = await adminApi.getPrinters();
      if (response.ok) {
        setAgents(response.data.agents);
        setTestPrints((prev) => {
          const next = { ...prev };
          for (const agent of response.data.agents) {
            for (const printer of agent.printers) {
              if (printer.latestTestPrint) {
                next[printer.id] = printer.latestTestPrint;
              }
            }
          }
          return next;
        });
      }
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  const activeTestPrinterIds = Object.entries(testPrints)
    .filter(
      ([, tp]) =>
        tp &&
        (tp.status === "PENDING" ||
          tp.status === "CLAIMED" ||
          tp.status === "SUBMITTED"),
    )
    .map(([printerId]) => printerId)
    .sort();
  const activeTestPrinterKey = activeTestPrinterIds.join("\n");

  useEffect(() => {
    if (!activeTestPrinterKey) return;
    const printerIds = activeTestPrinterKey.split("\n");
    const snapshots = new Map<string, string>();
    return startVisiblePolling(
      async () => {
        let changed = false;
        await Promise.all(
          printerIds.map(async (printerId) => {
            try {
              const res = await adminApi.getTestPrintStatus(printerId);
              if (!res.ok) return;
              const snapshot = JSON.stringify(res.data.testPrint);
              changed ||= snapshots.get(printerId) !== snapshot;
              snapshots.set(printerId, snapshot);
              setTestPrints((prev) => ({
                ...prev,
                [printerId]: res.data.testPrint,
              }));
            } catch {
              // A diagnostic-status refresh is informational. The Agent and the
              // command record remain authoritative and the next poll retries.
            }
          }),
        );
        return changed;
      },
      2_000,
      5_000,
    );
  }, [activeTestPrinterKey]);

  useEffect(() => {
    return startVisiblePolling(loadPrinters, 30_000);
  }, []);

  async function handleGeneratePairCode() {
    if (generatingCode) return;
    setGeneratingCode(true);
    setError(null);
    setNotice(null);
    try {
      const res = await adminApi.createPairCode();
      if (res.ok) {
        setPairCode(res.data.pairCode);
        setPairExpiresAt(res.data.expiresAt);
        setCopiedCode(false);
      }
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    } finally {
      setGeneratingCode(false);
    }
  }

  async function handleRevokeAgent(agentId: string) {
    setRevokingAgentId(agentId);
    setError(null);
    setNotice(null);
    try {
      const res = await adminApi.revokeAgent(agentId);
      if (res.ok) {
        setConfirmRevokeId(null);
        setNotice("Agent connection revoked.");
        await loadPrinters();
      }
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    } finally {
      setRevokingAgentId(null);
    }
  }

  async function handleTogglePrinter(printer: AdminPrinterDetails) {
    setTogglingPrinterId(printer.id);
    setError(null);
    setNotice(null);
    const newEnabled = !printer.enabled;
    try {
      const res = await adminApi.togglePrinter(printer.id, newEnabled);
      if (res.ok) {
        setAgents((prev) =>
          prev.map((agent) => ({
            ...agent,
            printers: agent.printers.map((p) =>
              p.id === printer.id ? { ...p, enabled: res.data.enabled } : p,
            ),
          })),
        );
        setNotice(
          `Printer "${printer.displayName}" ${newEnabled ? "enabled" : "disabled"}.`,
        );
      }
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    } finally {
      setTogglingPrinterId(null);
    }
  }

  async function handleRequestTestPrint(printer: AdminPrinterDetails) {
    setRequestingTestPrintId(printer.id);
    setError(null);
    setNotice(null);
    try {
      const res = await adminApi.requestTestPrint(printer.id);
      if (res.ok) {
        setTestPrints((prev) => ({
          ...prev,
          [printer.id]: res.data.testPrint,
        }));
        setNotice(`Test print requested for "${printer.displayName}".`);
      }
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    } finally {
      setRequestingTestPrintId(null);
    }
  }

  async function handleSetDefaultPrinter(printer: AdminPrinterDetails) {
    setSettingDefaultId(printer.id);
    setError(null);
    setNotice(null);
    try {
      const res = await adminApi.setDefaultPrinter(printer.id);
      if (res.ok) {
        setNotice(
          `Printer "${printer.displayName}" is now the default production printer.`,
        );
        await loadPrinters();
      }
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    } finally {
      setSettingDefaultId(null);
    }
  }

  const connectionLink = pairCode
    ? buildAgentConnectionUrl(
        pairCode,
        String(import.meta.env.VITE_API_BASE_URL || window.location.origin),
      )
    : null;
  function copyPairCode() {
    if (!connectionLink) {
      setError(
        "Your technician must configure a secure shop connection before pairing.",
      );
      return;
    }
    void navigator.clipboard
      .writeText(connectionLink)
      .then(() => {
        setCopiedCode(true);
        setTimeout(() => setCopiedCode(false), 3000);
      })
      .catch(() =>
        setError(
          "The connection link could not be copied. Use Connect This PC instead.",
        ),
      );
  }

  const release = getWindowsAgentReleaseConfig();

  if (loading) {
    return (
      <div className="panel page-loading" aria-busy="true">
        Loading printer configuration…
      </div>
    );
  }

  return (
    <div className="page-stack printer-page">
      <div className="action-row" style={{ alignItems: "flex-start" }}>
        <div>
          <p className="eyebrow">Shop Hardware</p>
          <h1>Printers & Agent</h1>
          <p className="page-intro">
            Connect your shop computer and manage printer readiness for online
            orders.
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button
            className="secondary-button"
            disabled={refreshing}
            onClick={() => void loadPrinters(true)}
            type="button"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <button
            className="primary-button"
            disabled={generatingCode}
            onClick={() => void handleGeneratePairCode()}
            type="button"
          >
            {generatingCode ? "Generating…" : "Add PrintGo Agent"}
          </button>
        </div>
      </div>

      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <section className="panel" aria-labelledby="windows-agent-heading">
        <div className="action-row" style={{ alignItems: "flex-start" }}>
          <div>
            <h2 id="windows-agent-heading">PrintGo Agent for Windows</h2>
            <p className="muted" style={{ margin: "0.25rem 0 0 0" }}>
              Connect this computer to your shop printer.
            </p>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.35rem",
              alignItems: "flex-end",
            }}
          >
            {release.isLive ? (
              <>
                <a
                  href={release.downloadUrl!}
                  download={release.fileName}
                  className="primary-button fit"
                  role="button"
                >
                  Download for Windows
                </a>
                <span
                  style={{
                    fontSize: "0.75rem",
                    color: "var(--text-muted, #64748b)",
                  }}
                >
                  Version: {release.version}
                </span>
                {release.zipDownloadUrl ? (
                  <a
                    href={release.zipDownloadUrl}
                    download="PrintGo-Windows-Test.zip"
                    style={{
                      fontSize: "0.8rem",
                      color: "var(--accent, #0066cc)",
                      textDecoration: "underline",
                    }}
                  >
                    Download complete ZIP package
                  </a>
                ) : null}
              </>
            ) : (
              <button
                type="button"
                className="secondary-button fit"
                disabled
                aria-disabled="true"
                title={release.statusNote}
              >
                Windows installer pending
              </button>
            )}
          </div>
        </div>

        <div
          style={{
            marginTop: "1.25rem",
            borderTop: "1px solid var(--border-color, #e0e0e0)",
            paddingTop: "1rem",
          }}
        >
          <h3 style={{ fontSize: "1rem", margin: "0 0 0.5rem 0" }}>
            Setup Steps:
          </h3>
          <ol
            style={{
              margin: "0",
              paddingLeft: "1.25rem",
              color: "var(--text-muted, #475569)",
              lineHeight: "1.6",
            }}
          >
            <li>
              <strong>Download PrintGo Agent:</strong> Save{" "}
              <code>{release.fileName}</code> onto your shop PC.
              {release.sha256 ? (
                <div
                  style={{
                    fontSize: "0.75rem",
                    marginTop: "0.25rem",
                    color: "var(--text-muted, #64748b)",
                    wordBreak: "break-all",
                  }}
                >
                  SHA-256: <code>{release.sha256}</code>
                </div>
              ) : null}
            </li>
            <li>
              <strong>Install on Windows:</strong> Run the executable on the
              computer connected to your printer.
            </li>
            <li>
              <strong>Create a connection link:</strong> Click "Generate Pairing
              Code" below.
            </li>
            <li>
              <strong>Connect this PC:</strong> Use the connection button, or
              paste the copied connection link into Control Center.
            </li>
            <li>
              <strong>Select & enable detected printer:</strong> Verify your
              printer is listed and toggle it ON.
            </li>
            <li>
              <strong>Run test print:</strong> Send a test page to verify
              hardware readiness.
            </li>
          </ol>
        </div>

        {pairCode ? (
          <div
            style={{
              marginTop: "1.25rem",
              padding: "1rem",
              border: "2px solid var(--accent, #0066cc)",
              borderRadius: "8px",
              backgroundColor: "var(--bg-subtle, #f5f5f5)",
            }}
          >
            <div className="action-row">
              <div>
                <h3 style={{ margin: 0, fontSize: "1.1rem" }}>
                  Agent Pairing Code
                </h3>
                <p className="muted" style={{ margin: "0.25rem 0 0 0" }}>
                  Open this page on your shop PC and connect through Control
                  Center.
                </p>
              </div>
              <button
                className="text-button"
                onClick={() => setPairCode(null)}
                type="button"
              >
                Dismiss
              </button>
            </div>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "1rem",
                margin: "1rem 0",
              }}
            >
              <a
                className="primary-button"
                href={connectionLink ?? undefined}
                aria-disabled={!connectionLink}
                style={{ textDecoration: "none", display: "inline-block" }}
              >
                ⚡ Connect This PC Automatically
              </a>
              <span
                style={{
                  fontFamily: "monospace",
                  fontSize: "1.75rem",
                  fontWeight: "bold",
                  letterSpacing: "0.2em",
                }}
              >
                {pairCode}
              </span>
              <button
                className="secondary-button"
                onClick={copyPairCode}
                type="button"
              >
                {copiedCode ? "Copied!" : "Copy Connection Link"}
              </button>
            </div>
            <p className="field-help" style={{ margin: 0 }}>
              This code expires in 10 minutes (
              {pairExpiresAt
                ? new Date(pairExpiresAt).toLocaleTimeString()
                : "soon"}
              ) and can only be used once.
            </p>
          </div>
        ) : null}
      </section>

      {agents.length === 0 ? (
        <section
          className="panel welcome"
          style={{ textAlign: "center", padding: "3rem 1.5rem" }}
        >
          <h2>No PrintGo Agents Connected</h2>
          <p
            className="muted"
            style={{ maxWidth: "540px", margin: "0.5rem auto 1.5rem auto" }}
          >
            To accept customer print jobs, install the PrintGo Windows Agent on
            your shop computer and pair it with this shop.
          </p>
          <button
            className="primary-button"
            disabled={generatingCode}
            onClick={() => void handleGeneratePairCode()}
            type="button"
          >
            Generate Pairing Code
          </button>
        </section>
      ) : (
        agents.map((agent) => (
          <section
            key={agent.id}
            className="panel"
            aria-labelledby={`agent-title-${agent.id}`}
          >
            <div
              className="action-row"
              style={{
                borderBottom: "1px solid var(--border-color, #e0e0e0)",
                paddingBottom: "1rem",
                marginBottom: "1rem",
              }}
            >
              <div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.75rem",
                  }}
                >
                  <h2 id={`agent-title-${agent.id}`} style={{ margin: 0 }}>
                    {agent.displayName}
                  </h2>
                  <span
                    style={{
                      display: "inline-block",
                      padding: "0.2rem 0.6rem",
                      borderRadius: "12px",
                      fontSize: "0.8rem",
                      fontWeight: 600,
                      backgroundColor: agent.isOnline ? "#e6f4ea" : "#fce8e6",
                      color: agent.isOnline ? "#137333" : "#c5221f",
                    }}
                  >
                    {agent.isOnline ? "ONLINE" : "OFFLINE"}
                  </span>
                </div>
                <p
                  className="muted"
                  style={{ margin: "0.25rem 0 0 0", fontSize: "0.85rem" }}
                >
                  Last heartbeat: {formatRelativeTime(agent.lastHeartbeatAt)}
                  {agent.pairedAt
                    ? ` • Paired: ${new Date(agent.pairedAt).toLocaleDateString()}`
                    : ""}
                </p>
              </div>
              <div>
                {confirmRevokeId === agent.id ? (
                  <div
                    style={{
                      display: "flex",
                      gap: "0.5rem",
                      alignItems: "center",
                    }}
                  >
                    <span style={{ fontSize: "0.85rem", color: "#c5221f" }}>
                      Confirm revoke?
                    </span>
                    <button
                      className="danger-button"
                      disabled={revokingAgentId === agent.id}
                      onClick={() => void handleRevokeAgent(agent.id)}
                      type="button"
                    >
                      {revokingAgentId === agent.id
                        ? "Revoking…"
                        : "Yes, Revoke"}
                    </button>
                    <button
                      className="text-button"
                      onClick={() => setConfirmRevokeId(null)}
                      type="button"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    className="secondary-button"
                    onClick={() => setConfirmRevokeId(agent.id)}
                    type="button"
                  >
                    Revoke Agent
                  </button>
                )}
              </div>
            </div>

            <h3 style={{ fontSize: "1.1rem", marginBottom: "0.75rem" }}>
              Printers ({agent.printers.length})
            </h3>
            {agent.printers.length === 0 ? (
              <p className="muted">No printers reported by this agent yet.</p>
            ) : (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "1rem",
                }}
              >
                {agent.printers.map((printer) => {
                  const isBusy = togglingPrinterId === printer.id;
                  const caps = printer.capabilities;
                  const colorText =
                    caps?.colour === true
                      ? "Colour & B/W"
                      : caps?.colour === false
                        ? "Black & White Only"
                        : "Colour: Unknown";
                  const duplexText =
                    caps?.duplex === true
                      ? "Duplex (2-sided)"
                      : caps?.duplex === false
                        ? "1-sided Only"
                        : "Duplex: Unknown";
                  const sizesText =
                    caps?.paperSizes && caps.paperSizes.length > 0
                      ? caps.paperSizes.join(", ")
                      : "Standard Sizes";

                  const testPrint =
                    testPrints[printer.id] ?? printer.latestTestPrint;
                  const isRequesting = requestingTestPrintId === printer.id;
                  const isTestPrintActive =
                    testPrint &&
                    (testPrint.status === "PENDING" ||
                      testPrint.status === "CLAIMED" ||
                      testPrint.status === "SUBMITTED");

                  return (
                    <div
                      key={printer.id}
                      style={{
                        padding: "1rem",
                        border: "1px solid var(--border-color, #e0e0e0)",
                        borderRadius: "8px",
                        display: "flex",
                        flexDirection: "column",
                        gap: "0.75rem",
                        opacity: printer.enabled ? 1 : 0.65,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: "1rem",
                        }}
                      >
                        <div>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "0.5rem",
                            }}
                          >
                            <strong style={{ fontSize: "1.05rem" }}>
                              {printer.displayName}
                            </strong>
                            {printer.isProductionDefault ? (
                              <span
                                style={{
                                  display: "inline-block",
                                  padding: "0.15rem 0.5rem",
                                  borderRadius: "10px",
                                  fontSize: "0.75rem",
                                  fontWeight: 600,
                                  backgroundColor: "#e8f0fe",
                                  color: "#1a73e8",
                                }}
                              >
                                ★ DEFAULT PRODUCTION PRINTER
                              </span>
                            ) : null}
                            {printer.isVirtual ? (
                              <span
                                style={{
                                  display: "inline-block",
                                  padding: "0.15rem 0.5rem",
                                  borderRadius: "10px",
                                  fontSize: "0.75rem",
                                  fontWeight: 600,
                                  backgroundColor: "#f1f3f4",
                                  color: "#5f6368",
                                }}
                              >
                                VIRTUAL QUEUE
                              </span>
                            ) : null}
                            <span
                              style={{
                                display: "inline-block",
                                padding: "0.15rem 0.5rem",
                                borderRadius: "10px",
                                fontSize: "0.75rem",
                                fontWeight: 600,
                                backgroundColor:
                                  printer.status === "ONLINE"
                                    ? "#e6f4ea"
                                    : printer.status === "OFFLINE"
                                      ? "#fce8e6"
                                      : "#feefe3",
                                color:
                                  printer.status === "ONLINE"
                                    ? "#137333"
                                    : printer.status === "OFFLINE"
                                      ? "#c5221f"
                                      : "#b06000",
                              }}
                            >
                              {printer.status}
                            </span>
                          </div>
                          <p
                            className="muted"
                            style={{ margin: "0.2rem 0", fontSize: "0.85rem" }}
                          >
                            Windows Queue:{" "}
                            <code>{printer.windowsPrinterName}</code>
                            {printer.portName
                              ? ` • Port: ${printer.portName}`
                              : ""}
                            {printer.statusReason
                              ? ` • Notice: ${printer.statusReason}`
                              : ""}
                          </p>
                          <p
                            style={{
                              margin: "0.3rem 0 0 0",
                              fontSize: "0.8rem",
                              color: "var(--muted-color, #666)",
                            }}
                          >
                            {colorText} • {duplexText} • Paper: {sizesText}
                          </p>
                          {printer.isPaused ? (
                            <div
                              style={{
                                marginTop: "0.5rem",
                                padding: "0.5rem 0.75rem",
                                backgroundColor: "#fef3c7",
                                border: "1px solid #f59e0b",
                                borderRadius: "6px",
                                display: "flex",
                                flexDirection: "column",
                                gap: "0.3rem",
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  alignItems: "center",
                                  flexWrap: "wrap",
                                  gap: "0.5rem",
                                }}
                              >
                                <strong
                                  style={{
                                    color: "#92400e",
                                    fontSize: "0.85rem",
                                  }}
                                >
                                  ⏸️ PRINTING PAUSED
                                </strong>
                                <button
                                  type="button"
                                  disabled={checkingHealthId === printer.id}
                                  onClick={() =>
                                    void handleCheckHealth(printer.id)
                                  }
                                  className="secondary-button"
                                  style={{
                                    fontSize: "0.8rem",
                                    padding: "0.2rem 0.5rem",
                                  }}
                                >
                                  {checkingHealthId === printer.id
                                    ? "Checking…"
                                    : "Issue Solved / Check Again"}
                                </button>
                              </div>
                              <div
                                style={{
                                  fontSize: "0.8rem",
                                  color: "#78350f",
                                }}
                              >
                                <strong>Reason:</strong>{" "}
                                {printer.pausedReason ??
                                  "Printer problem reported"}
                              </div>
                              {printer.pausedAt ? (
                                <div
                                  style={{
                                    fontSize: "0.75rem",
                                    color: "#92400e",
                                  }}
                                >
                                  <strong>Waiting since:</strong>{" "}
                                  {formatRelativeTime(printer.pausedAt)}
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                        <div
                          style={{
                            display: "flex",
                            gap: "0.5rem",
                            alignItems: "center",
                          }}
                        >
                          {!printer.isVirtual &&
                          !printer.isProductionDefault &&
                          printer.enabled ? (
                            <button
                              className="secondary-button"
                              disabled={settingDefaultId === printer.id}
                              onClick={() =>
                                void handleSetDefaultPrinter(printer)
                              }
                              type="button"
                              title="Set as the default physical printer for all incoming customer orders"
                            >
                              {settingDefaultId === printer.id
                                ? "Setting…"
                                : "Set as Default"}
                            </button>
                          ) : null}
                          {printer.enabled ? (
                            <button
                              className="secondary-button"
                              disabled={
                                isRequesting ||
                                isTestPrintActive ||
                                !agent.isOnline
                              }
                              onClick={() =>
                                void handleRequestTestPrint(printer)
                              }
                              type="button"
                              title={
                                !agent.isOnline ? "Agent is offline" : undefined
                              }
                            >
                              {isRequesting
                                ? "Sending test page…"
                                : isTestPrintActive
                                  ? "Testing in progress…"
                                  : testPrint
                                    ? "Try Test Print Again"
                                    : "Test Print"}
                            </button>
                          ) : null}
                          <button
                            className={
                              printer.enabled
                                ? "secondary-button"
                                : "primary-button"
                            }
                            disabled={isBusy || printer.isVirtual}
                            onClick={() => void handleTogglePrinter(printer)}
                            type="button"
                            title={
                              printer.isVirtual
                                ? "Virtual queues cannot be enabled for physical print jobs."
                                : undefined
                            }
                          >
                            {isBusy
                              ? "Updating…"
                              : printer.enabled
                                ? "Disable"
                                : printer.isVirtual
                                  ? "Virtual Queue"
                                  : "Enable"}
                          </button>
                        </div>
                      </div>

                      {testPrint ? (
                        <div
                          className="test-print-status"
                          role="status"
                          style={{
                            padding: "0.6rem 0.85rem",
                            borderRadius: "6px",
                            fontSize: "0.85rem",
                            backgroundColor:
                              testPrint.status === "SUCCEEDED"
                                ? "#e6f4ea"
                                : testPrint.status === "BLOCKED"
                                  ? "#fef7e0"
                                  : testPrint.status === "FAILED" ||
                                      testPrint.status === "EXPIRED"
                                    ? "#fce8e6"
                                    : "#e8f0fe",
                            color:
                              testPrint.status === "SUCCEEDED"
                                ? "#137333"
                                : testPrint.status === "BLOCKED"
                                  ? "#b06000"
                                  : testPrint.status === "FAILED" ||
                                      testPrint.status === "EXPIRED"
                                    ? "#c5221f"
                                    : "#1a73e8",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                          }}
                        >
                          <div>
                            {isRequesting && <span>Sending test page…</span>}
                            {!isRequesting &&
                              testPrint.status === "PENDING" && (
                                <span>Waiting for Agent…</span>
                              )}
                            {!isRequesting &&
                              testPrint.status === "CLAIMED" && (
                                <span>Agent claimed command…</span>
                              )}
                            {!isRequesting &&
                              testPrint.status === "SUBMITTED" && (
                                <span>
                                  Submitted to printer…
                                  {testPrint.spoolerJobId
                                    ? ` (Spooler Job #${testPrint.spoolerJobId})`
                                    : ""}
                                </span>
                              )}
                            {!isRequesting &&
                              testPrint.status === "SUCCEEDED" && (
                                <span>Test page submitted successfully.</span>
                              )}
                            {!isRequesting &&
                              testPrint.status === "BLOCKED" && (
                                <span>
                                  Printer needs attention:{" "}
                                  {testPrint.failureDetail ||
                                    testPrint.failureCode ||
                                    "Printer is blocked"}
                                </span>
                              )}
                            {!isRequesting && testPrint.status === "FAILED" && (
                              <span>
                                Test print failed
                                {testPrint.failureDetail
                                  ? `: ${testPrint.failureDetail}`
                                  : ""}
                              </span>
                            )}
                            {!isRequesting &&
                              testPrint.status === "EXPIRED" && (
                                <span>
                                  Test print timed out waiting for Agent.
                                </span>
                              )}
                          </div>
                          {testPrint.finishedAt ? (
                            <span
                              className="muted"
                              style={{ fontSize: "0.75rem" }}
                            >
                              {formatRelativeTime(testPrint.finishedAt)}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        ))
      )}
    </div>
  );
}
