import type {
  ScenarioActionAttachmentMediaType,
  ScenarioWhatsAppServiceMessageKind,
} from "@icecore/scenario-contracts";

/**
 * One name per message kind, on the node card and in the builder. Kinds that
 * the add menu offers use the menu's own key.
 */
export const WHATSAPP_SERVICE_MESSAGE_KIND_LABEL_KEYS: Record<
  ScenarioWhatsAppServiceMessageKind,
  string
> = {
  text: "whatsappServiceFormatText",
  media: "whatsappServiceFormatMedia",
  reply_buttons: "whatsappServiceFormatReplyButtons",
  list: "whatsappServiceFormatList",
  cta_url: "whatsappServiceFormatUrl",
  media_carousel: "whatsappServiceFormatCarousel",
  flow: "whatsappActionKindFlow",
  appointment: "whatsappServiceActionBookCall",
  contacts: "whatsappServiceActionShareContact",
  location: "whatsappServiceActionShareLocation",
  location_request: "whatsappServiceFormatLocationRequest",
  request_contact_info: "whatsappServiceFormatContactRequest",
  voice_call: "whatsappServiceFormatVoiceCall",
  commerce: "whatsappServiceActionCatalog",
};

export const WHATSAPP_SERVICE_MESSAGE_ACTION_MENU_LABEL_KEYS = {
  reply_buttons: "whatsappServiceActionReplyButton",
  cta_url: "whatsappServiceActionWebsite",
  flow: "whatsappServiceActionFlow",
  appointment: "whatsappServiceActionBookCall",
  voice_call: "whatsappServiceActionVoiceCall",
  commerce: "whatsappServiceActionCatalog",
  media_carousel: "whatsappServiceMediaCarousel",
} as const;

export const WHATSAPP_SERVICE_MESSAGE_MEDIA_MENU_LABEL_KEYS = {
  image: "whatsappServiceMediaImage",
  video: "whatsappServiceMediaVideo",
  document: "whatsappServiceMediaDocument",
  audio: "whatsappServiceMediaAudio",
  sticker: "whatsappServiceMediaSticker",
} as const satisfies Partial<Record<ScenarioActionAttachmentMediaType, string>>;

/** Extra add-menu keys (triggers + contact/location submenus + carousel). */
export const WHATSAPP_SERVICE_MESSAGE_MENU_EXTRA_LABEL_KEYS = [
  "whatsappServiceAddMedia",
  "whatsappServiceAddAction",
  "whatsappServiceMediaCarousel",
  "whatsappServiceActionContact",
  "whatsappServiceActionShareContact",
  "whatsappServiceActionRequestContact",
  "whatsappServiceActionLocation",
  "whatsappServiceActionShareLocation",
  "whatsappServiceActionRequestLocation",
] as const;

/** All centralized menu + kind label keys for locale parity checks. */
export const WHATSAPP_SERVICE_MESSAGE_CENTRALIZED_LABEL_KEYS: readonly string[] =
  [
    ...Object.values(WHATSAPP_SERVICE_MESSAGE_KIND_LABEL_KEYS),
    ...Object.values(WHATSAPP_SERVICE_MESSAGE_ACTION_MENU_LABEL_KEYS),
    ...Object.values(WHATSAPP_SERVICE_MESSAGE_MEDIA_MENU_LABEL_KEYS),
    ...WHATSAPP_SERVICE_MESSAGE_MENU_EXTRA_LABEL_KEYS,
  ];
