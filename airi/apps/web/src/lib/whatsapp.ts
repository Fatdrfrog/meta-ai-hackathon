import {
  CUSTOMER_MEDIA_PROVIDER_TTL_SECONDS,
  resolveCustomerMediaReadUrl,
} from "@/lib/media/customer-media-read-url";
import { htmlToWhatsAppFormat } from "@/lib/whatsapp-format";
import {
  buildWhatsAppInteractiveFlowPayload,
  type WhatsAppFlowMode,
} from "@/lib/whatsapp/interactive-flow-payload";
import {
  type WhatsAppSendResponseBody,
  type WhatsAppTemplateSendComponentInput,
} from "@/lib/whatsapp/templates/message-types";
import {
  buildWhatsAppTemplateParameterMismatchMessage,
  buildWhatsAppTemplateSendPayload,
  isWhatsAppTemplateParameterMismatch,
  redactWhatsAppTemplatePayload,
  type WhatsAppTemplateDeliveryProduct,
  type WhatsAppTemplateSendOptions,
} from "@/lib/whatsapp/templates/send-payload";
import {
  MetaGraphRequestError,
  getWhatsAppGraphClient,
} from "@icecore/shared/lib/meta/api";
import {
  normalizeWhatsAppPhone,
  parseWhatsAppRecipientTarget,
  type WhatsAppRecipientTarget,
} from "@icecore/shared/lib/whatsapp/contact-identities";
import { toWhatsAppGraphMessageId } from "@icecore/shared/lib/whatsapp/message-id";
import type { WhatsAppFlowActionType } from "@icecore/shared/types/whatsapp";
import { pickWhatsAppInteractiveFlowIdentity } from "@icecore/shared/types/whatsapp-flows";
import { WHATSAPP_SERVICE_MESSAGE_LIMITS } from "@icecore/scenario-contracts";

const graphClient = getWhatsAppGraphClient();

