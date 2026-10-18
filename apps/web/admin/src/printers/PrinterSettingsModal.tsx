import type { AdminPrinterDetails } from "@printgo/api-contract";
import type { PrinterCapabilityFeatures } from "@printgo/domain";
import type React from "react";
import { useEffect, useState } from "react";
import { formatSimpleCapabilities } from "./printer-helpers";

export interface PrinterSettingsModalProps {
  printer: AdminPrinterDetails | null;
  defaultProductionPrinterId: string | null;
  displayedPrinters: AdminPrinterDetails[];
  formDisplayName: string;
  setFormDisplayName: (name: string) => void;
  formPriority: number;
  setFormPriority: (priority: number) => void;
  formEnabled: boolean;
  setFormEnabled: (enabled: boolean) => void;
  formFallbackId: string;
  setFormFallbackId: (id: string) => void;
  formAutoFallback: boolean;
  setFormAutoFallback: (auto: boolean) => void;
  formEnabledServices: PrinterCapabilityFeatures | null;
  setFormEnabledServices: React.Dispatch<
    React.SetStateAction<PrinterCapabilityFeatures | null>
  >;
  formPhysicalDeviceId: string;
  setFormPhysicalDeviceId: (id: string) => void;
  settingDefaultId: string | null;
  savingSettings: boolean;
  onClose: () => void;
  onSetDefault: (printer: AdminPrinterDetails) => void | Promise<void>;
  onSaveSettings: () => void | Promise<void>;
}

