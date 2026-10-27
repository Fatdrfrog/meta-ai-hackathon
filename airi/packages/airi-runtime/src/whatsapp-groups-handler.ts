import { extractWhatsAppIdentifiersFromWebhookValue } from "@icecore/shared/lib/whatsapp/account-identifiers";
import type {
  WhatsAppWebhookBody,
  WhatsAppWebhookChange,
} from "@icecore/shared/lib/whatsapp/webhook-payload";
import {
  isWhatsAppGroupWebhookField,
  normalizeWhatsAppGroupWebhookEvents,
  type WhatsAppGroupWebhookEvent,
} from "@icecore/whatsapp/groupWebhooks";
import { asRecord } from "@icecore/shared/lib/value-utils";

type WhatsAppGroupWebhookRequestLogger = {
  success: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (
    message: string,
    error?: unknown,
    context?: Record<string, unknown>,
  ) => void;
};

type WhatsAppSourceRow = {
  id: string;
  workspace_id: string;
  credentials?: unknown;
};

export type WhatsAppGroupWebhookPersistenceParams = {
  workspaceId: string;
  sourceId: string;
  event: WhatsAppGroupWebhookEvent;
};

export type WhatsAppGroupWebhookHandlerDependencies = {
  buildWhatsAppWebhookSourceSkipPayload: (
    sourceSkip: any,
  ) => Record<string, unknown>;
  getWhatsAppWebhookSourceSkip: (source: any) => any | null;
  invalidateRequestsForWorkspace?: (workspaceId: string) => Promise<unknown>;
  resolveWhatsAppSourceByAccountIdentifiers: (
    params: Record<string, unknown>,
  ) => Promise<WhatsAppSourceRow | null>;
  upsertWhatsAppGroupEvent: (
    params: WhatsAppGroupWebhookPersistenceParams,
  ) => Promise<unknown>;
  upsertWhatsAppGroupState: (
    params: WhatsAppGroupWebhookPersistenceParams,
  ) => Promise<unknown>;
  realtime?: {
    trigger: (
      channel: string,
      event: string,
      payload: unknown,
    ) => Promise<unknown>;
  };
};

function readWebhookWabaId(body: WhatsAppWebhookBody): string | null {
  const entry = Array.isArray(body.entry) ? body.entry[0] : null;
  const id = entry?.id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

export function createWhatsAppGroupWebhookHandler(
  deps: WhatsAppGroupWebhookHandlerDependencies,
) {
  return async function tryHandleWhatsAppGroupWebhook(params: {
    body: WhatsAppWebhookBody;
    change: WhatsAppWebhookChange;
    requestLogger: WhatsAppGroupWebhookRequestLogger;
  }): Promise<Response | null> {
    const { body, change, requestLogger } = params;
    if (!isWhatsAppGroupWebhookField(change.field)) {
      return null;
    }

    const value = asRecord(change.value);
    const wabaId = readWebhookWabaId(body);
    const events = normalizeWhatsAppGroupWebhookEvents({
      field: change.field,
      receivedAt: new Date(),
      value,
      wabaId,
    });

    if (events.length === 0) {
      requestLogger.warn("WhatsApp group webhook skipped (no groups)", {
        field: change.field,
        object: body.object ?? null,
        payloadKeys: Object.keys(value),
        wabaId,
      });
      return Response.json({
        status: "ok",
        message: `${change.field} skipped`,
      });
    }

    const phoneNumberId = events[0]?.phoneNumberId || undefined;
    const source = await deps.resolveWhatsAppSourceByAccountIdentifiers({
      ...extractWhatsAppIdentifiersFromWebhookValue({
        entryId: wabaId,
        value,
      }),
      phoneNumberId,
    });

    if (!source?.id || !source.workspace_id) {
      requestLogger.warn("WhatsApp group webhook skipped (source not found)", {
        field: change.field,
        groupCount: events.length,
        phoneNumberId: phoneNumberId || null,
        wabaId,
      });
      return Response.json({
        status: "ok",
        message: `${change.field} skipped`,
      });
    }

    const sourceSkip = deps.getWhatsAppWebhookSourceSkip(source);
    if (sourceSkip) {
      requestLogger.warn("WhatsApp group webhook skipped for inactive source", {
        field: change.field,
        phoneNumberId: phoneNumberId || null,
        reason: sourceSkip.reason,
        sourceId: source.id,
        workspaceId: source.workspace_id,
      });
      return Response.json(
        deps.buildWhatsAppWebhookSourceSkipPayload(sourceSkip),
      );
    }

    for (const event of events) {
      await deps.upsertWhatsAppGroupEvent({
        event,
        sourceId: source.id,
        workspaceId: source.workspace_id,
      });
      await deps.upsertWhatsAppGroupState({
        event,
        sourceId: source.id,
        workspaceId: source.workspace_id,
      });
    }

    await deps
      .invalidateRequestsForWorkspace?.(source.workspace_id)
      .catch((error) => {
        requestLogger.warn("WhatsApp group webhook cache invalidation failed", {
          error: error instanceof Error ? error.message : String(error),
          field: change.field,
          sourceId: source.id,
          workspaceId: source.workspace_id,
        });
      });

    await deps.realtime
      ?.trigger(`tenant-${source.workspace_id}`, "whatsapp.group.updated", {
        eventCount: events.length,
        field: change.field,
        groups: events.map((event) => ({
          groupId: event.groupId,
          phoneNumberId: event.phoneNumberId,
          type: event.type,
        })),
        sourceId: source.id,
        workspaceId: source.workspace_id,
      })
      .catch((error) => {
        requestLogger.warn("WhatsApp group webhook realtime fanout failed", {
          error: error instanceof Error ? error.message : String(error),
          field: change.field,
          sourceId: source.id,
          workspaceId: source.workspace_id,
        });
      });

    requestLogger.success("WhatsApp group webhook processed", {
      eventCount: events.length,
      field: change.field,
      sourceId: source.id,
      workspaceId: source.workspace_id,
    });

    return Response.json({
      status: "ok",
      message: `${change.field} processed`,
      groups: events.length,
    });
  };
}
