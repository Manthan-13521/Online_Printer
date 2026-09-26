import { useEffect, useMemo, useState } from "react";

import type {
  CustomerConfigData,
  CustomerQuoteData,
} from "@printgo/api-contract";
import { parsePageRange } from "@printgo/domain";
import { formatInr } from "@printgo/pricing";

import { customerApi, uploadDirectly } from "./api";
import { inspectPdf } from "./pdf";

const DRAFT_TOKEN_KEY = "printgo.customerDraftToken";
const humanFileSize = (bytes: number) =>
  `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

function customerErrorMessage(caught: unknown): string {
  const code = caught instanceof Error ? caught.message : "";
  if (code === "ONLINE_PRINTING_DISABLED")
    return "Online printing was switched off. No upload was authorized.";
  if (code === "DRAFT_EXPIRED")
    return "This upload session expired. Please upload your PDF again.";
  if (code === "UPLOAD_INVALID")
    return "We couldn't read this PDF. Please check the file and try again.";
  if (code === "UPLOAD_NETWORK_ERROR" || code === "Failed to fetch")
    return "Connection lost during upload. Check your connection and try again.";
  return "The upload could not be completed. Your selections are preserved; please try again.";
}

export function App() {
  const [config, setConfig] = useState<CustomerConfigData | null>(null);
  const [loading, setLoading] = useState(true);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [instructions, setInstructions] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [pageMode, setPageMode] = useState<"ALL" | "CUSTOM">("ALL");
  const [customPages, setCustomPages] = useState("");
  const [copies, setCopies] = useState(1);
  const [paperSize, setPaperSize] = useState<"A4" | "A3">("A4");
  const [colorMode, setColorMode] = useState<"BW" | "COLOR">("BW");
  const [sides, setSides] = useState<"SINGLE" | "DOUBLE">("SINGLE");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [quote, setQuote] = useState<CustomerQuoteData | null>(null);
  const [draftToken, setDraftToken] = useState<string | null>(null);
  const [uploadFinalized, setUploadFinalized] = useState(false);

  useEffect(() => {
    customerApi
      .config()
      .then((loaded) => {
        setConfig(loaded);
        const first = loaded.availablePrintOptions[0];
        if (first) {
          setPaperSize(first.paperSize);
          setColorMode(first.colorMode);
          setSides(first.sides);
        }
      })
      .catch(() => {
        setStatus("Shop configuration could not be loaded. Please retry.");
      })
      .finally(() => setLoading(false));
  }, []);

  const optionAvailable = useMemo(
    () =>
      (config?.availablePrintOptions ?? []).some(
        (option) =>
          option.paperSize === paperSize &&
          option.colorMode === colorMode &&
          option.sides === sides,
      ),
    [config, paperSize, colorMode, sides],
  );

  async function chooseFile(selected: File | null) {
    setQuote(null);
    setDraftToken(null);
    setUploadFinalized(false);
    sessionStorage.removeItem(DRAFT_TOKEN_KEY);
    setFileError(null);
    setPageCount(null);
    setFile(selected);
    if (!selected || !config) return;
    if (
      !selected.name.toLocaleLowerCase().endsWith(".pdf") ||
      (selected.type && selected.type !== "application/pdf")
    ) {
      setFileError("Choose a PDF file.");
      return;
    }
    if (selected.size <= 0 || selected.size > config.maxPdfSizeBytes) {
      setFileError(
        `PDFs must be between 1 byte and ${humanFileSize(config.maxPdfSizeBytes)}.`,
      );
      return;
    }
    try {
      const pages = await inspectPdf(selected);
      setPageCount(pages);
      setCustomPages(`1-${pages}`);
    } catch (caught) {
      setFileError(
        caught instanceof Error && caught.message === "PASSWORD_PROTECTED"
          ? "Password-protected PDFs are not supported. Remove the password and try again."
          : "This PDF is corrupted or cannot be read.",
      );
    }
  }

  async function prepareReview(event: React.FormEvent) {
    event.preventDefault();
    if (
      !config?.onlinePrintingEnabled ||
      !file ||
      !pageCount ||
      fileError ||
      !optionAvailable
    )
      return;
    const selectedPages = pageMode === "ALL" ? `1-${pageCount}` : customPages;
    try {
      parsePageRange(selectedPages, pageCount);
    } catch {
      setStatus(`Enter pages between 1 and ${pageCount}, such as 1,3,7-10.`);
      return;
    }
    setBusy(true);
    setStatus("Creating a secure upload…");
    setQuote(null);
    try {
      let token = draftToken;
      if (!uploadFinalized) {
        let upload;
        if (token) {
          upload = (await customerApi.authorize(token)).upload;
        } else {
          const draft = await customerApi.createDraft({
            customerName,
            customerPhone,
            instructions: instructions.trim() || null,
            originalFilename: file.name,
            expectedSizeBytes: file.size,
            sourcePageCount: pageCount,
          });
          token = draft.draftToken;
          upload = draft.upload;
          setDraftToken(token);
          sessionStorage.setItem(DRAFT_TOKEN_KEY, token);
        }
        setStatus("Uploading directly to private storage…");
        await uploadDirectly(
          file,
          upload.uploadUrl,
          upload.requiredHeaders,
          setProgress,
        );
        setStatus("Verifying the uploaded PDF…");
        await customerApi.complete(token);
        setUploadFinalized(true);
      }
      if (!token) throw new Error("DRAFT_INVALID");
      setStatus("Calculating your review total…");
      setQuote(
        await customerApi.quote(token, {
          selectedPages,
          copies,
          paperSize,
          colorMode,
          sides,
        }),
      );
      setStatus("Review ready. Payment is added in the next phase.");
    } catch (caught) {
      if (
        caught instanceof Error &&
        ["DRAFT_EXPIRED", "DRAFT_INVALID"].includes(caught.message)
      ) {
        setDraftToken(null);
        setUploadFinalized(false);
        sessionStorage.removeItem(DRAFT_TOKEN_KEY);
      }
      setStatus(customerErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (loading)
    return (
      <main className="page-shell">
        <p>Loading PrintGo…</p>
      </main>
    );

  return (
    <main className="page-shell">
      <header className="hero">
        <p className="eyebrow">PrintGo</p>
        <h1>{config?.shopName ?? "Online printing"}</h1>
        <p>
          {config?.customerNotice ??
            "Upload a PDF and review your print settings."}
        </p>
      </header>
      {!config?.onlinePrintingEnabled ? (
        <section className="notice" role="status">
          <h2>Online printing is currently unavailable</h2>
          <p>
            Please contact the shop
            {config?.contactPhone ? ` at ${config.contactPhone}` : ""}.
          </p>
        </section>
      ) : (
        <form className="flow" onSubmit={(event) => void prepareReview(event)}>
          <section className="step">
            <span className="step-number">1</span>
            <h2>Details</h2>
            <label>
              Name
              <input
                required
                maxLength={120}
                value={customerName}
                onChange={(event) => setCustomerName(event.target.value)}
              />
            </label>
            <label>
              Phone
              <input
                required
                maxLength={30}
                inputMode="tel"
                value={customerPhone}
                onChange={(event) => setCustomerPhone(event.target.value)}
              />
            </label>
            <label>
              Instructions (optional)
              <textarea
                maxLength={1000}
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
              />
            </label>
          </section>
          <section className="step">
            <span className="step-number">2</span>
            <h2>PDF</h2>
            <label className="file-picker">
              Choose PDF
              <input
                required
                type="file"
                accept="application/pdf,.pdf"
                onChange={(event) =>
                  void chooseFile(event.target.files?.[0] ?? null)
                }
              />
            </label>
            {file && (
              <p className="muted">
                {file.name} · {humanFileSize(file.size)}
                {pageCount ? ` · ${pageCount} pages` : ""}
              </p>
            )}
            {fileError && (
              <p className="error" role="alert">
                {fileError}
              </p>
            )}
            <p className="muted">
              Maximum {config ? humanFileSize(config.maxPdfSizeBytes) : "25 MB"}
              . PDFs are private and temporary.
            </p>
            <p className="external-warning">
              Need a smaller file?{" "}
              <a
                href="https://www.ilovepdf.com/compress_pdf"
                target="_blank"
                rel="noreferrer noopener"
              >
                Open iLovePDF
              </a>{" "}
              (external site; its privacy terms apply).
            </p>
          </section>
          <section className="step">
            <span className="step-number">3</span>
            <h2>Settings</h2>
            <fieldset>
              <legend>Pages</legend>
              <label className="inline">
                <input
                  type="radio"
                  checked={pageMode === "ALL"}
                  onChange={() => setPageMode("ALL")}
                />
                All pages
              </label>
              <label className="inline">
                <input
                  type="radio"
                  checked={pageMode === "CUSTOM"}
                  onChange={() => setPageMode("CUSTOM")}
                />
                Custom range
              </label>
              {pageMode === "CUSTOM" && (
                <input
                  aria-label="Custom pages"
                  placeholder="1,3,7-10"
                  value={customPages}
                  onChange={(event) => setCustomPages(event.target.value)}
                />
              )}
            </fieldset>
            <div className="settings-grid">
              <label>
                Copies
                <input
                  type="number"
                  min={1}
                  max={999}
                  value={copies}
                  onChange={(event) => setCopies(Number(event.target.value))}
                />
              </label>
              <label>
                Paper
                <select
                  value={paperSize}
                  onChange={(event) =>
                    setPaperSize(event.target.value as "A4" | "A3")
                  }
                >
                  <option
                    disabled={
                      !config.availablePrintOptions.some(
                        (option) => option.paperSize === "A4",
                      )
                    }
                  >
                    A4
                  </option>
                  <option
                    disabled={
                      !config.availablePrintOptions.some(
                        (option) => option.paperSize === "A3",
                      )
                    }
                  >
                    A3
                  </option>
                </select>
              </label>
              <label>
                Colour
                <select
                  value={colorMode}
                  onChange={(event) =>
                    setColorMode(event.target.value as "BW" | "COLOR")
                  }
                >
                  <option
                    value="BW"
                    disabled={
                      !config.availablePrintOptions.some(
                        (option) =>
                          option.paperSize === paperSize &&
                          option.colorMode === "BW",
                      )
                    }
                  >
                    Black &amp; white
                  </option>
                  <option
                    value="COLOR"
                    disabled={
                      !config.availablePrintOptions.some(
                        (option) =>
                          option.paperSize === paperSize &&
                          option.colorMode === "COLOR",
                      )
                    }
                  >
                    Colour
                  </option>
                </select>
              </label>
              <label>
                Sides
                <select
                  value={sides}
                  onChange={(event) =>
                    setSides(event.target.value as "SINGLE" | "DOUBLE")
                  }
                >
                  <option
                    value="SINGLE"
                    disabled={
                      !config.availablePrintOptions.some(
                        (option) =>
                          option.paperSize === paperSize &&
                          option.colorMode === colorMode &&
                          option.sides === "SINGLE",
                      )
                    }
                  >
                    Single-sided
                  </option>
                  <option
                    value="DOUBLE"
                    disabled={
                      !config.availablePrintOptions.some(
                        (option) =>
                          option.paperSize === paperSize &&
                          option.colorMode === colorMode &&
                          option.sides === "DOUBLE",
                      )
                    }
                  >
                    Double-sided
                  </option>
                </select>
              </label>
            </div>
            {!optionAvailable && (
              <p className="error">
                That print combination is not currently available.
              </p>
            )}
          </section>
          <section className="step review">
            <span className="step-number">4</span>
            <h2>Review</h2>
            {busy && (
              <progress max={100} value={progress}>
                {progress}%
              </progress>
            )}
            {status && <p role="status">{status}</p>}
            {quote && (
              <dl>
                <div>
                  <dt>Customer</dt>
                  <dd>
                    {customerName} · {customerPhone}
                  </dd>
                </div>
                <div>
                  <dt>PDF</dt>
                  <dd>{file?.name}</dd>
                </div>
                {instructions.trim() && (
                  <div>
                    <dt>Instructions</dt>
                    <dd>{instructions.trim()}</dd>
                  </div>
                )}
                <div>
                  <dt>Pages</dt>
                  <dd>
                    {quote.normalizedSelectedPages} ({quote.selectedPageCount})
                  </dd>
                </div>
                <div>
                  <dt>Printing</dt>
                  <dd>{formatInr(quote.printingAmountPaise)}</dd>
                </div>
                <div>
                  <dt>File service</dt>
                  <dd>{formatInr(quote.serviceChargePaise)}</dd>
                </div>
                <div className="total">
                  <dt>Total</dt>
                  <dd>{formatInr(quote.totalAmountPaise)}</dd>
                </div>
              </dl>
            )}
            <button
              type="submit"
              disabled={
                busy ||
                !file ||
                !pageCount ||
                Boolean(fileError) ||
                !optionAvailable
              }
            >
              {busy
                ? "Preparing review…"
                : quote
                  ? "Refresh review"
                  : draftToken
                    ? "Try upload again"
                    : "Upload PDF and review"}
            </button>
            <p className="muted">
              No payment or print job is created in this step.
            </p>
          </section>
        </form>
      )}
    </main>
  );
}
