import type { CustomerConfigData } from "@printgo/api-contract";
import { humanFileSize, type LocalOrderFile } from "./customer-types";

export interface UploadPdfsStepProps {
  files: LocalOrderFile[];
  selectedFileIndex: number;
  onSelectFileIndex: (index: number) => void;
  onRemoveFile: (index: number) => void;
  onChooseFiles: (fileList: FileList) => void;
  config: CustomerConfigData | null;
  fileError: string | null;
  disabled: boolean;
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
}: UploadPdfsStepProps) {
  return (
    <section className="step">
      <div className="step-header">
        <span className="step-number">2</span>
        <h2>Upload PDFs</h2>
        <p className="step-desc">
          Upload one or more PDF files. Your printer will print them instantly.
        </p>
      </div>
      <div className="file-list">
        {files.map((item, index) => (
          <div
            key={item.clientId}
            className={`file-card-compact ${selectedFileIndex === index ? "active" : ""}`}
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
              {(item.uploadStatus === "UPLOADING" ||
                item.uploadStatus === "VALIDATING") && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    marginTop: "4px",
                  }}
                >
                  <progress
                    value={item.uploadProgress}
                    max="100"
                    style={{ height: "6px", flexGrow: 1 }}
                  />
                  <span style={{ fontSize: "0.75rem", color: "#64748b" }}>
                    {Math.round(item.uploadProgress)}%
                  </span>
                </div>
              )}
              {item.uploadStatus === "FAILED" && (
                <span className="file-status status-error">
                  {item.uploadError}
                </span>
              )}
            </div>
            <div className="file-actions-right">
              {item.uploadStatus === "UPLOADED" && (
                <span className="uploaded-badge">✓ Uploaded</span>
              )}
              <button
                type="button"
                className="remove-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveFile(index);
                }}
                aria-label="Remove file"
              >
                &times;
              </button>
            </div>
          </div>
        ))}
      </div>

      {files.length < (config?.maxOrderFiles ?? 10) && (
        <label className="drop-zone">
          <div className="drop-icon">+</div>
          <div className="drop-title">Add another PDF</div>
          <div className="drop-subtitle">Choose files or drag and drop</div>
          <div className="choose-btn">Choose Files</div>
          <input
            type="file"
            aria-label="Choose Files"
            accept="application/pdf"
            multiple
            disabled={disabled}
            onChange={(event) => {
              if (!event.target.files?.length) return;
              onChooseFiles(event.target.files);
              event.target.value = "";
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
