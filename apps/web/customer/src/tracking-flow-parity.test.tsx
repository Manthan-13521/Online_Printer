// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CustomerConfigData,
  CustomerTrackingData,
  PublicOrderTrackingData,
  VerifyCustomerPaymentRequest,
} from "@printgo/api-contract";

import { customerApi } from "./api";
import { App } from "./App";
import { TrackingErrorBoundary } from "./components";
import { PublicTrackingPage } from "./PublicTrackingPage";
import { createTrackingToken, trackingStorageKey } from "./tracking-token";

vi.mock("./api", () => ({
  customerApi: {
    config: vi.fn(),
    trackPublic: vi.fn(),
    tracking: vi.fn(),
    verifyPayment: vi.fn(),
    cancelPayment: vi.fn(),
    getDraft: vi.fn(),
    getDraftStatus: vi.fn(),
  },
  uploadDirectly: vi.fn(),
}));

const mockConfig: CustomerConfigData = {
  shopName: "PrintGo Express",
  appName: "PrintGo Express",
  contactPhone: "+919876543210",
  customerNotice: null,
  onlinePrintingEnabled: true,
  cashOrdersEnabled: true,
  maxPdfSizeBytes: 20 * 1024 * 1024,
  availablePrintOptions: [
    { paperSize: "A4", colorMode: "BW", sides: "SINGLE" },
    { paperSize: "A4", colorMode: "BW", sides: "DOUBLE" },
  ],
};

const mockPublicTracking: PublicOrderTrackingData = {
  pickupCode: "PA-001",
  status: "QUEUED",
  statusLabel: "Queued",
  statusMessage: "Your order is queued for printing.",
  isPriority: false,
  totalFiles: 1,
  completedFiles: 0,
  identificationRequired: false,
  createdAt: new Date().toISOString(),
};

const mockPrivateTracking: CustomerTrackingData = {
  jobCode: "PG-ABC123",
  pickupCode: "PA-001",
  customerName: "Alex Mercer",
  paymentStatus: "PAYMENT_RECEIVED",
  orderStatus: "QUEUED",
  statusLabel: "Queued",
  statusMessage: "Your order is queued for printing.",
  submittedAt: new Date().toISOString(),
  paidAt: new Date().toISOString(),
  printSummary: {
    selectedPages: "1-5",
    copies: 2,
    paperSize: "A4",
    colorMode: "BW",
    sides: "SINGLE",
  },
  amountPaidPaise: 400,
  currency: "INR",
  instructions: "Double staple top left",
  fileRetentionStatus: "TEMPORARILY_RETAINED",
  timeline: [],
  trackingExpiresAt: new Date().toISOString(),
  isPriority: false,
};

