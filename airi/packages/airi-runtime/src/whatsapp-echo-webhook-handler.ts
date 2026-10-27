import { extractWhatsAppIdentifiersFromWebhookValue } from "@icecore/shared/lib/whatsapp/account-identifiers";
import {
  getWhatsAppLogIdentity,
  isWhatsAppPhoneLike,
  type WhatsAppNormalizedContact,
} from "@icecore/shared/lib/whatsapp/contact-identities";
import {
  resolveWhatsAppDisplayPhoneNumber,
  resolveWhatsAppOutboundRecipientContact,
} from "@icecore/shared/lib/whatsapp/webhook-direction";
import {
  buildWhatsAppMessageRawSourcePayload,
  parseWhatsAppTimestamp,
  type WhatsAppMessage,
  type WhatsAppWebhookBody,
  type WhatsAppWebhookChange,
  type WhatsAppWebhookValue,
} from "@icecore/shared/lib/whatsapp/webhook-payload";
import { asRecord } from "@icecore/shared/lib/value-utils";
import {
  buildWhatsAppIntakePlanSkipBody,
  readWhatsAppPlanSkippedProcessResult,
  type WhatsAppIntakePlanCheck,
  type WhatsAppIntakePlanSkip,
} from "./whatsapp-intake-plan-gate";

type WhatsAppEchoWebhookRequestLogger = {
  info: (message: string, context?: Record<string, unknown>) => void;
  success: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (
    message: string,
    error?: unknown,
    context?: Record<string, unknown>,
  ) => void;
};

type WhatsAppEchoSourceRow = {
  id?: string | null;
  workspace_id?: string | null;
  credentials?: unknown;
};

type ExistingWhatsAppMessage = {
  messageId?: unknown;
  conversation?: unknown;
};

type ProcessedWhatsAppMessage = {
  _id?: unknown;
};

type ProcessWhatsAppEchoMessageResult = {
  conversationId?: string | null;
  isNewConversation?: boolean;
  message?: ProcessedWhatsAppMessage | null;
  messageWasNew?: boolean;
  processedAs?: string | null;
  planSkip?: WhatsAppIntakePlanSkip;
};

type EchoRealtimeTrigger = (
  channel: string,
  eventName: string,
  data: unknown,
) => Promise<unknown>;

type EchoConversationRealtimeTrigger = (
  conversationId: string,
  wasJustCreated?: boolean,
) => Promise<unknown>;

type EchoReactionRealtimeTrigger = (params: {
  conversationId: string;
  messageId: string;
}) => Promise<unknown>;

export type WhatsAppEchoWebhookHandlerDependencies = {
  buildWhatsAppWebhookSourceSkipPayload: (
    sourceSkip: any,
  ) => Record<string, unknown>;
  decryptString: (value: any) => string;
  findExistingWhatsAppMessageByExternalId: (
    messageId: string,
  ) => Promise<ExistingWhatsAppMessage | null>;
  findMessageForRealtime: (messageId: unknown) => Promise<unknown>;
  getWhatsAppWebhookSourceSkip: (source: any) => any | null;
  /** Trial-expired intake lock; fails open (see whatsapp-intake-plan-gate). */
  getWhatsAppIntakePlanSkip: WhatsAppIntakePlanCheck;
  processWhatsAppMessage: (params: {
    accessToken: string;
    contactData: WhatsAppNormalizedContact;
    direction: "outbound";
    messageData: WhatsAppMessage;
    messageDate: Date;
    phoneNumberId: string;
    rawSourcePayload: any;
    sourceId: string;
    workspaceId: string;
  }) => Promise<ProcessWhatsAppEchoMessageResult>;
  realtimeTrigger: EchoRealtimeTrigger;
  resolveWhatsAppSourceByAccountIdentifiers: (
    params: Record<string, unknown>,
  ) => Promise<WhatsAppEchoSourceRow | null>;
  shouldProcessEvenIfDuplicate: (messageType: string | undefined) => boolean;
  triggerConversationRealtime: EchoConversationRealtimeTrigger;
  triggerWhatsAppReactionRealtimeUpdate: EchoReactionRealtimeTrigger;
};

function readMessageDocumentId(message: unknown): unknown {
  if (!message || typeof message !== "object") return null;
  return (message as { _id?: unknown })._id ?? null;
}

function isWhatsAppEchoWebhookValue(
  value: WhatsAppWebhookChange["value"],
): value is Pick<
  WhatsAppWebhookValue,
  "message_echoes" | "smb_message_echoes" | "contacts" | "metadata"
