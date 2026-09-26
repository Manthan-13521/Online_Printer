import { describe, expect, it } from "vitest";

import { PageRangeError, parsePageRange } from "./page-range";

describe("parsePageRange", () => {
  it.each([
    ["1", "1", 1],
    ["1-5", "1-5", 5],
    ["1,3,5", "1,3,5", 3],
    ["1,3,7-10", "1,3,7-10", 6],
    ["1-1", "1", 1],
    [" 3 , 1-2, 2 ", "1-3", 3],
    ["1,1,2", "1-2", 2],
  ])("normalizes %s", (input, normalized, selectedPageCount) => {
    expect(parsePageRange(input)).toEqual({ normalized, selectedPageCount });
  });

  it.each(["0", "-1", "5-2", "1-", "a", "1,,2", "1.5"])(
    "rejects invalid input %s",
    (input) => expect(() => parsePageRange(input)).toThrow(PageRangeError),
  );

  it("enforces the known PDF page bound", () => {
    try {
      parsePageRange("1-6", 5);
      throw new Error("Expected the parser to reject the range.");
    } catch (caught) {
      expect(caught).toBeInstanceOf(PageRangeError);
      expect((caught as PageRangeError).code).toBe("PAGE_OUT_OF_BOUNDS");
    }
  });
});
