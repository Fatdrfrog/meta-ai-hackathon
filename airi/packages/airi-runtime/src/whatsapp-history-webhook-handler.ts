import { buildRawSourcePayload } from "@icecore/shared/lib/raw-source-payload";
import { extractWhatsAppIdentifiersFromWebhookValue } from "@icecore/shared/lib/whatsapp/account-identifiers";
import {
  getWhatsAppPrimaryIdentifier,
  sameWhatsAppBsuid,
  sameWhatsAppPhone,
  type WhatsAppNormalizedContact,
} from "@icecore/shared/lib/whatsapp/contact-identities";
import {
  normalizeWhatsAppWebhookContact,
  resolveWhatsAppDisplayPhoneNumber,
  resolveWhatsAppMessageContext,
  resolveWhatsAppOutboundRecipientContact,
} from "@icecore/shared/lib/whatsapp/webhook-direction";
import {
  parseWhatsAppTimestamp,
  type WhatsAppContact,
  type WhatsAppHistoryEntry,
  type WhatsAppHistoryValue,
  type WhatsAppMessage,
  type WhatsAppWebhookBody,
  type WhatsAppWebhookChange,
} from "@icecore/shared/lib/whatsapp/webhook-payload";
import {
  buildHistorySyncWebhookState,
  type WhatsAppHistorySyncState,
  type WhatsAppHistoryWebhookError,
  type WhatsAppHistoryWebhookMetadata,
} from "@icecore/whatsapp/historySyncState";
import { asRecord, toArray } from "@icecore/shared/lib/value-utils";
import type { WhatsAppHistoryImportReceipt } from "./whatsapp-history-import";
import {
  buildWhatsAppIntakePlanSkipBody,
  readWhatsAppPlanSkippedProcessResult,
  type WhatsAppIntakePlanCheck,
  type WhatsAppIntakePlanSkip,
} from "./whatsapp-intake-plan-gate";

type WhatsAppHistoryWebhookRequestLogger = {
  info: (message: string, context?: Record<string, unknown>) => void;
  success: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (
    message: string,
    errorOrContext?: unknown,
    context?: Record<string, unknown>,
  ) => void;
};

type WhatsAppHistorySourceRow = {
  id: string;
  workspace_id?: string | null;
  credentials?: unknown;
};

type ProcessWhatsAppHistoryMessageResult = {
  conversationId?: string | null;
  processedAs?: string;
  planSkip?: WhatsAppIntakePlanSkip;
};

type HistoryConversationRealtimeTrigger = (
  conversationId: string,
  wasJustCreated?: boolean,
) => Promise<unknown>;

type SourceCredentialUpdateResult = {
  error?: { message?: string | null } | null;
};

export type WhatsAppHistoryWebhookHandlerDependencies = {
  buildWhatsAppWebhookSourceSkipPayload: (
    sourceSkip: any,
  ) => Record<string, unknown>;
  decryptString: (value: any) => string;
  getWhatsAppWebhookSourceSkip: (source: any) => any | null;
  /** Trial-expired intake lock; fails open (see whatsapp-intake-plan-gate). */
  getWhatsAppIntakePlanSkip: WhatsAppIntakePlanCheck;
  invalidateRequestsForWorkspace?: (workspaceId: string) => Promise<unknown>;
  processWhatsAppMessage: (params: {
    accessToken: string;
    contactData: WhatsAppNormalizedContact;
    conversationId?: string;
    direction: "inbound" | "outbound";
    messageData: WhatsAppMessage;
    messageDate: Date;
    phoneNumberId: string;
    rawSourcePayload: any;
    sourceId: string;
    workspaceId: string;
    importMode?: "history";
  }) => Promise<ProcessWhatsAppHistoryMessageResult>;
  readLatestSourceCredentials: (params: {
    sourceId: string;
    workspaceId: string;
  }) => Promise<unknown | undefined>;
  resolveWhatsAppSourceByAccountIdentifiers: (
    params: Record<string, unknown>,
  ) => Promise<WhatsAppHistorySourceRow | null | undefined>;
  triggerConversationRealtime?: HistoryConversationRealtimeTrigger;
  updateSourceCredentials: (params: {
    sourceId: string;
    workspaceId: string;
    currentCredentials: Record<string, unknown>;
    credentials: Record<string, unknown>;
  }) => Promise<SourceCredentialUpdateResult>;
};

