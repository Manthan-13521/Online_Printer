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

function formatSimpleCapabilities(
  caps: AdminPrinterDetails["capabilities"],
): string {
  if (!caps) return "Standard A4";
  const color = caps.colour ? "Colour & B/W" : "Black & White";
  const sides = caps.duplex ? "Duplex (2-sided)" : "1-sided";
  const paper = caps.paperSizes?.includes("A4")
    ? "A4"
    : caps.paperSizes?.[0] || "A4";
  return `${paper} • ${color} • ${sides}`;
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

  // Pair code state
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
  const [settingDefaultId, setSettingDefaultId] = useState<string | null>(null);
  const [checkingHealthId, setCheckingHealthId] = useState<string | null>(null);

  // Test print tracking per printer
  const [testPrints, setTestPrints] = useState<
    Record<string, AdminTestPrintDetails | null>
  >({});
  const [requestingTestPrintId, setRequestingTestPrintId] = useState<
    string | null
  >(null);

  // Change printer modal & developer debug filter
  const [isChangingPrinter, setIsChangingPrinter] = useState(false);
  const [showVirtualPrinters, setShowVirtualPrinters] = useState(false);

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
              // Information refresh. The Agent remains authoritative.
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
        setNotice("Agent disconnected and removed.");
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

  // Helper to identify virtual software queues (Microsoft Print to PDF, XPS, Fax, OneNote, etc.)
  function isVirtualPrinter(p: AdminPrinterDetails): boolean {
    if (p.isVirtual) return true;
    const text = `${p.displayName} ${p.windowsPrinterName}`.toLowerCase();
    return /pdf|xps|fax|onenote|root print queue|generic \/ text|document writer/i.test(
      text,
    );
  }

  // Sort agents: Online first, then most recently active
  const sortedAgents = [...agents].sort((a, b) => {
    if (a.isOnline && !b.isOnline) return -1;
    if (!a.isOnline && b.isOnline) return 1;
    const timeA = a.lastHeartbeatAt ? new Date(a.lastHeartbeatAt).getTime() : 0;
    const timeB = b.lastHeartbeatAt ? new Date(b.lastHeartbeatAt).getTime() : 0;
    return timeB - timeA;
  });

  const activeAgent = sortedAgents[0] ?? null;
  const staleAgents = sortedAgents.slice(1);

  const allPrinters = activeAgent?.printers ?? [];
  const physicalPrinters = allPrinters.filter((p) => !isVirtualPrinter(p));

  // Determine active production printer:
  // 1. Explicit production default
  // 2. First enabled physical printer
  // 3. First physical printer
  // 4. First printer overall
  const activePrinter =
    allPrinters.find((p) => p.isProductionDefault) ??
    physicalPrinters.find((p) => p.enabled) ??
    physicalPrinters[0] ??
    allPrinters[0] ??
    null;

  // Printers available to pick in Change Printer modal
  const selectablePrinters =
    physicalPrinters.length > 0 && !showVirtualPrinters
      ? physicalPrinters
      : allPrinters;

  const testPrint = activePrinter
    ? (testPrints[activePrinter.id] ?? activePrinter.latestTestPrint)
    : null;
  const isRequestingTestPrint =
    activePrinter && requestingTestPrintId === activePrinter.id;
  const isTestPrintActive =
    testPrint &&
    (testPrint.status === "PENDING" ||
      testPrint.status === "CLAIMED" ||
      testPrint.status === "SUBMITTED");

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
            Manage your physical printer readiness and PrintGo Windows Agent.
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
            {generatingCode ? "Generating…" : "Connect New Agent"}
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

      {/* Pairing code banner if active */}
      {pairCode ? (
        <section
          className="panel"
          style={{
            border: "2px solid var(--accent, #0066cc)",
            backgroundColor: "var(--bg-subtle, #f5f5f5)",
          }}
        >
          <div className="action-row">
            <div>
              <h3 style={{ margin: 0, fontSize: "1.1rem" }}>
                Agent Pairing Code
              </h3>
              <p className="muted" style={{ margin: "0.25rem 0 0 0" }}>
                Run PrintGo Agent on your shop Windows computer and connect with
                this code.
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
        </section>
      ) : null}

      {/* Case 1: No agents connected at all */}
      {agents.length === 0 ? (
        <>
          <section
            className="panel welcome"
            style={{ textAlign: "center", padding: "2.5rem 1.5rem" }}
          >
            <h2>No PrintGo Agents Connected</h2>
            <p
              className="muted"
              style={{ maxWidth: "540px", margin: "0.5rem auto 0 auto" }}
            >
              To accept customer print jobs, install the PrintGo Windows Agent
              on your shop computer and pair it with this shop.
            </p>
          </section>

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
                  <strong>Create a connection link:</strong> Click "Generate
                  Pairing Code" below.
                </li>
                <li>
                  <strong>Connect this PC:</strong> Use the connection button,
                  or paste the copied connection link into Control Center.
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

            <div style={{ marginTop: "1.5rem" }}>
              <button
                className="primary-button"
                disabled={generatingCode}
                onClick={() => void handleGeneratePairCode()}
                type="button"
              >
                {generatingCode ? "Generating…" : "Generate Pairing Code"}
              </button>
            </div>
          </section>
        </>
      ) : (
        <>
          {/* Section 1: PRINTER (Clean Single Printer Card) */}
          <section
            className="panel"
            aria-labelledby="primary-printer-heading"
            style={{
              padding: "1.5rem",
              borderRadius: "12px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                flexWrap: "wrap",
                gap: "1.25rem",
              }}
            >
              <div style={{ flex: "1 1 280px" }}>
                <span
                  style={{
                    display: "block",
                    textTransform: "uppercase",
                    fontSize: "0.75rem",
                    letterSpacing: "1.2px",
                    fontWeight: 700,
                    color: "var(--text-muted, #64748b)",
                    marginBottom: "0.5rem",
                  }}
                >
                  PRINTER
                </span>

                {activePrinter ? (
                  <>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.75rem",
                        flexWrap: "wrap",
                      }}
                    >
                      <h2
                        id="primary-printer-heading"
                        style={{
                          margin: 0,
                          fontSize: "1.5rem",
                          fontWeight: 600,
                          color: "var(--text-primary, #0f172a)",
                        }}
                      >
                        {activePrinter.displayName}
                      </h2>
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "0.35rem",
                          padding: "0.2rem 0.65rem",
                          borderRadius: "9999px",
                          fontSize: "0.8rem",
                          fontWeight: 600,
                          backgroundColor: activePrinter.isPaused
                            ? "#fef3c7"
                            : activePrinter.status === "ONLINE"
                              ? "#e6f4ea"
                              : "#fce8e6",
                          color: activePrinter.isPaused
                            ? "#92400e"
                            : activePrinter.status === "ONLINE"
                              ? "#137333"
                              : "#c5221f",
                        }}
                      >
                        <span style={{ fontSize: "0.65rem" }}>●</span>
                        {activePrinter.isPaused
                          ? "PAUSED"
                          : activePrinter.status}
                      </span>
                    </div>

                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.6rem",
                        marginTop: "0.5rem",
                        flexWrap: "wrap",
                      }}
                    >
                      <span
                        style={{
                          fontSize: "0.8rem",
                          fontWeight: 600,
                          color: "#1a73e8",
                          backgroundColor: "#e8f0fe",
                          padding: "0.15rem 0.55rem",
                          borderRadius: "6px",
                        }}
                      >
                        Default printer
                      </span>
                      <span
                        className="muted"
                        style={{ fontSize: "0.85rem", color: "#64748b" }}
                      >
                        • {formatSimpleCapabilities(activePrinter.capabilities)}
                      </span>
                    </div>
                  </>
                ) : (
                  <div style={{ marginTop: "0.25rem" }}>
                    <h2
                      id="primary-printer-heading"
                      style={{
                        margin: 0,
                        fontSize: "1.25rem",
                        color: "#64748b",
                      }}
                    >
                      No physical printer selected
                    </h2>
                    <p
                      className="muted"
                      style={{ fontSize: "0.85rem", margin: "0.25rem 0 0 0" }}
                    >
                      Select a physical printer to start accepting customer
                      orders.
                    </p>
                  </div>
                )}
              </div>

              {/* Action Buttons: Test Print & Change Printer */}
              <div
                style={{
                  display: "flex",
                  gap: "0.75rem",
                  flexWrap: "wrap",
                  alignItems: "center",
                }}
              >
                {activePrinter && (
                  <button
                    type="button"
                    className="primary-button"
                    disabled={
                      !activeAgent?.isOnline ||
                      isRequestingTestPrint ||
                      Boolean(isTestPrintActive)
                    }
                    onClick={() => void handleRequestTestPrint(activePrinter)}
                    title={
                      !activeAgent?.isOnline ? "Agent is offline" : undefined
                    }
                  >
                    {isRequestingTestPrint
                      ? "Sending test page…"
                      : isTestPrintActive
                        ? "Testing in progress…"
                        : testPrint
                          ? "Try Test Print Again"
                          : "Test Print"}
                  </button>
                )}
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setIsChangingPrinter(true)}
                >
                  Change Printer
                </button>
              </div>
            </div>

            {/* Paused alert if printer has a problem */}
            {activePrinter?.isPaused && (
              <div
                style={{
                  marginTop: "1.25rem",
                  padding: "0.75rem 1rem",
                  backgroundColor: "#fef3c7",
                  border: "1px solid #f59e0b",
                  borderRadius: "8px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "0.75rem",
                }}
              >
                <div>
                  <strong style={{ color: "#92400e", display: "block" }}>
                    ⏸️ PRINTING PAUSED
                  </strong>
                  <span style={{ fontSize: "0.85rem", color: "#78350f" }}>
                    {activePrinter.pausedReason || "Printer problem reported"}
                  </span>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={checkingHealthId === activePrinter.id}
                  onClick={() => void handleCheckHealth(activePrinter.id)}
                  style={{ fontSize: "0.85rem" }}
                >
                  {checkingHealthId === activePrinter.id
                    ? "Checking…"
                    : "Issue Solved / Check Again"}
                </button>
              </div>
            )}

            {/* Test print status banner */}
            {activePrinter && testPrint && (
              <div
                className="test-print-status"
                role="status"
                style={{
                  marginTop: "1rem",
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
                  {isRequestingTestPrint && <span>Sending test page…</span>}
                  {!isRequestingTestPrint && testPrint.status === "PENDING" && (
                    <span>Waiting for Agent…</span>
                  )}
                  {!isRequestingTestPrint && testPrint.status === "CLAIMED" && (
                    <span>Agent claimed command…</span>
                  )}
                  {!isRequestingTestPrint &&
                    testPrint.status === "SUBMITTED" && (
                      <span>
                        Submitted to printer…
                        {testPrint.spoolerJobId
                          ? ` (Spooler Job #${testPrint.spoolerJobId})`
                          : ""}
                      </span>
                    )}
                  {!isRequestingTestPrint &&
                    testPrint.status === "SUCCEEDED" && (
                      <span>Test page submitted successfully.</span>
                    )}
                  {!isRequestingTestPrint && testPrint.status === "BLOCKED" && (
                    <span>
                      Printer needs attention:{" "}
                      {testPrint.failureDetail ||
                        testPrint.failureCode ||
                        "Printer is blocked"}
                    </span>
                  )}
                  {!isRequestingTestPrint && testPrint.status === "FAILED" && (
                    <span>
                      Test print failed
                      {testPrint.failureDetail
                        ? `: ${testPrint.failureDetail}`
                        : ""}
                    </span>
                  )}
                  {!isRequestingTestPrint && testPrint.status === "EXPIRED" && (
                    <span>Test print timed out waiting for Agent.</span>
                  )}
                </div>
                {testPrint.finishedAt ? (
                  <span className="muted" style={{ fontSize: "0.75rem" }}>
                    {formatRelativeTime(testPrint.finishedAt)}
                  </span>
                ) : null}
              </div>
            )}

            {/* Collapsed Diagnostics & Technical Details */}
            {activePrinter && (
              <details
                style={{
                  marginTop: "1.25rem",
                  borderTop: "1px solid var(--border-color, #e0e0e0)",
                  paddingTop: "0.75rem",
                }}
              >
                <summary
                  style={{
                    cursor: "pointer",
                    fontSize: "0.85rem",
                    color: "var(--text-muted, #64748b)",
                    userSelect: "none",
                  }}
                >
                  Diagnostics & Technical Details
                </summary>
                <div
                  style={{
                    marginTop: "0.75rem",
                    display: "grid",
                    gap: "0.4rem",
                    fontSize: "0.85rem",
                    color: "var(--text-muted, #475569)",
                  }}
                >
                  <div>
                    Windows Queue:{" "}
                    <code>{activePrinter.windowsPrinterName}</code>
                  </div>
                  <div>
                    Port: <code>{activePrinter.portName || "Local/USB"}</code>
                  </div>
                  <div>
                    Driver:{" "}
                    <code>{activePrinter.driverName || "Windows Default"}</code>
                  </div>
                  <div>
                    Supported Paper:{" "}
                    {activePrinter.capabilities?.paperSizes?.join(", ") ||
                      "Standard A4"}
                  </div>
                  <div style={{ marginTop: "0.5rem" }}>
                    <button
                      type="button"
                      className="secondary-button compact"
                      disabled={togglingPrinterId === activePrinter.id}
                      onClick={() => void handleTogglePrinter(activePrinter)}
                    >
                      {activePrinter.enabled ? "Disable" : "Enable"}
                    </button>
                  </div>
                </div>
              </details>
            )}
          </section>

          {/* Section 2: PRINTGO AGENT */}
          {activeAgent && (
            <section
              className="panel"
              aria-labelledby="active-agent-heading"
              style={{
                padding: "1.5rem",
                borderRadius: "12px",
                boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "1rem",
                }}
              >
                <div>
                  <span
                    style={{
                      display: "block",
                      textTransform: "uppercase",
                      fontSize: "0.75rem",
                      letterSpacing: "1.2px",
                      fontWeight: 700,
                      color: "var(--text-muted, #64748b)",
                      marginBottom: "0.5rem",
                    }}
                  >
                    PRINTGO AGENT
                  </span>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.75rem",
                      flexWrap: "wrap",
                    }}
                  >
                    <h2
                      id="active-agent-heading"
                      style={{
                        margin: 0,
                        fontSize: "1.35rem",
                        fontWeight: 600,
                        color: "var(--text-primary, #0f172a)",
                      }}
                    >
                      {activeAgent.displayName}
                    </h2>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "0.35rem",
                        padding: "0.2rem 0.65rem",
                        borderRadius: "9999px",
                        fontSize: "0.8rem",
                        fontWeight: 600,
                        backgroundColor: activeAgent.isOnline
                          ? "#e6f4ea"
                          : "#fce8e6",
                        color: activeAgent.isOnline ? "#137333" : "#c5221f",
                      }}
                    >
                      <span style={{ fontSize: "0.65rem" }}>●</span>
                      {activeAgent.isOnline ? "Connected" : "Offline"}
                    </span>
                  </div>
                  <p
                    className="muted"
                    style={{
                      margin: "0.35rem 0 0 0",
                      fontSize: "0.85rem",
                      color: "#64748b",
                    }}
                  >
                    Last seen: {formatRelativeTime(activeAgent.lastHeartbeatAt)}
                    {activeAgent.pairedAt
                      ? ` • Paired: ${new Date(activeAgent.pairedAt).toLocaleDateString()}`
                      : ""}
                  </p>
                </div>

                <div>
                  {confirmRevokeId === activeAgent.id ? (
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
                        className="danger-button compact"
                        disabled={revokingAgentId === activeAgent.id}
                        onClick={() => void handleRevokeAgent(activeAgent.id)}
                        type="button"
                      >
                        {revokingAgentId === activeAgent.id
                          ? "Disconnecting…"
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
                      aria-label="Revoke Agent"
                      onClick={() => setConfirmRevokeId(activeAgent.id)}
                      type="button"
                    >
                      Disconnect Agent
                    </button>
                  )}
                </div>
              </div>
            </section>
          )}

          {/* Section 3: Stale / Old Duplicate Agents (Shop cleanup) */}
          {staleAgents.length > 0 && (
            <section className="panel" aria-labelledby="stale-agents-heading">
              <h3
                id="stale-agents-heading"
                style={{
                  fontSize: "1rem",
                  margin: "0 0 0.25rem 0",
                  color: "#64748b",
                }}
              >
                Previous / Offline Agents ({staleAgents.length})
              </h3>
              <p
                className="muted"
                style={{ fontSize: "0.85rem", margin: "0 0 1rem 0" }}
              >
                These old agent connections are inactive. Removing an agent
                cleans up its registered printer records.
              </p>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.75rem",
                }}
              >
                {staleAgents.map((stale) => (
                  <div
                    key={stale.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "0.75rem 1rem",
                      backgroundColor: "var(--bg-subtle, #f8fafc)",
                      border: "1px solid var(--border-color, #e2e8f0)",
                      borderRadius: "8px",
                      flexWrap: "wrap",
                      gap: "0.5rem",
                    }}
                  >
                    <div>
                      <strong>{stale.displayName}</strong>
                      <span
                        className="muted"
                        style={{ fontSize: "0.8rem", marginLeft: "0.75rem" }}
                      >
                        Last seen: {formatRelativeTime(stale.lastHeartbeatAt)}
                      </span>
                    </div>
                    <div>
                      {confirmRevokeId === stale.id ? (
                        <div
                          style={{
                            display: "flex",
                            gap: "0.5rem",
                            alignItems: "center",
                          }}
                        >
                          <span
                            style={{ fontSize: "0.85rem", color: "#c5221f" }}
                          >
                            Confirm remove?
                          </span>
                          <button
                            className="danger-button compact"
                            disabled={revokingAgentId === stale.id}
                            onClick={() => void handleRevokeAgent(stale.id)}
                            type="button"
                          >
                            {revokingAgentId === stale.id
                              ? "Removing…"
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
                          className="secondary-button compact"
                          aria-label="Revoke Agent"
                          onClick={() => setConfirmRevokeId(stale.id)}
                          type="button"
                        >
                          Remove Agent
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Change Printer Modal */}
          {isChangingPrinter && (
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="change-printer-title"
              style={{
                position: "fixed",
                inset: 0,
                backgroundColor: "rgba(0, 0, 0, 0.5)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 100,
                padding: "1rem",
              }}
            >
              <div
                style={{
                  backgroundColor: "#ffffff",
                  borderRadius: "12px",
                  maxWidth: "540px",
                  width: "100%",
                  maxHeight: "90vh",
                  display: "flex",
                  flexDirection: "column",
                  boxShadow:
                    "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    padding: "1.25rem 1.5rem",
                    borderBottom: "1px solid #e2e8f0",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <h2
                      id="change-printer-title"
                      style={{ margin: 0, fontSize: "1.25rem" }}
                    >
                      Choose Production Printer
                    </h2>
                    <p
                      className="muted"
                      style={{ margin: "0.25rem 0 0 0", fontSize: "0.85rem" }}
                    >
                      Select the physical printer used for customer online
                      orders.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setIsChangingPrinter(false)}
                    style={{ fontSize: "1.25rem", padding: "0.25rem 0.5rem" }}
                  >
                    ✕
                  </button>
                </div>

                <div
                  style={{
                    padding: "1.25rem 1.5rem",
                    overflowY: "auto",
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.75rem",
                  }}
                >
                  {selectablePrinters.length === 0 ? (
                    <p
                      className="muted"
                      style={{ textAlign: "center", padding: "1.5rem 0" }}
                    >
                      No physical printers detected. Make sure your printer is
                      connected via USB/Network and powered on.
                    </p>
                  ) : (
                    selectablePrinters.map((p) => {
                      const isCurrentDefault = p.id === activePrinter?.id;
                      return (
                        <div
                          key={p.id}
                          style={{
                            border: isCurrentDefault
                              ? "2px solid #1a73e8"
                              : "1px solid #cbd5e1",
                            backgroundColor: isCurrentDefault
                              ? "#f8faff"
                              : "#ffffff",
                            borderRadius: "8px",
                            padding: "1rem",
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: "0.75rem",
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
                              <strong>{p.displayName}</strong>
                              <span
                                style={{
                                  fontSize: "0.75rem",
                                  fontWeight: 600,
                                  color:
                                    p.status === "ONLINE"
                                      ? "#137333"
                                      : "#c5221f",
                                }}
                              >
                                ● {p.status === "ONLINE" ? "Online" : "Offline"}
                              </span>
                            </div>
                            <div
                              className="muted"
                              style={{
                                fontSize: "0.8rem",
                                marginTop: "0.2rem",
                              }}
                            >
                              {formatSimpleCapabilities(p.capabilities)}
                            </div>
                          </div>

                          <div
                            style={{
                              display: "flex",
                              gap: "0.5rem",
                              alignItems: "center",
                            }}
                          >
                            {isCurrentDefault ? (
                              <span
                                style={{
                                  fontSize: "0.85rem",
                                  fontWeight: 600,
                                  color: "#1a73e8",
                                }}
                              >
                                ✓ Selected
                              </span>
                            ) : (
                              <button
                                type="button"
                                className="primary-button compact"
                                disabled={settingDefaultId === p.id}
                                onClick={() => {
                                  void (async () => {
                                    await handleSetDefaultPrinter(p);
                                    setIsChangingPrinter(false);
                                  })();
                                }}
                              >
                                {settingDefaultId === p.id
                                  ? "Setting…"
                                  : "Set as Printer"}
                              </button>
                            )}
                            <button
                              type="button"
                              className="secondary-button compact"
                              disabled={
                                !activeAgent?.isOnline ||
                                requestingTestPrintId === p.id
                              }
                              onClick={() => void handleRequestTestPrint(p)}
                            >
                              Test Print
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}

                  <div
                    style={{
                      marginTop: "0.75rem",
                      paddingTop: "0.75rem",
                      borderTop: "1px solid #e2e8f0",
                    }}
                  >
                    <label
                      style={{
                        fontSize: "0.8rem",
                        color: "#64748b",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "0.4rem",
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={showVirtualPrinters}
                        onChange={(e) =>
                          setShowVirtualPrinters(e.target.checked)
                        }
                      />
                      Show virtual / software printers (Developer debug mode)
                    </label>
                  </div>
                </div>

                <div
                  style={{
                    padding: "1rem 1.5rem",
                    borderTop: "1px solid #e2e8f0",
                    display: "flex",
                    justifyContent: "flex-end",
                  }}
                >
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setIsChangingPrinter(false)}
                  >
                    Done
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
