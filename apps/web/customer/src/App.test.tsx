// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { customerApi, uploadDirectly } from "./api";
import { App } from "./App";
import { inspectPdf } from "./pdf";

vi.mock("./api", () => ({
  customerApi: {
    config: vi.fn(),
    createDraft: vi.fn(),
    authorize: vi.fn(),
    complete: vi.fn(),
    getDraft: vi.fn(),
    addFile: vi.fn(),
    removeFile: vi.fn(),
    quote: vi.fn(),
    quoteOrder: vi.fn(),
    previewQuoteOrder: vi.fn(),
    createPayment: vi.fn(),
    verifyPayment: vi.fn(),
    cancelPayment: vi.fn(),
    tracking: vi.fn(),
    selectCashPayment: vi.fn(),
    getDraftStatus: vi.fn(),
    trackPublic: vi.fn(),
  },
  uploadDirectly: vi.fn(),
}));
vi.mock("./pdf", () => ({ inspectPdf: vi.fn() }));

const enabledConfig = {
  shopName: "ABC Xerox",
  contactPhone: "9876543210",
  customerNotice: "Same-day printing",
  onlinePrintingEnabled: true,
  maxPdfSizeBytes: 1024,
  availablePrintOptions: [
    {
      paperSize: "A4" as const,
      colorMode: "BW" as const,
      sides: "SINGLE" as const,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  delete window.Razorpay;
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.mocked(customerApi.config).mockResolvedValue(enabledConfig);
  vi.mocked(inspectPdf).mockResolvedValue(10);
  vi.mocked(customerApi.tracking).mockResolvedValue({
    jobCode: "PG-ABC234",
    instructions: null,
    customerName: "Rahul",
    paymentStatus: "PAYMENT_RECEIVED",
    orderStatus: "QUEUED",
    statusLabel: "In queue",
    statusMessage: "Queue",
    submittedAt: "2026-09-26T00:00:00.000Z",
    paidAt: "2026-09-26T00:01:00.000Z",
    printSummary: {
      selectedPages: "1-12",
      copies: 1,
      paperSize: "A4",
      colorMode: "BW",
      sides: "DOUBLE",
    },
    amountPaidPaise: 4200,
    currency: "INR",
    fileRetentionStatus: "TEMPORARILY_RETAINED",
    timeline: [],
    trackingExpiresAt: "2026-10-10T00:01:00.000Z",
  });
  vi.mocked(customerApi.createDraft).mockResolvedValue({
    draftToken: "A".repeat(43),
    draftExpiresAt: "2026-09-26T00:10:00.000Z",
    fileId: "10000000-0000-4000-8000-000000000001",
    position: 1,
    upload: {
      uploadUrl: "https://r2.test/signed",
      expiresAt: "2026-09-26T00:05:00.000Z",
      requiredHeaders: { "Content-Type": "application/pdf" },
    },
  });
  vi.mocked(uploadDirectly).mockImplementation(
    (_file, _url, _headers, progress) => {
      progress(42);
      return Promise.resolve();
    },
  );
  vi.mocked(customerApi.complete).mockResolvedValue({
    sizeBytes: 100,
    uploadedAt: "now",
    draftExpiresAt: "later",
  });
  vi.mocked(customerApi.authorize).mockResolvedValue({
    upload: {
      uploadUrl: "https://r2.test/retry",
      expiresAt: "soon",
      requiredHeaders: { "Content-Type": "application/pdf" },
    },
  });
  let addedPosition = 1;
  vi.mocked(customerApi.addFile).mockImplementation(() => {
    addedPosition += 1;
    return Promise.resolve({
      fileId: `20000000-0000-4000-8000-00000000000${addedPosition}`,
      position: addedPosition,
      draftExpiresAt: "later",
      upload: {
        uploadUrl: `https://r2.test/file-${addedPosition}`,
        expiresAt: "soon",
        requiredHeaders: { "Content-Type": "application/pdf" },
      },
    });
  });
  vi.mocked(customerApi.quote).mockResolvedValue({
    normalizedSelectedPages: "1-10",
    selectedPageCount: 10,
    copies: 1,
    paperSize: "A4",
    colorMode: "BW",
    sides: "SINGLE",
    printingAmountPaise: 2000,
    serviceChargePaise: 100,
    totalAmountPaise: 2100,
    currency: "INR",
    expiresAt: "later",
  });
  vi.mocked(customerApi.quoteOrder).mockResolvedValue({
    normalizedSelectedPages: "1-10",
    selectedPageCount: 10,
    copies: 1,
    paperSize: "A4",
    colorMode: "BW",
    sides: "SINGLE",
    printingAmountPaise: 2000,
    serviceChargePaise: 100,
    totalAmountPaise: 2100,
    currency: "INR",
    expiresAt: "later",
  });
  vi.mocked(customerApi.previewQuoteOrder).mockResolvedValue({
    normalizedSelectedPages: "1-10",
    selectedPageCount: 10,
    copies: 1,
    paperSize: "A4",
    colorMode: "BW",
    sides: "SINGLE",
    printingAmountPaise: 2000,
    serviceChargePaise: 100,
    totalAmountPaise: 2100,
    currency: "INR",
    expiresAt: "later",
  });
  vi.mocked(customerApi.createPayment).mockResolvedValue({
    status: "PRICE_CHANGED",
    quote: {
      normalizedSelectedPages: "1-10",
      selectedPageCount: 10,
      copies: 1,
      paperSize: "A4",
      colorMode: "BW",
      sides: "SINGLE",
      printingAmountPaise: 2100,
      serviceChargePaise: 100,
      totalAmountPaise: 2200,
      currency: "INR",
      expiresAt: "later",
    },
  });
  vi.mocked(customerApi.verifyPayment).mockResolvedValue({
    jobCode: "PG-ABC234",
    amountPaidPaise: 2100,
    currency: "INR",
    status: "QUEUED",
    message: "Payment verified. Your print job is queued.",
    trackingToken: "T".repeat(43),
    trackingExpiresAt: "2026-10-10T00:00:00.000Z",
  });
  vi.mocked(customerApi.cancelPayment).mockResolvedValue({
    status: "PAYMENT_CANCELLED",
    retainedUntil: "later",
  });
});

afterEach(cleanup);

describe("customer upload app", () => {
  it("numbers three PDFs, applies settings to all, and keeps 3+ review filename-free", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("ABC Xerox");
    await user.type(screen.getByLabelText("Name"), "Rahul");
    await user.type(screen.getByLabelText("Phone"), "9876543210");
    await user.upload(screen.getByLabelText("Choose Files"), [
      new File(["%PDF"], "one.pdf", { type: "application/pdf" }),
      new File(["%PDF"], "two.pdf", { type: "application/pdf" }),
      new File(["%PDF"], "three.pdf", { type: "application/pdf" }),
    ]);
    expect(await screen.findByText("one.pdf")).toBeTruthy();
    expect(screen.getByText("two.pdf")).toBeTruthy();
    expect(screen.getByText("three.pdf")).toBeTruthy();

    await user.clear(screen.getByLabelText("Copies"));
    await user.type(screen.getByLabelText("Copies"), "3");
    await user.click(
      screen.getByRole("button", {
        name: /Apply these settings to all files/i,
      }),
    );
    await user.selectOptions(screen.getByLabelText("File to configure"), "1");
    expect(screen.getByLabelText<HTMLInputElement>("Copies").value).toBe("3");
    await user.clear(screen.getByLabelText("Copies"));
    await user.type(screen.getByLabelText("Copies"), "2");
    await user.selectOptions(screen.getByLabelText("File to configure"), "0");
    expect(screen.getByLabelText<HTMLInputElement>("Copies").value).toBe("3");

    fireEvent.submit(
      screen.getByRole("button", { name: "Review Order" }).closest("form")!,
    );
    const review = (await screen.findByText("Files (3)")).closest("section")!;
    expect(within(review).queryByText(/View files/i)).toBeNull();
  });

  it("shows the service-paused screen without an upload form", async () => {
    vi.mocked(customerApi.config).mockResolvedValueOnce({
      ...enabledConfig,
      onlinePrintingEnabled: false,
    });
    render(<App />);
    expect(
      await screen.findByText("Online printing is currently unavailable"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /upload pdf/i })).toBeNull();
  });

  it("shows the printer-unavailable screen when all printers are offline or agent is disconnected", async () => {
    vi.mocked(customerApi.config).mockResolvedValueOnce({
      ...enabledConfig,
      onlinePrintingEnabled: true,
      availablePrintOptions: [],
    });
    render(<App />);
    expect(
      await screen.findByRole("heading", {
        name: "Sorry, printing is temporarily unavailable.",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Shop printers are currently offline or unavailable. Please check back in a few moments.",
      ),
    ).toBeTruthy();
    // Verify four checkout sections are not shown
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.queryByLabelText("Choose Files")).toBeNull();
  });

  it("keeps checkout accessible and allows order queuing when printers are healthy but occupied printing", async () => {
    // When shop printers are actively printing existing jobs, onlinePrintingEnabled remains true
    // and availablePrintOptions has supported options. The 4 checkout sections must remain fully usable!
    vi.mocked(customerApi.config).mockResolvedValueOnce({
      ...enabledConfig,
      onlinePrintingEnabled: true,
      availablePrintOptions: [
        {
          paperSize: "A4" as const,
          colorMode: "BW" as const,
          sides: "SINGLE" as const,
        },
      ],
    });
    render(<App />);

    // All 4 checkout sections must be rendered and visible
    expect(await screen.findByLabelText("Name")).toBeTruthy();
    expect(screen.getByLabelText("Phone")).toBeTruthy();
    expect(screen.getByLabelText("Choose Files")).toBeTruthy();
    expect(screen.getByText("Print Settings")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review Order" })).toBeTruthy();

    // Unavailable screen must NOT be shown
    expect(
      screen.queryByText("Sorry, printing is temporarily unavailable."),
    ).toBeNull();
    expect(screen.queryByText("Sorry, we're currently closed.")).toBeNull();
  });

  it("shows PDF limits and the external compression privacy warning", async () => {
    render(<App />);
    expect(await screen.findByText("ABC Xerox")).toBeTruthy();
    const link = screen.getByRole("link", { name: /Open iLovePDF/i });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(
      screen.getByText(/external site; its privacy terms apply/i),
    ).toBeTruthy();
  });

  it("rejects an oversized PDF before parsing or uploading", async () => {
    render(<App />);
    await screen.findByText("ABC Xerox");
    const file = new File([new Uint8Array(2048)], "large.pdf", {
      type: "application/pdf",
    });
    await userEvent.upload(screen.getByLabelText("Choose Files"), file);
    expect(await screen.findByText(/PDFs must be between 1 byte/)).toBeTruthy();
    expect(inspectPdf).not.toHaveBeenCalled();
  });

  it("handles corrupted and password-protected PDFs with useful errors", async () => {
    vi.mocked(inspectPdf).mockRejectedValueOnce(new Error("INVALID_PDF"));
    render(<App />);
    await screen.findByText("ABC Xerox");
    const file = new File(["%PDF"], "broken.pdf", { type: "application/pdf" });
    await userEvent.upload(screen.getByLabelText("Choose Files"), file);
    expect(
      await screen.findByText("This PDF is corrupted or cannot be read."),
    ).toBeTruthy();
  });

  it("uploads with progress, converts All to an explicit range, and renders the authoritative review", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("ABC Xerox");
    await user.type(screen.getByLabelText("Name"), "Rahul");
    await user.type(screen.getByLabelText("Phone"), "9876543210");
    await user.upload(
      screen.getByLabelText("Choose Files"),
      new File(["%PDF"], "notes.pdf", { type: "application/pdf" }),
    );
    expect(await screen.findAllByText(/10 pages/)).toBeTruthy();
    fireEvent.submit(
      screen.getByRole("button", { name: "Review Order" }).closest("form")!,
    );
    await waitFor(() =>
      expect(customerApi.quoteOrder).toHaveBeenCalledWith(
        "A".repeat(43),
        expect.objectContaining({
          files: [
            expect.objectContaining({ selectedPages: "1-10", copies: 1 }),
          ],
        }),
      ),
    );
    expect(await screen.findByText("₹21.00")).toBeTruthy();
    expect(screen.getAllByText("notes.pdf")).toHaveLength(2);
    expect(sessionStorage.getItem("printgo.customerDraftToken")).toBe(
      "A".repeat(43),
    );
  });

  it("validates custom ranges locally and preserves details on retryable failure", async () => {
    const user = userEvent.setup();
    vi.mocked(uploadDirectly).mockRejectedValueOnce(
      new Error("UPLOAD_NETWORK_ERROR"),
    );
    render(<App />);
    await screen.findByText("ABC Xerox");
    await user.type(screen.getByLabelText("Name"), "Rahul");
    await user.type(screen.getByLabelText("Phone"), "9876543210");
    await user.upload(
      screen.getByLabelText("Choose Files"),
      new File(["%PDF"], "notes.pdf", { type: "application/pdf" }),
    );
    await user.click(screen.getByLabelText("Custom range"));
    const pages = await screen.findByLabelText("Custom pages");
    fireEvent.change(pages, { target: { value: "10-2" } });
    fireEvent.submit(
      screen.getByRole("button", { name: "Review Order" }).closest("form")!,
    );
    expect(
      await screen.findByText(/Enter pages between 1 and 10/),
    ).toBeTruthy();
    fireEvent.change(pages, { target: { value: "1-3" } });
    fireEvent.submit(
      screen.getByRole("button", { name: "Review Order" }).closest("form")!,
    );
    expect(
      (await screen.findAllByText(/The upload was interrupted/i)).length,
    ).toBeGreaterThan(0);
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Rahul");
    const retry = screen.getByRole("button", { name: "Try upload again" });
    fireEvent.submit(retry.closest("form")!);
    await waitFor(() =>
      expect(customerApi.authorize).toHaveBeenCalledWith(
        "A".repeat(43),
        "10000000-0000-4000-8000-000000000001",
      ),
    );
    await waitFor(() => expect(customerApi.quoteOrder).toHaveBeenCalled());
  });

  it("requires a second explicit click after a server-side price change", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("ABC Xerox");
    await user.type(screen.getByLabelText("Name"), "Rahul");
    await user.type(screen.getByLabelText("Phone"), "9876543210");
    await user.upload(
      screen.getByLabelText("Choose Files"),
      new File(["%PDF"], "notes.pdf", { type: "application/pdf" }),
    );
    fireEvent.submit(
      screen.getByRole("button", { name: "Review Order" }).closest("form")!,
    );
    const pay = await screen.findByRole("button", { name: "🔒 Pay ₹21.00" });
    await user.click(pay);
    expect(
      await screen.findByText(/The price changed\. Review the updated total/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "🔒 Pay ₹22.00" })).toBeTruthy();
    expect(customerApi.createPayment).toHaveBeenCalledTimes(1);
  });

  it("disables duplicate Pay clicks while payment creation is pending", async () => {
    const user = userEvent.setup();
    vi.mocked(customerApi.createPayment).mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    render(<App />);
    await screen.findByText("ABC Xerox");
    await user.type(screen.getByLabelText("Name"), "Rahul");
    await user.type(screen.getByLabelText("Phone"), "9876543210");
    await user.upload(
      screen.getByLabelText("Choose Files"),
      new File(["%PDF"], "notes.pdf", { type: "application/pdf" }),
    );
    fireEvent.submit(
      screen.getByRole("button", { name: "Review Order" }).closest("form")!,
    );
    const pay = await screen.findByRole("button", { name: "🔒 Pay ₹21.00" });
    await user.click(pay);
    expect(
      screen.getByRole("button", {
        name: /Finding the best printer|Confirming payment/i,
      }),
    ).toHaveProperty("disabled", true);
    await user.click(
      screen.getByRole("button", {
        name: /Finding the best printer|Confirming payment/i,
      }),
    );
    expect(customerApi.createPayment).toHaveBeenCalledTimes(1);
  });

  it("shows verified success and a job code only after Worker verification", async () => {
    const user = userEvent.setup();
    let checkoutHandler:
      | ((value: {
          razorpay_order_id: string;
          razorpay_payment_id: string;
          razorpay_signature: string;
        }) => void)
      | undefined;
    class MockRazorpay {
      constructor(options: Record<string, unknown>) {
        checkoutHandler = options.handler as typeof checkoutHandler;
      }
      open() {}
      on() {}
    }
    window.Razorpay = MockRazorpay;
    vi.mocked(customerApi.createPayment).mockResolvedValueOnce({
      status: "CHECKOUT_READY",
      razorpayKeyId: "rzp_test_key",
      razorpayOrderId: "order_server_a",
      amountPaise: 2100,
      currency: "INR",
      shopName: "ABC Xerox",
      customerName: "Rahul",
      customerPhone: "9876543210",
      description: "Printing: notes.pdf",
    });
    render(<App />);
    await screen.findByText("ABC Xerox");
    await user.type(screen.getByLabelText("Name"), "Rahul");
    await user.type(screen.getByLabelText("Phone"), "9876543210");
    await user.upload(
      screen.getByLabelText("Choose Files"),
      new File(["%PDF"], "notes.pdf", { type: "application/pdf" }),
    );
    fireEvent.submit(
      screen.getByRole("button", { name: "Review Order" }).closest("form")!,
    );
    await user.click(
      await screen.findByRole("button", { name: "🔒 Pay ₹21.00" }),
    );
    expect(screen.queryByText("PG-ABC234")).toBeNull();
    checkoutHandler?.({
      razorpay_order_id: "order_server_a",
      razorpay_payment_id: "pay_server_a",
      razorpay_signature: "a".repeat(64),
    });
    expect(await screen.findByText("Order PG-ABC234")).toBeTruthy();
    expect(screen.getByText("In queue")).toBeTruthy();
    expect(sessionStorage.getItem("printgo.tracking.PG-ABC234")).toBe(
      "T".repeat(43),
    );
    expect(customerApi.verifyPayment).toHaveBeenCalledOnce();
    expect(customerApi.verifyPayment).toHaveBeenCalledWith(
      "A".repeat(43),
      expect.objectContaining({
        razorpayOrderId: "order_server_a",
      }),
    );
    const verification = vi.mocked(customerApi.verifyPayment).mock
      .calls[0]?.[1];
    expect(verification?.trackingToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("reports checkout cancellation and records it with the Worker", async () => {
    const user = userEvent.setup();
    let dismiss: (() => void) | undefined;
    class MockRazorpay {
      constructor(options: Record<string, unknown>) {
        dismiss = (options.modal as { ondismiss: () => void }).ondismiss;
      }
      open() {}
      on() {}
    }
    window.Razorpay = MockRazorpay;
    vi.mocked(customerApi.createPayment).mockResolvedValueOnce({
      status: "CHECKOUT_READY",
      razorpayKeyId: "rzp_test_key",
      razorpayOrderId: "order_server_a",
      amountPaise: 2100,
      currency: "INR",
      shopName: "ABC Xerox",
      customerName: "Rahul",
      customerPhone: "9876543210",
      description: "Printing: notes.pdf",
    });
    render(<App />);
    await screen.findByText("ABC Xerox");
    await user.type(screen.getByLabelText("Name"), "Rahul");
    await user.type(screen.getByLabelText("Phone"), "9876543210");
    await user.upload(
      screen.getByLabelText("Choose Files"),
      new File(["%PDF"], "notes.pdf", { type: "application/pdf" }),
    );
    fireEvent.submit(
      screen.getByRole("button", { name: "Review Order" }).closest("form")!,
    );
    await user.click(
      await screen.findByRole("button", { name: "🔒 Pay ₹21.00" }),
    );
    dismiss?.();
    expect(
      await screen.findByText(
        /Payment was cancelled\. Your PDF is retained briefly/,
      ),
    ).toBeTruthy();
    expect(customerApi.cancelPayment).toHaveBeenCalledWith("A".repeat(43), {
      razorpayOrderId: "order_server_a",
    });
  });

  it("shows checkout failure without fabricating success", async () => {
    const user = userEvent.setup();
    let failed: (() => void) | undefined;
    class MockRazorpay {
      open() {}
      on(_event: "payment.failed", callback: () => void) {
        failed = callback;
      }
    }
    window.Razorpay = MockRazorpay;
    vi.mocked(customerApi.createPayment).mockResolvedValueOnce({
      status: "CHECKOUT_READY",
      razorpayKeyId: "rzp_test_key",
      razorpayOrderId: "order_server_a",
      amountPaise: 2100,
      currency: "INR",
      shopName: "ABC Xerox",
      customerName: "Rahul",
      customerPhone: "9876543210",
      description: "Printing: notes.pdf",
    });
    render(<App />);
    await screen.findByText("ABC Xerox");
    await user.type(screen.getByLabelText("Name"), "Rahul");
    await user.type(screen.getByLabelText("Phone"), "9876543210");
    await user.upload(
      screen.getByLabelText("Choose Files"),
      new File(["%PDF"], "notes.pdf", { type: "application/pdf" }),
    );
    fireEvent.submit(
      screen.getByRole("button", { name: "Review Order" }).closest("form")!,
    );
    await user.click(
      await screen.findByRole("button", { name: "🔒 Pay ₹21.00" }),
    );
    failed?.();
    expect(
      await screen.findByText(/Payment failed\. No print job was created/),
    ).toBeTruthy();
    expect(screen.queryByText("PG-ABC234")).toBeNull();
    expect(customerApi.verifyPayment).not.toHaveBeenCalled();
  });

  it("shows a retryable network error without opening checkout", async () => {
    const user = userEvent.setup();
    vi.mocked(customerApi.createPayment).mockRejectedValueOnce(
      new Error("Failed to fetch"),
    );
    render(<App />);
    await screen.findByText("ABC Xerox");
    await user.type(screen.getByLabelText("Name"), "Rahul");
    await user.type(screen.getByLabelText("Phone"), "9876543210");
    await user.upload(
      screen.getByLabelText("Choose Files"),
      new File(["%PDF"], "notes.pdf", { type: "application/pdf" }),
    );
    fireEvent.submit(
      screen.getByRole("button", { name: "Review Order" }).closest("form")!,
    );
    await user.click(
      await screen.findByRole("button", { name: "🔒 Pay ₹21.00" }),
    );
    expect(
      await screen.findByText(/payment service could not be reached/i),
    ).toBeTruthy();
    expect(screen.queryByText("PG-ABC234")).toBeNull();
  });

  it("renders add-on services as custom-length chips and applies selected class on toggle", async () => {
    const user = userEvent.setup();
    vi.mocked(customerApi.config).mockResolvedValueOnce({
      ...enabledConfig,
      addonServices: [
        {
          id: "svc_staple",
          name: "Stapling",
          pricingType: "FIXED_PRICE" as const,
          fixedPricePaise: 500,
        },
      ],
    });
    render(<App />);
    const stapleLabel = await screen.findByText("Stapling");
    const chip = stapleLabel.closest("label")!;
    expect(chip.className).toContain("addon-checkbox-item");
    expect(chip.className).not.toContain("selected");

    const checkbox = screen.getByRole("checkbox", { name: /stapling/i });
    await user.click(checkbox);
    expect(chip.className).toContain("selected");

    await user.click(checkbox);
    expect(chip.className).not.toContain("selected");
  });

  it("opens Pricing modal", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.queryByRole("dialog")).toBeNull();
    const pricingButton = await screen.findByRole("button", {
      name: /Pricing & Info/,
    });

    // Open Pricing modal
    await user.click(pricingButton);
    expect(
      screen.getByRole("heading", { name: "Pricing & Rates" }),
    ).toBeTruthy();
    await user.click(screen.getAllByRole("button", { name: "Close" })[0]!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders Smart Payment options when cashOrdersEnabled is true and transitions to CashWaitingPage on selection", async () => {
    const user = userEvent.setup();
    vi.mocked(customerApi.config).mockResolvedValue({
      ...enabledConfig,
      cashOrdersEnabled: true,
    });
    vi.mocked(customerApi.selectCashPayment).mockResolvedValueOnce({
      orderId: "order_cash_123",
      publicJobCode: "PG-CSH001",
      payableAmountPaise: 2100,
      cashExpiresAtMs: Date.now() + 600000,
      cashGraceUntilMs: Date.now() + 720000,
    });

    render(<App />);
    await screen.findByText("ABC Xerox");
    await user.type(screen.getByLabelText("Name"), "Rahul");
    await user.type(screen.getByLabelText("Phone"), "9876543210");
    await user.upload(
      screen.getByLabelText("Choose Files"),
      new File(["%PDF"], "notes.pdf", { type: "application/pdf" }),
    );
    fireEvent.submit(
      screen.getByRole("button", { name: "Review Order" }).closest("form")!,
    );

    // Verify both Pay Online and Pay Cash at Counter buttons appear
    const payOnlineButton = await screen.findByRole("button", {
      name: /Pay Online/i,
    });
    const payCashButton = screen.getByRole("button", {
      name: /Pay Cash at Counter/i,
    });
    expect(payOnlineButton).toBeTruthy();
    expect(payCashButton).toBeTruthy();

    // Select Cash
    await user.click(payCashButton);
    expect(customerApi.selectCashPayment).toHaveBeenCalled();
    expect(await screen.findByText("Pay Cash at Counter")).toBeTruthy();
    expect(screen.getByText("PG-CSH001")).toBeTruthy();
  });

  it("defaults to Single-sided (Simplex) for newly uploaded PDF even when duplex is supported", async () => {
    const user = userEvent.setup();
    const configWithDuplex = {
      ...enabledConfig,
      availablePrintOptions: [
        {
          paperSize: "A4" as const,
          colorMode: "BW" as const,
          sides: "DOUBLE" as const,
        },
        {
          paperSize: "A4" as const,
          colorMode: "BW" as const,
          sides: "SINGLE" as const,
        },
      ],
    };
    vi.mocked(customerApi.config).mockResolvedValue(configWithDuplex);

    render(<App />);
    await screen.findByText("ABC Xerox");
    await user.upload(
      screen.getByLabelText("Choose Files"),
      new File(["%PDF"], "sample.pdf", { type: "application/pdf" }),
    );

    const singleRadio = screen.getByRole<HTMLInputElement>("radio", {
      name: /Single-sided/i,
    });
    const doubleRadio = screen.getByRole<HTMLInputElement>("radio", {
      name: /Double-sided/i,
    });
    expect(singleRadio.checked).toBe(true);
    expect(doubleRadio.checked).toBe(false);
  });

  it("defaults multiple uploaded files to Single-sided and preserves explicitly selected duplex on file 1", async () => {
    const user = userEvent.setup();
    const configWithDuplex = {
      ...enabledConfig,
      availablePrintOptions: [
        {
          paperSize: "A4" as const,
          colorMode: "BW" as const,
          sides: "DOUBLE" as const,
        },
        {
          paperSize: "A4" as const,
          colorMode: "BW" as const,
          sides: "SINGLE" as const,
        },
      ],
    };
    vi.mocked(customerApi.config).mockResolvedValue(configWithDuplex);

    render(<App />);
    await screen.findByText("ABC Xerox");
    await user.upload(
      screen.getByLabelText("Choose Files"),
      new File(["%PDF"], "first.pdf", { type: "application/pdf" }),
    );

    // File 1 starts single-sided
    const singleRadio = screen.getByRole<HTMLInputElement>("radio", {
      name: /Single-sided/i,
    });
    const doubleRadio = screen.getByRole<HTMLInputElement>("radio", {
      name: /Double-sided/i,
    });
    expect(singleRadio.checked).toBe(true);

    // User explicitly selects Double-sided on file 1
    await user.click(doubleRadio);
    expect(doubleRadio.checked).toBe(true);

    // User uploads a second file
    await user.upload(
      screen.getByLabelText("Choose Files"),
      new File(["%PDF"], "second.pdf", { type: "application/pdf" }),
    );

    // Newly added file 2 must default to Single-sided
    const singleRadioAfter2 = screen.getByRole<HTMLInputElement>("radio", {
      name: /Single-sided/i,
    });
    const doubleRadioAfter2 = screen.getByRole<HTMLInputElement>("radio", {
      name: /Double-sided/i,
    });
    expect(singleRadioAfter2.checked).toBe(true);
    expect(doubleRadioAfter2.checked).toBe(false);

    // Switch back to file 1
    const fileSelector = screen.getByLabelText("File to configure");
    await user.selectOptions(fileSelector, "0");

    // File 1 must preserve the user's explicit Double-sided selection
    const singleRadioFile1 = screen.getByRole<HTMLInputElement>("radio", {
      name: /Single-sided/i,
    });
    const doubleRadioFile1 = screen.getByRole<HTMLInputElement>("radio", {
      name: /Double-sided/i,
    });
    expect(doubleRadioFile1.checked).toBe(true);
    expect(singleRadioFile1.checked).toBe(false);
  });

  it("disables Double-sided option with clear explanation when no duplex printer is available", async () => {
    const user = userEvent.setup();
    // enabledConfig has only sides: "SINGLE"
    render(<App />);
    await screen.findByText("ABC Xerox");
    await user.upload(
      screen.getByLabelText("Choose Files"),
      new File(["%PDF"], "sample.pdf", { type: "application/pdf" }),
    );

    const doubleRadio = screen.getByRole<HTMLInputElement>("radio", {
      name: /Double-sided/i,
    });
    expect(doubleRadio.disabled).toBe(true);
    expect(
      screen.getByText("Duplex printing unavailable on current printers"),
    ).toBeTruthy();
  });

  it("revalidates printer capabilities on Review Order and halts if duplex went offline", async () => {
    const user = userEvent.setup();
    const configWithDuplex = {
      ...enabledConfig,
      availablePrintOptions: [
        {
          paperSize: "A4" as const,
          colorMode: "BW" as const,
          sides: "DOUBLE" as const,
        },
        {
          paperSize: "A4" as const,
          colorMode: "BW" as const,
          sides: "SINGLE" as const,
        },
      ],
    };
    vi.mocked(customerApi.config).mockResolvedValue(configWithDuplex);

    render(<App />);
    await screen.findByText("ABC Xerox");
    await user.type(screen.getByLabelText("Name"), "Rahul");
    await user.type(screen.getByLabelText("Phone"), "9876543210");
    await user.upload(
      screen.getByLabelText("Choose Files"),
      new File(["%PDF"], "doc.pdf", { type: "application/pdf" }),
    );

    // User chooses Double-sided
    const doubleRadio = screen.getByRole<HTMLInputElement>("radio", {
      name: /Double-sided/i,
    });
    await user.click(doubleRadio);
    expect(doubleRadio.checked).toBe(true);

    // Now duplex printer goes offline before Review Order click
    const configWithoutDuplex = {
      ...enabledConfig,
      availablePrintOptions: [
        {
          paperSize: "A4" as const,
          colorMode: "BW" as const,
          sides: "SINGLE" as const,
        },
      ],
    };
    vi.mocked(customerApi.config).mockResolvedValue(configWithoutDuplex);

    fireEvent.submit(
      screen.getByRole("button", { name: "Review Order" }).closest("form")!,
    );

    expect(
      await screen.findByText(
        'Double-sided printing for "doc.pdf" is no longer supported by available printers. Please switch to Single-sided.',
      ),
    ).toBeTruthy();
    expect(customerApi.createDraft).not.toHaveBeenCalled();
  });

  it("handles initial config failure with clear retry button without crashing", async () => {
    vi.mocked(customerApi.config).mockRejectedValueOnce(
      new Error("Failed to fetch"),
    );
    render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "Shop Temporarily Unavailable",
      }),
    ).toBeTruthy();
    const retryBtn = screen.getByRole("button", { name: "Retry Connection" });
    expect(retryBtn).toBeTruthy();

    // Recovering after config retry
    vi.mocked(customerApi.config).mockResolvedValueOnce(enabledConfig);
    await userEvent.click(retryBtn);
    expect(await screen.findByText("ABC Xerox")).toBeTruthy();
  });

  it("validates phone number with friendly message and prevents doomed draft request", async () => {
    const user = userEvent.setup();
    vi.mocked(customerApi.config).mockResolvedValue(enabledConfig);
    render(<App />);
    await screen.findByText("ABC Xerox");

    await user.type(screen.getByLabelText("Name"), "Rahul");
    await user.type(screen.getByLabelText("Phone"), "1234");
    fireEvent.blur(screen.getByLabelText("Phone"));

    expect(
      await screen.findByText(
        "Enter a valid phone number (at least 6 digits, e.g. 9876543210 or +91 98765 43210).",
      ),
    ).toBeTruthy();

    await user.upload(
      screen.getByLabelText("Choose Files"),
      new File(["%PDF"], "doc.pdf", { type: "application/pdf" }),
    );

    fireEvent.submit(
      screen.getByRole("button", { name: "Review Order" }).closest("form")!,
    );

    expect(
      await screen.findByText(
        "Please enter a valid phone number before continuing.",
      ),
    ).toBeTruthy();
    expect(customerApi.createDraft).not.toHaveBeenCalled();
  });

  it("handles payment verification network failure with server-authoritative recovery and avoids double charge", async () => {
    const user = userEvent.setup();
    vi.mocked(customerApi.config).mockResolvedValue({
      ...enabledConfig,
      cashOrdersEnabled: true,
    });
    vi.mocked(customerApi.createDraft).mockResolvedValue({
      draftToken: "token-1",
      draftExpiresAt: "2026-09-26T00:10:00.000Z",
      fileId: "file-1",
      position: 1,
      upload: {
        uploadUrl: "https://r2.example/upload",
        expiresAt: "2026-09-26T00:05:00.000Z",
        requiredHeaders: {},
      },
    });
    vi.mocked(customerApi.quoteOrder).mockResolvedValue({
      normalizedSelectedPages: "1-10",
      selectedPageCount: 10,
      copies: 1,
      paperSize: "A4",
      colorMode: "BW",
      sides: "SINGLE",
      printingAmountPaise: 500,
      serviceChargePaise: 0,
      totalAmountPaise: 500,
      currency: "INR",
      expiresAt: "later",
      files: [],
    });
    vi.mocked(customerApi.createPayment).mockResolvedValue({
      status: "CHECKOUT_READY",
      razorpayKeyId: "rzp_test",
      razorpayOrderId: "order_rzp_1",
      amountPaise: 500,
      currency: "INR",
      shopName: "ABC Xerox",
      customerName: "Rahul",
      customerPhone: "9876543210",
      description: "Print order",
    });

    // Razorpay mock
    let capturedHandler:
      | ((response: {
          razorpay_order_id: string;
          razorpay_payment_id: string;
          razorpay_signature: string;
        }) => void)
      | undefined;
    class MockRazorpay {
      constructor(options: Record<string, unknown>) {
        capturedHandler = options.handler as typeof capturedHandler;
      }
      open() {}
      on() {}
    }
    const openSpy = vi.spyOn(MockRazorpay.prototype, "open");
    window.Razorpay = MockRazorpay;

    render(<App />);
    await screen.findByText("ABC Xerox");
    await user.type(screen.getByLabelText("Name"), "Rahul");
    await user.type(screen.getByLabelText("Phone"), "9876543210");
    await user.upload(
      screen.getByLabelText("Choose Files"),
      new File(["%PDF"], "doc.pdf", { type: "application/pdf" }),
    );

    fireEvent.submit(
      screen.getByRole("button", { name: "Review Order" }).closest("form")!,
    );
    await screen.findByText("Total Amount");

    // Network drops during verifyPayment
    vi.mocked(customerApi.verifyPayment).mockRejectedValueOnce(
      new Error("Failed to fetch"),
    );

    await user.click(screen.getByText(/Pay Online/i));
    expect(openSpy).toHaveBeenCalled();

    // Trigger Razorpay payment success handler
    act(() => {
      capturedHandler?.({
        razorpay_order_id: "order_rzp_1",
        razorpay_payment_id: "pay_1",
        razorpay_signature: "sig_1",
      });
    });

    // Verification failed due to network: shows recovery card with "Check Payment Status"
    expect(
      await screen.findByText("Payment Verification Pending"),
    ).toBeTruthy();
    const checkBtn = screen.getByRole("button", {
      name: "Check Payment Status",
    });
    expect(checkBtn).toBeTruthy();
    expect(screen.queryByText("Pay Cash at Counter")).toBeNull();

    // Server-authoritative check confirms payment capture via webhook
    vi.mocked(customerApi.getDraftStatus).mockResolvedValueOnce({
      orderId: "ord-1",
      status: "PAID",
      paymentMethod: "ONLINE",
      publicJobCode: "JOB-101",
      pickupCode: "P-101",
      cashExpiresAtMs: null,
      cashGraceUntilMs: null,
    });
    vi.mocked(customerApi.tracking).mockResolvedValueOnce({
      jobCode: "JOB-101",
      pickupCode: "P-101",
      customerName: "Rahul",
      paymentStatus: "PAYMENT_RECEIVED",
      orderStatus: "QUEUED",
      statusLabel: "In queue",
      statusMessage: "Queue",
      submittedAt: "2026-09-26T00:00:00.000Z",
      paidAt: "2026-09-26T00:01:00.000Z",
      printSummary: {
        selectedPages: "1-10",
        copies: 1,
        paperSize: "A4",
        colorMode: "BW",
        sides: "SINGLE",
      },
      amountPaidPaise: 500,
      currency: "INR",
      instructions: null,
      fileRetentionStatus: "TEMPORARILY_RETAINED",
      timeline: [],
      trackingExpiresAt: "2026-10-10T00:01:00.000Z",
    });

    await user.click(checkBtn);
    expect(customerApi.getDraftStatus).toHaveBeenCalledWith("token-1");
    // Does NOT call createPayment again (prevents double charge)
    expect(customerApi.createPayment).toHaveBeenCalledTimes(1);
  });

  describe("Payment Recovery on Page Refresh", () => {
    const user = userEvent.setup();

    it("navigates to tracking on refresh when draft status is explicitly confirmed paid/queued", async () => {
      sessionStorage.setItem("printgo.customerDraftToken", "draft-paid-123");
      vi.mocked(customerApi.getDraft).mockResolvedValueOnce({
        customerName: "Suresh Patel",
        customerPhone: "9876543210",
        instructions: "Staple together",
        status: "QUEUED",
        publicJobCode: "PG-CONF123",
        files: [],
      });

      render(<App />);
      await waitFor(() => {
        expect(customerApi.getDraft).toHaveBeenCalledWith("draft-paid-123");
      });

      // Should automatically clean up draft token from sessionStorage
      expect(sessionStorage.getItem("printgo.customerDraftToken")).toBeNull();
      // Should auto-navigate to /track/PG-CONF123
      expect(window.location.pathname).toBe("/track/PG-CONF123");
    });

    it("restores pending verification recovery card on refresh when checkout was in-flight", async () => {
      sessionStorage.setItem("printgo.customerDraftToken", "draft-pending-456");
      sessionStorage.setItem(
        "printgo.pendingTracking.order_rzp_999",
        "a".repeat(43),
      );
      vi.mocked(customerApi.getDraft).mockResolvedValueOnce({
        customerName: "Anita Rao",
        customerPhone: "9876543210",
        instructions: null,
        status: "PAYMENT_PENDING",
        publicJobCode: null,
        files: [],
      });

      render(<App />);

      // Shows the pending verification card with Check Payment Status button
      expect(
        await screen.findByText("Payment Verification Pending"),
      ).toBeTruthy();
      const checkBtn = screen.getByRole("button", {
        name: "Check Payment Status",
      });
      expect(checkBtn).toBeTruthy();

      // Clicking Check Payment Status queries server
      vi.mocked(customerApi.getDraftStatus).mockResolvedValueOnce({
        orderId: "ord-999",
        status: "PRINTING",
        paymentMethod: "ONLINE",
        publicJobCode: "PG-PRINT999",
        pickupCode: "P-999",
        cashExpiresAtMs: null,
        cashGraceUntilMs: null,
      });

      await user.click(checkBtn);
      expect(customerApi.getDraftStatus).toHaveBeenCalledWith(
        "draft-pending-456",
      );

      // Successfully transitioned to tracking page
      await waitFor(() => {
        expect(window.location.pathname).toBe("/track/P-999");
      });
      expect(sessionStorage.getItem("printgo.customerDraftToken")).toBeNull();
    });

    it("does not navigate to tracking for unpaid or payment_pending without in-flight checkout", async () => {
      sessionStorage.setItem("printgo.customerDraftToken", "draft-unpaid-789");
      vi.mocked(customerApi.getDraft).mockResolvedValueOnce({
        customerName: "Deepak Kumar",
        customerPhone: "9876543210",
        instructions: "Do not fold",
        status: "UPLOADED",
        publicJobCode: null,
        files: [
          {
            fileId: "file-789",
            originalFilename: "report.pdf",
            sizeBytes: 2048,
            sourcePageCount: 5,
            selectedPages: "ALL",
            copies: 1,
            paperSize: "A4",
            colorMode: "BW",
            sides: "SINGLE",
            printingAmountPaise: 250,
            serviceChargePaise: 0,
            uploadStatus: "UPLOADED",
          },
        ],
      });

      render(<App />);
      // Restores normal draft session
      expect(await screen.findByDisplayValue("Deepak Kumar")).toBeTruthy();
      expect(screen.getByDisplayValue("9876543210")).toBeTruthy();
      expect(screen.getByText("report.pdf")).toBeTruthy();
      // Does NOT navigate to tracking
      expect(window.location.pathname).toBe("/");
    });

    it("purges draftToken on refresh when draft has expired", async () => {
      sessionStorage.setItem("printgo.customerDraftToken", "draft-expired-000");
      vi.mocked(customerApi.getDraft).mockRejectedValueOnce(
        new Error("DRAFT_EXPIRED"),
      );

      render(<App />);
      await waitFor(() => {
        expect(sessionStorage.getItem("printgo.customerDraftToken")).toBeNull();
      });
      // Renders clean upload form
      expect(screen.getByText("Upload PDFs")).toBeTruthy();
      expect(window.location.pathname).toBe("/");
    });

    it("securely renders PublicTrackingPage when private tracking token is missing on refresh", async () => {
      sessionStorage.setItem(
        "printgo.customerDraftToken",
        "draft-webhook-paid",
      );
      vi.mocked(customerApi.getDraft).mockResolvedValueOnce({
        customerName: "Anonymous Customer",
        customerPhone: "9876543210",
        instructions: null,
        status: "QUEUED",
        publicJobCode: "PG-PUB123",
        files: [],
      });
      vi.mocked(customerApi.trackPublic).mockResolvedValueOnce({
        pickupCode: "PG-PUB123",
        status: "QUEUED",
        statusLabel: "In queue",
        statusMessage: "Your order is queued for printing.",
        isPriority: false,
        totalFiles: 1,
        completedFiles: 0,
        identificationRequired: false,
        createdAt: new Date().toISOString(),
        completedAt: null,
      });

      render(<App />);
      await waitFor(() => {
        expect(window.location.pathname).toBe("/track/PG-PUB123");
      });

      // Renders public tracking without exposing PII
      expect(
        await screen.findByText("Your order is queued for printing."),
      ).toBeTruthy();
      expect(screen.queryByText("Anonymous Customer")).toBeNull();
      expect(screen.queryByText("9876543210")).toBeNull();
    });

    it("promotes pending tracking token and handles repeated refreshes seamlessly", async () => {
      const privateTrackingToken = "t".repeat(43);
      sessionStorage.setItem(
        "printgo.customerDraftToken",
        "draft-double-refresh",
      );
      sessionStorage.setItem(
        "printgo.pendingTracking.order_double",
        privateTrackingToken,
      );
      vi.mocked(customerApi.getDraft).mockResolvedValueOnce({
        customerName: "Meera Nair",
        customerPhone: "9876543210",
        instructions: null,
        status: "PRINTING",
        publicJobCode: "PG-MEERA1",
        files: [],
      });

      const { unmount } = render(<App />);
      await waitFor(() => {
        expect(window.location.pathname).toBe("/track/PG-MEERA1");
      });

      // Pending token promoted to permanent tracking storage key
      expect(sessionStorage.getItem("printgo.tracking.PG-MEERA1")).toBe(
        privateTrackingToken,
      );
      expect(
        sessionStorage.getItem("printgo.pendingTracking.order_double"),
      ).toBeNull();
      expect(sessionStorage.getItem("printgo.customerDraftToken")).toBeNull();

      unmount();

      // Second refresh: window.location.pathname is already /track/PG-MEERA1
      render(<App />);
      await waitFor(() => {
        expect(customerApi.tracking).toHaveBeenCalledWith(
          "PG-MEERA1",
          privateTrackingToken,
        );
      });
    });
  });

  describe("live checkout editing & zero extra D1 writes", () => {
    it("keeps customer details and upload inputs unlocked after review", async () => {
      const user = userEvent.setup();
      render(<App />);
      await screen.findByText("ABC Xerox");
      await user.type(screen.getByLabelText("Name"), "Rahul");
      await user.type(screen.getByLabelText("Phone"), "9876543210");
      await user.upload(
        screen.getByLabelText("Choose Files"),
        new File(["%PDF"], "notes.pdf", { type: "application/pdf" }),
      );
      await screen.findAllByText(/10 pages/);
      fireEvent.submit(
        screen.getByRole("button", { name: "Review Order" }).closest("form")!,
      );

      // Quote appears
      expect(await screen.findByText("₹21.00")).toBeTruthy();

      // Step 1 and Step 2 inputs remain unlocked!
      const nameInput = screen.getByLabelText<HTMLInputElement>("Name");
      const phoneInput = screen.getByLabelText<HTMLInputElement>("Phone");
      const fileInput = screen.getByLabelText<HTMLInputElement>("Choose Files");

      expect(nameInput.disabled).toBe(false);
      expect(phoneInput.disabled).toBe(false);
      expect(fileInput.disabled).toBe(false);
    });

    it("reflects live edits to customer name without clearing quote or calling quoteOrder", async () => {
      const user = userEvent.setup();
      render(<App />);
      await screen.findByText("ABC Xerox");
      await user.type(screen.getByLabelText("Name"), "Rahul");
      await user.type(screen.getByLabelText("Phone"), "9876543210");
      await user.upload(
        screen.getByLabelText("Choose Files"),
        new File(["%PDF"], "notes.pdf", { type: "application/pdf" }),
      );
      await screen.findAllByText(/10 pages/);
      fireEvent.submit(
        screen.getByRole("button", { name: "Review Order" }).closest("form")!,
      );

      expect(await screen.findByText("₹21.00")).toBeTruthy();
      expect(customerApi.quoteOrder).toHaveBeenCalledTimes(1);

      // Edit name
      const nameInput = screen.getByLabelText("Name");
      await user.clear(nameInput);
      await user.type(nameInput, "Rahul Sharma");

      // Review summary immediately reflects updated name
      expect(await screen.findByText(/Rahul Sharma/)).toBeTruthy();
      // Quote is NOT cleared!
      expect(screen.getByText("₹21.00")).toBeTruthy();
      // Zero extra D1 writes (quoteOrder was NOT called again)
      expect(customerApi.quoteOrder).toHaveBeenCalledTimes(1);
    });

    it("automatically recalculates preview quote when copies change without extra D1 writes", async () => {
      const user = userEvent.setup();
      vi.mocked(customerApi.previewQuoteOrder).mockResolvedValueOnce({
        normalizedSelectedPages: "1-10",
        selectedPageCount: 10,
        copies: 2,
        paperSize: "A4",
        colorMode: "BW",
        sides: "SINGLE",
        printingAmountPaise: 4000,
        serviceChargePaise: 100,
        totalAmountPaise: 4100,
        currency: "INR",
        expiresAt: "later",
      });

      render(<App />);
      await screen.findByText("ABC Xerox");
      await user.type(screen.getByLabelText("Name"), "Rahul");
      await user.type(screen.getByLabelText("Phone"), "9876543210");
      await user.upload(
        screen.getByLabelText("Choose Files"),
        new File(["%PDF"], "notes.pdf", { type: "application/pdf" }),
      );
      await screen.findAllByText(/10 pages/);
      fireEvent.submit(
        screen.getByRole("button", { name: "Review Order" }).closest("form")!,
      );

      expect(await screen.findByText("₹21.00")).toBeTruthy();
      expect(customerApi.quoteOrder).toHaveBeenCalledTimes(1);

      // Change copies
      const copiesInput = screen.getByRole("spinbutton", { name: /copies/i });
      fireEvent.change(copiesInput, { target: { value: "2" } });

      // Debounced previewQuoteOrder fires (zero D1 writes)
      await waitFor(() => {
        expect(customerApi.previewQuoteOrder).toHaveBeenCalledWith(
          "A".repeat(43),
          expect.objectContaining({
            files: [expect.objectContaining({ copies: 2 })],
          }),
        );
      });

      // Total updates to ₹41.00
      expect(await screen.findByText("₹41.00")).toBeTruthy();
      // Still only 1 D1 write from initial review!
      expect(customerApi.quoteOrder).toHaveBeenCalledTimes(1);
    });

    it("automatically uploads newly added PDFs and updates the preview total", async () => {
      const user = userEvent.setup();
      vi.mocked(customerApi.previewQuoteOrder).mockResolvedValueOnce({
        normalizedSelectedPages: "1-10",
        selectedPageCount: 10,
        copies: 1,
        paperSize: "A4",
        colorMode: "BW",
        sides: "SINGLE",
        printingAmountPaise: 4000,
        serviceChargePaise: 200,
        totalAmountPaise: 4200,
        currency: "INR",
        expiresAt: "later",
        files: [
          {
            fileId: "10000000-0000-4000-8000-000000000001",
            originalFilename: "notes.pdf",
            sizeBytes: 1024,
            sourcePageCount: 10,
            uploadStatus: "UPLOADED",
            printingAmountPaise: 2000,
            serviceChargePaise: 100,
            copies: 1,
            paperSize: "A4",
            colorMode: "BW",
            sides: "SINGLE",
            selectedPages: "1-10",
            selectedPageCount: 10,
          },
          {
            fileId: "20000000-0000-4000-8000-000000000002",
            originalFilename: "diagrams.pdf",
            sizeBytes: 1024,
            sourcePageCount: 10,
            uploadStatus: "UPLOADED",
            printingAmountPaise: 2000,
            serviceChargePaise: 100,
            copies: 1,
            paperSize: "A4",
            colorMode: "BW",
            sides: "SINGLE",
            selectedPages: "1-10",
            selectedPageCount: 10,
          },
        ],
      });

      render(<App />);
      await screen.findByText("ABC Xerox");
      await user.type(screen.getByLabelText("Name"), "Rahul");
      await user.type(screen.getByLabelText("Phone"), "9876543210");
      await user.upload(
        screen.getByLabelText("Choose Files"),
        new File(["%PDF"], "notes.pdf", { type: "application/pdf" }),
      );
      await screen.findAllByText(/10 pages/);
      fireEvent.submit(
        screen.getByRole("button", { name: "Review Order" }).closest("form")!,
      );

      expect(await screen.findByText("₹21.00")).toBeTruthy();

      // Add a second PDF while in Review
      await user.upload(
        screen.getByLabelText("Choose Files"),
        new File(["%PDF"], "diagrams.pdf", { type: "application/pdf" }),
      );

      // Verify second file was automatically uploaded
      await waitFor(() => {
        expect(customerApi.addFile).toHaveBeenCalledWith(
          "A".repeat(43),
          expect.objectContaining({ originalFilename: "diagrams.pdf" }),
        );
        expect(customerApi.complete).toHaveBeenCalledWith(
          "A".repeat(43),
          "20000000-0000-4000-8000-000000000002",
        );
      });

      // Preview quote recalculates with both files
      await waitFor(() => {
        expect(customerApi.previewQuoteOrder).toHaveBeenCalled();
      });
      expect(await screen.findByText("₹42.00")).toBeTruthy();
      expect(screen.getByText("Files (2)")).toBeTruthy();
    });

    it("persists the final edited configuration to D1 exactly once when payment is initiated", async () => {
      const user = userEvent.setup();
      vi.mocked(customerApi.quoteOrder)
        .mockResolvedValueOnce({
          normalizedSelectedPages: "1-10",
          selectedPageCount: 10,
          copies: 1,
          paperSize: "A4",
          colorMode: "BW",
          sides: "SINGLE",
          printingAmountPaise: 2000,
          serviceChargePaise: 100,
          totalAmountPaise: 2100,
          currency: "INR",
          expiresAt: "later",
        })
        .mockResolvedValueOnce({
          normalizedSelectedPages: "1-10",
          selectedPageCount: 10,
          copies: 3,
          paperSize: "A4",
          colorMode: "BW",
          sides: "SINGLE",
          printingAmountPaise: 6000,
          serviceChargePaise: 100,
          totalAmountPaise: 6100,
          currency: "INR",
          expiresAt: "later",
        });

      vi.mocked(customerApi.createPayment).mockResolvedValueOnce({
        status: "CHECKOUT_READY",
        razorpayKeyId: "rzp_test_key",
        razorpayOrderId: "order_test_123",
        amountPaise: 6100,
        currency: "INR",
        shopName: "ABC Xerox",
        customerName: "Rahul Sharma",
        customerPhone: "9876543210",
        description: "Printing",
      });

      render(<App />);
      await screen.findByText("ABC Xerox");
      await user.type(screen.getByLabelText("Name"), "Rahul");
      await user.type(screen.getByLabelText("Phone"), "9876543210");
      await user.upload(
        screen.getByLabelText("Choose Files"),
        new File(["%PDF"], "notes.pdf", { type: "application/pdf" }),
      );
      await screen.findAllByText(/10 pages/);
      fireEvent.submit(
        screen.getByRole("button", { name: "Review Order" }).closest("form")!,
      );

      expect(await screen.findByText("₹21.00")).toBeTruthy();
      expect(customerApi.quoteOrder).toHaveBeenCalledTimes(1);

      // User edits name and copies while in review
      const nameInput = screen.getByLabelText("Name");
      await user.clear(nameInput);
      await user.type(nameInput, "Rahul Sharma");

      const copiesInput = screen.getByRole("spinbutton", { name: /copies/i });
      fireEvent.change(copiesInput, { target: { value: "3" } });

      // Wait for debounced preview recalculation to complete and enable the button
      await waitFor(() => {
        expect(customerApi.previewQuoteOrder).toHaveBeenCalled();
      });

      // User clicks Pay button
      const payButton = await screen.findByRole("button", {
        name: /Pay/i,
      });
      await waitFor(() => {
        expect((payButton as HTMLButtonElement).disabled).toBe(false);
      });
      await user.click(payButton);

      // quoteOrder was called exactly ONCE more with the final persisted details!
      await waitFor(() => {
        expect(customerApi.quoteOrder).toHaveBeenCalledTimes(2);
        expect(customerApi.quoteOrder).toHaveBeenLastCalledWith(
          "A".repeat(43),
          expect.objectContaining({
            customerName: "Rahul Sharma",
            customerPhone: "9876543210",
            files: [expect.objectContaining({ copies: 3 })],
          }),
        );
      });

      // createPayment received the matching acknowledgedTotalPaise
      expect(customerApi.createPayment).toHaveBeenCalledWith(
        "A".repeat(43),
        expect.objectContaining({
          acknowledgedTotalPaise: 6100,
        }),
      );
    });

    it("resolves cold cloud files reporting 0 bytes initially on first selection and uploads without error", async () => {
      const user = userEvent.setup();
      render(<App />);
      await screen.findByText("ABC Xerox");

      // Create a file whose .size property reports 0 (simulating iCloud / cold cloud stream placeholder)
      // but whose arrayBuffer() resolves valid PDF bytes
      const samplePdfContent = new TextEncoder().encode(
        "%PDF-1.4 test content",
      );
      const zeroSizeFile = new File([], "cloud-doc.pdf", {
        type: "application/pdf",
      });
      Object.defineProperty(zeroSizeFile, "size", {
        value: 0,
        configurable: true,
      });
      zeroSizeFile.arrayBuffer = vi
        .fn()
        .mockResolvedValue(samplePdfContent.buffer);

      await user.upload(screen.getByLabelText("Choose Files"), zeroSizeFile);

      // Verify inspectPdf was called and file was successfully added without size error
      await waitFor(() => {
        expect(screen.getByText("cloud-doc.pdf")).toBeTruthy();
      });
      expect(screen.queryByText(/PDFs must be between 1 byte and/)).toBeNull();
    });

    it("rejects truly empty 0-byte PDFs with a clear error message", async () => {
      const user = userEvent.setup();
      render(<App />);
      await screen.findByText("ABC Xerox");

      const emptyFile = new File([], "empty.pdf", {
        type: "application/pdf",
      });
      Object.defineProperty(emptyFile, "size", {
        value: 0,
        configurable: true,
      });
      emptyFile.arrayBuffer = vi.fn().mockResolvedValue(new ArrayBuffer(0));

      await user.upload(screen.getByLabelText("Choose Files"), emptyFile);

      expect(
        await screen.findByText(/PDFs must be between 1 byte and/),
      ).toBeTruthy();
    });

    it("renders compact two-column print settings for pages, paper size, colour, sides, and copies", async () => {
      const user = userEvent.setup();
      render(<App />);
      await screen.findByText("ABC Xerox");
      await user.upload(
        screen.getByLabelText("Choose Files"),
        new File(["%PDF-test"], "doc.pdf", { type: "application/pdf" }),
      );

      // Verify all two-column option controls
      expect(screen.getByRole("radio", { name: "All pages" })).toBeTruthy();
      expect(screen.getByRole("radio", { name: "Custom range" })).toBeTruthy();
      expect(screen.getByRole("radio", { name: "A4" })).toBeTruthy();
      expect(screen.getByRole("radio", { name: /A3/ })).toBeTruthy();
      expect(
        screen.getByRole("radio", { name: /Black & white/i }),
      ).toBeTruthy();
      expect(screen.getByRole("radio", { name: /Colour/i })).toBeTruthy();
      expect(screen.getByRole("radio", { name: /Single-sided/i })).toBeTruthy();
      expect(screen.getByRole("radio", { name: /Double-sided/i })).toBeTruthy();
      expect(screen.getByRole("spinbutton", { name: /copies/i })).toBeTruthy();

      // Switch to custom range and verify input appears
      await user.click(screen.getByLabelText("Custom range"));
      expect(await screen.findByLabelText("Custom pages")).toBeTruthy();
    });
  });
});
