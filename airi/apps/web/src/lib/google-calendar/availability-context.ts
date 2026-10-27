import type {
  GoogleCalendarCredentials,
  GoogleCalendarSource,
} from "@icecore/shared/types/sources";
import { createHash } from "crypto";
import {
  GOOGLE_CALENDAR_DEFAULT_CALENDAR_ID,
  GOOGLE_CALENDAR_SOURCE_TYPE,
} from "./google-calendar-source";
import { decryptMaybeString, encryptString } from "@/lib/crypto";
import { isRecord, readDate } from "@icecore/shared/lib/value-utils";

const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";
const CALENDAR_EVENTS_BASE_URL =
  "https://www.googleapis.com/calendar/v3/calendars";
const DEFAULT_HORIZON_DAYS = 7;
const DEFAULT_MIN_NOTICE_MINUTES = 120;
const DEFAULT_MIN_DURATION_MINUTES = 30;
const DEFAULT_MAX_WINDOW_MINUTES = 120;
const DEFAULT_MAX_WINDOWS = 5;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const SIGNATURE_HORIZON_BUCKET_MINUTES = 60;
const SIGNATURE_WINDOW_BUCKET_MINUTES = 15;

type FetchResponseLike = {
  ok: boolean;
  status?: number;
  statusText?: string;
  json: () => Promise<unknown>;
};

type FetchLike = (
  input: string,
  init?: RequestInit
) => Promise<FetchResponseLike>;

export type CalendarBusyInterval = {
  start: string;
  end: string;
};

export type CalendarAvailabilityWindow = {
  start: string;
  end: string;
};

export type GoogleCalendarSourceRepository = {
  findGoogleCalendarSource: (
    workspaceId: string
  ) => Promise<GoogleCalendarSource | null>;
  updateGoogleCalendarCredentials: (
    sourceId: string,
    credentials: GoogleCalendarCredentials
  ) => Promise<void>;
};

export type GoogleCalendarAvailabilityContext = {
  calendarId: string;
  timeZone: string;
  timeMin: string;
  timeMax: string;
  busySlotCount: number;
  windows: CalendarAvailabilityWindow[];
  signature: string;
  promptBlock: string;
};

export type GoogleCalendarBookingEventResult =
  | {
      status: "booked";
      eventId?: string;
      htmlLink?: string;
    }
  | {
      status:
        | "missing_calendar_source"
        | "calendar_unavailable"
        | "slot_unavailable"
        | "event_create_failed";
    };

export type BuildGoogleCalendarAvailabilityContextParams = {
  workspaceId: string;
  now?: Date;
  fetchImpl?: FetchLike;
  sourceRepository?: GoogleCalendarSourceRepository;
  decryptCredential?: (value: unknown) => string;
  encryptCredential?: (
    value: string
  ) => GoogleCalendarCredentials["access_token"];
  clientId?: string;
  clientSecret?: string;
  timeZone?: string;
  rangeStart?: Date;
  rangeEnd?: Date;
  horizonDays?: number;
  minimumNoticeMinutes?: number;
  minDurationMinutes?: number;
  maxWindowMinutes?: number;
  maxWindows?: number;
};

export type CreateGoogleCalendarBookingEventParams = {
  workspaceId: string;
  start: Date;
  end: Date;
  customerWhatsAppNumber: string;
  conversationId: string;
  actionNodeId: string;
  eventTitle?: string;
  timeZone?: string;
  createMeetLink?: boolean;
  now?: Date;
  fetchImpl?: FetchLike;
  sourceRepository?: GoogleCalendarSourceRepository;
  decryptCredential?: (value: unknown) => string;
  encryptCredential?: (
    value: string
  ) => GoogleCalendarCredentials["access_token"];
  clientId?: string;
  clientSecret?: string;
};

function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

function parsePositiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function cleanTimeZone(value: unknown): string {
  const timeZone =
    typeof value === "string" && value.trim()
      ? value.trim()
      : process.env.GOOGLE_CALENDAR_AVAILABILITY_TIME_ZONE || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return "UTC";
  }
}

function normalizeBusyIntervals(params: {
  busy: CalendarBusyInterval[];
  rangeStartMs: number;
  rangeEndMs: number;
}): Array<{ startMs: number; endMs: number }> {
  const intervals = params.busy
    .map(slot => {
      const start = readDate(slot.start);
      const end = readDate(slot.end);
      if (!start || !end) return null;
      const startMs = Math.max(start.getTime(), params.rangeStartMs);
      const endMs = Math.min(end.getTime(), params.rangeEndMs);
      if (endMs <= startMs) return null;
      return { startMs, endMs };
    })
    .filter((slot): slot is { startMs: number; endMs: number } => Boolean(slot))
    .sort((a, b) => a.startMs - b.startMs);

  const merged: Array<{ startMs: number; endMs: number }> = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (!last || interval.startMs > last.endMs) {
      merged.push({ ...interval });
      continue;
    }
    last.endMs = Math.max(last.endMs, interval.endMs);
  }
  return merged;
}

export function computeAvailableWindows(params: {
  rangeStart: Date;
  rangeEnd: Date;
  busy: CalendarBusyInterval[];
  minDurationMinutes?: number;
  maxWindowMinutes?: number;
  maxWindows?: number;
}): CalendarAvailabilityWindow[] {
  const rangeStartMs = params.rangeStart.getTime();
  const rangeEndMs = params.rangeEnd.getTime();
  if (!Number.isFinite(rangeStartMs) || !Number.isFinite(rangeEndMs)) return [];
  if (rangeEndMs <= rangeStartMs) return [];

  const minDurationMs =
    parsePositiveNumber(
      params.minDurationMinutes,
      DEFAULT_MIN_DURATION_MINUTES
    ) * MINUTE_MS;
  const maxWindowMs =
    parsePositiveNumber(params.maxWindowMinutes, DEFAULT_MAX_WINDOW_MINUTES) *
    MINUTE_MS;
  const maxWindows = Math.max(
    1,
    Math.floor(parsePositiveNumber(params.maxWindows, DEFAULT_MAX_WINDOWS))
  );
  const busy = normalizeBusyIntervals({
    busy: params.busy,
    rangeStartMs,
    rangeEndMs,
  });
  const windows: CalendarAvailabilityWindow[] = [];

  const pushGap = (gapStartMs: number, gapEndMs: number) => {
    let cursorMs = gapStartMs;
    while (
      windows.length < maxWindows &&
      gapEndMs - cursorMs >= minDurationMs
    ) {
      const windowEndMs = Math.min(gapEndMs, cursorMs + maxWindowMs);
      windows.push({
        start: new Date(cursorMs).toISOString(),
        end: new Date(windowEndMs).toISOString(),
      });
      cursorMs = windowEndMs;
    }
  };

  let cursorMs = rangeStartMs;
  for (const busySlot of busy) {
    if (busySlot.startMs > cursorMs) {
      pushGap(cursorMs, busySlot.startMs);
      if (windows.length >= maxWindows) break;
    }
    cursorMs = Math.max(cursorMs, busySlot.endMs);
  }
  if (windows.length < maxWindows && cursorMs < rangeEndMs) {
    pushGap(cursorMs, rangeEndMs);
  }

  return windows;
}

function twoDigit(value: number): string {
  return String(value).padStart(2, "0");
}

function sameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

