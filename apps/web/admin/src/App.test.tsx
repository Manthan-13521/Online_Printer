// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { adminApi, AdminApiError } from "./api";
import type * as ApiModule from "./api";

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    adminApi: {
      login: vi.fn(),
      me: vi.fn(),
      logout: vi.fn(),
      revokeAllSessions: vi.fn(),
      changePassword: vi.fn(),
    },
  };
});

const mockedApi = vi.mocked(adminApi);
const admin = {
  id: "10000000-0000-4000-8000-000000000001",
  loginIdentifier: "admin",
};

describe("Admin application", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/admin");
    vi.resetAllMocks();
  });

  afterEach(cleanup);

  it("shows the accessible login form only after auth restoration completes", async () => {
    let rejectMe: ((reason: unknown) => void) | undefined;
    mockedApi.me.mockReturnValue(
      new Promise((_, reject) => {
        rejectMe = reject;
      }),
    );
    render(<App />);
    expect(screen.getByText("Opening PrintGo…")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Sign in" })).toBeNull();
    rejectMe?.(new AdminApiError("AUTH_SESSION_REQUIRED", 401, "expired"));
    expect(
      await screen.findByRole("heading", { name: "Sign in" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Login")).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
  });

  it("signs in and exposes the complete accessible navigation without fake data", async () => {
    mockedApi.me.mockRejectedValue(
      new AdminApiError("AUTH_SESSION_REQUIRED", 401, "expired"),
    );
    mockedApi.login.mockResolvedValue({ ok: true, data: { admin } });
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText("Login"), "admin");
    await user.type(screen.getByLabelText("Password"), "correct password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(
      await screen.findByRole("navigation", { name: "Admin navigation" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Live Orders" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Security" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Welcome to PrintGo" }),
    ).toBeTruthy();
    expect(screen.queryByText(/revenue|37 orders/iu)).toBeNull();
  });

  it("logs out from the shell and returns to login with feedback", async () => {
    mockedApi.me.mockResolvedValue({ ok: true, data: { admin } });
    mockedApi.logout.mockResolvedValue({
      ok: true,
      data: { message: "You have been signed out." },
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(
      await screen.findByRole("heading", { name: "Sign in" }),
    ).toBeTruthy();
    expect(screen.getByText("You have been signed out.")).toBeTruthy();
  });

  it("handles an expired session during password change", async () => {
    window.history.replaceState({}, "", "/admin/security");
    mockedApi.me.mockResolvedValue({ ok: true, data: { admin } });
    mockedApi.changePassword.mockRejectedValue(
      new AdminApiError(
        "AUTH_SESSION_EXPIRED",
        401,
        "Your session has expired. Please sign in again.",
      ),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.type(
      await screen.findByLabelText("Current password"),
      "current password",
    );
    await user.type(
      screen.getByLabelText("New password"),
      "new secure password",
    );
    await user.type(
      screen.getByLabelText("Confirm new password"),
      "new secure password",
    );
    await user.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy(),
    );
    expect(
      screen.getByText("Your session has expired. Please sign in again."),
    ).toBeTruthy();
  });
});
