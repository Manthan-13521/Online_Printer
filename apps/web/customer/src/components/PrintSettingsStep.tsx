import type { CustomerConfigData } from "@printgo/api-contract";
import type { PaperSize } from "@printgo/domain";
import { MAX_PRINT_COPIES, MIN_PRINT_COPIES } from "@printgo/domain";
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
}: PrintSettingsStepProps) {
  return (
    <section className="step">
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
            <div className="print-setting-col">
              <label style={{ margin: 0, fontWeight: 600 }}>Pages</label>
              <div className="visual-options horizontal">
                <label
                  className={`visual-option-card ${selectedFile.pageMode === "ALL" ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    checked={selectedFile.pageMode === "ALL"}
                    onChange={() => onPatchSelected({ pageMode: "ALL" })}
                  />
                  <span className="radio-circle"></span>
                  <span className="label">All pages</span>
                </label>
                <label
                  className={`visual-option-card ${selectedFile.pageMode === "CUSTOM" ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    checked={selectedFile.pageMode === "CUSTOM"}
                    onChange={() => onPatchSelected({ pageMode: "CUSTOM" })}
                  />
                  <span className="radio-circle"></span>
                  <span className="label">Custom range</span>
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

            <div className="print-setting-col row-layout">
              <div className="copies-control">
                <label htmlFor="copies-input" style={{ margin: 0 }}>
                  Copies
                </label>
                <div className="number-stepper">
                  <button
                    type="button"
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
                    type="number"
                    min={MIN_PRINT_COPIES}
                    max={MAX_PRINT_COPIES}
                    value={selectedFile.copies}
                    onChange={(event) =>
                      onPatchSelected({
                        copies: Number(event.target.value),
                      })
                    }
                  />
                  <button
                    type="button"
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
              <div className="paper-size-control">
                <label htmlFor="paper-size" style={{ margin: 0 }}>
                  Paper size
                </label>
                <div className="select-wrapper">
                  <span className="icon">📄</span>
                  <select
                    id="paper-size"
                    value={selectedFile.paperSize}
                    onChange={(event) =>
                      onPatchSelected({
                        paperSize: event.target.value as PaperSize,
                      })
                    }
                  >
                    <option value="A4">A4</option>
                    <option
                      value="A3"
                      disabled={!printOptions.some((o) => o.paperSize === "A3")}
                    >
                      {printOptions.some((o) => o.paperSize === "A3")
                        ? "A3"
                        : "A3 (A3 paper unavailable)"}
                    </option>
                  </select>
                </div>
                {!printOptions.some((o) => o.paperSize === "A3") && (
                  <span
                    style={{
                      fontSize: "0.75rem",
                      color: "#64748b",
                      marginTop: "0.25rem",
                      display: "block",
                    }}
                  >
                    A3 paper unavailable
                  </span>
                )}
              </div>
            </div>

            <div className="print-setting-col">
              <label style={{ margin: 0 }}>Colour</label>
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
                      <span
                        style={{
                          display: "block",
                          fontSize: "0.7rem",
                          color: "#64748b",
                          fontWeight: 400,
                        }}
                      >
                        No colour printer available
                      </span>
                    )}
                  </span>
                  <span className="radio-circle"></span>
                </label>
              </div>
            </div>

            <div className="print-setting-col">
              <label style={{ margin: 0 }}>Sides</label>
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
                  <span className="card-icon single-side-icon">📄</span>
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
                  <span className="card-icon double-side-icon">📑</span>
                  <span className="label">
                    Double-sided
                    {!printOptions.some(
                      (o) =>
                        o.paperSize === selectedFile.paperSize &&
                        o.colorMode === selectedFile.colorMode &&
                        o.sides === "DOUBLE",
                    ) && (
                      <span
                        style={{
                          display: "block",
                          fontSize: "0.72rem",
                          color: "#64748b",
                          fontWeight: 400,
                          marginTop: "0.15rem",
                        }}
                      >
                        Duplex printing unavailable on current printers
                      </span>
                    )}
                  </span>
                  <span className="radio-circle"></span>
                </label>
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
