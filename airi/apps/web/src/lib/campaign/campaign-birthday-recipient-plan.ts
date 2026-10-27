import type { ScenarioCampaignRecipient } from "@icecore/scenario-contracts";

import { normalizeCampaignTimezone } from "./campaign-schedule-config";
import {
  isLeapYear,
  isCustomerBirthdayFieldName,
  parseCustomerBirthday,
} from "../customers/customer-birthday";
import { normalizePhone } from "../customers/shared";
import { normalizeTelegramChatId } from "../telegram/chat-id";

export const BIRTHDAY_CAMPAIGN_UPLOAD_RECIPIENT_LIMIT = 10_000;

export type BirthdayRecipientDayCount = {
  key: string;
  month: number;
  day: number;
  count: number;
  limit?: number | null;
  overflow: number;
  nonLeapFeb28?: boolean;
};

export type BirthdayRecipientPlan = {
  selectedRecipientCount: number;
  uniquePhoneCount: number;
  validBirthdayCount: number;
  missingBirthdayCount: number;
  invalidBirthdayCount: number;
  duplicatePhoneCount: number;
  todayBirthdayCount: number;
  dayCounts: BirthdayRecipientDayCount[];
  overLimitDays: BirthdayRecipientDayCount[];
};

function normalizePositiveLimit(limit?: number | null): number | null {
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : null;
}

function resolveBirthdayRaw(recipient: ScenarioCampaignRecipient): unknown {
  if (recipient.birthday) return recipient.birthday;
  for (const [key, value] of Object.entries(recipient.fields || {})) {
    if (isCustomerBirthdayFieldName(key)) return value;
  }
  return "";
}

export function buildBirthdayDayKey(params: {
  month: number;
  day: number;
}): string {
  return `${String(params.month).padStart(2, "0")}-${String(params.day).padStart(2, "0")}`;
}

export function getZonedBirthdayDateParts(params: {
  date: Date;
  timezone: string;
}): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: normalizeCampaignTimezone(params.timezone),
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  const parts = formatter.formatToParts(params.date);
  const get = (type: string) =>
    Number.parseInt(parts.find(part => part.type === type)?.value || "", 10);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
  };
}

function incrementDay(
  counts: Map<string, BirthdayRecipientDayCount>,
  params: {
    month: number;
    day: number;
    count?: number;
    nonLeapFeb28?: boolean;
  }
) {
  const key = params.nonLeapFeb28
    ? "02-28-non-leap"
    : buildBirthdayDayKey(params);
  const current = counts.get(key);
  if (current) {
    current.count += params.count || 1;
    return;
  }
  counts.set(key, {
    key,
    month: params.month,
    day: params.day,
    count: params.count || 1,
    overflow: 0,
    nonLeapFeb28: params.nonLeapFeb28 || undefined,
  });
}

function sortBirthdayDays(
  left: BirthdayRecipientDayCount,
  right: BirthdayRecipientDayCount
) {
  if (left.month !== right.month) return left.month - right.month;
  if (left.day !== right.day) return left.day - right.day;
  return left.key.localeCompare(right.key);
}

export function buildBirthdayRecipientPlan(params: {
  recipients: ScenarioCampaignRecipient[];
  dailyLimit?: number | null;
  timezone?: string | null;
  now?: Date;
}): BirthdayRecipientPlan {
  const dailyLimit = normalizePositiveLimit(params.dailyLimit);
  const timezone = normalizeCampaignTimezone(params.timezone);
  const today = getZonedBirthdayDateParts({
    date: params.now || new Date(),
    timezone,
  });
  const todayKeys = new Set([
    buildBirthdayDayKey({ month: today.month, day: today.day }),
  ]);
  if (today.month === 2 && today.day === 28 && !isLeapYear(today.year)) {
    todayKeys.add(buildBirthdayDayKey({ month: 2, day: 29 }));
  }

  let missingBirthdayCount = 0;
  let invalidBirthdayCount = 0;
  let duplicatePhoneCount = 0;
  const seenRecipients = new Set<string>();
  const latestBirthdayByRecipient = new Map<
    string,
    { month: number; day: number }
  >();

  for (const recipient of params.recipients) {
    const phone = normalizePhone(recipient.phone || "");
    const chatId = normalizeTelegramChatId(recipient.chatId);
    const recipientKey = phone
      ? `phone:${phone}`
      : chatId
        ? `telegram:${chatId}`
        : "";
    if (!recipientKey) continue;
    if (seenRecipients.has(recipientKey)) {
      duplicatePhoneCount += 1;
    }
    seenRecipients.add(recipientKey);

    const rawBirthday = resolveBirthdayRaw(recipient);
    if (!rawBirthday) {
      missingBirthdayCount += 1;
      continue;
    }

    const parsed = parseCustomerBirthday(rawBirthday);
    if (!parsed.ok) {
      invalidBirthdayCount += 1;
      continue;
    }

    latestBirthdayByRecipient.set(recipientKey, {
      month: parsed.birthday.month,
      day: parsed.birthday.day,
    });
  }

  const exactCounts = new Map<string, BirthdayRecipientDayCount>();
  for (const birthday of latestBirthdayByRecipient.values()) {
    incrementDay(exactCounts, birthday);
  }

  const feb28 = exactCounts.get("02-28")?.count || 0;
  const feb29 = exactCounts.get("02-29")?.count || 0;
  if (feb28 + feb29 > 0) {
    incrementDay(exactCounts, {
      month: 2,
      day: 28,
      count: feb28 + feb29,
      nonLeapFeb28: true,
    });
  }

  const dayCounts = Array.from(exactCounts.values())
    .map(day => ({
      ...day,
      limit: dailyLimit,
      overflow: dailyLimit ? Math.max(0, day.count - dailyLimit) : 0,
    }))
    .sort(sortBirthdayDays);

  const todayBirthdayCount = Array.from(
    latestBirthdayByRecipient.values()
  ).filter(birthday =>
    todayKeys.has(
      buildBirthdayDayKey({ month: birthday.month, day: birthday.day })
    )
  ).length;

  return {
    selectedRecipientCount: params.recipients.length,
    uniquePhoneCount: seenRecipients.size,
    validBirthdayCount: latestBirthdayByRecipient.size,
    missingBirthdayCount,
    invalidBirthdayCount,
    duplicatePhoneCount,
    todayBirthdayCount,
    dayCounts,
    overLimitDays: dayCounts.filter(day => day.overflow > 0),
  };
}
