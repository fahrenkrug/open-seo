import {
  ga4DateInTimeZone,
  shiftGa4Date,
} from "@/server/features/ga4/services/Ga4Dates";
import type { UmamiTimeRange } from "@/server/lib/umamiClient";
import { UmamiError } from "@/server/lib/umamiErrors";

type DateRange = { startDate: string; endDate: string };

function parseDate(value: string): boolean {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
  );
}

/** Same defaults as the GA4 reports: the last 28 complete days in the
 *  connection's time zone, with a future endDate moved back to yesterday. */
export function resolveUmamiDateRange(
  input: { startDate?: string; endDate?: string },
  timeZone: string,
  now: Date = new Date(),
) {
  if (Boolean(input.startDate) !== Boolean(input.endDate)) {
    throw new UmamiError(
      "validation_error",
      "Provide both startDate and endDate, or neither.",
    );
  }
  const requestedDateRange =
    input.startDate && input.endDate
      ? { startDate: input.startDate, endDate: input.endDate }
      : null;
  if (
    requestedDateRange &&
    (!parseDate(requestedDateRange.startDate) ||
      !parseDate(requestedDateRange.endDate) ||
      requestedDateRange.startDate > requestedDateRange.endDate)
  ) {
    throw new UmamiError(
      "validation_error",
      "Dates must be valid YYYY-MM-DD values with startDate on or before endDate.",
    );
  }
  const lastCompleteDay = shiftGa4Date(ga4DateInTimeZone(now, timeZone), -1);
  let endDate = requestedDateRange?.endDate ?? lastCompleteDay;
  const startDate = requestedDateRange?.startDate ?? shiftGa4Date(endDate, -27);
  const warnings: string[] = [];
  if (endDate > lastCompleteDay) {
    endDate = lastCompleteDay;
    warnings.push("end_date_clamped");
  }
  if (startDate > endDate) {
    throw new UmamiError(
      "validation_error",
      "The resolved startDate is after the last complete day.",
    );
  }
  return {
    requestedDateRange,
    resolvedDateRange: { startDate, endDate },
    warnings,
  };
}

// Milliseconds the zone is ahead of UTC at this instant.
function zoneOffset(instant: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, Number(part.value)]),
  );
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** Epoch milliseconds of local midnight that starts `date` in `timeZone`. */
function zonedMidnight(date: string, timeZone: string): number {
  const utcMidnight = Date.parse(`${date}T00:00:00.000Z`);
  const guess = utcMidnight - zoneOffset(utcMidnight, timeZone);
  // A DST change between the guess and midnight shifts the offset once more.
  return utcMidnight - zoneOffset(guess, timeZone);
}

export function toUmamiTimeRange(
  range: DateRange,
  timeZone: string,
): UmamiTimeRange {
  return {
    startAt: zonedMidnight(range.startDate, timeZone),
    endAt: zonedMidnight(shiftGa4Date(range.endDate, 1), timeZone) - 1,
  };
}

type Series = { x: string; y: number }[];
type TrendUnit = "day" | "month";

// Umami labels buckets "YYYY-MM-DDT00:00:00Z" in the requested zone.
function byPeriod(rows: Series, unit: TrendUnit) {
  const length = unit === "day" ? 10 : 7;
  return new Map(rows.map((row) => [row.x.slice(0, length), row.y]));
}

function periods(range: DateRange, unit: TrendUnit): string[] {
  if (unit === "day") {
    const days: string[] = [];
    for (
      let date = range.startDate;
      date <= range.endDate;
      date = shiftGa4Date(date, 1)
    ) {
      days.push(date);
    }
    return days;
  }
  const months: string[] = [];
  let [year, month] = range.startDate.split("-").map(Number);
  const last = range.endDate.slice(0, 7);
  for (;;) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    if (key > last) break;
    months.push(key);
    month = month === 12 ? 1 : month + 1;
    if (month === 1) year += 1;
  }
  return months;
}

/** Zero-fill the series across the range: Umami omits empty periods. With
 *  the organic filter only entry pageviews match, so pageviews are left out
 *  rather than reported as a visit count. */
export function fillUmamiTrend(
  series: { pageviews: Series; sessions: Series },
  range: DateRange,
  unit: TrendUnit,
  includePageviews: boolean,
) {
  const pageviews = byPeriod(series.pageviews, unit);
  const visitors = byPeriod(series.sessions, unit);
  return periods(range, unit).map((date) => ({
    date,
    visitors: visitors.get(date) ?? 0,
    pageviews: includePageviews ? (pageviews.get(date) ?? 0) : null,
  }));
}
