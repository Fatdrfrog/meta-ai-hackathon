import { extractWhatsAppIdentifiersFromWebhookValue } from "@icecore/shared/lib/whatsapp/account-identifiers";
import {
  isWhatsAppPhoneLike,
  normalizeWhatsAppPhone,
} from "@icecore/shared/lib/whatsapp/contact-identities";
import { parseCampaignCallbackData } from "@icecore/shared/lib/whatsapp/campaign-callback-data";
import {
  buildWhatsAppCampaignPricingReceiptPatch,
} from "@icecore/shared/constants/whatsapp-message-rates";
import { classifyMetaMessageFailureScope } from "@icecore/shared/lib/meta/message-failure-scope";
import {
  normalizeWhatsAppMessageId,
  parseWhatsAppTimestamp,
  type WhatsAppWebhookBody,
} from "@icecore/shared/lib/whatsapp/webhook-payload";
import { resolveWhatsAppStatusRecipientIdentity } from "@icecore/shared/lib/whatsapp/webhook-status-identities";
import { shouldAdvanceWhatsAppDeliveryStatus } from "@icecore/shared/types/whatsapp-delivery";

export type WhatsAppStatusRequestLogger = {
  error: (
    message: string,
    errorOrContext?: unknown,
    maybeContext?: Record<string, unknown>,
  ) => void;
  info: (message: string, context?: Record<string, unknown>) => void;
  success: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
};

export type WhatsAppStatusSupabaseClient = {
  from: (table: string) => any;
};

export type WhatsAppStatusSource = {
  id?: string | null;
  workspace_id?: string | null;
  credentials?: unknown;
};

export type WhatsAppDeliveryRecordResult = {
  recorded?: boolean;
  chatId?: string | null;
  status?: string | null;
  eventStatus?: string | null;
  messageFound?: boolean;
  messageDeliveryUpdated?: boolean;
  conversationId?: string | null;
  messageObjectId?: string | null;
  delivery?: Record<string, unknown> | null;
};

type CampaignMessage = {
  campaign_id: string;
  phone?: string | null;
};

type OpenConversation = {
  _id: unknown;
  workspaceId?: string | null;
};

export type WhatsAppStatusWebhookHandlerDependencies = {
  buildWhatsAppWebhookSourceSkipPayload: (
    sourceSkip: any,
  ) => Record<string, unknown>;
  findOpenWhatsAppConversationByChatId: (
    params: { chatId: string; workspaceId: string; sourceId: string },
  ) => Promise<OpenConversation | null>;
  findOriginalMessageChatIdByMessageId: (
    messageId: string,
  ) => Promise<string | null>;
  getWhatsAppWebhookSourceSkip: (source: WhatsAppStatusSource) => any | null;
  persistCampaignMessageStatusWithOutbox: (params: {
    messageId: string;
    updateData: Record<string, unknown>;
    realtime?: { workspaceId?: string | null; campaignId: string };
  }) => Promise<{
    applied?: boolean;
    queuedToOutbox?: boolean;
    errorMessage?: string | null;
  }>;
  realtimeTrigger: (
    channel: string,
    eventName: string,
    payload: unknown,
  ) => Promise<unknown>;
  recordWhatsAppMessageDeliveryStatus: (params: {
    workspaceId: string;
    messageId: string;
    status: string;
    eventAt: Date;
    recipientId?: string | null;
    recipientWaId?: string | null;
    recipientUserId?: string | null;
    recipientParentUserId?: string | null;
    recipientUsername?: string | null;
    recipientType?: string | null;
    recipientParticipantId?: string | null;
    campaignId?: string | null;
    phoneNumberId?: string | null;
    sourceId?: string | null;
    pricing?: unknown;
    conversation?: unknown;
    errors?: Array<{ code?: number; message?: string; title?: string }> | null;
    rawStatus?: unknown;
    bizOpaqueCallbackData?: string | null;
    recipientIdentityKeyHash?: string | null;
  }) => Promise<WhatsAppDeliveryRecordResult>;
  recordCampaignTaskProviderAcceptance?: (params: {
    workspaceId: string;
    campaignId: string;
    taskId: string;
    sourceId: string;
    phoneNumberId: string;
    recipient: string;
    messageId: string;
  }) => Promise<void>;
  /** Frees the contact-policy slot of a campaign send Meta reported as failed. */
  releaseCampaignContactSlot?: (params: {
    workspaceId: string;
    campaignId: string;
    taskId: string | null;
    phone: string;
  }) => Promise<unknown>;
  resolveWhatsAppSourceByAccountIdentifiers: (
    params: Record<string, unknown>,
  ) => Promise<WhatsAppStatusSource | null>;
  trackScenarioFlowReadByMessageId: (params: {
    outboundMessageId: string;
    eventAt: Date;
  }) => Promise<unknown>;
  updateChatWhatsAppUserId: (params: {
    chatId: string;
    userId: string;
  }) => Promise<unknown>;
  updateUserWhatsAppUserId: (params: {
    chatId: string;
    userId: string;
  }) => Promise<unknown>;
  now?: () => Date;
};

