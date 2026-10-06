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
    queue: 0,
    attention: 0,
    completedToday: 0,
  });
  const [togglingPrinting, setTogglingPrinting] = useState(false);
  const [confirmPause, setConfirmPause] = useState(false);

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
          queue: data.queue,
          attention: data.attention,
          completedToday: data.completedToday,
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

  const ordersWaiting = counts.queue;
  const ordersAttention = counts.attention;

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

      {/* Critical Status Grid */}
      <section
        className="status-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "1rem",
          marginBottom: "1.5rem",
        }}
      >
        {/* Card 1: Online Printing */}
        <div className="panel" style={{ padding: "1.25rem" }}>
          <p
            className="muted"
            style={{ margin: 0, fontSize: "0.85rem", fontWeight: "bold" }}
          >
            ONLINE PRINTING
          </p>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              marginTop: "0.5rem",
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: "12px",
                height: "12px",
                borderRadius: "50%",
                backgroundColor: onlinePrinting ? "#22c55e" : "#94a3b8",
              }}
            />
            <span style={{ fontSize: "1.25rem", fontWeight: "bold" }}>
              {onlinePrinting ? "Accepting Orders" : "Paused"}
            </span>
          </div>
          <button
            className="text-button"
            onClick={() => onNavigate("/admin/shop-settings")}
            style={{ marginTop: "0.75rem", padding: 0 }}
            type="button"
          >
            {onlinePrinting ? "Manage settings →" : "Turn ON in settings →"}
          </button>
        </div>

        {/* Card 2: Windows Agent */}
        <div className="panel" style={{ padding: "1.25rem" }}>
          <p
            className="muted"
            style={{ margin: 0, fontSize: "0.85rem", fontWeight: "bold" }}
          >
            WINDOWS AGENT
          </p>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              marginTop: "0.5rem",
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: "12px",
                height: "12px",
                borderRadius: "50%",
                backgroundColor: agentOnline ? "#22c55e" : "#ef4444",
              }}
            />
            <span style={{ fontSize: "1.25rem", fontWeight: "bold" }}>
              {agentOnline ? "Connected" : "Disconnected"}
            </span>
          </div>
          <button
            className="text-button"
            onClick={() => onNavigate("/admin/printer")}
            style={{ marginTop: "0.75rem", padding: 0 }}
            type="button"
          >
            {agentOnline
              ? (activeAgent?.displayName ?? "Agent details →")
              : "Connect Windows PC →"}
          </button>
        </div>

        {/* Card 3: Production Printer */}
        <div className="panel" style={{ padding: "1.25rem" }}>
          <p
            className="muted"
            style={{ margin: 0, fontSize: "0.85rem", fontWeight: "bold" }}
          >
            PRODUCTION PRINTER
          </p>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              marginTop: "0.5rem",
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: "12px",
                height: "12px",
                borderRadius: "50%",
                backgroundColor: printerReady ? "#22c55e" : "#eab308",
              }}
            />
            <span
              style={{
                fontSize: "1.1rem",
                fontWeight: "bold",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {defaultPrinter ? defaultPrinter.displayName : "No printer set"}
            </span>
          </div>
          <button
            className="text-button"
            onClick={() => onNavigate("/admin/printer")}
            style={{ marginTop: "0.75rem", padding: 0 }}
            type="button"
          >
            {printerReady ? "Printer ready →" : "Choose printer →"}
          </button>
        </div>

        {/* Card 4: Orders in Queue */}
        <div className="panel" style={{ padding: "1.25rem" }}>
          <p
            className="muted"
            style={{ margin: 0, fontSize: "0.85rem", fontWeight: "bold" }}
          >
            ORDERS IN QUEUE
          </p>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: "0.5rem",
              marginTop: "0.5rem",
            }}
          >
            <span style={{ fontSize: "1.75rem", fontWeight: "bold" }}>
              {ordersWaiting}
            </span>
            <span className="muted" style={{ fontSize: "0.9rem" }}>
              waiting
            </span>
            {ordersAttention > 0 ? (
              <span
                style={{
                  color: "#ef4444",
                  fontWeight: "bold",
                  marginLeft: "auto",
                }}
              >
                ⚠️ {ordersAttention} need attention
              </span>
            ) : null}
          </div>
          <button
            className="text-button"
            onClick={() => onNavigate("/admin/live-orders")}
            style={{ marginTop: "0.75rem", padding: 0 }}
            type="button"
          >
            View live queue →
          </button>
        </div>

        {/* Card 5: Today's Orders */}
        <div className="panel" style={{ padding: "1.25rem" }}>
          <p
            className="muted"
            style={{ margin: 0, fontSize: "0.85rem", fontWeight: "bold" }}
          >
            TODAY'S ORDERS
          </p>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: "0.5rem",
              marginTop: "0.5rem",
            }}
          >
            <span style={{ fontSize: "1.75rem", fontWeight: "bold" }}>
              {counts.completedToday}
            </span>
            <span className="muted" style={{ fontSize: "0.9rem" }}>
              completed
            </span>
          </div>
          <button
            className="text-button"
            onClick={() => onNavigate("/admin/order-history")}
            style={{ marginTop: "0.75rem", padding: 0 }}
            type="button"
          >
            View history →
          </button>
        </div>
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
            justifyContent: "flex-start", gap: "1rem",
            paddingBottom: "0.75rem",
            borderBottom: "1px solid #e2e8f0",
            marginBottom: "0.75rem",
          }}
        >
          <span>
            Identification sheet:{" "}
            <strong>
              {settings?.identificationSheetEnabled ? "ON" : "OFF"}
            </strong>
          </span>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-start", gap: "1rem",
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
