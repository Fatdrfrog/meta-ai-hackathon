import { extractWhatsAppIdentifiersFromWebhookValue } from "@icecore/shared/lib/whatsapp/account-identifiers";
import type {
  WhatsAppWebhookBody,
  WhatsAppWebhookChange,
} from "@icecore/shared/lib/whatsapp/webhook-payload";
import { processWhatsAppContactSyncWebhook } from "./processor.js";

type WhatsAppContactSyncRequestLogger = {
  success: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
};

type WhatsAppSourceRow = {
  id: string;
  workspace_id: string;
  credentials?: unknown;
};

export type WhatsAppContactSyncWebhookHandlerDependencies = {
  buildWhatsAppWebhookSourceSkipPayload: (
    sourceSkip: any,
  ) => Record<string, unknown>;
  getWhatsAppWebhookSourceSkip: (source: any) => any | null;
  resolveWhatsAppSourceByAccountIdentifiers: (
    params: Record<string, unknown>,
  ) => Promise<WhatsAppSourceRow | null>;
  updateSourceCredentials: (params: {
    sourceId: string;
    workspaceId: string;
    currentCredentials: Record<string, unknown>;
    credentials: Record<string, unknown>;
  }) => Promise<{ error?: { message?: string } | unknown | null }>;
};

export function createWhatsAppContactSyncWebhookHandler(
  deps: WhatsAppContactSyncWebhookHandlerDependencies,
) {
  return async function tryHandleWhatsAppContactSyncWebhook(params: {
    body: WhatsAppWebhookBody;
    change: WhatsAppWebhookChange;
    requestLogger: WhatsAppContactSyncRequestLogger;
  }): Promise<Response | null> {
    const { body, change, requestLogger } = params;
    const isContactSyncWebhook =
      change.field === "smb_app_state_sync" || "state_sync" in change.value;
    if (!isContactSyncWebhook) {
      return null;
    }

    const contactSyncValue = change.value as Record<string, any> & {
      state_sync?: unknown;
    };
    const phoneNumberId =
      contactSyncValue.metadata?.phone_number_id ||
      contactSyncValue.metadata?.cs_id;

    if (!phoneNumberId) {
      requestLogger.warn(
        "WhatsApp contact sync webhook skipped because phone number id was missing",
        {
          object: body.object,
          field: change.field ?? null,
        },
      );
      return Response.json({
        status: "ok",
        message: "state_sync skipped",
      });
    }

    const source = await deps.resolveWhatsAppSourceByAccountIdentifiers({
      ...extractWhatsAppIdentifiersFromWebhookValue({
        entryId: body.entry?.[0]?.id,
        value: contactSyncValue,
      }),
      phoneNumberId,
    });
    if (!source || !source.workspace_id) {
      requestLogger.warn(
        "WhatsApp contact sync webhook skipped because source was not found",
        {
          phoneNumberId,
        },
      );
      return Response.json({
        status: "ok",
        message: "state_sync skipped",
      });
    }

    const sourceSkip = deps.getWhatsAppWebhookSourceSkip(source);
    if (sourceSkip) {
      requestLogger.warn(
        "WhatsApp contact sync webhook skipped for inactive source",
        {
          phoneNumberId,
          workspaceId: source.workspace_id,
          sourceId: source.id,
          reason: sourceSkip.reason,
        },
      );
      return Response.json(
        deps.buildWhatsAppWebhookSourceSkipPayload(sourceSkip),
      );
    }

    let currentCredentialSnapshot =
      source.credentials &&
      typeof source.credentials === "object" &&
      !Array.isArray(source.credentials)
        ? (source.credentials as Record<string, unknown>)
        : {};
    const stats = await processWhatsAppContactSyncWebhook({
      source,
      phoneNumberId,
      stateSync: contactSyncValue.state_sync ?? contactSyncValue,
      persistCredentials: async (nextCredentials) => {
        const { error } = await deps.updateSourceCredentials({
          sourceId: source.id,
          workspaceId: source.workspace_id,
          currentCredentials: currentCredentialSnapshot,
          credentials: nextCredentials,
        });

        if (error) {
          const message =
            typeof error === "object" && error && "message" in error
              ? String((error as { message?: unknown }).message)
              : String(error);
          throw new Error(message);
        }
        currentCredentialSnapshot = nextCredentials;
      },
    });

    requestLogger.success("WhatsApp contact sync webhook processed", {
      phoneNumberId,
      workspaceId: source.workspace_id,
      sourceId: source.id,
      processedCount: stats.processedCount,
      skippedCount: stats.skippedCount,
    });

    return Response.json({
      status: "ok",
      message: "state_sync processed",
    });
  };
}
