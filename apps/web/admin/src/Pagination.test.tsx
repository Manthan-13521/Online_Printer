// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Pagination } from "./Pagination";

describe("Pagination component", () => {
  afterEach(cleanup);

  it("renders nothing when totalItems <= pageSize and hasNextPage is false", () => {
    const { container } = render(
      <Pagination
        currentPage={1}
        totalItems={5}
        pageSize={10}
        onPageChange={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders pagination controls when totalItems > pageSize", async () => {
    const user = userEvent.setup();
    const handlePageChange = vi.fn();

    render(
      <Pagination
        currentPage={1}
        totalItems={25}
        pageSize={10}
        onPageChange={handlePageChange}
        itemLabel="live orders"
      />,
    );

    expect(screen.getByText(/Showing/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "3" })).toBeTruthy();

    const prevBtn = screen.getByRole("button", { name: "Previous page" });
    const nextBtn = screen.getByRole("button", { name: "Next page" });

    expect(prevBtn.hasAttribute("disabled")).toBe(true);
    expect(nextBtn.hasAttribute("disabled")).toBe(false);

    // Click next page
    await user.click(nextBtn);
    expect(handlePageChange).toHaveBeenCalledWith(2);

    // Click page number 3
    const page3Btn = screen.getByRole("button", { name: "3" });
    await user.click(page3Btn);
    expect(handlePageChange).toHaveBeenCalledWith(3);
  });

  it("disables next button on the last page when hasNextPage is false", () => {
    render(
      <Pagination
        currentPage={3}
        totalItems={25}
        pageSize={10}
        onPageChange={vi.fn()}
      />,
    );

    const prevBtn = screen.getByRole("button", { name: "Previous page" });
    const nextBtn = screen.getByRole("button", { name: "Next page" });

    expect(prevBtn.hasAttribute("disabled")).toBe(false);
    expect(nextBtn.hasAttribute("disabled")).toBe(true);
  });

  it("enables next button on last page when hasNextPage is true", async () => {
    const user = userEvent.setup();
    const handlePageChange = vi.fn();

    render(
      <Pagination
        currentPage={2}
        totalItems={20}
        pageSize={10}
        onPageChange={handlePageChange}
        hasNextPage={true}
      />,
    );

    const nextBtn = screen.getByRole("button", { name: "Next page" });
    expect(nextBtn.hasAttribute("disabled")).toBe(false);

    await user.click(nextBtn);
    expect(handlePageChange).toHaveBeenCalledWith(3);
  });
});
