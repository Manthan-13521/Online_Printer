import { applyShopBranding } from "./utils/branding";
import { startVisiblePolling } from "./utils/polling";
import type {
  AdminAgentDetails,
  AdminPrinterDetails,
  ShopSettings,
} from "@printgo/api-contract";
import { useEffect, useRef, useState } from "react";
import { adminApi, AdminApiError, friendlyAdminError } from "./api";
import { useAdminWebSocket } from "./useAdminWebSocket";

interface DashboardPageProps {
  onSessionExpired: (message: string) => void;
  onNavigate: (path: string) => void;
}

export function DashboardPage({
  onSessionExpired,
  onNavigate,
}: DashboardPageProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<ShopSettings | null>(null);
  const [agents, setAgents] = useState<AdminAgentDetails[]>([]);
  const [printers, setPrinters] = useState<AdminPrinterDetails[]>([]);
  const [defaultPrinterId, setDefaultPrinterId] = useState<string | null>(null);
  const [counts, setCounts] = useState({
    todaysEarningsPaise: 0,
    todaysOrders: 0,
    inQueue: 0,
    printingNow: 0,
    statusCounts: {
      waiting: 0,
      printing: 0,
      readyForPickup: 0,
      needsAttention: 0,
    },
  });
  const [manualCount, setManualCount] = useState<number>(0);
  const [pendingCashCount, setPendingCashCount] = useState<number>(0);
  const [togglingPrinting, setTogglingPrinting] = useState(false);
  const [togglingIdSheet, setTogglingIdSheet] = useState(false);
  const [togglingCash, setTogglingCash] = useState(false);
  const [confirmPause, setConfirmPause] = useState(false);

  async function handleToggleCashOrders(enabled: boolean) {
    if (!settings || togglingCash) return;
    setTogglingCash(true);
    setError(null);
    try {
      const response = await adminApi.updateSettings({
        ...settings,
        cashOrdersEnabled: enabled,
      });
      if (response.ok) {
        setSettings(response.data.settings);
      }
    } catch (err: unknown) {
      if (err instanceof AdminApiError && err.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(err));
    } finally {
      setTogglingCash(false);
    }
  }

  async function handleToggleIdSheet(enabled: boolean) {
    if (!settings || togglingIdSheet) return;
    setTogglingIdSheet(true);
    setError(null);
    try {
      const response = await adminApi.updateSettings({
        ...settings,
        identificationSheetEnabled: enabled,
      });
      if (response.ok) {
        setSettings(response.data.settings);
      }
    } catch (err: unknown) {
      if (err instanceof AdminApiError && err.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(err));
    } finally {
      setTogglingIdSheet(false);
    }
  }

  async function handleToggleOnlinePrinting(enabled: boolean) {
    if (!settings || togglingPrinting) return;
    if (!enabled && settings.onlinePrintingEnabled) {
      setConfirmPause(true);
      return;
    }
    await saveOnlinePrinting(enabled);
  }

  async function saveOnlinePrinting(enabled: boolean) {
    if (!settings) return;
    setTogglingPrinting(true);
    setError(null);
    try {
      const response = await adminApi.updateSettings({
        ...settings,
        onlinePrintingEnabled: enabled,
      });
      if (response.ok) {
        setSettings(response.data.settings);
      }
    } catch (err: unknown) {
      if (err instanceof AdminApiError && err.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(err));
    } finally {
      setTogglingPrinting(false);
    }
  }

  const prevSnapshotRef = useRef("");

  const loadDashboard = async (): Promise<boolean> => {
    try {
      setError(null);
      const response = await adminApi.getDashboard();
      if (!response.ok) return false;
      const data = response.data;
      const snapshot = JSON.stringify(data);
      const changed = snapshot !== prevSnapshotRef.current;
      prevSnapshotRef.current = snapshot;
      setSettings(data.settings);
      setAgents(data.agents);
      setPrinters(data.agents.flatMap((a) => a.printers));
      setDefaultPrinterId(data.defaultProductionPrinterId);
      setCounts({
        todaysEarningsPaise: data.todaysEarningsPaise,
        todaysOrders: data.todaysOrders,
        inQueue: data.inQueue,
        printingNow: data.printingNow,
        statusCounts: data.statusCounts,
      });

      if (typeof adminApi.getManualOrders === "function") {
        try {
          const manualRes = await adminApi.getManualOrders();
          if (manualRes && manualRes.ok) {
            setManualCount(manualRes.data.orders.length);
          } else {
            setManualCount(data.statusCounts?.readyForPickup ?? 0);
          }
        } catch {
          setManualCount(data.statusCounts?.readyForPickup ?? 0);
        }
      } else {
        setManualCount(data.statusCounts?.readyForPickup ?? 0);
      }

      if (typeof adminApi.getCashOrders === "function") {
        try {
          const cashRes = await adminApi.getCashOrders();
          if (cashRes && cashRes.ok) {
            const now = Date.now();
            const activeCash = cashRes.data.orders.filter(
              (o) => now < o.cashGraceUntilMs,
            ).length;
            setPendingCashCount(activeCash);
          }
        } catch {
          // Keep current or 0
        }
      }

      return changed;
    } catch (err: unknown) {
      const msg = friendlyAdminError(err);
      if (err instanceof AdminApiError && err.status === 401) {
        onSessionExpired(msg);
      } else {
        setError(msg);
      }
      return false;
    } finally {
      setLoading(false);
    }
  };

  useAdminWebSocket(() => {
    void loadDashboard();
  });

  useEffect(() => {
    let cancelled = false;
    const stop = startVisiblePolling(
      async () => {
        if (cancelled) return false;
        return await loadDashboard();
      },
      35_000,
      70_000,
    );
    return () => {
      cancelled = true;
      stop();
    };
  }, [onSessionExpired]);

  useEffect(() => {
    if (settings?.appName) return applyShopBranding(settings.appName, true);
    if (settings?.shopName) return applyShopBranding(settings.shopName, true);
    return undefined;
  }, [settings?.appName, settings?.shopName]);

  if (loading) {
    return (
      <main className="loading-screen" aria-busy="true">
        <span className="spinner" aria-hidden="true" />
        <p>Loading shop operations...</p>
      </main>
    );
  }

  const defaultPrinter = printers.find((p) => p.id === defaultPrinterId);
  const sortedAgents = [...agents].sort((a, b) => {
    if (a.isOnline && !b.isOnline) return -1;
    if (!a.isOnline && b.isOnline) return 1;
    const timeA = a.lastHeartbeatAt ? new Date(a.lastHeartbeatAt).getTime() : 0;
    const timeB = b.lastHeartbeatAt ? new Date(b.lastHeartbeatAt).getTime() : 0;
    return timeB - timeA;
  });
  const activeAgent = sortedAgents[0] ?? null;
  const agentOnline = Boolean(
    activeAgent?.isOnline ||
    (activeAgent &&
      activeAgent.isActive &&
      activeAgent.lastHeartbeatAt &&
      Date.now() - new Date(activeAgent.lastHeartbeatAt).getTime() < 150000),
  );
  const printerReady = Boolean(
    defaultPrinter &&
    defaultPrinter.enabled &&
    defaultPrinter.status === "ONLINE",
  );
  const onlinePrinting = Boolean(settings?.onlinePrintingEnabled);
  const canAcceptOrders = onlinePrinting && agentOnline && printerReady;
  const isAnyToggling = togglingIdSheet || togglingPrinting || togglingCash;
  const isCashEnabled = Boolean(settings?.cashOrdersEnabled);
  const isIdSheetEnabled = Boolean(settings?.identificationSheetEnabled);

  return (
    <div className="dashboard-page">
      <header className="page-header dashboard-header">
        <h1
          style={{
            margin: 0,
            fontSize: "1.65rem",
            fontWeight: 800,
            color: "#0f172a",
            letterSpacing: "-0.02em",
          }}
        >
          {settings?.shopName ?? settings?.appName ?? "PrintGo"}
        </h1>

        <div className="dashboard-status-counters">
          <button
            type="button"
            className="compact-status-counter blue-counter"
            onClick={() => onNavigate("/admin/manual-orders")}
            title="View Manual / Finishing Orders"
            aria-label={`Manual or Finishing Orders: ${manualCount}`}
          >
            <span
              className="compact-counter-icon blue-counter-icon"
              aria-hidden="true"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="6 9 6 2 18 2 18 9" />
                <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                <rect x="6" y="14" width="12" height="8" />
              </svg>
            </span>
            <span className="compact-counter-label">
              Manual / Finishing Orders
            </span>
            <span className="count-badge blue-count-badge">{manualCount}</span>
          </button>

          <button
            type="button"
            className="compact-status-counter green-counter"
            onClick={() => onNavigate("/admin/manual-orders")}
            title="View Pending Cash Orders"
            aria-label={`Pending Cash Orders: ${pendingCashCount}`}
          >
            <span
              className="compact-counter-icon green-counter-icon"
              aria-hidden="true"
            >
              ₹
            </span>
            <span className="compact-counter-label">Pending Cash Orders</span>
            <span className="count-badge green-count-badge">
              {pendingCashCount}
            </span>
          </button>
        </div>
      </header>

      {error ? (
        <p
          className="form-error"
          role="alert"
          style={{ marginBottom: "0.85rem" }}
        >
          {error}
        </p>
      ) : null}

      {/* Top 4 Summary Cards */}
      <section
        className="status-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "0.75rem",
          marginBottom: "1rem",
        }}
      >
        <div
          className="panel"
          style={{
            padding: "1rem 1.15rem",
            backgroundColor: "#f0fdf4",
            border: "1px solid #bbf7d0",
            borderRadius: "0.65rem",
          }}
        >
          <p
            className="muted"
            style={{
              margin: 0,
              fontSize: "0.75rem",
              fontWeight: "bold",
              color: "#166534",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
            }}
          >
            TODAY'S EARNINGS
          </p>
          <div
            style={{
              fontSize: "1.75rem",
              fontWeight: "bold",
              color: "#15803d",
              marginTop: "0.35rem",
              lineHeight: 1.1,
            }}
          >
            ₹{(counts.todaysEarningsPaise / 100).toFixed(2)}
          </div>
        </div>

        <div
          className="panel"
          style={{
            padding: "1rem 1.15rem",
            backgroundColor: "#eff6ff",
            border: "1px solid #bfdbfe",
            borderRadius: "0.65rem",
          }}
        >
          <p
            className="muted"
            style={{
              margin: 0,
              fontSize: "0.75rem",
              fontWeight: "bold",
              color: "#1e40af",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
            }}
          >
            TODAY'S ORDERS
          </p>
          <div
            style={{
              fontSize: "1.75rem",
              fontWeight: "bold",
              color: "#1d4ed8",
              marginTop: "0.35rem",
              lineHeight: 1.1,
            }}
          >
            {counts.todaysOrders}
          </div>
        </div>

        <div
          className="panel"
          style={{
            padding: "1rem 1.15rem",
            backgroundColor: "#fef3c7",
            border: "1px solid #fde68a",
            borderRadius: "0.65rem",
          }}
        >
          <p
            className="muted"
            style={{
              margin: 0,
              fontSize: "0.75rem",
              fontWeight: "bold",
              color: "#92400e",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
            }}
          >
            IN QUEUE
          </p>
          <div
            style={{
              fontSize: "1.75rem",
              fontWeight: "bold",
              color: "#b45309",
              marginTop: "0.35rem",
              lineHeight: 1.1,
            }}
          >
            {counts.inQueue}
          </div>
        </div>

        <div
          className="panel"
          style={{
            padding: "1rem 1.15rem",
            backgroundColor: "#fdf4ff",
            border: "1px solid #fbcfe8",
            borderRadius: "0.65rem",
          }}
        >
          <p
            className="muted"
            style={{
              margin: 0,
              fontSize: "0.75rem",
              fontWeight: "bold",
              color: "#86198f",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
            }}
          >
            PRINTING NOW
          </p>
          <div
            style={{
              fontSize: "1.75rem",
              fontWeight: "bold",
              color: "#a21caf",
              marginTop: "0.35rem",
              lineHeight: 1.1,
            }}
          >
            {counts.printingNow}
          </div>
        </div>
      </section>

      {/* Customer Readiness / Shop Status Banner */}
      {!canAcceptOrders ? (
        <section
          className="panel"
          style={{
            marginBottom: "1rem",
            backgroundColor: "#fef2f2",
            border: "1px solid #fecaca",
            padding: "0.9rem 1.15rem",
            borderRadius: "0.65rem",
          }}
        >
          <h2
            style={{
              margin: "0 0 0.35rem 0",
              color: "#991b1b",
              fontSize: "1.05rem",
              fontWeight: 700,
            }}
          >
            ⚠️ Online Printing Cannot Accept Payments Yet
          </h2>
          <p style={{ margin: 0, color: "#991b1b", fontSize: "0.9rem" }}>
            Before customers can pay and submit jobs, ensure:
          </p>
          <ul
            style={{
              margin: "0.35rem 0 0 1.25rem",
              color: "#991b1b",
              fontSize: "0.88rem",
            }}
          >
            {!onlinePrinting ? (
              <li>Online printing is enabled in Shop Settings.</li>
            ) : null}
            {!agentOnline ? (
              <li>The PrintGo Windows Agent is running on the shop PC.</li>
            ) : null}
            {!printerReady ? (
              <li>The production printer is connected and working.</li>
            ) : null}
          </ul>
        </section>
      ) : (
        <section
          className="panel"
          style={{
            marginBottom: "1rem",
            backgroundColor: "#f0fdf4",
            border: "1px solid #bbf7d0",
            padding: "0.9rem 1.15rem",
            borderRadius: "0.65rem",
          }}
        >
          <h2
            style={{
              margin: "0 0 0.25rem 0",
              color: "#166534",
              fontSize: "1.05rem",
              fontWeight: 700,
            }}
          >
            ✅ Your Website is Accepting Online Orders
          </h2>
          <p style={{ margin: 0, color: "#15803d", fontSize: "0.9rem" }}>
            All systems ready! The PrintGo Windows Agent is running on the shop
            PC and your printer is connected and working.
          </p>
        </section>
      )}

      {/* Compact Shop Controls (3 Toggles) */}
      <section
        className="panel shop-controls-panel"
        aria-label="Shop Controls"
        style={{
          padding: "1rem 1.15rem",
          marginBottom: "1rem",
          backgroundColor: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "0.65rem",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "0.75rem",
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: "0.95rem",
              fontWeight: 700,
              color: "#334155",
              letterSpacing: "0.01em",
            }}
          >
            Shop Controls
          </h2>
          {isAnyToggling ? (
            <span
              style={{
                fontSize: "0.78rem",
                color: "#64748b",
                fontWeight: 600,
              }}
            >
              Saving…
            </span>
          ) : null}
        </div>

        <div className="shop-controls-grid">
          {/* Toggle 1: Identification Sheet */}
          <div
            className="shop-control-card"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0.75rem 0.9rem",
              backgroundColor: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: "0.55rem",
              gap: "0.75rem",
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.15rem",
                minWidth: 0,
              }}
            >
              <span
                style={{
                  fontSize: "0.85rem",
                  fontWeight: 650,
                  color: "#1e293b",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                Identification Sheet
              </span>
              <span
                style={{
                  fontSize: "0.72rem",
                  fontWeight: 750,
                  color: isIdSheetEnabled ? "#16a34a" : "#64748b",
                  letterSpacing: "0.03em",
                }}
              >
                {isIdSheetEnabled ? "ON" : "OFF"}
              </span>
            </div>
            <label className="toggle-switch" style={{ flexShrink: 0 }}>
              <input
                aria-label="Toggle Identification Sheet"
                checked={isIdSheetEnabled}
                disabled={togglingIdSheet || !settings}
                onChange={(event) => {
                  void handleToggleIdSheet(event.target.checked);
                }}
                role="switch"
                type="checkbox"
              />
              <span className="toggle-slider" />
            </label>
          </div>

          {/* Toggle 2: Accept Online Orders */}
          <div
            className="shop-control-card"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0.75rem 0.9rem",
              backgroundColor: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: "0.55rem",
              gap: "0.75rem",
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.15rem",
                minWidth: 0,
              }}
            >
              <span
                style={{
                  fontSize: "0.85rem",
                  fontWeight: 650,
                  color: "#1e293b",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                Accept Online Orders
              </span>
              <span
                style={{
                  fontSize: "0.72rem",
                  fontWeight: 750,
                  color: onlinePrinting ? "#16a34a" : "#dc2626",
                  letterSpacing: "0.03em",
                }}
              >
                {onlinePrinting ? "ON" : "OFF"}
              </span>
            </div>
            <label className="toggle-switch" style={{ flexShrink: 0 }}>
              <input
                aria-label="Toggle Online Printing"
                checked={onlinePrinting}
                disabled={togglingPrinting || !settings}
                onChange={(event) => {
                  void handleToggleOnlinePrinting(event.target.checked);
                }}
                role="switch"
                type="checkbox"
              />
              <span className="toggle-slider" />
            </label>
          </div>

          {/* Toggle 3: Accept Cash Orders */}
          <div
            className="shop-control-card"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0.75rem 0.9rem",
              backgroundColor: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: "0.55rem",
              gap: "0.75rem",
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.15rem",
                minWidth: 0,
              }}
            >
              <span
                style={{
                  fontSize: "0.85rem",
                  fontWeight: 650,
                  color: "#1e293b",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                Accept Cash Orders
              </span>
              <span
                style={{
                  fontSize: "0.72rem",
                  fontWeight: 750,
                  color: isCashEnabled ? "#16a34a" : "#64748b",
                  letterSpacing: "0.03em",
                }}
              >
                {isCashEnabled ? "ON" : "OFF"}
              </span>
            </div>
            <label className="toggle-switch" style={{ flexShrink: 0 }}>
              <input
                aria-label="Toggle Accept Cash Orders"
                checked={isCashEnabled}
                disabled={togglingCash || !settings}
                onChange={(event) => {
                  void handleToggleCashOrders(event.target.checked);
                }}
                role="switch"
                type="checkbox"
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
      </section>

      {/* First-Run Setup Checklist */}
      <section
        className="panel"
        style={{ padding: "1.5rem", marginBottom: "1.5rem" }}
      >
        <h2 style={{ margin: "0 0 1rem 0" }}>Shop Launch Checklist</h2>
        <div
          style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
        >
          <div
            style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}
          >
            <span
              style={{
                fontSize: "1.25rem",
                color: agentOnline ? "#16a34a" : "#dc2626",
                fontWeight: "bold",
              }}
            >
              {agentOnline ? "✓" : "✕"}
            </span>
            <div>
              <strong>Connect Windows Counter PC</strong> —{" "}
              {agentOnline ? "PrintGo Agent connected" : "Not connected yet"}
            </div>
            <button
              className="text-button"
              onClick={() => onNavigate("/admin/printer")}
              style={{ marginLeft: "auto" }}
              type="button"
            >
              {agentOnline ? "View Agent" : "Connect PC"}
            </button>
          </div>

          <div
            style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}
          >
            <span
              style={{
                fontSize: "1.25rem",
                color: printerReady ? "#16a34a" : "#dc2626",
                fontWeight: "bold",
              }}
            >
              {printerReady ? "✓" : "✕"}
            </span>
            <div>
              <strong>Choose Default Production Printer</strong> —{" "}
              {defaultPrinter
                ? defaultPrinter.displayName
                : "No physical printer selected"}
            </div>
            <button
              className="text-button"
              onClick={() => onNavigate("/admin/printer")}
              style={{ marginLeft: "auto" }}
              type="button"
            >
              Select Printer
            </button>
          </div>

          <div
            style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}
          >
            <span
              style={{
                fontSize: "1.25rem",
                color: onlinePrinting ? "#16a34a" : "#dc2626",
                fontWeight: "bold",
              }}
            >
              {onlinePrinting ? "✓" : "✕"}
            </span>
            <div>
              <strong>Online Customer Orders</strong> —{" "}
              {onlinePrinting ? "Enabled" : "Paused"}
            </div>
            <button
              className="text-button"
              onClick={() => onNavigate("/admin/shop-settings")}
              style={{ marginLeft: "auto" }}
              type="button"
            >
              Toggle
            </button>
          </div>
        </div>
      </section>

      {confirmPause ? (
        <div className="dialog-backdrop">
          <section
            aria-labelledby="dashboard-pause-title"
            aria-modal="true"
            className="confirm-dialog"
            role="dialog"
          >
            <h2 id="dashboard-pause-title">Pause new online print orders?</h2>
            <p>
              New customers will not be able to upload or pay. Existing paid
              jobs will continue.
            </p>
            <div className="dialog-actions">
              <button
                className="secondary-button"
                onClick={() => setConfirmPause(false)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="danger-button"
                onClick={() => {
                  setConfirmPause(false);
                  void saveOnlinePrinting(false);
                }}
                type="button"
              >
                Pause Printing
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
