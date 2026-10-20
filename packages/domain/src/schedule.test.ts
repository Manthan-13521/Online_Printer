import { describe, expect, it } from "vitest";
import {
  calculateNextPickupTarget,
  formatTimeAmPm,
  isShopCurrentlyOpen,
  isValidTimezone,
} from "./schedule.js";

describe("Shop Operating Schedule & Next Pickup Target", () => {
  const shopSchedule = {
    openingTime: "07:00",
    closingTime: "15:00", // 3:00 PM
    operatingDays: [1, 2, 3, 4, 5, 6], // Mon-Sat (Sunday closed)
    timezone: "Asia/Kolkata",
  };

  it("formats 24h time to 12h AM/PM properly", () => {
    expect(formatTimeAmPm("07:00")).toBe("7:00 AM");
    expect(formatTimeAmPm("15:30")).toBe("3:30 PM");
    expect(formatTimeAmPm("00:00")).toBe("12:00 AM");
    expect(formatTimeAmPm("12:00")).toBe("12:00 PM");
    expect(formatTimeAmPm("23:45")).toBe("11:45 PM");
  });

  it("validates timezones properly", () => {
    expect(isValidTimezone("Asia/Kolkata")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("Invalid/Timezone_Foo")).toBe(false);
  });

  it("detects shop open vs closed correctly", () => {
    // 2026-01-05 is a Monday
    // 10:00 AM IST (open) = 2026-01-05T04:30:00.000Z
    const monday10Am = new Date("2026-01-05T04:30:00.000Z").getTime();
    expect(isShopCurrentlyOpen(monday10Am, shopSchedule)).toBe(true);

    // 04:00 PM IST (closed, after 3 PM) = 2026-01-05T10:30:00.000Z
    const monday4Pm = new Date("2026-01-05T10:30:00.000Z").getTime();
    expect(isShopCurrentlyOpen(monday4Pm, shopSchedule)).toBe(false);

    // 06:00 AM IST (closed, before 7 AM) = 2026-01-05T00:30:00.000Z
    const monday6Am = new Date("2026-01-05T00:30:00.000Z").getTime();
    expect(isShopCurrentlyOpen(monday6Am, shopSchedule)).toBe(false);

    // 2026-01-11 is a Sunday (closed day)
    // 10:00 AM IST
    const sunday10Am = new Date("2026-01-11T04:30:00.000Z").getTime();
    expect(isShopCurrentlyOpen(sunday10Am, shopSchedule)).toBe(false);
  });

  // User requirement specification tests:
  // "For example, if the shop opens at 7:00 AM and closes at 3:00 PM:
  // - January 3, 4:00 PM → Pickup January 4, from 7:00 AM.
  // - January 4, 3:00 AM → Pickup January 4, from 7:00 AM.
  // - January 4, 6:00 AM → Pickup January 4, from 7:00 AM."
  // Note: Let's test with everyday operating schedule for this example:
  const allDaysSchedule = {
    openingTime: "07:00",
    closingTime: "15:00",
    operatingDays: [0, 1, 2, 3, 4, 5, 6],
    timezone: "Asia/Kolkata",
  };

  it("handles Jan 3, 4:00 PM -> Pickup Jan 4, from 7:00 AM", () => {
    // 2026-01-03 16:00 IST = 2026-01-03T10:30:00.000Z
    const jan3At4Pm = new Date("2026-01-03T10:30:00.000Z").getTime();
    const result = calculateNextPickupTarget(jan3At4Pm, allDaysSchedule);
    expect(result.dayOffset).toBe(1);
    expect(result.formattedPickupTime).toBe("4 Jan, from 7:00 AM");
    // Target is Jan 4 07:00 IST = 2026-01-04T01:30:00.000Z
    expect(new Date(result.targetTimeMs).toISOString()).toBe(
      "2026-01-04T01:30:00.000Z",
    );
  });

  it("handles Jan 4, 3:00 AM -> Pickup Jan 4, from 7:00 AM", () => {
    // 2026-01-04 03:00 IST = 2026-01-03T21:30:00.000Z
    const jan4At3Am = new Date("2026-01-03T21:30:00.000Z").getTime();
    const result = calculateNextPickupTarget(jan4At3Am, allDaysSchedule);
    expect(result.dayOffset).toBe(0);
    expect(result.formattedPickupTime).toBe("4 Jan, from 7:00 AM");
    expect(new Date(result.targetTimeMs).toISOString()).toBe(
      "2026-01-04T01:30:00.000Z",
    );
  });

  it("handles Jan 4, 6:00 AM -> Pickup Jan 4, from 7:00 AM", () => {
    // 2026-01-04 06:00 IST = 2026-01-04T00:30:00.000Z
    const jan4At6Am = new Date("2026-01-04T00:30:00.000Z").getTime();
    const result = calculateNextPickupTarget(jan4At6Am, allDaysSchedule);
    expect(result.dayOffset).toBe(0);
    expect(result.formattedPickupTime).toBe("4 Jan, from 7:00 AM");
    expect(new Date(result.targetTimeMs).toISOString()).toBe(
      "2026-01-04T01:30:00.000Z",
    );
  });

  it("skips Sunday when closed and advances Saturday to Monday", () => {
    // Saturday Jan 10, 2026 4:00 PM IST = 2026-01-10T10:30:00.000Z
    const saturday4Pm = new Date("2026-01-10T10:30:00.000Z").getTime();
    const result = calculateNextPickupTarget(saturday4Pm, shopSchedule);
    // Sunday is closed, so next open day is Monday Jan 12 (offset 2)
    expect(result.dayOffset).toBe(2);
    expect(result.formattedPickupTime).toBe("12 Jan, from 7:00 AM");
    // Monday Jan 12, 2026 07:00 IST = 2026-01-12T01:30:00.000Z
    expect(new Date(result.targetTimeMs).toISOString()).toBe(
      "2026-01-12T01:30:00.000Z",
    );
  });

  it("accurately handles US Eastern timezone", () => {
    const nySchedule = {
      openingTime: "08:30",
      closingTime: "18:00",
      operatingDays: [1, 2, 3, 4, 5],
      timezone: "America/New_York",
    };
    // Wednesday Oct 14, 2026 8:00 PM EDT (UTC-4) = 2026-10-15T00:00:00.000Z
    const wed8Pm = new Date("2026-10-15T00:00:00.000Z").getTime();
    const result = calculateNextPickupTarget(wed8Pm, nySchedule);
    expect(result.dayOffset).toBe(1);
    expect(result.formattedPickupTime).toBe("15 Oct, from 8:30 AM");
    // Target is Thursday Oct 15, 2026 08:30 EDT = 2026-10-15T12:30:00.000Z
    expect(new Date(result.targetTimeMs).toISOString()).toBe(
      "2026-10-15T12:30:00.000Z",
    );
  });
});
