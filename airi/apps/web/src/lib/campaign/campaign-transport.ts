import {
  getWorkspaceEmailSource,
  resolveEmailProviderForWorkspaceSource,
} from "@/lib/email/email-source";
import { renderMarkdownEmailTemplate } from "@/lib/email/email-template-rendering";
import {
  appendEmailUnsubscribeFooter,
  buildEmailUnsubscribeHeaders,
  getEmailUnsubscribeUrlFromTemplateModel,
} from "@/lib/email/email-unsubscribes";
import {
  getWorkspaceEmailProviderConfig,
  isManagedEmailProviderPending,
} from "@/lib/email/provider-config";
import { type PrebuiltEmailTemplateKey } from "@/lib/email/templates/registry";
import {
  POSTMARK_CAMPAIGN_MESSAGE_ID_METADATA_KEY,
  type PostmarkBulkEmailResponse,
  postmarkSendBulkEmails,
  postmarkSendEmail,
} from "@/lib/postmark";
import type { WhatsAppRecipientTarget } from "@/lib/whatsapp";
import type { WhatsAppTemplateSendComponentInput } from "@/lib/whatsapp/templates/message-types";
import { MetaGraphRequestError } from "@icecore/shared/lib/meta/api";
import { classifyMetaMessageFailureScope } from "@icecore/shared/lib/meta/message-failure-scope";
import { normalizeWhatsAppPhone } from "@icecore/shared/lib/whatsapp/contact-identities";
import { createHash, randomUUID } from "crypto";
import type { EmailCampaignContent } from "./bulk-campaign-contracts";
import { isCampaignEmailBatchEnabled } from "./campaign-config";
import {
  buildCampaignEmailTemplateModel,
  normalizeCampaignEmail,
} from "./campaign-recipient-utils";

export type CampaignTransportChannel = "whatsapp" | "telegram" | "email";
export type CampaignTransportProvider = "meta" | "telegram" | "postmark";
export type CampaignTransportFailureScope =
  | "provider"
  | "recipient"
  | "unknown";
export type CampaignWhatsAppTemplateCategory =
  | "MARKETING"
  | "UTILITY"
  | "AUTHENTICATION";

export type CampaignTransportCapabilities = {
  channel: CampaignTransportChannel;
  provider: CampaignTransportProvider;
  supportsBatch: boolean;
};

export type CampaignTransportSingleResult = {
  success: boolean;
  channel: CampaignTransportChannel;
  provider: CampaignTransportProvider;
  recipient: string;
  messageId?: string;
  acceptedAt?: string;
  providerMessageStatus?: string;
  error?: string;
  providerCode?: string;
  failureScope?: CampaignTransportFailureScope;
  /** WhatsApp request crossed the final provider I/O boundary. */
  providerRequestAttempted?: true;
  /** Provider acceptance cannot be established; never automatically resend. */
  providerAcceptanceUnknown?: true;
};

export type CampaignTransportBatchResult = {
  success: boolean;
  channel: "email";
  provider: "postmark";
  results: CampaignTransportSingleResult[];
  error?: string;
};

export type CampaignTransportSingleRequest =
  | {
      channel: "whatsapp";
      whatsappMessageType?: "template";
      recipient: { phone?: string; target?: WhatsAppRecipientTarget };
      phoneNumberId: string;
      accessToken: string;
      templateName: string;
      languageCode?: string;
      templateCategory?: CampaignWhatsAppTemplateCategory;
      contactPolicy?: {
        workspaceId: string;
        deliveryKey: string;
        conversationId?: string;
      };
      marketingMessagesEnabled?: boolean;
      marketingMessagePricing?: {
        perMessageBidMultiplier?: number;
      };
      messagingAccountId?: string;
      components?: WhatsAppTemplateSendComponentInput[];
      /** Same as panel send-template for Cloud API. */
      requirePhoneRecipient?: boolean;
      bizOpaqueCallbackData?: string | null;
      /** Persist durable send intent before crossing the provider I/O boundary. */
      beforeProviderSend?: () => Promise<void>;
    }
  | {
      channel: "whatsapp";
      whatsappMessageType: "service_text";
      contactPolicy?: {
        workspaceId: string;
        deliveryKey: string;
        conversationId?: string;
      };
      recipient: { phone?: string; target?: WhatsAppRecipientTarget };
      phoneNumberId: string;
      accessToken: string;
      messageText: string;
      beforeProviderSend?: () => Promise<void>;
    }
  | {
      channel: "telegram";
      recipient: { chatId: string };
      messageText: string;
      botToken?: string;
      businessConnectionId?: string;
    }
  | {
      channel: "email";
      workspaceId: string;
      recipient: { email: string; variables?: Record<string, string> };
      fromAddress?: string;
      templateKey?: PrebuiltEmailTemplateKey;
      templateModel?: Record<string, string>;
      subjectOverride?: string;
      emailContent?: EmailCampaignContent;
      messageStream?: string;
    };

