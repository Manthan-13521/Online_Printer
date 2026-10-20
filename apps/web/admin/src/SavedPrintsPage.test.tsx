// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SavedPrintDocument } from "@printgo/api-contract";
import { SavedPrintsPage } from "./SavedPrintsPage";

const {
  getSavedPrints,
  uploadSavedPrint,
  renameSavedPrint,
  deleteSavedPrint,
  printSavedPrint,
} = vi.hoisted(() => ({
  getSavedPrints: vi.fn(),
  uploadSavedPrint: vi.fn(),
  renameSavedPrint: vi.fn(),
  deleteSavedPrint: vi.fn(),
  printSavedPrint: vi.fn(),
}));

vi.mock("./api", () => ({
  adminApi: {
    getSavedPrints,
    uploadSavedPrint,
    renameSavedPrint,
    deleteSavedPrint,
    printSavedPrint,
  },
  AdminApiError: class AdminApiError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
  friendlyAdminError: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
  resolveAdminApiUrl: (path: string) => `http://localhost${path}`,
}));

const sampleDoc: SavedPrintDocument = {
  id: "doc-1",
  name: "Rental Agreement Template",
  originalFilename: "rental_agreement_2026.pdf",
  fileSizeBytes: 2097152, // 2 MB
  pageCount: 4,
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
};

describe("SavedPrintsPage", () => {
  const onSessionExpired = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders empty state when there are no saved prints", async () => {
    getSavedPrints.mockResolvedValueOnce({
      ok: true,
      data: { documents: [] },
    });

    render(<SavedPrintsPage onSessionExpired={onSessionExpired} />);

    await waitFor(() => {
      expect(screen.getByText("No Saved Documents")).toBeDefined();
    });
    expect(screen.getByText("Upload Document")).toBeDefined();
  });

  it("renders documents and allows opening print dialog and printing", async () => {
    getSavedPrints.mockResolvedValueOnce({
      ok: true,
      data: { documents: [sampleDoc] },
    });
    printSavedPrint.mockResolvedValueOnce({
      ok: true,
      data: { orderId: "ord-saved-1", jobCode: "SP-4001" },
    });

    render(<SavedPrintsPage onSessionExpired={onSessionExpired} />);

    await waitFor(() => {
      expect(screen.getByText("Rental Agreement Template")).toBeDefined();
      expect(screen.getByText(/4 pages/)).toBeDefined();
      expect(screen.getByText(/2\.0 MB/)).toBeDefined();
    });

    const printBtn = screen.getByRole("button", { name: /Print/ });
    act(() => {
      fireEvent.click(printBtn);
    });

    expect(screen.getByText("Print: Rental Agreement Template")).toBeDefined();

    const submitPrint = screen.getByRole("button", { name: "Print Now" });
    act(() => {
      fireEvent.click(submitPrint);
    });

    expect(printSavedPrint).toHaveBeenCalledWith(
      "doc-1",
      expect.objectContaining({
        copies: 1,
        pageRange: "ALL",
        paperSize: "A4",
        colorMode: "BW",
        sides: "SINGLE",
      }),
    );
  });

  it("allows renaming a saved document", async () => {
    getSavedPrints.mockResolvedValueOnce({
      ok: true,
      data: { documents: [sampleDoc] },
    });
    renameSavedPrint.mockResolvedValueOnce({
      ok: true,
      data: { ...sampleDoc, name: "Updated Agreement Template" },
    });
    getSavedPrints.mockResolvedValueOnce({
      ok: true,
      data: {
        documents: [{ ...sampleDoc, name: "Updated Agreement Template" }],
      },
    });

    render(<SavedPrintsPage onSessionExpired={onSessionExpired} />);

    await waitFor(() => {
      expect(screen.getByText("Rental Agreement Template")).toBeDefined();
    });

    const renameBtn = screen.getByRole("button", { name: "Rename" });
    act(() => {
      fireEvent.click(renameBtn);
    });

    const nameInput = screen.getByLabelText("Document Name");
    fireEvent.change(nameInput, {
      target: { value: "Updated Agreement Template" },
    });

    const saveBtn = screen.getByRole("button", { name: "Save" });
    act(() => {
      fireEvent.click(saveBtn);
    });

    expect(renameSavedPrint).toHaveBeenCalledWith(
      "doc-1",
      "Updated Agreement Template",
    );
  });

  it("allows deleting a saved document with confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);

    getSavedPrints.mockResolvedValueOnce({
      ok: true,
      data: { documents: [sampleDoc] },
    });
    deleteSavedPrint.mockResolvedValueOnce({
      ok: true,
      data: { deleted: true },
    });
    getSavedPrints.mockResolvedValueOnce({
      ok: true,
      data: { documents: [] },
    });

    render(<SavedPrintsPage onSessionExpired={onSessionExpired} />);

    await waitFor(() => {
      expect(screen.getByText("Rental Agreement Template")).toBeDefined();
    });

    const deleteBtn = screen.getByRole("button", { name: "Delete" });
    act(() => {
      fireEvent.click(deleteBtn);
    });

    expect(deleteSavedPrint).toHaveBeenCalledWith("doc-1");
  });

  it("allows uploading a new document with file and pdf fields in FormData", async () => {
    getSavedPrints.mockResolvedValueOnce({
      ok: true,
      data: { documents: [] },
    });
    uploadSavedPrint.mockResolvedValueOnce({
      ok: true,
      data: sampleDoc,
    });
    getSavedPrints.mockResolvedValueOnce({
      ok: true,
      data: { documents: [sampleDoc] },
    });

    render(<SavedPrintsPage onSessionExpired={onSessionExpired} />);

    await waitFor(() => {
      expect(screen.getByText("Upload Document")).toBeDefined();
    });

    const uploadBtn = screen.getByRole("button", { name: /Upload Document/ });
    act(() => {
      fireEvent.click(uploadBtn);
    });

    expect(screen.getByText("Document Display Name")).toBeDefined();

    const nameInput = screen.getByLabelText("Document Display Name");
    fireEvent.change(nameInput, {
      target: { value: "Rental Agreement Template" },
    });

    const fileInput = screen.getByLabelText(/PDF File/);
    const fakeFile = new File(["%PDF-1.4 test"], "rental.pdf", {
      type: "application/pdf",
    });
    fireEvent.change(fileInput, { target: { files: [fakeFile] } });

    const form = screen.getByRole("dialog").querySelector("form")!;
    act(() => {
      fireEvent.submit(form);
    });

    await waitFor(() => {
      expect(uploadSavedPrint).toHaveBeenCalledTimes(1);
    });

    const calledFormData = uploadSavedPrint.mock.calls[0]![0] as FormData;
    expect(calledFormData.get("name")).toBe("Rental Agreement Template");
    expect(calledFormData.get("file")).toBeInstanceOf(File);
    expect(calledFormData.get("pdf")).toBeInstanceOf(File);
  });
});
