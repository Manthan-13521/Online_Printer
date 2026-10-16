import { describe, expect, it, vi } from "vitest";
import {
  formatDateTime,
  formatPaise,
  formatRelativeTime,
  getInitials,
} from "./formatters";

describe("admin formatters", () => {
  describe("formatPaise", () => {
    it("formats 0 paise as ₹0.00", () => {
      expect(formatPaise(0)).toBe("₹0.00");
    });

    it("formats standard amounts with two decimal places", () => {
      expect(formatPaise(2100)).toBe("₹21.00");
      expect(formatPaise(50)).toBe("₹0.50");
      expect(formatPaise(123456)).toBe("₹1234.56");
    });
  });

  describe("formatDateTime", () => {
    it("returns dash for null or undefined", () => {
      expect(formatDateTime(null)).toBe("—");
      expect(formatDateTime(undefined)).toBe("—");
      expect(formatDateTime("")).toBe("—");
    });

    it("formats a valid ISO timestamp", () => {
      const iso = "2026-09-26T12:00:00.000Z";
      expect(formatDateTime(iso)).toBe(new Date(iso).toLocaleString());
    });
  });

  describe("formatRelativeTime", () => {
    it("returns 'Never' for null or empty dates", () => {
      expect(formatRelativeTime(null)).toBe("Never");
      expect(formatRelativeTime("")).toBe("Never");
    });

    it("returns 'Just now' for timestamps within 5 seconds", () => {
      const now = new Date("2026-10-16T12:00:00Z");
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const threeSecondsAgo = new Date(now.getTime() - 3000).toISOString();
      expect(formatRelativeTime(threeSecondsAgo)).toBe("Just now");

      vi.useRealTimers();
    });

    it("returns seconds ago for timestamps between 5 and 59 seconds", () => {
      const now = new Date("2026-10-16T12:00:00Z");
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const twentySecondsAgo = new Date(now.getTime() - 20000).toISOString();
      expect(formatRelativeTime(twentySecondsAgo)).toBe("20s ago");

      vi.useRealTimers();
    });

    it("returns minutes ago for timestamps within an hour", () => {
      const now = new Date("2026-10-16T12:00:00Z");
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const tenMinutesAgo = new Date(
        now.getTime() - 10 * 60 * 1000,
      ).toISOString();
      expect(formatRelativeTime(tenMinutesAgo)).toBe("10m ago");

      vi.useRealTimers();
    });

    it("returns hours ago for timestamps within 24 hours", () => {
      const now = new Date("2026-10-16T12:00:00Z");
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const threeHoursAgo = new Date(
        now.getTime() - 3 * 60 * 60 * 1000,
      ).toISOString();
      expect(formatRelativeTime(threeHoursAgo)).toBe("3h ago");

      vi.useRealTimers();
    });

    it("returns localized date string for timestamps older than 24 hours", () => {
      const now = new Date("2026-10-16T12:00:00Z");
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const twoDaysAgo = new Date(
        now.getTime() - 48 * 60 * 60 * 1000,
      ).toISOString();
      expect(formatRelativeTime(twoDaysAgo)).toBe(
        new Date(twoDaysAgo).toLocaleDateString(),
      );

      vi.useRealTimers();
    });
  });

  describe("getInitials", () => {
    it("returns 'C' for missing or empty names", () => {
      expect(getInitials(null)).toBe("C");
      expect(getInitials(undefined)).toBe("C");
      expect(getInitials("")).toBe("C");
      expect(getInitials("   ")).toBe("C");
    });

    it("returns first two letters for single word names", () => {
      expect(getInitials("Rahul")).toBe("RA");
      expect(getInitials("A")).toBe("A");
    });

    it("returns first and last initials for multi-word names", () => {
      expect(getInitials("Rahul Kumar")).toBe("RK");
      expect(getInitials("Manthan Kumar Jaiswal")).toBe("MJ");
    });
  });
});