export type CampaignTransportBatchRequest = {
  channel: "email";
  workspaceId: string;
  messages: Array<{
    recipient: { email: string; variables?: Record<string, string> };
    templateKey?: PrebuiltEmailTemplateKey;
    templateModel?: Record<string, string>;
    subjectOverride?: string;
    emailContent?: EmailCampaignContent;
    messageStream?: string;
  }>;
};

type PreparedBulkEmailMessage = {
  index: number;
  recipient: string;
  templateKey?: PrebuiltEmailTemplateKey;
  templateModel: Record<string, string>;
  subjectOverride?: string;
  emailContent?: EmailCampaignContent;
  messageStream: string;
  correlationMessageId: string;
  headers?: Record<string, string>;
};

const EMAIL_BULK_TEMPLATE_BASE_KEYS = [
  "recipientEmail",
  "recipientName",
  "company",
  "headline",
  "previewText",
  "signature",
  "body",
  "featureList",
  "eventDate",
  "eventTime",
  "workspaceName",
  "workspaceUrl",
] as const;

const EMAIL_BULK_OPTIONAL_LAYOUT_KEYS = ["ctaUrl", "ctaLabel"] as const;

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error || "Unknown transport error");
}

function readMetaProviderCode(error: MetaGraphRequestError): string | null {
  const details =
    error.details && typeof error.details === "object"
      ? (error.details as { error?: { code?: unknown } })
      : null;
  const rawCode = error.metaError?.code ?? details?.error?.code;
  if (
    (typeof rawCode !== "number" && typeof rawCode !== "string") ||
    !String(rawCode).trim()
  ) {
    return null;
  }
  return String(rawCode).trim();
}

export function classifyCampaignTransportFailure(params: {
  error: unknown;
  provider: CampaignTransportProvider;
}): {
  providerCode?: string;
  failureScope: CampaignTransportFailureScope;
} {
  if (
    params.provider !== "meta" ||
    !(params.error instanceof MetaGraphRequestError)
  ) {
    return { failureScope: "unknown" };
  }

  const providerCode = readMetaProviderCode(params.error);
  if (!providerCode) return { failureScope: "unknown" };
  return {
    providerCode,
    failureScope: classifyMetaMessageFailureScope(providerCode),
  };
}

function isPostmarkBulkApprovalRequiredError(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  return (
    (normalized.includes("requires approval") &&
      normalized.includes("bulk api")) ||
    normalized.includes("(code 14)")
  );
}

function buildBulkCorrelationMessageId(): string {
  return `bulk:${randomUUID()}`;
}

function buildBulkPlaceholderTemplateModel(
  models: Record<string, string>[]
): Record<string, string> {
  const keys = new Set<string>(EMAIL_BULK_TEMPLATE_BASE_KEYS);
  for (const model of models) {
    Object.keys(model).forEach(key => keys.add(key));
  }

  for (const optionalKey of EMAIL_BULK_OPTIONAL_LAYOUT_KEYS) {
    if (models.some(model => String(model[optionalKey] || "").trim())) {
      keys.add(optionalKey);
    } else {
      keys.delete(optionalKey);
    }
  }

  return Object.fromEntries(Array.from(keys).map(key => [key, `{{${key}}}`]));
}

function completeBulkTemplateModel(
  model: Record<string, string>,
  placeholderModel: Record<string, string>
): Record<string, string> {
  const completed = { ...model };
  for (const key of Object.keys(placeholderModel)) {
    if (completed[key] === undefined || completed[key] === null) {
      completed[key] = "";
    }
  }
  return completed;
}

function getBulkOptionalLayoutSignature(model: Record<string, string>): string {
  return JSON.stringify(
    EMAIL_BULK_OPTIONAL_LAYOUT_KEYS.map(key => [
      key,
      Boolean(String(model[key] || "").trim()),
    ])
  );
}

