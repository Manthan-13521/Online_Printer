import type { AdminPrinterDetails } from "@printgo/api-contract";

export interface TestPrintModalProps {
  printer: AdminPrinterDetails | null;
  testPrinterFeatures: {
    color: boolean;
    duplex: boolean;
    a4: boolean;
    a3: boolean;
  } | null;
  onClose: () => void;
  onRequestTestPrint: (
    printer: AdminPrinterDetails,
    type: "STANDARD" | "COLOR" | "DUPLEX" | "A3",
  ) => void | Promise<void>;
}

export function TestPrintModal({
  printer,
  testPrinterFeatures,
  onClose,
  onRequestTestPrint,
}: TestPrintModalProps) {
  if (!printer) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="test-print-menu-title"
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
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        style={{
          backgroundColor: "#ffffff",
          borderRadius: "12px",
          maxWidth: "460px",
          width: "100%",
          padding: "1.25rem 1.5rem",
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "1rem",
          }}
        >
          <h3
            id="test-print-menu-title"
            style={{ margin: 0, fontSize: "1.1rem" }}
          >
            Select Test Print for {printer.displayName}
          </h3>
          <button
            type="button"
            aria-label="Close"
            style={{
              background: "none",
              border: "none",
              fontSize: "1.25rem",
              cursor: "pointer",
              color: "#64748b",
              padding: "0.2rem 0.5rem",
              lineHeight: 1,
              borderRadius: "4px",
            }}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.6rem",
          }}
        >
          <button
            type="button"
            className="secondary-button"
            style={{ textAlign: "left", padding: "0.75rem 1rem" }}
            onClick={() => void onRequestTestPrint(printer, "STANDARD")}
          >
            <strong>📄 Standard Test (B&W Simplex A4)</strong>
            <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
              Basic alignment, header text, and printer diagnostic info.
            </div>
          </button>
          <button
            type="button"
            className="secondary-button"
            style={{
              textAlign: "left",
              padding: "0.75rem 1rem",
              opacity: testPrinterFeatures?.color ? 1 : 0.6,
              cursor: testPrinterFeatures?.color ? "pointer" : "not-allowed",
            }}
            disabled={!testPrinterFeatures?.color}
            onClick={() => {
              if (testPrinterFeatures?.color) {
                void onRequestTestPrint(printer, "COLOR");
              }
            }}
          >
            <strong>🎨 Color Calibration Test</strong>
            <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
              {testPrinterFeatures?.color
                ? "Prints CMYK/RGB calibration bars to verify ink/toner reproduction."
                : "Unsupported on this printer (Hardware is Black & White only)."}
            </div>
          </button>
          <button
            type="button"
            className="secondary-button"
            style={{
              textAlign: "left",
              padding: "0.75rem 1rem",
              opacity: testPrinterFeatures?.duplex ? 1 : 0.6,
              cursor: testPrinterFeatures?.duplex ? "pointer" : "not-allowed",
            }}
            disabled={!testPrinterFeatures?.duplex}
            onClick={() => {
              if (testPrinterFeatures?.duplex) {
                void onRequestTestPrint(printer, "DUPLEX");
              }
            }}
          >
            <strong>🔄 Duplex 2-Page Flip Test</strong>
            <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
              {testPrinterFeatures?.duplex
                ? "Prints 2 pages to verify automatic double-sided paper turnaround."
                : "Unsupported on this printer (Automatic duplex not supported)."}
            </div>
          </button>
          <button
            type="button"
            className="secondary-button"
            style={{
              textAlign: "left",
              padding: "0.75rem 1rem",
              opacity: testPrinterFeatures?.a3 ? 1 : 0.6,
              cursor: testPrinterFeatures?.a3 ? "pointer" : "not-allowed",
            }}
            disabled={!testPrinterFeatures?.a3}
            onClick={() => {
              if (testPrinterFeatures?.a3) {
                void onRequestTestPrint(printer, "A3");
              }
            }}
          >
            <strong>📐 A3 Large Format Test</strong>
            <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
              {testPrinterFeatures?.a3
                ? "Tests oversized paper tray feeding and border margins."
                : "Unsupported on this printer (Maximum paper size is A4)."}
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
