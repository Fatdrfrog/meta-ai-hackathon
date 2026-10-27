import { buildConversationEventData } from "@icecore/shared/lib/conversation-lifecycle-webhook";
import { isCompanyRuntimeCapacityDeferredError } from "@icecore/shared/lib/company-runtime-capacity";
import { getWhatsAppMessageMutationKind } from "@icecore/shared/lib/whatsapp/message-mutations";
import {
  resolveWhatsAppRecipientTarget,
  type WhatsAppRecipientTarget,
} from "@icecore/shared/lib/whatsapp/contact-identities";
import { normalizeWhatsAppFlowReply } from "@icecore/shared/lib/whatsapp/flow-reply";
import { findWhatsAppContextMessage } from "@icecore/shared/lib/whatsapp/message-id";
import type { WhatsAppWebhookBody } from "@icecore/shared/lib/whatsapp/webhook-payload";
import {
  isWhatsAppRecoverableMessageContent,
  isWhatsAppUnavailableMessage,
} from "@icecore/shared/lib/whatsapp/webhook-automation-eligibility";
import type {
  WhatsAppWebhookRuntimeResult,
} from "@icecore/temporal";
import { airiWorkerLogger } from "./logging";
import {
  buildWhatsAppIntakePlanSkipBody,
  readWhatsAppPlanSkippedProcessResult,
  type WhatsAppIntakePlanCheck,
} from "./whatsapp-intake-plan-gate";
import { getWhatsAppRecoverySourceMessage } from "./whatsapp-message-recovery";
import type { WhatsAppHistoryImportReceipt } from "./whatsapp-history-import";

export type AccountUpdateValue = {
  event: string;
  waba_info?: {
    waba_id: string;
    messaging_account_id?: string;
    waac_id?: string;
    cs_id?: string;
    owner_business_id: string;
    partner_app_id?: string;
  };
  disconnection_info?: {
    reason?: string;
    initiated_by?: string;
  };
  phone_number?: string;
  ban_info?: {
    waba_ban_state: string[];
    waba_ban_date: string;
  };
};
type ModelLike = {
  findById: (...args: any[]) => any;
  findOne?: (...args: any[]) => any;
};

