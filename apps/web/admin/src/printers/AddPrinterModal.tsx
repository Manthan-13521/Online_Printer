import type { AdminPrinterDetails } from "@printgo/api-contract";
import { formatSimpleCapabilities } from "./printer-helpers";

export interface AddPrinterModalProps {
  isOpen: boolean;
  unconfiguredPrinters: AdminPrinterDetails[];
  togglingPrinterId: string | null;
  refreshing: boolean;
  onClose: () => void;
  onTogglePrinter: (printer: AdminPrinterDetails) => void | Promise<void>;
  onScanPrinters: () => void | Promise<void>;
}

export function AddPrinterModal({
  isOpen,
  unconfiguredPrinters,
  togglingPrinterId,
  refreshing,
  onClose,
  onTogglePrinter,
  onScanPrinters,
}: AddPrinterModalProps) {
  if (!isOpen) return null;

  return (
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
              Automatic discovery for all your shop USB and network printers.
            </p>
          </div>
          <button
            type="button"
            className="text-button"
            onClick={onClose}
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
                      onClick={() => void onTogglePrinter(up)}
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
              <li>Turn on the printer power and verify it has paper.</li>
              <li>
                Click <strong>Scan for Printers</strong> below. PrintGo Agent
                will discover it in Windows and register it automatically!
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
              onClick={() => void onScanPrinters()}
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
          <button type="button" className="secondary-button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
