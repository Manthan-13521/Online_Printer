import { startVisiblePolling } from "./utils/polling";
import { formatRelativeTime } from "./utils/formatters";
import type {
  AdminAgentDetails,
  AdminPrinterDetails,
  AdminTestPrintDetails,
} from "@printgo/api-contract";
import type { PrinterCapabilityFeatures } from "@printgo/domain";
import { useEffect, useState } from "react";

import { adminApi, AdminApiError, friendlyAdminError } from "./api";
import { useAdminWebSocket } from "./useAdminWebSocket";
import {
  getWindowsAgentReleaseConfig,
  buildAgentConnectionUrl,
} from "./agent-download";
import {
  AddPrinterModal,
  AgentPairingBanner,
  PrinterCard,
  PrinterSettingsModal,
  PrinterVerificationModal,
  TestPrintModal,
  isVirtualPrinter,
} from "./printers";

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
  const [formEnabledServices, setFormEnabledServices] =
    useState<PrinterCapabilityFeatures | null>(null);
  const [formPhysicalDeviceId, setFormPhysicalDeviceId] = useState<string>("");
  const [savingSettings, setSavingSettings] = useState(false);

  // Guided Verification modal state
  const [verifyingPrinter, setVerifyingPrinter] =
    useState<AdminPrinterDetails | null>(null);
  const [verifyingFeatures, setVerifyingFeatures] =
    useState<PrinterCapabilityFeatures>({
      bw: true,
      color: false,
      duplex: false,
      a4: true,
      a3: false,
    });
  const [verifyingEnabled, setVerifyingEnabled] =
    useState<PrinterCapabilityFeatures>({
      bw: true,
      color: false,
      duplex: false,
      a4: true,
      a3: false,
    });
  const [verificationNotes, setVerificationNotes] = useState("");
  const [savingVerification, setSavingVerification] = useState(false);

  // Test print selection state
  const [testPrintMenuPrinter, setTestPrintMenuPrinter] =
    useState<AdminPrinterDetails | null>(null);

  useEffect(() => {
    if (!testPrintMenuPrinter) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setTestPrintMenuPrinter(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [testPrintMenuPrinter]);

  const testPrinterFeatures = testPrintMenuPrinter
    ? testPrintMenuPrinter.verifiedCapabilities &&
      !testPrintMenuPrinter.verifiedCapabilities.requiresReview
      ? {
          bw: Boolean(
            testPrintMenuPrinter.verifiedCapabilities.verified.bw &&
            (testPrintMenuPrinter.enabledServices
              ? testPrintMenuPrinter.enabledServices.bw
              : true),
          ),
          color: Boolean(
            testPrintMenuPrinter.verifiedCapabilities.verified.color &&
            (testPrintMenuPrinter.enabledServices
              ? testPrintMenuPrinter.enabledServices.color
              : true),
          ),
          duplex: Boolean(
            testPrintMenuPrinter.verifiedCapabilities.verified.duplex &&
            (testPrintMenuPrinter.enabledServices
              ? testPrintMenuPrinter.enabledServices.duplex
              : true),
          ),
          a4: Boolean(
            testPrintMenuPrinter.verifiedCapabilities.verified.a4 &&
            (testPrintMenuPrinter.enabledServices
              ? testPrintMenuPrinter.enabledServices.a4
              : true),
          ),
          a3: Boolean(
            testPrintMenuPrinter.verifiedCapabilities.verified.a3 &&
            (testPrintMenuPrinter.enabledServices
              ? testPrintMenuPrinter.enabledServices.a3
              : true),
          ),
        }
      : {
          bw: true,
          color: testPrintMenuPrinter.capabilities?.colour === true,
          duplex: testPrintMenuPrinter.capabilities?.duplex === true,
          a4:
            !testPrintMenuPrinter.capabilities?.paperSizes ||
            testPrintMenuPrinter.capabilities.paperSizes.includes("A4"),
          a3: Boolean(
            testPrintMenuPrinter.capabilities?.paperSizes?.includes("A3"),
          ),
        }
    : null;

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

  useAdminWebSocket(() => {
    void loadPrinters();
  });

  useEffect(() => {
    return startVisiblePolling(loadPrinters, 90_000);
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

  async function handleRequestTestPrint(
    printer: AdminPrinterDetails,
    type?: "STANDARD" | "COLOR" | "DUPLEX" | "A3",
  ) {
    setRequestingTestPrintId(printer.id);
    setError(null);
    setNotice(null);
    try {
      const res = await (type && type !== "STANDARD"
        ? adminApi.requestTestPrint(printer.id, {
            testType: type,
            testSettings: {
              colorMode: type === "COLOR" ? "COLOR" : "BW",
              sides: type === "DUPLEX" ? "DOUBLE" : "SINGLE",
              paperSize: type === "A3" ? "A3" : "A4",
            },
          })
        : adminApi.requestTestPrint(printer.id));
      if (res.ok) {
        setTestPrints((prev) => ({
          ...prev,
          [printer.id]: res.data.testPrint,
        }));
        setNotice(
          `${type ?? "Standard"} test page sent to "${printer.displayName}". Please inspect the physical printout.`,
        );
      }
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    } finally {
      setRequestingTestPrintId(null);
      setTestPrintMenuPrinter(null);
    }
  }

  function openVerificationModal(printer: AdminPrinterDetails) {
    setVerifyingPrinter(printer);
    const existingVerified = printer.verifiedCapabilities?.verified;
    const initialVerified: PrinterCapabilityFeatures = existingVerified ?? {
      bw: true,
      color: Boolean(
        printer.capabilities?.colour === true ||
        printer.capabilities?.colour === "UNKNOWN",
      ),
      duplex: Boolean(printer.capabilities?.duplex === true),
      a4:
        !printer.capabilities?.paperSizes ||
        printer.capabilities.paperSizes.includes("A4"),
      a3: Boolean(printer.capabilities?.paperSizes?.includes("A3")),
    };
    setVerifyingFeatures(initialVerified);
    setVerifyingEnabled(printer.enabledServices ?? initialVerified);
    setVerificationNotes(printer.verifiedCapabilities?.notes ?? "");
  }

  async function handleSaveVerification() {
    if (!verifyingPrinter) return;
    setSavingVerification(true);
    setError(null);
    setNotice(null);
    try {
      const res = await adminApi.verifyPrinterCapabilities(
        verifyingPrinter.id,
        {
          verified: verifyingFeatures,
          enabled: verifyingEnabled,
          notes: verificationNotes.trim() || undefined,
        },
      );
      if (res.ok) {
        setNotice(
          `Hardware capabilities verified & certified for "${verifyingPrinter.displayName}".`,
        );
        setVerifyingPrinter(null);
        await loadPrinters();
      }
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    } finally {
      setSavingVerification(false);
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
    setFormEnabledServices(printer.enabledServices ?? null);
    setFormPhysicalDeviceId(printer.physicalDeviceId ?? "");
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
        ...(formPhysicalDeviceId.trim()
          ? { physicalDeviceId: formPhysicalDeviceId.trim() }
          : settingsPrinter.physicalDeviceId
            ? { physicalDeviceId: null }
            : {}),
        ...(formEnabledServices
          ? { enabledServices: formEnabledServices }
          : {}),
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
        <AgentPairingBanner
          pairCode={pairCode}
          pairExpiresAt={pairExpiresAt}
          connectionLink={connectionLink}
          copiedCode={copiedCode}
          copiedLink={copiedLink}
          onDismiss={() => setPairCode(null)}
          onCopyPairCode={copyPairCodeOnly}
          onCopyConnectionLink={copyConnectionLink}
        />
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
                  const isAgentOnline = Boolean(activeAgent?.isOnline);

                  return (
                    <PrinterCard
                      key={p.id}
                      printer={p}
                      isDefault={Boolean(isDefault)}
                      isAgentOnline={isAgentOnline}
                      activeAgent={activeAgent}
                      testPrint={tp}
                      isTesting={Boolean(isTesting)}
                      togglingPrinterId={togglingPrinterId}
                      settingDefaultId={settingDefaultId}
                      checkingHealthId={checkingHealthId}
                      requestingTestPrintId={requestingTestPrintId}
                      displayedPrinters={displayedPrinters}
                      onOpenTestPrintMenu={(printer) =>
                        setTestPrintMenuPrinter(printer)
                      }
                      onOpenSettings={openSettingsModal}
                      onOpenVerification={openVerificationModal}
                      onRequestTestPrint={(printer, type) =>
                        void handleRequestTestPrint(printer, type)
                      }
                      onTogglePrinter={(printer) =>
                        void handleTogglePrinter(printer)
                      }
                      onSetDefault={(printer) =>
                        void handleSetDefaultPrinter(printer)
                      }
                      onCheckHealth={(printerId) =>
                        void handleCheckHealth(printerId)
                      }
                    />
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
          <AddPrinterModal
            isOpen={isAddingPrinter}
            unconfiguredPrinters={unconfiguredPrinters}
            togglingPrinterId={togglingPrinterId}
            refreshing={refreshing}
            onClose={() => setIsAddingPrinter(false)}
            onTogglePrinter={(printer) => void handleTogglePrinter(printer)}
            onScanPrinters={() => void loadPrinters(true)}
          />

          {/* SETTINGS MODAL */}
          <PrinterSettingsModal
            printer={settingsPrinter}
            defaultProductionPrinterId={defaultProductionPrinterId}
            displayedPrinters={displayedPrinters}
            formDisplayName={formDisplayName}
            setFormDisplayName={setFormDisplayName}
            formPriority={formPriority}
            setFormPriority={setFormPriority}
            formEnabled={formEnabled}
            setFormEnabled={setFormEnabled}
            formFallbackId={formFallbackId}
            setFormFallbackId={setFormFallbackId}
            formAutoFallback={formAutoFallback}
            setFormAutoFallback={setFormAutoFallback}
            formEnabledServices={formEnabledServices}
            setFormEnabledServices={setFormEnabledServices}
            formPhysicalDeviceId={formPhysicalDeviceId}
            setFormPhysicalDeviceId={setFormPhysicalDeviceId}
            settingDefaultId={settingDefaultId}
            savingSettings={savingSettings}
            onClose={() => setSettingsPrinter(null)}
            onSetDefault={(printer) => void handleSetDefaultPrinter(printer)}
            onSaveSettings={() => void handleSaveSettings()}
          />

          {/* TEST PRINT SELECTION MODAL */}
          <TestPrintModal
            printer={testPrintMenuPrinter}
            testPrinterFeatures={testPrinterFeatures}
            onClose={() => setTestPrintMenuPrinter(null)}
            onRequestTestPrint={(printer, type) =>
              void handleRequestTestPrint(printer, type)
            }
          />

          {/* GUIDED CAPABILITY VERIFICATION MODAL */}
          <PrinterVerificationModal
            printer={verifyingPrinter}
            verifyingFeatures={verifyingFeatures}
            setVerifyingFeatures={setVerifyingFeatures}
            verifyingEnabled={verifyingEnabled}
            setVerifyingEnabled={setVerifyingEnabled}
            verificationNotes={verificationNotes}
            setVerificationNotes={setVerificationNotes}
            savingVerification={savingVerification}
            onClose={() => setVerifyingPrinter(null)}
            onSaveVerification={() => void handleSaveVerification()}
          />
        </>
      )}
    </div>
  );
}