function getEmailContentSignature(content: EmailCampaignContent): string {
  return createHash("sha256")
    .update(content.subject)
    .update("\0")
    .update(content.markdown)
    .digest("hex");
}

export async function renderCampaignEmail(params: {
  templateKey?: PrebuiltEmailTemplateKey;
  templateModel: Record<string, string>;
  subjectOverride?: string;
  emailContent?: EmailCampaignContent;
}): Promise<{ subject: string; html: string; text: string }> {
  const rawUnsubscribeUrl = String(
    params.templateModel.unsubscribeUrl || ""
  ).trim();
  const unsubscribeUrl =
    getEmailUnsubscribeUrlFromTemplateModel(params.templateModel) ||
    (rawUnsubscribeUrl === "{{unsubscribeUrl}}" ? rawUnsubscribeUrl : "");

  if (params.emailContent) {
    return renderMarkdownEmailTemplate({
      subject: params.emailContent.subject,
      markdown: unsubscribeUrl
        ? appendEmailUnsubscribeFooter(
            params.emailContent.markdown,
            unsubscribeUrl
          )
        : params.emailContent.markdown,
      variables: params.templateModel,
    });
  }

  if (!params.templateKey) {
    throw new Error("Email templateKey or emailContent is required");
  }

  const { renderPrebuiltCampaignEmail } = await import(
    "@/lib/email/templates/registry-render"
  );
  const rendered = await renderPrebuiltCampaignEmail({
    templateKey: params.templateKey,
    templateModel: params.templateModel,
    subjectOverride: params.subjectOverride,
  });
  if (!unsubscribeUrl) return rendered;

  return {
    subject: rendered.subject,
    html: `${rendered.html}<p style="margin:24px 0 0;font-size:12px;line-height:18px;color:#6b7280;"><a href="{{unsubscribeUrl}}" style="color:#6b7280;text-decoration:underline;">Unsubscribe</a></p>`,
    text: `${rendered.text}\n\nUnsubscribe ({{unsubscribeUrl}})`,
  };
}

async function sendPreparedBulkEmailMessagesIndividually(params: {
  group: PreparedBulkEmailMessage[];
  providerConfig: Awaited<ReturnType<typeof resolveActiveEmailProvider>>;
}): Promise<CampaignTransportSingleResult[]> {
  const results: CampaignTransportSingleResult[] = [];

  for (const message of params.group) {
    try {
      const rendered = await renderCampaignEmail({
        templateKey: message.templateKey,
        templateModel: message.templateModel,
        subjectOverride: message.subjectOverride,
        emailContent: message.emailContent,
      });
      const result = await postmarkSendEmail({
        serverToken: params.providerConfig.postmarkServerToken,
        from: params.providerConfig.defaultFromAddress,
        to: message.recipient,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        messageStream: message.messageStream,
        headers: message.headers,
        metadata: {
          [POSTMARK_CAMPAIGN_MESSAGE_ID_METADATA_KEY]:
            message.correlationMessageId,
        },
      });

      results.push({
        success: Boolean(result.MessageID),
        channel: "email",
        provider: "postmark",
        recipient: message.recipient,
        messageId: result.MessageID || undefined,
        ...(result.MessageID
          ? {}
          : { error: "Email send returned empty message id" }),
      });
    } catch (error) {
      results.push({
        success: false,
        channel: "email",
        provider: "postmark",
        recipient: message.recipient,
        error: normalizeError(error),
      });
    }
  }

  return results;
}

function groupPreparedBulkMessages(messages: PreparedBulkEmailMessage[]) {
  const groups = new Map<string, PreparedBulkEmailMessage[]>();
  for (const message of messages) {
    const key = JSON.stringify([
      message.emailContent
        ? ["custom", getEmailContentSignature(message.emailContent)]
        : ["prebuilt", message.templateKey],
      message.subjectOverride || "",
      message.messageStream,
      message.emailContent
        ? ""
        : getBulkOptionalLayoutSignature(message.templateModel),
    ]);
    const group = groups.get(key) || [];
    group.push(message);
    groups.set(key, group);
  }
  return Array.from(groups.values());
}

function formatPostmarkBulkErrorItem(error: {
  ErrorCode?: number;
  Message?: string;
}): string {
  const message = String(error.Message || "").trim();
  const code =
    typeof error.ErrorCode === "number" ? ` (code ${error.ErrorCode})` : "";
  return `${message || "Postmark Bulk API recipient error"}${code}`;
}

