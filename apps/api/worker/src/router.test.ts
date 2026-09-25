import { describe, expect, it } from "vitest";

import { routeRequest } from "./router";
import type { WorkerEnv } from "./env";

const env = {} as WorkerEnv;

describe("Worker routing", () => {
  it("returns the standard success envelope for the health route", async () => {
    const response = await routeRequest(
      new Request("https://api.example.test/health"),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { service: "printgo-api", status: "available" },
    });
  });

  it("does not leak technical details for an unknown route", async () => {
    const response = await routeRequest(
      new Request("https://api.example.test/nope"),
      env,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "The requested resource was not found.",
      },
    });
  });
});
