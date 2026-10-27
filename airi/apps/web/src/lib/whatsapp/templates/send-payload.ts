import { normalizePerMessageBidMultiplier } from "@/lib/whatsapp/marketing/message-pricing";
import { normalizeWhatsAppTemplateHeaderMediaComponents } from "@/lib/whatsapp/templates/header-media";
import {
  normalizeWhatsAppTemplateSendComponents,
  type WhatsAppTemplateMessagePayload,
  type WhatsAppTemplateSendComponentInput,
} from "@/lib/whatsapp/templates/message-types";

export type WhatsAppTemplateDeliveryProduct =
  | "cloud_api"
  | "marketing_messages";

export type WhatsAppTemplateSendOptions = {
  /** Runs after payload preparation, immediately before the message POST. */
  beforeSend?: () => Promise<void>;
  requirePhoneRecipient?: boolean;
  deliveryProduct?: WhatsAppTemplateDeliveryProduct;
  redactTemplatePayloadInLogs?: boolean;
  /**
   * Opaque string (<=512 bytes) Meta echoes back on every status webhook for
   * this message. Used by campaigns to avoid per-status Supabase lookups.
   */
  bizOpaqueCallbackData?: string | null;
  messagingAccountId?: string | null;
  perMessageBidMultiplier?: number | null;
};

export async function buildWhatsAppTemplateSendPayload(params: {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  templateName: string;
  languageCode: string;
  components?: WhatsAppTemplateSendComponentInput[];
  options?: WhatsAppTemplateSendOptions;
}): Promise<{
  payload: WhatsAppTemplateMessagePayload;
  sendEndpoint: string;
  deliveryProduct: WhatsAppTemplateDeliveryProduct;
}> {
  const normalizedComponents =
    await normalizeWhatsAppTemplateHeaderMediaComponents({
      components: normalizeWhatsAppTemplateSendComponents(params.components),
      phoneNumberId: params.phoneNumberId,
      accessToken: params.accessToken,
    });

  const payload: WhatsAppTemplateMessagePayload = {
    messaging_product: "whatsapp",
    to: params.to,
    type: "template",
    template: {
      name: params.templateName,
      language: {
        code: params.languageCode,
      },
    },
  };

  if (normalizedComponents && normalizedComponents.length > 0) {
    payload.template.components = normalizedComponents;
  }

  const callbackData =
    typeof params.options?.bizOpaqueCallbackData === "string"
      ? params.options.bizOpaqueCallbackData.trim()
      : "";
  if (callbackData) {
    payload.biz_opaque_callback_data = callbackData;
  }

  const messagingAccountId =
    typeof params.options?.messagingAccountId === "string"
      ? params.options.messagingAccountId.trim()
      : "";
  if (messagingAccountId) {
    payload.messaging_account_id = messagingAccountId;
  }

  const deliveryProduct: WhatsAppTemplateDeliveryProduct =
    params.options?.deliveryProduct === "marketing_messages"
      ? "marketing_messages"
      : "cloud_api";
  const perMessageBidMultiplier = normalizePerMessageBidMultiplier(
    params.options?.perMessageBidMultiplier
  );
  if (!perMessageBidMultiplier.ok) {
    throw new Error(perMessageBidMultiplier.error);
  }
  if (perMessageBidMultiplier.value !== undefined) {
    if (deliveryProduct !== "marketing_messages") {
      throw new Error(
        "perMessageBidMultiplier is only supported for WhatsApp Marketing Messages API sends"
      );
    }
    payload.per_message_bid_multiplier = perMessageBidMultiplier.value;
  }

  return {
    payload,
    deliveryProduct,
    sendEndpoint:
      deliveryProduct === "marketing_messages"
        ? `${params.phoneNumberId}/marketing_messages`
        : `${params.phoneNumberId}/messages`,
  };
}

export function redactWhatsAppTemplatePayload(payload: unknown): unknown {
  return JSON.parse(
    JSON.stringify(payload, (key, value) => {
      if (key === "to") return "[redacted_recipient]";
      if (key === "parameters") return "[redacted_parameters]";
      if (key === "biz_opaque_callback_data") return "[redacted_callback]";
      if (typeof value === "string" && /^\d{4,8}$/.test(value)) {
        return "[redacted_code]";
      }
      return value;
    })
  );
}

export function isWhatsAppTemplateParameterMismatch(params: {
  code?: number;
  message?: string;
}): boolean {
  const msg = params.message || "";
  return (
    params.code === 132000 ||
    params.code === 132012 ||
    msg.includes("132000") ||
    msg.includes("132012") ||
    msg.includes("parameters does not match") ||
    msg.includes("component parameter")
  );
}

export function buildWhatsAppTemplateParameterMismatchMessage(
  templateName: string,
  details?: string
): string {
  const hint =
    `Template "${templateName}" requires non-empty component parameters. ` +
    `Send a "components" array with "parameters" for each placeholder or media header (e.g. body, header, button). ` +
    `Each {{1}}, {{2}}, etc. needs a corresponding { "type": "text", "text": "value" }.`;
  return details ? `${hint} WhatsApp: ${details}` : hint;
}