export type WhatsAppStatusWebhookHandlerParams = {
  body: WhatsAppWebhookBody;
  requestLogger: WhatsAppStatusRequestLogger;
  supabase: WhatsAppStatusSupabaseClient;
  suppressRealtime?: boolean;
  providerSignatureVerified?: boolean;
};

async function lookupCampaignMessage(params: {
  supabase: WhatsAppStatusSupabaseClient;
  messageId: string;
}): Promise<CampaignMessage | null> {
  const { data } = await params.supabase
    .from("campaign_messages")
    .select("campaign_id, phone")
    .eq("message_id", params.messageId)
    .eq("channel", "whatsapp")
    .maybeSingle();
  return data ?? null;
}

async function lookupCampaignWorkspaceId(params: {
  supabase: WhatsAppStatusSupabaseClient;
  campaignId: string;
}): Promise<string | null> {
  const { data } = await params.supabase
    .from("campaign_history")
    .select("workspace_id")
    .eq("id", params.campaignId)
    .single();
  return data?.workspace_id ?? null;
}

async function lookupExistingCampaignMessageState(params: {
  supabase: WhatsAppStatusSupabaseClient;
  messageId: string;
}): Promise<{ status: string | null; delivered_at: string | null } | null> {
  const { data } = await params.supabase
    .from("campaign_messages")
    .select("status, delivered_at")
    .eq("message_id", params.messageId)
    .eq("channel", "whatsapp")
    .maybeSingle();
  if (!data) return null;
  return {
    status: typeof data.status === "string" ? data.status : null,
    delivered_at:
      typeof data.delivered_at === "string" ? data.delivered_at : null,
  };
}

