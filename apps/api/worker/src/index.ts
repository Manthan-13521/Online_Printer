import type { WorkerEnv } from "./env";
import { error } from "./http";
import { D1CleanupRepository } from "./cleanup/repository";
import { CleanupService } from "./cleanup/service";
import { D1PrintingRepository } from "./printing/repository";
import { routeRequest } from "./router";

export { routeRequest } from "./router";

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    try {
      return await routeRequest(request, env);
    } catch (caught: unknown) {
      console.error("Unhandled Worker request error", {
        message: caught instanceof Error ? caught.message : String(caught),
        stack: caught instanceof Error ? caught.stack : undefined,
      });

      return error(
        500,
        "INTERNAL_ERROR",
        "We could not complete the request. Please try again.",
      );
    }
  },

  async scheduled(
    _controller: ScheduledController,
    env: WorkerEnv,
  ): Promise<void> {
    try {
      const service = new CleanupService(
        new D1CleanupRepository(env.DB),
        env.PDF_BUCKET,
      );
      const result = await service.runScheduled();
      console.log("Cleanup scheduled execution complete", {
        runId: result?.runId ?? null,
        status: result?.status ?? "IDLE",
        deletedOrders: result?.deletedOrders ?? 0,
        deletedFiles: result?.deletedFiles ?? 0,
        failures: result?.failures ?? 0,
      });
    } catch (err) {
      console.error("Cleanup scheduled execution failed", {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }

    try {
      const printingRepo = new D1PrintingRepository(env.DB);
      const nowMs = Date.now();
      await printingRepo.recoverExpiredClaims(nowMs);
      const retryResult = await printingRepo.autoRetryEligibleOrders(nowMs);
      if (retryResult.retriedCount > 0) {
        console.log("Auto-retry scheduled execution complete", {
          retriedCount: retryResult.retriedCount,
        });
      }
    } catch (err) {
      console.error("Auto-retry / recovery scheduled execution failed", {
        error: err instanceof Error ? err.name : "UnknownError",
      });
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
