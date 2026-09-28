import type { WorkerEnv } from "./env";
import { error } from "./http";
import { D1RetentionRepository } from "./retention/repository";
import { RetentionService } from "./retention/service";
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
      const repository = new D1RetentionRepository(env.DB);
      const service = new RetentionService(repository, env.PDF_BUCKET);
      const result = await service.runCleanup();
      console.log("Retention cleanup scheduled execution complete", {
        processedUploads: result.processedUploads,
        deletedUploads: result.deletedUploads,
        failedUploads: result.failedUploads,
        purgedPiiCount: result.purgedPiiCount,
      });
    } catch (err) {
      console.error("Retention cleanup scheduled execution failed", {
        error: err instanceof Error ? err.name : "UnknownError",
      });
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