function parsePostmarkBulkMessageErrorIndex(path: string): number | null {
  const bracketMatch = path.match(/Messages\[(\d+)\]/i);
  if (bracketMatch?.[1]) {
    return Number(bracketMatch[1]);
  }

  const dotMatch = path.match(/Messages\.(\d+)/i);
  if (dotMatch?.[1]) {
    return Number(dotMatch[1]);
  }

  return null;
}

function collectPostmarkBulkResponseErrors(
  response: PostmarkBulkEmailResponse,
  groupSize: number
) {
  const messageErrors = new Map<number, string[]>();
  const globalErrors: string[] = [];

  for (const [path, errors] of Object.entries(response.Errors || {})) {
    const formatted = (Array.isArray(errors) ? errors : [])
      .map(formatPostmarkBulkErrorItem)
      .join("; ");
    const message = `${path}: ${formatted || "Postmark Bulk API error"}`;
    const messageIndex = parsePostmarkBulkMessageErrorIndex(path);

    if (
      messageIndex !== null &&
      Number.isInteger(messageIndex) &&
      messageIndex >= 0 &&
      messageIndex < groupSize
    ) {
      const existing = messageErrors.get(messageIndex) || [];
      existing.push(message);
      messageErrors.set(messageIndex, existing);
    } else {
      globalErrors.push(message);
    }
  }

  return { messageErrors, globalErrors };
}

export function getCampaignTransportCapabilities(
  channel: CampaignTransportChannel
): CampaignTransportCapabilities {
  if (channel === "whatsapp") {
    return {
      channel,
      provider: "meta",
      supportsBatch: false,
    };
  }

  if (channel === "telegram") {
    return {
      channel,
      provider: "telegram",
      supportsBatch: false,
    };
  }

  return {
    channel,
    provider: "postmark",
    supportsBatch: true,
  };
}

async function resolveActiveEmailProvider(workspaceId: string) {
  const emailSource = await getWorkspaceEmailSource(workspaceId);
  const providerConfig =
    (await resolveEmailProviderForWorkspaceSource(emailSource)) ||
    (await getWorkspaceEmailProviderConfig(workspaceId, true));
  if (!providerConfig) {
    throw new Error(
      "Email source is not configured for this workspace. Connect email in Settings > Integrations first."
    );
  }
  if (isManagedEmailProviderPending(providerConfig)) {
    throw new Error(
      "email_provider_verification_pending: Verify DNS in Settings > Integrations > Email before sending email."
    );
  }
  if (providerConfig.status !== "active") {
    throw new Error("Email provider is inactive for this workspace.");
  }
  return providerConfig;
}

