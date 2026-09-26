const MAX_RANGE_LENGTH = 200;
const MAX_SEGMENTS = 100;
export const MAX_PDF_PAGE_COUNT = 1_000_000;

export type PageRangeErrorCode =
  | "EMPTY_PAGE_RANGE"
  | "PAGE_RANGE_TOO_LONG"
  | "TOO_MANY_PAGE_SEGMENTS"
  | "INVALID_PAGE_RANGE"
  | "PAGE_OUT_OF_BOUNDS";

export class PageRangeError extends Error {
  constructor(readonly code: PageRangeErrorCode) {
    super(code);
    this.name = "PageRangeError";
  }
}

export interface ParsedPageRange {
  normalized: string;
  selectedPageCount: number;
}

export function parsePageRange(
  input: string,
  maximumPage = MAX_PDF_PAGE_COUNT,
): ParsedPageRange {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new PageRangeError("EMPTY_PAGE_RANGE");
  }
  if (input.length > MAX_RANGE_LENGTH) {
    throw new PageRangeError("PAGE_RANGE_TOO_LONG");
  }
  if (!Number.isSafeInteger(maximumPage) || maximumPage < 1) {
    throw new PageRangeError("PAGE_OUT_OF_BOUNDS");
  }

  const segments = input.split(",");
  if (segments.length > MAX_SEGMENTS) {
    throw new PageRangeError("TOO_MANY_PAGE_SEGMENTS");
  }

  const intervals = segments.map((segment) => {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/u.exec(segment);
    if (!match) throw new PageRangeError("INVALID_PAGE_RANGE");
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 1 ||
      end < start ||
      end > maximumPage
    ) {
      throw new PageRangeError(
        end > maximumPage ? "PAGE_OUT_OF_BOUNDS" : "INVALID_PAGE_RANGE",
      );
    }
    return { start, end };
  });

  intervals.sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }

  const selectedPageCount = merged.reduce(
    (total, interval) => total + interval.end - interval.start + 1,
    0,
  );
  return {
    normalized: merged
      .map(({ start, end }) =>
        start === end ? String(start) : `${start}-${end}`,
      )
      .join(","),
    selectedPageCount,
  };
}
