import type { WorkerEnv } from "./env";
import { error } from "./http";
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
} satisfies ExportedHandler<WorkerEnv>;
