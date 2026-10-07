import { useEffect, useState } from "react";
import {
  adminApi,
  AdminApiError,
  friendlyAdminError,
  clearWaitingQueue,
} from "./api";
import { startVisiblePolling } from "../../polling";
import type { AdminPrintSystemStatusData } from "@printgo/api-contract";

export function SystemStatusPanel({
  onSessionExpired,
  pollIntervalMs = 20000,
}: {
  onSessionExpired: (message: string) => void;
  pollIntervalMs?: number;
}) {
  const [status, setStatus] = useState<AdminPrintSystemStatusData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRecovering, setIsRecovering] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearConfirmText, setClearConfirmText] = useState("");

  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  useEffect(() => {
    let active = true;
    let previous = "";
    const stop = startVisiblePolling(async () => {
      try {
        const response = await adminApi.getPrintSystemStatus();
        if (!active || !response.ok) return undefined;
        setStatus(response.data);
        setError(null);

        // Fast polling if printing or recovering
        if (
          response.data.recoverability === "RECOVERY_ALREADY_RUNNING" ||
          (response.data.currentOrder &&
            response.data.currentOrder.status === "PRINTING" &&
            !response.data.currentOrder.isStalled)
        ) {
          // We could change poll interval dynamically, but startVisiblePolling doesn't support that easily.
          // That's fine.
        }

        const snapshot = JSON.stringify(response.data);
        const changed = snapshot !== previous;
        previous = snapshot;
        return changed;
      } catch (caught) {
        if (!active) return undefined;
        if (caught instanceof AdminApiError && caught.status === 401) {
          onSessionExpired("Your session has expired. Please sign in again.");
        } else {
          // ignore transient errors
        }
      }
      return undefined;
    }, pollIntervalMs);
    return () => {
      active = false;
      stop();
    };
  }, [onSessionExpired, pollIntervalMs]);

  async function handleClearQueue() {
    setIsClearing(true);
    setRecoveryNotice(null);
    setError(null);
    try {
      const res = await clearWaitingQueue();
      setRecoveryNotice(res.message);
      setShowClearConfirm(false);
      setClearConfirmText("");
      const s = await adminApi.getPrintSystemStatus();
      if (s.ok) setStatus(s.data);
    } catch (caught) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
      } else {
        setError(friendlyAdminError(caught));
      }
    } finally {
      setIsClearing(false);
      setShowClearConfirm(false);
    }
  }

  async function handleRecover() {
    setIsRecovering(true);
    setRecoveryNotice(null);
    setError(null);
    try {
      const res = await adminApi.recoverPrintSystem();
      if (res.ok) {
        setRecoveryNotice(res.data.message);
        setShowConfirm(false);
        setConfirmText("");
        // Optimistically fetch status immediately
        const s = await adminApi.getPrintSystemStatus();
        if (s.ok) setStatus(s.data);
      }
    } catch (caught) {
      if (caught instanceof AdminApiError) {
        if (caught.status === 401) {
          onSessionExpired("Your session has expired. Please sign in again.");
          return;
        }
        setError(caught.message);
      } else {
        setError(friendlyAdminError(caught));
      }
    } finally {
      setIsRecovering(false);
      setShowConfirm(false);
    }
  }

  if (!status) {
    return (
      <div className="panel" style={{ minWidth: "300px", padding: "1rem" }}>
        <p className="muted" style={{ margin: 0 }}>
          Loading Print System...
        </p>
      </div>
    );
  }

  const agentOnline = status.agentStatus === "ONLINE";
  const printerReady = status.printerStatus === "READY";
  const recoverDisabled =
    !agentOnline ||
    !printerReady ||
    (status.recoverability === "READY") === false ||
    isRecovering;

  let noticeMsg = null;
  if (!agentOnline) {
    noticeMsg = "Start PrintGo Agent first.";
  } else if (status.printerStatus === "OFFLINE") {
    noticeMsg = "Turn on/reconnect the printer first.";
  } else if (status.printerStatus === "PAPER_JAM") {
    noticeMsg = "Clear the paper jam first.";
  } else if (status.printerStatus === "PAPER_OUT") {
    noticeMsg = "Load paper first.";
  } else if (!printerReady) {
    noticeMsg = `Fix printer issue: ${status.printerStatusMessage}`;
  } else if (status.currentOrder?.isStalled) {
    noticeMsg =
      "Printing appears stalled — no meaningful progress for 5 minutes.";
  }

  return (
    <div
      className="panel"
      style={{ minWidth: "300px", padding: "1rem", backgroundColor: "#f9fafb" }}
    >
      <h3 style={{ margin: "0 0 1rem 0", fontSize: "1.1rem" }}>Print System</h3>
      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "0.5rem",
          margin: "0 0 1rem 0",
          fontSize: "0.9rem",
        }}
      >
        <dt style={{ color: "#6b7280" }}>Agent</dt>
        <dd
          style={{
            margin: 0,
            fontWeight: 500,
            color: agentOnline ? "#166534" : "#b91c1c",
          }}
        >
          ● {status.agentStatus}
        </dd>

        <dt style={{ color: "#6b7280" }}>Printer</dt>
        <dd
          style={{
            margin: 0,
            fontWeight: 500,
            color: printerReady ? "#166534" : "#b91c1c",
          }}
        >
          ●{" "}
          {status.printerStatus === "READY"
            ? "Ready"
            : status.printerStatusMessage || status.printerStatus}
        </dd>

        <dt style={{ color: "#6b7280" }}>Current</dt>
        <dd style={{ margin: 0, fontWeight: 500 }}>
          {status.currentOrder ? (
            <span
              style={{
                color: status.currentOrder.isStalled ? "#b91c1c" : "inherit",
              }}
            >
              {status.currentOrder.publicJobCode} · {status.currentOrder.status}
            </span>
          ) : (
            <span style={{ color: "#6b7280" }}>None</span>
          )}
        </dd>

        <dt style={{ color: "#6b7280" }}>Waiting</dt>
        <dd style={{ margin: 0, fontWeight: 500 }}>{status.waitingCount}</dd>
      </dl>

      {noticeMsg && (
        <p
          style={{
            margin: "0 0 1rem 0",
            fontSize: "0.85rem",
            color: "#92400e",
            backgroundColor: "#fef3c7",
            padding: "0.5rem",
            borderRadius: "4px",
          }}
        >
          {noticeMsg}
        </p>
      )}

      {error && (
        <p
          style={{
            margin: "0 0 1rem 0",
            fontSize: "0.85rem",
            color: "#b91c1c",
            backgroundColor: "#fee2e2",
            padding: "0.5rem",
            borderRadius: "4px",
          }}
        >
          {error}
        </p>
      )}

      {recoveryNotice && (
        <p
          style={{
            margin: "0 0 1rem 0",
            fontSize: "0.85rem",
            color: "#166534",
            backgroundColor: "#dcfce7",
            padding: "0.5rem",
            borderRadius: "4px",
          }}
        >
          {recoveryNotice}
        </p>
      )}

      {!showConfirm && !showClearConfirm ? (
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button
            type="button"
            className="primary-button"
            style={{ flex: 1 }}
            disabled={recoverDisabled}
            onClick={() => setShowConfirm(true)}
          >
            {isRecovering ? "Recovering..." : "Recover Printing"}
          </button>
          <button
            type="button"
            className="secondary-button"
            style={{ flex: 1 }}
            disabled={status.waitingCount === 0 || isClearing}
            onClick={() => setShowClearConfirm(true)}
          >
            {isClearing ? "Clearing..." : "Clear Waiting Queue"}
          </button>
        </div>
      ) : showConfirm ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
            backgroundColor: "#fef2f2",
            padding: "0.5rem",
            borderRadius: "6px",
            border: "1px solid #fca5a5",
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: "0.85rem",
              color: "#991b1b",
              fontWeight: 600,
            }}
          >
            Type RECOVER to confirm:
          </p>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="RECOVER"
            style={{
              padding: "0.4rem",
              fontSize: "0.9rem",
              border: "1px solid #f87171",
              borderRadius: "4px",
            }}
            autoFocus
          />
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              type="button"
              className="primary-button"
              style={{ flex: 1, backgroundColor: "#dc2626" }}
              disabled={confirmText !== "RECOVER" || isRecovering}
              onClick={() => void handleRecover()}
            >
              Confirm
            </button>
            <button
              type="button"
              className="secondary-button"
              style={{ flex: 1 }}
              onClick={() => setShowConfirm(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : showClearConfirm ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
            backgroundColor: "#fff7ed",
            padding: "0.5rem",
            borderRadius: "6px",
            border: "1px solid #fdba74",
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: "0.85rem",
              color: "#9a3412",
              fontWeight: 600,
            }}
          >
            Type CLEAR QUEUE to confirm:
          </p>
          <input
            type="text"
            value={clearConfirmText}
            onChange={(e) => setClearConfirmText(e.target.value)}
            placeholder="CLEAR QUEUE"
            style={{
              padding: "0.4rem",
              fontSize: "0.9rem",
              border: "1px solid #fb923c",
              borderRadius: "4px",
            }}
            autoFocus
          />
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              type="button"
              className="primary-button"
              style={{ flex: 1, backgroundColor: "#ea580c" }}
              disabled={clearConfirmText !== "CLEAR QUEUE" || isClearing}
              onClick={() => void handleClearQueue()}
            >
              Confirm
            </button>
            <button
              type="button"
              className="secondary-button"
              style={{ flex: 1 }}
              onClick={() => setShowClearConfirm(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
