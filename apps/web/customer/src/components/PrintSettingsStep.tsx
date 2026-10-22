import type { CustomerConfigData } from "@printgo/api-contract";
import { MAX_PRINT_COPIES, MIN_PRINT_COPIES } from "@printgo/domain";
import { useEffect, useState } from "react";
import type { LocalOrderFile } from "./customer-types";

export interface PrintSettingsStepProps {
  files: LocalOrderFile[];
  selectedFile: LocalOrderFile | null;
  selectedFileIndex: number;
  onSelectFileIndex: (index: number) => void;
  printOptions: NonNullable<CustomerConfigData["availablePrintOptions"]>;
  optionAvailable: boolean;
  onPatchSelected: (update: Partial<LocalOrderFile>) => void;
  onApplySettingsToAll: () => void;
  isPickup?: boolean | undefined;
  onTogglePickup?: ((enabled: boolean) => void) | undefined;
  pickupSchedule?: CustomerConfigData["pickupSchedule"] | undefined;
}

function formatOpeningTime12h(
  openingTime?: string | null,
  formattedStr?: string | null,
): string {
  if (openingTime) {
    const parts = openingTime.split(":");
    const hStr = parts[0];
    const mStr = parts[1];
    if (hStr !== undefined) {
      const h = parseInt(hStr, 10);
      const m = parseInt(mStr ?? "0", 10);
      if (!isNaN(h)) {
        const ampm = h >= 12 ? "PM" : "AM";
        const h12 = h % 12 || 12;
        const mFormatted = m > 0 ? `:${String(m).padStart(2, "0")}` : ":00";
        return `${h12}${mFormatted} ${ampm}`;
      }
    }
  }
  if (formattedStr) {
    const match = formattedStr.match(/\b\d{1,2}(?::\d{2})?\s*(?:AM|PM)\b/i);
    if (match) return match[0];
  }
  return "opening";
}

