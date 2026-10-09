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
  if (!caps) return "B&W • A4 (Unverified)";
  const color = caps.colour ? "Color" : "B&W";
  const sides = caps.duplex ? "Duplex" : "1-sided";
  const paper = caps.paperSizes?.includes("A4")
    ? "A4"
    : caps.paperSizes?.[0] || "A4";
  return `${color} • ${paper} • ${sides} (Driver Detected)`;
}

function friendlyPrinterMessage(
  code: string | null | undefined,
  detail: string | null | undefined,
): string {
  if (detail && detail.trim().length > 0) {
    if (detail.toLowerCase().includes("paper tray is empty")) {
      return "Paper tray is empty. Please load paper.";
    }
    return detail;
  }
  switch (code) {
    case "PAPER_OUT":
      return "Printer is out of paper. Please add paper.";
    case "PAPER_JAM":
      return "Paper jam detected. Please check the paper path.";
    case "DOOR_OPEN":
      return "Printer door or cover is open.";
    case "NO_TONER":
      return "Toner or ink is empty.";
    case "TONER_LOW":
      return "Toner or ink is low.";
    case "OFFLINE":
      return "Printer is powered off or disconnected.";
    case "USER_INTERVENTION":
      return "Printer requires attention.";
    default:
      return "Printer reported an issue.";
  }
}