export type WhatsAppWebhookRuntimeDependencies = {
  Chat: Pick<ModelLike, "findById">;
  Conversation: Pick<ModelLike, "findById">;
  Message: Required<Pick<ModelLike, "findById" | "findOne">>;
  User: unknown;
  buildGroundedReplyOptionPayload: (
    option?: Record<string, unknown>,
  ) => string | null;
  buildWhatsAppMessageRawSourcePayload: (params: any) => { payload: unknown };
  buildWhatsAppWebhookSourceSkipPayload: (
    sourceSkip: any,
  ) => Record<string, unknown>;
  decryptString: (...args: any[]) => string;
  directIngressAiriConversation: (
    params: any,
    metadata: Record<string, unknown>,
  ) => Promise<{ workflowId?: string; signaledRunId?: string | null }>;
  enqueueReferralEnrichment: (input: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
  }) => Promise<void>;
  enqueueMessageRealtime: (input: {
    workspaceId: string;
    conversationId: string;
    message: Record<string, unknown>;
    recoveryRevision?: string | null;
  }) => Promise<void>;
  extractWhatsAppIdentifiersFromWebhookValue: (
    params: any,
  ) => Record<string, unknown>;
  findExistingWhatsAppMessageByExternalId: (...args: any[]) => Promise<any>;
  getWhatsAppLogIdentity: (contactData: any) => string | null | undefined;
  getWhatsAppPrimaryIdentifier: (contactData: any) => string | null | undefined;
  getWhatsAppWebhookSourceSkip: (source: any) => any;
  /** Trial-expired intake lock; fails open (see whatsapp-intake-plan-gate). */
  getWhatsAppIntakePlanSkip: WhatsAppIntakePlanCheck;
  handleAccountUpdateWebhook: (value: any) => Promise<Response>;
  handleUserChangedNumber: (params: any) => Promise<{
    migrated: boolean;
    chatIds: unknown[];
    userIds: unknown[];
  }>;
  handleUserChangedUserId: (params: any) => Promise<{
    migrated: boolean;
    chatIds: unknown[];
    userIds: unknown[];
  }>;
  invalidateRequestsForWorkspace: (workspaceId: string) => Promise<unknown>;
  isWhatsAppAiriRuntimeEnabled: () => boolean;
  normalizeWhatsAppWebhookContact: (...args: any[]) => any;
  parseWhatsAppLlmFeedbackPayload: (payload: string | null | undefined) => any;
  parseWhatsAppTimestamp: (...args: any[]) => Date;
  processWhatsAppMessage: (params: any) => Promise<any>;
  realtime: {
    trigger: (
      channel: string,
      event: string,
      payload: unknown,
    ) => Promise<unknown>;
  };
  resolveWhatsAppConversationAutomationEnabled: (conversation: any) => boolean;
  resolveWhatsAppDisplayPhoneNumber: (params: any) => string | null | undefined;
  resolveWhatsAppInteractiveReplyTriggerEventKind: (
    params: any,
  ) => string | null | undefined;
  resolveWhatsAppMessageContext: (params: any) => any;
  resolveWhatsAppSourceByAccountIdentifiers: (params: any) => Promise<any>;
  enqueueWhatsAppLlmFeedbackReasonPrompt: (params: {
    workspaceId: string;
    conversationId: string;
    sourceId?: string | null;
    recipient: WhatsAppRecipientTarget;
    sourceMessageId: string | null;
  }) => Promise<unknown>;
  shouldProcessEvenIfDuplicate: (messageType: any) => boolean;
  shouldQueueWhatsAppAiriIngress: (params: any) => boolean;
  shouldSuppressGeneralWhatsAppAiriReply: (params: any) => boolean;
  supabaseAdmin: unknown;
  trackScenarioFlowSubmitted: (params: any) => Promise<unknown>;
  upsertWhatsAppLlmFeedbackReviewItem: (
    params: any,
  ) => Promise<{ inserted?: boolean } | null | undefined>;
  triggerConversationRealtime: (
    conversationId: string,
    includeMessages: boolean,
  ) => Promise<unknown>;
  triggerConversationReopened: (
    workspaceId: string,
    payload: any,
  ) => Promise<unknown>;
  triggerWhatsAppReactionRealtimeUpdate: (params: any) => Promise<unknown>;
  tryHandleWhatsAppCallWebhook: (params: any) => Promise<Response | null>;
  tryHandleWhatsAppContactSyncWebhook: (
    params: any,
  ) => Promise<Response | null>;
  tryHandleWhatsAppEchoWebhook: (params: any) => Promise<Response | null>;
  tryHandleWhatsAppGroupWebhook: (params: any) => Promise<Response | null>;
  tryHandleWhatsAppHistoryWebhook: (params: any) => Promise<Response | null>;
  tryHandleWhatsAppLifecycleWebhook: (params: any) => Promise<Response | null>;
  tryHandleWhatsAppStatusWebhook: (params: any) => Promise<Response | null>;
  tryHandleWhatsAppUserPreferencesWebhook: (
    params: any,
  ) => Promise<Response | null>;
};
type WhatsAppWebhookRuntimeLogger = {
  start(message: string, context?: Record<string, unknown>): void;
  success(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(
    message: string,
    errorOrContext?: unknown,
    maybeContext?: Record<string, unknown>,
  ): void;
};

function createWhatsAppWebhookRuntimeLogger(params?: {
  eventId?: string | null;
  dedupeKey?: string | null;
}): WhatsAppWebhookRuntimeLogger {
  const baseContext = {
    scope: "whatsapp.webhook.runtime",
    eventId: params?.eventId || null,
    dedupeKey: params?.dedupeKey || null,
  };

  return {
    start(message, context) {
      airiWorkerLogger.info("whatsapp.webhook.runtime.start", {
        ...baseContext,
        message,
        ...(context || {}),
      });
    },
    success(message, context) {
      airiWorkerLogger.info("whatsapp.webhook.runtime.success", {
        ...baseContext,
        message,
        ...(context || {}),
      });
    },
    info(message, context) {
      airiWorkerLogger.info("whatsapp.webhook.runtime.info", {
        ...baseContext,
        message,
        ...(context || {}),
      });
    },
    warn(message, context) {
      airiWorkerLogger.warn("whatsapp.webhook.runtime.warn", {
        ...baseContext,
        message,
        ...(context || {}),
      });
    },
    error(message, errorOrContext, maybeContext) {
      const hasErrorContext =
        errorOrContext instanceof Error || maybeContext !== undefined;
      const error = hasErrorContext ? errorOrContext : undefined;
      const context = hasErrorContext
        ? maybeContext
        : (errorOrContext as Record<string, unknown> | undefined);
      airiWorkerLogger.error("whatsapp.webhook.runtime.error", error, {
        ...baseContext,
        message,
        ...(context || {}),
      });
    },
  };
}

function runtimeJson(
  body: Record<string, unknown>,
  init?: { status?: number },
): WhatsAppWebhookRuntimeResult {
  const status = init?.status ?? 200;
  const code =
    String(body.status || body.error || body.message || "").trim() ||
    (status >= 200 && status < 300 ? "ok" : "error");
  const message =
    typeof body.message === "string"
      ? body.message
      : typeof body.error === "string"
        ? body.error
        : null;

  return {
    ok: status >= 200 && status < 300,
    code,
    message,
    details: body,
    retryable: status < 200 || status >= 300,
  };
}

async function responseToRuntimeResult(
  response: Response,
): Promise<WhatsAppWebhookRuntimeResult> {
  const text = await response.text().catch(() => "");
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  const details =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : text
        ? { body: text }
        : null;
  const code =
    details && typeof details === "object"
      ? String(
          details.status || details.error || details.message || response.status,
        )
      : String(response.status);

  return {
    ok: response.status >= 200 && response.status < 300,
    code,
    message:
      details && typeof details === "object"
        ? typeof details.message === "string"
          ? details.message
          : typeof details.error === "string"
            ? details.error
            : null
        : text || null,
    details,
    retryable: response.status < 200 || response.status >= 300,
  };
}

async function resolveGroundedReplyQuickPayload(
  deps: WhatsAppWebhookRuntimeDependencies,
  params: {
    conversationId: string;
    outboundMessageId: string | null | undefined;
    optionId: string | null | undefined;
  },
): Promise<string | null> {
  const outboundMessageId = String(params.outboundMessageId || "").trim();
  const optionId = String(params.optionId || "").trim();
  if (!outboundMessageId || !optionId) {
    return null;
  }

  const outboundMessage = await findWhatsAppContextMessage<{
    groundedReplyOptions?: {
      options?: Array<Record<string, unknown>>;
    } | null;
  }>({
    Message: deps.Message,
    conversationId: params.conversationId,
    contextMessageId: outboundMessageId,
    direction: "outbound",
    select: "groundedReplyOptions",
  });

  const selectedOption =
    outboundMessage?.groundedReplyOptions?.options?.find(
      (option: Record<string, unknown>) =>
        String(option?.callbackKey || "").trim() === optionId ||
        String(option?.id || "").trim() === optionId,
    ) || null;

  return deps.buildGroundedReplyOptionPayload(selectedOption || undefined);
}

function isAccountUpdateValue(value: unknown): value is AccountUpdateValue {
  if (!value || typeof value !== "object") return false;
  const event = (value as { event?: unknown }).event;
  return typeof event === "string" && event.length > 0;
}

function stringifyId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && "toString" in value) {
    const stringValue = String(value);
    return stringValue && stringValue !== "[object Object]"
      ? stringValue
      : null;
  }
  return null;
}

function toPlainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const maybeDocument = value as {
    toObject?: (options?: Record<string, unknown>) => Record<string, unknown>;
  };
  if (typeof maybeDocument.toObject === "function") {
    return maybeDocument.toObject({ versionKey: false });
  }

  return { ...(value as Record<string, unknown>) };
}

export function serializeWhatsAppRealtimeMessage(
  message: unknown,
): Record<string, unknown> | null {
  const payload = toPlainObject(message);
  if (!payload) {
    return null;
  }

  const id = stringifyId(payload._id);
  if (id) {
    payload._id = id;
  }

  for (const key of ["chat", "conversation"] as const) {
    const stringValue = stringifyId(payload[key]);
    if (stringValue) {
      payload[key] = stringValue;
    }
  }

  const author = payload.author;
  const authorId = stringifyId(author);
  if (authorId) {
    payload.author = { _id: authorId };
  } else if (author && typeof author === "object" && !Array.isArray(author)) {
    const authorPayload = { ...(author as Record<string, unknown>) };
    const nestedAuthorId = stringifyId(authorPayload._id);
    if (nestedAuthorId) {
      authorPayload._id = nestedAuthorId;
    }
    payload.author = authorPayload;
  }

  return payload;
}

