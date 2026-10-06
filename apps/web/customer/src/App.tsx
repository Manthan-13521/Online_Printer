import { applyShopBranding } from "../../branding";
import { useEffect, useMemo, useState, useRef } from "react";

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
import { PublicTrackingPage } from "./PublicTrackingPage";
import { createTrackingToken, trackingStorageKey } from "./tracking-token";

const DRAFT_TOKEN_KEY = "printgo.customerDraftToken";
const PENDING_TRACKING_TOKEN_PREFIX = "printgo.pendingTracking.";
const humanFileSize = (bytes: number) =>
  `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

interface LocalOrderFile {
  clientId: string;
  fileId?: string | undefined;
  file: File | null;
  name: string;
  size: number;
  pageCount: number;
  uploaded: boolean;
  uploadStatus:
    | "SELECTED"
    | "VALIDATING"
    | "UPLOADING"
    | "FINALIZING"
    | "UPLOADED"
    | "FAILED";
  uploadProgress: number;
  uploadError: string | null;
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
  if (
    code === "DRAFT_EXPIRED" ||
    code === "DRAFT_INVALID" ||
    code === "DRAFT_NOT_FOUND"
  )
    return "This upload session expired. Click 'Try upload again' or 'Review Order' to refresh.";
  if (code === "UPLOAD_FILE_REQUIRED")
    return "Please re-select your PDF file to complete the upload.";
  if (code === "UPLOAD_INVALID")
    return "We couldn't read this PDF. Please check the file and try again.";
  if (code === "UPLOAD_ABORTED") return "Upload was cancelled.";
  if (code === "UPLOAD_HTTP_403" || code === "UPLOAD_HTTP_400")
    return "The secure upload link expired or was rejected. Click 'Try upload again' to get a fresh one.";
  if (code === "UPLOAD_NETWORK_ERROR")
    return "The upload was interrupted. Keep the app open and don't switch tabs while uploading. Check connection and try again.";
  if (code === "Failed to fetch")
    return "Could not reach the shop server. Please check your internet connection.";
  if (code && code.length > 0 && !code.startsWith("UPLOAD_")) {
    return code;
  }
  return "The upload could not be completed. Your selections are preserved; please try again.";
}

function paymentErrorMessage(caught: unknown): string {
  const code = caught instanceof Error ? caught.message : "";
  if (
    code &&
    code !== "PRINTER_NOT_READY" &&
    code !== "REQUEST_FAILED" &&
    code !== "Failed to fetch" &&
    code !== "CHECKOUT_LOAD_FAILED" &&
    code !== "PAYMENT_NOT_CAPTURED" &&
    code !== "PAYMENT_SIGNATURE_INVALID" &&
    code !== "PAYMENT_PROVIDER_UNAVAILABLE" &&
    code !== "TRACKING_ACCESS_UNAVAILABLE" &&
    code !== "TRACKING_ACCESS_CONFLICT"
  ) {
    return code;
  }
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
  if (
    code === "TRACKING_ACCESS_UNAVAILABLE" ||
    code === "TRACKING_ACCESS_CONFLICT"
  )
    return "Payment was received, but tracking confirmation encountered an issue. Please contact shop staff with your payment ID.";
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
  const filesRef = useRef(files);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  // Helper to synchronously update ref for async functions and trigger re-render
  const updateFile = (clientId: string, updater: Partial<LocalOrderFile>) => {
    filesRef.current = filesRef.current.map((f) =>
      f.clientId === clientId ? { ...f, ...updater } : f,
    );
    setFiles(filesRef.current);
  };

  const abortControllers = useRef(new Map<string, AbortController>());
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [status, setStatus] = useState<string | null>(null);
  const [quote, setQuote] = useState<CustomerQuoteData | null>(null);
  const [draftToken, setDraftToken] = useState<string | null>(null);
  const [paymentBusy, setPaymentBusy] = useState(false);
  const [paymentSuccess, setPaymentSuccess] =
    useState<CustomerPaymentSuccessData | null>(null);
  const [selectedAddonIds, setSelectedAddonIds] = useState<string[]>([]);
  const [isPriority, setIsPriority] = useState(false);
  const [trackBoxCode, setTrackBoxCode] = useState("");
  const [showPricing, setShowPricing] = useState(false);
  const [showInfo, setShowInfo] = useState(false);

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
            uploadStatus:
              remote.uploadStatus === "UPLOADED" ? "UPLOADED" : "FAILED",
            uploadProgress: remote.uploadStatus === "UPLOADED" ? 100 : 0,
            uploadError:
              remote.uploadStatus === "UPLOADED"
                ? null
                : "Upload was interrupted",
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
          uploadStatus: "SELECTED",
          uploadProgress: 0,
          uploadError: null,
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

  async function prepareReview(event?: React.FormEvent) {
    if (event) event.preventDefault();
    if (busy) return;
    if (!config?.onlinePrintingEnabled) {
      setStatus("Online printing is currently unavailable at this shop.");
      return;
    }
    if (files.length === 0) {
      setStatus("Please add at least one PDF file to print.");
      return;
    }
    if (fileError) return;
    if (!optionAvailable) {
      setStatus(
        "That print combination is not currently available. Please adjust your print settings.",
      );
      return;
    }
    if (!customerName.trim() || !customerPhone.trim()) {
      setStatus(
        "Please enter your name and phone number before reviewing your order.",
      );
      return;
    }
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
    let errorToReport: Error | null = null;
    try {
      let token = draftToken;

      for (let index = 0; index < filesRef.current.length; index++) {
        const clientId = filesRef.current[index]?.clientId;
        if (!clientId) continue;

        const item = filesRef.current.find((f) => f.clientId === clientId);
        if (!item || item.uploadStatus === "UPLOADED") continue;
        if (!item.file) throw new Error("UPLOAD_FILE_REQUIRED");

        const uploadFile = item.file;
        let upload;

        updateFile(clientId, {
          uploadStatus: "VALIDATING",
          uploadProgress: 0,
          uploadError: null,
        });

        let uploadAttempt = 0;
        while (uploadAttempt < 2) {
          uploadAttempt++;
          try {
            if (!token) {
              const draft = await customerApi.createDraft({
                customerName: customerName.trim(),
                customerPhone: customerPhone.trim(),
                instructions: instructions.trim() || null,
                originalFilename: item.name,
                expectedSizeBytes: item.size,
                sourcePageCount: item.pageCount,
                ...(selectedAddonIds.length > 0
                  ? { addonServiceIds: selectedAddonIds }
                  : {}),
              });
              token = draft.draftToken;
              upload = draft.upload;
              if (draft.fileId) updateFile(clientId, { fileId: draft.fileId });
              setDraftToken(token);
              sessionStorage.setItem(DRAFT_TOKEN_KEY, token);
            } else if (!item.fileId) {
              const created = await customerApi.addFile(token, {
                originalFilename: item.name,
                expectedSizeBytes: item.size,
                sourcePageCount: item.pageCount,
              });
              upload = created.upload;
              if (created.fileId)
                updateFile(clientId, { fileId: created.fileId });
            } else {
              upload = (await customerApi.authorize(token, item.fileId)).upload;
            }
            break;
          } catch (authErr) {
            const msg = authErr instanceof Error ? authErr.message : "";
            if (
              uploadAttempt === 1 &&
              (msg.includes("DRAFT") ||
                msg.includes("UPLOAD_NOT_FOUND") ||
                msg.includes("401") ||
                msg.includes("410"))
            ) {
              token = null;
              setDraftToken(null);
              sessionStorage.removeItem(DRAFT_TOKEN_KEY);
              filesRef.current.forEach((f) => {
                if (f.uploadStatus !== "UPLOADED") {
                  updateFile(f.clientId, { fileId: undefined });
                }
              });
              continue;
            }
            throw authErr;
          }
        }

        if (!filesRef.current.find((f) => f.clientId === clientId)) continue;

        updateFile(clientId, { uploadStatus: "UPLOADING" });
        setStatus(`Uploading File ${index + 1} of ${filesRef.current.length}…`);

        const controller = new AbortController();
        abortControllers.current.set(clientId, controller);

        if (!upload) throw new Error("UPLOAD_FAILED");
        try {
          await uploadDirectly(
            uploadFile,
            upload.uploadUrl,
            upload.requiredHeaders,
            (p) => updateFile(clientId, { uploadProgress: p }),
            controller.signal,
          );

          abortControllers.current.delete(clientId);

          if (!filesRef.current.find((f) => f.clientId === clientId)) continue;

          updateFile(clientId, { uploadStatus: "FINALIZING" });
          setStatus(`Verifying File ${index + 1}…`);

          const latestItem = filesRef.current.find(
            (f) => f.clientId === clientId,
          );
          await customerApi.complete(token!, latestItem?.fileId || "");

          updateFile(clientId, {
            uploaded: true,
            uploadStatus: "UPLOADED",
            uploadProgress: 100,
          });
        } catch (caught) {
          if (caught instanceof Error && caught.message === "UPLOAD_ABORTED") {
            continue;
          }
          const errMsg = customerErrorMessage(caught);
          updateFile(clientId, { uploadStatus: "FAILED", uploadError: errMsg });
          errorToReport =
            caught instanceof Error ? caught : new Error(String(caught));
          break;
        }
      }

      if (errorToReport) throw errorToReport;

      const allUploaded = filesRef.current.every(
        (f) => f.uploadStatus === "UPLOADED",
      );
      if (!allUploaded || filesRef.current.length === 0) {
        setBusy(false);
        return; // User removed a file or something else failed
      }

      if (!token) throw new Error("DRAFT_INVALID");
      setStatus("Calculating your review total…");
      setQuote(
        await customerApi.quoteOrder(token, {
          files: filesRef.current.map((f) => ({
            fileId: f.fileId!,
            selectedPages:
              f.pageMode === "ALL" ? `1-${f.pageCount}` : f.customPages,
            copies: f.copies,
            paperSize: f.paperSize,
            colorMode: f.colorMode,
            sides: f.sides,
          })),
          isPriority,
        }),
      );
      setPaymentSuccess(null);
      setStatus(
        "Review ready. Confirm the total to continue to secure payment.",
      );
    } catch (caught) {
      if (
        caught instanceof Error &&
        (caught.message.includes("DRAFT") ||
          ["DRAFT_EXPIRED", "DRAFT_INVALID", "DRAFT_NOT_FOUND"].includes(
            caught.message,
          ))
      ) {
        setDraftToken(null);
        sessionStorage.removeItem(DRAFT_TOKEN_KEY);
      }
      setStatus(customerErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function removeFile(index: number) {
    if (paymentBusy) return;
    const item = files[index];
    if (!item) return;

    // Abort if uploading
    const controller = abortControllers.current.get(item.clientId);
    if (controller) {
      controller.abort();
      abortControllers.current.delete(item.clientId);
    }

    // Do not set global busy if we just want to remove a file while other things are uploading.
    // If it's a drafted file, delete it in the background to not block UI.
    if (draftToken && item.fileId) {
      void customerApi.removeFile(draftToken, item.fileId).catch(() => {});
    }

    setFiles((current) => current.filter((_, position) => position !== index));
    setSelectedFileIndex((current) =>
      Math.max(
        0,
        Math.min(current > index ? current - 1 : current, files.length - 2),
      ),
    );
    setQuote(null);
    setStatus("PDF removed.");
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

  async function togglePriority(nextPriority: boolean) {
    setIsPriority(nextPriority);
    if (
      draftToken &&
      files.length > 0 &&
      files.every((f) => f.uploaded && f.fileId)
    ) {
      setBusy(true);
      setStatus("Updating priority review…");
      try {
        setQuote(
          await customerApi.quoteOrder(draftToken, {
            files: files.map((item) => ({
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
            isPriority: nextPriority,
          }),
        );
        setStatus("Priority updated. Review your new total.");
      } catch (caught) {
        setStatus(customerErrorMessage(caught));
      } finally {
        setBusy(false);
      }
    } else {
      setQuote(null);
    }
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

      // Auto-navigate to tracking page
      const code = result.pickupCode ?? result.jobCode;
      window.history.pushState(null, "", `/track/${encodeURIComponent(code)}`);
      setTrackingJobCode(code);
    } catch (caught) {
      setStatus(paymentErrorMessage(caught));
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
      theme: { color: "#16754A" },
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

  const shopHeader = (
    <header className="hero">
      <div className="hero-top-row">
        <div className="hero-branding">
          {config?.logoUrl ? (
            <img
              src={resolveCustomerApiUrl(config.logoUrl)}
              alt="Shop logo"
              style={{ maxWidth: 144, maxHeight: 80, objectFit: "contain" }}
            />
          ) : (
            <h1 className="logo-text">
              {config?.shopName ?? "Online printing"}
            </h1>
          )}
        </div>

        <form
          className="track-printing-form"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = trackBoxCode.trim().toUpperCase();
            if (trimmed) {
              window.history.pushState(
                null,
                "",
                `/track/${encodeURIComponent(trimmed)}`,
              );
              setTrackingJobCode(trimmed);
            }
          }}
        >
          <div className="track-input-wrapper">
            <span className="track-icon">📦</span>
            <input
              placeholder="Track your order (e.g. PA-001)"
              value={trackBoxCode}
              onChange={(e) => setTrackBoxCode(e.target.value)}
            />
            <button type="submit" className="track-button">
              Track
            </button>
          </div>
        </form>

        <div className="hero-actions">
          <button
            type="button"
            className="pricing-info-button"
            onClick={() => setShowPricing(true)}
          >
            ⓘ Pricing & Info
          </button>
        </div>
      </div>

      <div className="hero-content">
        <div className="hero-text">
          <h1 className="hero-title">Upload & Print Instantly</h1>
          <p className="hero-subtitle">
            Upload your PDF files and get high-quality prints without any manual
            interference.
          </p>
        </div>
        <div className="hero-decoration">
          <div className="decoration-text">
            Your files,
            <br />
            our print magic!
          </div>
        </div>
      </div>
    </header>
  );
  if (trackingJobCode) {
    const isPickupPattern = /^[A-Za-z]{2}-\d{3}$/i.test(trackingJobCode);
    const hasPrivateToken =
      typeof window !== "undefined" &&
      (/^[A-Za-z0-9_-]{43}$/.test(window.location.hash.slice(1)) ||
        Boolean(sessionStorage.getItem(`printgo.tracking.${trackingJobCode}`)));

    if (isPickupPattern || !hasPrivateToken) {
      return (
        <>
          {shopHeader}
          <PublicTrackingPage
            pickupCode={trackingJobCode}
            onBack={() => {
              setTrackingJobCode(null);
              window.history.pushState(null, "", "/");
            }}
          />
        </>
      );
    }

    const handleResetToHome = () => {
      setTrackingJobCode(null);
      setFiles([]);
      setSelectedFileIndex(0);
      setQuote(null);
      setDraftToken(null);
      setPaymentSuccess(null);
      window.history.pushState(null, "", "/");
    };

    return (
      <>
        {shopHeader}
        <TrackingPage jobCode={trackingJobCode} onBack={handleResetToHome} />
      </>
    );
  }

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
      {showPricing && config ? (
        <div
          className="pricing-modal-backdrop"
          onClick={() => setShowPricing(false)}
        >
          <div
            className="pricing-modal-content"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pricing-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="pricing-modal-header">
              <h2 id="pricing-modal-title">Pricing &amp; Rates</h2>
              <button
                type="button"
                className="close-button"
                aria-label="Close"
                onClick={() => setShowPricing(false)}
              >
                &times;
              </button>
            </div>

            {config.availablePrintOptions &&
            config.availablePrintOptions.length > 0 ? (
              <section className="pricing-info-section">
                <h3>Printing Rates</h3>
                <table className="pricing-table">
                  <thead>
                    <tr>
                      <th>Option</th>
                      <th>Sides</th>
                      <th>Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {config.availablePrintOptions.map((opt) => (
                      <tr
                        key={`${opt.paperSize}-${opt.colorMode}-${opt.sides}`}
                      >
                        <td>
                          {opt.paperSize}{" "}
                          {opt.colorMode === "BW" ? "B&W" : "Colour"}
                        </td>
                        <td>
                          {opt.sides === "SINGLE"
                            ? "Single-sided"
                            : "Double-sided"}
                        </td>
                        <td>
                          {opt.pricePerPagePaise !== undefined
                            ? `₹${(opt.pricePerPagePaise / 100).toFixed(2)} / page`
                            : "Standard"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ) : null}

            {config.addonServices && config.addonServices.length > 0 ? (
              <section className="pricing-info-section">
                <h3>Add-on Services</h3>
                <ul className="pricing-addon-list">
                  {config.addonServices.map((svc) => (
                    <li key={svc.id}>
                      <strong>{svc.name}</strong>
                      <span>
                        {svc.pricingType === "STAFF_PRICED"
                          ? "Price decided by staff"
                          : svc.fixedPricePaise === 0
                            ? "FREE"
                            : `₹${(svc.fixedPricePaise / 100).toFixed(2)}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {config.priorityPrinting?.enabled ? (
              <section className="pricing-info-section">
                <h3>Priority Printing</h3>
                <p>
                  ⚡ Fast-track your print in the queue for an additional{" "}
                  <strong>
                    ₹{(config.priorityPrinting.feePaise / 100).toFixed(2)}
                  </strong>
                  .
                </p>
              </section>
            ) : null}

            {config.discountRules && config.discountRules.length > 0 ? (
              <section className="pricing-info-section">
                <h3>Volume Discounts</h3>
                <ul className="pricing-addon-list">
                  {config.discountRules.map((rule) => (
                    <li key={rule.id}>
                      <span>
                        Orders above ₹{(rule.minSubtotalPaise / 100).toFixed(0)}
                      </span>
                      <strong style={{ color: "#16754A" }}>
                        {rule.discountPercent}% OFF
                      </strong>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <div className="pricing-modal-footer">
              <button
                type="button"
                className="primary-button fit"
                onClick={() => setShowPricing(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {showInfo && config ? (
        <div
          className="pricing-modal-backdrop"
          onClick={() => setShowInfo(false)}
        >
          <div
            className="pricing-modal-content"
            role="dialog"
            aria-modal="true"
            aria-labelledby="info-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="pricing-modal-header">
              <h2 id="info-modal-title">Shop Information</h2>
              <button
                type="button"
                className="close-button"
                aria-label="Close"
                onClick={() => setShowInfo(false)}
              >
                &times;
              </button>
            </div>

            <div className="pricing-info-notice">
              <p>
                Most standard orders are automatically sent to the printer after
                successful payment. Orders requiring special/manual services are
                handled by shop staff and kept ready for collection.
              </p>
            </div>

            {config.customerNotice ? (
              <section className="pricing-info-section">
                <h3>Notice</h3>
                <p>{config.customerNotice}</p>
              </section>
            ) : null}

            {config.shopName || config.contactPhone || config.address ? (
              <section className="pricing-info-section">
                <h3>Shop Details</h3>
                <p>
                  <strong>{config.shopName}</strong>
                </p>
                {config.address ? <p>{config.address}</p> : null}
                {config.contactPhone ? (
                  <p>
                    Phone:{" "}
                    <a href={`tel:${config.contactPhone}`}>
                      {config.contactPhone}
                    </a>
                  </p>
                ) : null}
              </section>
            ) : null}

            <div className="pricing-modal-footer">
              <button
                type="button"
                className="primary-button fit"
                onClick={() => setShowInfo(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
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
        <form
          className="order-layout"
          onSubmit={(event) => void prepareReview(event)}
        >
          <div className="order-left">
            <section className="step">
              <div className="step-header">
                <span className="step-number">1</span>
                <h2>Customer Details</h2>
                <p className="step-desc">
                  Tell us a bit about yourself to get started.
                </p>
              </div>
              <div className="details-grid">
                <label>
                  Name
                  <div className="input-with-icon">
                    <span className="icon">👤</span>
                    <input
                      required
                      maxLength={120}
                      aria-label="Name"
                      value={customerName}
                      onChange={(event) => setCustomerName(event.target.value)}
                    />
                  </div>
                </label>
                <label>
                  Phone
                  <div className="input-with-icon">
                    <span className="icon">📞</span>
                    <input
                      required
                      maxLength={30}
                      aria-label="Phone"
                      inputMode="tel"
                      value={customerPhone}
                      onChange={(event) => setCustomerPhone(event.target.value)}
                    />
                  </div>
                </label>
              </div>
              {config?.addonServices && config.addonServices.length > 0 ? (
                <div className="addon-selection-group">
                  <span className="addon-group-label">Add-on Services</span>
                  <div className="addon-checkbox-list">
                    {config.addonServices.map((service) => {
                      const isSelected = selectedAddonIds.includes(service.id);
                      return (
                        <label
                          key={service.id}
                          className={`addon-checkbox-item ${isSelected ? "selected" : ""}`}
                        >
                          <div className="addon-info">
                            <span className="addon-icon">
                              {service.name.toLowerCase().includes("bind")
                                ? "📖"
                                : service.name.toLowerCase().includes("staple")
                                  ? "📎"
                                  : "📄"}
                            </span>
                            <div>
                              <span className="addon-name">{service.name}</span>
                              <span className="addon-price-tag">
                                {service.pricingType === "STAFF_PRICED"
                                  ? "Price decided by staff"
                                  : service.fixedPricePaise === 0
                                    ? "FREE"
                                    : `+₹${(service.fixedPricePaise / 100).toFixed(2)}`}
                              </span>
                            </div>
                          </div>
                          <input
                            type="checkbox"
                            checked={isSelected}
                            disabled={
                              busy || paymentBusy || Boolean(draftToken)
                            }
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedAddonIds([
                                  ...selectedAddonIds,
                                  service.id,
                                ]);
                              } else {
                                setSelectedAddonIds(
                                  selectedAddonIds.filter(
                                    (id) => id !== service.id,
                                  ),
                                );
                              }
                            }}
                          />
                        </label>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              <label htmlFor="customer-inst">Instructions (optional)</label>
              <div className="input-with-icon textarea">
                <span className="icon">📝</span>
                <textarea
                  placeholder="Any special instructions for your print job..."
                  maxLength={500}
                  aria-label="Instructions"
                  id="customer-inst"
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                />
              </div>
              <div className="char-count">{instructions.length}/500</div>
            </section>

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
                      <select
                        id="settings-file"
                        value={selectedFileIndex}
                        onChange={(event) =>
                          setSelectedFileIndex(Number(event.target.value))
                        }
                      >
                        {files.map((item, index) => (
                          <option key={item.clientId} value={index}>
                            File {index + 1} — {item.name} ({item.pageCount}{" "}
                            pages)
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="print-settings-grid">
                    <div className="print-setting-col">
                      <label style={{ margin: 0, fontWeight: 600 }}>
                        Pages
                      </label>
                      <div className="visual-options horizontal">
                        <label
                          className={`visual-option-card ${selectedFile.pageMode === "ALL" ? "selected" : ""}`}
                        >
                          <input
                            type="radio"
                            checked={selectedFile.pageMode === "ALL"}
                            onChange={() => patchSelected({ pageMode: "ALL" })}
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
                            onChange={() =>
                              patchSelected({ pageMode: "CUSTOM" })
                            }
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
                            patchSelected({ customPages: event.target.value })
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
                            aria-label="Decrease copies"
                            onClick={() =>
                              patchSelected({
                                copies: Math.max(
                                  MIN_PRINT_COPIES,
                                  selectedFile.copies - 1,
                                ),
                              })
                            }
                          >
                            −
                          </button>
                          <input
                            id="copies-input"
                            aria-label="Copies"
                            type="number"
                            min={MIN_PRINT_COPIES}
                            max={MAX_PRINT_COPIES}
                            value={selectedFile.copies}
                            onChange={(event) =>
                              patchSelected({
                                copies: Number(event.target.value),
                              })
                            }
                          />
                          <button
                            type="button"
                            aria-label="Increase copies"
                            onClick={() =>
                              patchSelected({
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
                          <select
                            id="paper-size"
                            value={selectedFile.paperSize}
                            onChange={(event) =>
                              patchSelected({
                                paperSize: event.target.value as PaperSize,
                              })
                            }
                          >
                            {config.availablePrintOptions
                              .filter(
                                (v, i, a) =>
                                  a.findIndex(
                                    (t) => t.paperSize === v.paperSize,
                                  ) === i,
                              )
                              .map((o) => (
                                <option key={o.paperSize} value={o.paperSize}>
                                  {o.paperSize}
                                </option>
                              ))}
                          </select>
                        </div>
                      </div>
                    </div>

                    <div className="print-setting-col">
                      <label style={{ margin: 0 }}>Colour</label>
                      <div className="visual-options horizontal">
                        <label
                          className={`visual-option-card ${selectedFile.colorMode === "BW" ? "selected" : ""} ${!config.availablePrintOptions.some((o) => o.paperSize === selectedFile.paperSize && o.colorMode === "BW") ? "disabled" : ""}`}
                        >
                          <input
                            type="radio"
                            name="colorMode"
                            value="BW"
                            checked={selectedFile.colorMode === "BW"}
                            disabled={
                              !config.availablePrintOptions.some(
                                (o) =>
                                  o.paperSize === selectedFile.paperSize &&
                                  o.colorMode === "BW",
                              )
                            }
                            onChange={() => patchSelected({ colorMode: "BW" })}
                          />
                          <span className="card-icon bw-icon"></span>
                          <span className="label">Black & white</span>
                          <span className="radio-circle"></span>
                        </label>
                        <label
                          className={`visual-option-card ${selectedFile.colorMode === "COLOR" ? "selected" : ""} ${!config.availablePrintOptions.some((o) => o.paperSize === selectedFile.paperSize && o.colorMode === "COLOR") ? "disabled" : ""}`}
                        >
                          <input
                            type="radio"
                            name="colorMode"
                            value="COLOR"
                            checked={selectedFile.colorMode === "COLOR"}
                            disabled={
                              !config.availablePrintOptions.some(
                                (o) =>
                                  o.paperSize === selectedFile.paperSize &&
                                  o.colorMode === "COLOR",
                              )
                            }
                            onChange={() =>
                              patchSelected({ colorMode: "COLOR" })
                            }
                          />
                          <span className="card-icon color-icon"></span>
                          <span className="label">Colour</span>
                          <span className="radio-circle"></span>
                        </label>
                      </div>
                    </div>

                    <div className="print-setting-col">
                      <label style={{ margin: 0 }}>Sides</label>
                      <div className="visual-options horizontal">
                        <label
                          className={`visual-option-card ${selectedFile.sides === "SINGLE" ? "selected" : ""} ${!config.availablePrintOptions.some((o) => o.paperSize === selectedFile.paperSize && o.colorMode === selectedFile.colorMode && o.sides === "SINGLE") ? "disabled" : ""}`}
                        >
                          <input
                            type="radio"
                            name="sides"
                            value="SINGLE"
                            checked={selectedFile.sides === "SINGLE"}
                            disabled={
                              !config.availablePrintOptions.some(
                                (o) =>
                                  o.paperSize === selectedFile.paperSize &&
                                  o.colorMode === selectedFile.colorMode &&
                                  o.sides === "SINGLE",
                              )
                            }
                            onChange={() => patchSelected({ sides: "SINGLE" })}
                          />
                          <span className="card-icon single-side-icon">📄</span>
                          <span className="label">Single-sided</span>
                          <span className="radio-circle"></span>
                        </label>
                        <label
                          className={`visual-option-card ${selectedFile.sides === "DOUBLE" ? "selected" : ""} ${!config.availablePrintOptions.some((o) => o.paperSize === selectedFile.paperSize && o.colorMode === selectedFile.colorMode && o.sides === "DOUBLE") ? "disabled" : ""}`}
                        >
                          <input
                            type="radio"
                            name="sides"
                            value="DOUBLE"
                            checked={selectedFile.sides === "DOUBLE"}
                            disabled={
                              !config.availablePrintOptions.some(
                                (o) =>
                                  o.paperSize === selectedFile.paperSize &&
                                  o.colorMode === selectedFile.colorMode &&
                                  o.sides === "DOUBLE",
                              )
                            }
                            onChange={() => patchSelected({ sides: "DOUBLE" })}
                          />
                          <span className="card-icon double-side-icon">📑</span>
                          <span className="label">Double-sided</span>
                          <span className="radio-circle"></span>
                        </label>
                      </div>
                    </div>
                  </div>
                  {!optionAvailable && (
                    <p className="error">
                      That print combination is not currently available.
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={applySettingsToAll}
                    className="apply-all-btn"
                  >
                    ⚡ Apply these settings to all files
                  </button>
                </>
              ) : (
                <p className="muted">Add a PDF to configure print settings.</p>
              )}
            </section>
          </div>

          <div className="order-right">
            <section className="step">
              <div className="step-header">
                <span className="step-number">2</span>
                <h2>Upload PDFs</h2>
                <p className="step-desc">
                  Upload one or more PDF files. Your printer will print them
                  instantly.
                </p>
              </div>
              <div className="file-list">
                {files.map((item, index) => (
                  <div
                    key={item.clientId}
                    className={`file-card-compact ${selectedFileIndex === index ? "active" : ""}`}
                    onClick={() => setSelectedFileIndex(index)}
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
                          <span
                            style={{ fontSize: "0.75rem", color: "#64748b" }}
                          >
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
                          removeFile(index);
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
                  <div className="drop-subtitle">
                    Choose files or drag and drop
                  </div>
                  <div className="choose-btn">Choose Files</div>
                  <input
                    type="file"
                    aria-label="Choose Files"
                    accept="application/pdf"
                    multiple
                    disabled={busy || paymentBusy || Boolean(draftToken)}

                    onChange={(event) => {
                      if (!event.target.files?.length) return;
                      void chooseFiles(event.target.files);
                      event.target.value = "";
                    }}
                  />
                </label>
              )}

              <div className="upload-footer">
                <span className="file-count">
                  {files.length} of {config.maxOrderFiles ?? 10} files | Maximum{" "}
                  {config ? humanFileSize(config.maxPdfSizeBytes) : "20.0 MB"}{" "}
                  per file.
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

            <section className="step review">
              <div className="step-header">
                <span className="step-number">4</span>
                <h2>Review & Payment</h2>
                <p className="step-desc">
                  Review your order details and pay securely to continue.
                </p>
              </div>

              {status && (
                <p
                  role="status"
                  className="status-message"
                  style={{
                    margin: "0 0 1rem",
                    padding: "0.75rem",
                    background: "#f8fafc",
                    borderRadius: "8px",
                    border: "1px solid #cbd5e1",
                  }}
                >
                  {status}
                </p>
              )}

              {!quote && (
                <button
                  type="submit"
                  className="pay-button"
                  style={{
                    width: "100%",
                    marginBottom: "1.5rem",
                    padding: "1rem",
                    fontSize: "1.1rem",
                  }}
                  disabled={busy || files.length === 0}
                  onClick={(e) => {
                    if (!busy) void prepareReview(e);
                  }}
                >
                  {busy
                    ? "Calculating..."
                    : files.some((f) => f.uploadStatus === "FAILED")
                      ? "Try upload again"
                      : "Review Order"}
                </button>
              )}

              {config?.priorityPrinting?.enabled ? (
                <div
                  className={`priority-selector ${isPriority ? "active" : ""}`}
                >
                  <div className="priority-content">
                    <span className="priority-icon">⚡</span>
                    <div className="priority-text">
                      <label>
                        Priority Printing (+
                        {formatInr(config.priorityPrinting.feePaise)})
                      </label>
                      <p>Fast-track your job in the print queue.</p>
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={isPriority}
                    disabled={busy || paymentBusy}
                    onChange={(e) => void togglePriority(e.target.checked)}
                    className="priority-checkbox"
                  />
                </div>
              ) : null}

              {quote && (
                <div className="review-summary">
                  <div className="summary-section">
                    <div className="summary-box">
                      <div className="summary-label">Customer Details</div>
                      <div className="summary-val">
                        <span className="icon">👤</span> {customerName || "—"}
                      </div>
                      <div className="summary-val">
                        <span className="icon">📞</span> {customerPhone || "—"}
                      </div>
                    </div>
                    <div className="summary-box">
                      <div className="summary-label">
                        Files ({files.length})
                      </div>
                      <div className="summary-files">
                        {files.map((f) => (
                          <div key={f.clientId} className="summary-file-row">
                            <span className="pdf-icon-small">PDF</span>
                            <div className="summary-file-info">
                              <span className="name" title={f.name}>
                                {f.name.length > 25
                                  ? f.name.substring(0, 25) + "..."
                                  : f.name}
                              </span>
                              <span className="meta">
                                {f.pageCount} pages · {humanFileSize(f.size)}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="summary-order">
                    <div className="summary-label">Order Summary</div>
                    {quote.files?.map((quoted, index) => (
                      <div className="summary-row" key={quoted.fileId}>
                        <span>File {index + 1}</span>
                        <span>{formatInr(quoted.printingAmountPaise)}</span>
                      </div>
                    ))}
                    <div className="summary-row">
                      <span>Printing</span>
                      <span>{formatInr(quote.printingAmountPaise)}</span>
                    </div>
                    {quote.serviceChargePaise ? (
                      <div className="summary-row">
                        <span>File service</span>
                        <span>{formatInr(quote.serviceChargePaise)}</span>
                      </div>
                    ) : null}
                    {quote.addonServices && quote.addonServices.length > 0
                      ? quote.addonServices.map((s) => (
                          <div className="summary-row" key={s.serviceId}>
                            <span>{s.serviceName}</span>
                            <span>
                              {s.pricingType === "STAFF_PRICED"
                                ? "TBD"
                                : s.onlinePricePaise === 0
                                  ? "FREE"
                                  : formatInr(s.onlinePricePaise)}
                            </span>
                          </div>
                        ))
                      : null}
                    {quote.priorityFeePaise && quote.priorityFeePaise > 0 ? (
                      <div className="summary-row">
                        <span>Priority queue</span>
                        <span>{formatInr(quote.priorityFeePaise)}</span>
                      </div>
                    ) : null}
                    {quote.discountAmountPaise &&
                    quote.discountAmountPaise > 0 ? (
                      <div className="summary-row discount">
                        <span>
                          Discount ({quote.appliedDiscount?.discountPercent}%
                          off)
                        </span>
                        <span>-{formatInr(quote.discountAmountPaise)}</span>
                      </div>
                    ) : null}
                  </div>

                  <div className="total-box">
                    <div className="total-label">Total Amount</div>
                    <div className="total-value">
                      {formatInr(quote.totalAmountPaise)}
                    </div>

                    {quote.addonServices?.some(
                      (s) => s.pricingType === "STAFF_PRICED",
                    ) && (
                      <div className="staff-price-warning">
                        Note: Staff-priced items will be paid at the counter.
                      </div>
                    )}

                    {draftToken && (
                      <button
                        type="button"
                        className="pay-button"
                        onClick={() => void pay()}
                        disabled={
                          paymentBusy || busy || Boolean(paymentSuccess)
                        }
                      >
                        {paymentBusy
                          ? "Confirming payment…"
                          : `🔒 Pay ${formatInr(quote.totalAmountPaise)}`}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </section>
          </div>
        </form>
      )}
      <footer
        className="customer-privacy-footer"
        style={{
          marginTop: "2.5rem",
          paddingTop: "1.5rem",
          borderTop: "1px solid #E1E5E2",
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