type HistoryProcessingContext = {
  historyImport?: WhatsAppHistoryImportReceipt;
  accessToken: string;
  conversationIdsByContact: Map<string, string>;
  cutoffTime: number | null;
  deps: WhatsAppHistoryWebhookHandlerDependencies;
  displayPhoneNumber?: string | null;
  phoneNumberId: string;
  requestLogger: WhatsAppHistoryWebhookRequestLogger;
  sourceId: string;
  workspaceId: string;
};

type HistoryProcessingStats = {
  processedCount: number;
  processedConversationId: string | null;
  skippedCount: number;
  planSkip?: WhatsAppIntakePlanSkip;
};

function getHistoryWebhookMetadata(
  historyEntries: WhatsAppHistoryEntry[],
): WhatsAppHistoryWebhookMetadata[] {
  return historyEntries.flatMap((entry) =>
    entry.metadata
      ? [
          {
            phase: entry.metadata.phase,
            chunk_order: entry.metadata.chunk_order,
            progress: entry.metadata.progress,
          },
        ]
      : [],
  );
}

async function persistWhatsAppHistorySyncState({
  deps,
  errors,
  metadata,
  phoneNumberId,
  requestLogger,
  source,
  stats,
}: {
  deps: WhatsAppHistoryWebhookHandlerDependencies;
  errors?: WhatsAppHistoryWebhookError[];
  metadata: WhatsAppHistoryWebhookMetadata[];
  phoneNumberId: string;
  requestLogger: WhatsAppHistoryWebhookRequestLogger;
  source: {
    credentials?: unknown;
    id: string;
    workspace_id: string;
  };
  stats: Pick<HistoryProcessingStats, "processedCount" | "skippedCount">;
}) {
  const latestCredentials = await deps.readLatestSourceCredentials({
    sourceId: source.id,
    workspaceId: source.workspace_id,
  });
  const currentSourceCredentials =
    latestCredentials !== undefined ? latestCredentials : source.credentials;
  const currentCredentials = asRecord(currentSourceCredentials);
  const currentHistorySync = currentCredentials.history_sync as
    | WhatsAppHistorySyncState
    | undefined;
  // A new connection can be reserved while an old, unbound chunk is running.
  // Its terminal legacy counter write must not overwrite the new session.
  if (currentHistorySync?.session_id) return currentHistorySync;
  const historySyncState = buildHistorySyncWebhookState({
    current: currentHistorySync,
    metadata,
    errors,
    processedCount: stats.processedCount,
    skippedCount: stats.skippedCount,
    receivedAt: new Date().toISOString(),
  });

  const { error } = await deps.updateSourceCredentials({
    sourceId: source.id,
    workspaceId: source.workspace_id,
    currentCredentials,
    credentials: {
      ...currentCredentials,
      history_sync: historySyncState,
    },
  });

  if (error) {
    requestLogger.error(
      "WhatsApp history sync state persist failed",
      new Error(error.message || "Failed to update source credentials"),
      {
        phoneNumberId,
        sourceId: source.id,
        workspaceId: source.workspace_id,
      },
    );
    throw new Error(
      error.message || "Failed to persist WhatsApp history sync state",
    );
  }

  return historySyncState;
}

function resolveHistoryContactFromMessage(params: {
  contacts?: WhatsAppContact[];
  displayPhoneNumber?: string | null;
  messageData: WhatsAppMessage;
}): WhatsAppNormalizedContact | null {
  const { messageData, contacts, displayPhoneNumber } = params;

  const resolved = resolveWhatsAppMessageContext({
    messageData,
    contacts,
    displayPhoneNumber,
  });

  return resolved.contactData;
}

