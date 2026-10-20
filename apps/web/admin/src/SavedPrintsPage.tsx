import {
  useEffect,
  useState,
  useCallback,
  useRef,
  type FormEvent,
} from "react";
import type {
  SavedPrintDocument,
  PrintSavedPrintRequest,
} from "@printgo/api-contract";
import { MAX_SAVED_PRINT_BYTES } from "@printgo/domain";
import { formatBytes } from "./utils/formatters";
import {
  adminApi,
  AdminApiError,
  friendlyAdminError,
  resolveAdminApiUrl,
} from "./api";

export function SavedPrintsPage({
  onSessionExpired,
}: {
  onSessionExpired: (message: string) => void;
}) {
  const [documents, setDocuments] = useState<SavedPrintDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  // Upload modal state
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Rename modal / dialog state
  const [editingDoc, setEditingDoc] = useState<SavedPrintDocument | null>(null);
  const [editName, setEditName] = useState("");
  const [renaming, setRenaming] = useState(false);

  // Print modal state
  const [printingDoc, setPrintingDoc] = useState<SavedPrintDocument | null>(
    null,
  );
  const [printCopies, setPrintCopies] = useState(1);
  const [printPageMode, setPrintPageMode] = useState<"ALL" | "CUSTOM">("ALL");
  const [printCustomPages, setPrintCustomPages] = useState("");
  const [printPaperSize, setPrintPaperSize] = useState<"A4" | "A3">("A4");
  const [printColorMode, setPrintColorMode] = useState<"BW" | "COLOR">("BW");
  const [printSides, setPrintSides] = useState<"SINGLE" | "DOUBLE">("SINGLE");
  const [submittingPrint, setSubmittingPrint] = useState(false);

  const loadDocuments = useCallback(async () => {
    try {
      const response = await adminApi.getSavedPrints();
      if (response.ok) {
        setDocuments(response.data.documents);
        setError(null);
      }
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    } finally {
      setLoading(false);
    }
  }, [onSessionExpired]);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  // Handle document upload
  const handleUploadSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!uploadFile) {
      setUploadError("Please select a PDF file to upload.");
      return;
    }
    if (uploadFile.size > MAX_SAVED_PRINT_BYTES) {
      setUploadError("PDF file size cannot exceed 10 MB.");
      return;
    }
    if (!uploadName.trim()) {
      setUploadError("Please enter a name for the document.");
      return;
    }

    setUploading(true);
    setUploadError(null);

    const formData = new FormData();
    formData.append("name", uploadName.trim());
    formData.append("file", uploadFile);
    formData.append("pdf", uploadFile);

    try {
      await adminApi.uploadSavedPrint(formData);
      setActionNotice(`Document "${uploadName.trim()}" uploaded successfully.`);
      setShowUploadModal(false);
      setUploadName("");
      setUploadFile(null);
      await loadDocuments();
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setUploadError(friendlyAdminError(caught));
    } finally {
      setUploading(false);
    }
  };

  // Handle document rename
  const handleRenameSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingDoc || !editName.trim()) return;

    setRenaming(true);
    try {
      await adminApi.renameSavedPrint(editingDoc.id, editName.trim());
      setActionNotice("Document name updated.");
      setEditingDoc(null);
      await loadDocuments();
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    } finally {
      setRenaming(false);
    }
  };

  // Handle document delete
  const handleDelete = async (doc: SavedPrintDocument) => {
    if (
      !window.confirm(
        `Are you sure you want to delete "${doc.name}"? This cannot be undone.`,
      )
    ) {
      return;
    }

    try {
      await adminApi.deleteSavedPrint(doc.id);
      setActionNotice(`"${doc.name}" deleted.`);
      await loadDocuments();
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    }
  };

  // Open print dialog
  const openPrintModal = (doc: SavedPrintDocument) => {
    setPrintingDoc(doc);
    setPrintCopies(1);
    setPrintPageMode("ALL");
    setPrintCustomPages("");
    setPrintPaperSize("A4");
    setPrintColorMode("BW");
    setPrintSides("SINGLE");
  };

  // Submit print order
  const handlePrintSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!printingDoc) return;

    setSubmittingPrint(true);
    try {
      const pageRange =
        printPageMode === "CUSTOM" && printCustomPages.trim()
          ? printCustomPages.trim()
          : "ALL";
      const requestInput: PrintSavedPrintRequest = {
        copies: printCopies,
        pageRange,
        paperSize: printPaperSize,
        colorMode: printColorMode,
        sides: printSides,
      };

      const result = await adminApi.printSavedPrint(
        printingDoc.id,
        requestInput,
      );
      if (result.ok) {
        setActionNotice(
          `Print job #${result.data.jobCode} queued successfully for "${printingDoc.name}".`,
        );
      }
      setPrintingDoc(null);
    } catch (caught: unknown) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onSessionExpired("Your session has expired. Please sign in again.");
        return;
      }
      setError(friendlyAdminError(caught));
    } finally {
      setSubmittingPrint(false);
    }
  };

  return (
    <div
      className="saved-prints-page"
      style={{ padding: "1.5rem", maxWidth: "1050px", margin: "0 auto" }}
    >
      {/* Top Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "1rem",
          marginBottom: "1.5rem",
        }}
      >
        <div>
          <h1
            style={{
              margin: "0 0 0.25rem 0",
              fontSize: "1.75rem",
              fontWeight: 800,
            }}
          >
            Saved Prints
          </h1>
          <p className="muted" style={{ margin: 0, fontSize: "0.95rem" }}>
            Frequently requested shop forms and documents. Print anytime without
            re-uploading.
          </p>
        </div>

        <button
          type="button"
          className="primary-button"
          onClick={() => {
            setShowUploadModal(true);
            setUploadError(null);
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          <span>＋</span> Upload Document
        </button>
      </div>

      {actionNotice && (
        <div
          role="status"
          style={{
            marginBottom: "1rem",
            padding: "0.75rem 1rem",
            background: "#f0fdf4",
            color: "#166534",
            border: "1px solid #bbf7d0",
            borderRadius: "8px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>{actionNotice}</span>
          <button
            type="button"
            onClick={() => setActionNotice(null)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "#166534",
              fontWeight: "bold",
            }}
          >
            ×
          </button>
        </div>
      )}

      {error && (
        <div
          role="alert"
          style={{
            marginBottom: "1rem",
            padding: "0.75rem 1rem",
            background: "#fef2f2",
            color: "#991b1b",
            border: "1px solid #fecaca",
            borderRadius: "8px",
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: "center", padding: "3rem", color: "#64748b" }}>
          Loading saved prints…
        </div>
      ) : documents.length === 0 ? (
        <div
          style={{
            background: "#ffffff",
            padding: "3.5rem 1.5rem",
            borderRadius: "12px",
            textAlign: "center",
            border: "1px dashed #cbd5e1",
            marginTop: "1rem",
          }}
        >
          <div style={{ fontSize: "2.5rem", marginBottom: "0.5rem" }}>📄</div>
          <h3 style={{ margin: "0 0 0.5rem 0", color: "#1e293b" }}>
            No Saved Documents
          </h3>
          <p
            className="muted"
            style={{
              margin: "0 0 1.25rem 0",
              maxWidth: "450px",
              marginInline: "auto",
            }}
          >
            Upload standard forms, templates, or recurring prints (max 10 MB
            each) to print them with one click.
          </p>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setShowUploadModal(true)}
          >
            Upload your first document
          </button>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "1rem" }}>
          {documents.map((doc) => (
            <div
              key={doc.id}
              style={{
                background: "#ffffff",
                borderRadius: "12px",
                border: "1px solid #e2e8f0",
                padding: "1.25rem",
                boxShadow: "0 2px 4px rgba(0,0,0,0.02)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "1rem",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "1rem",
                }}
              >
                <div
                  style={{
                    background: "#f1f5f9",
                    padding: "0.75rem",
                    borderRadius: "8px",
                    fontSize: "1.5rem",
                    lineHeight: 1,
                  }}
                >
                  📄
                </div>
                <div>
                  <h3
                    style={{
                      margin: "0 0 0.25rem 0",
                      fontSize: "1.1rem",
                      color: "#0f172a",
                    }}
                  >
                    {doc.name}
                  </h3>
                  <div style={{ fontSize: "0.85rem", color: "#64748b" }}>
                    <span>{doc.originalFilename}</span>
                    <span>
                      {" "}
                      · {doc.pageCount} {doc.pageCount === 1 ? "page" : "pages"}
                    </span>
                    <span> · {formatBytes(doc.fileSizeBytes)}</span>
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  flexWrap: "wrap",
                }}
              >
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => openPrintModal(doc)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.35rem",
                  }}
                >
                  <span>🖨️</span> Print
                </button>

                <a
                  href={resolveAdminApiUrl(
                    `/api/admin/saved-prints/${encodeURIComponent(doc.id)}/preview`,
                  )}
                  target="_blank"
                  rel="noreferrer"
                  className="secondary-button"
                  style={{
                    textDecoration: "none",
                    display: "inline-flex",
                    alignItems: "center",
                  }}
                >
                  Preview
                </a>

                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    setEditingDoc(doc);
                    setEditName(doc.name);
                  }}
                >
                  Rename
                </button>

                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleDelete(doc)}
                  style={{ color: "#ef4444" }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Upload Modal */}
      {showUploadModal && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: "#ffffff",
              borderRadius: "16px",
              padding: "1.5rem",
              width: "100%",
              maxWidth: "500px",
              boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1)",
            }}
          >
            <h2
              style={{
                margin: "0 0 1rem 0",
                fontSize: "1.25rem",
                color: "#0f172a",
              }}
            >
              Upload Saved Document
            </h2>

            {uploadError && (
              <div
                role="alert"
                style={{
                  marginBottom: "1rem",
                  padding: "0.6rem 0.8rem",
                  background: "#fef2f2",
                  color: "#991b1b",
                  borderRadius: "6px",
                  fontSize: "0.9rem",
                }}
              >
                {uploadError}
              </div>
            )}

            <form onSubmit={(e) => void handleUploadSubmit(e)}>
              <div style={{ marginBottom: "1rem" }}>
                <label
                  htmlFor="upload-doc-name"
                  style={{
                    display: "block",
                    marginBottom: "0.4rem",
                    fontWeight: 600,
                  }}
                >
                  Document Display Name
                </label>
                <input
                  id="upload-doc-name"
                  type="text"
                  placeholder="e.g. Standard Rental Agreement, Price List"
                  value={uploadName}
                  onChange={(e) => setUploadName(e.target.value)}
                  maxLength={100}
                  required
                  style={{ width: "100%", padding: "0.6rem" }}
                />
              </div>

              <div style={{ marginBottom: "1.25rem" }}>
                <label
                  htmlFor="upload-doc-file"
                  style={{
                    display: "block",
                    marginBottom: "0.4rem",
                    fontWeight: 600,
                  }}
                >
                  PDF File (Max 10 MB)
                </label>
                <input
                  id="upload-doc-file"
                  type="file"
                  ref={fileInputRef}
                  accept="application/pdf"
                  onChange={(e) => {
                    const file = e.target.files?.[0] ?? null;
                    setUploadFile(file);
                    if (file && !uploadName) {
                      setUploadName(file.name.replace(/\.pdf$/i, ""));
                    }
                  }}
                  required
                  style={{ width: "100%" }}
                />
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: "0.75rem",
                }}
              >
                <button
                  type="button"
                  className="secondary-button"
                  disabled={uploading}
                  onClick={() => setShowUploadModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="primary-button"
                  disabled={uploading}
                >
                  {uploading ? "Uploading…" : "Upload Document"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Rename Modal */}
      {editingDoc && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: "#ffffff",
              borderRadius: "16px",
              padding: "1.5rem",
              width: "100%",
              maxWidth: "450px",
            }}
          >
            <h2 style={{ margin: "0 0 1rem 0", fontSize: "1.25rem" }}>
              Rename Document
            </h2>

            <form onSubmit={(e) => void handleRenameSubmit(e)}>
              <div style={{ marginBottom: "1.25rem" }}>
                <label
                  htmlFor="rename-input"
                  style={{
                    display: "block",
                    marginBottom: "0.4rem",
                    fontWeight: 600,
                  }}
                >
                  Document Name
                </label>
                <input
                  id="rename-input"
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  maxLength={100}
                  required
                  style={{ width: "100%", padding: "0.6rem" }}
                />
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: "0.75rem",
                }}
              >
                <button
                  type="button"
                  className="secondary-button"
                  disabled={renaming}
                  onClick={() => setEditingDoc(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="primary-button"
                  disabled={renaming}
                >
                  {renaming ? "Saving…" : "Save"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Print Settings Modal */}
      {printingDoc && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: "#ffffff",
              borderRadius: "16px",
              padding: "1.5rem",
              width: "100%",
              maxWidth: "500px",
              maxHeight: "90vh",
              overflowY: "auto",
            }}
          >
            <h2 style={{ margin: "0 0 0.25rem 0", fontSize: "1.3rem" }}>
              Print: {printingDoc.name}
            </h2>
            <p
              className="muted"
              style={{ margin: "0 0 1.25rem 0", fontSize: "0.85rem" }}
            >
              {printingDoc.pageCount}{" "}
              {printingDoc.pageCount === 1 ? "page" : "pages"} ·{" "}
              {formatBytes(printingDoc.fileSizeBytes)}
            </p>

            <form onSubmit={(e) => void handlePrintSubmit(e)}>
              {/* Copies */}
              <div style={{ marginBottom: "1rem" }}>
                <label
                  htmlFor="print-copies"
                  style={{
                    display: "block",
                    marginBottom: "0.3rem",
                    fontWeight: 600,
                  }}
                >
                  Copies
                </label>
                <input
                  id="print-copies"
                  type="number"
                  min={1}
                  max={100}
                  value={printCopies}
                  onChange={(e) =>
                    setPrintCopies(
                      Math.max(1, Math.min(100, parseInt(e.target.value) || 1)),
                    )
                  }
                  style={{ width: "90px", padding: "0.4rem" }}
                />
              </div>

              {/* Pages */}
              <div style={{ marginBottom: "1rem" }}>
                <label
                  style={{
                    display: "block",
                    marginBottom: "0.3rem",
                    fontWeight: 600,
                  }}
                >
                  Pages to Print
                </label>
                <div
                  style={{
                    display: "flex",
                    gap: "1rem",
                    marginBottom: "0.5rem",
                  }}
                >
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.35rem",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="radio"
                      name="pageMode"
                      checked={printPageMode === "ALL"}
                      onChange={() => setPrintPageMode("ALL")}
                    />
                    All pages (1–{printingDoc.pageCount})
                  </label>
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.35rem",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="radio"
                      name="pageMode"
                      checked={printPageMode === "CUSTOM"}
                      onChange={() => setPrintPageMode("CUSTOM")}
                    />
                    Custom range
                  </label>
                </div>
                {printPageMode === "CUSTOM" && (
                  <input
                    type="text"
                    placeholder="e.g. 1-3, 5"
                    value={printCustomPages}
                    onChange={(e) => setPrintCustomPages(e.target.value)}
                    style={{ width: "100%", padding: "0.4rem" }}
                  />
                )}
              </div>

              {/* Paper & Color & Sides */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 1fr",
                  gap: "0.75rem",
                  marginBottom: "1.5rem",
                }}
              >
                <div>
                  <label
                    htmlFor="print-paper"
                    style={{
                      display: "block",
                      marginBottom: "0.3rem",
                      fontWeight: 600,
                      fontSize: "0.85rem",
                    }}
                  >
                    Paper
                  </label>
                  <select
                    id="print-paper"
                    value={printPaperSize}
                    onChange={(e) =>
                      setPrintPaperSize(e.target.value as "A4" | "A3")
                    }
                    style={{ width: "100%", padding: "0.4rem" }}
                  >
                    <option value="A4">A4</option>
                    <option value="A3">A3</option>
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="print-color"
                    style={{
                      display: "block",
                      marginBottom: "0.3rem",
                      fontWeight: 600,
                      fontSize: "0.85rem",
                    }}
                  >
                    Color
                  </label>
                  <select
                    id="print-color"
                    value={printColorMode}
                    onChange={(e) =>
                      setPrintColorMode(e.target.value as "BW" | "COLOR")
                    }
                    style={{ width: "100%", padding: "0.4rem" }}
                  >
                    <option value="BW">Black & White</option>
                    <option value="COLOR">Color</option>
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="print-sides"
                    style={{
                      display: "block",
                      marginBottom: "0.3rem",
                      fontWeight: 600,
                      fontSize: "0.85rem",
                    }}
                  >
                    Sides
                  </label>
                  <select
                    id="print-sides"
                    value={printSides}
                    onChange={(e) =>
                      setPrintSides(e.target.value as "SINGLE" | "DOUBLE")
                    }
                    style={{ width: "100%", padding: "0.4rem" }}
                  >
                    <option value="SINGLE">Single-sided</option>
                    <option value="DOUBLE">Double-sided</option>
                  </select>
                </div>
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: "0.75rem",
                }}
              >
                <button
                  type="button"
                  className="secondary-button"
                  disabled={submittingPrint}
                  onClick={() => setPrintingDoc(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="primary-button"
                  disabled={submittingPrint}
                >
                  {submittingPrint ? "Sending to Printer…" : "Print Now"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