export async function sendCampaignTransportSingle(
  request: CampaignTransportSingleRequest
): Promise<CampaignTransportSingleResult> {
  let contactSuppression: string | null = null;
  let reservedContact: {
    workspaceId: string;
    phone: string;
    deliveryKey: string;
    conversationId?: string;
  } | null = null;
  let providerRequestAttempted = false;
  try {
    if (request.channel === "whatsapp") {
      const phone = normalizeWhatsAppPhone(
        request.recipient.target?.kind === "phone"
          ? request.recipient.target.value
          : request.recipient.phone
      );
      // A phone field is never an opaque WhatsApp identity. Explicit targets
      // retain the sender's authoritative BSUID/phone-only feature gates.
      if (
        (!request.recipient.target ||
          request.recipient.target.kind === "phone") &&
        !phone
      ) {
        return {
          success: false,
          channel: "whatsapp",
          provider: "meta",
          recipient: request.recipient.phone || "",
          error:
            "WhatsApp campaign recipient must contain a valid phone number with country code",
          providerCode: "invalid_whatsapp_recipient",
          failureScope: "recipient",
        };
      }
      const resolvedRecipient = request.recipient.target || phone!;
      // SQL/outbox recovery uses the original task identity. Canonicalization
      // changes only the address sent to Meta, never that durable lookup key.
      const recipientIdentity = request.recipient.target
        ? `${request.recipient.target.kind}:${request.recipient.target.value}`
        : request.recipient.phone || "";
      const reserveContact =
        request.contactPolicy &&
        (request.whatsappMessageType === "service_text" ||
          !request.templateCategory ||
          request.templateCategory === "MARKETING");
      // Reserve only after the existing sender has prepared and validated its
      // payload. After a POST, release only on Meta's definite rejection: a
      // missing response can still be accepted.
      const beforeSend = async () => {
        if (reserveContact) {
          const { reserveCustomerMarketingContact } = await import(
            "./customer-contact-policy"
          );
          contactSuppression = await reserveCustomerMarketingContact({
            ...request.contactPolicy!,
            phone: phone || "",
          });
          if (contactSuppression) throw new Error(contactSuppression);
          reservedContact = { ...request.contactPolicy!, phone: phone || "" };
        }
        await request.beforeProviderSend?.();
        providerRequestAttempted = true;
      };
      if (request.whatsappMessageType === "service_text") {
        const { sendWhatsappMessage } = await import("@/lib/whatsapp");
        const result = await sendWhatsappMessage(
          request.phoneNumberId,
          request.accessToken,
          resolvedRecipient,
          request.messageText,
          undefined,
          { beforeSend }
        );
        return {
          success: Boolean(result.messageId),
          channel: "whatsapp",
          provider: "meta",
          recipient: recipientIdentity,
          providerRequestAttempted: true,
          ...(!result.messageId
            ? { providerAcceptanceUnknown: true as const }
            : {}),
          messageId: result.messageId || undefined,
          acceptedAt: new Date(result.date * 1000).toISOString(),
          providerMessageStatus: result.messageStatus || undefined,
          ...(result.messageId
            ? {}
            : { error: "WhatsApp send returned empty message id" }),
        };
      }

      const { sendWhatsappTemplate } = await import("@/lib/whatsapp");
      const deliveryProduct =
        request.templateCategory === "MARKETING" &&
        request.marketingMessagesEnabled === true
          ? "marketing_messages"
          : "cloud_api";
      const perMessageBidMultiplier =
        request.marketingMessagePricing?.perMessageBidMultiplier;
      if (
        perMessageBidMultiplier !== undefined &&
        deliveryProduct !== "marketing_messages"
      ) {
        throw new Error(
          "WhatsApp marketingMessagePricing requires a MARKETING template sent through the Marketing Messages API"
        );
      }
      const requirePhoneRecipient =
        request.requirePhoneRecipient ||
        request.templateCategory === "AUTHENTICATION";
      const result = await sendWhatsappTemplate(
        request.phoneNumberId,
        request.accessToken,
        resolvedRecipient,
        request.templateName,
        request.languageCode || "en",
        request.components,
        {
          requirePhoneRecipient,
          deliveryProduct,
          messagingAccountId: request.messagingAccountId,
          perMessageBidMultiplier,
          bizOpaqueCallbackData: request.bizOpaqueCallbackData ?? null,
          beforeSend,
        }
      );

      return {
        success: Boolean(result.messageId),
        channel: "whatsapp",
        provider: "meta",
        recipient: recipientIdentity,
        providerRequestAttempted: true,
        ...(!result.messageId
          ? { providerAcceptanceUnknown: true as const }
          : {}),
        messageId: result.messageId || undefined,
        acceptedAt: new Date(result.date * 1000).toISOString(),
        providerMessageStatus: result.messageStatus || undefined,
        ...(result.messageId
          ? {}
          : { error: "WhatsApp send returned empty message id" }),
      };
    }

    if (request.channel === "telegram") {
      const { sendTelegramMessage } = await import("@/lib/telegram");
      const telegramOptions =
        request.botToken || request.businessConnectionId
          ? {
              ...(request.botToken ? { botToken: request.botToken } : {}),
              ...(request.businessConnectionId
                ? { businessConnectionId: request.businessConnectionId }
                : {}),
            }
          : undefined;
      const result = await sendTelegramMessage(
        request.recipient.chatId,
        request.messageText,
        telegramOptions
      );

      return {
        success: Boolean(result.messageId),
        channel: "telegram",
        provider: "telegram",
        recipient: request.recipient.chatId,
        messageId:
          result.messageId !== null && result.messageId !== undefined
            ? String(result.messageId)
            : undefined,
        ...(result.messageId
          ? {}
          : { error: "Telegram send returned empty message id" }),
      };
    }

    const providerConfig = await resolveActiveEmailProvider(
      request.workspaceId
    );
    if (request.fromAddress !== undefined && request.fromAddress !== null) {
      const normalizedLegacyFrom = normalizeCampaignEmail(request.fromAddress);
      if (
        normalizedLegacyFrom &&
        normalizedLegacyFrom !== providerConfig.defaultFromAddress
      ) {
        throw new Error(
          "fromAddress must match the workspace default sender. Update sender in Settings > Integrations > Email."
        );
      }
    }

    const templateModel = buildCampaignEmailTemplateModel({
      templateModel: request.templateModel,
      recipientEmail: request.recipient.email,
      recipientVariables: request.recipient.variables,
    });
    const unsubscribeHeaders = buildEmailUnsubscribeHeaders(
      getEmailUnsubscribeUrlFromTemplateModel(templateModel)
    );
    const rendered = await renderCampaignEmail({
      templateKey: request.templateKey,
      templateModel,
      subjectOverride: request.subjectOverride,
      emailContent: request.emailContent,
    });

    const { postmarkSendEmail } = await import("@/lib/postmark");
    const result = await postmarkSendEmail({
      from: providerConfig.defaultFromAddress,
      to: request.recipient.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      messageStream: request.messageStream || providerConfig.broadcastStream,
      serverToken: providerConfig.postmarkServerToken,
      headers: unsubscribeHeaders,
    });

    return {
      success: Boolean(result.MessageID),
      channel: "email",
      provider: "postmark",
      recipient: request.recipient.email,
      messageId: result.MessageID || undefined,
      ...(result.MessageID
        ? {}
        : { error: "Email send returned empty message id" }),
    };
  } catch (error) {
    const provider = getCampaignTransportCapabilities(request.channel).provider;
    const definiteMetaRejection =
      error instanceof MetaGraphRequestError &&
      Number.isInteger(error.metaError?.code) &&
      Number(error.metaError?.code) > 0;
    const contactToRelease = reservedContact as typeof reservedContact;
    if (providerRequestAttempted && definiteMetaRejection && contactToRelease) {
      // Meta rejected the request, so this contact never happened. A failed
      // release keeps the slot, which only delays the next send.
      const { releaseCustomerMarketingContact } = await import(
        "./customer-contact-policy"
      );
      await releaseCustomerMarketingContact(contactToRelease).catch(
        () => undefined
      );
    }
    const failure = contactSuppression
      ? { providerCode: contactSuppression, failureScope: "recipient" as const }
      : classifyCampaignTransportFailure({ error, provider });
    const recipient =
      request.channel === "whatsapp"
        ? request.recipient.phone ||
          (request.recipient.target
            ? `${request.recipient.target.kind}:${request.recipient.target.value}`
            : "")
        : request.channel === "telegram"
          ? request.recipient.chatId
          : request.recipient.email;

    return {
      success: false,
      channel: request.channel,
      provider,
      recipient,
      error: contactSuppression || normalizeError(error),
      ...(providerRequestAttempted
        ? { providerRequestAttempted: true as const }
        : {}),
      ...(providerRequestAttempted && !definiteMetaRejection
        ? { providerAcceptanceUnknown: true as const }
        : {}),
      ...failure,
    };
  }
}