> {
  if (!value || typeof value !== "object") return false;
  return "message_echoes" in value || "smb_message_echoes" in value;
}

function resolveEchoContainerKey(params: {
  echoValue: Pick<WhatsAppWebhookValue, "message_echoes">;
  messageId: string;
}) {
  return params.echoValue.message_echoes?.some(
    (echo) => echo.id === params.messageId,
  )
    ? "message_echoes"
    : "smb_message_echoes";
}

export function createWhatsAppEchoWebhookHandler(
  deps: WhatsAppEchoWebhookHandlerDependencies,
) {
  return async function tryHandleWhatsAppEchoWebhook(params: {
    body: WhatsAppWebhookBody;
    change: WhatsAppWebhookChange;
    requestLogger: WhatsAppEchoWebhookRequestLogger;
  }): Promise<Response | null> {
    const { body, change, requestLogger } = params;

    if (!isWhatsAppEchoWebhookValue(change.value)) {
      return null;
    }

    const echoValue = change.value;
    const allEchoes = [
      ...(echoValue.message_echoes || []),
      ...(echoValue.smb_message_echoes || []),
    ];

    if (allEchoes.length === 0) {
      return Response.json({ status: "ok", message: "echoes processed" });
    }

    const echoMetadata = echoValue.metadata || {};
    const echoPhoneNumberId =
      echoMetadata.phone_number_id || echoMetadata.cs_id;

    requestLogger.info("WhatsApp message echoes received", {
      messageCount: allEchoes.length,
      messageEchoCount: echoValue.message_echoes?.length || 0,
      smbMessageEchoCount: echoValue.smb_message_echoes?.length || 0,
      phoneNumberId: echoPhoneNumberId,
      messageIds: allEchoes.map((message) => message.id),
    });

    const source = await deps.resolveWhatsAppSourceByAccountIdentifiers({
      ...extractWhatsAppIdentifiersFromWebhookValue({
        entryId: body.entry?.[0]?.id,
        value: echoValue,
      }),
      phoneNumberId: echoPhoneNumberId,
    });

    if (!source?.id || !source.workspace_id) {
      return Response.json({ status: "ok", message: "echoes processed" });
    }

    const sourceSkip = deps.getWhatsAppWebhookSourceSkip(source);
    if (sourceSkip) {
      requestLogger.warn("WhatsApp echo webhook skipped for inactive source", {
        phoneNumberId: echoPhoneNumberId ?? null,
        workspaceId: source.workspace_id,
        sourceId: source.id,
        reason: sourceSkip.reason,
      });
      return Response.json(
        deps.buildWhatsAppWebhookSourceSkipPayload(sourceSkip),
      );
    }

    // Echoes download media eagerly; a trial-expired company stores none.
    const intakePlanSkip = await deps.getWhatsAppIntakePlanSkip({
      workspaceId: source.workspace_id,
      sourceId: source.id,
      itemKind: "echo",
    });
    if (intakePlanSkip) {
      requestLogger.info("WhatsApp echo intake skipped by company plan", {
        phoneNumberId: echoPhoneNumberId ?? null,
        workspaceId: source.workspace_id,
        sourceId: source.id,
        itemKind: "echo",
        messageIds: allEchoes.map((message) => message.id),
        reason: intakePlanSkip.reason,
      });
      return Response.json(buildWhatsAppIntakePlanSkipBody(intakePlanSkip));
    }

    const sourceCredentials = asRecord(source.credentials);
    const accessToken = deps.decryptString(sourceCredentials.access_token);
    const resolvedEchoPhoneNumberId =
      echoPhoneNumberId ||
      sourceCredentials.phone_number_id ||
      sourceCredentials.cs_id ||
      "";

    let newConversationPlanSkip: WhatsAppIntakePlanSkip | null = null;
    for (const messageData of allEchoes) {
      const displayPhoneNumber = resolveWhatsAppDisplayPhoneNumber({
        metadataDisplayPhoneNumber: echoMetadata.display_phone_number,
        sourceCredentials,
      });
      const contactData = resolveWhatsAppOutboundRecipientContact({
        messageData,
        contacts: echoValue.contacts,
        displayPhoneNumber,
      });

      if (!contactData) {
        requestLogger.warn(
          "WhatsApp echo skipped; could not resolve recipient",
          {
            messageId: messageData.id,
            messageFrom: messageData.from ?? null,
            messageTo: messageData.to ?? null,
            hasContacts: Boolean(echoValue.contacts?.length),
            displayPhoneNumber: displayPhoneNumber ?? null,
            phoneNumberId: resolvedEchoPhoneNumberId,
            workspaceId: source.workspace_id,
          },
        );
        continue;
      }

      const messageDate = parseWhatsAppTimestamp(messageData.timestamp);

      if (!deps.shouldProcessEvenIfDuplicate(messageData.type)) {
        const existingMessage =
          await deps.findExistingWhatsAppMessageByExternalId(messageData.id);
        if (existingMessage) {
          requestLogger.info("WhatsApp duplicate echo ignored", {
            messageId: messageData.id,
            storedMessageId: existingMessage.messageId,
            conversationId: String(existingMessage.conversation),
            workspaceId: source.workspace_id,
            phoneNumberId: resolvedEchoPhoneNumberId,
          });
          continue;
        }
      }

      requestLogger.info("WhatsApp echo message processing", {
        messageId: messageData.id,
        recipientId: getWhatsAppLogIdentity(contactData) || null,
        contactDataWaId: contactData.waId || null,
        contactDataUserId: contactData.userId || null,
        workspaceId: source.workspace_id,
        sourceId: source.id,
        direction: "outbound",
        phoneNumberId: resolvedEchoPhoneNumberId,
      });

      if (
        messageData.to &&
        !isWhatsAppPhoneLike(messageData.to) &&
        contactData.userId
      ) {
        requestLogger.info("WhatsApp echo BSUID recipient observed", {
          messageId: messageData.id,
          echoTo: messageData.to,
          resolvedUserId: contactData.userId,
          phoneNumberId: resolvedEchoPhoneNumberId,
          workspaceId: source.workspace_id,
        });
      }

      try {
        const result = await deps.processWhatsAppMessage({
          messageData,
          contactData,
          phoneNumberId: String(resolvedEchoPhoneNumberId),
          accessToken,
          workspaceId: source.workspace_id,
          direction: "outbound",
          sourceId: source.id,
          messageDate,
          rawSourcePayload: buildWhatsAppMessageRawSourcePayload({
            body,
            entry: body.entry[0],
            change,
            value: echoValue as WhatsAppWebhookValue,
            messageData,
            sourceId: source.id,
            direction: "outbound",
            capturedAt: messageDate,
            messageContainerKey: resolveEchoContainerKey({
              echoValue,
              messageId: messageData.id,
            }),
          }),
        });

        const planSkip = readWhatsAppPlanSkippedProcessResult(result);
        if (planSkip) {
          requestLogger.info(
            "WhatsApp echo new conversation skipped by company plan",
            {
              messageId: messageData.id,
              workspaceId: source.workspace_id,
              sourceId: source.id,
              itemKind: "echo",
              reason: planSkip.reason,
            },
          );
          newConversationPlanSkip = planSkip;
          continue;
        }

        if (!result.conversationId) {
          continue;
        }

        const isReactionEvent =
          messageData.type === "reaction" || result.processedAs === "reaction";

        if (!isReactionEvent && !result.messageWasNew) {
          requestLogger.info(
            "WhatsApp echo duplicate after race, skipping side effects",
            {
              messageId: messageData.id,
              conversationId: result.conversationId,
              workspaceId: source.workspace_id,
            },
          );
          continue;
        }

        await deps.triggerConversationRealtime(
          result.conversationId,
          result.isNewConversation,
        );

        if (isReactionEvent) {
          const reactionTargetId = readMessageDocumentId(result.message);
          if (reactionTargetId) {
            await deps.triggerWhatsAppReactionRealtimeUpdate({
              conversationId: result.conversationId,
              messageId: String(reactionTargetId),
            });
          }
          continue;
        }

        const messageId = readMessageDocumentId(result.message);
        if (!messageId) {
          continue;
        }

        await deps.realtimeTrigger(
          `private-conversation-${result.conversationId}`,
          "new-message",
          await deps.findMessageForRealtime(messageId),
        );
      } catch (error) {
        requestLogger.error("WhatsApp echo message processing failed", error, {
          messageId: messageData.id,
          workspaceId: source.workspace_id,
          sourceId: source.id,
          phoneNumberId: resolvedEchoPhoneNumberId,
        });
        throw error;
      }
    }

    requestLogger.success("WhatsApp message echoes batch completed", {
      workspaceId: source.workspace_id,
      sourceId: source.id,
      echoCount: allEchoes.length,
      phoneNumberId: resolvedEchoPhoneNumberId,
    });

    return Response.json({
      status: "ok",
      message: "echoes processed",
      // A plan-refused conversation marks the receipt for --plan-skipped
      // replay; echoes already stored are ignored as duplicates on replay.
      ...(newConversationPlanSkip
        ? { reason: newConversationPlanSkip.reason }
        : {}),
    });
  };
}