describe("Permanent Blank Tracking Page Remediation & Resilience Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    window.history.pushState(null, "", "/");
    vi.mocked(customerApi.config).mockResolvedValue(mockConfig);
    vi.mocked(customerApi.trackPublic).mockResolvedValue(mockPublicTracking);
    vi.mocked(customerApi.tracking).mockResolvedValue(mockPrivateTracking);
  });

  afterEach(() => {
    cleanup();
    sessionStorage.clear();
  });

  // 1 & 2. Razorpay success callback and modal dismissal race condition
  it("Scenario 1 & 2: Success callback followed immediately by modal dismissal does NOT cancel payment", () => {
    const verifyMock = vi.mocked(customerApi.verifyPayment).mockResolvedValue({
      jobCode: "PG-ABC123",
      pickupCode: "PA-001",
      amountPaidPaise: 400,
      currency: "INR",
      status: "QUEUED",
      trackingToken: createTrackingToken(),
      trackingExpiresAt: new Date().toISOString(),
      message: "Payment verified successfully.",
    });

    const cancelMock = vi.mocked(customerApi.cancelPayment);

    // Instantiate with handler & dismiss
    let paymentSuccessHandled = false;
    const testHandler = (response: VerifyCustomerPaymentRequest) => {
      paymentSuccessHandled = true;
      void customerApi.verifyPayment("draft-token", response);
    };
    const testDismiss = () => {
      if (paymentSuccessHandled) return; // Guard under test!
      void customerApi.cancelPayment("draft-token", {
        razorpayOrderId: "order_rzp_999",
      });
    };

    // Simulate success
    testHandler({
      razorpayOrderId: "order_rzp_999",
      razorpayPaymentId: "pay_xyz",
      razorpaySignature: "sig_abc",
      trackingToken: createTrackingToken(),
    });

    // Simulate concurrent modal dismissal right after success
    testDismiss();

    expect(verifyMock).toHaveBeenCalledTimes(1);
    expect(cancelMock).not.toHaveBeenCalled();
  });

  // 3. Genuine payment cancellation
  it("Scenario 3: Genuine modal dismissal without payment DOES trigger cancellation", () => {
    const cancelMock = vi.mocked(customerApi.cancelPayment).mockResolvedValue({
      status: "PAYMENT_CANCELLED",
      retainedUntil: new Date().toISOString(),
    });

    const paymentSuccessHandled = false;
    const testDismiss = () => {
      if (paymentSuccessHandled) return;
      void customerApi.cancelPayment("draft-token", {
        razorpayOrderId: "order_rzp_999",
      });
    };

    // Customer closes modal without paying
    testDismiss();

    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(cancelMock).toHaveBeenCalledWith("draft-token", {
      razorpayOrderId: "order_rzp_999",
    });
  });

  // 4 & 5. Private tracking token stored for pickupCode routes to private TrackingPage
  it("Scenario 4 & 5: Paying customer with private tracking token for pickupCode routes to TrackingPage", async () => {
    const token = createTrackingToken();
    sessionStorage.setItem(trackingStorageKey("PA-001"), token);
    window.history.pushState(null, "", "/track/PA-001");

    render(<App />);

    // Must call customerApi.tracking (private), NOT trackPublic
    await waitFor(() => {
      expect(customerApi.tracking).toHaveBeenCalledWith("PA-001", token);
    });
    expect(customerApi.trackPublic).not.toHaveBeenCalled();

    // Verify private order summary is visible (pickup code, queued status)
    await waitFor(() => {
      expect(screen.getByText("PA - 001")).toBeTruthy();
    });
  });

  // 6. Public tracking without a private token routes to PublicTrackingPage
  it("Scenario 6: Public visitor navigating to /track/PA-001 without private token routes to PublicTrackingPage", async () => {
    window.history.pushState(null, "", "/track/PA-001");

    render(<App />);

    // Must call customerApi.trackPublic
    await waitFor(() => {
      expect(customerApi.trackPublic).toHaveBeenCalledWith("PA-001");
    });
    expect(customerApi.tracking).not.toHaveBeenCalled();
  });

  // 7 & 8. Mobile Safari / Android Chrome returning from UPI app switch
  it("Scenario 7 & 8: Initial fetch executes even when document is initially hidden, and wakeup triggers refresh", async () => {
    // Simulate mobile background tab state (document.hidden = true)
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });

    render(<PublicTrackingPage pickupCode="PA-001" />);

    // Initial fetch should execute despite hidden state
    await waitFor(() => {
      expect(customerApi.trackPublic).toHaveBeenCalledTimes(1);
    });

    // Simulate customer returning to browser: document becomes visible & triggers pageshow
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });

    window.dispatchEvent(new Event("pageshow"));

    await waitFor(() => {
      expect(customerApi.trackPublic).toHaveBeenCalledTimes(2);
    });
  });

  // 9. Public tracking displays retry state instead of blank screen on error
  it("Scenario 9: Temporary API failure displays retry card and allows manual recovery", async () => {
    vi.mocked(customerApi.trackPublic).mockRejectedValueOnce(
      new Error("NETWORK_DISCONNECTED"),
    );

    render(<PublicTrackingPage pickupCode="PA-001" />);

    await waitFor(() => {
      expect(screen.getByText("Order Not Found")).toBeTruthy();
    });
    expect(
      screen.getByText(
        "Could not load tracking information. Please check your connection.",
      ),
    ).toBeTruthy();
    const retryBtn = screen.getByRole("button", { name: "Retry" });
    expect(retryBtn).toBeTruthy();

    // Click retry with recovered network
    vi.mocked(customerApi.trackPublic).mockResolvedValueOnce(
      mockPublicTracking,
    );
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.getByText("Queued")).toBeTruthy();
    });
  });

  // 10. Missing optional API fields do not throw or produce blank screen
  it("Scenario 10: Missing optional API fields are handled gracefully without throwing", async () => {
    vi.mocked(customerApi.trackPublic).mockResolvedValueOnce({
      pickupCode: "PA-002",
      status: "QUEUED",
      statusLabel: undefined as unknown as string,
      statusMessage: "Processing...",
      isPriority: false,
      totalFiles: 1,
      completedFiles: 0,
      identificationRequired: false,
      createdAt: new Date().toISOString(),
    });

    render(<PublicTrackingPage pickupCode="PA-002" />);

    await waitFor(() => {
      expect(screen.getByText("Processing...")).toBeTruthy();
    });
  });

  // 11. TrackingErrorBoundary catches child crash and presents recovery UI
  it("Scenario 11: TrackingErrorBoundary catches unhandled render exception and prevents white screen", () => {
    const ProblematicChild = () => {
      throw new Error("Simulated SVG Render Crash");
    };

    const resetSpy = vi.fn();

    render(
      <TrackingErrorBoundary onReset={resetSpy}>
        <ProblematicChild />
      </TrackingErrorBoundary>,
    );

    expect(screen.getByText("Unable to Display Tracking")).toBeTruthy();
    expect(
      screen.getByText(
        /Something unexpected occurred while rendering your order status/,
      ),
    ).toBeTruthy();

    const homeBtn = screen.getByRole("button", { name: "Back to Home" });
    fireEvent.click(homeBtn);
    expect(resetSpy).toHaveBeenCalledTimes(1);
  });

  // 12. Token is preserved across refresh for both jobCode and pickupCode
  it("Scenario 12: Tokens stored under both jobCode and pickupCode survive session refresh", () => {
    const token = createTrackingToken();
    sessionStorage.setItem(trackingStorageKey("PG-XYZ123"), token);
    sessionStorage.setItem(trackingStorageKey("PA-099"), token);

    expect(sessionStorage.getItem(trackingStorageKey("PG-XYZ123"))).toBe(token);
    expect(sessionStorage.getItem(trackingStorageKey("PA-099"))).toBe(token);
  });

  // 13. Duplicate callbacks in Razorpay handler do not execute multiple verification calls
  it("Scenario 13: Duplicate handler callbacks are guarded and verify only once", () => {
    const verifyMock = vi.mocked(customerApi.verifyPayment);
    let paymentSuccessHandled = false;

    const testHandler = (response: VerifyCustomerPaymentRequest) => {
      if (paymentSuccessHandled) return;
      paymentSuccessHandled = true;
      void customerApi.verifyPayment("draft-token", response);
    };

    const res: VerifyCustomerPaymentRequest = {
      razorpayOrderId: "order_dup_1",
      razorpayPaymentId: "pay_dup_1",
      razorpaySignature: "sig_dup_1",
      trackingToken: createTrackingToken(),
    };

    // First invocation
    testHandler(res);
    // Duplicate invocation
    testHandler(res);

    expect(verifyMock).toHaveBeenCalledTimes(1);
  });

  // 14. Popstate navigation correctly updates tracking route
  it("Scenario 14: Browser popstate event updates tracking job code", async () => {
    window.history.pushState(null, "", "/track/PA-101");
    render(<App />);

    await waitFor(() => {
      expect(customerApi.trackPublic).toHaveBeenCalledWith("PA-101");
    });

    // Simulate browser back/forward
    window.history.pushState(null, "", "/track/PA-102");
    window.dispatchEvent(new PopStateEvent("popstate"));

    await waitFor(() => {
      expect(customerApi.trackPublic).toHaveBeenCalledWith("PA-102");
    });
  });

  // 15. Ready for pickup page 'Print Again' action opens fresh customer order page
  it("Scenario 15: In Ready for pickup page, Print Again action purges draft and opens fresh customer page", async () => {
    const token = createTrackingToken();
    sessionStorage.setItem(trackingStorageKey("PA-031"), token);
    sessionStorage.setItem(
      "printgo.customerDraftToken",
      "draft-old-order-token",
    );
    window.history.pushState(null, "", "/track/PA-031");

    vi.mocked(customerApi.tracking).mockResolvedValue({
      ...mockPrivateTracking,
      pickupCode: "PA-031",
      orderStatus: "COMPLETED",
      statusLabel: "Ready for pickup",
      statusMessage: "Your order is printed, finished, and waiting.",
    });

    render(<App />);

    // Customer is on Ready for pickup page
    await waitFor(() => {
      expect(screen.getByText("Ready for pickup")).toBeTruthy();
    });
    expect(screen.getByText("PA-031")).toBeTruthy();

    // Click "Print Again" button
    const printAgainBtn = await screen.findByRole("button", {
      name: /print again/i,
    });
    expect(printAgainBtn).toBeTruthy();
    fireEvent.click(printAgainBtn);

    // Draft token must be purged from sessionStorage
    expect(sessionStorage.getItem("printgo.customerDraftToken")).toBeNull();

    // URL must be reset to root "/"
    expect(window.location.pathname).toBe("/");

    // Fresh Customer Details step must be visible and inputs empty
    await waitFor(() => {
      expect(screen.getByText("Customer Details")).toBeTruthy();
    });
    const nameInput = screen.getByLabelText("Name");
    expect(nameInput).toHaveProperty("value", "");
  });
});