export function PrinterPage({
  onSessionExpired,
}: {
  onSessionExpired: (message: string) => void;
}) {
  const [agents, setAgents] = useState<AdminAgentDetails[]>([]);
  const [defaultProductionPrinterId, setDefaultProductionPrinterId] = useState<
    string | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Pair code state
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [pairExpiresAt, setPairExpiresAt] = useState<string | null>(null);
  const [generatingCode, setGeneratingCode] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

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

  // Add Printer flow & Settings Modal
  const [isAddingPrinter, setIsAddingPrinter] = useState(false);
  const [settingsPrinter, setSettingsPrinter] =
    useState<AdminPrinterDetails | null>(null);
  const [showVirtualPrinters, setShowVirtualPrinters] = useState(false);

  // Settings form state
  const [formDisplayName, setFormDisplayName] = useState("");
  const [formPriority, setFormPriority] = useState(0);
  const [formEnabled, setFormEnabled] = useState(true);
  const [formFallbackId, setFormFallbackId] = useState<string>("");
  const [formAutoFallback, setFormAutoFallback] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

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
        setDefaultProductionPrinterId(
          response.data.defaultProductionPrinterId ?? null,
        );
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
        setDefaultProductionPrinterId(printer.id);
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

  function openSettingsModal(printer: AdminPrinterDetails) {
    setSettingsPrinter(printer);
    setFormDisplayName(printer.displayName);
    setFormPriority(printer.priority ?? 0);
    setFormEnabled(printer.enabled);
    setFormFallbackId(printer.fallbackPrinterId ?? "");
    setFormAutoFallback(printer.autoFallbackEnabled ?? false);
  }

  async function handleSaveSettings() {
    if (!settingsPrinter) return;
    setSavingSettings(true);
    setError(null);
    setNotice(null);
    try {
      const res = await adminApi.updatePrinter(settingsPrinter.id, {
        displayName: formDisplayName.trim() || settingsPrinter.displayName,
        priority: formPriority,
        enabled: formEnabled,
        fallbackPrinterId: formFallbackId.trim() || null,
        autoFallbackEnabled: formAutoFallback,
      });
      if (res.ok) {
        setNotice(
          `Settings saved for "${formDisplayName.trim() || settingsPrinter.displayName}".`,
        );
        setSettingsPrinter(null);
        await loadPrinters();
      }
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    } finally {
      setSavingSettings(false);
    }
  }

  const connectionLink = pairCode
    ? buildAgentConnectionUrl(
        pairCode,
        String(import.meta.env.VITE_API_BASE_URL || window.location.origin),
      )
    : null;

  function copyPairCodeOnly() {
    if (!pairCode) return;
    void navigator.clipboard
      .writeText(pairCode)
      .then(() => {
        setCopiedCode(true);
        setTimeout(() => setCopiedCode(false), 3000);
      })
      .catch(() =>
        setError("The pairing code could not be copied to clipboard."),
      );
  }

  function copyConnectionLink() {
    if (!connectionLink) {
      setError(
        "Your technician must configure a secure shop connection before pairing.",
      );
      return;
    }
    void navigator.clipboard
      .writeText(connectionLink)
      .then(() => {
        setCopiedLink(true);
        setTimeout(() => setCopiedLink(false), 3000);
      })
      .catch(() =>
        setError(
          "The connection link could not be copied. Use Connect This PC instead.",
        ),
      );
  }

  const release = getWindowsAgentReleaseConfig();

  // Helper to identify virtual software queues
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

  // Configured printers to display
  const displayedPrinters = showVirtualPrinters
    ? allPrinters
    : physicalPrinters;

  // Printers discovered but un-enabled (ready to confirm/add)
  const unconfiguredPrinters = physicalPrinters.filter((p) => !p.enabled);

  // Ready and attention counts
  const readyPrinters = displayedPrinters.filter(
    (p) =>
      p.enabled &&
      p.status === "ONLINE" &&
      !p.isPaused &&
      Boolean(activeAgent?.isOnline),
  );
  const attentionPrinters = displayedPrinters.filter(
    (p) =>
      p.enabled &&
      (p.isPaused || p.status !== "ONLINE" || !activeAgent?.isOnline),
  );

  if (loading) {
    return (
      <div className="panel page-loading" aria-busy="true">
        Loading printer configuration…
      </div>
    );
  }

  return (
    <div className="page-stack printer-page">
      {/* Top Header */}
      <div className="action-row" style={{ alignItems: "flex-start" }}>
        <div>
          <p className="eyebrow">Shop Hardware</p>
          <h1>Printers & Agent</h1>
          <p className="page-intro">
            Manage all your shop printers in one place.
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
            onClick={() => setIsAddingPrinter(true)}
            type="button"
          >
            + Add Printer
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
                backgroundColor: "var(--bg-card, #ffffff)",
                padding: "0.25rem 0.75rem",
                borderRadius: "6px",
                border: "1px dashed var(--border, #cbd5e1)",
                cursor: "pointer",
                userSelect: "all",
              }}
              title="Click to copy pairing code"
              onClick={copyPairCodeOnly}
            >
              {pairCode}
            </span>
            <button
              className="secondary-button"
              onClick={copyPairCodeOnly}
              type="button"
            >
              {copiedCode ? "Code Copied!" : "Copy Code"}
            </button>
            <button
              className="secondary-button"
              onClick={copyConnectionLink}
              type="button"
            >
              {copiedLink ? "Link Copied!" : "Copy Full Link"}
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

      {/* Empty State: No agents connected */}
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
          {/* Section: MULTI-PRINTER MANAGEMENT */}
          <section
            className="panel"
            aria-labelledby="printers-section-heading"
            style={{
              padding: "1.5rem",
              borderRadius: "12px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            }}
          >
            {/* Summary Bar */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "1rem",
                marginBottom: "1.25rem",
                paddingBottom: "1rem",
                borderBottom: "1px solid var(--border-color, #e2e8f0)",
              }}
            >
              <div>
                <h2
                  id="printers-section-heading"
                  style={{
                    margin: 0,
                    fontSize: "1.25rem",
                    fontWeight: 700,
                    color: "var(--text-primary, #0f172a)",
                  }}
                >
                  My Printers
                </h2>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.6rem",
                    marginTop: "0.35rem",
                    fontSize: "0.875rem",
                    color: "var(--text-muted, #64748b)",
                    flexWrap: "wrap",
                  }}
                >
                  <span style={{ color: "#16a34a", fontWeight: 600 }}>
                    {readyPrinters.length} ready
                  </span>
                  <span>·</span>
                  <span
                    style={{
                      color:
                        attentionPrinters.length > 0 ? "#d97706" : "#64748b",
                      fontWeight: attentionPrinters.length > 0 ? 600 : 400,
                    }}
                  >
                    {attentionPrinters.length} needs attention
                  </span>
                  <span>·</span>
                  <span>
                    {displayedPrinters.length} printer
                    {displayedPrinters.length === 1 ? "" : "s"}
                  </span>
                </div>
              </div>

              <div
                style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}
              >
                <label
                  style={{
                    fontSize: "0.8rem",
                    color: "#64748b",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.4rem",
                    cursor: "pointer",
                    marginRight: "0.5rem",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={showVirtualPrinters}
                    onChange={(e) => setShowVirtualPrinters(e.target.checked)}
                  />
                  Show virtual queues
                </label>
              </div>
            </div>

            {/* Offline Agent Warning Banner */}
            {activeAgent && !activeAgent.isOnline && (
              <div
                style={{
                  marginBottom: "1.25rem",
                  padding: "0.75rem 1rem",
                  backgroundColor: "#fee2e2",
                  border: "1px solid #ef4444",
                  borderRadius: "8px",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.75rem",
                  color: "#991b1b",
                  fontSize: "0.875rem",
                }}
              >
                <span style={{ fontSize: "1.25rem" }}>⚠️</span>
                <div>
                  <strong>Shop PC Agent is Offline.</strong> Statuses below
                  reflect the last known report from{" "}
                  {formatRelativeTime(activeAgent.lastHeartbeatAt)}. Keep
                  PrintGo Agent running on the shop PC to print orders.
                </div>
              </div>
            )}

            {/* Printer Cards List */}
            {displayedPrinters.length === 0 ? (
              <div
                style={{
                  textAlign: "center",
                  padding: "2.5rem 1rem",
                  color: "var(--text-muted, #64748b)",
                }}
              >
                <p style={{ margin: "0 0 0.75rem 0", fontSize: "1rem" }}>
                  No physical printers detected yet.
                </p>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => setIsAddingPrinter(true)}
                >
                  Detect & Add Printers
                </button>
              </div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
                  gap: "1rem",
                }}
              >
                {displayedPrinters.map((p) => {
                  const isDefault =
                    p.id === defaultProductionPrinterId ||
                    p.isProductionDefault;
                  const tp = testPrints[p.id] ?? p.latestTestPrint;
                  const isTesting =
                    requestingTestPrintId === p.id ||
                    (tp &&
                      (tp.status === "PENDING" ||
                        tp.status === "CLAIMED" ||
                        tp.status === "SUBMITTED"));

                  // Status details
                  const isAgentOnline = Boolean(activeAgent?.isOnline);
                  const hasProblem =
                    p.isPaused ||
                    p.status === "BLOCKED" ||
                    p.status === "ERROR";

                  return (
                    <div
                      key={p.id}
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
                          <p
                            className="muted"
                            style={{
                              margin: "0.25rem 0 0 0",
                              fontSize: "0.8rem",
                            }}
                          >
                            {formatSimpleCapabilities(p.capabilities)}
                          </p>
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
                            {friendlyPrinterMessage(
                              p.statusReason,
                              p.pausedReason,
                            )}
                          </div>
                          <button
                            type="button"
                            className="secondary-button compact"
                            disabled={checkingHealthId === p.id}
                            onClick={() => void handleCheckHealth(p.id)}
                            style={{ fontSize: "0.775rem" }}
                          >
                            {checkingHealthId === p.id
                              ? "Checking…"
                              : "Check Again"}
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
                                  : tp.status === "FAILED" ||
                                      tp.status === "EXPIRED"
                                    ? "#fee2e2"
                                    : "#e0f2fe",
                            color:
                              tp.status === "SUCCEEDED"
                                ? "#15803d"
                                : tp.status === "BLOCKED"
                                  ? "#92400e"
                                  : tp.status === "FAILED" ||
                                      tp.status === "EXPIRED"
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
                                {tp.spoolerJobId
                                  ? ` (Job #${tp.spoolerJobId})`
                                  : ""}
                              </span>
                            ) : tp.status === "SUCCEEDED" ? (
                              <span>Test page submitted successfully.</span>
                            ) : tp.status === "BLOCKED" ? (
                              <span>
                                Printer needs attention:{" "}
                                {friendlyPrinterMessage(
                                  tp.failureCode,
                                  tp.failureDetail,
                                )}
                              </span>
                            ) : tp.status === "FAILED" ? (
                              <span>
                                Test print failed:{" "}
                                {tp.failureDetail || "Unknown error"}
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
                        <div style={{ display: "flex", gap: "0.4rem" }}>
                          <button
                            type="button"
                            className="secondary-button compact"
                            disabled={
                              !activeAgent?.isOnline || Boolean(isTesting)
                            }
                            onClick={() => void handleRequestTestPrint(p)}
                            title={
                              !activeAgent?.isOnline
                                ? "Agent is offline"
                                : undefined
                            }
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
                            onClick={() => openSettingsModal(p)}
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
                              onClick={() => void handleSetDefaultPrinter(p)}
                            >
                              {settingDefaultId === p.id
                                ? "Setting…"
                                : "Set Default"}
                            </button>
                          )}
                          <button
                            type="button"
                            className="secondary-button compact"
                            disabled={togglingPrinterId === p.id}
                            onClick={() => void handleTogglePrinter(p)}
                          >
                            {p.enabled ? "Disable" : "Enable"}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Section: PRINTGO WINDOWS AGENT (At bottom) */}
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
                      marginBottom: "0.4rem",
                    }}
                  >
                    PRINTGO WINDOWS AGENT
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
                          ? "#dcfce7"
                          : "#fee2e2",
                        color: activeAgent.isOnline ? "#15803d" : "#991b1b",
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
                    One Agent manages all {physicalPrinters.length} shop
                    printers • Last seen:{" "}
                    {formatRelativeTime(activeAgent.lastHeartbeatAt)}
                    {activeAgent.pairedAt
                      ? ` • Paired: ${new Date(activeAgent.pairedAt).toLocaleDateString()}`
                      : ""}
                  </p>
                </div>

                <div
                  style={{
                    display: "flex",
                    gap: "0.5rem",
                    alignItems: "center",
                  }}
                >
                  <button
                    className="secondary-button"
                    disabled={generatingCode}
                    onClick={() => void handleGeneratePairCode()}
                    type="button"
                  >
                    {generatingCode ? "Generating…" : "Connect New Agent"}
                  </button>
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
                      Revoke Agent
                    </button>
                  )}
                </div>
              </div>
            </section>
          )}

          {/* Stale / Inactive Agents List */}
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

          {/* ADD PRINTER MODAL */}
          {isAddingPrinter && (
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="add-printer-title"
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
                      id="add-printer-title"
                      style={{ margin: 0, fontSize: "1.25rem" }}
                    >
                      Connect & Add Printer
                    </h2>
                    <p
                      className="muted"
                      style={{ margin: "0.25rem 0 0 0", fontSize: "0.85rem" }}
                    >
                      Automatic discovery for all your shop USB and network
                      printers.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setIsAddingPrinter(false)}
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
                    gap: "1rem",
                  }}
                >
                  {/* If there are discovered unconfigured printers on the agent */}
                  {unconfiguredPrinters.length > 0 ? (
                    <div>
                      <h3
                        style={{
                          fontSize: "0.95rem",
                          margin: "0 0 0.5rem 0",
                          color: "#1e293b",
                        }}
                      >
                        Detected Printers Ready to Add:
                      </h3>
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "0.6rem",
                        }}
                      >
                        {unconfiguredPrinters.map((up) => (
                          <div
                            key={up.id}
                            style={{
                              border: "1px solid #cbd5e1",
                              borderRadius: "8px",
                              padding: "0.75rem 1rem",
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              backgroundColor: "#f8fafc",
                            }}
                          >
                            <div>
                              <strong>{up.displayName}</strong>
                              <p
                                className="muted"
                                style={{
                                  margin: "0.2rem 0 0 0",
                                  fontSize: "0.8rem",
                                }}
                              >
                                {formatSimpleCapabilities(up.capabilities)} •{" "}
                                {up.portName || "USB/Network"}
                              </p>
                            </div>
                            <button
                              type="button"
                              className="primary-button compact"
                              disabled={togglingPrinterId === up.id}
                              onClick={() => void handleTogglePrinter(up)}
                            >
                              {togglingPrinterId === up.id
                                ? "Adding…"
                                : "+ Add Printer"}
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {/* Setup guide */}
                  <div
                    style={{
                      padding: "1rem",
                      backgroundColor: "#f1f5f9",
                      borderRadius: "8px",
                      fontSize: "0.875rem",
                      color: "#334155",
                    }}
                  >
                    <h4 style={{ margin: "0 0 0.5rem 0", fontSize: "0.95rem" }}>
                      Plug & Play Setup:
                    </h4>
                    <ol
                      style={{
                        margin: 0,
                        paddingLeft: "1.25rem",
                        lineHeight: 1.6,
                      }}
                    >
                      <li>
                        Connect your printer to the shop Windows PC via{" "}
                        <strong>USB cable</strong> or connect it to the{" "}
                        <strong>shop Wi-Fi / LAN</strong>.
                      </li>
                      <li>
                        Turn on the printer power and verify it has paper.
                      </li>
                      <li>
                        Click <strong>Scan for Printers</strong> below. PrintGo
                        Agent will discover it in Windows and register it
                        automatically!
                      </li>
                    </ol>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      justifyContent: "center",
                      paddingTop: "0.5rem",
                    }}
                  >
                    <button
                      type="button"
                      className="primary-button"
                      disabled={refreshing}
                      onClick={() => void loadPrinters(true)}
                    >
                      {refreshing ? "Scanning PC…" : "🔄 Scan for New Printers"}
                    </button>
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
                    onClick={() => setIsAddingPrinter(false)}
                  >
                    Done
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* SETTINGS MODAL */}
          {settingsPrinter && (
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="printer-settings-title"
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
                  maxWidth: "520px",
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
                      id="printer-settings-title"
                      style={{ margin: 0, fontSize: "1.25rem" }}
                    >
                      Printer Settings
                    </h2>
                    <p
                      className="muted"
                      style={{ margin: "0.25rem 0 0 0", fontSize: "0.85rem" }}
                    >
                      Configure friendly name, default status, and priorities.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setSettingsPrinter(null)}
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
                    gap: "1.1rem",
                  }}
                >
                  {/* Friendly Display Name */}
                  <div>
                    <label
                      htmlFor="printer-friendly-name"
                      style={{ display: "block", marginBottom: "0.35rem" }}
                    >
                      Printer Name (Friendly):
                    </label>
                    <input
                      id="printer-friendly-name"
                      type="text"
                      value={formDisplayName}
                      onChange={(e) => setFormDisplayName(e.target.value)}
                      placeholder="e.g. Counter HP LaserJet"
                      maxLength={100}
                    />
                    <p
                      className="muted"
                      style={{ fontSize: "0.75rem", margin: "0.25rem 0 0 0" }}
                    >
                      This name is displayed throughout the shop admin and
                      tracking.
                    </p>
                  </div>

                  {/* Enable / Disable */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "0.75rem 1rem",
                      backgroundColor: "#f8fafc",
                      borderRadius: "8px",
                      border: "1px solid #e2e8f0",
                    }}
                  >
                    <div>
                      <strong>Accept Orders (Enabled)</strong>
                      <p
                        className="muted"
                        style={{ margin: "0.2rem 0 0 0", fontSize: "0.8rem" }}
                      >
                        Disable to temporarily take this printer out of service.
                      </p>
                    </div>
                    <label
                      style={{
                        display: "flex",
                        alignItems: "center",
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={formEnabled}
                        onChange={(e) => setFormEnabled(e.target.checked)}
                      />
                    </label>
                  </div>

                  {/* Default Printer Status */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "0.75rem 1rem",
                      backgroundColor: "#f8fafc",
                      borderRadius: "8px",
                      border: "1px solid #e2e8f0",
                    }}
                  >
                    <div>
                      <strong>Default Production Printer</strong>
                      <p
                        className="muted"
                        style={{ margin: "0.2rem 0 0 0", fontSize: "0.8rem" }}
                      >
                        {settingsPrinter.id === defaultProductionPrinterId ||
                        settingsPrinter.isProductionDefault
                          ? "This printer is currently your primary default."
                          : "Set this printer as the default for new orders."}
                      </p>
                    </div>
                    {!(
                      settingsPrinter.id === defaultProductionPrinterId ||
                      settingsPrinter.isProductionDefault
                    ) && (
                      <button
                        type="button"
                        className="secondary-button compact"
                        disabled={settingDefaultId === settingsPrinter.id}
                        onClick={() => {
                          void (async () => {
                            await handleSetDefaultPrinter(settingsPrinter);
                            setSettingsPrinter(null);
                          })();
                        }}
                      >
                        {settingDefaultId === settingsPrinter.id
                          ? "Setting…"
                          : "Set Default"}
                      </button>
                    )}
                  </div>

                  {/* Routing Priority */}
                  <div>
                    <label
                      htmlFor="printer-priority"
                      style={{ display: "block", marginBottom: "0.35rem" }}
                    >
                      Routing Priority (0 = Normal, 1+ = Higher):
                    </label>
                    <input
                      id="printer-priority"
                      type="number"
                      min={0}
                      max={100}
                      value={formPriority}
                      onChange={(e) =>
                        setFormPriority(Number(e.target.value) || 0)
                      }
                    />
                    <p
                      className="muted"
                      style={{ fontSize: "0.75rem", margin: "0.25rem 0 0 0" }}
                    >
                      Higher priority printers are selected first when multiple
                      printers match order specs.
                    </p>
                  </div>

                  {/* Fallback Printer */}
                  <div>
                    <label
                      htmlFor="printer-fallback"
                      style={{ display: "block", marginBottom: "0.35rem" }}
                    >
                      Automatic Fallback Printer (Optional):
                    </label>
                    <select
                      id="printer-fallback"
                      value={formFallbackId}
                      onChange={(e) => setFormFallbackId(e.target.value)}
                    >
                      <option value="">None (No fallback)</option>
                      {displayedPrinters
                        .filter((p) => p.id !== settingsPrinter.id && p.enabled)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.displayName} (
                            {formatSimpleCapabilities(p.capabilities)})
                          </option>
                        ))}
                    </select>
                    {formFallbackId ? (
                      <label
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "0.4rem",
                          marginTop: "0.4rem",
                          fontSize: "0.8rem",
                          color: "#334155",
                          cursor: "pointer",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={formAutoFallback}
                          onChange={(e) =>
                            setFormAutoFallback(e.target.checked)
                          }
                          disabled
                        />
                        <span style={{ opacity: 0.7 }}>
                          Auto-reroute to fallback printer when this printer is
                          paused or offline <i>(Routing coming in Phase 3)</i>
                        </span>
                      </label>
                    ) : null}
                  </div>

                  {/* Advanced Technical Details */}
                  <details
                    style={{
                      borderTop: "1px solid #e2e8f0",
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
                      Advanced Technical Details
                    </summary>
                    <div
                      style={{
                        marginTop: "0.5rem",
                        display: "grid",
                        gap: "0.35rem",
                        fontSize: "0.8rem",
                        color: "#475569",
                        backgroundColor: "#f8fafc",
                        padding: "0.75rem",
                        borderRadius: "6px",
                      }}
                    >
                      <div>
                        Windows Queue:{" "}
                        <code>{settingsPrinter.windowsPrinterName}</code>
                      </div>
                      <div>
                        Port:{" "}
                        <code>{settingsPrinter.portName || "Local/USB"}</code>
                      </div>
                      <div>
                        Driver:{" "}
                        <code>
                          {settingsPrinter.driverName || "Standard Driver"}
                        </code>
                      </div>
                      <div>
                        Hardware ID: <code>{settingsPrinter.id}</code>
                      </div>
                      <div>
                        Supported Sizes:{" "}
                        {settingsPrinter.capabilities?.paperSizes?.join(", ") ||
                          "A4"}
                      </div>
                    </div>
                  </details>
                </div>

                <div
                  style={{
                    padding: "1rem 1.5rem",
                    borderTop: "1px solid #e2e8f0",
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: "0.5rem",
                  }}
                >
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setSettingsPrinter(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={savingSettings}
                    onClick={() => void handleSaveSettings()}
                  >
                    {savingSettings ? "Saving…" : "Save Settings"}
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
