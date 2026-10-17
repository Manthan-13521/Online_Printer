import { applyShopBranding } from "./utils/branding";
import {
  CustomerDetailsStep,
  CustomerPrivacyFooter,
  OrderReviewSummary,
  PricingModal,
  PrintSettingsStep,
  ShopHeader,
  ShopInfoModal,
  ShopUnavailableState,
  UploadPdfsStep,
  FloatingLoadingIndicator,
  customerErrorMessage,
  humanFileSize,
  isValidPhone,
  paymentErrorMessage,
  type LocalOrderFile,
} from "./components";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
  lazy,
  Suspense,
} from "react";

import type {
  CustomerConfigData,
  CustomerPaymentCheckoutData,
  CustomerPaymentSuccessData,
  CustomerQuoteData,
} from "@printgo/api-contract";
import { parsePageRange } from "@printgo/domain";
import { formatInr } from "@printgo/pricing";

import { customerApi, uploadDirectly } from "./api";
import { inspectPdf } from "./pdf";
import { PwaInstallBanner } from "./PwaInstallBanner";
import { createTrackingToken, trackingStorageKey } from "./tracking-token";

const TrackingPage = lazy(() =>
  import("./TrackingPage").then((m) => ({ default: m.TrackingPage })),
);
const PublicTrackingPage = lazy(() =>
  import("./PublicTrackingPage").then((m) => ({
    default: m.PublicTrackingPage,
  })),
);
const CashWaitingPage = lazy(() =>
  import("./CashWaitingPage").then((m) => ({ default: m.CashWaitingPage })),
);

const DRAFT_TOKEN_KEY = "printgo.customerDraftToken";
const PENDING_TRACKING_TOKEN_PREFIX = "printgo.pendingTracking.";

