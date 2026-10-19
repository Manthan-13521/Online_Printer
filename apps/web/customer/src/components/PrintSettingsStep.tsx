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
