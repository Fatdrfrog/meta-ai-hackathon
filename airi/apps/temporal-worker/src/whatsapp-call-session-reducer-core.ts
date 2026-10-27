import type { WhatsAppCallWebhookEvent } from "@icecore/shared/lib/whatsapp/webhook-call-events";
import { parseWhatsAppTimestamp } from "@icecore/shared/lib/whatsapp/webhook-payload";

export const WHATSAPP_CALL_SESSION_STATES = [
  "unknown",
  "incoming",
  "pre_accepted",
  "accepted",
  "ringing",
  "active",
  "terminated",
  "missed",
  "failed",
] as const;

export type WhatsAppCallSessionState =
  (typeof WHATSAPP_CALL_SESSION_STATES)[number];

type ExecQuery<T> = {
  exec: () => Promise<T>;
};

export type WhatsAppCallSessionReducerDependencies<TSession> = {
  whatsAppCallSessionModel: {
    findOneAndUpdate: (
      query: Record<string, unknown>,
      update: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => ExecQuery<TSession | null>;
  };
};

const INCOMING_EVENTS = new Set(["connect", "request", "incoming"]);
const PRE_ACCEPTED_EVENTS = new Set([
  "pre_accept",
  "pre_accepted",
  "preaccept",
]);
const ACCEPTED_EVENTS = new Set(["accept", "accepted"]);
const TERMINATED_EVENTS = new Set([
  "terminate",
  "terminated",
  "disconnect",
  "disconnected",
  "end",
  "ended",
  "completed",
]);
const MISSED_EVENTS = new Set([
  "reject",
  "rejected",
  "decline",
  "declined",
  "cancel",
  "canceled",
  "cancelled",
  "no_answer",
  "busy",
  "missed",
]);
const RINGING_STATUSES = new Set(["ringing"]);
const ACTIVE_STATUSES = new Set([
  "active",
  "in_progress",
  "inprogress",
  "ongoing",
  "connected",
]);
const FAILED_STATUSES = new Set(["failed", "error"]);

function normalizeLifecycleToken(value: string | null): string | null {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return normalized || null;
}

function getProviderEventAt(event: WhatsAppCallWebhookEvent): Date {
  return event.timestamp ? parseWhatsAppTimestamp(event.timestamp) : new Date();
}

export function deriveWhatsAppCallSessionState(
  event: WhatsAppCallWebhookEvent,
): WhatsAppCallSessionState {
  if (event.errorCode || event.errorMessage) {
    return "failed";
  }

  const status = normalizeLifecycleToken(event.status);
  if (status) {
    if (FAILED_STATUSES.has(status)) return "failed";
    if (RINGING_STATUSES.has(status)) return "ringing";
    if (PRE_ACCEPTED_EVENTS.has(status)) return "pre_accepted";
    if (ACCEPTED_EVENTS.has(status)) return "accepted";
    if (ACTIVE_STATUSES.has(status)) return "active";
    if (TERMINATED_EVENTS.has(status)) return "terminated";
    if (MISSED_EVENTS.has(status)) return "missed";
  }

  const providerEvent = normalizeLifecycleToken(event.event);
  if (!providerEvent) {
    return "unknown";
  }
  if (FAILED_STATUSES.has(providerEvent)) return "failed";
  if (INCOMING_EVENTS.has(providerEvent)) return "incoming";
  if (PRE_ACCEPTED_EVENTS.has(providerEvent)) return "pre_accepted";
  if (ACCEPTED_EVENTS.has(providerEvent)) return "accepted";
  if (ACTIVE_STATUSES.has(providerEvent)) return "active";
  if (TERMINATED_EVENTS.has(providerEvent)) return "terminated";
  if (MISSED_EVENTS.has(providerEvent)) return "missed";

  return "unknown";
}

function isAnsweredState(state: WhatsAppCallSessionState): boolean {
  return state === "accepted" || state === "active";
}

function isEndedState(state: WhatsAppCallSessionState): boolean {
  return state === "terminated" || state === "missed" || state === "failed";
}

export function createWhatsAppCallSessionReducer<TSession>(
  deps: WhatsAppCallSessionReducerDependencies<TSession>,
) {
  return async function upsertWhatsAppCallSessionFromEvent(params: {
    workspaceId: string;
    sourceId?: string | null;
    event: WhatsAppCallWebhookEvent;
  }): Promise<TSession | null> {
    const callId = params.event.callId;
    if (!callId) return null;

    const sourceId = params.sourceId || null;
    const eventAt = getProviderEventAt(params.event);
    const state = deriveWhatsAppCallSessionState(params.event);
    const setPayload: Record<string, unknown> = {
      state,
      latestEvent: params.event.event,
      latestStatus: params.event.status,
      direction: params.event.direction,
      from: params.event.from,
      to: params.event.to,
      fromUserId: params.event.fromUserId,
      fromParentUserId: params.event.fromParentUserId,
      toUserId: params.event.toUserId,
      toParentUserId: params.event.toParentUserId,
      recipientId: params.event.recipientId,
      recipientUserId: params.event.recipientUserId,
      recipientParentUserId: params.event.recipientParentUserId,
      contactUserId: params.event.contactUserId,
      contactParentUserId: params.event.contactParentUserId,
      contactWaId: params.event.contactWaId,
      contactName: params.event.contactName,
      contactUsername: params.event.contactUsername,
      countryCode: params.event.countryCode,
      wabaId: params.event.wabaId,
      phoneNumberId: params.event.phoneNumberId,
      bizOpaqueCallbackData: params.event.bizOpaqueCallbackData,
      sessionSdpType: params.event.sessionSdpType,
      sessionSdp: params.event.sessionSdp,
      durationSeconds: params.event.durationSeconds,
      errorCode: params.event.errorCode,
      errorMessage: params.event.errorMessage,
      lastProviderUpdateAt: eventAt,
      latestRawEvent: params.event.rawEvent,
    };

    if (isAnsweredState(state)) {
      setPayload.answeredAt = eventAt;
    }

    if (isEndedState(state)) {
      setPayload.endedAt = eventAt;
    }

    const session = await deps.whatsAppCallSessionModel
      .findOneAndUpdate(
        {
          workspaceId: params.workspaceId,
          sourceId,
          callId,
        },
        {
          $setOnInsert: {
            workspaceId: params.workspaceId,
            sourceId,
            callId,
            firstSeenAt: eventAt,
          },
          $set: setPayload,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();

    if (!session) {
      throw new Error("Failed to upsert WhatsApp call session.");
    }

    return session;
  };
}
