import { buildRawSourcePayload } from "../raw-source-payload";
export {
  normalizeWhatsAppMessageId,
  stripWhatsAppMessageIdPrefix,
  toWhatsAppGraphMessageId,
} from "./message-id";
import type { WhatsAppWebhookContactLike } from "./webhook-direction";

export function parseWhatsAppTimestamp(timestamp: string): Date {
  // Try parsing as Unix timestamp first (most common format)
  const unixTimestamp = parseInt(timestamp, 10);
  if (!isNaN(unixTimestamp) && unixTimestamp > 0) {
    // If it's a Unix timestamp in seconds, convert to milliseconds
    return new Date(unixTimestamp * 1000);
  }

  // Fall back to ISO string parsing
  const isoDate = new Date(timestamp);
  if (!isNaN(isoDate.getTime())) {
    return isoDate;
  }

  // If both fail, return current date as a defensive fallback.
  return new Date();
}

type WhatsAppHistoryStatus =
  | "DELIVERED"
  | "ERROR"
  | "PENDING"
  | "PLAYED"
  | "READ"
  | "SENT"
  | string;

interface WhatsAppHistoryContext {
  status?: WhatsAppHistoryStatus;
}

// Define types for the webhook payload for better type safety
// Export WhatsAppMessage so it can be used by message-processor
export interface WhatsAppMessage {
  id: string;
  from?: string;
  to?: string; // Present in echo messages - contains customer phone number
  from_user_id?: string;
  from_parent_user_id?: string;
  to_user_id?: string;
  to_parent_user_id?: string;
  group_id?: string;
  timestamp: string;
  type:
    | "text"
    | "button"
    | "interactive"
    | "image"
    | "video"
    | "audio"
    | "document"
    | "sticker"
    | "voice"
    | "edit"
    | "revoke"
    | "reaction"
    | "media_placeholder"
    | "location"
    | "contacts"
    | "order"
    | "system"
    | "errors"
    | "unsupported";

  // System message (identity/number changes, group events). Only `type:
  // "system"` inbound messages carry this payload.
  // @see https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/reference/messages#system-messages
  system?: {
    body?: string;
    type?: string; // "user_changed_number" | ...
    wa_id?: string;
    new_wa_id?: string;
    user_id?: string;
    customer?: string;
    identity?: string;
  };

  // History webhooks include message status context
  history_context?: WhatsAppHistoryContext;

  // Text message
  text?: {
    body: string;
  };

  // Template quick-reply button responses
  button?: {
    payload?: string;
    text?: string;
  };

  // Interactive messages (buttons, lists, flows)
  interactive?: {
    type?: "button_reply" | "list_reply" | "nfm_reply" | string;
    button_reply?: {
      id?: string;
      title?: string;
    };
    list_reply?: {
      id?: string;
      title?: string;
      description?: string;
    };
    nfm_reply?: {
      name?: string;
      body?: string;
      response_json?: string;
    };
  };

  // Media messages
  image?: {
    id: string;
    mime_type: string;
    sha256: string;
    caption?: string;
  };
  video?: {
    id: string;
    mime_type: string;
    sha256: string;
    caption?: string;
  };
  audio?: {
    id: string;
    mime_type: string;
    sha256: string;
  };
  voice?: {
    id: string;
    mime_type: string;
    sha256: string;
  };
  document?: {
    id: string;
    mime_type: string;
    sha256: string;
    filename?: string;
    caption?: string;
  };
  sticker?: {
    id: string;
    mime_type: string;
    sha256: string;
  };

  // Reaction messages
  reaction?: {
    emoji?: string;
    message_id: string;
  };

