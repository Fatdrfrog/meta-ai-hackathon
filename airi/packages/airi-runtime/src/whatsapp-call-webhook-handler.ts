import { extractWhatsAppIdentifiersFromWebhookValue } from "@icecore/shared/lib/whatsapp/account-identifiers";
import {
  extractWhatsAppCallWebhookEvents,
  type WhatsAppCallWebhookEvent,
} from "@icecore/shared/lib/whatsapp/webhook-call-events";
import {
  parseWhatsAppTimestamp,
  type WhatsAppWebhookBody,
  type WhatsAppWebhookValue,
} from "@icecore/shared/lib/whatsapp/webhook-payload";
import { readIdString } from "@icecore/shared/lib/value-utils";

type WhatsAppCallWebhookRequestLogger = {
  info: (message: string, context?: Record<string, unknown>) => void;
  success: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (
    message: string,
    error?: unknown,
    context?: Record<string, unknown>,
  ) => void;
};

type WhatsAppCallSourceRow = {
  id?: string | null;
  workspace_id?: string | null;
  credentials?: unknown;
};

type WhatsAppCallSessionLike = {
  _id?: unknown;
  conversationId?: unknown;
  phoneNumberId?: string | null;
  state?: string | null;
};

type WhatsAppCallConversationLinkResult = {
  conversationId: string;
  customerId: string | null;
  createdConversation: boolean;
};

export type PersistWhatsAppCallEventParams = {
  workspaceId: string;
  sourceId: string | null;
  event: WhatsAppCallWebhookEvent;
  eventAt: Date | null;
};

export type WhatsAppCallWebhookHandlerDependencies = {
  buildWhatsAppWebhookSourceSkipPayload: (
    sourceSkip: any,
  ) => Record<string, unknown>;
  emitConversationCallUpdatedRealtimeEvent: (params: {
    workspaceId: string;
    conversationId: string;
    callSessionId: string;
    state: string;
  }) => Promise<unknown>;
  getWhatsAppWebhookSourceSkip: (source: any) => any | null;
  linkWhatsAppCallSessionToConversation: (params: {
    workspaceId: string;
    sourceId?: string | null;
    event: WhatsAppCallWebhookEvent;
  }) => Promise<WhatsAppCallConversationLinkResult | null>;
  persistWhatsAppCallEvent: (
    params: PersistWhatsAppCallEventParams,
  ) => Promise<unknown>;
  resolveWhatsAppSourceByAccountIdentifiers: (
    params: Record<string, unknown>,
  ) => Promise<WhatsAppCallSourceRow | null>;
  signalWithStartWhatsAppCallWorkflow: (params: {
    workspaceId: string;
    sourceId?: string | null;
    callSessionId: string;
    callId: string;
    conversationId?: string | null;
    phoneNumberId?: string | null;
    state: any;
    sessionSdp?: string | null;
    sessionSdpType?: string | null;
    receivedAt?: string | null;
  }) => Promise<unknown>;
  upsertWhatsAppCallSessionFromEvent: (params: {
    workspaceId: string;
    sourceId?: string | null;
    event: WhatsAppCallWebhookEvent;
  }) => Promise<WhatsAppCallSessionLike | null>;
};

function isWhatsAppCallWebhook(body: WhatsAppWebhookBody): boolean {
  const change = body.entry?.[0]?.changes?.[0];
  if (body.object !== "whatsapp_business_account" || !change) {
    return false;
  }

  return (
    change.field === "calls" ||
    Boolean(change.value?.calls?.[0]) ||
    change.value?.statuses?.[0]?.type === "call"
  );
}

