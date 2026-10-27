import type { AiriScenarioRuntimeConfig } from "@icecore/airi-runtime/scenario-runtime-types";
import { resolveScenarioRuntimeWhatsAppAppointmentConfig } from "@icecore/airi-runtime/scenario-runtime-types";
import {
  type CreateGoogleCalendarBookingEventParams,
  type GoogleCalendarAvailabilityContext,
  type GoogleCalendarBookingEventResult,
  buildGoogleCalendarAvailabilityContext,
  createGoogleCalendarBookingEvent,
} from "@/lib/google-calendar/availability-context";
import {
  findRawScenarioNode,
  type ScenarioGraphRecord,
} from "@icecore/airi-runtime/scenario-graph";
import { resolveScenarioActionTypeFromNodeData } from "@icecore/airi-runtime/scenario-action-semantics";
import { normalizeActionReplyChannelForActionNode } from "@/lib/scenarios/normalization";
import {
  buildWhatsAppBookCallChoices,
  buildWhatsAppBookCallDateRange,
} from "@/lib/scenarios/whatsapp-book-call";
import { resolveScenarioWhatsAppServiceMessage } from "@/lib/scenarios/whatsapp-service-message";
import { Scenario } from "@/models/scenario";
import {
  buildWhatsAppBookCallPayload,
  parseWhatsAppBookCallPayload,
  type ScenarioWhatsAppBookCallConfig,
  type ScenarioWhatsAppSessionChoice,
} from "@icecore/scenario-contracts";
import type { WhatsAppNormalizedContact } from "@icecore/shared/lib/whatsapp/contact-identities";

type BuildAvailabilityContext = typeof buildGoogleCalendarAvailabilityContext;
type CreateBookingEvent = (
  params: CreateGoogleCalendarBookingEventParams
) => Promise<GoogleCalendarBookingEventResult>;
type ResolveAppointmentConfig = (params: {
  workspaceId: string;
  actionNodeId: string;
}) => Promise<ScenarioWhatsAppBookCallConfig | null>;

export type ScenarioWhatsAppAppointmentAvailability = {
  config: ScenarioWhatsAppBookCallConfig;
  context: GoogleCalendarAvailabilityContext | null;
  choices: ScenarioWhatsAppSessionChoice[];
};

export type WhatsAppBookCallTapRejectionReason =
  | "appointment_not_found"
  | "slot_outside_current_window"
  | "slot_not_offered";

function rejectedBookCallTap(
  payload: NonNullable<ReturnType<typeof parseWhatsAppBookCallPayload>>,
  rejectionReason: WhatsAppBookCallTapRejectionReason
) {
  const eventResult = {
    status: "slot_unavailable",
  } satisfies GoogleCalendarBookingEventResult;
  return {
    payload,
    eventResult,
    confirmationText: getBookingConfirmationText(eventResult),
    rejectionReason,
  };
}

export function resolveWhatsAppBookCallAppointmentConfigFromScenarios(params: {
  scenarios: ScenarioGraphRecord[];
  actionNodeId: string;
}): ScenarioWhatsAppBookCallConfig | null {
  const matchingActions = params.scenarios.flatMap(scenario => {
    const action = findRawScenarioNode({
      scenario,
      nodeId: params.actionNodeId,
      kind: "action",
    });
    return action ? [action] : [];
  });
  if (matchingActions.length !== 1) return null;

  const action = matchingActions[0];
  if (
    resolveScenarioActionTypeFromNodeData(action.data) !== "reply" ||
    normalizeActionReplyChannelForActionNode(action.data) !== "whatsapp"
  ) {
    return null;
  }

  const resolution = resolveScenarioWhatsAppServiceMessage(action.data);
  return resolution.status === "canonical" &&
    resolution.value.message.kind === "appointment"
    ? resolution.value.message.config
    : null;
}

async function resolveActiveWhatsAppBookCallAppointmentConfig(params: {
  workspaceId: string;
  actionNodeId: string;
}): Promise<ScenarioWhatsAppBookCallConfig | null> {
  const workspaceId = params.workspaceId.trim();
  const actionNodeId = params.actionNodeId.trim();
  if (!workspaceId || !actionNodeId) return null;

  const scenarios = await Scenario.find({
    workspaceId,
    status: "active",
    mode: { $ne: "bulk_campaign" },
    deletedAt: null,
    nodes: {
      $elemMatch: {
        id: actionNodeId,
        "data.kind": "action",
      },
    },
  })
    .select("_id nodes")
    .limit(2)
    .lean<ScenarioGraphRecord[]>();

  return resolveWhatsAppBookCallAppointmentConfigFromScenarios({
    scenarios,
    actionNodeId,
  });
}