function scheduleWhatsAppMessageRealtimeNotifications(params: {
  deps: WhatsAppWebhookRuntimeDependencies;
  requestLogger: WhatsAppWebhookRuntimeLogger;
  workspaceId: string;
  conversationId: string;
  messageObjectId: unknown;
  messageDocument: unknown;
  sourceMessageId: string;
  isNewConversation: boolean;
}): void {
  const { deps } = params;
  try {
    void deps
      .invalidateRequestsForWorkspace(params.workspaceId)
      .catch((err) => {
        params.requestLogger.error(
          "WhatsApp webhook request invalidation failed",
          err,
          {
            workspaceId: params.workspaceId,
            conversationId: params.conversationId,
            messageId: params.sourceMessageId,
          },
        );
      });

    void deps.realtime
      .trigger(
        `tenant-${params.workspaceId}`,
        params.isNewConversation ? "requests.new" : "requests.update",
        {
          _id: params.conversationId,
          conversationId: params.conversationId,
          workspaceId: params.workspaceId,
        },
      )
      .catch((err) => {
        params.requestLogger.error(
          "WhatsApp webhook realtime notification failed",
          err,
          {
            workspaceId: params.workspaceId,
            conversationId: params.conversationId,
            messageId: params.sourceMessageId,
          },
        );
      });

    const realtimeMessage = serializeWhatsAppRealtimeMessage(
      params.messageDocument,
    );

    if (realtimeMessage?.direction === "inbound") return;

    void deps.Message.findById(params.messageObjectId)
      .populate({
        path: "author",
        model: deps.User,
        select: "firstName isBot",
      })
      .then((populatedMessage: unknown) =>
        deps.realtime.trigger(
          `private-conversation-${params.conversationId}`,
          "new-message",
          populatedMessage,
        ),
      )
      .catch((err: unknown) => {
        params.requestLogger.error(
          "WhatsApp webhook Realtime notification failed",
          err,
          {
            workspaceId: params.workspaceId,
            conversationId: params.conversationId,
            messageId: params.sourceMessageId,
          },
        );
      });
  } catch (err) {
    params.requestLogger.error("WhatsApp webhook realtime setup failed", err, {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      messageId: params.sourceMessageId,
    });
  }
}

async function queueWhatsAppAiriIngress(params: {
  deps: WhatsAppWebhookRuntimeDependencies;
  requestLogger: WhatsAppWebhookRuntimeLogger;
  airiParams: any;
  workspaceId: string;
  conversationId: string;
  messageId: string;
  triggerEventKind: string | null | undefined;
  interactiveType: string | null | undefined;
  webhookElapsedBeforeQueueMs: number;
  messageProcessingMs: number;
}): Promise<{ workflowId?: string; signaledRunId?: string | null }> {
  params.requestLogger.info("WhatsApp Airi auto-reply direct ingress started", {
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    messageId: params.messageId,
  });

  try {
    const workflowHandle = await params.deps.directIngressAiriConversation(
      params.airiParams,
      {
        label: "whatsapp-webhook",
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        messageId: params.messageId,
        channel: "whatsapp",
        idempotent: true,
      },
    );
    params.requestLogger.info(
      "WhatsApp Airi auto-reply direct ingress queued",
      {
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        messageId: params.messageId,
        workflowId: workflowHandle.workflowId,
        runId: workflowHandle.signaledRunId || null,
        triggerEventKind: params.triggerEventKind ?? null,
        interactiveType: params.interactiveType ?? null,
        webhookElapsedBeforeQueueMs: params.webhookElapsedBeforeQueueMs,
        messageProcessingMs: params.messageProcessingMs,
      },
    );
    return workflowHandle;
  } catch (error) {
    params.requestLogger.error(
      "WhatsApp Airi auto-reply direct ingress failed",
      error,
      {
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        messageId: params.messageId,
        triggerEventKind: params.triggerEventKind ?? null,
        interactiveType: params.interactiveType ?? null,
      },
    );
    throw error;
  }
}