export function createWhatsAppCallWebhookHandler(
  deps: WhatsAppCallWebhookHandlerDependencies,
) {
  return async function tryHandleWhatsAppCallWebhook(params: {
    body: WhatsAppWebhookBody;
    requestLogger: WhatsAppCallWebhookRequestLogger;
  }): Promise<Response | null> {
    const { body, requestLogger } = params;

    if (!isWhatsAppCallWebhook(body)) {
      return null;
    }

    const entry = body.entry[0];
    const change = entry.changes[0];
    const value = change.value as WhatsAppWebhookValue;
    const callPhoneNumberId =
      value.metadata?.phone_number_id ?? value.metadata?.cs_id ?? null;
    const wabaId = (entry.id || "").toString();

    let callSource: WhatsAppCallSourceRow | null = null;

    try {
      callSource = await deps.resolveWhatsAppSourceByAccountIdentifiers({
        ...extractWhatsAppIdentifiersFromWebhookValue({
          entryId: entry.id,
          value,
        }),
        phoneNumberId: callPhoneNumberId || undefined,
        wabaId,
      });
    } catch (sourceError) {
      requestLogger.error("WhatsApp call source lookup failed", sourceError, {
        phoneNumberId: callPhoneNumberId,
        wabaId,
      });
    }

    if (!callSource?.workspace_id) {
      requestLogger.info(
        "WhatsApp call webhook skipped because source was not found",
        {
          phoneNumberId: callPhoneNumberId,
          wabaId,
          callCount: value.calls?.length ?? 0,
          statusCount: value.statuses?.length ?? 0,
        },
      );
      return Response.json({ status: "ok", message: "calls skipped" });
    }

    const sourceSkip = deps.getWhatsAppWebhookSourceSkip(callSource);
    if (sourceSkip) {
      requestLogger.warn("WhatsApp call webhook skipped for inactive source", {
        phoneNumberId: callPhoneNumberId,
        wabaId,
        workspaceId: callSource.workspace_id,
        sourceId: callSource.id,
        reason: sourceSkip.reason,
      });
      return Response.json(
        deps.buildWhatsAppWebhookSourceSkipPayload(sourceSkip),
      );
    }

    const sourceId = callSource.id || null;
    const callEvents = extractWhatsAppCallWebhookEvents({
      wabaId,
      phoneNumberId: callPhoneNumberId,
      contacts: value.contacts,
      calls: value.calls,
      statuses: value.statuses,
    });

    for (const event of callEvents) {
      const eventAt = event.timestamp
        ? parseWhatsAppTimestamp(event.timestamp)
        : null;

      await deps.persistWhatsAppCallEvent({
        workspaceId: callSource.workspace_id,
        sourceId,
        event,
        eventAt,
      });

      let callSession: WhatsAppCallSessionLike | null = null;
      try {
        callSession = await deps.upsertWhatsAppCallSessionFromEvent({
          workspaceId: callSource.workspace_id,
          sourceId,
          event,
        });
      } catch (sessionError) {
        requestLogger.error(
          "WhatsApp call session reduction failed",
          sessionError,
          {
            workspaceId: callSource.workspace_id,
            sourceId,
            callId: event.callId,
            event: event.event,
            status: event.status,
          },
        );
        continue;
      }

      const callSessionId = readIdString(callSession?._id);
      if (!callSession || !callSessionId) {
        continue;
      }

      let linkResult: WhatsAppCallConversationLinkResult | null = null;
      try {
        linkResult = await deps.linkWhatsAppCallSessionToConversation({
          workspaceId: callSource.workspace_id,
          sourceId,
          event,
        });
      } catch (linkError) {
        requestLogger.error(
          "WhatsApp call conversation linking failed",
          linkError,
          {
            workspaceId: callSource.workspace_id,
            sourceId,
            callId: event.callId,
            event: event.event,
            status: event.status,
          },
        );
      }

      const conversationId =
        linkResult?.conversationId || readIdString(callSession.conversationId);
      const callSessionState = callSession.state || "unknown";

      if (conversationId) {
        try {
          await deps.emitConversationCallUpdatedRealtimeEvent({
            workspaceId: callSource.workspace_id,
            conversationId,
            callSessionId,
            state: callSessionState,
          });
        } catch (realtimeError) {
          requestLogger.error(
            "WhatsApp call realtime update failed",
            realtimeError,
            {
              workspaceId: callSource.workspace_id,
              sourceId,
              callId: event.callId,
              conversationId,
            },
          );
        }
      }

      if (event.callId) {
        try {
          await deps.signalWithStartWhatsAppCallWorkflow({
            workspaceId: callSource.workspace_id,
            sourceId,
            callSessionId,
            callId: event.callId,
            conversationId,
            phoneNumberId:
              callSession.phoneNumberId || event.phoneNumberId || null,
            state: callSessionState,
            sessionSdp: event.sessionSdp,
            sessionSdpType: event.sessionSdpType,
            receivedAt: eventAt?.toISOString() || null,
          });
        } catch (temporalError) {
          requestLogger.error(
            "WhatsApp call Temporal signal failed",
            temporalError,
            {
              workspaceId: callSource.workspace_id,
              sourceId,
              callId: event.callId,
              callSessionId,
            },
          );
        }
      }
    }

    requestLogger.success("WhatsApp call webhook processed", {
      workspaceId: callSource.workspace_id,
      sourceId,
      phoneNumberId: callPhoneNumberId,
      wabaId,
      eventCount: callEvents.length,
    });

    return Response.json({
      status: "ok",
      message: "calls processed",
      received: callEvents.length,
    });
  };
}