async function buildScenarioWhatsAppAppointmentAvailability(params: {
  config: ScenarioWhatsAppBookCallConfig;
  actionNodeId: string;
  workspaceId: string;
  now?: Date;
  buildAvailabilityContext?: BuildAvailabilityContext;
}): Promise<ScenarioWhatsAppAppointmentAvailability> {
  const dateRange = buildWhatsAppBookCallDateRange({
    config: params.config,
    now: params.now,
  });
  if (!dateRange) {
    return {
      config: params.config,
      context: null,
      choices: [],
    };
  }

  const loadAvailability =
    params.buildAvailabilityContext || buildGoogleCalendarAvailabilityContext;
  const context = await loadAvailability({
    workspaceId: params.workspaceId,
    timeZone: params.config.timeZone,
    minimumNoticeMinutes: params.config.minNoticeMinutes,
    horizonDays: params.config.horizonDays,
    rangeStart: dateRange.rangeStart,
    rangeEnd: dateRange.rangeEnd,
    minDurationMinutes: params.config.durationMinutes,
    maxWindowMinutes: params.config.durationMinutes,
    maxWindows: params.config.maxSlots,
  }).catch(() => null);

  return {
    config: params.config,
    context,
    choices: buildWhatsAppBookCallChoices({
      actionNodeId: params.actionNodeId,
      windows: context?.windows ?? [],
      timeZone: params.config.timeZone,
      durationMinutes: params.config.durationMinutes,
      maxSlots: params.config.maxSlots,
    }),
  };
}

export async function resolveScenarioWhatsAppAppointmentAvailability(params: {
  runtime: AiriScenarioRuntimeConfig | null | undefined;
  workspaceId: string;
  now?: Date;
  buildAvailabilityContext?: BuildAvailabilityContext;
}): Promise<ScenarioWhatsAppAppointmentAvailability | undefined> {
  const config = resolveScenarioRuntimeWhatsAppAppointmentConfig(
    params.runtime
  );
  const actionNodeId = params.runtime?.selectedActionNodeId?.trim() || "";
  if (!config?.enabled || !actionNodeId) return undefined;

  return buildScenarioWhatsAppAppointmentAvailability({
    config,
    actionNodeId,
    workspaceId: params.workspaceId,
    now: params.now,
    buildAvailabilityContext: params.buildAvailabilityContext,
  });
}

function formatWhatsAppNumberForCalendar(
  contactData: WhatsAppNormalizedContact | null | undefined
): string {
  const waId = contactData?.waId?.trim();
  if (waId) return waId.startsWith("+") ? waId : `+${waId}`;
  return (
    contactData?.userId?.trim() ||
    contactData?.parentUserId?.trim() ||
    "Unknown WhatsApp number"
  );
}

function getBookingConfirmationText(
  result: GoogleCalendarBookingEventResult
): string {
  if (result.status === "booked") {
    return "Airi: Your call is booked. I saved this time on the calendar.";
  }
  if (result.status === "slot_unavailable") {
    return "Airi: That time is no longer available. Please choose another slot.";
  }
  if (result.status === "missing_calendar_source") {
    return "Airi: I could not access the calendar for this booking.";
  }
  return "Airi: I could not create the calendar event. Please try again.";
}

export async function handleWhatsAppBookCallTap(params: {
  payload: string | null | undefined;
  workspaceId: string;
  conversationId: string;
  contactData?: WhatsAppNormalizedContact | null;
  now?: Date;
  resolveAppointmentConfig?: ResolveAppointmentConfig;
  buildAvailabilityContext?: BuildAvailabilityContext;
  createBookingEvent?: CreateBookingEvent;
}) {
  const parsed = parseWhatsAppBookCallPayload(params.payload);
  if (!parsed) return null;

  const resolveAppointmentConfig =
    params.resolveAppointmentConfig ||
    resolveActiveWhatsAppBookCallAppointmentConfig;
  const config = await resolveAppointmentConfig({
    workspaceId: params.workspaceId,
    actionNodeId: parsed.actionNodeId,
  });
  if (!config?.enabled) {
    return rejectedBookCallTap(parsed, "appointment_not_found");
  }

  const dateRange = buildWhatsAppBookCallDateRange({
    config,
    now: params.now,
  });
  const durationMs = (config.durationMinutes ?? 30) * 60 * 1000;
  if (
    !dateRange ||
    parsed.endMs - parsed.startMs !== durationMs ||
    parsed.startMs < dateRange.rangeStart.getTime() ||
    parsed.endMs > dateRange.rangeEnd.getTime()
  ) {
    return rejectedBookCallTap(parsed, "slot_outside_current_window");
  }

  const availability = await buildScenarioWhatsAppAppointmentAvailability({
    config,
    actionNodeId: parsed.actionNodeId,
    workspaceId: params.workspaceId,
    now: params.now,
    buildAvailabilityContext: params.buildAvailabilityContext,
  });
  const normalizedPayload = buildWhatsAppBookCallPayload(parsed);
  if (
    !availability.choices.some(choice => choice.payload === normalizedPayload)
  ) {
    return rejectedBookCallTap(parsed, "slot_not_offered");
  }

  const createEvent =
    params.createBookingEvent || createGoogleCalendarBookingEvent;
  const eventResult = await createEvent({
    workspaceId: params.workspaceId,
    start: new Date(parsed.startMs),
    end: new Date(parsed.endMs),
    customerWhatsAppNumber: formatWhatsAppNumberForCalendar(params.contactData),
    conversationId: params.conversationId,
    actionNodeId: parsed.actionNodeId,
    eventTitle: config.eventTitle,
    timeZone: config.timeZone,
    createMeetLink: config.createMeetLink,
    now: params.now,
  });

  return {
    payload: parsed,
    eventResult,
    confirmationText: getBookingConfirmationText(eventResult),
    rejectionReason: undefined,
  };
}