export async function processWhatsAppWebhookPayload(
  deps: WhatsAppWebhookRuntimeDependencies,
  params: {
    body: WhatsAppWebhookBody;
    rawBody?: string | null;
    providerSignatureVerified?: boolean;
    eventId?: string | null;
    dedupeKey?: string | null;
    suppressAiriIngress?: boolean;
    suppressRealtime?: boolean;
    historyImport?: WhatsAppHistoryImportReceipt;
  },
): Promise<WhatsAppWebhookRuntimeResult> {
  const routeStartedAt = Date.now();
  const body = params.body;
  const realtimeSuppressed = Boolean(params.suppressRealtime);
  const timingEnabled = process.env.WHATSAPP_WEBHOOK_RUNTIME_TIMINGS === "1";
  let timingLastAt = routeStartedAt;
  const logTiming = (stage: string, context?: Record<string, unknown>) => {
    if (!timingEnabled) return;
    const now = Date.now();
    requestLogger.info("WhatsApp webhook runtime timing", {
      stage,
      stageMs: now - timingLastAt,
      totalMs: now - routeStartedAt,
      ...context,
    });
    timingLastAt = now;
  };
  const requestLogger = createWhatsAppWebhookRuntimeLogger({
    eventId: params.eventId,
    dedupeKey: params.dedupeKey,
  });
  const supabase = deps.supabaseAdmin as never;

  requestLogger.start("WhatsApp webhook runtime payload received", {
    object: body.object,
    entryCount: body.entry?.length ?? 0,
    hasRawBody: Boolean(params.rawBody),
  });

  try {
    requestLogger.info("WhatsApp webhook payload accepted", {
      object: body.object,
      entryCount: body.entry?.length ?? 0,
      firstChangeField: body.entry?.[0]?.changes?.[0]?.field ?? null,
    });

    // Handle account_update webhook (Embedded Signup completions, bans, etc.)
    if (
      body.object === "whatsapp_business_account" &&
      body.entry?.[0]?.changes?.[0]
    ) {
      const change = body.entry[0].changes[0];

      // Route to account update handler if this is an account_update event
      if (
        change.field === "account_update" &&
        isAccountUpdateValue(change.value)
      ) {
        const wabaId = body.entry[0].id?.toString();
        const rawAccountUpdateValue = change.value as AccountUpdateValue & {
          owner_business_id?: unknown;
          partner_app_id?: unknown;
        };
        const accountUpdateValue: AccountUpdateValue = {
          ...rawAccountUpdateValue,
          waba_info:
            rawAccountUpdateValue.waba_info ||
            (wabaId
              ? {
                  waba_id: wabaId,
                  owner_business_id:
                    typeof rawAccountUpdateValue.owner_business_id === "string"
                      ? rawAccountUpdateValue.owner_business_id
                      : "",
                  partner_app_id:
                    typeof rawAccountUpdateValue.partner_app_id === "string"
                      ? rawAccountUpdateValue.partner_app_id
                      : undefined,
                }
              : undefined),
        };
        requestLogger.success("WhatsApp account update webhook handled", {
          object: body.object,
          field: change.field ?? null,
          event: change.value.event,
          wabaId: wabaId ?? null,
        });
        return responseToRuntimeResult(
          await deps.handleAccountUpdateWebhook(accountUpdateValue),
        );
      }

      const groupResponse = await deps.tryHandleWhatsAppGroupWebhook({
        body,
        change,
        requestLogger,
      });
      if (groupResponse) return responseToRuntimeResult(groupResponse);

      const lifecycleResponse = await deps.tryHandleWhatsAppLifecycleWebhook({
        body,
        change,
        requestLogger,
      });
      if (lifecycleResponse) return responseToRuntimeResult(lifecycleResponse);

      const userPreferencesResponse =
        await deps.tryHandleWhatsAppUserPreferencesWebhook({
          body,
          change,
          requestLogger,
        });
      if (userPreferencesResponse)
        return responseToRuntimeResult(userPreferencesResponse);

      // Handle coexistence webhooks for WhatsApp Business app users
      // @see https://developers.facebook.com/docs/whatsapp/embedded-signup/custom-flows/onboarding-business-app-users/

      const historyResponse = await deps.tryHandleWhatsAppHistoryWebhook({
        body,
        change,
        requestLogger,
        historyImport: params.historyImport,
      });
      if (historyResponse) return responseToRuntimeResult(historyResponse);

      const contactSyncResponse =
        await deps.tryHandleWhatsAppContactSyncWebhook({
          body,
          change,
          requestLogger,
        });
      if (contactSyncResponse)
        return responseToRuntimeResult(contactSyncResponse);

      const echoResponse = await deps.tryHandleWhatsAppEchoWebhook({
        body,
        change,
        requestLogger,
      });
      if (echoResponse) return responseToRuntimeResult(echoResponse);
    }

    const callResponse = await deps.tryHandleWhatsAppCallWebhook({
      body,
      requestLogger,
    });
    if (callResponse) return responseToRuntimeResult(callResponse);

    const statusResponse = await deps.tryHandleWhatsAppStatusWebhook({
      body,
      providerSignatureVerified: params.providerSignatureVerified === true,
      requestLogger,
      supabase,
      suppressRealtime: realtimeSuppressed,
    });
    if (statusResponse) return responseToRuntimeResult(statusResponse);

    if (
      body.object === "whatsapp_business_account" &&
      body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
    ) {
      const entry = body.entry[0];
      const change = entry.changes[0];
      const value = change.value;
      const messageData = value.messages?.[0];
      const phoneNumberId =
        value.metadata?.phone_number_id || value.metadata?.cs_id;

      // Defensive: ensure required message fields exist
      if (!phoneNumberId) {
        requestLogger.warn(
          "WhatsApp message webhook skipped because phone number id was missing",
          {
            object: body.object,
            messageId: messageData?.id ?? null,
            metadataKeys: Object.keys(value.metadata || {}),
          },
        );
        return runtimeJson({ status: "ok" });
      }

      if (!messageData) {
        requestLogger.warn(
          "WhatsApp message webhook skipped because message payload was missing",
          {
            object: body.object,
            hasMessage: Boolean(messageData),
            payloadKeys: Object.keys(value || {}),
          },
        );
        return runtimeJson({ status: "ok" });
      }

      const source = await deps.resolveWhatsAppSourceByAccountIdentifiers({
        ...deps.extractWhatsAppIdentifiersFromWebhookValue({
          entryId: entry.id,
          value,
        }),
        phoneNumberId,
      });
      logTiming("source_resolve", { phoneNumberId });

      if (!source || !source.workspace_id) {
        requestLogger.warn(
          "WhatsApp message webhook skipped because source was not found",
          {
            phoneNumberId,
            messageId: messageData.id,
          },
        );
        return runtimeJson({
          status: "ok",
          message: "Source not found or configured.",
          debug: {
            phoneNumberId,
          },
        });
      }

      const sourceSkip = deps.getWhatsAppWebhookSourceSkip(source);
      logTiming("source_skip_check", {
        phoneNumberId,
        workspaceId: source.workspace_id,
        sourceId: source.id,
      });
      if (sourceSkip) {
        requestLogger.warn(
          "WhatsApp message webhook skipped for inactive source",
          {
            phoneNumberId,
            workspaceId: source.workspace_id,
            sourceId: source.id,
            messageId: messageData.id,
            reason: sourceSkip.reason,
          },
        );
        return runtimeJson(
          deps.buildWhatsAppWebhookSourceSkipPayload(sourceSkip),
        );
      }

      // A trial-expired company ingests nothing (owner decision 2026-10-18).
      // The receipt completes with its payload, so it stays replayable.
      const intakePlanSkip = await deps.getWhatsAppIntakePlanSkip({
        workspaceId: source.workspace_id,
        sourceId: source.id,
        itemKind: "message",
      });
      logTiming("intake_plan_check", {
        phoneNumberId,
        workspaceId: source.workspace_id,
        sourceId: source.id,
      });
      if (intakePlanSkip) {
        requestLogger.info("WhatsApp message intake skipped by company plan", {
          phoneNumberId,
          workspaceId: source.workspace_id,
          sourceId: source.id,
          itemKind: "message",
          messageId: messageData.id,
          reason: intakePlanSkip.reason,
        });
        return runtimeJson(buildWhatsAppIntakePlanSkipBody(intakePlanSkip));
      }

      // System messages carry identity events (user_changed_number, etc.).
      // They shouldn't go through the normal processor — instead, migrate
      // Chat/User identities so the thread history follows the customer to
      // their new number.
      if (messageData.type === "system") {
        const systemType = messageData.system?.type || null;
        requestLogger.info("WhatsApp system message received", {
          phoneNumberId,
          workspaceId: source.workspace_id,
          sourceId: source.id,
          messageId: messageData.id,
          systemType,
          messageFrom: messageData.from ?? null,
          systemBody: messageData.system?.body ?? null,
        });

        if (systemType === "user_changed_number") {
          try {
            const outcome = await deps.handleUserChangedNumber({
              workspaceId: source.workspace_id,
              sourceId: source.id,
              phoneNumberId,
              messageFrom: messageData.from,
              system: messageData.system,
              rawMessage: deps.buildWhatsAppMessageRawSourcePayload({
                body,
                entry,
                change,
                value,
                messageData,
                sourceId: source.id,
                direction: "inbound",
                capturedAt: deps.parseWhatsAppTimestamp(messageData.timestamp),
                eventType: "system",
              }).payload as Record<string, unknown>,
              platformMessageId: messageData.id,
              eventAt: deps.parseWhatsAppTimestamp(messageData.timestamp),
            });
            return runtimeJson({
              status: "ok",
              message: "user_changed_number processed",
              migrated: outcome.migrated,
              affected: {
                chats: outcome.chatIds.length,
                users: outcome.userIds.length,
              },
            });
          } catch (error) {
            requestLogger.error(
              "WhatsApp user_changed_number processing failed",
              error,
              {
                phoneNumberId,
                workspaceId: source.workspace_id,
                sourceId: source.id,
                messageId: messageData.id,
              },
            );
            return runtimeJson({
              status: "ok",
              message: "user_changed_number processing failed",
            });
          }
        }

        if (systemType === "user_changed_user_id") {
          try {
            const outcome = await deps.handleUserChangedUserId({
              workspaceId: source.workspace_id,
              sourceId: source.id,
              phoneNumberId,
              messageFrom: messageData.from_user_id || messageData.from,
              system: messageData.system,
              rawMessage: deps.buildWhatsAppMessageRawSourcePayload({
                body,
                entry,
                change,
                value,
                messageData,
                sourceId: source.id,
                direction: "inbound",
                capturedAt: deps.parseWhatsAppTimestamp(messageData.timestamp),
                eventType: "system",
              }).payload as Record<string, unknown>,
            });
            return runtimeJson({
              status: "ok",
              message: "user_changed_user_id processed",
              migrated: outcome.migrated,
              affected: {
                chats: outcome.chatIds.length,
                users: outcome.userIds.length,
              },
            });
          } catch (error) {
            requestLogger.error(
              "WhatsApp user_changed_user_id processing failed",
              error,
              {
                phoneNumberId,
                workspaceId: source.workspace_id,
                sourceId: source.id,
                messageId: messageData.id,
              },
            );
            return runtimeJson({
              status: "ok",
              message: "user_changed_user_id processing failed",
            });
          }
        }

        // Unknown system subtype — log for future handling and ack 200 so
        // Meta doesn't retry.
        return runtimeJson({
          status: "ok",
          message: `system message '${systemType || "unknown"}' logged`,
        });
      }

      const displayPhoneNumber = deps.resolveWhatsAppDisplayPhoneNumber({
        metadataDisplayPhoneNumber: value.metadata?.display_phone_number,
        sourceCredentials: source.credentials,
      });
      const messageSenderIdentifier =
        messageData.from?.trim() || messageData.from_user_id?.trim() || "";
      const fallbackContactData = deps.normalizeWhatsAppWebhookContact(
        value.contacts?.[0],
        messageSenderIdentifier,
      );
      const { direction: resolvedDirection, contactData } =
        deps.resolveWhatsAppMessageContext({
          messageData,
          contacts: value.contacts,
          displayPhoneNumber,
        });

      if (
        !value.contacts?.[0] &&
        fallbackContactData &&
        resolvedDirection === "inbound"
      ) {
        requestLogger.info(
          "WhatsApp inbound contact inferred from message.from (no contacts array)",
          {
            phoneNumberId,
            messageId: messageData.id,
            workspaceId: source.workspace_id,
            inferredPrimaryIdType: fallbackContactData.primaryIdType,
            waId: fallbackContactData.waId || null,
            userId: fallbackContactData.userId || null,
            parentUserId: fallbackContactData.parentUserId || null,
          },
        );
      }

      if (
        contactData?.primaryIdType === "message_from" &&
        resolvedDirection === "inbound" &&
        !value.contacts?.[0]
      ) {
        requestLogger.info(
          "WhatsApp inbound BSUID inferred from message.from",
          {
            phoneNumberId,
            messageId: messageData.id,
            workspaceId: source.workspace_id,
            inferredFrom: messageSenderIdentifier,
            userId: contactData.userId || null,
          },
        );
      }

      requestLogger.info("WhatsApp inbound message received", {
        phoneNumberId,
        messageId: messageData.id,
        workspaceId: source.workspace_id,
        sourceId: source.id,
        from:
          messageData.from ||
          messageData.from_user_id ||
          deps.getWhatsAppLogIdentity(contactData),
        to: messageData.to || null,
        contactWaId: contactData?.waId || null,
        contactUserId: contactData?.userId || null,
        contactParentUserId: contactData?.parentUserId || null,
        contactUsername: contactData?.profile.username || null,
        primaryIdType: contactData?.primaryIdType || null,
        type: messageData.type,
        timestamp: messageData.timestamp,
        hasContactData: Boolean(deps.getWhatsAppPrimaryIdentifier(contactData)),
        hasContactName: Boolean(contactData?.profile.name),
        resolvedDirection,
      });

      if (!contactData || !deps.getWhatsAppPrimaryIdentifier(contactData)) {
        requestLogger.warn(
          "WhatsApp message webhook skipped because contact identity could not be resolved",
          {
            phoneNumberId,
            workspaceId: source.workspace_id,
            sourceId: source.id,
            messageId: messageData.id,
            direction: resolvedDirection,
            messageFrom: messageData.from ?? null,
            messageTo: messageData.to ?? null,
            hasContacts: Boolean(value.contacts),
            contactsLength: value.contacts?.length ?? 0,
            displayPhoneNumber: displayPhoneNumber ?? null,
          },
        );
        return runtimeJson({ status: "ok" });
      }

      // BSUID adoption monitoring: emit structured log when an inbound
      // contact arrives with a BSUID (with or without phone).
      if (
        resolvedDirection === "inbound" &&
        (contactData.userId || contactData.parentUserId)
      ) {
        requestLogger.info("WhatsApp inbound BSUID contact observed", {
          phoneNumberId,
          workspaceId: source.workspace_id,
          sourceId: source.id,
          messageId: messageData.id,
          hasPhone: Boolean(contactData.waId),
          hasUserId: Boolean(contactData.userId),
          hasParentUserId: Boolean(contactData.parentUserId),
          primaryIdType: contactData.primaryIdType,
        });
      }

      // Log unsupported message types
      // Round videos (video notes) may come as "unsupported" but contain video data
      if (messageData.type === "unsupported") {
        requestLogger.info("WhatsApp unsupported message type stored", {
          phoneNumberId,
          workspaceId: source.workspace_id,
          sourceId: source.id,
          messageId: messageData.id,
          resolvedDirection,
          rawMessageData: messageData,
          rawContact: value.contacts?.[0] || null,
          rawErrors: messageData.errors || null,
        });
      }

      const airiIngressSuppressed = Boolean(params.suppressAiriIngress);
      const airiRuntimeEnabled =
        !airiIngressSuppressed && deps.isWhatsAppAiriRuntimeEnabled();
      const messageMutationKind = getWhatsAppMessageMutationKind(messageData);
      if (
        resolvedDirection === "outbound" &&
        !messageMutationKind &&
        !deps.shouldProcessEvenIfDuplicate(messageData.type)
      ) {
        const existingMessage =
          await deps.findExistingWhatsAppMessageByExternalId(messageData.id);
        logTiming("duplicate_check", {
          phoneNumberId,
          workspaceId: source.workspace_id,
          sourceId: source.id,
          messageId: messageData.id,
        });
        if (existingMessage) {
          requestLogger.info(
            "WhatsApp duplicate outbound message ignored before processing",
            {
              phoneNumberId,
              workspaceId: source.workspace_id,
              sourceId: source.id,
              messageId: messageData.id,
              storedMessageId: existingMessage.messageId,
              conversationId: String(existingMessage.conversation),
            },
          );
          return runtimeJson({
            status: "ok",
            message: "duplicate ignored",
          });
        }
      }

      const fromId = deps.getWhatsAppLogIdentity(contactData);

      requestLogger.info("WhatsApp message processing started", {
        messageId: messageData.id,
        fromId,
        contactDataWaId: contactData.waId || null,
        contactDataUserId: contactData.userId || null,
        contactDataParentUserId: contactData.parentUserId || null,
        workspaceId: source.workspace_id,
        sourceId: source.id,
        direction: resolvedDirection,
        phoneNumberId,
      });

      let resolvedAccessToken: string | null = null;
      const getAccessToken = () => {
        if (resolvedAccessToken) return resolvedAccessToken;

        resolvedAccessToken = deps.decryptString(
          (source.credentials as { access_token: unknown }).access_token,
        );
        return resolvedAccessToken;
      };

      const messageDate = deps.parseWhatsAppTimestamp(messageData.timestamp);
      const normalizedWhatsAppFlowReply =
        normalizeWhatsAppFlowReply(messageData);
      logTiming("parse_date", {
        phoneNumberId,
        workspaceId: source.workspace_id,
        sourceId: source.id,
        messageId: messageData.id,
      });
      // Use message processor helper for consistency
      // Wrap in try-catch to handle processing errors gracefully
      let result;
      const messageProcessingStartedAt = Date.now();
      let messageProcessingMs = 0;
      try {
        result = await deps.processWhatsAppMessage({
          messageData,
          contactData,
          phoneNumberId,
          workspaceId: source.workspace_id,
          direction: resolvedDirection,
          sourceId: source.id,
          messageDate,
          normalizedWhatsAppFlowReply,
          deferMediaHydration: true,
          deferReferralEnrichment: true,
          rawSourcePayload: deps.buildWhatsAppMessageRawSourcePayload({
            body,
            entry,
            change,
            value,
            messageData,
            sourceId: source.id,
            direction: resolvedDirection,
            capturedAt: messageDate,
          }),
        });
        logTiming("process_message", {
          phoneNumberId,
          workspaceId: source.workspace_id,
          sourceId: source.id,
          messageId: messageData.id,
        });
        messageProcessingMs = Date.now() - messageProcessingStartedAt;
      } catch (processingError) {
        messageProcessingMs = Date.now() - messageProcessingStartedAt;
        requestLogger.error(
          "WhatsApp message processing failed",
          processingError,
          {
            phoneNumberId,
            workspaceId: source.workspace_id,
            sourceId: source.id,
            messageId: messageData.id,
            from: deps.getWhatsAppLogIdentity(contactData),
            direction: resolvedDirection,
            messageType: messageData.type,
            messageProcessingMs,
          },
        );
        throw processingError;
      }

      const newConversationPlanSkip =
        readWhatsAppPlanSkippedProcessResult(result);
      if (newConversationPlanSkip) {
        requestLogger.info(
          "WhatsApp new conversation skipped by company plan",
          {
            phoneNumberId,
            workspaceId: source.workspace_id,
            sourceId: source.id,
            itemKind: "message",
            messageId: messageData.id,
            reason: newConversationPlanSkip.reason,
          },
        );
        return runtimeJson(
          buildWhatsAppIntakePlanSkipBody(newConversationPlanSkip),
        );
      }

      if (
        messageData.type === "reaction" ||
        result.processedAs === "reaction"
      ) {
        const reactionTargetId =
          result?.message && "_id" in result.message
            ? String(result.message._id)
            : undefined;

        if (reactionTargetId && !realtimeSuppressed) {
          try {
            await deps.triggerWhatsAppReactionRealtimeUpdate({
              conversationId: result.conversationId,
              messageId: reactionTargetId,
            });
          } catch (reactionUpdateError) {
            requestLogger.error(
              "WhatsApp reaction Realtime update failed",
              reactionUpdateError,
              {
                workspaceId: source.workspace_id,
                conversationId: result.conversationId,
                messageId: messageData.id,
              },
            );
          }
        }

        return runtimeJson({
          status: "ok",
          message: "reaction processed",
        });
      }

      if (messageMutationKind === "edit" || messageMutationKind === "revoke") {
        const updatedMessageId =
          result?.message && "_id" in result.message
            ? String(result.message._id)
            : undefined;

        try {
          if (result.conversationId) {
            if (!realtimeSuppressed) {
              await deps.invalidateRequestsForWorkspace(source.workspace_id);
              await deps.triggerConversationRealtime(
                result.conversationId,
                false,
              );
            }
          }

          if (
            updatedMessageId &&
            result.conversationId &&
            !realtimeSuppressed
          ) {
            const updatedPayload = (await deps.Message.findById(
              updatedMessageId,
            )
              .select("_id text editMeta")
              .lean()) as {
              text?: string | null;
              editMeta?: {
                editedAt?: Date | string | null;
                previousText?: string | null;
                editCount?: number | null;
                source?: "whatsapp_webhook" | "manager" | null;
                kind?: "edit" | "revoke" | null;
              } | null;
            } | null;

            await deps.realtime.trigger(
              `private-conversation-${result.conversationId}`,
              "message-updated",
              {
                messageId: updatedMessageId,
                text: updatedPayload?.text || "",
                editMeta: updatedPayload?.editMeta || null,
              },
            );
          }
        } catch (editUpdateError) {
          requestLogger.error(
            "WhatsApp edit/revoke realtime update failed",
            editUpdateError,
            {
              workspaceId: source.workspace_id,
              conversationId: result.conversationId,
              messageId: messageData.id,
            },
          );
        }

        return runtimeJson({
          status: "ok",
          message: "edit/revoke processed",
        });
      }

      const newMessage = result.message;
      if (!newMessage) {
        return runtimeJson({
          status: "ok",
          message: "message skipped",
        });
      }
      // The tapped reply, read once for LLM feedback and for Airi ingress.
      const interactiveReplyOptionId =
        typeof messageData.interactive?.button_reply?.id === "string"
          ? messageData.interactive.button_reply.id
          : typeof messageData.interactive?.list_reply?.id === "string"
            ? messageData.interactive.list_reply.id
            : null;
      const templateButtonPayload =
        messageData.type === "button" &&
        typeof messageData.button?.payload === "string"
          ? messageData.button.payload
          : null;
      let preResolvedGroundedQuickReplyPayload: string | null = null;
      let llmFeedbackPayload = deps.parseWhatsAppLlmFeedbackPayload(
        templateButtonPayload || interactiveReplyOptionId,
      );
      if (
        !llmFeedbackPayload &&
        interactiveReplyOptionId &&
        messageData.context?.id
      ) {
        preResolvedGroundedQuickReplyPayload =
          await resolveGroundedReplyQuickPayload(deps, {
            conversationId: String(result.conversationId),
            outboundMessageId: messageData.context.id,
            optionId: interactiveReplyOptionId,
          });
        llmFeedbackPayload = deps.parseWhatsAppLlmFeedbackPayload(
          preResolvedGroundedQuickReplyPayload,
        );
      }
      // The receipt owns this obligation until the outbox write succeeds.
      // Repair it before duplicate detection: a prior attempt may have crashed
      // immediately after saving the message.
      if (!realtimeSuppressed && newMessage.direction === "inbound") {
        await deps.enqueueMessageRealtime({
          workspaceId: source.workspace_id,
          conversationId: String(result.conversationId),
          message: serializeWhatsAppRealtimeMessage(newMessage)!,
          recoveryRevision: result.messageRecoveryRevision || null,
        });
      }
      if (newMessage.direction === "inbound" && messageData.referral) {
        await deps.enqueueReferralEnrichment({
          workspaceId: source.workspace_id,
          conversationId: String(result.conversationId),
          messageId: String(newMessage._id),
        });
      }
      let airiIngressQueued = false;
      // When readable content won the insert, its durable event owns admission.
      // A later placeholder must not claim that key with unavailable-message flags.
      const lateUnavailableDuplicate = Boolean(
        !result.messageWasNew &&
          !result.messageRecoveryRevision &&
          isWhatsAppUnavailableMessage(messageData) &&
          isWhatsAppRecoverableMessageContent(
            getWhatsAppRecoverySourceMessage(newMessage.rawSourcePayload),
          ),
      );
      const duplicateAiriRecovery = Boolean(
        !result.messageWasNew &&
          !lateUnavailableDuplicate &&
          newMessage.direction === "inbound" &&
          airiRuntimeEnabled &&
          !result.processedAs,
      );
      const duplicateFeedbackRecovery = Boolean(
        !result.messageWasNew && llmFeedbackPayload,
      );
      if (
        !result.messageWasNew &&
        !result.messageRecoveryRevision &&
        !duplicateAiriRecovery &&
        !duplicateFeedbackRecovery
      ) {
        requestLogger.info(
          "WhatsApp duplicate message ignored after race detection",
          {
            phoneNumberId,
            workspaceId: source.workspace_id,
            sourceId: source.id,
            messageId: messageData.id,
            conversationId: result.conversationId,
          },
        );
        return runtimeJson({
          status: "ok",
          message: "duplicate ignored",
        });
      }

      if (duplicateAiriRecovery) {
        requestLogger.info(
          "WhatsApp persisted duplicate entered durable Airi recovery",
          {
            phoneNumberId,
            workspaceId: source.workspace_id,
            sourceId: source.id,
            messageId: messageData.id,
            conversationId: result.conversationId,
          },
        );
      }

      if (
        !result.messageWasNew &&
        result.messageRecoveryRevision &&
        !realtimeSuppressed
      ) {
        try {
          await deps.invalidateRequestsForWorkspace(source.workspace_id);
        } catch (error) {
          requestLogger.warn(
            "WhatsApp recovered message realtime update failed",
            {
              workspaceId: source.workspace_id,
              conversationId: result.conversationId,
              messageId: String(newMessage._id),
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      } else if (!result.messageWasNew) {
        requestLogger.info("WhatsApp duplicate realtime notification skipped", {
          conversationId: result.conversationId,
          workspaceId: source.workspace_id,
          messageId: String(newMessage._id),
        });
      } else if (realtimeSuppressed) {
        requestLogger.info("WhatsApp realtime skipped (webhook replay)", {
          conversationId: result.conversationId,
          workspaceId: source.workspace_id,
          messageId: String(newMessage._id),
        });
      } else {
        scheduleWhatsAppMessageRealtimeNotifications({
          deps,
          requestLogger,
          workspaceId: source.workspace_id,
          conversationId: result.conversationId,
          messageObjectId: newMessage._id,
          messageDocument: newMessage,
          sourceMessageId: messageData.id,
          isNewConversation: result.isNewConversation,
        });
      }

      const shouldLoadConversationForAiri =
        newMessage.direction === "inbound" && airiRuntimeEnabled;
      const conversationDoc =
        result.conversation ||
        (result.reopenedConversation || shouldLoadConversationForAiri
          ? await deps.Conversation.findById(result.conversationId)
          : null);
      const conversationAutomationEnabled =
        airiRuntimeEnabled &&
        deps.resolveWhatsAppConversationAutomationEnabled(conversationDoc);
      const shouldLoadChatForAiri =
        newMessage.direction === "inbound" && conversationAutomationEnabled;
      const chatDoc =
        result.chat ||
        (shouldLoadChatForAiri && (result.chatId || conversationDoc?.chat)
          ? (await deps.Chat.findById(
              result.chatId || conversationDoc?.chat,
            )) || null
          : null);
      const shouldQueueAiriIngress =
        newMessage.direction === "inbound" &&
        deps.shouldQueueWhatsAppAiriIngress({
          direction: newMessage.direction,
          hasChat: Boolean(chatDoc),
          hasConversation: Boolean(conversationDoc),
          messageType: messageData.type,
          messageErrors: messageData.errors,
          unsupportedType: messageData.unsupported?.type,
          messageWasNew: result.messageWasNew || duplicateAiriRecovery,
        });
      // Media orchestration runs from the durable Airi intent, after receipt
      // admission. Its dispatcher retains pending ownership until analysis ends.

      if (result.reopenedConversation && conversationDoc) {
        deps
          .triggerConversationReopened(
            source.workspace_id,
            buildConversationEventData(conversationDoc, {
              status: "open",
              previous_status: "closed",
              channel: "whatsapp",
              customer_phone: deps.getWhatsAppLogIdentity(contactData) || "",
            }),
          )
          .catch((err) =>
            requestLogger.error(
              "WhatsApp conversation reopened webhook failed",
              err,
              {
                workspaceId: source.workspace_id,
                conversationId: String(conversationDoc._id),
              },
            ),
          );
      }

      if (newMessage.direction === "inbound") {
        // Language detection is owned by the Airi turn runtime. Running it here
        // duplicates the same provider call and delays realtime + AI ingress.
        if (messageData.type === "unsupported") {
          requestLogger.info(
            "WhatsApp unsupported inbound message automation eligibility resolved",
            {
              conversationId: result.conversationId,
              workspaceId: source.workspace_id,
              messageId: String(newMessage._id),
              messageType: messageData.type,
              eligibleForScenarioIngress: shouldQueueAiriIngress,
              providerErrorCodes:
                messageData.errors?.map((error) => error.code) || [],
            },
          );
        }

        if (llmFeedbackPayload) {
          await deps.upsertWhatsAppLlmFeedbackReviewItem({
            workspaceId: source.workspace_id,
            conversationId: String(result.conversationId),
            customerMessageId: String(newMessage._id),
            payload: llmFeedbackPayload,
          });

          if (
            llmFeedbackPayload.kind === "helpfulness" &&
            !llmFeedbackPayload.helpful &&
            !airiIngressSuppressed
          ) {
            const feedbackRecipient =
              resolveWhatsAppRecipientTarget(contactData);
            if (feedbackRecipient) {
              await deps.enqueueWhatsAppLlmFeedbackReasonPrompt({
                workspaceId: source.workspace_id,
                conversationId: String(result.conversationId),
                sourceId: source.id || null,
                recipient: feedbackRecipient,
                sourceMessageId: llmFeedbackPayload.sourceMessageId,
              });
            } else {
              requestLogger.warn(
                "WhatsApp LLM feedback reason prompt skipped without recipient",
                {
                  workspaceId: source.workspace_id,
                  conversationId: String(result.conversationId),
                },
              );
            }
          }

          requestLogger.info("WhatsApp LLM feedback captured", {
            workspaceId: source.workspace_id,
            conversationId: String(result.conversationId),
            feedbackKind: llmFeedbackPayload.kind,
            sourceMessageId: llmFeedbackPayload.sourceMessageId,
          });
          return runtimeJson({
            status: "ok",
            message: "llm feedback processed",
          });
        }

        // -----------------------------------------------------------------
        // Airi auto-reply for WhatsApp (env toggle and mention/always modes)
        // -----------------------------------------------------------------
        if (airiIngressSuppressed) {
          requestLogger.info("WhatsApp Airi skipped (webhook replay)", {
            conversationId: result.conversationId,
            workspaceId: source.workspace_id,
            messageId: String(newMessage._id),
          });
        } else if (!airiRuntimeEnabled) {
          requestLogger.info("WhatsApp Airi skipped (runtime disabled)", {
            conversationId: result.conversationId,
            workspaceId: source.workspace_id,
            messageId: String(newMessage._id),
          });
        } else if (!conversationAutomationEnabled) {
          requestLogger.info(
            "WhatsApp Airi skipped (conversation automation disabled)",
            {
              conversationId: result.conversationId,
              workspaceId: source.workspace_id,
              messageId: String(newMessage._id),
            },
          );
        } else if (shouldQueueAiriIngress) {
          requestLogger.info("WhatsApp Airi auto-reply eligibility check", {
            conversationId: result.conversationId,
            messageWasNew: result.messageWasNew,
            hasConversation: Boolean(conversationDoc),
            workspaceId: source.workspace_id,
            messagePreviewLength: newMessage.text?.length ?? 0,
          });
          const interactiveReplyType = messageData.interactive?.type;
          const isWhatsAppFlowReply = normalizedWhatsAppFlowReply !== null;
          const whatsAppFlowResponseJson =
            normalizedWhatsAppFlowReply?.responseJson ?? null;
          const groundedQuickReplyPayload =
            preResolvedGroundedQuickReplyPayload ||
            (interactiveReplyOptionId && messageData.context?.id
              ? await resolveGroundedReplyQuickPayload(deps, {
                  conversationId: String(result.conversationId),
                  outboundMessageId: messageData.context.id,
                  optionId: interactiveReplyOptionId,
                })
              : null);
          const quickReplyPayload =
            groundedQuickReplyPayload ||
            templateButtonPayload ||
            interactiveReplyOptionId;
          const triggerEventKind =
            deps.resolveWhatsAppInteractiveReplyTriggerEventKind({
              isWhatsAppFlowReply,
              messageType: messageData.type,
              interactiveReplyType,
              interactiveReplyOptionId,
              quickReplyPayload,
            });
          const airiParams = {
            type: "whatsapp" as const,
            whatsAppInfo: { phoneNumberId, contactData },
            newMessage,
            messageRecoveryRevision:
              result.messageRecoveryRevision || undefined,
            ...(isWhatsAppUnavailableMessage(messageData) &&
            !result.messageRecoveryRevision
              ? { whatsappMessageContentUnavailable: true }
              : {}),
            conversation: conversationDoc,
            workspaceId: source.workspace_id,
            chatDocument: chatDoc,
            chatId: String(chatDoc._id),
            suppressGeneralAutoReply:
              deps.shouldSuppressGeneralWhatsAppAiriReply({
                messageType: messageData.type,
              }),
            triggerEventKind,
            quickReplyPayload,
            whatsAppFlowResponseJson,
          };

          if (isWhatsAppFlowReply) {
            void deps
              .trackScenarioFlowSubmitted({
                workspaceId: source.workspace_id,
                sourceId: source.id,
                conversationId: String(result.conversationId),
                customerWaId: deps.getWhatsAppLogIdentity(contactData) || null,
                flowToken: normalizedWhatsAppFlowReply.flowToken,
                outboundMessageId: messageData.context?.id || null,
                flowIdHint: normalizedWhatsAppFlowReply.flowName,
                responseJson: whatsAppFlowResponseJson,
                eventAt: messageDate,
              })
              .catch((error) => {
                requestLogger.warn(
                  "WhatsApp flow analytics submit tracking failed",
                  {
                    workspaceId: source.workspace_id,
                    conversationId: String(result.conversationId),
                    error:
                      error instanceof Error ? error.message : String(error),
                  },
                );
              });
          }

          await queueWhatsAppAiriIngress({
            deps,
            requestLogger,
            airiParams,
            workspaceId: source.workspace_id,
            conversationId: String(result.conversationId),
            messageId: String(newMessage._id),
            triggerEventKind: airiParams.triggerEventKind ?? null,
            interactiveType: messageData.interactive?.type ?? null,
            webhookElapsedBeforeQueueMs: Date.now() - routeStartedAt,
            messageProcessingMs,
          });
          airiIngressQueued = true;
        } else {
          requestLogger.info(
            "WhatsApp Airi skipped (missing conversation or chat, or duplicate message)",
            {
              workspaceId: source.workspace_id,
              conversationId: result.conversationId,
              messageWasNew: result.messageWasNew,
              hasConversation: Boolean(conversationDoc),
              hasChat: Boolean(chatDoc),
            },
          );
        }
      } else {
        requestLogger.info("WhatsApp Airi skipped for non-inbound message", {
          conversationId: result.conversationId,
          workspaceId: source.workspace_id,
          messageId: String(newMessage._id),
          direction: newMessage.direction,
        });
      }

      requestLogger.success("WhatsApp message webhook processed", {
        phoneNumberId,
        workspaceId: source.workspace_id,
        sourceId: source.id,
        messageId: messageData.id,
        conversationId: result.conversationId,
        direction: resolvedDirection,
        messageType: messageData.type,
        processedAs: result.processedAs,
        reopenedConversation: result.reopenedConversation,
        airiIngressQueued,
      });
    }
  } catch (error) {
    if (isCompanyRuntimeCapacityDeferredError(error)) throw error;

    requestLogger.error(
      "WhatsApp webhook failed with an unhandled error",
      error,
      {
        object: body?.object ?? null,
        entryCount: body?.entry?.length ?? 0,
      },
    );
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    return runtimeJson(
      {
        error: "Server error",
        message: errorMessage,
        ...(errorStack &&
          process.env.NODE_ENV === "development" && { stack: errorStack }),
      },
      { status: 500 },
    );
  }

  return runtimeJson({ status: "ok" });
}
