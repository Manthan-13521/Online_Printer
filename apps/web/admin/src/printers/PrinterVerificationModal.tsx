import type { AdminPrinterDetails } from "@printgo/api-contract";
import type { PrinterCapabilityFeatures } from "@printgo/domain";
import type React from "react";

export interface PrinterVerificationModalProps {
  printer: AdminPrinterDetails | null;
  verifyingFeatures: PrinterCapabilityFeatures;
  setVerifyingFeatures: React.Dispatch<
    React.SetStateAction<PrinterCapabilityFeatures>
  >;
  verifyingEnabled: PrinterCapabilityFeatures;
  setVerifyingEnabled: React.Dispatch<
    React.SetStateAction<PrinterCapabilityFeatures>
  >;
  verificationNotes: string;
  setVerificationNotes: (notes: string) => void;
  savingVerification: boolean;
  onClose: () => void;
  onSaveVerification: () => void | Promise<void>;
}

export function PrinterVerificationModal({
  printer,
  verifyingFeatures,
  setVerifyingFeatures,
  verifyingEnabled,
  setVerifyingEnabled,
  verificationNotes,
  setVerificationNotes,
  savingVerification,
  onClose,
  onSaveVerification,
}: PrinterVerificationModalProps) {
  if (!printer) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="verify-caps-title"
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 110,
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
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1)",
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
              id="verify-caps-title"
              style={{ margin: 0, fontSize: "1.2rem" }}
            >
              Certify Hardware Capabilities
            </h2>
            <p
              className="muted"
              style={{ margin: "0.25rem 0 0 0", fontSize: "0.85rem" }}
            >
              {printer.displayName} ({printer.windowsPrinterName})
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
            gap: "1.2rem",
          }}
        >
          <div
            style={{
              padding: "0.75rem 1rem",
              backgroundColor: "#f0fdf4",
              border: "1px solid #bbf7d0",
              borderRadius: "8px",
              fontSize: "0.85rem",
              color: "#166534",
            }}
          >
            <strong>Operator Instructions:</strong> Inspect the test sheet
            printed by this physical machine. Only check the boxes below for
            features that printed successfully without distortion or jamming.
          </div>

          {/* Section 1: Physical Verification */}
          <div>
            <h3
              style={{
                fontSize: "0.95rem",
                margin: "0 0 0.5rem 0",
                color: "#1e293b",
              }}
            >
              1. Confirmed Physical Hardware Output
            </h3>
            <div style={{ display: "grid", gap: "0.5rem" }}>
              {[
                {
                  key: "bw" as const,
                  label: "Black & White Printing",
                  desc: "Text and graphics printed crisp black & monochrome.",
                },
                {
                  key: "color" as const,
                  label: "Full Color Printing",
                  desc: "RGB/CMYK colored bars printed in proper full color.",
                },
                {
                  key: "duplex" as const,
                  label: "Automatic Double-Sided (Duplex)",
                  desc: "Printer mechanically flipped sheet and printed both sides.",
                },
                {
                  key: "a4" as const,
                  label: "A4 Paper Size Support",
                  desc: "Fed and aligned correctly from A4 paper tray.",
                },
                {
                  key: "a3" as const,
                  label: "A3 Paper Size Support",
                  desc: "Fed and aligned correctly on A3 paper tray/feed.",
                },
              ].map((item) => (
                <label
                  key={item.key}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: "0.6rem",
                    padding: "0.5rem 0.75rem",
                    border: "1px solid #e2e8f0",
                    borderRadius: "6px",
                    backgroundColor: verifyingFeatures[item.key]
                      ? "#f8fafc"
                      : "#ffffff",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={verifyingFeatures[item.key]}
                    style={{ marginTop: "0.2rem" }}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setVerifyingFeatures((prev) => ({
                        ...prev,
                        [item.key]: checked,
                      }));
                      if (!checked) {
                        setVerifyingEnabled((prev) => ({
                          ...prev,
                          [item.key]: false,
                        }));
                      }
                    }}
                  />
                  <div>
                    <strong>{item.label}</strong>
                    <div
                      style={{
                        fontSize: "0.75rem",
                        color: "#64748b",
                      }}
                    >
                      {item.desc}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Section 2: Enabled Services for Customers */}
          <div>
            <h3
              style={{
                fontSize: "0.95rem",
                margin: "0 0 0.5rem 0",
                color: "#1e293b",
              }}
            >
              2. Enable for Customer Online Orders
            </h3>
            <p
              className="muted"
              style={{
                fontSize: "0.8rem",
                margin: "0 0 0.5rem 0",
              }}
            >
              Uncheck any service that you do not want customers to order on
              this printer right now:
            </p>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "0.4rem",
              }}
            >
              {[
                { key: "bw" as const, label: "Allow B&W" },
                { key: "color" as const, label: "Allow Color" },
                { key: "duplex" as const, label: "Allow 2-Sided" },
                { key: "a4" as const, label: "Allow A4" },
                { key: "a3" as const, label: "Allow A3" },
              ].map((svc) => (
                <label
                  key={svc.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.4rem",
                    fontSize: "0.825rem",
                    opacity: verifyingFeatures[svc.key] ? 1 : 0.4,
                    cursor: verifyingFeatures[svc.key]
                      ? "pointer"
                      : "not-allowed",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={verifyingEnabled[svc.key]}
                    disabled={!verifyingFeatures[svc.key]}
                    onChange={(e) =>
                      setVerifyingEnabled((prev) => ({
                        ...prev,
                        [svc.key]: e.target.checked,
                      }))
                    }
                  />
                  <span>{svc.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Section 3: Notes */}
          <div>
            <label
              htmlFor="verification-notes"
              style={{
                display: "block",
                marginBottom: "0.3rem",
                fontSize: "0.85rem",
                fontWeight: 600,
              }}
            >
              Operator / Technician Notes (Optional):
            </label>
            <input
              id="verification-notes"
              type="text"
              placeholder="e.g. Tested on Brother HL-L2321D, toner 85%, duplex tested."
              value={verificationNotes}
              maxLength={500}
              onChange={(e) => setVerificationNotes(e.target.value)}
            />
          </div>
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
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={savingVerification}
            onClick={() => void onSaveVerification()}
          >
            {savingVerification ? "Saving…" : "Certify & Save Capabilities"}
          </button>
        </div>
      </div>
    </div>
  );
}