export function PrintSettingsStep({
  files,
  selectedFile,
  selectedFileIndex,
  onSelectFileIndex,
  printOptions,
  optionAvailable,
  onPatchSelected,
  onApplySettingsToAll,
  isPickup,
  onTogglePickup,
  pickupSchedule,
}: PrintSettingsStepProps) {
  const [copiesDraft, setCopiesDraft] = useState(
    selectedFile ? String(selectedFile.copies) : "1",
  );

  useEffect(() => {
    if (selectedFile) {
      setCopiesDraft(String(selectedFile.copies));
    }
  }, [selectedFile?.clientId, selectedFile?.copies]);

  return (
    <section className="step print-settings-step">
      <div className="step-header">
        <span className="step-number">3</span>
        <h2>Print Settings</h2>
        <p className="step-desc">
          Choose how you want your files to be printed.
        </p>
      </div>

      {selectedFile ? (
        <>
          <div className="settings-file-selector">
            <label htmlFor="settings-file">File to configure</label>
            <div className="select-wrapper">
              <span className="icon">📄</span>
              <select
                id="settings-file"
                value={selectedFileIndex}
                onChange={(event) =>
                  onSelectFileIndex(Number(event.target.value))
                }
              >
                {files.map((item, index) => (
                  <option key={item.clientId} value={index}>
                    File {index + 1} — {item.name} ({item.pageCount} pages)
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="print-settings-grid">
            {/* 1. Pages: All Pages | Custom Range */}
            <div className="print-setting-col">
              <label className="setting-label">Pages</label>
              <div className="visual-options horizontal">
                <label
                  className={`visual-option-card ${selectedFile.pageMode === "ALL" ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="pageMode"
                    value="ALL"
                    checked={selectedFile.pageMode === "ALL"}
                    onChange={() => onPatchSelected({ pageMode: "ALL" })}
                  />
                  <span
                    className="card-icon pages-icon"
                    aria-hidden="true"
                  ></span>
                  <span className="label">All pages</span>
                  <span className="radio-circle"></span>
                </label>
                <label
                  className={`visual-option-card ${selectedFile.pageMode === "CUSTOM" ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="pageMode"
                    value="CUSTOM"
                    checked={selectedFile.pageMode === "CUSTOM"}
                    onChange={() => onPatchSelected({ pageMode: "CUSTOM" })}
                  />
                  <span
                    className="card-icon custom-icon"
                    aria-hidden="true"
                  ></span>
                  <span className="label">Custom range</span>
                  <span className="radio-circle"></span>
                </label>
              </div>
              {selectedFile.pageMode === "CUSTOM" && (
                <input
                  aria-label="Custom pages"
                  placeholder="e.g. 1, 3, 5-10"
                  value={selectedFile.customPages}
                  onChange={(event) =>
                    onPatchSelected({ customPages: event.target.value })
                  }
                  className="custom-pages-input"
                />
              )}
            </div>

            {/* 2. Paper Size: A4 | A3 */}
            <div className="print-setting-col">
              <label className="setting-label">Paper size</label>
              <div className="visual-options horizontal">
                <label
                  className={`visual-option-card ${selectedFile.paperSize === "A4" ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="paperSize"
                    value="A4"
                    checked={selectedFile.paperSize === "A4"}
                    onChange={() => onPatchSelected({ paperSize: "A4" })}
                  />
                  <span
                    className="card-icon paper-badge-icon a4"
                    aria-hidden="true"
                  ></span>
                  <span className="label">A4</span>
                  <span className="radio-circle"></span>
                </label>
                <label
                  className={`visual-option-card ${selectedFile.paperSize === "A3" ? "selected" : ""} ${!printOptions.some((o) => o.paperSize === "A3") ? "disabled" : ""}`}
                >
                  <input
                    type="radio"
                    name="paperSize"
                    value="A3"
                    checked={selectedFile.paperSize === "A3"}
                    disabled={!printOptions.some((o) => o.paperSize === "A3")}
                    onChange={() => onPatchSelected({ paperSize: "A3" })}
                  />
                  <span
                    className="card-icon paper-badge-icon a3"
                    aria-hidden="true"
                  ></span>
                  <span className="label">
                    A3
                    {!printOptions.some((o) => o.paperSize === "A3") && (
                      <span className="option-help-text">
                        A3 paper unavailable
                      </span>
                    )}
                  </span>
                  <span className="radio-circle"></span>
                </label>
              </div>
            </div>

            {/* 3. Colour: Black & White | Colour */}
            <div className="print-setting-col">
              <label className="setting-label">Colour</label>
              <div className="visual-options horizontal">
                <label
                  className={`visual-option-card ${selectedFile.colorMode === "BW" ? "selected" : ""} ${!printOptions.some((o) => o.paperSize === selectedFile.paperSize && o.colorMode === "BW") ? "disabled" : ""}`}
                >
                  <input
                    type="radio"
                    name="colorMode"
                    value="BW"
                    checked={selectedFile.colorMode === "BW"}
                    disabled={
                      !printOptions.some(
                        (o) =>
                          o.paperSize === selectedFile.paperSize &&
                          o.colorMode === "BW",
                      )
                    }
                    onChange={() => onPatchSelected({ colorMode: "BW" })}
                  />
                  <span className="card-icon bw-icon"></span>
                  <span className="label">Black & white</span>
                  <span className="radio-circle"></span>
                </label>
                <label
                  className={`visual-option-card ${selectedFile.colorMode === "COLOR" ? "selected" : ""} ${!printOptions.some((o) => o.paperSize === selectedFile.paperSize && o.colorMode === "COLOR") ? "disabled" : ""}`}
                >
                  <input
                    type="radio"
                    name="colorMode"
                    value="COLOR"
                    checked={selectedFile.colorMode === "COLOR"}
                    disabled={
                      !printOptions.some(
                        (o) =>
                          o.paperSize === selectedFile.paperSize &&
                          o.colorMode === "COLOR",
                      )
                    }
                    onChange={() => onPatchSelected({ colorMode: "COLOR" })}
                  />
                  <span className="card-icon color-icon"></span>
                  <span className="label">
                    Colour
                    {!printOptions.some(
                      (o) =>
                        o.paperSize === selectedFile.paperSize &&
                        o.colorMode === "COLOR",
                    ) && (
                      <span className="option-help-text">
                        No colour printer available
                      </span>
                    )}
                  </span>
                  <span className="radio-circle"></span>
                </label>
              </div>
            </div>

            {/* 4. Sides: Single-sided | Double-sided */}
            <div className="print-setting-col">
              <label className="setting-label">Sides</label>
              <div className="visual-options horizontal">
                <label
                  className={`visual-option-card ${selectedFile.sides === "SINGLE" ? "selected" : ""} ${!printOptions.some((o) => o.paperSize === selectedFile.paperSize && o.colorMode === selectedFile.colorMode && o.sides === "SINGLE") ? "disabled" : ""}`}
                >
                  <input
                    type="radio"
                    name="sides"
                    value="SINGLE"
                    checked={selectedFile.sides === "SINGLE"}
                    disabled={
                      !printOptions.some(
                        (o) =>
                          o.paperSize === selectedFile.paperSize &&
                          o.colorMode === selectedFile.colorMode &&
                          o.sides === "SINGLE",
                      )
                    }
                    onChange={() => onPatchSelected({ sides: "SINGLE" })}
                  />
                  <span
                    className="card-icon single-side-icon"
                    aria-hidden="true"
                  ></span>
                  <span className="label">Single-sided</span>
                  <span className="radio-circle"></span>
                </label>
                <label
                  className={`visual-option-card ${selectedFile.sides === "DOUBLE" ? "selected" : ""} ${!printOptions.some((o) => o.paperSize === selectedFile.paperSize && o.colorMode === selectedFile.colorMode && o.sides === "DOUBLE") ? "disabled" : ""}`}
                >
                  <input
                    type="radio"
                    name="sides"
                    value="DOUBLE"
                    checked={selectedFile.sides === "DOUBLE"}
                    disabled={
                      !printOptions.some(
                        (o) =>
                          o.paperSize === selectedFile.paperSize &&
                          o.colorMode === selectedFile.colorMode &&
                          o.sides === "DOUBLE",
                      )
                    }
                    onChange={() => onPatchSelected({ sides: "DOUBLE" })}
                  />
                  <span
                    className="card-icon double-side-icon"
                    aria-hidden="true"
                  ></span>
                  <span className="label">
                    Double-sided
                    {!printOptions.some(
                      (o) =>
                        o.paperSize === selectedFile.paperSize &&
                        o.colorMode === selectedFile.colorMode &&
                        o.sides === "DOUBLE",
                    ) && (
                      <span className="option-help-text">
                        Duplex printing unavailable on current printers
                      </span>
                    )}
                  </span>
                  <span className="radio-circle"></span>
                </label>
              </div>
            </div>

            {/* 5. Copies: Clear, compact stepper */}
            <div className="print-setting-col">
              <div className="copies-setting-row">
                <label
                  htmlFor="copies-input"
                  className="setting-label"
                  style={{ margin: 0 }}
                >
                  Copies
                </label>
                <div className="number-stepper">
                  <button
                    type="button"
                    aria-label="-"
                    onClick={() =>
                      onPatchSelected({
                        copies: Math.max(
                          MIN_PRINT_COPIES,
                          selectedFile.copies - 1,
                        ),
                      })
                    }
                  >
                    -
                  </button>
                  <input
                    id="copies-input"
                    aria-label="Copies"
                    type="number"
                    min={MIN_PRINT_COPIES}
                    max={MAX_PRINT_COPIES}
                    value={copiesDraft}
                    onChange={(event) => {
                      const text = event.target.value;
                      setCopiesDraft(text);
                      if (text.trim() === "") return;
                      const c = parseInt(text, 10);
                      if (!isNaN(c) && c >= 1) {
                        onPatchSelected({
                          copies: Math.min(MAX_PRINT_COPIES, c),
                        });
                      }
                    }}
                    onBlur={() => {
                      const c = parseInt(copiesDraft, 10);
                      if (isNaN(c) || c < MIN_PRINT_COPIES) {
                        setCopiesDraft(String(MIN_PRINT_COPIES));
                        onPatchSelected({ copies: MIN_PRINT_COPIES });
                      } else {
                        const clamped = Math.min(MAX_PRINT_COPIES, c);
                        setCopiesDraft(String(clamped));
                        onPatchSelected({ copies: clamped });
                      }
                    }}
                  />
                  <button
                    type="button"
                    aria-label="+"
                    onClick={() =>
                      onPatchSelected({
                        copies: Math.min(
                          MAX_PRINT_COPIES,
                          selectedFile.copies + 1,
                        ),
                      })
                    }
                  >
                    +
                  </button>
                </div>
              </div>
            </div>
          </div>

          {!optionAvailable && (
            <p className="error">
              {selectedFile?.sides === "DOUBLE" &&
              !printOptions.some(
                (o) =>
                  o.paperSize === selectedFile.paperSize &&
                  o.colorMode === selectedFile.colorMode &&
                  o.sides === "DOUBLE",
              )
                ? "Double-sided printing is not supported for this paper and color option. Please switch to Single-sided."
                : "That print combination is not currently available."}
            </p>
          )}

          {pickupSchedule?.enabled && (
            <div
              className="pickup-schedule-card"
              style={{
                margin: "1.25rem 0 1rem",
                padding: "1rem",
                background: "#f0f9ff",
                border: "1.5px solid #bae6fd",
                borderRadius: "10px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "1rem",
              }}
            >
              <div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.4rem",
                    fontWeight: 700,
                    color: "#0369a1",
                    fontSize: "0.95rem",
                  }}
                >
                  <span>🌅</span> Tomorrow Pickup Order
                </div>
                <div
                  style={{
                    fontSize: "0.9rem",
                    color: "#0c4a6e",
                    marginTop: "0.25rem",
                    fontWeight: 600,
                  }}
                >
                  Pickup at:{" "}
                  {pickupSchedule.nextPickupFormatted
                    ? pickupSchedule.nextPickupFormatted.replace(
                        ", from ",
                        ", ",
                      )
                    : (pickupSchedule.nextPickupTime ?? "")}
                </div>
                <p
                  style={{
                    margin: "0.2rem 0 0",
                    fontSize: "0.8rem",
                    color: "#64748b",
                  }}
                >
                  {pickupSchedule.isShopOpen
                    ? `Enable if you want to take order tomorrow after ${formatOpeningTime12h(
                        pickupSchedule.openingTime,
                        pickupSchedule.nextPickupFormatted,
                      )}`
                    : `Shop is currently closed. Order will be ready tomorrow after ${formatOpeningTime12h(
                        pickupSchedule.openingTime,
                        pickupSchedule.nextPickupFormatted,
                      )}`}
                </p>
              </div>

              <label
                className="toggle-switch"
                style={{ margin: 0, flexShrink: 0 }}
              >
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="Tomorrow Pickup Order"
                  checked={Boolean(isPickup)}
                  onChange={(e) => onTogglePickup?.(e.target.checked)}
                />
                <span className="toggle-slider" />
              </label>
            </div>
          )}

          <button
            type="button"
            onClick={onApplySettingsToAll}
            className="apply-all-btn"
          >
            ⚡ Apply these settings to all files
          </button>
        </>
      ) : (
        <p className="muted">Add a PDF to configure print settings.</p>
      )}
    </section>
  );
}
