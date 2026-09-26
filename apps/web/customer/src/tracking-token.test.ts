// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { createTrackingToken } from "./tracking-token";

describe("tracking token generation", () => {
  it("creates independent 32-byte Base64URL credentials", () => {
    const first = createTrackingToken();
    const second = createTrackingToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first).not.toBe(second);
  });
});