function resolveHistoryContactFromThread(
  thread: NonNullable<WhatsAppHistoryEntry["threads"]>[number],
): WhatsAppNormalizedContact | null {
  const context = thread.context;
  return normalizeWhatsAppWebhookContact(
    context
      ? {
          wa_id: context.wa_id || thread.id,
          user_id: context.user_id,
          parent_user_id: context.parent_user_id,
          profile: {
            username: context.username,
          },
        }
      : null,
    thread.id,
  );
}

function messageIdentifierMatchesContact(
  identifier: string | undefined,
  contactData: WhatsAppNormalizedContact,
): boolean {
  if (!identifier) return false;
  return (
    sameWhatsAppPhone(identifier, contactData.waId) ||
    sameWhatsAppBsuid(identifier, contactData.userId) ||
    sameWhatsAppBsuid(identifier, contactData.parentUserId)
  );
}

function messageTargetsHistoryContact(
  messageData: WhatsAppMessage,
  contactData: WhatsAppNormalizedContact,
): boolean {
  return (
    messageIdentifierMatchesContact(messageData.to, contactData) ||
    messageIdentifierMatchesContact(messageData.to_user_id, contactData) ||
    messageIdentifierMatchesContact(messageData.to_parent_user_id, contactData)
  );
}

function inferHistoryDirection(
  messageData: WhatsAppMessage,
  contactData: WhatsAppNormalizedContact,
  displayPhoneNumber?: string | null,
): "inbound" | "outbound" {
  const resolved = resolveWhatsAppMessageContext({
    messageData,
    contacts: [
      {
        wa_id: contactData.waId,
        user_id: contactData.userId,
        parent_user_id: contactData.parentUserId,
        profile: {
          name: contactData.profile.name,
          username: contactData.profile.username,
        },
      },
    ],
    displayPhoneNumber,
  }).direction;

  if (
    resolved === "inbound" &&
    messageTargetsHistoryContact(messageData, contactData)
  ) {
    return "outbound";
  }

  return resolved;
}

async function processHistoryMessagesBatch(
  messages: WhatsAppMessage[],
  resolveContact: (
    message: WhatsAppMessage,
  ) => WhatsAppNormalizedContact | null,
  context: HistoryProcessingContext,
  stats: HistoryProcessingStats,
  options?: {
    direction?: "inbound" | "outbound";
    eventType?: string;
  },
) {
  for (const messageData of messages) {
    if (context.historyImport && !messageData.id)
      throw new Error("WhatsApp history message id is required");
    if (messageData.type === "media_placeholder") {
      stats.skippedCount += 1;
      continue;
    }

    const messageDate = context.historyImport
      ? new Date(Number(messageData.timestamp) * 1000)
      : parseWhatsAppTimestamp(messageData.timestamp);
    if (
      context.historyImport &&
      (typeof messageData.timestamp !== "string" ||
        !/^\d+$/.test(messageData.timestamp) ||
        Number(messageData.timestamp) <= 0 ||
        !Number.isFinite(messageDate.getTime()))
    ) {
      throw new Error(
        `WhatsApp history message ${messageData.id} has an invalid timestamp`,
      );
    }
    if (context.cutoffTime && messageDate.getTime() < context.cutoffTime) {
      stats.skippedCount += 1;
      continue;
    }

    const contactData = resolveContact(messageData);
    if (!contactData) {
      if (context.historyImport)
        throw new Error(
          `WhatsApp history message ${messageData.id} has no contact identity`,
        );
      context.requestLogger.warn(
        "WhatsApp history batch message missing contact",
        {
          workspaceId: context.workspaceId,
          sourceId: context.sourceId,
          phoneNumberId: context.phoneNumberId,
          messageId: messageData.id,
          messageFrom: messageData.from ?? null,
          messageTo: messageData.to ?? null,
        },
      );
      stats.skippedCount += 1;
      continue;
    }

    const contactKey = getWhatsAppPrimaryIdentifier(contactData);
    const knownConversationId = contactKey
      ? context.conversationIdsByContact.get(contactKey)
      : undefined;
    const direction =
      options?.direction ||
      inferHistoryDirection(
        messageData,
        contactData,
        context.displayPhoneNumber,
      );

    try {
      const result = await context.deps.processWhatsAppMessage({
        ...(context.historyImport ? { importMode: "history" as const } : {}),
        messageData,
        contactData,
        phoneNumberId: context.phoneNumberId,
        accessToken: context.accessToken,
        workspaceId: context.workspaceId,
        direction,
        sourceId: context.sourceId,
        messageDate,
        conversationId: knownConversationId,
        rawSourcePayload: buildRawSourcePayload({
          provider: "whatsapp",
          eventType: options?.eventType || "history_message",
          capturedAt: messageDate,
          payload: {
            message: messageData,
            phoneNumberId: context.phoneNumberId,
            sourceId: context.sourceId,
            displayPhoneNumber: context.displayPhoneNumber || null,
            direction,
          },
        }),
      });

      const newConversationPlanSkip =
        readWhatsAppPlanSkippedProcessResult(result);
      if (newConversationPlanSkip) {
        context.requestLogger.info(
          "WhatsApp history new conversation skipped by company plan",
          {
            workspaceId: context.workspaceId,
            sourceId: context.sourceId,
            phoneNumberId: context.phoneNumberId,
            itemKind: "history_message",
            messageId: messageData.id,
            reason: newConversationPlanSkip.reason,
          },
        );
        stats.skippedCount += 1;
        stats.planSkip = newConversationPlanSkip;
        continue;
      }
      if (result.processedAs === "unsupported_skipped") stats.skippedCount += 1;
      else stats.processedCount += 1;
      if (!stats.processedConversationId) {
        stats.processedConversationId = result.conversationId || null;
      }
      if (contactKey && result.conversationId) {
        context.conversationIdsByContact.set(contactKey, result.conversationId);
      }
    } catch (error) {
      context.requestLogger.error(
        "WhatsApp history batch message processing failed",
        error,
        {
          workspaceId: context.workspaceId,
          sourceId: context.sourceId,
          phoneNumberId: context.phoneNumberId,
          messageId: messageData.id,
        },
      );
      throw error;
    }
  }
}

