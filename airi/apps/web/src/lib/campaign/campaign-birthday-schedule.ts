import {
  normalizeCampaignScheduleConfig,
  parseCampaignScheduleConfigV2,
} from "@/lib/campaign/campaign-schedule-config";
import type { CampaignScheduleConfig } from "@icecore/scenario-contracts";
import { isRecord } from "@icecore/shared/lib/value-utils";

/** Birthday automation must never replace an invalid time or zone with a default. */
export function parseBirthdayCampaignScheduleConfig(
  value: unknown
): Extract<CampaignScheduleConfig, { mode: "recurring" }> | null {
  if (
    !isRecord(value) ||
    value.mode !== "recurring" ||
    !isRecord(value.recurrence) ||
    value.recurrence.kind !== "daily" ||
    typeof value.recurrence.time !== "string" ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.recurrence.time) ||
    typeof value.timezone !== "string" ||
    !value.timezone.trim()
  )
    return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value.timezone.trim() });
  } catch {
    return null;
  }
  for (const dateBound of [value.startAt, value.endAt]) {
    if (
      dateBound !== undefined &&
      (typeof dateBound !== "string" ||
        !dateBound.trim() ||
        !Number.isFinite(new Date(dateBound).getTime()))
    )
      return null;
  }
  if (
    value.startAt &&
    value.endAt &&
    new Date(String(value.endAt)) <= new Date(String(value.startAt))
  )
    return null;
  const parsed = parseCampaignScheduleConfigV2(value, value.timezone);
  return parsed?.mode === "recurring" ? parsed : null;
}

export function buildBirthdayCampaignScheduleConfig(
  timezone: string,
  time = "09:00"
): CampaignScheduleConfig {
  return normalizeCampaignScheduleConfig({
    timezone,
    config: {
      version: 2,
      mode: "recurring",
      timezone,
      recurrence: {
        kind: "daily",
        time,
      },
    },
  });
}

export function getBirthdayCampaignScheduleTime(
  config: CampaignScheduleConfig | undefined
) {
  return config?.mode === "recurring" && config.recurrence.kind === "daily"
    ? config.recurrence.time
    : "09:00";
}
