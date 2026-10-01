import { applyShopBranding } from "../../branding";
import { useEffect, useMemo, useState } from "react";

import type { ColorMode, PaperSize, SidesMode } from "@printgo/domain";
import type {
  CustomerConfigData,
  CustomerPaymentCheckoutData,
  CustomerPaymentSuccessData,
  CustomerQuoteData,
} from "@printgo/api-contract";
import {
  MAX_PRINT_COPIES,
  MIN_PRINT_COPIES,
  parsePageRange,
} from "@printgo/domain";
import { formatInr } from "@printgo/pricing";

import { customerApi, uploadDirectly, resolveCustomerApiUrl } from "./api";
import { inspectPdf } from "./pdf";
import { PwaInstallBanner } from "./PwaInstallBanner";
import { TrackingPage } from "./TrackingPage";
import {
  createTrackingToken,
  privateTrackingUrl,
  trackingStorageKey,
} from "./tracking-token";

const DRAFT_TOKEN_KEY = "printgo.customerDraftToken";
const PENDING_TRACKING_TOKEN_PREFIX = "printgo.pendingTracking.";
const humanFileSize = (bytes: number) =>
  `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

interface LocalOrderFile {
  clientId: string;
  fileId?: string;
  file: File | null;
  name: string;
  size: number;
  pageCount: number;
  uploaded: boolean;
  pageMode: "ALL" | "CUSTOM";
  customPages: string;
  copies: number;
  paperSize: PaperSize;
  colorMode: ColorMode;
  sides: SidesMode;
}

function trackingCodeFromPath(): string | null {
  const match = /^\/track\/([^/]+)\/?$/u.exec(window.location.pathname);
  return match ? decodeURIComponent(match[1] ?? "") : null;
}

interface RazorpaySuccessResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

interface RazorpayInstance {
  open(): void;
  on(event: "payment.failed", callback: () => void): void;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

let checkoutScriptPromise: Promise<void> | null = null;

function loadRazorpayCheckout(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  if (checkoutScriptPromise) return checkoutScriptPromise;
  const loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("CHECKOUT_LOAD_FAILED"));
    document.head.append(script);
  }).catch((caught: unknown) => {
    checkoutScriptPromise = null;
    throw caught;
  });
  checkoutScriptPromise = loading;
  return loading;
}

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

function paymentErrorMessage(caught: unknown): string {
  const code = caught instanceof Error ? caught.message : "";
  if (code === "PRINTER_NOT_READY")
    return "Online payment is temporarily unavailable because the shop printer is not ready.";
  if (code === "PAYMENT_NOT_CAPTURED")
    return "Payment is still being confirmed. No print job has been created yet.";
  if (code === "PAYMENT_SIGNATURE_INVALID")
    return "Payment verification failed. Please contact the shop before trying again.";
  if (code === "PAYMENT_PROVIDER_UNAVAILABLE" || code === "Failed to fetch")
    return "The payment service could not be reached. Please check your connection and try again.";
  if (code === "CHECKOUT_LOAD_FAILED")
    return "The secure payment window could not be loaded. Please try again.";
  return "Payment could not be completed. You have not been shown a successful print job.";
}

export function App() {
  const [trackingJobCode, setTrackingJobCode] = useState(trackingCodeFromPath);
  const [config, setConfig] = useState<CustomerConfigData | null>(null);
  const [loading, setLoading] = useState(true);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [instructions, setInstructions] = useState("");
  const [files, setFiles] = useState<LocalOrderFile[]>([]);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [quote, setQuote] = useState<CustomerQuoteData | null>(null);
  const [draftToken, setDraftToken] = useState<string | null>(null);
  const [paymentBusy, setPaymentBusy] = useState(false);
  const [paymentSuccess, setPaymentSuccess] =
    useState<CustomerPaymentSuccessData | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);

  useEffect(() => {
    const handlePopState = () => setTrackingJobCode(trackingCodeFromPath());
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    customerApi
      .config()
      .then((loaded) => {
        setConfig(loaded);
      })
      .catch(() => {
        setStatus("Shop configuration could not be loaded. Please retry.");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (config?.appName || config?.shopName)
      return applyShopBranding(config.appName ?? config.shopName);
    return undefined;
  }, [config?.appName, config?.shopName]);

  useEffect(() => {
    if (!config) return;
    const savedToken = sessionStorage.getItem(DRAFT_TOKEN_KEY);
    if (!savedToken) return;
    void customerApi
      .getDraft(savedToken)
      .then((draft) => {
        setCustomerName(draft.customerName);
        setCustomerPhone(draft.customerPhone);
        setInstructions(draft.instructions ?? "");
        setFiles(
          draft.files.map((remote) => ({
            clientId: remote.fileId,
            fileId: remote.fileId,
            file: null,
            name: remote.originalFilename,
            size: remote.sizeBytes ?? 0,
            pageCount: remote.sourcePageCount,
            uploaded: remote.uploadStatus === "UPLOADED",
            pageMode: remote.selectedPages === "ALL" ? "ALL" : "CUSTOM",
            customPages:
              remote.selectedPages === "ALL"
                ? `1-${remote.sourcePageCount}`
                : remote.selectedPages,
            copies: remote.copies,
            paperSize: remote.paperSize,
            colorMode: remote.colorMode,
            sides: remote.sides,
          })),
        );
        setDraftToken(savedToken);
        setStatus("Your secure upload session was restored.");
      })
      .catch(() => sessionStorage.removeItem(DRAFT_TOKEN_KEY));
  }, [config]);

  const selectedFile = files[selectedFileIndex] ?? null;

  const optionAvailable = useMemo(
    () =>
      (config?.availablePrintOptions ?? []).some(
        (option) =>
          option.paperSize === selectedFile?.paperSize &&
          option.colorMode === selectedFile?.colorMode &&
          option.sides === selectedFile?.sides,
      ),
    [config, selectedFile],
  );

  function patchSelected(update: Partial<LocalOrderFile>) {
    setQuote(null);
    setFiles((current) =>
      current.map((item, index) =>
        index === selectedFileIndex ? { ...item, ...update } : item,
      ),
    );
  }

  async function chooseFiles(selected: FileList | null) {
    setQuote(null);
    setPaymentSuccess(null);
    setFileError(null);
    if (!selected || !config) return;
    const incoming = [...selected];
    if (files.length + incoming.length > (config.maxOrderFiles ?? 10)) {
      setFileError("You can add up to 10 PDFs in one order.");
      return;
    }
    const aggregate =
      files.reduce((total, item) => total + item.size, 0) +
      incoming.reduce((total, item) => total + item.size, 0);
    if (aggregate > (config.maxOrderUploadBytes ?? 100 * 1024 * 1024)) {
      setFileError("These PDFs exceed the 100 MB order limit.");
      return;
    }
    const firstOption = config.availablePrintOptions[0];
    if (!firstOption) return;
    const added: LocalOrderFile[] = [];
    for (const selectedFile of incoming) {
      if (
        !selectedFile.name.toLocaleLowerCase().endsWith(".pdf") ||
        (selectedFile.type && selectedFile.type !== "application/pdf")
      ) {
        setFileError("Choose PDF files only.");
        return;
      }
      if (
        selectedFile.size <= 0 ||
        selectedFile.size > config.maxPdfSizeBytes
      ) {
        setFileError(
          `PDFs must be between 1 byte and ${humanFileSize(config.maxPdfSizeBytes)}.`,
        );
        return;
      }
      try {
        const pages = await inspectPdf(selectedFile);
        added.push({
          clientId: crypto.randomUUID(),
          file: selectedFile,
          name: selectedFile.name,
          size: selectedFile.size,
          pageCount: pages,
          uploaded: false,
          pageMode: "ALL",
          customPages: `1-${pages}`,
          copies: 1,
          paperSize: firstOption.paperSize,
          colorMode: firstOption.colorMode,
          sides: firstOption.sides,
        });
      } catch (caught) {
        setFileError(
          caught instanceof Error && caught.message === "PASSWORD_PROTECTED"
            ? "Password-protected PDFs are not supported. Remove the password and try again."
            : "This PDF is corrupted or cannot be read.",
        );
        return;
      }
    }
    setFiles((current) => [...current, ...added]);
    setSelectedFileIndex(files.length);
  }

  async function prepareReview(event: React.FormEvent) {
    event.preventDefault();
    if (
      !config?.onlinePrintingEnabled ||
      files.length === 0 ||
      fileError ||
      !optionAvailable
    )
      return;
    for (const item of files) {
      const selectedPages =
        item.pageMode === "ALL" ? `1-${item.pageCount}` : item.customPages;
      try {
        parsePageRange(selectedPages, item.pageCount);
      } catch {
        setStatus(
          `Enter pages between 1 and ${item.pageCount} for File ${files.indexOf(item) + 1}.`,
        );
        return;
      }
    }
    setBusy(true);
    setStatus("Creating a secure upload…");
    setQuote(null);
    try {
      let token = draftToken;
      const working = [...files];
      for (let index = 0; index < working.length; index++) {
        let item = working[index]!;
        if (item.uploaded) continue;
        if (!item.file) throw new Error("UPLOAD_FILE_REQUIRED");
        const uploadFile = item.file;
        let upload;
        if (!token) {
          const draft = await customerApi.createDraft({
            customerName,
            customerPhone,
            instructions: instructions.trim() || null,
            originalFilename: item.name,
            expectedSizeBytes: item.size,
            sourcePageCount: item.pageCount,
          });
          token = draft.draftToken;
          upload = draft.upload;
          if (!draft.fileId) throw new Error("DRAFT_INVALID");
          item = { ...item, fileId: draft.fileId };
          setDraftToken(token);
          sessionStorage.setItem(DRAFT_TOKEN_KEY, token);
        } else if (!item.fileId) {
          const created = await customerApi.addFile(token, {
            originalFilename: item.name,
            expectedSizeBytes: item.size,
            sourcePageCount: item.pageCount,
          });
          item = { ...item, fileId: created.fileId };
          upload = created.upload;
        } else {
          upload = (await customerApi.authorize(token, item.fileId)).upload;
        }
        working[index] = item;
        setFiles([...working]);
        setStatus(`Uploading File ${index + 1} of ${working.length}…`);
        await uploadDirectly(
          uploadFile,
          upload.uploadUrl,
          upload.requiredHeaders,
          setProgress,
        );
        setStatus(`Verifying File ${index + 1}…`);
        await customerApi.complete(token, item.fileId);
        working[index] = { ...item, uploaded: true };
        setFiles([...working]);
      }
      if (!token) throw new Error("DRAFT_INVALID");
      setStatus("Calculating your review total…");
      setQuote(
        await customerApi.quoteOrder(token, {
          files: working.map((item) => ({
            fileId: item.fileId!,
            selectedPages:
              item.pageMode === "ALL"
                ? `1-${item.pageCount}`
                : item.customPages,
            copies: item.copies,
            paperSize: item.paperSize,
            colorMode: item.colorMode,
            sides: item.sides,
          })),
        }),
      );
      setPaymentSuccess(null);
      setStatus(
        "Review ready. Confirm the total to continue to secure payment.",
      );
    } catch (caught) {
      if (
        caught instanceof Error &&
        ["DRAFT_EXPIRED", "DRAFT_INVALID"].includes(caught.message)
      ) {
        setDraftToken(null);
        sessionStorage.removeItem(DRAFT_TOKEN_KEY);
      }
      setStatus(customerErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function removeFile(index: number) {
    if (files.length <= 1 || busy || paymentBusy) return;
    const item = files[index];
    if (!item) return;
    setBusy(true);
    setStatus(`Removing File ${index + 1}…`);
    try {
      if (draftToken && item.fileId) {
        await customerApi.removeFile(draftToken, item.fileId);
      }
      setFiles((current) =>
        current.filter((_, position) => position !== index),
      );
      setSelectedFileIndex((current) =>
        Math.max(
          0,
          Math.min(current > index ? current - 1 : current, files.length - 2),
        ),
      );
      setQuote(null);
      setStatus(
        "PDF removed. File numbers and pricing will update automatically.",
      );
    } catch (caught) {
      setStatus(customerErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function applySettingsToAll() {
    if (!selectedFile) return;
    setFiles((current) =>
      current.map((item) => ({
        ...item,
        pageMode: selectedFile.pageMode,
        customPages: selectedFile.customPages,
        copies: selectedFile.copies,
        paperSize: selectedFile.paperSize,
        colorMode: selectedFile.colorMode,
        sides: selectedFile.sides,
      })),
    );
    setQuote(null);
    setStatus(
      "These settings now apply to every file. You can still override one file.",
    );
  }

  async function verifyCheckoutPayment(
    token: string,
    response: RazorpaySuccessResponse,
  ) {
    setPaymentBusy(true);
    setStatus("Verifying captured payment with the shop server…");
    const pendingKey = `${PENDING_TRACKING_TOKEN_PREFIX}${response.razorpay_order_id}`;
    const trackingToken =
      sessionStorage.getItem(pendingKey) ?? createTrackingToken();
    sessionStorage.setItem(pendingKey, trackingToken);
    try {
      const result = await customerApi.verifyPayment(token, {
        razorpayOrderId: response.razorpay_order_id,
        razorpayPaymentId: response.razorpay_payment_id,
        razorpaySignature: response.razorpay_signature,
        trackingToken,
      });
      setPaymentSuccess(result);
      setStatus(result.message);
      sessionStorage.setItem(
        trackingStorageKey(result.jobCode),
        result.trackingToken,
      );
      sessionStorage.removeItem(pendingKey);
      sessionStorage.removeItem(DRAFT_TOKEN_KEY);
    } catch (caught) {
      setStatus(paymentErrorMessage(caught));
    } finally {
      setPaymentBusy(false);
    }
  }

  async function openCheckout(
    token: string,
    checkout: CustomerPaymentCheckoutData,
  ) {
    await loadRazorpayCheckout();
    if (!window.Razorpay) throw new Error("CHECKOUT_LOAD_FAILED");
    const instance = new window.Razorpay({
      key: checkout.razorpayKeyId,
      order_id: checkout.razorpayOrderId,
      amount: checkout.amountPaise,
      currency: checkout.currency,
      name: checkout.shopName,
      description: checkout.description,
      prefill: {
        name: checkout.customerName,
        contact: checkout.customerPhone,
      },
      handler: (response: RazorpaySuccessResponse) => {
        void verifyCheckoutPayment(token, response);
      },
      modal: {
        ondismiss: () => {
          setPaymentBusy(true);
          setStatus("Recording payment cancellation…");
          void customerApi
            .cancelPayment(token, {
              razorpayOrderId: checkout.razorpayOrderId,
            })
            .then(() => {
              setStatus(
                "Payment was cancelled. Your PDF is retained briefly so you can retry.",
              );
            })
            .catch(() => {
              setStatus(
                "Checkout closed, but cancellation could not be confirmed. Please retry or contact the shop.",
              );
            })
            .finally(() => setPaymentBusy(false));
        },
      },
      theme: { color: "#0e7490" },
    });
    instance.on("payment.failed", () => {
      setPaymentBusy(false);
      setStatus(
        "Payment failed. No print job was created. You can retry payment.",
      );
    });
    instance.open();
  }

  async function pay() {
    if (!quote || !draftToken || paymentBusy || paymentSuccess) return;
    setPaymentBusy(true);
    setStatus("Rechecking the current price and printer readiness…");
    try {
      const result = await customerApi.createPayment(draftToken, {
        acknowledgedTotalPaise: quote.totalAmountPaise,
      });
      if (result.status === "PRICE_CHANGED") {
        setQuote(result.quote);
        setStatus(
          "The price changed. Review the updated total, then press Pay again to acknowledge it.",
        );
        setPaymentBusy(false);
        return;
      }
      setStatus("Opening secure Razorpay checkout…");
      await openCheckout(draftToken, result);
    } catch (caught) {
      setStatus(paymentErrorMessage(caught));
      setPaymentBusy(false);
    }
  }

  function openTracking() {
    if (!paymentSuccess) return;
    sessionStorage.setItem(
      trackingStorageKey(paymentSuccess.jobCode),
      paymentSuccess.trackingToken,
    );
    window.history.pushState(
      null,
      "",
      `/track/${encodeURIComponent(paymentSuccess.jobCode)}#${paymentSuccess.trackingToken}`,
    );
    setTrackingJobCode(paymentSuccess.jobCode);
  }

  async function copyTrackingLink() {
    if (!paymentSuccess) return;
    try {
      await navigator.clipboard.writeText(
        privateTrackingUrl(
          paymentSuccess.jobCode,
          paymentSuccess.trackingToken,
        ),
      );
      setCopyMessage("Private tracking link copied.");
    } catch {
      setCopyMessage("The link could not be copied on this device.");
    }
  }

  const shopHeader = (
    <header className="hero">
      {config?.logoUrl ? (
        <img
          src={resolveCustomerApiUrl(config.logoUrl)}
          alt="Shop logo"
          style={{ maxWidth: 144, maxHeight: 80, objectFit: "contain" }}
        />
      ) : null}
      <h1>{config?.shopName ?? "Online printing"}</h1>
      <p>
        {config?.customerNotice ??
          "Upload a PDF and review your print settings."}
      </p>
    </header>
  );
  if (trackingJobCode)
    return (
      <>
        {shopHeader}
        <TrackingPage jobCode={trackingJobCode} />
      </>
    );

  if (loading)
    return (
      <main className="page-shell">
        <p>Loading PrintGo…</p>
      </main>
    );

  return (
    <main className="page-shell">
      {shopHeader}
      {!busy && !paymentBusy && !quote && !paymentSuccess ? (
        <PwaInstallBanner />
      ) : null}
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
            <h2>PDFs</h2>
            <div className="file-list">
              {files.map((item, index) => (
                <div className="file-sequence" key={item.clientId}>
                  <strong className="file-number">File {index + 1}</strong>
                  <div className="file-card">
                    <button
                      type="button"
                      className="file-card-main"
                      aria-label={`Edit settings for File ${index + 1}, ${item.name}`}
                      onClick={() => setSelectedFileIndex(index)}
                    >
                      <span>{item.name}</span>
                      <small>
                        {item.pageCount} pages · {humanFileSize(item.size)}
                      </small>
                    </button>
                    <button
                      type="button"
                      className="remove-file"
                      aria-label={`Remove File ${index + 1}`}
                      disabled={files.length === 1 || busy || paymentBusy}
                      onClick={() => void removeFile(index)}
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <label className="file-picker">
              <span className="add-file-plus">+</span>
              {files.length === 0 ? "Choose PDF" : "Add another PDF"}
              <input
                aria-label="Choose PDF"
                multiple
                type="file"
                accept="application/pdf,.pdf"
                disabled={files.length >= (config.maxOrderFiles ?? 10)}
                onChange={(event) => {
                  void chooseFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            </label>
            <p className="file-count">
              {files.length} of {config.maxOrderFiles ?? 10} files
            </p>
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
            {selectedFile ? (
              <>
                <label htmlFor="settings-file">Settings for</label>
                <select
                  id="settings-file"
                  value={selectedFileIndex}
                  onChange={(event) =>
                    setSelectedFileIndex(Number(event.target.value))
                  }
                >
                  {files.map((item, index) => (
                    <option key={item.clientId} value={index}>
                      File {index + 1} — {item.name}
                    </option>
                  ))}
                </select>
                <fieldset>
                  <legend>Pages</legend>
                  <label className="inline">
                    <input
                      type="radio"
                      checked={selectedFile.pageMode === "ALL"}
                      onChange={() => patchSelected({ pageMode: "ALL" })}
                    />
                    All pages
                  </label>
                  <label className="inline">
                    <input
                      type="radio"
                      checked={selectedFile.pageMode === "CUSTOM"}
                      onChange={() => patchSelected({ pageMode: "CUSTOM" })}
                    />
                    Custom range
                  </label>
                  {selectedFile.pageMode === "CUSTOM" && (
                    <input
                      aria-label="Custom pages"
                      placeholder="1,3,7-10"
                      value={selectedFile.customPages}
                      onChange={(event) =>
                        patchSelected({ customPages: event.target.value })
                      }
                    />
                  )}
                </fieldset>
                <div className="settings-grid">
                  <label>
                    Copies
                    <input
                      type="number"
                      min={MIN_PRINT_COPIES}
                      max={MAX_PRINT_COPIES}
                      value={selectedFile.copies}
                      onChange={(event) =>
                        patchSelected({ copies: Number(event.target.value) })
                      }
                    />
                  </label>
                  <label>
                    Paper
                    <select
                      value={selectedFile.paperSize}
                      onChange={(event) =>
                        patchSelected({
                          paperSize: event.target.value as "A4" | "A3",
                        })
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
                      value={selectedFile.colorMode}
                      onChange={(event) =>
                        patchSelected({
                          colorMode: event.target.value as "BW" | "COLOR",
                        })
                      }
                    >
                      <option
                        value="BW"
                        disabled={
                          !config.availablePrintOptions.some(
                            (option) =>
                              option.paperSize === selectedFile.paperSize &&
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
                              option.paperSize === selectedFile.paperSize &&
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
                      value={selectedFile.sides}
                      onChange={(event) =>
                        patchSelected({
                          sides: event.target.value as "SINGLE" | "DOUBLE",
                        })
                      }
                    >
                      <option
                        value="SINGLE"
                        disabled={
                          !config.availablePrintOptions.some(
                            (option) =>
                              option.paperSize === selectedFile.paperSize &&
                              option.colorMode === selectedFile.colorMode &&
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
                              option.paperSize === selectedFile.paperSize &&
                              option.colorMode === selectedFile.colorMode &&
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
                <button
                  className="secondary-button"
                  type="button"
                  onClick={applySettingsToAll}
                >
                  Apply these settings to all files
                </button>
              </>
            ) : (
              <p className="muted">Add a PDF to configure print settings.</p>
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
                  <dd>
                    {files.length === 1
                      ? files[0]?.name
                      : files.length === 2
                        ? `${files[0]?.name}, ${files[1]?.name}`
                        : `${files.length} files`}
                  </dd>
                </div>
                {quote.files?.map((quoted, index) => (
                  <div key={quoted.fileId}>
                    <dt>File {index + 1}</dt>
                    <dd>{formatInr(quoted.printingAmountPaise)}</dd>
                  </div>
                ))}
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
            {paymentSuccess && (
              <div className="payment-success" role="status">
                <h3>Payment successful</h3>
                <p>Your Print Code</p>
                <strong>{paymentSuccess.jobCode}</strong>
                <p>Keep this code until you collect your print.</p>
                <p>Amount paid: {formatInr(paymentSuccess.amountPaidPaise)}</p>
                <p className="muted">
                  This reference code is not an authentication token.
                </p>
                <button type="button" onClick={openTracking}>
                  Track My Print
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void copyTrackingLink()}
                >
                  Copy private tracking link
                </button>
                <p className="private-link-warning">
                  Anyone with this link can view this print-job status.
                </p>
                {copyMessage && <p role="status">{copyMessage}</p>}
              </div>
            )}
            <button
              type="submit"
              disabled={
                busy ||
                files.length === 0 ||
                Boolean(fileError) ||
                !optionAvailable ||
                Boolean(paymentSuccess)
              }
            >
              {busy
                ? "Preparing review…"
                : paymentSuccess
                  ? "Payment complete"
                  : quote
                    ? "Refresh review"
                    : draftToken
                      ? "Try upload again"
                      : "Upload PDF and review"}
            </button>
            {quote && !paymentSuccess && (
              <button
                className="pay-button"
                type="button"
                disabled={busy || paymentBusy}
                onClick={() => void pay()}
              >
                {paymentBusy
                  ? "Confirming payment…"
                  : `Pay ${formatInr(quote.totalAmountPaise)}`}
              </button>
            )}
            <p className="muted">
              A job is queued only after the shop server verifies a captured
              payment.
            </p>
          </section>
        </form>
      )}
      <footer
        className="customer-privacy-footer"
        style={{
          marginTop: "2.5rem",
          paddingTop: "1.5rem",
          borderTop: "1px solid #c9dcdf",
          textAlign: "center",
        }}
      >
        <p
          className="muted"
          style={{
            fontSize: "0.85rem",
            maxWidth: "520px",
            margin: "0 auto 0.5rem auto",
            lineHeight: "1.5",
          }}
        >
          🔒 <strong>Privacy &amp; Automatic Cleanup:</strong> Unpaid uploads
          are purged after 10 minutes. Completed print data is purged two hours
          after the entire order finishes.
        </p>
        <p className="muted" style={{ fontSize: "0.8rem", margin: 0 }}>
          Powered by <strong>{config?.appName ?? "PrintGo"}</strong> · Secure
          Single-Shop Printing
        </p>
      </footer>
    </main>
  );
}