async function emitConversationDeliveryUpdate(params: {
  deps: WhatsAppStatusWebhookHandlerDependencies;
  result: WhatsAppDeliveryRecordResult | null | undefined;
  workspaceId: string;
  messageId: string;
  status: string;
  requestLogger: WhatsAppStatusRequestLogger;
  suppressRealtime?: boolean;
}) {
  if (params.suppressRealtime) {
    return;
  }

  if (
    !params.result?.messageFound ||
    !params.result.messageDeliveryUpdated ||
    !params.result.conversationId ||
    !params.result.delivery?.status
  ) {
    return;
  }

  const delivery = {
    ...params.result.delivery,
    status: params.result.delivery.status,
  };

  await params.deps
    .realtimeTrigger(
      `private-conversation-${params.result.conversationId}`,
      "message-delivery",
      {
        workspaceId: params.workspaceId,
        messageId: params.messageId,
        messageObjectId: params.result.messageObjectId,
        status: params.result.delivery.status,
        delivery,
      },
    )
    .catch((error) => {
      params.requestLogger.warn("WhatsApp delivery realtime fanout failed", {
        messageId: params.messageId,
        status: params.status,
        conversationId: params.result?.conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

export function createWhatsAppStatusWebhookHandler(
  deps: WhatsAppStatusWebhookHandlerDependencies,
) {
  return async function tryHandleWhatsAppStatusWebhook(
    params: WhatsAppStatusWebhookHandlerParams,
  ): Promise<Response | null> {
    const { body, requestLogger, supabase } = params;
    const realtimeSuppressed = Boolean(params.suppressRealtime);
    if (
      body.object !== "whatsapp_business_account" ||
      !body.entry?.[0]?.changes?.[0]?.value?.statuses?.[0]
    ) {
      return null;
    }

    const changeValue = body.entry[0].changes[0].value;
    const statuses = changeValue.statuses;
    const status = statuses?.[0];
    if (!status) {
      return null;
    }
    if (!status.id || !status.status || !status.timestamp) {
      requestLogger.warn(
        "WhatsApp status webhook skipped due to malformed payload",
        {
          hasId: Boolean(status.id),
          hasStatus: Boolean(status.status),
          hasTimestamp: Boolean(status.timestamp),
          rawStatus: status,
        },
      );
      return Response.json({ status: "ok" });
    }

    const messageId = status.id;
    const statusType = status.status;
    const timestamp = parseWhatsAppTimestamp(status.timestamp);
    const recipientIdentity = resolveWhatsAppStatusRecipientIdentity({
      status,
      contacts: changeValue.contacts,
    });
    const statusRecipientId = recipientIdentity.recipientId;
    const statusPhoneNumberId =
      changeValue.metadata?.phone_number_id ??
      changeValue.metadata?.cs_id ??
      null;

    requestLogger.info("WhatsApp message status update received", {
      messageId,
      status: statusType,
      recipientId: statusRecipientId,
      recipientWaId: recipientIdentity.recipientWaId,
      recipientUserId: recipientIdentity.recipientUserId,
      timestamp: timestamp.toISOString(),
      errors: status.errors,
    });

    let statusSource: WhatsAppStatusSource | null = null;
    try {
      statusSource = await deps.resolveWhatsAppSourceByAccountIdentifiers({
        ...extractWhatsAppIdentifiersFromWebhookValue({
          entryId: body.entry?.[0]?.id,
          value: changeValue,
        }),
        phoneNumberId: statusPhoneNumberId || undefined,
      });
    } catch (sourceError) {
      requestLogger.warn("WhatsApp status source lookup failed", {
        messageId,
        phoneNumberId: statusPhoneNumberId,
        error:
          sourceError instanceof Error
            ? sourceError.message
            : String(sourceError),
      });
    }

    const callbackHint = parseCampaignCallbackData(status.biz_opaque_callback_data);
    // Meta echoes the hint unsigned, so any sender on the number can name
    // another workspace. Only a hint matching the verified source workspace may
    // name where a status is recorded; one naming another workspace is ignored.
    const verifiedCallbackHint =
      callbackHint &&
      statusSource?.workspace_id &&
      callbackHint.workspaceId === statusSource.workspace_id
        ? callbackHint
        : null;
    const hintNamesOtherWorkspace = Boolean(
      callbackHint && statusSource?.workspace_id && !verifiedCallbackHint,
    );
    if (hintNamesOtherWorkspace) {
      requestLogger.warn("WhatsApp status campaign hint names another workspace", {
        messageId,
        workspaceId: statusSource?.workspace_id,
        sourceId: statusSource?.id,
        hintWorkspaceId: callbackHint?.workspaceId,
      });
    }
    // The campaign row update is keyed by message id, so an unresolved source
    // may still use the hint for it, but not to name a workspace.
    const campaignRowHint = hintNamesOtherWorkspace ? null : callbackHint;
    let taskAcceptanceRecoveryFailed = false;
    if (
      params.providerSignatureVerified === true &&
      callbackHint?.taskId &&
      !statusSource
    ) {
      // Source resolution can return null for a transient store failure.
      // Retain the status below, then retry rather than lose task evidence.
      taskAcceptanceRecoveryFailed = true;
    }

    // Disconnection stops automation, but cannot erase acceptance of a request
    // made before disconnecting. The recovery owner verifies the exact task,
    // workspace, source, sender and recipient against the durable send intent.
    if (
      params.providerSignatureVerified === true &&
      callbackHint?.taskId &&
      statusSource?.id &&
      statusSource.workspace_id === callbackHint.workspaceId &&
      statusPhoneNumberId && statusRecipientId &&
      ["sent", "delivered", "read", "played", "failed"].includes(statusType) &&
      deps.recordCampaignTaskProviderAcceptance
    ) {
      try {
        await deps.recordCampaignTaskProviderAcceptance({
          workspaceId: callbackHint.workspaceId,
          campaignId: callbackHint.campaignId,
          taskId: callbackHint.taskId,
          sourceId: statusSource.id,
          phoneNumberId: statusPhoneNumberId,
          recipient: statusRecipientId,
          messageId,
        });
      } catch (error) {
        taskAcceptanceRecoveryFailed = true;
        requestLogger.error("WhatsApp campaign task acceptance persist failed", error, {
          messageId, taskId: callbackHint.taskId,
        });
      }
    }

    // Meta reported the accepted campaign send as failed, so it never reached
    // the customer and its contact-policy slot stops counting. Only a signed
    // webhook whose hint names the verified source workspace may release one.
    const releaseFailedCampaignContact = async () => {
      if (
        !deps.releaseCampaignContactSlot ||
        params.providerSignatureVerified !== true ||
        !callbackHint ||
        !statusRecipientId ||
        !statusSource?.workspace_id ||
        statusSource.workspace_id !== callbackHint.workspaceId
      )
        return;
      try {
        await deps.releaseCampaignContactSlot({
          workspaceId: callbackHint.workspaceId,
          campaignId: callbackHint.campaignId,
          taskId: callbackHint.taskId || null,
          phone: statusRecipientId,
        });
      } catch (error) {
        // The slot stays reserved, which only delays the next send.
        requestLogger.warn("WhatsApp campaign contact slot release failed", {
          messageId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    // The campaign row lives in Supabase and does not depend on the Mongo
    // delivery record, so the two run concurrently.
    const persistCampaignStatus = async (): Promise<CampaignMessage | null> => {
      try {
        let campaignMessage: CampaignMessage | null = null;
        let campaignWorkspaceId: string | null = null;

        if (campaignRowHint) {
          campaignMessage = {
            campaign_id: campaignRowHint.campaignId,
            phone: statusRecipientId || undefined,
          };
          campaignWorkspaceId = campaignRowHint.workspaceId;
        } else {
          campaignMessage = await lookupCampaignMessage({ supabase, messageId });
        }

        if (!campaignMessage) return null;

        const campaignStatusType =
          statusType === "played" ? "read" : statusType;
        const existingState = await lookupExistingCampaignMessageState({
          supabase,
          messageId,
        });
        const shouldAdvanceStatus = shouldAdvanceWhatsAppDeliveryStatus({
          currentStatus: existingState?.status,
          incomingStatus: campaignStatusType,
        });

        const updateData: {
          status?: string;
          delivered_at?: string;
          read_at?: string;
          failed_at?: string;
          error_code?: number;
          error_message?: string;
          failure_scope?: "provider" | "recipient" | "unknown";
          estimated_cost_usd?: number | null;
          updated_at: string;
        } = {
          updated_at: (deps.now?.() ?? new Date()).toISOString(),
        };

        if (shouldAdvanceStatus) {
          updateData.status = campaignStatusType;
        }

        if (campaignStatusType === "delivered") {
          if (!existingState?.delivered_at) {
            updateData.delivered_at = timestamp.toISOString();
          }
        } else if (campaignStatusType === "read") {
          updateData.read_at = timestamp.toISOString();
          if (!existingState?.delivered_at) {
            updateData.delivered_at = timestamp.toISOString();
          }
        } else if (campaignStatusType === "failed" && shouldAdvanceStatus) {
          const errorCode = status.errors?.[0]?.code;
          updateData.failed_at = timestamp.toISOString();
          updateData.error_code = errorCode;
          updateData.error_message = status.errors?.[0]?.message;
          updateData.failure_scope = classifyMetaMessageFailureScope(errorCode);
        }

        const pricingUpdate = buildWhatsAppCampaignPricingReceiptPatch(status.pricing, timestamp);
        if (pricingUpdate) Object.assign(updateData, pricingUpdate);

        const hasFieldUpdates =
          Boolean(updateData.status) ||
          Boolean(updateData.delivered_at) ||
          Boolean(updateData.read_at) ||
          Boolean(updateData.failed_at) ||
          updateData.estimated_cost_usd !== undefined;

        if (hasFieldUpdates) {
          const persistStatusResult =
            await deps.persistCampaignMessageStatusWithOutbox({
              messageId,
              updateData,
              ...(!realtimeSuppressed
                ? {
                    realtime: {
                      campaignId: campaignMessage.campaign_id,
                      ...(campaignWorkspaceId
                        ? { workspaceId: campaignWorkspaceId }
                        : {}),
                    },
                  }
                : {}),
            });
          if (
            updateData.failed_at &&
            (persistStatusResult.applied || persistStatusResult.queuedToOutbox)
          ) {
            await releaseFailedCampaignContact();
          }
          if (
            !persistStatusResult.applied &&
            !persistStatusResult.queuedToOutbox
          ) {
            requestLogger.error(
              "WhatsApp campaign status persist failed; outbox not queued",
              undefined,
              {
                messageId,
                status: statusType,
                error: persistStatusResult.errorMessage,
              },
            );
          } else if (persistStatusResult.queuedToOutbox) {
            requestLogger.warn(
              "WhatsApp campaign status persisted via outbox fallback",
              {
                messageId,
                status: statusType,
                error: persistStatusResult.errorMessage,
              },
            );
          }
        }
        return campaignMessage;
      } catch (error) {
        requestLogger.error(
          "WhatsApp campaign message status update failed",
          error,
          { messageId, status: statusType },
        );
        return null;
      }
    };
    let campaignStatusUpdate: Promise<CampaignMessage | null> | null = null;
    const updateCampaignStatus = () => {
      if (!campaignStatusUpdate) campaignStatusUpdate = persistCampaignStatus();
      return campaignStatusUpdate;
    };

    let deliveryResult: WhatsAppDeliveryRecordResult | null = null;
    // Campaign id already stored on this event's delivery record for a message
    // that exists, so the campaign follow-up below need not record it again.
    // A status can arrive before bulk dispatch saves the message; then the
    // follow-up stays as the later retry that links it.
    let deliveryRecordedCampaignId: string | null = null;
    if (statusSource?.workspace_id) {
      const sourceSkip = deps.getWhatsAppWebhookSourceSkip(statusSource);
      if (sourceSkip) {
        requestLogger.warn(
          "WhatsApp status webhook skipped for inactive source",
          {
            messageId,
            phoneNumberId: statusPhoneNumberId,
            workspaceId: statusSource.workspace_id,
            sourceId: statusSource.id,
            reason: sourceSkip.reason,
          },
        );
        return taskAcceptanceRecoveryFailed
          ? Response.json({ error: "Campaign task acceptance persistence failed" }, { status: 503 })
          : Response.json(deps.buildWhatsAppWebhookSourceSkipPayload(sourceSkip));
      }

      void updateCampaignStatus();
      const verifiedCampaignId = verifiedCallbackHint?.campaignId ?? null;
      try {
        deliveryResult = await deps.recordWhatsAppMessageDeliveryStatus({
          workspaceId: statusSource.workspace_id,
          messageId,
          status: statusType,
          eventAt: timestamp,
          recipientId: statusRecipientId,
          recipientWaId: recipientIdentity.recipientWaId,
          recipientUserId: recipientIdentity.recipientUserId,
          recipientParentUserId: recipientIdentity.recipientParentUserId,
          recipientUsername: recipientIdentity.recipientUsername,
          recipientType: status.recipient_type || null,
          recipientParticipantId: status.recipient_participant_id || null,
          ...(verifiedCampaignId ? { campaignId: verifiedCampaignId } : {}),
          phoneNumberId: statusPhoneNumberId,
          sourceId: statusSource.id || null,
          pricing: status.pricing,
          conversation: status.conversation,
          errors: status.errors,
          rawStatus: status,
          bizOpaqueCallbackData: status.biz_opaque_callback_data || null,
          recipientIdentityKeyHash: status.recipient_identity_key_hash || null,
        });
        if (
          deliveryResult?.recorded &&
          deliveryResult.messageFound &&
          verifiedCampaignId
        ) {
          deliveryRecordedCampaignId = verifiedCampaignId;
        }
      } catch (error) {
        requestLogger.warn("WhatsApp delivery event persist failed", {
          messageId,
          status: statusType,
          workspaceId: statusSource?.workspace_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      await emitConversationDeliveryUpdate({
        deps,
        result: deliveryResult,
        workspaceId: statusSource.workspace_id,
        messageId,
        status: statusType,
        requestLogger,
        suppressRealtime: realtimeSuppressed,
      });
    }

    // A group status names one participant; that BSUID is not the group chat's.
    const statusRecipientUserId =
      status.recipient_type === "group"
        ? null
        : recipientIdentity.recipientUserId ||
          (statusRecipientId && !isWhatsAppPhoneLike(statusRecipientId)
            ? statusRecipientId
            : null);
    if (statusRecipientUserId) {
      requestLogger.info("WhatsApp status BSUID recipient observed", {
        messageId,
        recipientBsuid: statusRecipientUserId,
        statusType,
        phoneNumberId: changeValue.metadata?.phone_number_id,
      });

      // Every status repeats the conditional writes, so one that failed earlier
      // is retried; the recorded chat saves the extra message lookup.
      try {
        const normalizedMessageId = normalizeWhatsAppMessageId(messageId);
        const chatId =
          deliveryResult?.chatId ||
          (await deps.findOriginalMessageChatIdByMessageId(
            normalizedMessageId,
          ));
        if (chatId) {
          await Promise.all([
            deps.updateUserWhatsAppUserId({
              chatId,
              userId: statusRecipientUserId,
            }),
            deps.updateChatWhatsAppUserId({
              chatId,
              userId: statusRecipientUserId,
            }),
          ]);
        }
      } catch (enrichError) {
        requestLogger.warn("WhatsApp status BSUID enrichment failed", {
          messageId,
          recipientBsuid: statusRecipientUserId,
          error:
            enrichError instanceof Error
              ? enrichError.message
              : String(enrichError),
        });
      }
    }

    if (statusType === "read") {
      void deps
        .trackScenarioFlowReadByMessageId({
          outboundMessageId: messageId,
          eventAt: timestamp,
        })
        .catch((error) => {
          requestLogger.warn("WhatsApp flow analytics read tracking failed", {
            messageId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    const campaignMessage = await updateCampaignStatus();
    if (
      campaignMessage &&
      campaignMessage.campaign_id !== deliveryRecordedCampaignId
    ) {
      void (async () => {
        let resolvedCampaignWorkspaceId =
          verifiedCallbackHint?.workspaceId || null;
        let followUpCampaignId = campaignMessage.campaign_id;
        if (!resolvedCampaignWorkspaceId) {
          // An unverified hint never names the campaign either: the stored row
          // for this message does, and its campaign names the workspace.
          if (campaignRowHint) {
            const storedCampaign = await lookupCampaignMessage({
              supabase,
              messageId,
            });
            if (!storedCampaign) return;
            followUpCampaignId = storedCampaign.campaign_id;
          }
          resolvedCampaignWorkspaceId = await lookupCampaignWorkspaceId({
            supabase,
            campaignId: followUpCampaignId,
          });
        }

        if (resolvedCampaignWorkspaceId) {
          await deps.recordWhatsAppMessageDeliveryStatus({
            workspaceId: resolvedCampaignWorkspaceId,
            messageId,
            status: statusType,
            eventAt: timestamp,
            recipientId: statusRecipientId,
            recipientWaId: recipientIdentity.recipientWaId,
            recipientUserId: recipientIdentity.recipientUserId,
            recipientParentUserId: recipientIdentity.recipientParentUserId,
            recipientUsername: recipientIdentity.recipientUsername,
            recipientType: status.recipient_type || null,
            recipientParticipantId: status.recipient_participant_id || null,
            campaignId: followUpCampaignId,
            phoneNumberId: statusPhoneNumberId,
            sourceId: statusSource?.id || null,
            pricing: status.pricing,
            conversation: status.conversation,
            errors: status.errors,
            rawStatus: status,
            bizOpaqueCallbackData: status.biz_opaque_callback_data || null,
            recipientIdentityKeyHash:
              status.recipient_identity_key_hash || null,
          });
        }
      })().catch((error) => {
        requestLogger.warn(
          "WhatsApp campaign status post-processing failed",
          {
            campaignId: campaignMessage.campaign_id,
            messageId,
            status: statusType,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      });
    }

    if (status.status === "failed" && !realtimeSuppressed) {
      const is24HourError = status.errors?.some((err) => err.code === 131047);
      if (is24HourError) {
        void (async () => {
          const workspaceId = statusSource?.workspace_id;
          if (!workspaceId) return;

          let conversation: OpenConversation | null =
            deliveryResult?.messageFound && deliveryResult.conversationId
              ? { _id: deliveryResult.conversationId, workspaceId }
              : null;
          if (!conversation) {
            const sourceId = statusSource?.id;
            if (!sourceId) return;
            const recipientId = statusRecipientId;
            if (!recipientId) {
              throw new Error("Missing status recipient id");
            }
            const recipientPhone = normalizeWhatsAppPhone(recipientId);
            const recipientChatId = recipientPhone
              ? `wa_${recipientPhone}`
              : `wa_bsuid_${recipientId}`;
            conversation = await deps.findOpenWhatsAppConversationByChatId({
              chatId: recipientChatId,
              workspaceId,
              sourceId,
            });
          }

          if (conversation?.workspaceId === workspaceId) {
            await deps.realtimeTrigger(
              `private-conversation-${conversation._id}`,
              "message-failed",
              {
                messageId: status.id,
                errorCode: 131047,
                errorType: "24_hour_window_expired",
                message:
                  "Message failed: 24-hour window expired. Use template messages to re-engage.",
                timestamp: parseWhatsAppTimestamp(status.timestamp),
              },
            );

            await deps.realtimeTrigger(
              `private-${workspaceId}-alerts`,
              "alert",
              {
                type: "warning",
                title: "WhatsApp Message Failed",
                message:
                  "24-hour window expired for conversation. Use template messages to re-engage.",
                conversationId: String(conversation._id),
                timestamp: deps.now?.() ?? new Date(),
              },
            );
          }
        })().catch((error) => {
          requestLogger.warn("WhatsApp failed status alert fanout failed", {
            messageId,
            status: statusType,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }

    requestLogger.success("WhatsApp status webhook processed", {
      messageId,
      status: statusType,
      recipientId: statusRecipientId,
    });

    return taskAcceptanceRecoveryFailed
      ? Response.json({ error: "Campaign task acceptance persistence failed" }, { status: 503 })
      : Response.json({ status: "ok" });
  };
}
