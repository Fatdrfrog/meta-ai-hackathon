import type { TelegramStoredMessageMeta } from "./telegram";
import type { WhatsAppStoredMessageMeta } from "./whatsapp-message-meta";

export type StoredMessageMediaType =
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "voice"
  | "file";

export interface StoredWhatsAppFlowFieldOptionPreview {
  id: string;
  title: string;
}

export interface StoredWhatsAppFlowFieldMetadataPreview {
  id: string;
  label?: string | null;
  helperText?: string | null;
  screenTitle?: string | null;
  options?: StoredWhatsAppFlowFieldOptionPreview[] | null;
  /** The Flow field type, such as "DatePicker"; absent on older sends. */
  fieldType?: string | null;
}

export interface StoredWhatsAppFlowPreview {
  flowId?: string | null;
  flowToken?: string | null;
  flowCta?: string | null;
  headerText?: string | null;
  bodyText?: string | null;
  footerText?: string | null;
  responseFieldMetadata?: StoredWhatsAppFlowFieldMetadataPreview[] | null;
  flowActionType?: "navigate" | "data_exchange" | null;
  flowActionPayload?: Record<string, unknown> | null;
  scenarioId?: string | null;
  scenarioName?: string | null;
  actionNodeId?: string | null;
  status?: "sent" | "read" | "submitted" | null;
  responseJson?: string | null;
}

export interface StoredWhatsAppFlowReplyPreview {
  flowName?: string | null;
  flowToken?: string | null;
  body?: string | null;
  responseJson?: string | null;
  /** Safe read-model summary; raw responseJson is intentionally omitted. */
  responseFieldCount?: number | null;
  responseSubmitted?: boolean | null;
}

export interface StoredWhatsAppTemplateButtonPreview {
  type: "quick_reply" | "url" | "phone" | "flow" | "request_contact_info";
  text: string;
  value?: string | null;
  flowId?: string | null;
  flowAction?: "navigate" | "data_exchange" | null;
}

export interface StoredWhatsAppTemplatePreview {
  name?: string | null;
  languageCode?: string | null;
  headerText?: string | null;
  bodyText?: string | null;
  footerText?: string | null;
  buttons?: StoredWhatsAppTemplateButtonPreview[] | null;
}

export interface StoredWhatsAppCtaLinkPreview {
  title?: string | null;
  url?: string | null;
}

/**
 * The `whatsappServiceMessage` preview stored on an outbound WhatsApp message.
 * The scenario compiler writes it with a typed send command
 * (`WhatsAppServiceMessagePreview` in scenario-contracts); stored documents are
 * read back with the command untyped.
 */
export interface StoredWhatsAppServiceMessagePreview<
  Command extends object = Record<string, unknown>,
> {
  version: number;
  kind: string;
  bodyText?: string | null;
  command?: Command | null;
}

export interface GroundedReplyOption {
  id: string;
  callbackKey?: string | null;
  label: string;
  description?: string | null;
  selectionKind?: "offer" | "program" | "payment" | "product" | null;
  sourceKind: "snippet" | "kb" | "mixed";
  sourceIds: string[];
  sourceRecordId?: string | null;
  sourceDocumentId?: string | null;
  quotedPriceText?: string | null;
  quotedPriceAmount?: number | null;
  quotedPriceCurrency?: string | null;
}

export interface StoredGroundedReplyOptionsPreview {
  surface?:
    | "telegram_inline"
    | "whatsapp_button"
    | "whatsapp_list"
    | "text"
    | null;
  options?: GroundedReplyOption[] | null;
}

export interface StoredTelegramReplyMarkupButtonPreview {
  text: string;
  type: "callback" | "url";
  url?: string | null;
}

export interface StoredTelegramReplyMarkupPreview {
  inlineKeyboard?: StoredTelegramReplyMarkupButtonPreview[][] | null;
}

export interface StoredMessageEditMeta {
  editedAt?: Date | string | null;
  previousText?: string | null;
  editCount?: number | null;
  source?: "whatsapp_webhook" | "instagram_webhook" | "manager" | null;
  kind?: "edit" | "revoke" | null;
}

export interface RequestConversationMessageAuthor {
  _id?: string | number;
  firstName?: string;
  lastName?: string;
  username?: string;
  avatar_url?: string;
  isBot?: boolean;
}

export interface RequestConversationMessage {
  text?: string;
  date?: Date | string;
  direction?: string;
  mediaType?: StoredMessageMediaType | null;
  mimeType?: string | null;
  fileName?: string | null;
  whatsappFlow?: StoredWhatsAppFlowPreview | null;
  whatsappFlowReply?: StoredWhatsAppFlowReplyPreview | null;
  whatsappTemplate?: StoredWhatsAppTemplatePreview | null;
  whatsappServiceMessage?: StoredWhatsAppServiceMessagePreview | null;
  whatsappCtaLink?: StoredWhatsAppCtaLinkPreview | null;
  groundedReplyOptions?: StoredGroundedReplyOptionsPreview | null;
  telegramReplyMarkup?: StoredTelegramReplyMarkupPreview | null;
  editMeta?: StoredMessageEditMeta | null;
  author?: RequestConversationMessageAuthor;
  telegramMeta?: TelegramStoredMessageMeta | null;
  whatsappMeta?: WhatsAppStoredMessageMeta | null;
}
