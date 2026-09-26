import { describe, expect, it } from "vitest";

import { generateJobCode } from "./job-code";

describe("generateJobCode", () => {
  it("uses the human-safe uppercase format", () => {
    const code = generateJobCode((bytes) => {
      bytes.set([0, 1, 2, 3, 4, 5]);
      return bytes;
    });
    expect(code).toMatch(/^PG-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/u);
    expect(code).not.toMatch(/[01ILO]/u);
  });
});
