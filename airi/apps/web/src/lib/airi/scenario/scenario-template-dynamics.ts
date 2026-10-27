import type { GoogleCalendarAvailabilityContext } from "@/lib/google-calendar/availability-context";
import { buildGoogleCalendarAvailabilityContext } from "@/lib/google-calendar/availability-context";
import type { AiriScenarioRuntimeConfig } from "@icecore/airi-runtime/scenario-runtime-types";
import { resolveScenarioRuntimeWhatsAppAppointmentConfig } from "@icecore/airi-runtime/scenario-runtime-types";
import { buildWhatsAppBookCallDateRange } from "@/lib/scenarios/whatsapp-book-call";
import {
  isSupportedScenarioTemplateToken,
  listScenarioTemplateTokens,
  parseScenarioTemplatePath,
} from "@icecore/scenario-contracts";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export type ScenarioCalendarTemplateAvailability = {
  connected: boolean;
  nextFreeSlot: string;
  nextFreeSlotEnd: string;
  timeZone: string;
  slotCount: number;
};

export type ScenarioCountdownTemplateContext = {
  days: number;
  hours: number;
  minutes: number;
  humanized: string;
  expired: boolean;
  iso: string;
};

/** Loads availability only for a calendar path the renderer will fill. */
export function scenarioReplyNeedsCalendarTokens(text: string): boolean {
  return listScenarioTemplateTokens(text || "").some(
    token =>
      parseScenarioTemplatePath(token)[0] === "calendar" &&
      isSupportedScenarioTemplateToken(token)
  );
}

function normalizeDate(value: unknown): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function localizeCountdown(params: {
  language?: string;
  kind: "expired" | "days" | "hours" | "minutes";
  value?: number;
}): string {
  const lang = (params.language || "").toLowerCase();
  const isRu = lang.startsWith("ru");
  const isKz = lang.startsWith("kz") || lang.startsWith("kk");
  const isUz = lang.startsWith("uz");
  const value = params.value ?? 0;

  if (params.kind === "expired") {
    if (isRu) return "время истекло";
    if (isKz) return "уақыт бітті";
    if (isUz) return "muddat tugadi";
    return "expired";
  }

  if (params.kind === "days") {
    if (isRu) return `${value} дн. осталось`;
    if (isKz) return `${value} күн қалды`;
    if (isUz) return `${value} kun qoldi`;
    return `${value} day${value === 1 ? "" : "s"} left`;
  }

  if (params.kind === "hours") {
    if (isRu) return `${value} ч. осталось`;
    if (isKz) return `${value} сағат қалды`;
    if (isUz) return `${value} soat qoldi`;
    return `${value} hour${value === 1 ? "" : "s"} left`;
  }

  if (isRu) return `${value} мин. осталось`;
  if (isKz) return `${value} минут қалды`;
  if (isUz) return `${value} daqiqa qoldi`;
  return `${value} minute${value === 1 ? "" : "s"} left`;
}

/**
 * Countdown from the Meta 24-hour free-form messaging window.
 * Uses conversation.last_inbound_at when present.
 */
export function buildMessagingWindowCountdownContext(params: {
  lastInboundAt?: Date | string | null;
  language?: string;
  now?: Date;
}): ScenarioCountdownTemplateContext {
  const now = params.now || new Date();
  const lastInbound = normalizeDate(params.lastInboundAt);
  if (!lastInbound) {
    return {
      days: 0,
      hours: 0,
      minutes: 0,
      humanized: localizeCountdown({
        language: params.language,
        kind: "expired",
      }),
      expired: true,
      iso: "",
    };
  }

  const expiresAtMs = lastInbound.getTime() + DAY_MS;
  const remainingMs = Math.max(0, expiresAtMs - now.getTime());
  const expired = remainingMs <= 0;
  const totalMinutes = expired ? 0 : Math.ceil(remainingMs / MINUTE_MS);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes;

  let humanized: string;
  if (expired) {
    humanized = localizeCountdown({
      language: params.language,
      kind: "expired",
    });
  } else if (hours >= 48) {
    humanized = localizeCountdown({
      language: params.language,
      kind: "days",
      value: Math.max(1, days),
    });
  } else if (hours >= 1) {
    humanized = localizeCountdown({
      language: params.language,
      kind: "hours",
      value: hours,
    });
  } else {
    humanized = localizeCountdown({
      language: params.language,
      kind: "minutes",
      value: Math.max(1, minutes),
    });
  }

  return {
    days,
    hours,
    minutes,
    humanized,
    expired,
    iso: new Date(expiresAtMs).toISOString(),
  };
}