const SERVER_CONFIRMED_PAID_STATUSES = new Set([
  "PAID",
  "QUEUED",
  "CLAIMED",
  "SPOOLING",
  "PRINTING",
  "PRINT_BLOCKED",
  "PRINT_FAILED",
  "RETRY_PENDING",
  "NEEDS_ADMIN",
  "COMPLETION_UNKNOWN",
  "ADMIN_ACTION_REQUIRED",
  "PRINTED",
  "MANUAL_PRINT",
  "AWAITING_FINISHING",
  "COMPLETED",
]);

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
  const [cashWaitingData, setCashWaitingData] = useState<{
    orderId: string;
    publicJobCode: string | null;
    payableAmountPaise: number;
    cashExpiresAtMs: number;
    cashGraceUntilMs: number;
  } | null>(null);
  const [cashSelecting, setCashSelecting] = useState(false);
  const [selectedAddonIds, setSelectedAddonIds] = useState<string[]>([]);
  const [isPriority, setIsPriority] = useState(false);
  const [trackBoxCode, setTrackBoxCode] = useState("");
  const [showPricing, setShowPricing] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [isInspectingFiles, setIsInspectingFiles] = useState(false);
  const [paymentPhase, setPaymentPhase] = useState<
    "IDLE" | "CHECKING_AVAILABILITY" | "FINDING_PRINTER" | "PREPARING_PAYMENT"
  >("IDLE");
  const [pendingPaymentRecovery, setPendingPaymentRecovery] = useState<{
    token: string;
    response?: RazorpaySuccessResponse;
  } | null>(null);

  const loadShopConfig = useCallback(() => {
    setLoading(true);
    setConfigError(null);
    customerApi
      .config()
      .then((loaded) => {
        setConfig(loaded);
        setConfigError(null);
      })
      .catch((caught: unknown) => {
        const msg =
          caught instanceof Error && caught.message === "Failed to fetch"
            ? "Could not connect to the shop. Please check your internet connection."
            : "Shop configuration could not be loaded. Please retry.";
        setConfigError(msg);
        setStatus(msg);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadShopConfig();
  }, [loadShopConfig]);

  useEffect(() => {
    const handlePopState = () => setTrackingJobCode(trackingCodeFromPath());
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (config?.appName || config?.shopName)
      return applyShopBranding(config.appName ?? config.shopName);
    return undefined;
  }, [config?.appName, config?.shopName]);

  useEffect(() => {
    if (!config || draftToken) return;
    const savedToken = sessionStorage.getItem(DRAFT_TOKEN_KEY);
    if (!savedToken) return;
    void customerApi
      .getDraft(savedToken)
      ?.then((draft) => {
        // 1. If server confirms order is paid/queued/completed, navigate to tracking
        if (
          SERVER_CONFIRMED_PAID_STATUSES.has(draft.status) &&
          draft.publicJobCode
        ) {
          const code = draft.publicJobCode;
          sessionStorage.removeItem(DRAFT_TOKEN_KEY);
          // Preserve tracking authorization by linking any pending tracking token from this checkout session
          if (typeof sessionStorage !== "undefined") {
            for (let i = 0; i < sessionStorage.length; i++) {
              const key = sessionStorage.key(i);
              if (key && key.startsWith(PENDING_TRACKING_TOKEN_PREFIX)) {
                const pendingToken = sessionStorage.getItem(key);
                if (pendingToken && /^[A-Za-z0-9_-]{43}$/u.test(pendingToken)) {
                  sessionStorage.setItem(
                    trackingStorageKey(code),
                    pendingToken,
                  );
                }
                sessionStorage.removeItem(key);
                break;
              }
            }
          }
          window.history.pushState(
            null,
            "",
            `/track/${encodeURIComponent(code)}`,
          );
          setTrackingJobCode(code);
          return;
        }

        // 2. If payment was initiated (PAYMENT_PENDING) and this session has an in-flight checkout pending tracking token,
        // restore pending recovery so the customer sees "Payment Verification Pending" with "Check Payment Status" button.
        let hasInFlightPayment = false;
        if (typeof sessionStorage !== "undefined") {
          for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            if (key && key.startsWith(PENDING_TRACKING_TOKEN_PREFIX)) {
              hasInFlightPayment = true;
              break;
            }
          }
        }
        if (draft.status === "PAYMENT_PENDING" && hasInFlightPayment) {
          setDraftToken(savedToken);
          setPendingPaymentRecovery({ token: savedToken });
          setStatus(
            "Payment verification is pending. Tap Check Payment Status to confirm.",
          );
          return;
        }

        // 3. Otherwise restore normal unpaid or review draft session
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
  }, [config, draftToken]);

  const selectedFile = files[selectedFileIndex] ?? null;

  const printOptions = useMemo(
    () => config?.availablePrintOptions ?? [],
    [config?.availablePrintOptions],
  );

  const optionAvailable = useMemo(
    () =>
      printOptions.some(
        (option) =>
          option.paperSize === selectedFile?.paperSize &&
          option.colorMode === selectedFile?.colorMode &&
          option.sides === selectedFile?.sides,
      ),
    [printOptions, selectedFile],
  );

  function patchSelected(update: Partial<LocalOrderFile>) {
    setQuote(null);
    setFiles((current) =>
      current.map((item, index) => {
        if (index !== selectedFileIndex) return item;
        const targetPaper = update.paperSize ?? item.paperSize;
        const targetColor = update.colorMode ?? item.colorMode;
        let targetSides = update.sides ?? item.sides;
        if (targetSides === "DOUBLE") {
          const isDuplexSupported = (config?.availablePrintOptions ?? []).some(
            (o) =>
              o.paperSize === targetPaper &&
              o.colorMode === targetColor &&
              o.sides === "DOUBLE",
          );
          if (!isDuplexSupported) {
            targetSides = "SINGLE";
          }
        }
        return { ...item, ...update, sides: targetSides };
      }),
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
    const availableOpts = config?.availablePrintOptions ?? [];
    const preferredOption =
      availableOpts.find(
        (o) =>
          o.paperSize === "A4" && o.colorMode === "BW" && o.sides === "SINGLE",
      ) ??
      availableOpts.find((o) => o.sides === "SINGLE") ??
      availableOpts[0];
    if (!preferredOption) return;
    const added: LocalOrderFile[] = [];
    setIsInspectingFiles(true);
    try {
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
            paperSize: preferredOption.paperSize,
            colorMode: preferredOption.colorMode,
            sides: "SINGLE", // Always Single-sided by default for new orders and newly uploaded files
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
    } finally {
      setIsInspectingFiles(false);
    }
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
    if (!customerName.trim()) {
      setStatus("Please enter your name.");
      return;
    }
    if (!isValidPhone(customerPhone)) {
      setPhoneError(
        "Enter a valid phone number (at least 6 digits, e.g. 9876543210 or +91 98765 43210).",
      );
      setStatus("Please enter a valid phone number before continuing.");
      return;
    }
    setPhoneError(null);
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
    setStatus("Checking printer capabilities…");
    try {
      const freshConfig = await customerApi.config();
      setConfig(freshConfig);
      if (!freshConfig.onlinePrintingEnabled) {
        setStatus("Online printing is currently paused.");
        setBusy(false);
        return;
      }
      const unsupported = filesRef.current.find(
        (f) =>
          !(freshConfig.availablePrintOptions ?? []).some(
            (o) =>
              o.paperSize === f.paperSize &&
              o.colorMode === f.colorMode &&
              o.sides === f.sides,
          ),
      );
      if (unsupported) {
        const msg =
          unsupported.sides === "DOUBLE"
            ? `Double-sided printing for "${unsupported.name}" is no longer supported by available printers. Please switch to Single-sided.`
            : `Selected print settings for "${unsupported.name}" are no longer supported by available printers. Please review your settings.`;
        setStatus(msg);
        setBusy(false);
        return;
      }
    } catch {
      // Continue if config lookup encountered a transient error
    }
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

        try {
          if (!token) {
            const draft = await customerApi.createDraft({
              customerName,
              customerPhone,
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

          if (!filesRef.current.find((f) => f.clientId === clientId)) continue;

          updateFile(clientId, { uploadStatus: "UPLOADING" });
          setStatus(
            `Uploading File ${index + 1} of ${filesRef.current.length}…`,
          );

          const controller = new AbortController();
          abortControllers.current.set(clientId, controller);

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
          await customerApi.complete(token, latestItem?.fileId || "");

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
      setPaymentPhase("IDLE");
      setStatus(paymentErrorMessage(caught));
      setPaymentBusy(false);
      setPendingPaymentRecovery({ token, response });
    }
  }

  async function recoverPayment(
    token: string,
    response?: RazorpaySuccessResponse,
  ) {
    setPaymentBusy(true);
    setStatus("Checking with the shop for your confirmed payment…");
    try {
      const draftStatus = await customerApi.getDraftStatus(token);
      if (SERVER_CONFIRMED_PAID_STATUSES.has(draftStatus.status)) {
        const code =
          draftStatus.pickupCode ||
          draftStatus.publicJobCode ||
          draftStatus.orderId;
        sessionStorage.removeItem(DRAFT_TOKEN_KEY);
        setPendingPaymentRecovery(null);
        setPaymentBusy(false);
        // Link any pending tracking token generated in this checkout session
        if (typeof sessionStorage !== "undefined" && code) {
          for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            if (key && key.startsWith(PENDING_TRACKING_TOKEN_PREFIX)) {
              const pendingToken = sessionStorage.getItem(key);
              if (pendingToken && /^[A-Za-z0-9_-]{43}$/u.test(pendingToken)) {
                sessionStorage.setItem(trackingStorageKey(code), pendingToken);
              }
              sessionStorage.removeItem(key);
              break;
            }
          }
        }
        window.history.pushState(
          null,
          "",
          `/track/${encodeURIComponent(code)}`,
        );
        setTrackingJobCode(code);
        return;
      }
      if (response) {
        setStatus("Re-verifying captured payment with the shop server…");
        await verifyCheckoutPayment(token, response);
        return;
      }
      setStatus(
        "Payment is still being processed by the shop. Please wait a moment and tap Check Payment Status. Do not pay twice.",
      );
    } catch {
      setStatus(
        "Could not connect to check payment status. Please check your connection and tap Check Payment Status.",
      );
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
          setPaymentPhase("IDLE");
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
      setPaymentPhase("IDLE");
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
    setPaymentPhase("CHECKING_AVAILABILITY");
    setStatus("Checking printer availability…");
    try {
      const freshConfig = await customerApi.config();
      setConfig(freshConfig);
      if (
        Array.isArray(freshConfig.availablePrintOptions) &&
        freshConfig.availablePrintOptions.length > 0
      ) {
        const unsupported = filesRef.current.find(
          (f) =>
            !freshConfig.availablePrintOptions.some(
              (o) =>
                o.paperSize === f.paperSize &&
                o.colorMode === f.colorMode &&
                o.sides === f.sides,
            ),
        );
        if (unsupported) {
          const msg =
            unsupported.sides === "DOUBLE"
              ? `Double-sided printing for "${unsupported.name}" is no longer supported by available printers. Please switch to Single-sided.`
              : `Selected printing options for "${unsupported.name}" are no longer supported by available printers. Please review your settings.`;
          setStatus(msg);
          setPaymentBusy(false);
          setPaymentPhase("IDLE");
          return;
        }
      }

      setPaymentPhase("FINDING_PRINTER");
      setStatus("Finding the best printer…");
      const result = await customerApi.createPayment(draftToken, {
        acknowledgedTotalPaise: quote.totalAmountPaise,
      });
      if (result.status === "PRICE_CHANGED") {
        setQuote(result.quote);
        setStatus(
          "The price changed. Review the updated total, then press Pay again to acknowledge it.",
        );
        setPaymentBusy(false);
        setPaymentPhase("IDLE");
        return;
      }
      setPaymentPhase("PREPARING_PAYMENT");
      setStatus("Preparing secure payment…");
      await openCheckout(draftToken, result);
    } catch (caught) {
      setStatus(paymentErrorMessage(caught));
      setPaymentBusy(false);
      setPaymentPhase("IDLE");
    }
  }

  async function selectCash() {
    if (
      !quote ||
      !draftToken ||
      paymentBusy ||
      busy ||
      cashSelecting ||
      Boolean(paymentSuccess)
    )
      return;
    setCashSelecting(true);
    setStatus("Selecting cash payment at counter…");
    try {
      const freshConfig = await customerApi.config();
      setConfig(freshConfig);
      if (
        Array.isArray(freshConfig.availablePrintOptions) &&
        freshConfig.availablePrintOptions.length > 0
      ) {
        const unsupported = filesRef.current.find(
          (f) =>
            !freshConfig.availablePrintOptions.some(
              (o) =>
                o.paperSize === f.paperSize &&
                o.colorMode === f.colorMode &&
                o.sides === f.sides,
            ),
        );
        if (unsupported) {
          const msg =
            unsupported.sides === "DOUBLE"
              ? `Double-sided printing for "${unsupported.name}" is no longer supported by available printers. Please switch to Single-sided.`
              : `Selected printing options for "${unsupported.name}" are no longer supported by available printers. Please review your settings.`;
          setStatus(msg);
          setCashSelecting(false);
          return;
        }
      }

      const data = await customerApi.selectCashPayment(draftToken);
      setCashWaitingData(data);
      setStatus(null);
    } catch (caught) {
      setStatus(customerErrorMessage(caught));
    } finally {
      setCashSelecting(false);
    }
  }

  const shopHeader = (
    <ShopHeader
      config={config}
      trackBoxCode={trackBoxCode}
      onTrackBoxCodeChange={setTrackBoxCode}
      onTrackSubmit={(e) => {
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
      onOpenPricing={() => setShowPricing(true)}
    />
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
          <Suspense
            fallback={
              <div className="page-shell">
                <p>Loading tracking…</p>
              </div>
            }
          >
            <PublicTrackingPage
              pickupCode={trackingJobCode}
              onBack={() => {
                setTrackingJobCode(null);
                window.history.pushState(null, "", "/");
              }}
            />
          </Suspense>
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
      setCashWaitingData(null);
      window.history.pushState(null, "", "/");
    };

    return (
      <>
        {shopHeader}
        <Suspense
          fallback={
            <div className="page-shell">
              <p>Loading tracking…</p>
            </div>
          }
        >
          <TrackingPage jobCode={trackingJobCode} onBack={handleResetToHome} />
        </Suspense>
      </>
    );
  }

  if (cashWaitingData && draftToken) {
    return (
      <main className="page-shell">
        {shopHeader}
        <Suspense
          fallback={
            <div className="page-shell">
              <p>Loading…</p>
            </div>
          }
        >
          <CashWaitingPage
            draftToken={draftToken}
            orderId={cashWaitingData.orderId}
            publicJobCode={cashWaitingData.publicJobCode}
            payableAmountPaise={cashWaitingData.payableAmountPaise}
            cashExpiresAtMs={cashWaitingData.cashExpiresAtMs}
            cashGraceUntilMs={cashWaitingData.cashGraceUntilMs}
            onPayOnlineInstead={() => {
              setCashWaitingData(null);
              void pay();
            }}
            onOrderConfirmed={(trackingCode) => {
              setCashWaitingData(null);
              setDraftToken(null);
              sessionStorage.removeItem(DRAFT_TOKEN_KEY);
              window.history.pushState(
                null,
                "",
                `/track/${encodeURIComponent(trackingCode)}`,
              );
              setTrackingJobCode(trackingCode);
            }}
            onExpired={() => {
              setCashWaitingData(null);
              setStatus(
                "Cash payment window expired. Your document and settings are preserved below so you can review and try again.",
              );
            }}
          />
        </Suspense>
      </main>
    );
  }

  if (loading) {
    return (
      <main className="page-shell" aria-busy="true">
        <div style={{ textAlign: "center", padding: "4rem 1rem" }}>
          <div style={{ marginBottom: "1.25rem" }}>
            <FloatingLoadingIndicator size="lg" variant="green" />
          </div>
          <p style={{ color: "#123b4a", fontWeight: 700, fontSize: "1.05rem" }}>
            Connecting to PrintGo…
          </p>
        </div>
      </main>
    );
  }

  if (!config) {
    return (
      <main className="page-shell">
        {shopHeader}
        <ShopUnavailableState
          reason="NETWORK_ERROR"
          error={configError}
          onRetry={loadShopConfig}
        />
      </main>
    );
  }

  const isShopClosed = !config.onlinePrintingEnabled;
  const isPrintersUnavailable =
    config.onlinePrintingEnabled &&
    (!config.availablePrintOptions ||
      config.availablePrintOptions.length === 0);

  if (isShopClosed || isPrintersUnavailable) {
    return (
      <main className="page-shell">
        {shopHeader}
        <ShopUnavailableState
          reason={isShopClosed ? "SHOP_CLOSED" : "PRINTER_UNAVAILABLE"}
          shopName={config.shopName}
          contactPhone={config.contactPhone}
          customerNotice={config.customerNotice}
          onRetry={loadShopConfig}
        />
        <CustomerPrivacyFooter appName={config?.appName} />
      </main>
    );
  }

  return (
    <main className="page-shell">
      {shopHeader}
      {!busy && !paymentBusy && !quote && !paymentSuccess ? (
        <PwaInstallBanner />
      ) : null}
      <PricingModal
        isOpen={showPricing}
        config={config}
        onClose={() => setShowPricing(false)}
      />
      <ShopInfoModal
        isOpen={showInfo}
        config={config}
        onClose={() => setShowInfo(false)}
      />
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
      <form
        className="order-layout"
        onSubmit={(event) => void prepareReview(event)}
      >
        <div className="order-step-container step-1-container">
          <CustomerDetailsStep
            customerName={customerName}
            onCustomerNameChange={setCustomerName}
            customerPhone={customerPhone}
            onCustomerPhoneChange={(val) => {
              setCustomerPhone(val);
              if (phoneError && isValidPhone(val)) {
                setPhoneError(null);
              }
            }}
            phoneError={phoneError}
            onPhoneBlur={() => {
              if (customerPhone.trim() && !isValidPhone(customerPhone)) {
                setPhoneError(
                  "Enter a valid phone number (at least 6 digits, e.g. 9876543210 or +91 98765 43210).",
                );
              } else {
                setPhoneError(null);
              }
            }}
            instructions={instructions}
            onInstructionsChange={setInstructions}
            addonServices={config.addonServices}
            selectedAddonIds={selectedAddonIds}
            onToggleAddon={(id, checked) => {
              if (checked) {
                setSelectedAddonIds([...selectedAddonIds, id]);
              } else {
                setSelectedAddonIds(
                  selectedAddonIds.filter((serviceId) => serviceId !== id),
                );
              }
            }}
            disabled={busy || paymentBusy || Boolean(draftToken)}
          />
        </div>

        <div className="order-step-container step-2-container">
          <UploadPdfsStep
            files={files}
            selectedFileIndex={selectedFileIndex}
            onSelectFileIndex={setSelectedFileIndex}
            onRemoveFile={removeFile}
            onChooseFiles={(fileList) => void chooseFiles(fileList)}
            config={config}
            fileError={fileError}
            disabled={busy || paymentBusy || Boolean(draftToken)}
            isInspectingFiles={isInspectingFiles}
          />
        </div>

        <div className="order-step-container step-3-container">
          <PrintSettingsStep
            files={files}
            selectedFile={selectedFile}
            selectedFileIndex={selectedFileIndex}
            onSelectFileIndex={setSelectedFileIndex}
            printOptions={printOptions}
            optionAvailable={optionAvailable}
            onPatchSelected={patchSelected}
            onApplySettingsToAll={applySettingsToAll}
          />
        </div>

        <div className="order-step-container step-4-container">
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

            {pendingPaymentRecovery && !quote && (
              <div
                style={{
                  backgroundColor: "#FEF3C7",
                  border: "1.5px solid #F59E0B",
                  borderRadius: "8px",
                  padding: "1rem",
                  textAlign: "left",
                  marginBottom: "1.5rem",
                }}
                role="alert"
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                    marginBottom: "0.4rem",
                  }}
                >
                  <span style={{ fontSize: "1.25rem" }}>⚠️</span>
                  <strong style={{ color: "#92400E" }}>
                    Payment Verification Pending
                  </strong>
                </div>
                <p
                  style={{
                    fontSize: "0.85rem",
                    color: "#78350F",
                    margin: "0 0 0.75rem",
                  }}
                >
                  Your payment was received, but server verification was
                  interrupted by a network issue. Tap below to verify your
                  payment and get your print job tracking code.
                </p>
                <button
                  type="button"
                  className="pay-button"
                  style={{
                    backgroundColor: "#D97706",
                    borderColor: "#B45309",
                    width: "100%",
                    padding: "0.75rem",
                  }}
                  disabled={paymentBusy}
                  onClick={() =>
                    void recoverPayment(
                      pendingPaymentRecovery.token,
                      pendingPaymentRecovery.response,
                    )
                  }
                >
                  {paymentBusy ? "Checking Status…" : "Check Payment Status"}
                </button>
              </div>
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
              <OrderReviewSummary
                quote={quote}
                files={files}
                customerName={customerName}
                customerPhone={customerPhone}
              >
                {draftToken && (
                  <div
                    className="payment-methods"
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.6rem",
                      marginTop: "0.75rem",
                    }}
                  >
                    {pendingPaymentRecovery ? (
                      <div
                        style={{
                          backgroundColor: "#FEF3C7",
                          border: "1.5px solid #F59E0B",
                          borderRadius: "8px",
                          padding: "1rem",
                          textAlign: "left",
                        }}
                        role="alert"
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "0.5rem",
                            marginBottom: "0.4rem",
                          }}
                        >
                          <span style={{ fontSize: "1.25rem" }}>⚠️</span>
                          <strong
                            style={{
                              color: "#92400E",
                              fontSize: "0.95rem",
                            }}
                          >
                            Payment Verification Pending
                          </strong>
                        </div>
                        <p
                          style={{
                            margin: "0 0 0.75rem",
                            fontSize: "0.88rem",
                            color: "#78350F",
                            lineHeight: "1.4",
                          }}
                        >
                          Your payment was submitted to Razorpay, but connecting
                          to the shop server timed out before confirmation
                          arrived.
                          <br />
                          <strong>Please do not pay again.</strong> Tap below to
                          check your payment status.
                        </p>
                        <button
                          type="button"
                          className="primary-button"
                          onClick={() =>
                            void recoverPayment(
                              pendingPaymentRecovery.token,
                              pendingPaymentRecovery.response,
                            )
                          }
                          disabled={paymentBusy}
                          style={{
                            width: "100%",
                            padding: "0.75rem",
                            marginTop: 0,
                          }}
                        >
                          {paymentBusy
                            ? "Checking Status…"
                            : "Check Payment Status"}
                        </button>
                      </div>
                    ) : config?.cashOrdersEnabled ? (
                      <>
                        <button
                          type="button"
                          className={`pay-button ${paymentBusy ? "loading" : ""}`}
                          onClick={() => void pay()}
                          disabled={
                            paymentBusy ||
                            busy ||
                            cashSelecting ||
                            Boolean(paymentSuccess)
                          }
                          aria-busy={paymentBusy}
                          style={{
                            display: "flex",
                            flexDirection: paymentBusy ? "row" : "column",
                            alignItems: "center",
                            justifyContent: "center",
                            gap: paymentBusy ? "0.65rem" : "0",
                            padding: "0.85rem 1.25rem",
                            cursor: paymentBusy ? "wait" : "pointer",
                          }}
                        >
                          {paymentBusy ? (
                            <>
                              <FloatingLoadingIndicator
                                size="sm"
                                variant="green"
                              />
                              <span
                                style={{
                                  fontSize: "1rem",
                                  fontWeight: 700,
                                  color: "#123b4a",
                                }}
                              >
                                {paymentPhase === "CHECKING_AVAILABILITY"
                                  ? "Checking printer availability…"
                                  : paymentPhase === "PREPARING_PAYMENT"
                                    ? "Preparing secure payment…"
                                    : "Finding the best printer…"}
                              </span>
                            </>
                          ) : (
                            <>
                              <span
                                style={{ fontSize: "1rem", fontWeight: 700 }}
                              >
                                🔒 Pay Online (
                                {formatInr(quote.totalAmountPaise)})
                              </span>
                              <span
                                style={{
                                  fontSize: "0.75rem",
                                  fontWeight: 400,
                                  opacity: 0.9,
                                  marginTop: "0.15rem",
                                }}
                              >
                                Print immediately after payment
                              </span>
                            </>
                          )}
                        </button>

                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => void selectCash()}
                          disabled={
                            paymentBusy ||
                            busy ||
                            cashSelecting ||
                            Boolean(paymentSuccess)
                          }
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            justifyContent: "center",
                            padding: "0.65rem 1rem",
                            cursor: "pointer",
                            border: "1px solid #CBD5E1",
                            borderRadius: "8px",
                            backgroundColor: "#FFFFFF",
                            color: "#1E293B",
                          }}
                        >
                          <span
                            style={{ fontSize: "0.95rem", fontWeight: 600 }}
                          >
                            {cashSelecting
                              ? "Selecting cash…"
                              : "💵 Pay Cash at Counter"}
                          </span>
                          <span
                            style={{
                              fontSize: "0.75rem",
                              fontWeight: 400,
                              color: "#64748B",
                              marginTop: "0.15rem",
                            }}
                          >
                            Printing starts after the shopkeeper confirms
                            payment
                          </span>
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className={`pay-button ${paymentBusy ? "loading" : ""}`}
                        onClick={() => void pay()}
                        disabled={
                          paymentBusy ||
                          busy ||
                          cashSelecting ||
                          Boolean(paymentSuccess)
                        }
                        aria-busy={paymentBusy}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: paymentBusy ? "0.65rem" : "0",
                          cursor: paymentBusy ? "wait" : "pointer",
                        }}
                      >
                        {paymentBusy ? (
                          <>
                            <FloatingLoadingIndicator
                              size="sm"
                              variant="green"
                            />
                            <span
                              style={{
                                fontSize: "1rem",
                                fontWeight: 700,
                                color: "#123b4a",
                              }}
                            >
                              {paymentPhase === "CHECKING_AVAILABILITY"
                                ? "Checking printer availability…"
                                : paymentPhase === "PREPARING_PAYMENT"
                                  ? "Preparing secure payment…"
                                  : "Finding the best printer…"}
                            </span>
                          </>
                        ) : (
                          `🔒 Pay ${formatInr(quote.totalAmountPaise)}`
                        )}
                      </button>
                    )}
                  </div>
                )}
              </OrderReviewSummary>
            )}
          </section>
        </div>
      </form>
      <CustomerPrivacyFooter appName={config?.appName} />
    </main>
  );
}
