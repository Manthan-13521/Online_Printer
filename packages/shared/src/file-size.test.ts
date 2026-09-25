import { describe, expect, it } from "vitest";

import { BYTES_PER_MIB, isAtOrBelowByteLimit, mebibytesToBytes } from "./index";

describe("file-size conventions", () => {
  it("converts configured MiB limits to exact integer bytes", () => {
    expect(mebibytesToBytes(2)).toBe(2 * BYTES_PER_MIB);
    expect(mebibytesToBytes(25)).toBe(25 * BYTES_PER_MIB);
  });

  it("treats the configured byte boundary as inclusive", () => {
    const limit = mebibytesToBytes(2);

    expect(isAtOrBelowByteLimit(limit, limit)).toBe(true);
    expect(isAtOrBelowByteLimit(limit + 1, limit)).toBe(false);
  });

  it("rejects invalid file-size inputs", () => {
    expect(() => mebibytesToBytes(1.5)).toThrow(RangeError);
    expect(() => isAtOrBelowByteLimit(-1, 10)).toThrow(RangeError);
  });
});
