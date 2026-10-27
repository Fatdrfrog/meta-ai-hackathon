export const CAMPAIGN_SCHEDULE_CONFIG_VERSION = 2 as const;

export type CampaignScheduleWeekday =
  | "sunday"
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday";

export type CampaignScheduleOrdinal = 1 | 2 | 3 | 4 | -1;

export type CampaignScheduleIntervalUnit = "minutes" | "hours" | "days";

export type CampaignScheduleRecurrence =
  | {
      kind: "interval";
      every: number;
      unit: CampaignScheduleIntervalUnit;
    }
  | {
      kind: "daily";
      time: string;
    }
  | {
      kind: "weekly";
      weekdays: CampaignScheduleWeekday[];
      time: string;
    }
  | {
      kind: "monthly_day";
      dayOfMonth: number;
      time: string;
    }
  | {
      kind: "monthly_weekday";
      ordinal: CampaignScheduleOrdinal;
      weekday: CampaignScheduleWeekday;
      time: string;
    };

export type CampaignScheduleConfigBase = {
  version: typeof CAMPAIGN_SCHEDULE_CONFIG_VERSION;
  timezone: string;
  startAt?: string | null;
  endAt?: string | null;
};

export type CampaignScheduleConfig =
  | (CampaignScheduleConfigBase & {
      mode: "once";
      recurrence?: never;
    })
  | (CampaignScheduleConfigBase & {
      mode: "recurring";
      recurrence: CampaignScheduleRecurrence;
    });
