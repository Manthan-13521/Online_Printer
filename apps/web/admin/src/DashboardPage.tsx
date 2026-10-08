import { applyShopBranding } from "../../branding";
import { startVisiblePolling } from "../../polling";
import type {
  AdminAgentDetails,
  AdminPrinterDetails,
  ShopSettings,
} from "@printgo/api-contract";
import { useEffect, useState } from "react";
import { adminApi, AdminApiError, friendlyAdminError } from "./api";

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
  const [togglingPrinting, setTogglingPrinting] = useState(false);
  const [togglingIdSheet, setTogglingIdSheet] = useState(false);
  const [confirmPause, setConfirmPause] = useState(false);

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

  useEffect(() => {
    let cancelled = false;
    async function loadDashboard() {
      try {
        setError(null);
        const response = await adminApi.getDashboard();
        if (cancelled || !response.ok) return;
        const data = response.data;
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
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = friendlyAdminError(err);
        if (err instanceof AdminApiError && err.status === 401) {
          onSessionExpired(msg);
        } else {
          setError(msg);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    const stop = startVisiblePolling(loadDashboard, 30_000);
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
      Date.now() - new Date(activeAgent.lastHeartbeatAt).getTime() < 90000),
  );
  const printerReady = Boolean(
    defaultPrinter &&
    defaultPrinter.enabled &&
    defaultPrinter.status === "ONLINE",
  );
  const onlinePrinting = Boolean(settings?.onlinePrintingEnabled);
  const canAcceptOrders = onlinePrinting && agentOnline && printerReady;

  return (
    <div className="dashboard-page">
      <header className="page-header" style={{ marginBottom: "1.5rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.75rem" }}>
          {settings?.shopName ?? settings?.appName ?? "PrintGo"}
        </h1>
      </header>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {/* Top 4 Cards */}
      <section
        className="status-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "1rem",
          marginBottom: "1.5rem",
        }}
      >
        <div
          className="panel"
          style={{
            padding: "1.5rem",
            backgroundColor: "#f0fdf4",
            border: "1px solid #bbf7d0",
          }}
        >
          <p
            className="muted"
            style={{
              margin: 0,
              fontSize: "0.85rem",
              fontWeight: "bold",
              color: "#166534",
            }}
          >
            TODAY'S EARNINGS
          </p>
          <div
            style={{
              fontSize: "2rem",
              fontWeight: "bold",
              color: "#15803d",
              marginTop: "0.5rem",
            }}
          >
            ₹{(counts.todaysEarningsPaise / 100).toFixed(2)}
          </div>
        </div>

        <div
          className="panel"
          style={{
            padding: "1.5rem",
            backgroundColor: "#eff6ff",
            border: "1px solid #bfdbfe",
          }}
        >
          <p
            className="muted"
            style={{
              margin: 0,
              fontSize: "0.85rem",
              fontWeight: "bold",
              color: "#1e40af",
            }}
          >
            TODAY'S ORDERS
          </p>
          <div
            style={{
              fontSize: "2rem",
              fontWeight: "bold",
              color: "#1d4ed8",
              marginTop: "0.5rem",
            }}
          >
            {counts.todaysOrders}
          </div>
        </div>

        <div
          className="panel"
          style={{
            padding: "1.5rem",
            backgroundColor: "#fef3c7",
            border: "1px solid #fde68a",
          }}
        >
          <p
            className="muted"
            style={{
              margin: 0,
              fontSize: "0.85rem",
              fontWeight: "bold",
              color: "#92400e",
            }}
          >
            IN QUEUE
          </p>
          <div
            style={{
              fontSize: "2rem",
              fontWeight: "bold",
              color: "#b45309",
              marginTop: "0.5rem",
            }}
          >
            {counts.inQueue}
          </div>
        </div>

        <div
          className="panel"
          style={{
            padding: "1.5rem",
            backgroundColor: "#fdf4ff",
            border: "1px solid #fbcfe8",
          }}
        >
          <p
            className="muted"
            style={{
              margin: 0,
              fontSize: "0.85rem",
              fontWeight: "bold",
              color: "#86198f",
            }}
          >
            PRINTING NOW
          </p>
          <div
            style={{
              fontSize: "2rem",
              fontWeight: "bold",
              color: "#a21caf",
              marginTop: "0.5rem",
            }}
          >
            {counts.printingNow}
          </div>
        </div>
      </section>

      {/* Order Status Section */}
      <h2
        style={{ fontSize: "1.15rem", margin: "0 0 1rem 0", color: "#334155" }}
      >
        Order Status
      </h2>
      {/* Customer Readiness Banner */}
      {!canAcceptOrders ? (
        <section
          className="panel"
          style={{
            marginBottom: "1.5rem",
            backgroundColor: "#fef2f2",
            border: "1px solid #fecaca",
            padding: "1.25rem",
          }}
        >
          <h2
            style={{
              margin: "0 0 0.5rem 0",
              color: "#991b1b",
              fontSize: "1.15rem",
            }}
          >
            ⚠️ Online Printing Cannot Accept Payments Yet
          </h2>
          <p style={{ margin: 0, color: "#991b1b" }}>
            Before customers can pay and submit jobs, ensure:
          </p>
          <ul style={{ margin: "0.5rem 0 0 1.25rem", color: "#991b1b" }}>
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
            marginBottom: "1.5rem",
            backgroundColor: "#f0fdf4",
            border: "1px solid #bbf7d0",
            padding: "1.25rem",
          }}
        >
          <h2
            style={{
              margin: "0 0 0.5rem 0",
              color: "#166534",
              fontSize: "1.15rem",
            }}
          >
            ✅ Your Website is Accepting Online Orders
          </h2>
          <p style={{ margin: 0, color: "#15803d" }}>
            All systems ready! The PrintGo Windows Agent is running on the shop
            PC and your printer is connected and working.
          </p>
        </section>
      )}

      <section
        className="panel"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "1.5rem",
          padding: "1.5rem",
          marginBottom: "1.5rem",
          justifyContent: "space-around",
        }}
      >
        <button
          onClick={() => onNavigate("/admin/live-orders")}
          type="button"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            textAlign: "center",
            padding: "0.5rem",
          }}
        >
          <div
            style={{ fontSize: "2rem", fontWeight: "bold", color: "#3b82f6" }}
          >
            {counts.statusCounts.waiting}
          </div>
          <div
            style={{
              fontSize: "0.9rem",
              fontWeight: "bold",
              color: "#64748b",
              marginTop: "0.25rem",
            }}
          >
            Waiting
          </div>
        </button>

        <button
          onClick={() => onNavigate("/admin/live-orders")}
          type="button"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            textAlign: "center",
            padding: "0.5rem",
          }}
        >
          <div
            style={{ fontSize: "2rem", fontWeight: "bold", color: "#8b5cf6" }}
          >
            {counts.statusCounts.printing}
          </div>
          <div
            style={{
              fontSize: "0.9rem",
              fontWeight: "bold",
              color: "#64748b",
              marginTop: "0.25rem",
            }}
          >
            Printing
          </div>
        </button>

        <button
          onClick={() => onNavigate("/admin/live-orders")}
          type="button"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            textAlign: "center",
            padding: "0.5rem",
          }}
        >
          <div
            style={{ fontSize: "2rem", fontWeight: "bold", color: "#10b981" }}
          >
            {counts.statusCounts.readyForPickup}
          </div>
          <div
            style={{
              fontSize: "0.9rem",
              fontWeight: "bold",
              color: "#64748b",
              marginTop: "0.25rem",
            }}
          >
            Ready for Pickup
          </div>
        </button>

        <button
          onClick={() => onNavigate("/admin/live-orders")}
          type="button"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            textAlign: "center",
            padding: "0.5rem",
          }}
        >
          <div
            style={{
              fontSize: "2rem",
              fontWeight: "bold",
              color:
                counts.statusCounts.needsAttention > 0 ? "#ef4444" : "#64748b",
            }}
          >
            {counts.statusCounts.needsAttention}
          </div>
          <div
            style={{
              fontSize: "0.9rem",
              fontWeight: "bold",
              color:
                counts.statusCounts.needsAttention > 0 ? "#ef4444" : "#64748b",
              marginTop: "0.25rem",
            }}
          >
            Needs Attention
          </div>
        </button>
      </section>

      {/* Identification Sheet & Online Printing Controls */}
      <section
        className="panel"
        style={{ padding: "1.25rem", marginBottom: "1.5rem" }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-start",
            gap: "1rem",
            paddingBottom: "0.75rem",
            borderBottom: "1px solid #e2e8f0",
            marginBottom: "0.75rem",
          }}
        >
          <span>
            Identification sheet:{" "}
            <strong
              style={{
                color: settings?.identificationSheetEnabled
                  ? "#16a34a"
                  : "#64748b",
              }}
            >
              {settings?.identificationSheetEnabled ? "ON" : "OFF"}
            </strong>
          </span>
          {settings ? (
            <div
              style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
            >
              <span style={{ fontSize: "0.85rem", fontWeight: "bold" }}>
                {settings.identificationSheetEnabled ? "Enabled" : "Disabled"}
              </span>
              <label className="toggle-switch">
                <input
                  aria-label="Toggle Identification Sheet"
                  checked={settings.identificationSheetEnabled}
                  disabled={togglingIdSheet}
                  onChange={(event) => {
                    void handleToggleIdSheet(event.target.checked);
                  }}
                  role="switch"
                  type="checkbox"
                />
                <span className="toggle-slider" />
              </label>
            </div>
          ) : null}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-start",
            gap: "1rem",
          }}
        >
          <span>
            Online Printing:{" "}
            <strong style={{ color: onlinePrinting ? "#16a34a" : "#dc2626" }}>
              {onlinePrinting ? "ON" : "OFF"}
            </strong>
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span style={{ fontSize: "0.85rem", fontWeight: "bold" }}>
              {onlinePrinting ? "Accepting" : "Paused"}
            </span>
            <label className="toggle-switch">
              <input
                aria-label="Toggle Online Printing"
                checked={onlinePrinting}
                disabled={togglingPrinting}
                onChange={(event) => {
                  void handleToggleOnlinePrinting(event.target.checked);
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
