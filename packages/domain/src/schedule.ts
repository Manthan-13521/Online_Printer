/**
 * Shop operating schedule and pickup calculation with pure IANA timezone handling.
 */

export interface ShopOperatingSchedule {
  openingTime: string; // "HH:mm" (24-hour e.g. "07:00")
  closingTime: string; // "HH:mm" (24-hour e.g. "21:00")
  operatingDays: number[]; // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  timezone: string; // IANA timezone e.g. "Asia/Kolkata"
}

export interface NextPickupTarget {
  targetDateIso: string;
  targetTimeMs: number;
  formattedPickupTime: string;
  dayOffset: number;
}

/**
 * Validates whether a timezone identifier is supported by the runtime.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalizes and formats time into 12-hour AM/PM string (e.g., "07:00" -> "7:00 AM").
 */
export function formatTimeAmPm(timeHHMM: string): string {
  const [hStr, mStr] = timeHHMM.split(":");
  const h = Number(hStr ?? 0);
  const m = Number(mStr ?? 0);
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const minutePadded = String(m).padStart(2, "0");
  return `${hour12}:${minutePadded} ${period}`;
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function parseTimeToMinutes(timeHHMM: string): number {
  const [hStr, mStr] = timeHHMM.split(":");
  return Number(hStr ?? 0) * 60 + Number(mStr ?? 0);
}

/**
 * Determines whether the shop is currently open based on operating schedule and current time in shop timezone.
 */
export function isShopCurrentlyOpen(
  nowMs: number,
  schedule: ShopOperatingSchedule,
): boolean {
  const timezone = isValidTimezone(schedule.timezone)
    ? schedule.timezone
    : "Asia/Kolkata";

  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });

  const parts = dtf.formatToParts(new Date(nowMs));
  const getPart = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const weekdayStr = getPart("weekday");
  const weekdayNum = WEEKDAY_MAP[weekdayStr] ?? 0;

  const operatingDays =
    Array.isArray(schedule.operatingDays) && schedule.operatingDays.length > 0
      ? schedule.operatingDays
      : [1, 2, 3, 4, 5, 6];

  if (!operatingDays.includes(weekdayNum)) {
    return false;
  }

  const currentHour = Number(getPart("hour"));
  const currentMinute = Number(getPart("minute"));
  const nowMinutes = currentHour * 60 + currentMinute;

  const openMinutes = parseTimeToMinutes(schedule.openingTime);
  const closeMinutes = parseTimeToMinutes(schedule.closingTime);

  if (closeMinutes > openMinutes) {
    return nowMinutes >= openMinutes && nowMinutes < closeMinutes;
  } else {
    // Overnight schedule support
    return nowMinutes >= openMinutes || nowMinutes < closeMinutes;
  }
}

/**
 * Calculates the next pickup date and opening time based on next actual shop opening logic.
 *
 * Rules:
 * 1. If today is an operating day and current shop time is before openingTime, next opening is TODAY at openingTime.
 * 2. If today is closed or current time is past openingTime, advances day-by-day (offset 1..14)
 *    to find the next operating day at openingTime.
 * 3. Exact target millisecond timestamp is calculated for openingTime in the shop timezone.
 * 4. Never uses customer device timezone.
 */
export function calculateNextPickupTarget(
  nowMs: number,
  schedule: ShopOperatingSchedule,
): NextPickupTarget {
  const timezone = isValidTimezone(schedule.timezone)
    ? schedule.timezone
    : "Asia/Kolkata";

  const [openHour, openMin] = schedule.openingTime.split(":").map(Number);
  const operatingDays =
    Array.isArray(schedule.operatingDays) && schedule.operatingDays.length > 0
      ? schedule.operatingDays
      : [1, 2, 3, 4, 5, 6]; // default Mon-Sat

  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  });

  const nowParts = dtf.formatToParts(new Date(nowMs));
  const getPart = (parts: Intl.DateTimeFormatPart[], type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);

  const shopYear = getPart(nowParts, "year");
  const shopMonth = getPart(nowParts, "month"); // 1-12
  const shopDay = getPart(nowParts, "day"); // 1-31
  const shopHour = getPart(nowParts, "hour");
  const shopMin = getPart(nowParts, "minute");
  const nowMinutes = shopHour * 60 + shopMin;
  const openMinutes = (openHour ?? 7) * 60 + (openMin ?? 0);

  const weekdayDtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  });

  // Check offset = 0 (today) if current time is before opening time and today is an operating day
  for (let offset = 0; offset <= 14; offset++) {
    const approxUtc = Date.UTC(
      shopYear,
      shopMonth - 1,
      shopDay + offset,
      12,
      0,
      0,
    );
    const candidateParts = dtf.formatToParts(new Date(approxUtc));
    const candYear = getPart(candidateParts, "year");
    const candMonth = getPart(candidateParts, "month");
    const candDay = getPart(candidateParts, "day");

    const weekdayStr = weekdayDtf.format(new Date(approxUtc));
    const weekdayNum = WEEKDAY_MAP[weekdayStr] ?? 0;

    if (!operatingDays.includes(weekdayNum)) {
      continue;
    }

    if (offset === 0 && nowMinutes >= openMinutes) {
      // Today's opening has already passed
      continue;
    }

    // Found target opening day. Calculate exact UTC ms timestamp for openingTime in timezone
    let testUtc = Date.UTC(
      candYear,
      candMonth - 1,
      candDay,
      openHour ?? 7,
      openMin ?? 0,
      0,
    );
    for (let iter = 0; iter < 3; iter++) {
      const testParts = dtf.formatToParts(new Date(testUtc));
      const tHour = getPart(testParts, "hour");
      const tMin = getPart(testParts, "minute");
      const tDay = getPart(testParts, "day");

      const targetMinuteVal =
        candDay * 24 * 60 + (openHour ?? 7) * 60 + (openMin ?? 0);
      const actualMinuteVal = tDay * 24 * 60 + tHour * 60 + tMin;
      const diffMinutes = targetMinuteVal - actualMinuteVal;

      if (diffMinutes === 0) break;
      testUtc += diffMinutes * 60_000;
    }

    const dateFriendlyDtf = new Intl.DateTimeFormat("en-IN", {
      timeZone: timezone,
      day: "numeric",
      month: "short",
    });
    const formattedDatePart = dateFriendlyDtf.format(new Date(testUtc));
    const timeAmPm = formatTimeAmPm(schedule.openingTime);

    // e.g. "4 Jan, from 7:00 AM" or "Tomorrow, from 7:00 AM"
    const formattedPickupTime = `${formattedDatePart}, from ${timeAmPm}`;

    return {
      targetDateIso: new Date(testUtc).toISOString(),
      targetTimeMs: testUtc,
      formattedPickupTime,
      dayOffset: offset,
    };
  }

  throw new Error("No operating shop day found within the next 14 days.");
}