  // Location pin - WhatsApp user shares their location or a place
  // @see https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/reference/messages/location/
  location?: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
    url?: string;
  };

  // Shared vCard contacts - WhatsApp user forwards contact card(s)
  // @see https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/reference/messages/contacts/
  contacts?: Array<{
    name?: {
      formatted_name?: string;
      first_name?: string;
      last_name?: string;
      middle_name?: string;
      suffix?: string;
      prefix?: string;
    };
    phones?: Array<{ phone?: string; type?: string; wa_id?: string }>;
    emails?: Array<{ email?: string; type?: string }>;
    urls?: Array<{ url?: string; type?: string }>;
    addresses?: Array<{
      street?: string;
      city?: string;
      state?: string;
      zip?: string;
      country?: string;
      country_code?: string;
      type?: string;
    }>;
    birthday?: string;
    org?: { company?: string; department?: string; title?: string };
  }>;

  // Click-to-WhatsApp ad attribution (only on the first inbound message
  // of a conversation triggered by a Meta ad).
  // @see https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/reference/messages/
  referral?: WhatsAppReferral;

  // Edit messages (best-effort support based on webhook payloads)
  edit?: {
    message_id?: string;
    original_message_id?: string;
    message?: {
      context?: {
        id?: string;
      };
      type?: WhatsAppMessage["type"];
      text?: {
        body: string;
      };
      image?: {
        caption?: string;
        mime_type?: string;
        sha256?: string;
        id?: string;
        url?: string;
      };
      video?: {
        caption?: string;
        mime_type?: string;
        sha256?: string;
        id?: string;
        url?: string;
      };
      document?: {
        caption?: string;
        mime_type?: string;
        sha256?: string;
        id?: string;
        url?: string;
        filename?: string;
      };
    };
  };
  revoke?: {
    original_message_id?: string;
  };
  context?: {
    /**
     * Inbound webhook reply / product-context message id (wamid).
     * Meta wire name is `id` here — NOT `message_id`.
     * Outbound Graph send uses the inverse: `context.message_id`.
     * @see https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages/contextual-replies/
     * @see https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/text
     */
    id?: string;
    /** WhatsApp id (phone or BSUID-era identity) of the quoted message sender. */
    from?: string;
    /** Coexistence / username-era sender user id on the quoted message. */
    from_user_id?: string;
    /** Present when the inbound message was forwarded (no reply target id). */
    forwarded?: boolean;
    /** Present when forwarded more than 5 times. */
    frequently_forwarded?: boolean;
    referred_product?: {
      catalog_id?: string;
      product_retailer_id?: string;
    };
  };
  order?: {
    catalog_id?: string;
    text?: string;
    product_items?: Array<{
      product_retailer_id?: string;
      quantity?: number;
      item_price?: number;
      currency?: string;
    }>;
  };
  errors?: WhatsAppWebhookError[];
  unsupported?: {
    type?: string;
  };

  // Round videos (video notes) - may appear in unsupported messages or as video with specific metadata
  // WhatsApp sometimes sends round videos as unsupported but includes video data
}

export type WhatsAppContact = WhatsAppWebhookContactLike;

export interface WhatsAppWebhookError {
  code: number;
  title: string;
  message: string;
  error_data?: {
    details?: string;
  };
  href?: string;
}

export interface WhatsAppCallWebhookError {
  code?: number | string | null;
  title?: string | null;
  message?: string | null;
  details?: string | null;
  error_data?: {
    details?: string | null;
  } | null;
}

export interface WhatsAppReferral {
  source_url?: string;
  source_id?: string;
  source_type?: "ad" | "post" | string;
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  ad_set_id?: string;
  adset_name?: string;
  ad_set_name?: string;
  headline?: string;
  body?: string;
  media_type?: "image" | "video" | string;
  image_url?: string;
  video_url?: string;
  thumbnail_url?: string;
  ctwa_clid?: string;
  ref?: string;
  welcome_message?: { text?: string };
}

export interface WhatsAppStatusPricing {
  billable?: boolean;
  pricing_model?: "CBP" | "PMP" | string;
  type?:
    | "regular"
    | "free_customer_service"
    | "free_entry_point"
    | "free_tier"
    | string;
  category?:
    | "authentication"
    | "authentication-international"
    | "authentication_international"
    | "marketing"
    | "marketing_lite"
    | "referral_conversion"
    | "service"
    | "utility"
    | string;
}

export interface WhatsAppStatusConversation {
  id?: string;
  expiration_timestamp?: string | number;
  origin?: { type?: string };
}

export interface WhatsAppWebhookMetadata {
  phone_number_id?: string;
  display_phone_number?: string;
  cs_id?: string;
  messaging_account_id?: string;
  waac_id?: string;
}

export interface WhatsAppStatus {
  id: string;
  status: string;
  timestamp: string;
  type?: string;
  recipient_id?: string;
  recipient_user_id?: string;
  recipient_parent_user_id?: string;
  recipient_type?: string;
  recipient_participant_id?: string;
  errors?: WhatsAppWebhookError[];
  pricing?: WhatsAppStatusPricing;
  conversation?: WhatsAppStatusConversation;
  biz_opaque_callback_data?: string;
  recipient_identity_key_hash?: string;
  profile?: {
    name?: string;
    username?: string;
  };
}

