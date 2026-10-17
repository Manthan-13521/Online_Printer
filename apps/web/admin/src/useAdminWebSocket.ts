import { useEffect, useRef } from "react";
import { getAdminToken } from "./api";

/**
 * Custom React hook for connecting to the Admin WebSocket notification room.
 * When the server broadcasts WAKE_UP (order updates, payment confirmations,
 * printer changes, test prints), onWakeUp is called immediately (0ms latency).
 *
 * Handles automatic reconnection with bounded backoff and cleanup.
 */
export function useAdminWebSocket(onWakeUp: () => void): void {
  const onWakeUpRef = useRef(onWakeUp);
  onWakeUpRef.current = onWakeUp;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | undefined;
    let isDisposed = false;

    function connectWs() {
      if (isDisposed) return;
      try {
        const token = getAdminToken();
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl = `${protocol}//${window.location.host}/api/admin/ws${
          token ? `?token=${encodeURIComponent(token)}` : ""
        }`;
        ws = new WebSocket(wsUrl);

        ws.onmessage = (event: MessageEvent<string>) => {
          try {
            const rawData: unknown = event.data;
            if (typeof rawData === "string") {
              const data: unknown = JSON.parse(rawData);
              if (
                typeof data === "object" &&
                data !== null &&
                "type" in data &&
                (data.type === "WAKE_UP" || data.type === "ADMIN_ORDER_UPDATE")
              ) {
                onWakeUpRef.current();
              }
            }
          } catch {
            // Ignored
          }
        };

        ws.onerror = () => {
          // Handled by onclose
        };

        ws.onclose = () => {
          if (!isDisposed) {
            reconnectTimeout = setTimeout(connectWs, 15_000);
          }
        };
      } catch {
        // Fallback active
      }
    }

    connectWs();

    return () => {
      isDisposed = true;
      if (ws) {
        try {
          ws.close();
        } catch {
          // Ignored
        }
      }
      clearTimeout(reconnectTimeout);
    };
  }, []);
}
