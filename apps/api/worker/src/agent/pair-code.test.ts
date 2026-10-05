import { describe, expect, it } from "vitest";

import {
  generateAgentSecret,
  generatePairCode,
  normalizePairCode,
} from "./pair-code";

describe("Agent pair code & secret utilities", () => {
  it("generates a formatted 8-digit numeric code (XXXX-XXXX)", () => {
    const code = generatePairCode();
    expect(code).toMatch(/^[0-9]{4}-[0-9]{4}$/);
  });

  it("normalizes pair codes by stripping dashes and mapping ambiguous characters", () => {
    // lowercase to uppercase, 'o' -> '0', 'i' / 'l' -> '1', dashes ignored
    expect(normalizePairCode("ab12-cd34")).toBe("AB12CD34");
    expect(normalizePairCode("o0-il-1")).toBe("00111");
    expect(normalizePairCode("  ABCD - EFGH  ")).toBe("ABCDEFGH");
  });

  it("generates a 32-byte Base64URL agent secret", () => {
    const secret = generateAgentSecret();
    expect(secret.length).toBeGreaterThanOrEqual(40);
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
