// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CustomerConfigData,
  CustomerQuoteData,
} from "@printgo/api-contract";
import {
  BowingStaffIllustration,
  CustomerDetailsStep,
  CustomerPrivacyFooter,
  FloatingLoadingIndicator,
  OrderReviewSummary,
  PricingModal,
  PrintSettingsStep,
  ShopHeader,
  ShopInfoModal,
  ShopUnavailableState,
  UploadPdfsStep,
  WhatsAppFloatingButton,
  customerErrorMessage,
  humanFileSize,
  isValidPhone,
  paymentErrorMessage,
  type LocalOrderFile,
} from "./index";

describe("Customer Components & Helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  describe("customer-types helpers", () => {
    it("isValidPhone validates phone numbers correctly", () => {
      expect(isValidPhone("9876543210")).toBe(true);
      expect(isValidPhone("+91 98765 43210")).toBe(true);
      expect(isValidPhone("022-23456789")).toBe(true);
      expect(isValidPhone("123")).toBe(false);
      expect(isValidPhone("abc")).toBe(false);
      expect(isValidPhone("")).toBe(false);
    });

    it("humanFileSize converts bytes to MB string", () => {
      expect(humanFileSize(1024 * 1024)).toBe("1.0 MB");
      expect(humanFileSize(5.5 * 1024 * 1024)).toBe("5.5 MB");
    });

    it("customerErrorMessage returns friendly strings", () => {
      expect(
        customerErrorMessage(new Error("ONLINE_PRINTING_DISABLED")),
      ).toContain("Online printing was switched off");
      expect(customerErrorMessage(new Error("CASH_ORDERS_DISABLED"))).toContain(
        "Cash orders are currently disabled",
      );
      expect(customerErrorMessage(new Error("PRINTER_NOT_READY"))).toContain(
        "printer is currently not ready",
      );
      expect(customerErrorMessage(new Error("DRAFT_EXPIRED"))).toContain(
        "upload session expired",
      );
      expect(customerErrorMessage(new Error("CUSTOM_ERROR_MSG"))).toBe(
        "CUSTOM_ERROR_MSG",
      );
    });

    it("paymentErrorMessage returns friendly payment errors", () => {
      expect(paymentErrorMessage(new Error("PRINTER_NOT_READY"))).toContain(
        "Online payment is temporarily unavailable",
      );
      expect(paymentErrorMessage(new Error("PAYMENT_NOT_CAPTURED"))).toContain(
        "Payment is still being confirmed",
      );
      expect(paymentErrorMessage(new Error("CHECKOUT_LOAD_FAILED"))).toContain(
        "secure payment window could not be loaded",
      );
      expect(
        paymentErrorMessage(new Error("TRACKING_ACCESS_UNAVAILABLE")),
      ).toContain("Payment was received, but tracking confirmation");
    });
  });

  describe("ShopHeader", () => {
    const mockConfig = {
      shopName: "QuickPrint Central",
      logoUrl: null,
    } as unknown as CustomerConfigData;

    it("renders shop name, track input and triggers handlers", () => {
      const handleTrackChange = vi.fn();
      const handleTrackSubmit = vi.fn((e: React.FormEvent) => {
        e.preventDefault();
      });
      const handleOpenPricing = vi.fn();

      render(
        <ShopHeader
          config={mockConfig}
          trackBoxCode="PA-123"
          onTrackBoxCodeChange={handleTrackChange}
          onTrackSubmit={handleTrackSubmit}
          onOpenPricing={handleOpenPricing}
        />,
      );

      expect(screen.getByText("QuickPrint Central")).toBeTruthy();
      expect(screen.getByText("Upload & Print Instantly")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: /pricing & info/i }));
      expect(handleOpenPricing).toHaveBeenCalled();

      const trackInput = screen.getByPlaceholderText(/track your order/i);
      fireEvent.change(trackInput, { target: { value: "PA-999" } });
      expect(handleTrackChange).toHaveBeenCalledWith("PA-999");

      fireEvent.click(screen.getByRole("button", { name: /track/i }));
      expect(handleTrackSubmit).toHaveBeenCalled();
    });
  });

  describe("PricingModal", () => {
    const mockConfig = {
      availablePrintOptions: [
        {
          paperSize: "A4",
          colorMode: "BW",
          sides: "SINGLE",
          pricePerPagePaise: 200,
        },
        {
          paperSize: "A4",
          colorMode: "COLOR",
          sides: "DOUBLE",
          pricePerPagePaise: 1000,
        },
      ],
      addonServices: [
        {
          id: "add-1",
          name: "Spiral Binding",
          pricingType: "FIXED",
          fixedPricePaise: 3000,
        },
      ],
      priorityPrinting: { enabled: true, feePaise: 2000 },
      discountRules: [
        { id: "disc-1", minSubtotalPaise: 10000, discountPercent: 10 },
      ],
    } as unknown as CustomerConfigData;

    it("renders pricing modal with rates and triggers close", () => {
      const handleClose = vi.fn();

      render(
        <PricingModal
          isOpen={true}
          config={mockConfig}
          onClose={handleClose}
        />,
      );

      expect(
        screen.getByRole("dialog", { name: /pricing & rates/i }),
      ).toBeTruthy();
      expect(screen.getByText("₹2.00 / page")).toBeTruthy();
      expect(screen.getByText("Spiral Binding")).toBeTruthy();
      expect(screen.getByText("10% OFF")).toBeTruthy();

      fireEvent.click(screen.getAllByRole("button", { name: /close/i })[0]!);
      expect(handleClose).toHaveBeenCalled();
    });

    it("does not render when isOpen is false", () => {
      const { container } = render(
        <PricingModal isOpen={false} config={mockConfig} onClose={vi.fn()} />,
      );
      expect(container.firstChild).toBeNull();
    });
  });

  describe("ShopInfoModal", () => {
    const mockConfig = {
      customerNotice: "Shop closes at 9 PM on weekends.",
      shopName: "Central Print Hub",
      address: "123 Market St",
      contactPhone: "9876543210",
    } as unknown as CustomerConfigData;

    it("renders info modal and triggers close", () => {
      const handleClose = vi.fn();

      render(
        <ShopInfoModal
          isOpen={true}
          config={mockConfig}
          onClose={handleClose}
        />,
      );

      expect(
        screen.getByRole("dialog", { name: /shop information/i }),
      ).toBeTruthy();
      expect(screen.getByText("Shop closes at 9 PM on weekends.")).toBeTruthy();
      expect(screen.getByText("123 Market St")).toBeTruthy();

      fireEvent.click(screen.getAllByRole("button", { name: /close/i })[0]!);
      expect(handleClose).toHaveBeenCalled();
    });
  });

  describe("CustomerPrivacyFooter", () => {
    it("renders privacy cleanup text and app name", () => {
      render(<CustomerPrivacyFooter appName="PrintGo Secure" />);
      expect(screen.getByText(/Privacy & Automatic Cleanup:/i)).toBeTruthy();
      expect(screen.getByText("PrintGo Secure")).toBeTruthy();
    });
  });

  describe("FloatingLoadingIndicator", () => {
    it("renders default indicator with hourglass icon", () => {
      const { container } = render(<FloatingLoadingIndicator />);
      const indicator = container.querySelector(".pg-floating-indicator");
      expect(indicator).toBeTruthy();
      expect(indicator?.classList.contains("pg-floating-indicator--sm")).toBe(
        true,
      );
      expect(
        indicator?.classList.contains("pg-floating-indicator--green"),
      ).toBe(true);
      expect(container.querySelector("svg.pg-floating-svg")).toBeTruthy();
    });

    it("renders custom sizes, variants, and accessible status labels", () => {
      render(
        <FloatingLoadingIndicator
          size="lg"
          variant="white"
          label="Finding the best printer..."
        />,
      );
      const statusElement = screen.getByRole("status", {
        name: "Finding the best printer...",
      });
      expect(statusElement).toBeTruthy();
      expect(
        statusElement.classList.contains("pg-floating-indicator--lg"),
      ).toBe(true);
      expect(
        statusElement.classList.contains("pg-floating-indicator--white"),
      ).toBe(true);
      expect(screen.getByText("Finding the best printer...")).toBeTruthy();
    });

    it("supports rendering without badge wrapper", () => {
      const { container } = render(
        <FloatingLoadingIndicator showBadge={false} variant="dark" />,
      );
      expect(container.querySelector(".pg-floating-badge")).toBeNull();
      expect(container.querySelector(".pg-floating-icon")).toBeTruthy();
    });
  });

  describe("BowingStaffIllustration", () => {
    it("renders static SVG illustration with correct dimensions", () => {
      const { container } = render(<BowingStaffIllustration size={160} />);
      const svg = container.querySelector("svg");
      expect(svg).toBeTruthy();
      expect(svg?.getAttribute("width")).toBe("160");
      expect(svg?.getAttribute("height")).toBe("200");
      expect(svg?.getAttribute("viewBox")).toBe("0 0 160 200");
    });

    it("renders un-animated static elements strictly without animation tags", () => {
      const { container } = render(<BowingStaffIllustration />);
      expect(container.querySelectorAll("animate")).toHaveLength(0);
      expect(container.querySelectorAll("animateTransform")).toHaveLength(0);
    });
  });

  describe("ShopUnavailableState", () => {
    it("renders generic network error and retry button", () => {
      const handleRetry = vi.fn();
      render(
        <ShopUnavailableState
          error="Server connection timed out."
          onRetry={handleRetry}
        />,
      );

      expect(screen.getByText("Shop Temporarily Unavailable")).toBeTruthy();
      expect(screen.getByText("Server connection timed out.")).toBeTruthy();
      expect(
        screen.getByText(
          "We're sorry for the inconvenience. Please try again shortly.",
        ),
      ).toBeTruthy();
      fireEvent.click(
        screen.getByRole("button", { name: /retry connection/i }),
      );
      expect(handleRetry).toHaveBeenCalled();
    });

    it("renders shop closed state with apologetic message, without Try Again button, and with WhatsApp button", () => {
      const handleRetry = vi.fn();
      render(
        <ShopUnavailableState
          reason="SHOP_CLOSED"
          shopName="PrintGo Downtown"
          contactPhone="9876543210"
          customerNotice="We reopen tomorrow at 8:00 AM."
          onRetry={handleRetry}
        />,
      );

      expect(screen.getByText("Sorry, we're currently closed.")).toBeTruthy();
      expect(
        screen.getByText("Online printing is currently unavailable"),
      ).toBeTruthy();
      expect(screen.getByText("We reopen tomorrow at 8:00 AM.")).toBeTruthy();
      expect(screen.getByRole("link", { name: "9876543210" })).toBeTruthy();

      // Try Again button must NOT be present on unavailable screen
      expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();

      // WhatsApp floating button MUST be present
      const waButton = screen.getByRole("link", { name: /chat on whatsapp/i });
      expect(waButton).toBeTruthy();
      expect(waButton.getAttribute("href")).toContain(
        "https://wa.me/919876543210",
      );
      expect(waButton.getAttribute("href")).toContain(
        encodeURIComponent("PrintGo Downtown"),
      );
    });

    it("renders printer unavailable state with apologetic message, without Try Again button, and with WhatsApp button", () => {
      render(
        <ShopUnavailableState
          reason="PRINTER_UNAVAILABLE"
          shopName="PrintGo Downtown"
          contactPhone="+91 98765 43210"
        />,
      );

      expect(
        screen.getByText("Sorry, printing is temporarily unavailable."),
      ).toBeTruthy();
      expect(
        screen.getByText(
          "Shop printers are currently offline or unavailable. Please check back in a few moments.",
        ),
      ).toBeTruthy();

      // Try Again button must NOT be present
      expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();

      // WhatsApp floating button MUST be present
      const waButton = screen.getByRole("link", { name: /chat on whatsapp/i });
      expect(waButton).toBeTruthy();
      expect(waButton.getAttribute("href")).toContain(
        "https://wa.me/919876543210",
      );
    });
  });

  describe("WhatsAppFloatingButton", () => {
    it("formats 10-digit Indian phone with 91 prefix and default encoded message", () => {
      render(
        <WhatsAppFloatingButton phone="9876543210" shopName="QuickPrint" />,
      );
      const link = screen.getByRole("link", { name: /chat on whatsapp/i });
      expect(link.getAttribute("href")).toBe(
        `https://wa.me/919876543210?text=${encodeURIComponent(
          "Hello QuickPrint, I wanted to print some documents, but online printing is currently unavailable. Could you please assist?",
        )}`,
      );
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    });

    it("does not render when phone is empty or missing", () => {
      const { container } = render(<WhatsAppFloatingButton phone="" />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe("CustomerDetailsStep", () => {
    it("renders form fields and handles inputs", () => {
      const handleNameChange = vi.fn();
      const handlePhoneChange = vi.fn();
      const handleBlur = vi.fn();
      const handleInstructions = vi.fn();
      const handleToggleAddon = vi.fn();

      render(
        <CustomerDetailsStep
          customerName="Rahul Sharma"
          onCustomerNameChange={handleNameChange}
          customerPhone="9876543210"
          onCustomerPhoneChange={handlePhoneChange}
          phoneError={null}
          onPhoneBlur={handleBlur}
          instructions="Please staple files separately"
          onInstructionsChange={handleInstructions}
          addonServices={[
            {
              id: "add-1",
              name: "Staple",
              pricingType: "FIXED_PRICE",
              fixedPricePaise: 0,
            },
          ]}
          selectedAddonIds={[]}
          onToggleAddon={handleToggleAddon}
          disabled={false}
        />,
      );

      expect(screen.getByDisplayValue("Rahul Sharma")).toBeTruthy();
      expect(screen.getByDisplayValue("9876543210")).toBeTruthy();
      expect(
        screen.getByDisplayValue("Please staple files separately"),
      ).toBeTruthy();

      const nameInput = screen.getByLabelText("Name");
      fireEvent.change(nameInput, { target: { value: "Aman" } });
      expect(handleNameChange).toHaveBeenCalledWith("Aman");

      const checkbox = screen.getByRole("checkbox");
      fireEvent.click(checkbox);
      expect(handleToggleAddon).toHaveBeenCalledWith("add-1", true);
    });
  });

  describe("PrintSettingsStep", () => {
    const sampleFile: LocalOrderFile = {
      clientId: "f-1",
      name: "Resume.pdf",
      size: 1024 * 500,
      pageCount: 3,
      uploaded: true,
      uploadStatus: "UPLOADED",
      uploadProgress: 100,
      uploadError: null,
      pageMode: "ALL",
      customPages: "",
      copies: 1,
      paperSize: "A4",
      colorMode: "BW",
      sides: "SINGLE",
      file: null,
    };

    it("renders options and handles modifications", () => {
      const handlePatch = vi.fn();
      const handleApplyAll = vi.fn();

      render(
        <PrintSettingsStep
          files={[sampleFile]}
          selectedFile={sampleFile}
          selectedFileIndex={0}
          onSelectFileIndex={vi.fn()}
          printOptions={[
            {
              paperSize: "A4",
              colorMode: "BW",
              sides: "SINGLE",
              pricePerPagePaise: 200,
            },
          ]}
          optionAvailable={true}
          onPatchSelected={handlePatch}
          onApplySettingsToAll={handleApplyAll}
        />,
      );

      expect(screen.getByText("Print Settings")).toBeTruthy();
      expect(screen.getByLabelText("All pages")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "+" }));
      expect(handlePatch).toHaveBeenCalledWith({ copies: 2 });

      fireEvent.click(screen.getByText(/apply these settings to all files/i));
      expect(handleApplyAll).toHaveBeenCalled();
    });
  });

  describe("UploadPdfsStep", () => {
    const sampleFile: LocalOrderFile = {
      clientId: "f-1",
      name: "Document.pdf",
      size: 1024 * 1024 * 2,
      pageCount: 5,
      uploaded: true,
      uploadStatus: "UPLOADED",
      uploadProgress: 100,
      uploadError: null,
      pageMode: "ALL",
      customPages: "",
      copies: 1,
      paperSize: "A4",
      colorMode: "BW",
      sides: "SINGLE",
      file: null,
    };

    it("renders file list and triggers removal", () => {
      const handleRemove = vi.fn();
      const handleSelect = vi.fn();

      render(
        <UploadPdfsStep
          files={[sampleFile]}
          selectedFileIndex={0}
          onSelectFileIndex={handleSelect}
          onRemoveFile={handleRemove}
          onChooseFiles={vi.fn()}
          config={null}
          fileError={null}
          disabled={false}
        />,
      );

      expect(screen.getByText("Document.pdf")).toBeTruthy();
      expect(screen.getByText("✓ Uploaded")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: /remove file/i }));
      expect(handleRemove).toHaveBeenCalledWith(0);
    });

    it("displays 'Preparing your file...' when status is VALIDATING", () => {
      const preparingFile: LocalOrderFile = {
        ...sampleFile,
        uploaded: false,
        uploadStatus: "VALIDATING",
      };

      render(
        <UploadPdfsStep
          files={[preparingFile]}
          selectedFileIndex={0}
          onSelectFileIndex={vi.fn()}
          onRemoveFile={vi.fn()}
          onChooseFiles={vi.fn()}
          config={null}
          fileError={null}
          disabled={false}
        />,
      );

      expect(screen.getByText("Preparing your file...")).toBeTruthy();
    });

    it("displays 'Uploading your PDF...' and progress percentage when status is UPLOADING", () => {
      const uploadingFile: LocalOrderFile = {
        ...sampleFile,
        uploaded: false,
        uploadStatus: "UPLOADING",
        uploadProgress: 65,
      };

      render(
        <UploadPdfsStep
          files={[uploadingFile]}
          selectedFileIndex={0}
          onSelectFileIndex={vi.fn()}
          onRemoveFile={vi.fn()}
          onChooseFiles={vi.fn()}
          config={null}
          fileError={null}
          disabled={false}
        />,
      );

      expect(screen.getByText("Uploading your PDF...")).toBeTruthy();
      expect(screen.getByText("65%")).toBeTruthy();
    });

    it("displays friendly error message when status is FAILED", () => {
      const failedFile: LocalOrderFile = {
        ...sampleFile,
        uploaded: false,
        uploadStatus: "FAILED",
        uploadError: "Network connection dropped during upload.",
      };

      render(
        <UploadPdfsStep
          files={[failedFile]}
          selectedFileIndex={0}
          onSelectFileIndex={vi.fn()}
          onRemoveFile={vi.fn()}
          onChooseFiles={vi.fn()}
          config={null}
          fileError={null}
          disabled={false}
        />,
      );

      expect(
        screen.getByText("⚠️ Network connection dropped during upload."),
      ).toBeTruthy();
    });
  });

  describe("OrderReviewSummary", () => {
    const sampleQuote: CustomerQuoteData = {
      quoteId: "q-1",
      printingAmountPaise: 400,
      totalAmountPaise: 400,
      serviceChargePaise: 0,
      files: [
        {
          fileId: "f-1",
          fileName: "Document.pdf",
          pageCount: 2,
          copies: 1,
          paperSize: "A4",
          colorMode: "BW",
          sides: "SINGLE",
          printingAmountPaise: 400,
        },
      ],
    } as unknown as CustomerQuoteData;

    it("renders review breakdown with customer info and total", () => {
      render(
        <OrderReviewSummary
          quote={sampleQuote}
          files={[]}
          customerName="Pooja Patel"
          customerPhone="9876543210"
        >
          <button type="button">Mock Payment Button</button>
        </OrderReviewSummary>,
      );

      expect(screen.getByText("Pooja Patel")).toBeTruthy();
      expect(screen.getByText("9876543210")).toBeTruthy();
      expect(screen.getByText("Total Amount")).toBeTruthy();
      expect(screen.getByText("Mock Payment Button")).toBeTruthy();
    });
  });
});