export function formatCalendarNextFreeSlot(params: {
  start: string;
  end?: string;
  timeZone: string;
}): string {
  const start = new Date(params.start);
  if (Number.isNaN(start.getTime())) return "";

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: params.timeZone || "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
  const startText = formatter.format(start);
  if (!params.end) return startText;

  const end = new Date(params.end);
  if (Number.isNaN(end.getTime())) return startText;
  const endFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: params.timeZone || "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${startText} – ${endFormatter.format(end)}`;
}

export function toScenarioCalendarTemplateAvailability(
  context: GoogleCalendarAvailabilityContext | null | undefined
): ScenarioCalendarTemplateAvailability {
  if (!context) {
    return {
      connected: false,
      nextFreeSlot: "",
      nextFreeSlotEnd: "",
      timeZone: "",
      slotCount: 0,
    };
  }

  const first = context.windows[0];
  return {
    connected: true,
    nextFreeSlot: first
      ? formatCalendarNextFreeSlot({
          start: first.start,
          end: first.end,
          timeZone: context.timeZone,
        })
      : "",
    nextFreeSlotEnd: first
      ? formatCalendarNextFreeSlot({
          start: first.end,
          timeZone: context.timeZone,
        })
      : "",
    timeZone: context.timeZone || "",
    slotCount: context.windows.length,
  };
}

/**
 * Fetch next free Google Calendar slot when the reply body asks for calendar.* tokens.
 */
export async function resolveCalendarAvailabilityForScenarioTemplate(params: {
  workspaceId: string;
  replyText: string;
  runtime?: AiriScenarioRuntimeConfig | null;
  now?: Date;
  buildAvailabilityContext?: typeof buildGoogleCalendarAvailabilityContext;
}): Promise<ScenarioCalendarTemplateAvailability | undefined> {
  if (!scenarioReplyNeedsCalendarTokens(params.replyText)) {
    return undefined;
  }

  const loadAvailability =
    params.buildAvailabilityContext || buildGoogleCalendarAvailabilityContext;
  const config = resolveScenarioRuntimeWhatsAppAppointmentConfig(
    params.runtime
  );
  const now = params.now || new Date();

  if (config?.enabled) {
    const dateRange = buildWhatsAppBookCallDateRange({ config, now });
    if (!dateRange) {
      return toScenarioCalendarTemplateAvailability(null);
    }
    const context = await loadAvailability({
      workspaceId: params.workspaceId,
      timeZone: config.timeZone,
      minimumNoticeMinutes: config.minNoticeMinutes,
      horizonDays: config.horizonDays,
      rangeStart: dateRange.rangeStart,
      rangeEnd: dateRange.rangeEnd,
      minDurationMinutes: config.durationMinutes,
      maxWindowMinutes: config.durationMinutes,
      maxWindows: config.maxSlots,
    });
    return toScenarioCalendarTemplateAvailability(context);
  }

  const context = await loadAvailability({
    workspaceId: params.workspaceId,
  });
  return toScenarioCalendarTemplateAvailability(context);
}

export function hoursRemainingFromCountdown(
  countdown: ScenarioCountdownTemplateContext
): number {
  if (countdown.expired) return 0;
  return Math.round((countdown.minutes / 60) * 10) / 10;
}
