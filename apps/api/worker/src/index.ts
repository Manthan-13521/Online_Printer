import type { WorkerEnv } from "./env";
import { error } from "./http";
import { D1CleanupRepository } from "./cleanup/repository";
import { CleanupService } from "./cleanup/service";
import { routeRequest } from "./router";

export { routeRequest } from "./router";

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    try {
      return await routeRequest(request, env);
    } catch (caught: unknown) {
      console.error("Unhandled Worker request error", {
        error: caught instanceof Error ? caught.name : "UnknownError",
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
        error: err instanceof Error ? err.name : "UnknownError",
      });
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
