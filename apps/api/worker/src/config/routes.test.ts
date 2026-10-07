import { describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/unbound-method -- Vitest inspects method mocks without invoking them. */

import type {
  AdminPricingConfiguration,
  ShopSettings,
} from "@printgo/api-contract";
import {
  FILE_SIZE_SERVICE_CHARGE_BANDS,
  FILE_SIZE_10_MIB,
} from "@printgo/domain";

import { AuthError, type RequiredSession } from "../auth/service";
import type { WorkerEnv } from "../env";
import {
  handleAdminConfigurationRequest,
  type ConfigurationActions,
  type SessionActions,
} from "./routes";

const env = {
  APP_ENV: "production",
  ADMIN_ALLOWED_ORIGIN: "https://admin.example.test",
} as WorkerEnv;

const settings: ShopSettings = {
  shopName: "ABC Xerox",
  contactPhone: null,
  address: null,
  customerNotice: null,
  onlinePrintingEnabled: true,
  maxPdfSizeBytes: FILE_SIZE_10_MIB,
};

const pricing: AdminPricingConfiguration = {
  maxPdfSizeBytes: FILE_SIZE_10_MIB,
  printRates: (["A4", "A3"] as const).flatMap((paperSize) =>
    (["BW", "COLOR"] as const).flatMap((colorMode) =>
      (["SINGLE", "DOUBLE"] as const).map((sides) => ({
        paperSize,
        colorMode,
        sides,
        pricePerPagePaise: 200,
        enabled: true,
      })),
    ),
  ),
  fileSizeServiceCharges: FILE_SIZE_SERVICE_CHARGE_BANDS.map((band) => ({
    ...band,
    chargePaise: 100,
  })),
};

const session: RequiredSession = {
  sessionId: "session-1",
  tokenHash: "hash",
  admin: { id: "admin-1", loginIdentifier: "admin" },
};

function configuration(): ConfigurationActions {
  return {
    getSettings: vi.fn(() => Promise.resolve(settings)),
    updateSettings: vi.fn((input: ShopSettings) => Promise.resolve(input)),
    getPricing: vi.fn(() => Promise.resolve(pricing)),
    updatePricing: vi.fn(() => Promise.resolve(pricing)),
    resetPickupCode: vi.fn(() => Promise.resolve("PA-001")),
  };
}

function sessions(authenticated = true): SessionActions {
  return {
    requireSession: vi.fn(() => {
      if (!authenticated) {
        return Promise.reject(new AuthError("AUTH_SESSION_REQUIRED"));
      }
      return Promise.resolve(session);
    }),
  };
}

function request(
  path: string,
  method = "GET",
  body?: unknown,
  origin = env.ADMIN_ALLOWED_ORIGIN,
) {
  return new Request(`https://api.example.test${path}`, {
    method,
    headers: {
      origin,
      cookie: "__Host-printgo_admin=token",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("admin configuration routes", () => {
  it.each(["/api/admin/settings", "/api/admin/pricing"])(
    "requires an authenticated session for GET %s",
    async (path) => {
      const response = await handleAdminConfigurationRequest(
        request(path),
        env,
        configuration(),
        sessions(false),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    },
  );

  it.each([
    ["/api/admin/settings", settings],
    [
      "/api/admin/pricing",
      {
        printRates: pricing.printRates,
        fileSizeServiceCharges: pricing.fileSizeServiceCharges,
      },
    ],
  ])("requires an authenticated session for PUT %s", async (path, body) => {
    const response = await handleAdminConfigurationRequest(
      request(path, "PUT", body),
      env,
      configuration(),
      sessions(false),
    );
    expect(response.status).toBe(401);
  });

  it("reads current settings and pricing", async () => {
    const actions = configuration();
    const settingsResponse = await handleAdminConfigurationRequest(
      request("/api/admin/settings"),
      env,
      actions,
      sessions(),
    );
    const pricingResponse = await handleAdminConfigurationRequest(
      request("/api/admin/pricing"),
      env,
      actions,
      sessions(),
    );
    expect(settingsResponse.status).toBe(200);
    expect(await settingsResponse.json()).toEqual({
      ok: true,
      data: { settings },
    });
    expect(pricingResponse.status).toBe(200);
    expect(await pricingResponse.json()).toEqual({
      ok: true,
      data: { pricing },
    });
  });

  it("updates validated settings as the authenticated admin", async () => {
    const actions = configuration();
    const input = { ...settings, shopName: "City Prints" };
    const response = await handleAdminConfigurationRequest(
      request("/api/admin/settings", "PUT", input),
      env,
      actions,
      sessions(),
    );
    expect(response.status).toBe(200);
    expect(actions.updateSettings).toHaveBeenCalledWith(input, "admin-1");
  });

  it("rejects invalid pricing without invoking persistence", async () => {
    const actions = configuration();
    const response = await handleAdminConfigurationRequest(
      request("/api/admin/pricing", "PUT", {
        printRates: pricing.printRates.slice(0, 7),
        fileSizeServiceCharges: pricing.fileSizeServiceCharges,
      }),
      env,
      actions,
      sessions(),
    );
    expect(response.status).toBe(400);
    expect(actions.updatePricing).not.toHaveBeenCalled();
  });

  it("updates a complete pricing configuration as the authenticated admin", async () => {
    const actions = configuration();
    const input = {
      printRates: pricing.printRates,
      fileSizeServiceCharges: pricing.fileSizeServiceCharges,
    };
    const response = await handleAdminConfigurationRequest(
      request("/api/admin/pricing", "PUT", input),
      env,
      actions,
      sessions(),
    );
    expect(response.status).toBe(200);
    expect(actions.updatePricing).toHaveBeenCalledWith(input, "admin-1");
  });

  it("rejects an untrusted state-changing origin before authentication", async () => {
    const actions = configuration();
    const auth = sessions();
    const response = await handleAdminConfigurationRequest(
      request("/api/admin/settings", "PUT", settings, "https://evil.example"),
      env,
      actions,
      auth,
    );
    expect(response.status).toBe(403);
    expect(auth.requireSession).not.toHaveBeenCalled();
    expect(actions.updateSettings).not.toHaveBeenCalled();
  });
});