export function createWhatsAppHistoryWebhookHandler(
  deps: WhatsAppHistoryWebhookHandlerDependencies,
) {
  return async function tryHandleWhatsAppHistoryWebhook(params: {
    body: WhatsAppWebhookBody;
    change: WhatsAppWebhookChange;
    requestLogger: WhatsAppHistoryWebhookRequestLogger;
    historyImport?: WhatsAppHistoryImportReceipt;
  }): Promise<Response | null> {
    const { body, change, requestLogger } = params;
    const historyImport = params.historyImport;
    const changeValue =
      change.value && typeof change.value === "object" ? change.value : {};
    const isHistoryWebhook =
      change.field === "history" || "history" in changeValue;
    if (!isHistoryWebhook) {
      return null;
    }

    const historyValue = changeValue as WhatsAppHistoryValue;
    const historyEntries = toArray(historyValue.history);
    const phoneNumberId =
      historyValue.metadata?.phone_number_id || historyValue.metadata?.cs_id;

    if (!phoneNumberId) {
      requestLogger.warn(
        "WhatsApp history webhook skipped because phone number id was missing",
        {
          object: body.object,
          field: change.field ?? null,
        },
      );
      return Response.json({
        status: "ok",
        message: "history skipped",
      });
    }

    const historyErrors = historyEntries.flatMap((entry) => entry.errors || []);
    const historyMetadata = getHistoryWebhookMetadata(historyEntries);

    const source = await deps.resolveWhatsAppSourceByAccountIdentifiers({
      ...extractWhatsAppIdentifiersFromWebhookValue({
        entryId: body.entry?.[0]?.id,
        value: historyValue,
      }),
      phoneNumberId,
    });

    if (!source?.id || !source.workspace_id) {
      requestLogger.warn(
        "WhatsApp history webhook skipped because source was not found",
        {
          phoneNumberId,
        },
      );
      return Response.json({
        status: "ok",
        message: "history skipped",
      });
    }

    const resolvedSource = {
      ...source,
      workspace_id: source.workspace_id,
    };
    const latest = await deps.readLatestSourceCredentials({
      sourceId: resolvedSource.id,
      workspaceId: resolvedSource.workspace_id,
    });
    if (!latest) {
      return Response.json({
        status: "ok",
        message: "history source removed",
        historyOutcome: "superseded",
      });
    }
    const currentCredentials = asRecord(latest);
    const currentSession = asRecord(currentCredentials.history_sync);
    // Old durable receipts must not enter a replacement onboarding or overwrite
    // its request state, even when the source resolver still has cached credentials.
    if (!historyImport && currentSession.session_id) {
      return Response.json({
        status: "ok",
        message: "history session superseded",
        historyOutcome: "superseded",
      });
    }
    if (historyImport) {
      if (
        resolvedSource.id !== historyImport.sourceId ||
        resolvedSource.workspace_id !== historyImport.workspaceId ||
        phoneNumberId !== historyImport.phoneNumberId ||
        currentSession.session_id !== historyImport.sessionId
      ) {
        return Response.json({
          status: "ok",
          message: "history session superseded",
          historyOutcome: "superseded",
        });
      }
    }
    resolvedSource.credentials = currentCredentials;
    const sourceSkip = deps.getWhatsAppWebhookSourceSkip(resolvedSource);
    if (sourceSkip) {
      requestLogger.warn(
        "WhatsApp history webhook skipped for inactive source",
        {
          phoneNumberId,
          workspaceId: resolvedSource.workspace_id,
          sourceId: resolvedSource.id,
          reason: sourceSkip.reason,
        },
      );
      return Response.json({
        ...deps.buildWhatsAppWebhookSourceSkipPayload(sourceSkip),
        ...(historyImport ? { historyOutcome: "superseded" } : {}),
      });
    }

    // History downloads media eagerly; a trial-expired company stores none.
    // Bound children still record a durable outcome so their receipt completes.
    const intakePlanSkip = await deps.getWhatsAppIntakePlanSkip({
      workspaceId: resolvedSource.workspace_id,
      sourceId: resolvedSource.id,
      itemKind: "history_message",
    });
    if (intakePlanSkip) {
      requestLogger.info("WhatsApp history intake skipped by company plan", {
        phoneNumberId,
        workspaceId: resolvedSource.workspace_id,
        sourceId: resolvedSource.id,
        itemKind: "history_message",
        historyImportRole: historyImport?.role ?? null,
        reason: intakePlanSkip.reason,
      });
      return Response.json({
        ...buildWhatsAppIntakePlanSkipBody(intakePlanSkip),
        ...(historyImport ? { historyOutcome: "skipped" } : {}),
      });
    }

    if (historyErrors.length > 0) {
      const historySyncState = await persistWhatsAppHistorySyncState({
        deps,
        source: resolvedSource,
        metadata: historyMetadata,
        errors: historyErrors,
        stats: {
          processedCount: 0,
          skippedCount: 0,
        },
        requestLogger,
        phoneNumberId,
      });

      requestLogger.warn("WhatsApp history webhook reported provider errors", {
        phoneNumberId,
        workspaceId: resolvedSource.workspace_id,
        sourceId: resolvedSource.id,
        historySyncStatus: historySyncState.status,
        historyErrorCount: historyErrors.length,
        historyErrors,
      });
      return Response.json({
        status: "ok",
        message: "history errors received",
      });
    }

    const sourceCredentials = asRecord(resolvedSource.credentials);
    const accessToken = deps.decryptString(sourceCredentials.access_token);
    const historySync = sourceCredentials.history_sync as
      | { range_days?: number; requested_at?: string }
      | undefined;
    const rangeDays = historyImport?.rangeDays ?? historySync?.range_days;
    const requestedAt =
      historyImport?.sessionStartedAt ?? historySync?.requested_at;
    const cutoffTime =
      rangeDays && requestedAt
        ? new Date(requestedAt).getTime() - rangeDays * 24 * 60 * 60 * 1000
        : null;
    const displayPhoneNumber = resolveWhatsAppDisplayPhoneNumber({
      metadataDisplayPhoneNumber: historyValue.metadata?.display_phone_number,
      sourceCredentials,
    });

    const stats: HistoryProcessingStats = {
      processedConversationId: null,
      processedCount: 0,
      skippedCount: 0,
    };
    const context: HistoryProcessingContext = {
      historyImport,
      phoneNumberId,
      accessToken,
      workspaceId: resolvedSource.workspace_id,
      sourceId: resolvedSource.id,
      cutoffTime,
      displayPhoneNumber,
      conversationIdsByContact: new Map(),
      deps,
      requestLogger,
    };

    for (const entry of historyEntries) {
      for (const thread of entry.threads || []) {
        const contactData = resolveHistoryContactFromThread(thread);
        await processHistoryMessagesBatch(
          thread.messages || [],
          () => contactData,
          context,
          stats,
        );
      }

      if (entry.messages && entry.messages.length > 0) {
        const entryContacts = entry.contacts || historyValue.contacts;
        await processHistoryMessagesBatch(
          entry.messages,
          (messageData) =>
            resolveHistoryContactFromMessage({
              messageData,
              contacts: entryContacts,
              displayPhoneNumber,
            }),
          context,
          stats,
        );
      }
    }

    if (historyValue.messages && historyValue.messages.length > 0) {
      await processHistoryMessagesBatch(
        historyValue.messages,
        (messageData) =>
          resolveHistoryContactFromMessage({
            messageData,
            contacts: historyValue.contacts,
            displayPhoneNumber,
          }),
        context,
        stats,
      );
    }

    const historyEchoMessages = [
      ...(historyValue.message_echoes || []),
      ...(historyValue.smb_message_echoes || []),
    ];
    if (historyEchoMessages.length > 0) {
      await processHistoryMessagesBatch(
        historyEchoMessages,
        (messageData) =>
          resolveWhatsAppOutboundRecipientContact({
            messageData,
            contacts: historyValue.contacts,
            displayPhoneNumber,
          }),
        context,
        stats,
        {
          direction: "outbound",
          eventType: "history_message_echo",
        },
      );
    }

    if (stats.processedConversationId) {
      try {
        await deps.invalidateRequestsForWorkspace?.(
          resolvedSource.workspace_id,
        );
        await deps.triggerConversationRealtime?.(
          stats.processedConversationId,
          false,
        );
      } catch (error) {
        requestLogger.error(
          "WhatsApp history webhook realtime update failed",
          error,
          {
            phoneNumberId,
            workspaceId: resolvedSource.workspace_id,
            conversationId: stats.processedConversationId,
          },
        );
      }
    }

    if (historyImport) {
      return Response.json({
        status: "ok",
        message: "history message synchronized",
        historyOutcome: stats.processedCount > 0 ? "synchronized" : "skipped",
        // The reason marks the receipt for --plan-skipped replay.
        ...(stats.planSkip ? { reason: stats.planSkip.reason } : {}),
      });
    }

    const historySyncState = await persistWhatsAppHistorySyncState({
      deps,
      source: resolvedSource,
      metadata: historyMetadata,
      stats,
      requestLogger,
      phoneNumberId,
    });

    requestLogger.success("WhatsApp history webhook processed", {
      phoneNumberId,
      workspaceId: resolvedSource.workspace_id,
      sourceId: resolvedSource.id,
      historySyncStatus: historySyncState.status,
      historyProgress: historySyncState.last_progress,
      historyPhase: historySyncState.last_phase,
      historyChunkOrder: historySyncState.last_chunk_order,
      historyCompletedAt: historySyncState.completed_at,
      processedCount: stats.processedCount,
      skippedCount: stats.skippedCount,
      processedCountTotal: historySyncState.processed_count_total,
      skippedCountTotal: historySyncState.skipped_count_total,
      webhookCount: historySyncState.webhook_count,
      conversationId: stats.processedConversationId,
    });

    return Response.json({
      status: "ok",
      message: "history processed",
      // Any plan-refused conversation marks the receipt for --plan-skipped
      // replay; already stored messages short-circuit on replay.
      ...(stats.planSkip ? { reason: stats.planSkip.reason } : {}),
    });
  };
}
