// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
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
    quote: vi.fn(),
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
  sessionStorage.clear();
  vi.mocked(customerApi.config).mockResolvedValue(enabledConfig);
  vi.mocked(inspectPdf).mockResolvedValue(10);
  vi.mocked(customerApi.createDraft).mockResolvedValue({
    draftToken: "A".repeat(43),
    draftExpiresAt: "2026-09-26T00:10:00.000Z",
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
});

afterEach(cleanup);

describe("customer upload app", () => {
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
    const link = screen.getByRole("link", { name: "Open iLovePDF" });
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
    await userEvent.upload(screen.getByLabelText("Choose PDF"), file);
    expect(await screen.findByText(/PDFs must be between 1 byte/)).toBeTruthy();
    expect(inspectPdf).not.toHaveBeenCalled();
  });

  it("handles corrupted and password-protected PDFs with useful errors", async () => {
    vi.mocked(inspectPdf).mockRejectedValueOnce(new Error("INVALID_PDF"));
    render(<App />);
    await screen.findByText("ABC Xerox");
    const file = new File(["%PDF"], "broken.pdf", { type: "application/pdf" });
    await userEvent.upload(screen.getByLabelText("Choose PDF"), file);
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
      screen.getByLabelText("Choose PDF"),
      new File(["%PDF"], "notes.pdf", { type: "application/pdf" }),
    );
    expect(await screen.findByText(/10 pages/)).toBeTruthy();
    fireEvent.submit(
      screen
        .getByRole("button", { name: "Upload PDF and review" })
        .closest("form")!,
    );
    await waitFor(() =>
      expect(customerApi.quote).toHaveBeenCalledWith(
        "A".repeat(43),
        expect.objectContaining({ selectedPages: "1-10", copies: 1 }),
      ),
    );
    expect(await screen.findByText("₹21.00")).toBeTruthy();
    expect(screen.getByText("notes.pdf")).toBeTruthy();
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
      screen.getByLabelText("Choose PDF"),
      new File(["%PDF"], "notes.pdf", { type: "application/pdf" }),
    );
    await user.click(screen.getByLabelText("Custom range"));
    const pages = await screen.findByPlaceholderText("1,3,7-10");
    fireEvent.change(pages, { target: { value: "10-2" } });
    fireEvent.submit(
      screen
        .getByRole("button", { name: "Upload PDF and review" })
        .closest("form")!,
    );
    expect(
      await screen.findByText(/Enter pages between 1 and 10/),
    ).toBeTruthy();
    fireEvent.change(pages, { target: { value: "1-3" } });
    fireEvent.submit(
      screen
        .getByRole("button", { name: "Upload PDF and review" })
        .closest("form")!,
    );
    expect(
      await screen.findByText(/Connection lost during upload/),
    ).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Rahul");
    const retry = screen.getByRole("button", { name: "Try upload again" });
    fireEvent.submit(retry.closest("form")!);
    await waitFor(() =>
      expect(customerApi.authorize).toHaveBeenCalledWith("A".repeat(43)),
    );
    await waitFor(() => expect(customerApi.quote).toHaveBeenCalled());
  });
});
