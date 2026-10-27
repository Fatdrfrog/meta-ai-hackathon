import {
  buildBirthdayDayKey,
  getZonedBirthdayDateParts,
} from "./campaign-birthday-recipient-plan";

/** Stable day identity plus UTC bounds for older timestamp-keyed reservations. */
export function buildBirthdayCampaignOccurrence(params: {
  date: Date;
  timezone: string;
}): { runKey: string; start: string; end: string } {
  const instant = params.date.getTime();
  if (!Number.isFinite(instant))
    throw new Error("Invalid birthday occurrence date");
  const local = getZonedBirthdayDateParts(params);
  const localDay = Date.UTC(local.year, local.month - 1, local.day);
  const dayMs = 86_400_000;
  // Search actual calendar boundaries instead of adding 24 hours: DST days
  // can be shorter or longer, and some zones change offset at midnight.
  const boundary = (target: number) => {
    let low = instant - 2 * dayMs;
    let high = instant + 2 * dayMs;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      const observed = getZonedBirthdayDateParts({
        date: new Date(middle),
        timezone: params.timezone,
      });
      const observedDay = Date.UTC(
        observed.year,
        observed.month - 1,
        observed.day
      );
      if (observedDay < target) low = middle + 1;
      else high = middle;
    }
    return new Date(low).toISOString();
  };
  return {
    runKey: `birthday:${local.year}-${buildBirthdayDayKey(local)}`,
    start: boundary(localDay),
    end: boundary(localDay + dayMs),
  };
}