export function PrinterSettingsModal({
  printer,
  defaultProductionPrinterId,
  displayedPrinters,
  formDisplayName,
  setFormDisplayName,
  formPriority,
  setFormPriority,
  formEnabled,
  setFormEnabled,
  formFallbackId,
  setFormFallbackId,
  formAutoFallback,
  setFormAutoFallback,
  formEnabledServices,
  setFormEnabledServices,
  formPhysicalDeviceId,
  setFormPhysicalDeviceId,
  settingDefaultId,
  savingSettings,
  onClose,
  onSetDefault,
  onSaveSettings,
}: PrinterSettingsModalProps) {
  const [priorityDraft, setPriorityDraft] = useState(String(formPriority));

  useEffect(() => {
    setPriorityDraft(String(formPriority));
  }, [formPriority, printer?.id]);

  if (!printer) return null;

  return (
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
              This name is displayed throughout the shop admin and tracking.
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
                {printer.id === defaultProductionPrinterId ||
                printer.isProductionDefault
                  ? "This printer is currently your primary default."
                  : "Set this printer as the default for new orders."}
              </p>
            </div>
            {!(
              printer.id === defaultProductionPrinterId ||
              printer.isProductionDefault
            ) && (
              <button
                type="button"
                className="secondary-button compact"
                disabled={settingDefaultId === printer.id}
                onClick={() => {
                  void (async () => {
                    await onSetDefault(printer);
                    onClose();
                  })();
                }}
              >
                {settingDefaultId === printer.id ? "Setting…" : "Set Default"}
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
              value={priorityDraft}
              onChange={(e) => {
                const text = e.target.value;
                setPriorityDraft(text);
                if (text.trim() === "") return;
                const p = parseInt(text, 10);
                if (!isNaN(p)) {
                  setFormPriority(Math.min(100, Math.max(0, p)));
                }
              }}
              onBlur={() => {
                const p = parseInt(priorityDraft, 10);
                if (isNaN(p) || p < 0) {
                  setPriorityDraft("0");
                  setFormPriority(0);
                } else {
                  const clamped = Math.min(100, Math.max(0, p));
                  setPriorityDraft(String(clamped));
                  setFormPriority(clamped);
                }
              }}
            />
            <p
              className="muted"
              style={{ fontSize: "0.75rem", margin: "0.25rem 0 0 0" }}
            >
              Higher priority printers are selected first when multiple printers
              match order specs.
            </p>
          </div>

          {/* Physical Hardware ID (Mutual Exclusion Group) */}
          <div>
            <label
              htmlFor="printer-physical-device"
              style={{ display: "block", marginBottom: "0.35rem" }}
            >
              Physical Hardware Connection:
            </label>
            <select
              id="printer-physical-device"
              value={formPhysicalDeviceId}
              onChange={(e) => setFormPhysicalDeviceId(e.target.value)}
            >
              <option value="">Primary Machine (Shared Default)</option>
              <option value="machine-2">Independent Machine 2</option>
              <option value="machine-3">Independent Machine 3</option>
              <option value="machine-4">Independent Machine 4</option>
              <option value="machine-5">Independent Machine 5</option>
            </select>
            <p
              className="muted"
              style={{ fontSize: "0.75rem", margin: "0.25rem 0 0 0" }}
            >
              If multiple print queues connect to the same physical hardware,
              put them in the same group so they do not jam by printing at the
              same time.
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
                .filter((p) => p.id !== printer.id && p.enabled)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName} ({formatSimpleCapabilities(p.capabilities)})
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
                  onChange={(e) => setFormAutoFallback(e.target.checked)}
                />
                <span>
                  Auto-route new unprinted orders to fallback printer when this
                  printer is paused or offline
                </span>
              </label>
            ) : null}
          </div>

          {/* Enabled Customer Services */}
          <div
            style={{
              borderTop: "1px solid #e2e8f0",
              paddingTop: "0.75rem",
            }}
          >
            <label
              style={{
                display: "block",
                marginBottom: "0.35rem",
                fontWeight: 600,
              }}
            >
              Enabled Services for Online Orders:
            </label>
            <p
              className="muted"
              style={{ fontSize: "0.75rem", margin: "0 0 0.5rem 0" }}
            >
              Toggle which services customers can select for this printer. Only
              verified capabilities can be enabled.
            </p>
            {formEnabledServices && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "0.5rem",
                }}
              >
                {[
                  {
                    key: "bw" as const,
                    label: "B&W Orders",
                    verified: printer.verifiedCapabilities?.verified.bw ?? true,
                  },
                  {
                    key: "color" as const,
                    label: "Color Orders",
                    verified:
                      printer.verifiedCapabilities?.verified.color ?? false,
                  },
                  {
                    key: "duplex" as const,
                    label: "Duplex Orders",
                    verified:
                      printer.verifiedCapabilities?.verified.duplex ?? false,
                  },
                  {
                    key: "a4" as const,
                    label: "A4 Paper Orders",
                    verified: printer.verifiedCapabilities?.verified.a4 ?? true,
                  },
                  {
                    key: "a3" as const,
                    label: "A3 Paper Orders",
                    verified:
                      printer.verifiedCapabilities?.verified.a3 ?? false,
                  },
                ].map((item) => (
                  <label
                    key={item.key}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.4rem",
                      fontSize: "0.825rem",
                      opacity: item.verified ? 1 : 0.45,
                      cursor: item.verified ? "pointer" : "not-allowed",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(formEnabledServices[item.key])}
                      disabled={!item.verified}
                      onChange={(e) =>
                        setFormEnabledServices((prev) =>
                          prev
                            ? {
                                ...prev,
                                [item.key]: e.target.checked,
                              }
                            : null,
                        )
                      }
                    />
                    <span>
                      {item.label} {!item.verified && "(Unverified)"}
                    </span>
                  </label>
                ))}
              </div>
            )}
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
                Windows Queue: <code>{printer.windowsPrinterName}</code>
              </div>
              <div>
                Port: <code>{printer.portName || "Local/USB"}</code>
              </div>
              <div>
                Driver: <code>{printer.driverName || "Standard Driver"}</code>
              </div>
              <div>
                Hardware ID: <code>{printer.id}</code>
              </div>
              <div>
                Supported Sizes:{" "}
                {printer.capabilities?.paperSizes?.join(", ") || "A4"}
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
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={savingSettings}
            onClick={() => void onSaveSettings()}
          >
            {savingSettings ? "Saving…" : "Save Settings"}
          </button>
        </div>
      </div>
    </div>
  );
}
