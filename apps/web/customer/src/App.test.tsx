// @vitest-environment jsdom

import {
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
    createPayment: vi.fn(),
    verifyPayment: vi.fn(),
    cancelPayment: vi.fn(),
    tracking: vi.fn(),
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
      screen.getByRole("button", { name: "Confirming payment…" }),
    ).toHaveProperty("disabled", true);
    await user.click(
      screen.getByRole("button", { name: "Confirming payment…" }),
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
      razorpayOrderId: "order_server_a", trackingToken: expect.any(String),
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
        razorpayOrderId: "order_server_a", trackingToken: expect.any(String),
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
      razorpayOrderId: "order_server_a", trackingToken: expect.any(String),
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
      razorpayOrderId: "order_server_a", trackingToken: expect.any(String),
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
      razorpayOrderId: "order_server_a", trackingToken: expect.any(String),
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
});
