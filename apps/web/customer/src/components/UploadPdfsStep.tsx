import type { CustomerConfigData } from "@printgo/api-contract";
import { humanFileSize, type LocalOrderFile } from "./customer-types";
import { FloatingLoadingIndicator } from "./FloatingLoadingIndicator";

export interface UploadPdfsStepProps {
  files: LocalOrderFile[];
  selectedFileIndex: number;
  onSelectFileIndex: (index: number) => void;
  onRemoveFile: (index: number) => void;
  onChooseFiles: (fileList: FileList) => void;
  config: CustomerConfigData | null;
  fileError: string | null;
  disabled: boolean;
  isInspectingFiles?: boolean;
}

export function UploadPdfsStep({
  files,
  selectedFileIndex,
  onSelectFileIndex,
  onRemoveFile,
  onChooseFiles,
  config,
  fileError,
  disabled,
  isInspectingFiles = false,
}: UploadPdfsStepProps) {
  return (
    <section className="step upload-pdfs-step">
      <div className="step-header">
        <span className="step-number">2</span>
        <h2>Upload PDFs</h2>
        <p className="step-desc">
          Upload one or more PDF files. Your printer will print them instantly.
        </p>
      </div>
      <div className="file-list">
        {files.map((item, index) => {
          const isUploading = item.uploadStatus === "UPLOADING";
          const isPreparing =
            item.uploadStatus === "VALIDATING" ||
            item.uploadStatus === "FINALIZING";
          const isUploaded = item.uploadStatus === "UPLOADED";
          const isFailed = item.uploadStatus === "FAILED";

          return (
            <div
              key={item.clientId}
              className={`file-card-compact ${selectedFileIndex === index ? "active" : ""} ${isUploaded ? "uploaded" : ""} ${isFailed ? "has-error" : ""}`}
              onClick={() => onSelectFileIndex(index)}
              role="button"
              tabIndex={0}
              aria-label={`Settings for File ${index + 1}, ${item.name}`}
            >
              <div className="file-icon-wrapper">
                <span className="pdf-icon-doc">PDF</span>
              </div>
              <div className="file-info">
                <span className="file-name" title={item.name}>
                  {item.name.length > 30
                    ? item.name.substring(0, 30) + "..."
                    : item.name}
                </span>
                <span className="file-meta">
                  {item.pageCount} pages · {humanFileSize(item.size)}
                </span>

                {/* Real-time Loading & Progress Feedback */}
                {isPreparing && (
                  <div
                    className="file-feedback-box preparing"
                    role="status"
                    aria-live="polite"
                  >
                    <FloatingLoadingIndicator size="xs" variant="green" />
                    <span className="file-feedback-text">
                      Preparing your file...
                    </span>
                    <progress
                      value={0}
                      max="100"
                      className="sr-only-progress"
                      aria-hidden="true"
                    />
                  </div>
                )}

                {isUploading && (
                  <div
                    className="file-feedback-box uploading"
                    role="status"
                    aria-live="polite"
                  >
                    <div className="file-feedback-row">
                      <FloatingLoadingIndicator size="xs" variant="green" />
                      <span className="file-feedback-text">
                        Uploading your PDF...
                      </span>
                      <span className="file-upload-pct">
                        {Math.round(item.uploadProgress)}%
                      </span>
                    </div>
                    <div className="file-progress-track">
                      <div
                        className="file-progress-bar"
                        style={{
                          width: `${Math.max(8, item.uploadProgress)}%`,
                        }}
                      />
                    </div>
                    {/* Native progress bar preserved for accessibility & tests */}
                    <progress
                      value={item.uploadProgress}
                      max="100"
                      className="sr-only-progress"
                    />
                  </div>
                )}

                {isFailed && (
                  <span className="file-status status-error" role="alert">
                    ⚠️ {item.uploadError || "Upload failed. Please retry."}
                  </span>
                )}
              </div>
              <div className="file-actions-right">
                {isUploaded && (
                  <span className="uploaded-badge">✓ Uploaded</span>
                )}
                <button
                  type="button"
                  className="remove-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveFile(index);
                  }}
                  aria-label={`Remove file ${item.name}`}
                >
                  &times;
                </button>
              </div>
            </div>
          );
        })}

        {/* Immediate feedback while user selected files are being prepared/parsed */}
        {isInspectingFiles && (
          <div
            className="file-card-compact file-card-inspecting"
            role="status"
            aria-live="polite"
          >
            <div className="file-icon-wrapper inspecting">
              <span className="pdf-icon-doc">PDF</span>
            </div>
            <div className="file-info">
              <span className="file-name">Reading selected PDF...</span>
              <div className="file-feedback-box preparing">
                <FloatingLoadingIndicator size="xs" variant="green" />
                <span className="file-feedback-text">
                  Preparing your file...
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {files.length < (config?.maxOrderFiles ?? 10) && (
        <label className="drop-zone">
          <div className="drop-icon">+</div>
          <div className="drop-title">
            {files.length === 0 ? "Select PDF file" : "Add another PDF"}
          </div>
          <div className="drop-subtitle">Choose files or drag and drop</div>
          <div className="choose-btn">Choose Files</div>
          <input
            type="file"
            aria-label="Choose Files"
            accept="application/pdf"
            multiple
            disabled={disabled || isInspectingFiles}
            onClick={(event) => {
              (event.target as HTMLInputElement).value = "";
            }}
            onChange={(event) => {
              const fileList = event.target.files;
              if (!fileList || fileList.length === 0) return;
              onChooseFiles(fileList);
            }}
          />
        </label>
      )}

      <div className="upload-footer">
        <span className="file-count">
          {files.length} of {config?.maxOrderFiles ?? 10} files | Maximum{" "}
          {config ? humanFileSize(config.maxPdfSizeBytes) : "20.0 MB"} per file.
        </span>
        <a
          href="https://www.ilovepdf.com/compress_pdf"
          target="_blank"
          rel="noreferrer noopener"
          className="compress-link"
        >
          Need a smaller file? Open iLovePDF ↗
        </a>
        <p
          className="privacy-warning"
          style={{
            fontSize: "0.75rem",
            marginTop: "4px",
            color: "#64748b",
          }}
        >
          iLovePDF is an external site; its privacy terms apply.
        </p>
      </div>
      {fileError && (
        <p className="error" role="alert">
          {fileError}
        </p>
      )}
    </section>
  );
}
