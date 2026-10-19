import { describe, expect, it, vi } from "vitest";
import { handleDashboard } from "./dashboard";
import type { WorkerEnv } from "../env";
import { AdminAuthService } from "../auth/service";
import { D1ConfigurationRepository } from "./repository";
import { D1AgentRepository } from "../agent/repository";

describe("handleDashboard", () => {
  it("counts only paid orders and returns today's orders count and earnings", async () => {
    vi.spyOn(AdminAuthService.prototype, "requireSession").mockResolvedValue({
      sessionId: "test-sess",
      admin: { id: "admin-1", loginIdentifier: "admin" },
      tokenHash: "test-hash",
    });

    vi.spyOn(
      D1ConfigurationRepository.prototype,
      "getSettings",
    ).mockResolvedValue({
      shopName: "PrintGo Downtown",
      contactPhone: "+91 98765 43210",
      address: "123 Main St",
      customerNotice: null,
      onlinePrintingEnabled: true,
      maxPdfSizeBytes: 10485760,
      identificationSheetEnabled: false,
      identificationSheetPlacement: "FIRST",
    });

    vi.spyOn(
      D1AgentRepository.prototype,
      "listAgentsWithPrinters",
    ).mockResolvedValue([]);
    vi.spyOn(
      D1AgentRepository.prototype,
      "getDefaultProductionPrinterId",
    ).mockResolvedValue(null);

    // Mock DB batch returning:
    // Batch 0: created_count (paid orders only) = 3, earnings_paise = 45000
    // Batch 1: status counts (in queue = 2, printing = 1)
    const mockBatch = vi.fn().mockResolvedValue([
      {
        results: [
          {
            created_count: 3, // only paid orders
            earnings_paise: 45000,
          },
        ],
      },
      {
        results: [
          { status: "QUEUED", count: 2 },
          { status: "PRINTING", count: 1 },
        ],
      },
    ]);

    const mockPrepare = vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnThis(),
    });

    const env = {
      APP_ENV: "production",
      ADMIN_ALLOWED_ORIGIN: "https://admin.printgo.dev",
      DB: {
        batch: mockBatch,
        prepare: mockPrepare,
      },
    } as unknown as WorkerEnv;

    const request = new Request("https://api.printgo.dev/api/admin/dashboard", {
      method: "GET",
      headers: {
        Origin: "https://admin.printgo.dev",
        Cookie: "pg_admin_session=test-token",
      },
    });

    const response = await handleDashboard(request, env);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      data: {
        todaysOrders: 3,
        todaysEarningsPaise: 45000,
        inQueue: 2,
        printingNow: 1,
      },
    });

    // Verify SQL query binds dateKey and filters for paid orders only
    expect(mockPrepare).toHaveBeenCalled();
    const querySql = String(mockPrepare.mock.calls[0]?.[0] ?? "");
    expect(querySql).toContain("p.status = 'PAID'");
    expect(querySql).toContain("retained_payment_records");
    expect(querySql).toContain("SELECT p.id AS order_id");
    expect(querySql).not.toMatch(
      /SELECT\s+p\.order_id\s+FROM\s+retained_payment_records/i,
    );
    expect(querySql).toContain("o.payment_method = 'CASH'");
    expect(querySql).toContain("o.paid_at_ms IS NOT NULL");
  });
});