export interface WhatsAppCall {
  id?: string;
  event?: string;
  direction?: string;
  from?: string;
  to?: string;
  from_user_id?: string;
  from_parent_user_id?: string;
  to_user_id?: string;
  to_parent_user_id?: string;
  timestamp?: string;
  status?: string;
  biz_opaque_callback_data?: string;
  session?: {
    sdp_type?: string;
    sdp?: string;
  };
  duration?: string | number;
  errors?: WhatsAppCallWebhookError[];
}

interface WhatsAppHistoryMetadata {
  phase?: 0 | 1 | 2;
  chunk_order?: number;
  progress?: number;
}

interface WhatsAppHistoryThreadContext {
  wa_id?: string;
  user_id?: string;
  parent_user_id?: string;
  username?: string;
}

interface WhatsAppHistoryThread {
  id?: string;
  context?: WhatsAppHistoryThreadContext;
  messages?: WhatsAppMessage[];
}

export interface WhatsAppHistoryEntry {
  metadata?: WhatsAppHistoryMetadata;
  threads?: WhatsAppHistoryThread[];
  errors?: WhatsAppWebhookError[];
  // Non-standard fallback - keep optional for resiliency
  messages?: WhatsAppMessage[];
  contacts?: WhatsAppContact[];
}

export interface WhatsAppHistoryValue {
  messaging_product?: "whatsapp";
  metadata?: WhatsAppWebhookMetadata;
  history?: WhatsAppHistoryEntry[] | WhatsAppHistoryEntry;
  messages?: WhatsAppMessage[];
  message_echoes?: WhatsAppMessage[];
  smb_message_echoes?: WhatsAppMessage[];
  contacts?: WhatsAppContact[];
}

export interface WhatsAppWebhookValue {
  messaging_product?: "whatsapp";
  metadata?: WhatsAppWebhookMetadata;
  messages?: WhatsAppMessage[];
  statuses?: WhatsAppStatus[];
  calls?: WhatsAppCall[];
  contacts?: WhatsAppContact[];
  message_echoes?: WhatsAppMessage[];
  smb_message_echoes?: WhatsAppMessage[];
  history?: WhatsAppHistoryEntry[] | WhatsAppHistoryEntry;
  // Allow additional fields (account_update, state_sync, etc.)
  // Defensive: Meta may add new top-level fields during BSUID rollout
  [key: string]: unknown;
}

export interface WhatsAppWebhookBody {
  object: string;
  entry: Array<{
    id?: string;
    changes: Array<{
      field?: string;
      value: WhatsAppWebhookValue;
    }>;
  }>;
}

type WhatsAppWebhookEntry = WhatsAppWebhookBody["entry"][number];
export type WhatsAppWebhookChange = WhatsAppWebhookEntry["changes"][number];
type WhatsAppMessageContainerKey =
  | "messages"
  | "message_echoes"
  | "smb_message_echoes";

export function buildWhatsAppMessageRawSourcePayload(params: {
  body: WhatsAppWebhookBody;
  entry: WhatsAppWebhookEntry;
  change: WhatsAppWebhookChange;
  value: WhatsAppWebhookValue;
  messageData: WhatsAppMessage;
  sourceId: string;
  direction: "inbound" | "outbound";
  capturedAt: Date;
  eventType?: string;
  messageContainerKey?: WhatsAppMessageContainerKey;
}) {
  const {
    body,
    entry,
    change,
    value,
    messageData,
    sourceId,
    direction,
    capturedAt,
    eventType = "message",
    messageContainerKey = "messages",
  } = params;
  const valueRest = { ...value } as Record<string, unknown>;
  delete valueRest.messages;
  delete valueRest.message_echoes;
  delete valueRest.smb_message_echoes;
  delete valueRest.history;

  return buildRawSourcePayload({
    provider: "whatsapp",
    eventType,
    capturedAt,
    payload: {
      object: body.object,
      entry: {
        id: entry.id || null,
        changes: [
          {
            field: change.field || null,
            value: {
              ...valueRest,
              [messageContainerKey]: [messageData],
            },
          },
        ],
      },
      sourceId,
      phoneNumberId: value.metadata?.phone_number_id || null,
      direction,
    },
  });
}