export async function sendCampaignTransportBatch(
  request: CampaignTransportBatchRequest
): Promise<CampaignTransportBatchResult> {
  if (!isCampaignEmailBatchEnabled()) {
    return {
      success: false,
      channel: "email",
      provider: "postmark",
      results: request.messages.map(message => ({
        success: false,
        channel: "email",
        provider: "postmark",
        recipient: message.recipient.email,
        error: "Campaign email batch transport is disabled",
      })),
      error: "Campaign email batch transport is disabled",
    };
  }

  try {
    const providerConfig = await resolveActiveEmailProvider(
      request.workspaceId
    );

    const preparedMessages: PreparedBulkEmailMessage[] = request.messages.map(
      (message, index) => {
        const templateModel = buildCampaignEmailTemplateModel({
          templateModel: message.templateModel,
          recipientEmail: message.recipient.email,
          recipientVariables: message.recipient.variables,
        });

        return {
          index,
          recipient: message.recipient.email,
          templateKey: message.templateKey,
          templateModel,
          subjectOverride: message.subjectOverride || undefined,
          emailContent: message.emailContent,
          messageStream: providerConfig.broadcastStream,
          correlationMessageId: buildBulkCorrelationMessageId(),
          headers: buildEmailUnsubscribeHeaders(
            getEmailUnsubscribeUrlFromTemplateModel(templateModel)
          ),
        };
      }
    );

    const results: CampaignTransportSingleResult[] = Array.from(
      { length: preparedMessages.length },
      (_, index) => ({
        success: false,
        channel: "email",
        provider: "postmark",
        recipient: preparedMessages[index]?.recipient || "",
        error: "Email bulk send did not run",
      })
    );

    const groupErrors: string[] = [];

    for (const group of groupPreparedBulkMessages(preparedMessages)) {
      const representative = group[0];
      if (!representative) continue;

      try {
        const placeholderModel = buildBulkPlaceholderTemplateModel(
          group.map(message => message.templateModel)
        );
        const rendered = await renderCampaignEmail({
          templateKey: representative.templateKey,
          templateModel: placeholderModel,
          subjectOverride: representative.subjectOverride,
          emailContent: representative.emailContent,
        });

        const response = await postmarkSendBulkEmails({
          serverToken: providerConfig.postmarkServerToken,
          from: providerConfig.defaultFromAddress,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          messageStream: representative.messageStream,
          messages: group.map(message => ({
            to: message.recipient,
            templateModel: completeBulkTemplateModel(
              message.templateModel,
              placeholderModel
            ),
            headers: message.headers,
            metadata: {
              [POSTMARK_CAMPAIGN_MESSAGE_ID_METADATA_KEY]:
                message.correlationMessageId,
            },
          })),
        });

        const accepted = response.Status === "Accepted";
        const { messageErrors, globalErrors } =
          collectPostmarkBulkResponseErrors(response, group.length);
        const requestError =
          !accepted || globalErrors.length > 0
            ? [
                `Postmark Bulk API request ${response.ID || ""} returned ${response.Status || "unknown status"}`,
                ...globalErrors,
              ].join("; ")
            : "";

        if (requestError) {
          groupErrors.push(requestError);
        }

        for (const [groupIndex, message] of group.entries()) {
          const recipientErrors = messageErrors.get(groupIndex) || [];
          const recipientError = recipientErrors.join("; ");
          const error = requestError || recipientError;
          const success = accepted && !error;

          results[message.index] = {
            success,
            channel: "email",
            provider: "postmark",
            recipient: message.recipient,
            messageId: success ? message.correlationMessageId : undefined,
            acceptedAt: response.SubmittedAt || undefined,
            providerMessageStatus: response.Status || undefined,
            ...(error ? { error } : {}),
          };
        }
      } catch (error) {
        const errorMessage = normalizeError(error);
        if (isPostmarkBulkApprovalRequiredError(errorMessage)) {
          const fallbackResults =
            await sendPreparedBulkEmailMessagesIndividually({
              group,
              providerConfig,
            });

          for (const [groupIndex, message] of group.entries()) {
            results[message.index] = fallbackResults[groupIndex] || {
              success: false,
              channel: "email",
              provider: "postmark",
              recipient: message.recipient,
              error: "Email fallback send did not run",
            };
          }

          const fallbackErrors = fallbackResults
            .map(result => result.error)
            .filter((message): message is string => Boolean(message));
          if (fallbackErrors.length > 0) {
            groupErrors.push(...fallbackErrors);
          }
          continue;
        }

        groupErrors.push(errorMessage);
        for (const message of group) {
          results[message.index] = {
            success: false,
            channel: "email",
            provider: "postmark",
            recipient: message.recipient,
            error: errorMessage,
          };
        }
      }
    }

    const failed = results.filter(result => !result.success);
    const uniqueErrors = Array.from(
      new Set([
        ...groupErrors,
        ...failed
          .map(result => result.error)
          .filter((error): error is string => Boolean(error)),
      ])
    );

    return {
      success: results.every(result => result.success),
      channel: "email",
      provider: "postmark",
      results,
      ...(results.every(result => result.success)
        ? {}
        : {
            error:
              uniqueErrors.length > 0
                ? uniqueErrors.join("; ")
                : "One or more Postmark Bulk API requests failed",
          }),
    };
  } catch (error) {
    const errorMessage = normalizeError(error);
    return {
      success: false,
      channel: "email",
      provider: "postmark",
      results: request.messages.map(message => ({
        success: false,
        channel: "email",
        provider: "postmark",
        recipient: message.recipient.email,
        error: errorMessage,
      })),
      error: errorMessage,
    };
  }
}