function formatUtcDate(date: Date): string {
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  return `${weekdays[date.getUTCDay()]}, ${
    months[date.getUTCMonth()]
  } ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

function formatUtcTime(date: Date): string {
  return `${twoDigit(date.getUTCHours())}:${twoDigit(date.getUTCMinutes())}`;
}

function formatUtcDateTime(date: Date): string {
  return `${formatUtcDate(date)}, ${formatUtcTime(date)} UTC`;
}

function formatUtcWindow(window: CalendarAvailabilityWindow): string {
  const start = new Date(window.start);
  const end = new Date(window.end);

  if (sameUtcDay(start, end)) {
    return `${formatUtcDate(start)}, ${formatUtcTime(start)}-${formatUtcTime(
      end
    )} UTC`;
  }
  return `${formatUtcDateTime(start)} - ${formatUtcDateTime(end)}`;
}

function formatWindow(
  window: CalendarAvailabilityWindow,
  timeZone: string
): string {
  if (timeZone === "UTC") return formatUtcWindow(window);

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
  return `${formatter.format(new Date(window.start))} - ${formatter.format(
    new Date(window.end)
  )}`;
}

export function formatGoogleCalendarAvailabilityPromptBlock(params: {
  calendarId: string;
  timeZone: string;
  timeMin: string;
  timeMax: string;
  windows: CalendarAvailabilityWindow[];
}): string {
  const windowLines =
    params.windows.length > 0
      ? params.windows
          .map((window, index) => {
            return `${index + 1}. ${formatWindow(window, params.timeZone)}`;
          })
          .join("\n")
      : "No open windows were found in the current free/busy horizon.";

  return [
    "Google Calendar availability (free/busy only):",
    `Calendar: ${params.calendarId}`,
    `Time zone: ${params.timeZone}`,
    `Free/busy horizon: ${params.timeMin} to ${params.timeMax}`,
    "Open windows inferred from free/busy:",
    windowLines,
    "",
    "Use this only if the customer is trying to schedule, book, choose, or change a call, demo, meeting, appointment, or reminder time. If relevant, suggest at most 2-3 open windows and ask the customer to confirm. Do not mention Google Calendar or reveal busy events. Do not create or promise a booking.",
  ].join("\n");
}

function bucketIsoTimestamp(value: string, bucketMinutes: number): string {
  const date = readDate(value);
  const bucketMs = Math.max(1, bucketMinutes) * MINUTE_MS;
  if (!date) return "";
  return new Date(
    Math.floor(date.getTime() / bucketMs) * bucketMs
  ).toISOString();
}

export function buildGoogleCalendarAvailabilitySignature(params: {
  calendarId: string;
  timeZone: string;
  timeMin: string;
  timeMax: string;
  windows: CalendarAvailabilityWindow[];
}): string {
  const normalized = {
    calendarId: params.calendarId,
    timeZone: params.timeZone,
    timeMin: bucketIsoTimestamp(
      params.timeMin,
      SIGNATURE_HORIZON_BUCKET_MINUTES
    ),
    timeMax: bucketIsoTimestamp(
      params.timeMax,
      SIGNATURE_HORIZON_BUCKET_MINUTES
    ),
    windows: params.windows.map(window => ({
      start: bucketIsoTimestamp(window.start, SIGNATURE_WINDOW_BUCKET_MINUTES),
      end: bucketIsoTimestamp(window.end, SIGNATURE_WINDOW_BUCKET_MINUTES),
    })),
  };

  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

async function createDefaultSourceRepository(): Promise<GoogleCalendarSourceRepository> {
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  return {
    async findGoogleCalendarSource(workspaceId: string) {
      const { data, error } = await supabaseAdmin
        .from("sources")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("type", GOOGLE_CALENDAR_SOURCE_TYPE)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error || !data) return null;
      return data as GoogleCalendarSource;
    },
    async updateGoogleCalendarCredentials(sourceId, credentials) {
      await supabaseAdmin
        .from("sources")
        .update({ credentials })
        .eq("id", sourceId);
    },
  };
}

function getCredentials(
  source: GoogleCalendarSource
): GoogleCalendarCredentials {
  return (
    isRecord(source.credentials) ? source.credentials : {}
  ) as GoogleCalendarCredentials;
}

function shouldRefreshAccessToken(
  credentials: GoogleCalendarCredentials,
  now: Date
): boolean {
  const expiresAt = readDate(credentials.expires_at);
  if (!expiresAt) return Boolean(credentials.refresh_token);
  return expiresAt.getTime() <= now.getTime() + TOKEN_REFRESH_BUFFER_MS;
}

async function refreshGoogleCalendarAccessToken(params: {
  source: GoogleCalendarSource;
  credentials: GoogleCalendarCredentials;
  now: Date;
  fetchImpl: FetchLike;
  sourceRepository: GoogleCalendarSourceRepository;
  decryptCredential: (value: unknown) => string;
  encryptCredential: (
    value: string
  ) => GoogleCalendarCredentials["access_token"];
  clientId?: string;
  clientSecret?: string;
}): Promise<string> {
  const clientId = params.clientId || process.env.GOOGLE_AUTH_CLIENT_ID;
  const clientSecret =
    params.clientSecret || process.env.GOOGLE_AUTH_CLIENT_SECRET;
  const refreshToken = params.decryptCredential(
    params.credentials.refresh_token
  );

  if (!clientId || !clientSecret || !refreshToken) return "";

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const response = await params.fetchImpl(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }
  );
  if (!response.ok) return "";

  const payload = await response.json();
  if (!isRecord(payload) || typeof payload.access_token !== "string") {
    return "";
  }

  const expiresIn =
    typeof payload.expires_in === "number" &&
    Number.isFinite(payload.expires_in)
      ? payload.expires_in
      : null;
  const nextCredentials: GoogleCalendarCredentials = {
    ...params.credentials,
    access_token: params.encryptCredential(payload.access_token),
    expires_at: expiresIn
      ? addMs(params.now, expiresIn * 1000).toISOString()
      : (params.credentials.expires_at ?? null),
    scope:
      typeof payload.scope === "string"
        ? payload.scope
        : params.credentials.scope,
    token_type:
      typeof payload.token_type === "string"
        ? payload.token_type
        : params.credentials.token_type || "Bearer",
  };

  await params.sourceRepository.updateGoogleCalendarCredentials(
    params.source.id,
    nextCredentials
  );
  return payload.access_token;
}

async function resolveAccessToken(params: {
  source: GoogleCalendarSource;
  now: Date;
  fetchImpl: FetchLike;
  sourceRepository: GoogleCalendarSourceRepository;
  decryptCredential: (value: unknown) => string;
  encryptCredential: (
    value: string
  ) => GoogleCalendarCredentials["access_token"];
  clientId?: string;
  clientSecret?: string;
}): Promise<string> {
  const credentials = getCredentials(params.source);
  if (shouldRefreshAccessToken(credentials, params.now)) {
    const refreshed = await refreshGoogleCalendarAccessToken({
      source: params.source,
      credentials,
      now: params.now,
      fetchImpl: params.fetchImpl,
      sourceRepository: params.sourceRepository,
      decryptCredential: params.decryptCredential,
      encryptCredential: params.encryptCredential,
      clientId: params.clientId,
      clientSecret: params.clientSecret,
    });
    if (refreshed) return refreshed;
  }

  return params.decryptCredential(credentials.access_token);
}

function isFreeBusyAuthFailure(response: FetchResponseLike): boolean {
  return response.status === 401 || response.status === 403;
}

function logGoogleCalendarAvailabilityWarn(
  message: string,
  metadata: Record<string, unknown>
) {
  console.warn(`[google-calendar.availability] ${message}`, metadata);
}

async function fetchGoogleCalendarFreeBusy(params: {
  fetchImpl: FetchLike;
  accessToken: string;
  calendarId: string;
  timeZone: string;
  rangeStart: Date;
  rangeEnd: Date;
}): Promise<FetchResponseLike> {
  return params.fetchImpl(FREEBUSY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      timeMin: params.rangeStart.toISOString(),
      timeMax: params.rangeEnd.toISOString(),
      timeZone: params.timeZone,
      items: [{ id: params.calendarId }],
    }),
  });
}

function readBusySlots(
  payload: unknown,
  calendarId: string
): CalendarBusyInterval[] | null {
  if (!isRecord(payload) || !isRecord(payload.calendars)) return null;
  const calendar = payload.calendars[calendarId];
  if (!isRecord(calendar)) return null;
  if (Array.isArray(calendar.errors) && calendar.errors.length > 0) {
    return null;
  }
  if (!Array.isArray(calendar.busy)) return null;

  return calendar.busy
    .map(slot => {
      if (!isRecord(slot)) return null;
      const start = typeof slot.start === "string" ? slot.start : "";
      const end = typeof slot.end === "string" ? slot.end : "";
      return start && end ? { start, end } : null;
    })
    .filter((slot): slot is CalendarBusyInterval => Boolean(slot));
}

function busyOverlapsRange(params: {
  busy: CalendarBusyInterval[];
  rangeStart: Date;
  rangeEnd: Date;
}): boolean {
  const rangeStartMs = params.rangeStart.getTime();
  const rangeEndMs = params.rangeEnd.getTime();
  return params.busy.some(slot => {
    const start = readDate(slot.start);
    const end = readDate(slot.end);
    if (!start || !end) return false;
    return start.getTime() < rangeEndMs && end.getTime() > rangeStartMs;
  });
}

function safeGoogleRequestId(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
  return normalized || `booking-${Date.now()}`;
}

function cleanCalendarEventText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim()
    ? value.trim().replace(/\s+/g, " ").slice(0, 240)
    : fallback;
}

async function resolveGoogleCalendarAccess(params: {
  workspaceId: string;
  now: Date;
  fetchImpl: FetchLike;
  sourceRepository: GoogleCalendarSourceRepository;
  decryptCredential: (value: unknown) => string;
  encryptCredential: (
    value: string
  ) => GoogleCalendarCredentials["access_token"];
  clientId?: string;
  clientSecret?: string;
}): Promise<{
  source: GoogleCalendarSource;
  credentials: GoogleCalendarCredentials;
  calendarId: string;
  accessToken: string;
} | null> {
  const source = await params.sourceRepository.findGoogleCalendarSource(
    params.workspaceId
  );
  if (!source) return null;

  const credentials = getCredentials(source);
  const calendarId =
    typeof credentials.calendar_id === "string" &&
    credentials.calendar_id.trim()
      ? credentials.calendar_id.trim()
      : GOOGLE_CALENDAR_DEFAULT_CALENDAR_ID;
  const accessToken = await resolveAccessToken({
    source,
    now: params.now,
    fetchImpl: params.fetchImpl,
    sourceRepository: params.sourceRepository,
    decryptCredential: params.decryptCredential,
    encryptCredential: params.encryptCredential,
    clientId: params.clientId,
    clientSecret: params.clientSecret,
  });
  if (!accessToken) return null;

  return { source, credentials, calendarId, accessToken };
}

export async function createGoogleCalendarBookingEvent(
  params: CreateGoogleCalendarBookingEventParams
): Promise<GoogleCalendarBookingEventResult> {
  const workspaceId = params.workspaceId.trim();
  if (!workspaceId) return { status: "missing_calendar_source" };

  const fetchImpl = params.fetchImpl || globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) return { status: "calendar_unavailable" };

  const start =
    params.start && Number.isFinite(params.start.getTime())
      ? params.start
      : null;
  const end =
    params.end && Number.isFinite(params.end.getTime()) ? params.end : null;
  if (!start || !end || end.getTime() <= start.getTime()) {
    return { status: "slot_unavailable" };
  }

  const now =
    params.now && Number.isFinite(params.now.getTime())
      ? params.now
      : new Date();
  const sourceRepository =
    params.sourceRepository || (await createDefaultSourceRepository());
  const decryptCredential = params.decryptCredential || decryptMaybeString;
  const encryptCredential = params.encryptCredential || encryptString;
  const access = await resolveGoogleCalendarAccess({
    workspaceId,
    now,
    fetchImpl,
    sourceRepository,
    decryptCredential,
    encryptCredential,
    clientId: params.clientId,
    clientSecret: params.clientSecret,
  });
  if (!access) return { status: "missing_calendar_source" };

  const timeZone = cleanTimeZone(params.timeZone);
  const freeBusyResponse = await fetchGoogleCalendarFreeBusy({
    fetchImpl,
    accessToken: access.accessToken,
    calendarId: access.calendarId,
    timeZone,
    rangeStart: start,
    rangeEnd: end,
  });
  if (!freeBusyResponse.ok) {
    return { status: "calendar_unavailable" };
  }

  const freeBusyPayload = await freeBusyResponse.json();
  const busy = readBusySlots(freeBusyPayload, access.calendarId);
  if (!busy) return { status: "calendar_unavailable" };
  if (busyOverlapsRange({ busy, rangeStart: start, rangeEnd: end })) {
    return { status: "slot_unavailable" };
  }

  const whatsappNumber = cleanCalendarEventText(
    params.customerWhatsAppNumber,
    "Unknown WhatsApp number"
  );
  const eventTitle = cleanCalendarEventText(params.eventTitle, "Call");
  const summary = `${eventTitle} with ${whatsappNumber}`.slice(0, 240);
  const requestId = safeGoogleRequestId(
    `airi-${params.conversationId}-${params.actionNodeId}-${start.getTime()}`
  );
  const eventBody: Record<string, unknown> = {
    summary,
    description: [
      "Booked by Airi from WhatsApp.",
      `WhatsApp: ${whatsappNumber}`,
      `Conversation: ${params.conversationId}`,
    ].join("\n"),
    start: {
      dateTime: start.toISOString(),
      timeZone,
    },
    end: {
      dateTime: end.toISOString(),
      timeZone,
    },
    extendedProperties: {
      private: {
        airiConversationId: params.conversationId,
        airiActionNodeId: params.actionNodeId,
        whatsappNumber,
      },
    },
  };

  if (params.createMeetLink) {
    eventBody.conferenceData = {
      createRequest: {
        requestId,
      },
    };
  }

  const eventUrl = new URL(
    `${CALENDAR_EVENTS_BASE_URL}/${encodeURIComponent(access.calendarId)}/events`
  );
  if (params.createMeetLink) {
    eventUrl.searchParams.set("conferenceDataVersion", "1");
  }

  const eventResponse = await fetchImpl(eventUrl.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(eventBody),
  });
  if (!eventResponse.ok) {
    return { status: "event_create_failed" };
  }

  const eventPayload = await eventResponse.json();
  const event = isRecord(eventPayload) ? eventPayload : {};
  return {
    status: "booked",
    eventId: typeof event.id === "string" ? event.id : undefined,
    htmlLink: typeof event.htmlLink === "string" ? event.htmlLink : undefined,
  };
}

export async function buildGoogleCalendarAvailabilityContext(
  params: BuildGoogleCalendarAvailabilityContextParams
): Promise<GoogleCalendarAvailabilityContext | null> {
  const workspaceId = params.workspaceId.trim();
  if (!workspaceId) return null;

  const fetchImpl = params.fetchImpl || globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) return null;

  const now =
    params.now && Number.isFinite(params.now.getTime())
      ? params.now
      : new Date();
  const sourceRepository =
    params.sourceRepository || (await createDefaultSourceRepository());
  const source = await sourceRepository.findGoogleCalendarSource(workspaceId);
  if (!source) return null;

  const credentials = getCredentials(source);
  const calendarId =
    typeof credentials.calendar_id === "string" &&
    credentials.calendar_id.trim()
      ? credentials.calendar_id.trim()
      : GOOGLE_CALENDAR_DEFAULT_CALENDAR_ID;
  const decryptCredential = params.decryptCredential || decryptMaybeString;
  const encryptCredential = params.encryptCredential || encryptString;
  const accessToken = await resolveAccessToken({
    source,
    now,
    fetchImpl,
    sourceRepository,
    decryptCredential,
    encryptCredential,
    clientId: params.clientId,
    clientSecret: params.clientSecret,
  });
  if (!accessToken) return null;

  const timeZone = cleanTimeZone(params.timeZone);
  const minimumNoticeMinutes = parseNonNegativeNumber(
    params.minimumNoticeMinutes,
    DEFAULT_MIN_NOTICE_MINUTES
  );
  const horizonDays = parsePositiveNumber(
    params.horizonDays,
    DEFAULT_HORIZON_DAYS
  );
  const earliestStart = addMs(now, minimumNoticeMinutes * MINUTE_MS);
  const requestedRangeStart =
    params.rangeStart && Number.isFinite(params.rangeStart.getTime())
      ? params.rangeStart
      : null;
  const requestedRangeEnd =
    params.rangeEnd && Number.isFinite(params.rangeEnd.getTime())
      ? params.rangeEnd
      : null;
  const rangeStart = requestedRangeStart
    ? new Date(Math.max(requestedRangeStart.getTime(), earliestStart.getTime()))
    : earliestStart;
  const rangeEnd = requestedRangeEnd || addMs(rangeStart, horizonDays * DAY_MS);
  if (rangeEnd.getTime() <= rangeStart.getTime()) return null;

  let response = await fetchGoogleCalendarFreeBusy({
    fetchImpl,
    accessToken,
    calendarId,
    timeZone,
    rangeStart,
    rangeEnd,
  });
  if (isFreeBusyAuthFailure(response)) {
    logGoogleCalendarAvailabilityWarn("freebusy auth failed", {
      workspaceId,
      sourceId: source.id,
      status: response.status,
    });
    const refreshedAccessToken = await refreshGoogleCalendarAccessToken({
      source,
      credentials,
      now,
      fetchImpl,
      sourceRepository,
      decryptCredential,
      encryptCredential,
      clientId: params.clientId,
      clientSecret: params.clientSecret,
    });
    if (refreshedAccessToken) {
      response = await fetchGoogleCalendarFreeBusy({
        fetchImpl,
        accessToken: refreshedAccessToken,
        calendarId,
        timeZone,
        rangeStart,
        rangeEnd,
      });
    }
  }
  if (!response.ok) {
    logGoogleCalendarAvailabilityWarn("freebusy request failed", {
      workspaceId,
      sourceId: source.id,
      status: response.status,
    });
    return null;
  }

  const payload = await response.json();
  const busy = readBusySlots(payload, calendarId);
  if (!busy) {
    logGoogleCalendarAvailabilityWarn("freebusy calendar unavailable", {
      workspaceId,
      sourceId: source.id,
      calendarId,
    });
    return null;
  }
  const windows = computeAvailableWindows({
    rangeStart,
    rangeEnd,
    busy,
    minDurationMinutes: params.minDurationMinutes,
    maxWindowMinutes: params.maxWindowMinutes,
    maxWindows: params.maxWindows,
  });
  const promptBlock = formatGoogleCalendarAvailabilityPromptBlock({
    calendarId,
    timeZone,
    timeMin: rangeStart.toISOString(),
    timeMax: rangeEnd.toISOString(),
    windows,
  });
  const signature = buildGoogleCalendarAvailabilitySignature({
    calendarId,
    timeZone,
    timeMin: rangeStart.toISOString(),
    timeMax: rangeEnd.toISOString(),
    windows,
  });

  return {
    calendarId,
    timeZone,
    timeMin: rangeStart.toISOString(),
    timeMax: rangeEnd.toISOString(),
    busySlotCount: busy.length,
    windows,
    signature,
    promptBlock,
  };
}
