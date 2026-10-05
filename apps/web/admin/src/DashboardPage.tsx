import { applyShopBranding } from "../../branding";
import { startVisiblePolling } from "../../polling";
import type {
  AdminAgentDetails,
  AdminPrinterDetails,
  ShopSettings,
} from "@printgo/api-contract";
import { useEffect, useState } from "react";
import {
  adminApi,
  AdminApiError,
  friendlyAdminError,
  brandingUrl,
} from "./api";

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
      {settings?.logoUrl ? (
        <img
          src={brandingUrl(settings.logoUrl)}
          alt="Shop logo"
          style={{ maxWidth: 120, maxHeight: 72, objectFit: "contain" }}
        />
      ) : null}
      <header className="page-header" style={{ marginBottom: "1.5rem" }}>
        <div>
          <p
            className="eyebrow"
            style={{
              margin: 0,
              textTransform: "uppercase",
              fontSize: "0.8rem",
              letterSpacing: "0.05em",
              color: "var(--accent, #2563eb)",
              fontWeight: "bold",
            }}
          >
            Workspace ready
          </p>
          <h1 style={{ margin: "0.25rem 0 0 0", fontSize: "1.75rem" }}>
            {settings?.appName ?? settings?.shopName ?? "PrintGo"}
          </h1>
          <p className="muted" style={{ margin: "0.25rem 0 0 0" }}>
            {settings?.shopName
              ? `${settings.shopName} — Real-time shop operational overview.`
              : "Real-time status overview of your physical print shop."}
          </p>
        </div>
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
      </section>

      <section
        className="panel"
        style={{ padding: "1.25rem", marginBottom: "1.5rem" }}
      >
        <p>
          Today’s completed orders: <strong>{counts.completedToday}</strong>
        </p>
        <p>
          Identification sheet:{" "}
          <strong>{settings?.identificationSheetEnabled ? "ON" : "OFF"}</strong>
        </p>
      </section>
      {/* Customer Readiness Banner */}
      {!canAcceptOrders ? (
        <section
          className="panel"
          style={{
            marginBottom: "1.5rem",
            backgroundColor: "#fffbeb",
            border: "1px solid #fde68a",
            padding: "1.25rem",
          }}
        >
          <h2
            style={{
              margin: "0 0 0.5rem 0",
              color: "#92400e",
              fontSize: "1.15rem",
            }}
          >
            ⚠️ Online Printing Cannot Accept Payments Yet
          </h2>
          <p style={{ margin: 0, color: "#78350f" }}>
            Before customers can pay and submit jobs, ensure:
          </p>
          <ul style={{ margin: "0.5rem 0 0 1.25rem", color: "#78350f" }}>
            {!onlinePrinting ? (
              <li>Online printing is enabled in Shop Settings.</li>
            ) : null}
            {!agentOnline ? (
              <li>The PrintGo Windows Agent is running on the shop PC.</li>
            ) : null}
            {!printerReady ? (
              <li>
                A physical production printer is selected and reported Online.
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

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
            <span style={{ fontSize: "1.25rem" }}>✓</span>
            <div>
              <strong>Shop Profile & Contact</strong> —{" "}
              {settings?.shopName ?? "Set up"}
            </div>
            <button
              className="text-button"
              onClick={() => onNavigate("/admin/shop-settings")}
              style={{ marginLeft: "auto" }}
              type="button"
            >
              Edit
            </button>
          </div>

          <div
            style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}
          >
            <span style={{ fontSize: "1.25rem" }}>✓</span>
            <div>
              <strong>Print Rates & Surcharges</strong> — Configured server-side
            </div>
            <button
              className="text-button"
              onClick={() => onNavigate("/admin/pricing")}
              style={{ marginLeft: "auto" }}
              type="button"
            >
              Configure
            </button>
          </div>

          <div
            style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}
          >
            <span style={{ fontSize: "1.25rem" }}>
              {agentOnline ? "✓" : "○"}
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
            <span style={{ fontSize: "1.25rem" }}>
              {printerReady ? "✓" : "○"}
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
            <span style={{ fontSize: "1.25rem" }}>
              {onlinePrinting ? "✓" : "○"}
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
    </div>
  );
}