function extractMessageResult(sent: WhatsAppSendResponseBody) {
  const message = sent?.messages?.[0];
  const messageId = message?.id?.trim();
  if (!messageId) {
    throw new Error(
      "WhatsApp API accepted response did not include messages[0].id"
    );
  }
  const dateSec = Number(message?.timestamp) || Math.floor(Date.now() / 1000);
  return {
    messageId,
    date: dateSec,
    status: sent?.status,
    messageStatus: message?.message_status,
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof MetaGraphRequestError) {
    return error.formattedError?.message || error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

const WHATSAPP_BSUID_SEND_ENABLED =
  String(process.env.WHATSAPP_BSUID_SEND_ENABLED || "").toLowerCase() ===
  "true";

export type { WhatsAppRecipientTarget, WhatsAppTemplateDeliveryProduct };

type WhatsAppRecipientInput = WhatsAppRecipientTarget | string;

export type WhatsAppContactMessageContact = {
  name: {
    formatted_name: string;
    first_name?: string;
    last_name?: string;
  };
  org?: {
    company?: string;
    title?: string;
  };
  phones?: Array<{
    phone: string;
    type?: string;
    wa_id?: string;
  }>;
  emails?: Array<{
    email: string;
    type?: string;
  }>;
  urls?: Array<{
    url: string;
    type?: string;
  }>;
};

export type WhatsAppLocationMessageLocation = {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
};

const WHATSAPP_LINK_PREVIEW_URL_REGEX = /(^|\s)https?:\/\/[^\s<>"']+/i;

function shouldRequestWhatsAppLinkPreview(text: string) {
  return WHATSAPP_LINK_PREVIEW_URL_REGEX.test(text);
}

type WhatsAppRecipientResolutionOptions = {
  context:
    | "message"
    | "template"
    | "media"
    | "interactive_flow"
    | "interactive_cta"
    | "interactive_carousel"
    | "interactive_catalog"
    | "location_request"
    | "request_contact_info"
    | "voice_call";
  requirePhone?: boolean;
};

export function normalizeWhatsappRecipient(raw: string): string {
  return normalizeWhatsAppPhone(raw) || "";
}

function resolveRecipientTarget(
  recipient: WhatsAppRecipientInput
): WhatsAppRecipientTarget {
  const resolved = parseWhatsAppRecipientTarget(recipient);
  if (!resolved) {
    throw new Error("WhatsApp recipient is missing or invalid");
  }
  return resolved;
}

function resolveGraphRecipient(
  recipient: WhatsAppRecipientInput,
  options: WhatsAppRecipientResolutionOptions
): string {
  const target = resolveRecipientTarget(recipient);
  const operation =
    options.context === "interactive_flow"
      ? "interactive flow message"
      : options.context === "interactive_cta"
        ? "interactive CTA message"
        : options.context === "interactive_catalog"
          ? "interactive catalog message"
          : options.context;

  if (options.requirePhone && target.kind !== "phone") {
    throw new Error(
      `This WhatsApp ${operation} requires a phone number recipient. Request the customer phone number before sending.`
    );
  }

  if (target.kind === "phone") {
    return normalizeWhatsappRecipient(target.value);
  }

  if (!WHATSAPP_BSUID_SEND_ENABLED) {
    console.warn("[WhatsApp] bsuid_send_blocked", {
      recipientKind: target.kind,
      context: options.context,
    });
    throw new Error(
      `This WhatsApp ${operation} target only has a BSUID. Ask the customer for their phone number or wait until WHATSAPP_BSUID_SEND_ENABLED is available for your rollout.`
    );
  }

  return target.value.trim();
}

/**
 * Send a WhatsApp template message (for messages outside 24-hour window)
 * @param phoneNumberId - WhatsApp phone number ID
 * @param accessToken - Access token
 * @param to - Recipient phone number
 * @param templateName - Name of the approved template
 * @param languageCode - Language code (e.g., 'en', 'ru', 'kz')
 * @param components - Template components with variables (optional)
 */
export async function sendWhatsappTemplate(
  phoneNumberId: string,
  accessToken: string,
  recipient: WhatsAppRecipientInput,
  templateName: string,
  languageCode: string = "en",
  components?: WhatsAppTemplateSendComponentInput[],
  options?: WhatsAppTemplateSendOptions
) {
  const normalizedTo = resolveGraphRecipient(recipient, {
    context: "template",
    requirePhone: options?.requirePhoneRecipient,
  });

  const { payload, sendEndpoint, deliveryProduct } =
    await buildWhatsAppTemplateSendPayload({
      phoneNumberId,
      accessToken,
      to: normalizedTo,
      templateName,
      languageCode,
      components,
      options,
    });

  await options?.beforeSend?.();

  try {
    const response = await graphClient.postJson<WhatsAppSendResponseBody>(
      sendEndpoint,
      {
        token: accessToken,
        body: payload,
      }
    );

    if (response?.error) {
      throw new Error(response.error.message || "WhatsApp Template API error");
    }

    return {
      ...extractMessageResult(response),
      deliveryProduct,
    };
  } catch (error) {
    if (error instanceof MetaGraphRequestError) {
      const errorDetails =
        typeof error.details === "object" && error.details
          ? ((error.details as { error?: WhatsAppSendResponseBody["error"] })
              .error ?? undefined)
          : undefined;
      const code = errorDetails?.code;
      const msg =
        errorDetails?.message ||
        error.formattedError?.message ||
        error.message ||
        "WhatsApp Template API error";
      const isParamMismatch = isWhatsAppTemplateParameterMismatch({
        code,
        message: msg,
      });

      if (isParamMismatch) {
        const details = errorDetails?.error_data?.details ?? "";
        error.message = buildWhatsAppTemplateParameterMismatchMessage(
          templateName,
          details
        );
        throw error;
      }

      const details = errorDetails?.error_data?.details ?? "";
      const userTitle = errorDetails?.error_user_title ?? "";
      const userMessage = errorDetails?.error_user_msg ?? "";
      console.error("[WhatsApp] template_send_failed", {
        templateName,
        languageCode,
        code,
        subcode: errorDetails?.error_subcode,
        details: options?.redactTemplatePayloadInLogs ? "[redacted]" : details,
        userTitle: options?.redactTemplatePayloadInLogs
          ? "[redacted]"
          : userTitle,
        userMessage: options?.redactTemplatePayloadInLogs
          ? "[redacted]"
          : userMessage,
        fbtraceId: errorDetails?.fbtrace_id,
        payload: options?.redactTemplatePayloadInLogs
          ? redactWhatsAppTemplatePayload(payload)
          : payload,
      });

      const parts = [msg, userTitle, userMessage, details].filter(
        part => typeof part === "string" && part.trim().length > 0
      );
      error.message = parts.join(" | ");
      throw error;
    }

    throw new Error(getErrorMessage(error));
  }
}

export async function sendWhatsappMessage(
  phoneNumberId: string,
  accessToken: string,
  recipient: WhatsAppRecipientInput,
  text: string,
  replyToMessageId?: string,
  options?: { previewUrl?: boolean; beforeSend?: () => Promise<void> }
) {
  const recipientAddress = resolveGraphRecipientAddress(recipient, {
    context: "message",
  });
  const normalizedReplyTo =
    typeof replyToMessageId === "string" ? replyToMessageId.trim() : "";
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    ...recipientAddress,
    type: "text",
    text: {
      body: text,
      ...((options?.previewUrl ?? shouldRequestWhatsAppLinkPreview(text))
        ? { preview_url: true }
        : {}),
    },
    ...(normalizedReplyTo
      ? { context: { message_id: normalizedReplyTo } }
      : {}),
  };

  await options?.beforeSend?.();

  try {
    const sent = await graphClient.postJson<WhatsAppSendResponseBody>(
      `${phoneNumberId}/messages`,
      {
        token: accessToken,
        body: payload,
      }
    );

    if (sent?.error) {
      throw new Error(sent.error.message || "WhatsApp API error");
    }

    return extractMessageResult(sent);
  } catch (error) {
    if (error instanceof MetaGraphRequestError) throw error;
    throw new Error(getErrorMessage(error));
  }
}

export async function sendWhatsappContacts(
  phoneNumberId: string,
  accessToken: string,
  recipient: WhatsAppRecipientInput,
  contacts: WhatsAppContactMessageContact[],
  replyToMessageId?: string
) {
  const recipientAddress = resolveGraphRecipientAddress(recipient, {
    context: "message",
  });
  const normalizedReplyTo =
    typeof replyToMessageId === "string" ? replyToMessageId.trim() : "";
  const normalizedContacts = contacts
    .filter(
      contact =>
        contact?.name?.formatted_name &&
        typeof contact.name.formatted_name === "string" &&
        contact.name.formatted_name.trim().length > 0
    )
    .map(contact => ({
      ...contact,
      name: {
        ...contact.name,
        formatted_name: contact.name.formatted_name.trim(),
      },
    }));

  if (normalizedContacts.length === 0) {
    throw new Error("WhatsApp contacts message requires a formatted name");
  }

  try {
    const sent = await graphClient.postJson<WhatsAppSendResponseBody>(
      `${phoneNumberId}/messages`,
      {
        token: accessToken,
        body: {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          ...recipientAddress,
          type: "contacts",
          contacts: normalizedContacts,
          ...(normalizedReplyTo
            ? { context: { message_id: normalizedReplyTo } }
            : {}),
        },
      }
    );

    if (sent?.error) {
      throw new Error(sent.error.message || "WhatsApp contacts API error");
    }

    return extractMessageResult(sent);
  } catch (error) {
    if (error instanceof MetaGraphRequestError) throw error;
    throw new Error(getErrorMessage(error));
  }
}

export async function sendWhatsappLocation(
  phoneNumberId: string,
  accessToken: string,
  recipient: WhatsAppRecipientInput,
  location: WhatsAppLocationMessageLocation,
  replyToMessageId?: string
) {
  const recipientAddress = resolveGraphRecipientAddress(recipient, {
    context: "message",
  });
  const normalizedReplyTo =
    typeof replyToMessageId === "string" ? replyToMessageId.trim() : "";
  const latitude = Number(location?.latitude);
  const longitude = Number(location?.longitude);

  if (
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new Error("WhatsApp location message requires valid coordinates");
  }

  const name =
    typeof location.name === "string" && location.name.trim()
      ? location.name.trim()
      : undefined;
  const address =
    typeof location.address === "string" && location.address.trim()
      ? location.address.trim()
      : undefined;

  try {
    const sent = await graphClient.postJson<WhatsAppSendResponseBody>(
      `${phoneNumberId}/messages`,
      {
        token: accessToken,
        body: {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          ...recipientAddress,
          type: "location",
          location: {
            latitude,
            longitude,
            ...(name ? { name } : {}),
            ...(address ? { address } : {}),
          },
          ...(normalizedReplyTo
            ? { context: { message_id: normalizedReplyTo } }
            : {}),
        },
      }
    );

    if (sent?.error) {
      throw new Error(sent.error.message || "WhatsApp location API error");
    }

    return extractMessageResult(sent);
  } catch (error) {
    if (error instanceof MetaGraphRequestError) throw error;
    throw new Error(getErrorMessage(error));
  }
}

export async function sendWhatsappTypingIndicator(
  phoneNumberId: string,
  accessToken: string,
  messageId: string
) {
  // Meta requires status=read for WhatsApp typing indicators; this sends a
  // customer-visible read receipt. Only call after a human/operator-owned flow
  // has actually handled the inbound message.
  const wamid = toWhatsAppGraphMessageId(messageId);
  if (!wamid) {
    throw new Error("WhatsApp message id is required for typing indicator");
  }

  try {
    const response = await graphClient.postJson<{
      success?: boolean;
      error?: { message?: string };
    }>(`${phoneNumberId}/messages`, {
      token: accessToken,
      body: {
        messaging_product: "whatsapp",
        status: "read",
        message_id: wamid,
        typing_indicator: { type: "text" },
      },
    });

    if (response?.error) {
      throw new Error(
        response.error.message || "WhatsApp typing indicator API error"
      );
    }

    return response;
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }
}

/**
 * Edit an outbound WhatsApp text message (Cloud API).
 * @see https://developers.facebook.com/documentation/business-messaging/whatsapp/cloud-api/guides/send-messages/
 */
export async function editWhatsappTextMessage(
  phoneNumberId: string,
  accessToken: string,
  recipient: WhatsAppRecipientInput,
  newText: string,
  editTargetWamid: string
) {
  const recipientAddress = resolveGraphRecipientAddress(recipient, {
    context: "message",
  });
  const wamid = toWhatsAppGraphMessageId(editTargetWamid);
  if (!wamid) {
    throw new Error("WhatsApp message id is required to edit");
  }

  try {
    const sent = await graphClient.postJson<WhatsAppSendResponseBody>(
      `${phoneNumberId}/messages`,
      {
        token: accessToken,
        body: {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          ...recipientAddress,
          type: "text",
          text: { body: newText },
          edit: { message_id: wamid },
        },
      }
    );

    if (sent?.error) {
      throw new Error(sent.error.message || "WhatsApp API error");
    }

    return extractMessageResult(sent);
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }
}

export type WhatsAppMediaType =
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker";

export type WhatsAppInteractiveHeaderMedia = {
  type: Extract<WhatsAppMediaType, "image" | "video" | "document">;
  link: string;
  fileName?: string;
};

export type WhatsAppInteractiveHeader =
  | { type: "text"; text: string }
  | WhatsAppInteractiveHeaderMedia;

function buildWhatsAppInteractiveHeaderMedia(
  media?: WhatsAppInteractiveHeaderMedia
):
  | {
      type: "image";
      image: { link: string };
    }
  | {
      type: "video";
      video: { link: string };
    }
  | {
      type: "document";
      document: { link: string; filename?: string };
    }
  | undefined {
  const link = media?.link?.trim();
  if (!media || !link) return undefined;

  if (media.type === "document") {
    const fileName = media.fileName?.trim();
    return {
      type: "document",
      document: {
        link,
        ...(fileName ? { filename: fileName.slice(0, 240) } : {}),
      },
    };
  }

  if (media.type === "video") {
    return {
      type: "video",
      video: { link },
    };
  }

  return {
    type: "image",
    image: { link },
  };
}

function buildWhatsAppInteractiveHeader(
  header?: WhatsAppInteractiveHeader
):
  | { type: "text"; text: string }
  | ReturnType<typeof buildWhatsAppInteractiveHeaderMedia> {
  if (!header) return undefined;
  if (header.type !== "text") {
    return buildWhatsAppInteractiveHeaderMedia(header);
  }

  const text = htmlToWhatsAppFormat(header.text)
    .trim()
    .slice(0, WHATSAPP_SERVICE_MESSAGE_LIMITS.header.text);
  return text ? { type: "text", text } : undefined;
}

function buildWhatsAppInteractiveFooter(footerText?: string) {
  const text = htmlToWhatsAppFormat(String(footerText || ""))
    .trim()
    .slice(0, WHATSAPP_SERVICE_MESSAGE_LIMITS.footer.text);
  return text ? { text } : undefined;
}

function resolveGraphRecipientAddress(
  recipient: WhatsAppRecipientInput,
  options: WhatsAppRecipientResolutionOptions
): { to: string } | { recipient: string } {
  const target = resolveRecipientTarget(recipient);
  const value = resolveGraphRecipient(target, options);
  return target.kind === "phone" ? { to: value } : { recipient: value };
}

async function sendWhatsappInteractivePayload(
  phoneNumberId: string,
  accessToken: string,
  recipient: WhatsAppRecipientInput,
  context: WhatsAppRecipientResolutionOptions["context"],
  interactive: Record<string, unknown>,
  errorMessage: string
) {
  const recipientAddress = resolveGraphRecipientAddress(recipient, { context });

  try {
    const sent = await graphClient.postJson<WhatsAppSendResponseBody>(
      `${phoneNumberId}/messages`,
      {
        token: accessToken,
        body: {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          ...recipientAddress,
          type: "interactive",
          interactive,
        },
      }
    );

    if (sent?.error) {
      throw new Error(sent.error.message || errorMessage);
    }

    return extractMessageResult(sent);
  } catch (error) {
    if (error instanceof MetaGraphRequestError) throw error;
    throw new Error(getErrorMessage(error));
  }
}

export async function sendWhatsappMedia(
  phoneNumberId: string,
  accessToken: string,
  recipient: WhatsAppRecipientInput,
  media: {
    type: WhatsAppMediaType;
    link?: string;
    id?: string;
    caption?: string;
    fileName?: string;
    /** WhatsApp voice note (`audio.voice: true`). Only applied for type audio. */
    voice?: boolean;
  },
  replyToMessageId?: string
) {
  const recipientAddress = resolveGraphRecipientAddress(recipient, {
    context: "media",
  });
  const normalizedReplyTo =
    typeof replyToMessageId === "string" ? replyToMessageId.trim() : "";
  const mediaId = media.id?.trim();
  const mediaLink = media.link?.trim();

  if (!mediaId && !mediaLink) {
    throw new Error("WhatsApp media requires either an id or a link");
  }

  // Meta downloads a linked file when it sends the message.
  const mediaBody: Record<string, unknown> = mediaId
    ? { id: mediaId }
    : {
        link: await resolveCustomerMediaReadUrl(
          mediaLink,
          CUSTOMER_MEDIA_PROVIDER_TTL_SECONDS
        ),
      };
  if (media.type === "audio" && media.voice === true) {
    mediaBody.voice = true;
  }

  const payload: Record<string, unknown> = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    ...recipientAddress,
    type: media.type,
    [media.type]: mediaBody,
  };

  if (
    media.caption &&
    (media.type === "image" ||
      media.type === "video" ||
      media.type === "document")
  ) {
    (payload[media.type] as Record<string, unknown>).caption = media.caption;
  }

  if (media.fileName && media.type === "document") {
    (payload.document as Record<string, unknown>).filename = media.fileName;
  }
  if (normalizedReplyTo) {
    payload.context = { message_id: normalizedReplyTo };
  }

  try {
    const sent = await graphClient.postJson<WhatsAppSendResponseBody>(
      `${phoneNumberId}/messages`,
      {
        token: accessToken,
        body: payload,
      }
    );

    if (sent?.error) {
      throw new Error(sent.error.message || "WhatsApp media API error");
    }

    return extractMessageResult(sent);
  } catch (error) {
    if (error instanceof MetaGraphRequestError) throw error;
    throw new Error(getErrorMessage(error));
  }
}

/**
 * Send WhatsApp interactive Flow CTA message.
 * @see https://developers.facebook.com/docs/whatsapp/flows/reference/flowjson
 */
export async function sendWhatsappInteractiveFlow(
  phoneNumberId: string,
  accessToken: string,
  recipient: WhatsAppRecipientInput,
  params: {
    flowId?: string;
    flowName?: string;
    mode?: WhatsAppFlowMode;
    flowToken?: string;
    flowCta?: string;
    bodyText?: string;
    headerText?: string;
    footerText?: string;
    flowActionType?: WhatsAppFlowActionType;
    flowActionPayload?: Record<string, unknown>;
  }
) {
  const recipientAddress = resolveGraphRecipientAddress(recipient, {
    context: "interactive_flow",
  });
  const identity = pickWhatsAppInteractiveFlowIdentity({
    flow_id: params.flowId,
    flow_name: params.flowName,
  });
  if (!identity) {
    throw new Error(
      "flow_id or flow_name is required for WhatsApp Flow message"
    );
  }

  const flowTokenRaw = String(params.flowToken || "").trim();
  const flowToken =
    flowTokenRaw ||
    `flow_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const interactivePayload = buildWhatsAppInteractiveFlowPayload({
    flowId: identity.kind === "flow_id" ? identity.flow_id : undefined,
    flowName: identity.kind === "flow_name" ? identity.flow_name : undefined,
    mode: params.mode,
    flowToken,
    flowCta: params.flowCta,
    bodyText: params.bodyText,
    headerText: params.headerText,
    footerText: params.footerText,
    flowActionType: params.flowActionType,
    flowActionPayload:
      params.flowActionPayload && typeof params.flowActionPayload === "object"
        ? params.flowActionPayload
        : undefined,
  });

  try {
    const sent = await graphClient.postJson<WhatsAppSendResponseBody>(
      `${phoneNumberId}/messages`,
      {
        token: accessToken,
        body: {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          ...recipientAddress,
          type: "interactive",
          interactive: interactivePayload,
        },
      }
    );

    if (sent?.error) {
      throw new Error(
        sent.error.message || "WhatsApp Flow interactive API error"
      );
    }

    return extractMessageResult(sent);
  } catch (error) {
    if (error instanceof MetaGraphRequestError) throw error;
    throw new Error(getErrorMessage(error));
  }
}

/**
 * Send WhatsApp interactive CTA URL button message (like templates).
 * Renders a proper button instead of inline link text.
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-cta-url-messages
 */
export async function sendWhatsappInteractiveCtaUrl(
  phoneNumberId: string,
  accessToken: string,
  recipient: WhatsAppRecipientInput,
  bodyText: string,
  buttonUrl: string,
  buttonLabel: string,
  headerMedia?: WhatsAppInteractiveHeaderMedia
) {
  return sendWhatsappInteractiveCtaUrlMessage(
    phoneNumberId,
    accessToken,
    recipient,
    {
      bodyText,
      buttonUrl,
      buttonLabel,
      ...(headerMedia ? { header: headerMedia } : {}),
    }
  );
}

export async function sendWhatsappInteractiveCtaUrlMessage(
  phoneNumberId: string,
  accessToken: string,
  recipient: WhatsAppRecipientInput,
  params: {
    bodyText: string;
    buttonUrl: string;
    buttonLabel: string;
    header?: WhatsAppInteractiveHeader;
    footerText?: string;
  }
) {
  const header = buildWhatsAppInteractiveHeader(params.header);
  const footer = buildWhatsAppInteractiveFooter(params.footerText);
  const interactive = {
    type: "cta_url",
    ...(header ? { header } : {}),
    body: {
      text: htmlToWhatsAppFormat(params.bodyText).slice(
        0,
        WHATSAPP_SERVICE_MESSAGE_LIMITS.body.interactive
      ),
    },
    ...(footer ? { footer } : {}),
    action: {
      name: "cta_url",
      parameters: {
        display_text: params.buttonLabel
          .trim()
          .slice(0, WHATSAPP_SERVICE_MESSAGE_LIMITS.button.label),
        url: params.buttonUrl.trim(),
      },
    },
  };

  return sendWhatsappInteractivePayload(
    phoneNumberId,
    accessToken,
    recipient,
    "interactive_cta",
    interactive,
    "WhatsApp CTA URL API error"
  );
}

export async function sendWhatsappInteractiveReplyButtons(
  phoneNumberId: string,
  accessToken: string,
  recipient: WhatsAppRecipientInput,
  bodyText: string,
  buttons: Array<{ id: string; title: string }>,
  headerMedia?: WhatsAppInteractiveHeaderMedia
) {
  return sendWhatsappInteractiveReplyButtonsMessage(
    phoneNumberId,
    accessToken,
    recipient,
    {
      bodyText,
      buttons,
      ...(headerMedia ? { header: headerMedia } : {}),
    }
  );
}

export async function sendWhatsappInteractiveReplyButtonsMessage(
  phoneNumberId: string,
  accessToken: string,
  recipient: WhatsAppRecipientInput,
  params: {
    bodyText: string;
    buttons: Array<{ id: string; title: string }>;
    header?: WhatsAppInteractiveHeader;
    footerText?: string;
  }
) {
  const normalizedButtons = params.buttons
    .map(button => ({
      id: String(button.id || "")
        .trim()
        .slice(0, WHATSAPP_SERVICE_MESSAGE_LIMITS.button.replyId),
      title: String(button.title || "")
        .trim()
        .slice(0, WHATSAPP_SERVICE_MESSAGE_LIMITS.button.label),
    }))
    .filter(button => button.id && button.title)
    .slice(0, WHATSAPP_SERVICE_MESSAGE_LIMITS.replyButtons.max);

  if (normalizedButtons.length === 0) {
    throw new Error("WhatsApp reply buttons require at least one option");
  }
  const header = buildWhatsAppInteractiveHeader(params.header);
  const footer = buildWhatsAppInteractiveFooter(params.footerText);

  return sendWhatsappInteractivePayload(
    phoneNumberId,
    accessToken,
    recipient,
    "interactive_cta",
    {
      type: "button",
      ...(header ? { header } : {}),
      body: {
        text: htmlToWhatsAppFormat(params.bodyText).slice(
          0,
          WHATSAPP_SERVICE_MESSAGE_LIMITS.body.interactive
        ),
      },
      ...(footer ? { footer } : {}),
      action: {
        buttons: normalizedButtons.map(button => ({
          type: "reply",
          reply: button,
        })),
      },
    },
    "WhatsApp reply buttons API error"
  );
}

export async function sendWhatsappInteractiveList(
  phoneNumberId: string,
  accessToken: string,
  recipient: WhatsAppRecipientInput,
  bodyText: string,
  buttonText: string,
  rows: Array<{ id: string; title: string; description?: string }>,
  headerMedia?: WhatsAppInteractiveHeaderMedia
) {
  const normalizedRows = rows
    .map(row => ({
      id: String(row.id || "").trim(),
      title: String(row.title || "")
        .trim()
        .slice(0, WHATSAPP_SERVICE_MESSAGE_LIMITS.list.rowTitle),
      description:
        typeof row.description === "string" && row.description.trim()
          ? row.description
              .trim()
              .slice(0, WHATSAPP_SERVICE_MESSAGE_LIMITS.list.rowDescription)
          : undefined,
    }))
    .filter(row => row.id && row.title)
    .slice(0, WHATSAPP_SERVICE_MESSAGE_LIMITS.list.rows.max);

  if (normalizedRows.length === 0) {
    throw new Error("WhatsApp interactive list requires at least one row");
  }
  const header = buildWhatsAppInteractiveHeaderMedia(headerMedia);

  return sendWhatsappInteractivePayload(
    phoneNumberId,
    accessToken,
    recipient,
    "interactive_cta",
    {
      type: "list",
      ...(header ? { header } : {}),
      body: {
        text: htmlToWhatsAppFormat(bodyText).slice(
          0,
          WHATSAPP_SERVICE_MESSAGE_LIMITS.body.interactive
        ),
      },
      action: {
        button:
          buttonText
            .trim()
            .slice(0, WHATSAPP_SERVICE_MESSAGE_LIMITS.button.label) ||
          "View options",
        sections: [{ rows: normalizedRows }],
      },
    },
    "WhatsApp list API error"
  );
}

export async function sendWhatsappInteractiveListMessage(
  phoneNumberId: string,
  accessToken: string,
  recipient: WhatsAppRecipientInput,
  params: {
    bodyText: string;
    buttonText: string;
    headerText?: string;
    footerText?: string;
    sections: Array<{
      title?: string;
      rows: Array<{ id: string; title: string; description?: string }>;
    }>;
  }
) {
  let rowCount = 0;
  const sections = params.sections
    .slice(0, WHATSAPP_SERVICE_MESSAGE_LIMITS.list.sections.max)
    .map(section => {
      const rows = section.rows
        .map(row => ({
          id: String(row.id || "")
            .trim()
            .slice(0, WHATSAPP_SERVICE_MESSAGE_LIMITS.list.rowId),
          title: String(row.title || "")
            .trim()
            .slice(0, WHATSAPP_SERVICE_MESSAGE_LIMITS.list.rowTitle),
          description:
            typeof row.description === "string" && row.description.trim()
              ? row.description
                  .trim()
                  .slice(0, WHATSAPP_SERVICE_MESSAGE_LIMITS.list.rowDescription)
              : undefined,
        }))
        .filter(row => row.id && row.title)
        .slice(
          0,
          Math.max(0, WHATSAPP_SERVICE_MESSAGE_LIMITS.list.rows.max - rowCount)
        );
      rowCount += rows.length;
      const title = String(section.title || "")
        .trim()
        .slice(0, WHATSAPP_SERVICE_MESSAGE_LIMITS.list.sectionTitle);
      return {
        ...(title ? { title } : {}),
        rows,
      };
    })
    .filter(section => section.rows.length > 0);

  if (rowCount === 0) {
    throw new Error("WhatsApp interactive list requires at least one row");
  }

  const headerText = htmlToWhatsAppFormat(String(params.headerText || ""))
    .trim()
    .slice(0, WHATSAPP_SERVICE_MESSAGE_LIMITS.header.text);
  const footer = buildWhatsAppInteractiveFooter(params.footerText);

  return sendWhatsappInteractivePayload(
    phoneNumberId,
    accessToken,
    recipient,
    "interactive_cta",
    {
      type: "list",
      ...(headerText ? { header: { type: "text", text: headerText } } : {}),
      body: {
        text: htmlToWhatsAppFormat(params.bodyText).slice(
          0,
          WHATSAPP_SERVICE_MESSAGE_LIMITS.body.text
        ),
      },
      ...(footer ? { footer } : {}),
      action: {
        button:
          params.buttonText
            .trim()
            .slice(0, WHATSAPP_SERVICE_MESSAGE_LIMITS.button.label) ||
          "View options",
        sections,
      },
    },
    "WhatsApp list API error"
  );
}

export type WhatsAppInteractiveCarouselCard = {
  media: {
    type: "image" | "video";
    link: string;
  };
  bodyText?: string;
  interaction:
    | {
        kind: "url";
        buttonLabel: string;
        url: string;
      }
    | {
        kind: "quick_replies";
        buttons: Array<{ id: string; title: string }>;
      };
};

export async function sendWhatsappInteractiveMediaCarousel(
  phoneNumberId: string,
  accessToken: string,
  recipient: WhatsAppRecipientInput,
  params: {
    bodyText: string;
    cards: WhatsAppInteractiveCarouselCard[];
  }
) {
  if (
    params.cards.length < WHATSAPP_SERVICE_MESSAGE_LIMITS.carousel.cards.min ||
    params.cards.length > WHATSAPP_SERVICE_MESSAGE_LIMITS.carousel.cards.max
  ) {
    throw new Error("WhatsApp media carousel requires 2 to 10 cards");
  }

  const cards = params.cards.map((card, cardIndex) => {
    const header = buildWhatsAppInteractiveHeaderMedia(card.media);
    if (!header) {
      throw new Error("WhatsApp media carousel cards require media");
    }
    const bodyText = htmlToWhatsAppFormat(String(card.bodyText || ""))
      .trim()
      .slice(0, WHATSAPP_SERVICE_MESSAGE_LIMITS.carousel.cardBody);

    if (card.interaction.kind === "url") {
      return {
        card_index: cardIndex,
        type: "cta_url",
        header,
        ...(bodyText ? { body: { text: bodyText } } : {}),
        action: {
          name: "cta_url",
          parameters: {
            display_text: card.interaction.buttonLabel
              .trim()
              .slice(0, WHATSAPP_SERVICE_MESSAGE_LIMITS.button.label),
            url: card.interaction.url.trim(),
          },
        },
      };
    }

    const buttons = card.interaction.buttons
      .map(button => ({
        id: String(button.id || "")
          .trim()
          .slice(0, WHATSAPP_SERVICE_MESSAGE_LIMITS.button.replyId),
        title: String(button.title || "")
          .trim()
          .slice(0, WHATSAPP_SERVICE_MESSAGE_LIMITS.button.label),
      }))
      .filter(button => button.id && button.title)
      .slice(0, WHATSAPP_SERVICE_MESSAGE_LIMITS.replyButtons.max);
    if (buttons.length === 0) {
      throw new Error(
        "WhatsApp media carousel quick replies require at least one option"
      );
    }

    return {
      card_index: cardIndex,
      // Meta's media-carousel contract uses cta_url for both card action forms.
      type: "cta_url",
      header,
      ...(bodyText ? { body: { text: bodyText } } : {}),
      action: {
        buttons: buttons.map(button => ({
          type: "quick_reply",
          quick_reply: button,
        })),
      },
    };
  });

  return sendWhatsappInteractivePayload(
    phoneNumberId,
    accessToken,
    recipient,
    "interactive_carousel",
    {
      type: "carousel",
      body: {
        text: htmlToWhatsAppFormat(params.bodyText).slice(
          0,
          WHATSAPP_SERVICE_MESSAGE_LIMITS.body.interactive
        ),
      },
      action: { cards },
    },
    "WhatsApp media carousel API error"
  );
}

export async function sendWhatsappLocationRequest(
  phoneNumberId: string,
  accessToken: string,
  recipient: WhatsAppRecipientInput,
  bodyText: string
) {
  return sendWhatsappInteractivePayload(
    phoneNumberId,
    accessToken,
    recipient,
    "location_request",
    {
      type: "location_request_message",
      body: {
        text: htmlToWhatsAppFormat(bodyText).slice(
          0,
          WHATSAPP_SERVICE_MESSAGE_LIMITS.body.interactive
        ),
      },
      action: { name: "send_location" },
    },
    "WhatsApp location request API error"
  );
}

export async function sendWhatsappVoiceCall(
  phoneNumberId: string,
  accessToken: string,
  recipient: WhatsAppRecipientInput,
  params: {
    bodyText: string;
    buttonLabel: string;
    ttlMinutes: number;
    payload: string;
  }
) {
  return sendWhatsappInteractivePayload(
    phoneNumberId,
    accessToken,
    recipient,
    "voice_call",
    {
      type: "voice_call",
      body: {
        text: htmlToWhatsAppFormat(params.bodyText).slice(
          0,
          WHATSAPP_SERVICE_MESSAGE_LIMITS.body.interactive
        ),
      },
      action: {
        name: "voice_call",
        parameters: {
          display_text: params.buttonLabel
            .trim()
            .slice(0, WHATSAPP_SERVICE_MESSAGE_LIMITS.button.label),
          ttl_minutes: Math.trunc(params.ttlMinutes),
          payload: params.payload.slice(
            0,
            WHATSAPP_SERVICE_MESSAGE_LIMITS.voice.payloadBytes
          ),
        },
      },
    },
    "WhatsApp voice call API error"
  );
}

type CatalogMessageRecipient = WhatsAppRecipientInput;

function normalizeCatalogText(value: string | undefined, limit: number) {
  const text = String(value || "").trim();
  return text ? htmlToWhatsAppFormat(text).slice(0, limit) : "";
}

function normalizeProductRetailerIds(ids: string[], limit: number) {
  return Array.from(
    new Set(ids.map(id => String(id).trim()).filter(Boolean))
  ).slice(0, limit);
}

function normalizeCatalogLinkPhone(value: string): string {
  return value.replace(/\D/g, "");
}

async function sendWhatsappInteractiveCatalogPayload(
  phoneNumberId: string,
  accessToken: string,
  recipient: CatalogMessageRecipient,
  interactive: Record<string, unknown>
) {
  const recipientAddress = resolveGraphRecipientAddress(recipient, {
    context: "interactive_catalog",
  });

  try {
    const sent = await graphClient.postJson<WhatsAppSendResponseBody>(
      `${phoneNumberId}/messages`,
      {
        token: accessToken,
        body: {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          ...recipientAddress,
          type: "interactive",
          interactive,
        },
      }
    );

    if (sent?.error) {
      throw new Error(sent.error.message || "WhatsApp catalog API error");
    }

    return extractMessageResult(sent);
  } catch (error) {
    if (error instanceof MetaGraphRequestError) throw error;
    throw new Error(getErrorMessage(error));
  }
}

export async function sendWhatsappCatalogMessage(
  phoneNumberId: string,
  accessToken: string,
  recipient: CatalogMessageRecipient,
  params: {
    bodyText: string;
    footerText?: string;
    thumbnailProductRetailerId?: string;
  }
) {
  const bodyText = normalizeCatalogText(
    params.bodyText,
    WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.body
  );
  if (!bodyText) throw new Error("Catalog message bodyText is required");
  const footerText = normalizeCatalogText(
    params.footerText,
    WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.footer
  );
  const thumbnailProductRetailerId = String(
    params.thumbnailProductRetailerId || ""
  ).trim();

  return sendWhatsappInteractiveCatalogPayload(
    phoneNumberId,
    accessToken,
    recipient,
    {
      type: "catalog_message",
      body: { text: bodyText },
      ...(footerText ? { footer: { text: footerText } } : {}),
      action: {
        name: "catalog_message",
        ...(thumbnailProductRetailerId
          ? {
              parameters: {
                thumbnail_product_retailer_id: thumbnailProductRetailerId,
              },
            }
          : {}),
      },
    }
  );
}

export async function sendWhatsappCatalogLinkMessage(
  phoneNumberId: string,
  accessToken: string,
  recipient: CatalogMessageRecipient,
  params: {
    businessPhoneNumber: string;
    bodyText: string;
  }
) {
  const phone = normalizeCatalogLinkPhone(params.businessPhoneNumber);
  if (!phone) throw new Error("businessPhoneNumber is required");
  const bodyText = normalizeCatalogText(params.bodyText, 900);
  const catalogLink = `https://wa.me/c/${phone}`;
  return sendWhatsappMessage(
    phoneNumberId,
    accessToken,
    recipient,
    [bodyText, catalogLink].filter(Boolean).join(" ")
  );
}

export async function sendWhatsappSingleProductMessage(
  phoneNumberId: string,
  accessToken: string,
  recipient: CatalogMessageRecipient,
  params: {
    catalogId: string;
    productRetailerId: string;
    bodyText?: string;
    footerText?: string;
  }
) {
  const catalogId = String(params.catalogId || "").trim();
  const productRetailerId = String(params.productRetailerId || "").trim();
  if (!catalogId) throw new Error("catalogId is required");
  if (!productRetailerId) throw new Error("productRetailerId is required");
  const bodyText = normalizeCatalogText(
    params.bodyText,
    WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.body
  );
  const footerText = normalizeCatalogText(
    params.footerText,
    WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.footer
  );

  return sendWhatsappInteractiveCatalogPayload(
    phoneNumberId,
    accessToken,
    recipient,
    {
      type: "product",
      ...(bodyText ? { body: { text: bodyText } } : {}),
      ...(footerText ? { footer: { text: footerText } } : {}),
      action: {
        catalog_id: catalogId,
        product_retailer_id: productRetailerId,
      },
    }
  );
}

export async function sendWhatsappMultiProductMessage(
  phoneNumberId: string,
  accessToken: string,
  recipient: CatalogMessageRecipient,
  params: {
    catalogId: string;
    headerText: string;
    bodyText: string;
    footerText?: string;
    sections: Array<{
      title: string;
      productRetailerIds: string[];
    }>;
  }
) {
  const catalogId = String(params.catalogId || "").trim();
  if (!catalogId) throw new Error("catalogId is required");
  const sections = params.sections
    .slice(
      0,
      WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.multiProduct.sections.max
    )
    .map(section => ({
      title: String(section.title || "")
        .trim()
        .slice(
          0,
          WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.multiProduct.sectionTitle
        ),
      product_items: normalizeProductRetailerIds(
        section.productRetailerIds || [],
        WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.multiProduct.products.max
      ).map(productRetailerId => ({
        product_retailer_id: productRetailerId,
      })),
    }))
    .filter(section => section.title && section.product_items.length > 0);
  const totalItems = sections.reduce(
    (count, section) => count + section.product_items.length,
    0
  );
  if (totalItems === 0) {
    throw new Error("Multi-product message requires at least one product");
  }
  if (
    totalItems >
    WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.multiProduct.products.max
  ) {
    throw new Error("Multi-product message supports at most 30 products");
  }

  const headerText = normalizeCatalogText(
    params.headerText,
    WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.header
  );
  const bodyText = normalizeCatalogText(
    params.bodyText,
    WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.body
  );
  const footerText = normalizeCatalogText(
    params.footerText,
    WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.footer
  );
  if (!headerText || !bodyText) {
    throw new Error("Multi-product message requires headerText and bodyText");
  }

  return sendWhatsappInteractiveCatalogPayload(
    phoneNumberId,
    accessToken,
    recipient,
    {
      type: "product_list",
      header: { type: "text", text: headerText },
      body: { text: bodyText },
      ...(footerText ? { footer: { text: footerText } } : {}),
      action: {
        catalog_id: catalogId,
        sections,
      },
    }
  );
}

export async function sendWhatsappProductCarouselMessage(
  phoneNumberId: string,
  accessToken: string,
  recipient: CatalogMessageRecipient,
  params: {
    bodyText: string;
    catalogId: string;
    productRetailerIds: string[];
  }
) {
  const catalogId = String(params.catalogId || "").trim();
  if (!catalogId) throw new Error("catalogId is required");
  const productRetailerIds = normalizeProductRetailerIds(
    params.productRetailerIds || [],
    WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.productCarousel.products.max
  );
  if (
    productRetailerIds.length <
    WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.productCarousel.products.min
  ) {
    throw new Error("Product carousel requires at least 2 products");
  }
  const bodyText = normalizeCatalogText(
    params.bodyText,
    WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.body
  );
  if (!bodyText) throw new Error("Product carousel bodyText is required");

  return sendWhatsappInteractiveCatalogPayload(
    phoneNumberId,
    accessToken,
    recipient,
    {
      type: "product_carousel",
      body: { text: bodyText },
      action: {
        cards: productRetailerIds.map((productRetailerId, index) => ({
          card_index: index,
          type: "product",
          product_retailer_id: productRetailerId,
          catalog_id: catalogId,
        })),
      },
    }
  );
}

/**
 * Send a WhatsApp REQUEST_CONTACT_INFO interactive message.
 *
 * When only a BSUID is known for a customer, this button asks them to
 * share their phone number so the business can send templates and
 * re-engage outside the 24-hour messaging window.
 *
 * @see https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids
 */
export async function sendWhatsappRequestContactInfo(
  phoneNumberId: string,
  accessToken: string,
  recipient: WhatsAppRecipientInput,
  bodyText: string = "Please share your phone number so we can stay in touch."
) {
  if (resolveRecipientTarget(recipient).kind !== "bsuid") {
    throw new Error("WhatsApp REQUEST_CONTACT_INFO requires a BSUID recipient");
  }

  return sendWhatsappInteractivePayload(
    phoneNumberId,
    accessToken,
    recipient,
    "request_contact_info",
    {
      type: "request_contact_info",
      body: {
        text: htmlToWhatsAppFormat(bodyText).slice(
          0,
          WHATSAPP_SERVICE_MESSAGE_LIMITS.body.interactive
        ),
      },
      action: { name: "request_contact_info" },
    },
    "WhatsApp REQUEST_CONTACT_INFO API error"
  );
}
