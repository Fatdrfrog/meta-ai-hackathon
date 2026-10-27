import { isWhatsAppVoiceEligibleFile } from "@/lib/whatsapp/media-types";
import {
  createDefaultScenarioWhatsAppServiceMessage,
  getScenarioWhatsAppServiceBodySource,
  WHATSAPP_SERVICE_MESSAGE_LIMITS,
  type ScenarioActionAttachment,
  type ScenarioWhatsAppBodySource,
  type ScenarioWhatsAppCarouselCard,
  type ScenarioWhatsAppInteractiveHeader,
  type ScenarioWhatsAppInteractiveOption,
  type ScenarioWhatsAppListRow,
  type ScenarioWhatsAppListSection,
  type ScenarioWhatsAppServiceMessage,
  type ScenarioWhatsAppServiceMessagePayload,
  readScenarioPromptInputAskKind,
} from "@icecore/scenario-contracts";
import { WHATSAPP_SERVICE_MESSAGE_ACTION_MENU_LABEL_KEYS } from "./service-message-labels";

export type ServiceMessageEditorAction = Exclude<
  ScenarioWhatsAppServiceMessagePayload["kind"],
  "text" | "media" | "list"
>;

export type ServiceMessageEditorCapabilities = {
  callingReady: boolean;
  hasWhatsAppCoexistence: boolean;
};

type ServiceMessageEditorTray = "native" | "interactive" | "commerce";

export type ServiceMessageActionUnavailableReason =
  | "calling_not_ready"
  | "coexistence_unsupported"
  | "standalone_media";

export type ServiceMessageEditorProjection = {
  action: ServiceMessageEditorAction | "list" | null;
  body: ScenarioWhatsAppBodySource | undefined;
  media: ScenarioActionAttachment | null;
  headerText: string;
  footerText: string;
  tray: ServiceMessageEditorTray | null;
  allowsStandaloneAudio: boolean;
  supportsTextHeader: boolean;
  supportsFooter: boolean;
  supportsMedia: boolean;
  canAddChoice: boolean;
  isCarousel: boolean;
  supportsRenderer: boolean;
  currentActionAvailable: boolean;
  currentActionUnavailableReason: ServiceMessageActionUnavailableReason | null;
};

export type ServiceMessageEditorIntent =
  | { type: "set_body"; value: string }
  | { type: "set_body_mode"; mode: ScenarioWhatsAppBodySource["mode"] }
  | {
      type: "set_header_text";
      value: string;
    }
  | {
      type: "set_footer_text";
      value: string;
    }
  | {
      type: "attach_media";
      attachment: ScenarioActionAttachment;
      /** Force voice-note delivery when attaching audio (e.g. ElevenLabs OPUS). */
      deliverAsVoice?: boolean;
    }
  | { type: "remove_media" }
  | { type: "set_deliver_as_voice"; value: boolean }
  | {
      type: "select_action";
      action: ServiceMessageEditorAction;
      /** Seeded when selecting reply buttons so the bubble shows a draft row. */
      createDraftChoice?: () => ScenarioWhatsAppInteractiveOption;
      /** Allocated only after a real transition to carousel. */
      createCarouselCards?: () => ScenarioWhatsAppCarouselCard[];
    }
  | { type: "remove_action" }
  | {
      type: "add_choice";
      option: ScenarioWhatsAppInteractiveOption;
      listButtonLabel?: string;
    }
  | { type: "remove_choice"; optionId: string }
  | { type: "set_list_button_label"; value: string }
  | {
      type: "add_list_section";
      section: ScenarioWhatsAppListSection;
    }
  | { type: "remove_list_section"; sectionId: string }
  | { type: "set_list_section_title"; sectionId: string; value: string }
  | {
      type: "add_list_row";
      sectionId: string;
      row: ScenarioWhatsAppListRow;
    }
  | { type: "set_list_row_title"; rowId: string; value: string }
  | { type: "set_list_row_description"; rowId: string; value: string };

export type ServiceMessageListEditorIntent = Extract<
  ServiceMessageEditorIntent,
  {
    type:
      | "set_list_button_label"
      | "add_list_section"
      | "remove_list_section"
      | "set_list_section_title"
      | "add_list_row"
      | "remove_choice"
      | "set_list_row_title"
      | "set_list_row_description";
  }
>;

const DEFAULT_BODY: ScenarioWhatsAppBodySource = { mode: "fixed", text: "" };

type InteractiveMediaAttachment = ScenarioActionAttachment & {
  mediaType: "image" | "video" | "document";
};

function bodyValue(body: ScenarioWhatsAppBodySource): string {
  return body.mode === "fixed" ? body.text : body.instruction;
}

function bodyWithMode(
  body: ScenarioWhatsAppBodySource,
  mode: ScenarioWhatsAppBodySource["mode"]
): ScenarioWhatsAppBodySource {
  const value = body.mode === mode ? bodyValue(body) : "";
  return mode === "fixed"
    ? { mode, text: value }
    : { mode, instruction: value };
}

function bodyWithValue(
  body: ScenarioWhatsAppBodySource,
  value: string
): ScenarioWhatsAppBodySource {
  return body.mode === "fixed"
    ? { mode: "fixed", text: value }
    : { mode: "ai", instruction: value };
}

function isInteractiveMediaAttachment(
  attachment: ScenarioActionAttachment
): attachment is InteractiveMediaAttachment {
  return (
    attachment.mediaType === "image" ||
    attachment.mediaType === "video" ||
    attachment.mediaType === "document"
  );
}

/** Audio/sticker only work as standalone `type: audio|sticker` messages. */
function isStandaloneOnlyServiceMedia(
  attachment: ScenarioActionAttachment | null | undefined
): boolean {
  return (
    attachment?.mediaType === "audio" || attachment?.mediaType === "sticker"
  );
}

function canPromoteMediaToInteractiveHeader(
  value: ScenarioWhatsAppServiceMessage
): boolean {
  const media = projectedMedia(value.message);
  if (!media) return true;
  return isInteractiveMediaAttachment(media);
}

function mediaHeader(
  attachment: ScenarioActionAttachment
): ScenarioWhatsAppInteractiveHeader | undefined {
  if (!isInteractiveMediaAttachment(attachment)) return undefined;
  return { kind: "media", attachment };
}

function projectedMedia(
  message: ScenarioWhatsAppServiceMessagePayload
): ScenarioActionAttachment | null {
  if (message.kind === "media") return message.attachment;
  if (
    (message.kind === "reply_buttons" || message.kind === "cta_url") &&
    message.header?.kind === "media"
  ) {
    return message.header.attachment;
  }
  return null;
}

function projectedAction(
  message: ScenarioWhatsAppServiceMessagePayload
): ServiceMessageEditorProjection["action"] {
  switch (message.kind) {
    case "text":
    case "media":
      return null;
    case "list":
      return "list";
    default:
      return message.kind;
  }
}

type ServiceMessageEditorActionGroup = "button" | "contact" | "location";

type ServiceMessageEditorAvailabilityRule =
  | "always"
  | "interactive_header"
  | "calling"
  | "no_coexistence";

type ServiceMessageEditorActionDefinition = {
  action: ServiceMessageEditorAction;
  group: ServiceMessageEditorActionGroup;
  labelKey: string;
  availability: ServiceMessageEditorAvailabilityRule;
};

const SERVICE_MESSAGE_EDITOR_ACTION_DEFINITIONS = {
  reply_buttons: {
    action: "reply_buttons",
    group: "button",
    labelKey: WHATSAPP_SERVICE_MESSAGE_ACTION_MENU_LABEL_KEYS.reply_buttons,
    availability: "interactive_header",
  },
  cta_url: {
    action: "cta_url",
    group: "button",
    labelKey: WHATSAPP_SERVICE_MESSAGE_ACTION_MENU_LABEL_KEYS.cta_url,
    availability: "interactive_header",
  },
  flow: {
    action: "flow",
    group: "button",
    labelKey: WHATSAPP_SERVICE_MESSAGE_ACTION_MENU_LABEL_KEYS.flow,
    availability: "always",
  },
  appointment: {
    action: "appointment",
    group: "button",
    labelKey: WHATSAPP_SERVICE_MESSAGE_ACTION_MENU_LABEL_KEYS.appointment,
    availability: "always",
  },
  voice_call: {
    action: "voice_call",
    group: "button",
    labelKey: WHATSAPP_SERVICE_MESSAGE_ACTION_MENU_LABEL_KEYS.voice_call,
    availability: "calling",
  },
  media_carousel: {
    action: "media_carousel",
    group: "button",
    labelKey: WHATSAPP_SERVICE_MESSAGE_ACTION_MENU_LABEL_KEYS.media_carousel,
    availability: "always",
  },
  commerce: {
    action: "commerce",
    group: "button",
    labelKey: WHATSAPP_SERVICE_MESSAGE_ACTION_MENU_LABEL_KEYS.commerce,
    availability: "no_coexistence",
  },
  contacts: {
    action: "contacts",
    group: "contact",
    labelKey: "whatsappServiceActionShareContact",
    availability: "always",
  },
  request_contact_info: {
    action: "request_contact_info",
    group: "contact",
    labelKey: "whatsappServiceActionRequestContact",
    availability: "always",
  },
  location: {
    action: "location",
    group: "location",
    labelKey: "whatsappServiceActionShareLocation",
    availability: "always",
  },
  location_request: {
    action: "location_request",
    group: "location",
    labelKey: "whatsappServiceActionRequestLocation",
    availability: "always",
  },
} as const satisfies Record<
  ServiceMessageEditorAction,
  ServiceMessageEditorActionDefinition
>;

/** Ordered, exhaustive authoring registry; presentation code adds icons only. */
export const SERVICE_MESSAGE_EDITOR_ACTIONS: readonly ServiceMessageEditorActionDefinition[] =
  Object.values(SERVICE_MESSAGE_EDITOR_ACTION_DEFINITIONS);

function actionUnavailableReason(
  action: ServiceMessageEditorAction,
  value: ScenarioWhatsAppServiceMessage,
  capabilities: ServiceMessageEditorCapabilities
): ServiceMessageActionUnavailableReason | null {
  const availability =
    SERVICE_MESSAGE_EDITOR_ACTION_DEFINITIONS[action].availability;
  switch (availability) {
    case "always":
      return null;
    case "interactive_header":
      return isStandaloneOnlyServiceMedia(projectedMedia(value.message))
        ? "standalone_media"
        : null;
    case "calling":
      return capabilities.callingReady ? null : "calling_not_ready";
    case "no_coexistence":
      return capabilities.hasWhatsAppCoexistence
        ? "coexistence_unsupported"
        : null;
    default: {
      const exhaustive: never = availability;
      return exhaustive;
    }
  }
}

function projectedHeaderText(
  message: ScenarioWhatsAppServiceMessagePayload
): string {
  if (
    (message.kind === "reply_buttons" || message.kind === "cta_url") &&
    message.header?.kind === "text"
  ) {
    return message.header.text;
  }
  return message.kind === "list" ? (message.headerText ?? "") : "";
}

function projectedFooterText(
  message: ScenarioWhatsAppServiceMessagePayload
): string {
  return message.kind === "reply_buttons" ||
    message.kind === "list" ||
    message.kind === "cta_url"
    ? (message.footerText ?? "")
    : "";
}

function projectedTray(
  message: ScenarioWhatsAppServiceMessagePayload
): ServiceMessageEditorTray | null {
  switch (message.kind) {
    case "text":
    case "appointment":
    case "voice_call":
    case "contacts":
    case "location":
      return "native";
    case "list":
      return "interactive";
    case "commerce":
      return "commerce";
    case "media":
    case "media_carousel":
    case "reply_buttons":
    case "cta_url":
    case "flow":
    case "location_request":
    case "request_contact_info":
      return null;
    default: {
      const exhaustive: never = message;
      return exhaustive;
    }
  }
}

const LINK_PATTERN = /https?:\/\//i;

/**
 * Whether the native tray has anything to show. A text message offers link
 * preview only when its text can contain a link, or when it was turned off.
 */
export function hasServiceMessageNativeFields(
  message: ScenarioWhatsAppServiceMessagePayload
): boolean {
  switch (message.kind) {
    case "text":
      return (
        message.body.mode === "ai" ||
        LINK_PATTERN.test(message.body.text) ||
        message.previewUrl === false
      );
    case "appointment":
    case "contacts":
    case "location":
    case "voice_call":
      return true;
    default:
      return false;
  }
}

function projectedCanAddChoice(
  message: ScenarioWhatsAppServiceMessagePayload
): boolean {
  if (message.kind === "reply_buttons") {
    return (
      message.options.length < WHATSAPP_SERVICE_MESSAGE_LIMITS.list.rows.max
    );
  }
  if (message.kind === "list") {
    return (
      message.sections.reduce(
        (total, section) => total + section.rows.length,
        0
      ) < WHATSAPP_SERVICE_MESSAGE_LIMITS.list.rows.max
    );
  }
  return false;
}

export function projectServiceMessageEditor(
  value: ScenarioWhatsAppServiceMessage,
  capabilities: ServiceMessageEditorCapabilities
): ServiceMessageEditorProjection {
  const message = value.message;
  const action = projectedAction(message);
  const media = projectedMedia(message);
  const currentAction = action === "list" ? "reply_buttons" : action;
  const currentActionUnavailableReason = currentAction
    ? actionUnavailableReason(currentAction, value, capabilities)
    : null;
  const hasMediaPreview = Boolean(media?.url);
  const allowsStandaloneAudio =
    message.kind === "text" || message.kind === "media";
  const isCarousel = message.kind === "media_carousel";
  return {
    action,
    body: getScenarioWhatsAppServiceBodySource(value),
    media,
    headerText: projectedHeaderText(message),
    footerText: projectedFooterText(message),
    tray: projectedTray(message),
    allowsStandaloneAudio,
    supportsTextHeader:
      !hasMediaPreview &&
      (message.kind === "reply_buttons" ||
        message.kind === "cta_url" ||
        message.kind === "list"),
    supportsFooter:
      message.kind === "reply_buttons" ||
      message.kind === "cta_url" ||
      message.kind === "list",
    supportsMedia:
      message.kind === "text" ||
      message.kind === "media" ||
      message.kind === "reply_buttons" ||
      message.kind === "cta_url",
    canAddChoice: projectedCanAddChoice(message),
    isCarousel,
    supportsRenderer:
      message.kind !== "contacts" &&
      message.kind !== "location" &&
      message.kind !== "commerce",
    currentActionAvailable: currentActionUnavailableReason === null,
    currentActionUnavailableReason,
  };
}

export function getAvailableServiceMessageActions(
  value: ScenarioWhatsAppServiceMessage,
  capabilities: ServiceMessageEditorCapabilities
): ServiceMessageEditorAction[] {
  return SERVICE_MESSAGE_EDITOR_ACTIONS.filter(
    item => actionUnavailableReason(item.action, value, capabilities) === null
  ).map(item => item.action);
}

function wrap(
  message: ScenarioWhatsAppServiceMessagePayload
): ScenarioWhatsAppServiceMessage {
  return { version: 1, message };
}

export function retainScenarioPromptInputs(
  current: ScenarioWhatsAppServiceMessage,
  next: ScenarioWhatsAppServiceMessage
): ScenarioWhatsAppServiceMessage {
  if (!readScenarioPromptInputAskKind(next.message.kind)) {
    if (next.promptInputs === undefined) return next;
    const rest = { ...next };
    delete rest.promptInputs;
    return rest;
  }
  if (next.promptInputs !== undefined || !current.promptInputs?.length) {
    return next;
  }
  return { ...next, promptInputs: current.promptInputs };
}

function withBody(
  value: ScenarioWhatsAppServiceMessage,
  update: (body: ScenarioWhatsAppBodySource) => ScenarioWhatsAppBodySource
): ScenarioWhatsAppServiceMessage {
  const body = getScenarioWhatsAppServiceBodySource(value);
  if (!body) return value;
  const nextBody = update(body);
  switch (value.message.kind) {
    case "text":
    case "media":
    case "reply_buttons":
    case "list":
    case "cta_url":
    case "media_carousel":
    case "flow":
    case "appointment":
    case "location_request":
    case "request_contact_info":
    case "voice_call":
      return wrap({ ...value.message, body: nextBody });
    case "contacts":
    case "location":
    case "commerce":
      return value;
    default: {
      const exhaustive: never = value.message;
      return exhaustive;
    }
  }
}

function preserveBody(
  value: ScenarioWhatsAppServiceMessage
): ScenarioWhatsAppBodySource {
  return getScenarioWhatsAppServiceBodySource(value) ?? DEFAULT_BODY;
}

function preserveHeaderMedia(
  value: ScenarioWhatsAppServiceMessage
): ScenarioWhatsAppInteractiveHeader | undefined {
  const attachment = projectedMedia(value.message);
  return attachment ? mediaHeader(attachment) : undefined;
}

function preserveFooterText(
  value: ScenarioWhatsAppServiceMessage
): string | undefined {
  const message = value.message;
  if (
    message.kind === "reply_buttons" ||
    message.kind === "list" ||
    message.kind === "cta_url"
  ) {
    return message.footerText;
  }
  return undefined;
}

function preserveInteractiveHeader(
  value: ScenarioWhatsAppServiceMessage
): ScenarioWhatsAppInteractiveHeader | undefined {
  const mediaHeaderValue = preserveHeaderMedia(value);
  if (mediaHeaderValue) return mediaHeaderValue;

  const message = value.message;
  if (
    (message.kind === "reply_buttons" || message.kind === "cta_url") &&
    message.header?.kind === "text" &&
    message.header.text.trim()
  ) {
    return message.header;
  }
  if (message.kind === "list" && message.headerText?.trim()) {
    return { kind: "text", text: message.headerText };
  }
  return undefined;
}

function isSameActionFamily(
  message: ScenarioWhatsAppServiceMessagePayload,
  action: ServiceMessageEditorAction
): boolean {
  if (message.kind === action) return true;
  // List is the overflow form of reply buttons; the type select shows Reply.
  if (
    action === "reply_buttons" &&
    (message.kind === "reply_buttons" || message.kind === "list")
  ) {
    return true;
  }
  return false;
}

function replyOptionsFromMessage(
  message: ScenarioWhatsAppServiceMessagePayload,
  draftChoice?: ScenarioWhatsAppInteractiveOption
): ScenarioWhatsAppInteractiveOption[] {
  if (message.kind === "reply_buttons" && message.options.length > 0) {
    return message.options;
  }
  if (message.kind === "list") {
    const options = listRows(message).map(row => ({
      id: row.id,
      label: row.title,
    }));
    if (options.length > 0) {
      return options.slice(0, WHATSAPP_SERVICE_MESSAGE_LIMITS.replyButtons.max);
    }
  }
  if (message.kind === "cta_url") {
    const label = message.buttonLabel.trim();
    if (draftChoice) {
      return [{ ...draftChoice, label: draftChoice.label || label }];
    }
    return [];
  }
  if (draftChoice) return [draftChoice];
  return [];
}

function selectAction(
  value: ScenarioWhatsAppServiceMessage,
  action: ServiceMessageEditorAction,
  createDraftChoice?: () => ScenarioWhatsAppInteractiveOption,
  createCarouselCards?: () => ScenarioWhatsAppCarouselCard[]
): ScenarioWhatsAppServiceMessage {
  const current = value.message;
  if (isSameActionFamily(current, action)) {
    return value;
  }

  // Keep audio/sticker as standalone media — do not silently drop them into
  // reply/CTA messages that cannot carry those header types.
  if (
    (action === "reply_buttons" || action === "cta_url") &&
    !canPromoteMediaToInteractiveHeader(value)
  ) {
    return value;
  }

  const body = preserveBody(value);
  const footerText = preserveFooterText(value);
  const header = preserveInteractiveHeader(value);
  const defaults = createDefaultScenarioWhatsAppServiceMessage(action);
  const message = defaults.message;
  const draftChoice =
    action === "reply_buttons" ? createDraftChoice?.() : undefined;

  switch (message.kind) {
    case "reply_buttons": {
      const options = replyOptionsFromMessage(current, draftChoice);
      return wrap({
        kind: "reply_buttons",
        body,
        header,
        footerText,
        options:
          options.length > 0 ? options : draftChoice ? [draftChoice] : [],
      });
    }
    case "cta_url": {
      const buttonLabel =
        current.kind === "reply_buttons"
          ? current.options[0]?.label || ""
          : current.kind === "list"
            ? listRows(current)[0]?.title || ""
            : current.kind === "cta_url"
              ? current.buttonLabel
              : "";
      return wrap({
        kind: "cta_url",
        body,
        header,
        footerText,
        buttonLabel,
        urlSource:
          current.kind === "cta_url" ? current.urlSource : message.urlSource,
      });
    }
    case "media_carousel":
      return wrap({
        ...message,
        body,
        cards:
          message.cards.length > 0
            ? message.cards
            : (createCarouselCards?.() ?? message.cards),
      });
    case "flow":
    case "appointment":
    case "location_request":
    case "request_contact_info":
    case "voice_call":
      return wrap({ ...message, body });
    case "contacts":
    case "location":
    case "commerce":
      return defaults;
    case "text":
    case "media":
    case "list":
      return defaults;
    default: {
      const exhaustive: never = message;
      return exhaustive;
    }
  }
}

function setHeaderText(
  value: ScenarioWhatsAppServiceMessage,
  text: string
): ScenarioWhatsAppServiceMessage {
  const message = value.message;
  const hasText = text.trim().length > 0;

  if (message.kind === "list") {
    const next = { ...message };
    if (hasText) next.headerText = text;
    else delete next.headerText;
    return wrap(next);
  }

  if (message.kind === "reply_buttons" || message.kind === "cta_url") {
    const next = { ...message };
    if (hasText) next.header = { kind: "text", text };
    else delete next.header;
    return wrap(next);
  }

  return value;
}

function setFooterText(
  value: ScenarioWhatsAppServiceMessage,
  text: string
): ScenarioWhatsAppServiceMessage {
  const message = value.message;
  const hasText = text.trim().length > 0;

  if (
    message.kind === "reply_buttons" ||
    message.kind === "list" ||
    message.kind === "cta_url"
  ) {
    const next = { ...message };
    if (hasText) next.footerText = text;
    else delete next.footerText;
    return wrap(next);
  }

  return value;
}

function removeAction(
  value: ScenarioWhatsAppServiceMessage
): ScenarioWhatsAppServiceMessage {
  const body = preserveBody(value);
  const attachment = projectedMedia(value.message);
  if (attachment) {
    return wrap({
      kind: "media",
      attachment,
      body:
        attachment.mediaType === "audio" || attachment.mediaType === "sticker"
          ? undefined
          : body,
    });
  }
  return wrap({ kind: "text", body, previewUrl: true });
}

function attachMedia(
  value: ScenarioWhatsAppServiceMessage,
  attachment: ScenarioActionAttachment,
  deliverAsVoice?: boolean
): ScenarioWhatsAppServiceMessage {
  const message = value.message;
  const header = mediaHeader(attachment);
  if (message.kind === "reply_buttons" && header) {
    return wrap({ ...message, header });
  }
  if (message.kind === "cta_url" && header) {
    return wrap({ ...message, header });
  }
  // Interactive headers reject audio/sticker; leave message unchanged.
  if (message.kind === "reply_buttons" || message.kind === "cta_url") {
    return value;
  }
  if (message.kind !== "text" && message.kind !== "media") return value;

  const body = preserveBody(value);
  const preferVoice =
    deliverAsVoice === true ||
    (message.kind === "media" && message.deliverAsVoice === true);
  const keepVoice =
    attachment.mediaType === "audio" &&
    preferVoice &&
    isWhatsAppVoiceEligibleFile({
      mimeType: attachment.mimeType,
      fileName: attachment.fileName,
      url: attachment.url,
    });
  return wrap({
    kind: "media",
    attachment,
    body:
      attachment.mediaType === "audio" || attachment.mediaType === "sticker"
        ? undefined
        : body,
    ...(keepVoice ? { deliverAsVoice: true } : {}),
  });
}

type ScenarioWhatsAppMediaMessage = Extract<
  ScenarioWhatsAppServiceMessagePayload,
  { kind: "media" }
>;

/** Drop Graph `audio.voice` flag from a media service message. */
function clearDeliverAsVoice(
  message: ScenarioWhatsAppMediaMessage
): Omit<ScenarioWhatsAppMediaMessage, "deliverAsVoice"> {
  const next = { ...message };
  delete next.deliverAsVoice;
  return next;
}

function setDeliverAsVoice(
  value: ScenarioWhatsAppServiceMessage,
  enabled: boolean
): ScenarioWhatsAppServiceMessage {
  const message = value.message;
  if (message.kind !== "media") return value;
  if (message.attachment.mediaType !== "audio") return value;
  if (!enabled) {
    return wrap(clearDeliverAsVoice(message));
  }
  if (
    !isWhatsAppVoiceEligibleFile({
      mimeType: message.attachment.mimeType,
      fileName: message.attachment.fileName,
      url: message.attachment.url,
    })
  ) {
    return value;
  }
  return wrap({ ...message, deliverAsVoice: true });
}

function removeMedia(
  value: ScenarioWhatsAppServiceMessage
): ScenarioWhatsAppServiceMessage {
  const message = value.message;
  if (message.kind === "media") {
    return wrap({
      kind: "text",
      body: message.body ?? DEFAULT_BODY,
      previewUrl: true,
    });
  }
  if (message.kind === "reply_buttons") {
    return wrap({
      kind: "reply_buttons",
      body: message.body,
      footerText: message.footerText,
      options: message.options,
    });
  }
  if (message.kind === "cta_url") {
    return wrap({
      kind: "cta_url",
      body: message.body,
      footerText: message.footerText,
      buttonLabel: message.buttonLabel,
      urlSource: message.urlSource,
    });
  }
  return value;
}

function isSimpleList(
  message: Extract<ScenarioWhatsAppServiceMessagePayload, { kind: "list" }>
): boolean {
  return (
    !message.headerText &&
    message.sections.length === 1 &&
    !message.sections[0]?.title &&
    message.sections[0].rows.every(row => !row.description)
  );
}

function listRows(
  message: Extract<ScenarioWhatsAppServiceMessagePayload, { kind: "list" }>
): ScenarioWhatsAppListRow[] {
  return message.sections.flatMap(section => section.rows);
}

function addChoice(
  value: ScenarioWhatsAppServiceMessage,
  option: ScenarioWhatsAppInteractiveOption,
  listButtonLabel = "Options"
): ScenarioWhatsAppServiceMessage {
  const message = value.message;
  if (message.kind === "reply_buttons") {
    if (
      message.options.length >= WHATSAPP_SERVICE_MESSAGE_LIMITS.list.rows.max
    ) {
      return value;
    }
    if (
      message.options.length < WHATSAPP_SERVICE_MESSAGE_LIMITS.replyButtons.max
    ) {
      return wrap({ ...message, options: [...message.options, option] });
    }
    const rows = [...message.options, option].map(item => ({
      id: item.id,
      title: item.label,
    }));
    return wrap({
      kind: "list",
      body: message.body,
      headerText:
        message.header?.kind === "text" ? message.header.text : undefined,
      footerText: message.footerText,
      buttonLabel: listButtonLabel,
      sections: [{ id: "choices", rows }],
    });
  }
  if (message.kind === "list") {
    if (
      listRows(message).length >= WHATSAPP_SERVICE_MESSAGE_LIMITS.list.rows.max
    )
      return value;
    const [firstSection, ...remainingSections] = message.sections;
    if (!firstSection) {
      return wrap({
        ...message,
        sections: [
          {
            id: "choices",
            rows: [{ id: option.id, title: option.label }],
          },
        ],
      });
    }
    return wrap({
      ...message,
      sections: [
        {
          ...firstSection,
          rows: [...firstSection.rows, { id: option.id, title: option.label }],
        },
        ...remainingSections,
      ],
    });
  }
  if (projectedAction(message) !== null) return value;
  if (!canPromoteMediaToInteractiveHeader(value)) return value;
  const next = selectAction(value, "reply_buttons");
  if (next.message.kind !== "reply_buttons") return value;
  return wrap({ ...next.message, options: [option] });
}

function removeChoice(
  value: ScenarioWhatsAppServiceMessage,
  optionId: string
): ScenarioWhatsAppServiceMessage {
  const message = value.message;
  if (message.kind === "reply_buttons") {
    const options = message.options.filter(option => option.id !== optionId);
    return options.length === 0
      ? removeAction(value)
      : wrap({ ...message, options });
  }
  if (message.kind !== "list") return value;
  if (!listRows(message).some(row => row.id === optionId)) return value;

  return finishListRemoval(value, {
    ...message,
    sections: message.sections.map(section => ({
      ...section,
      rows: section.rows.filter(row => row.id !== optionId),
    })),
  });
}

function finishListRemoval(
  value: ScenarioWhatsAppServiceMessage,
  message: Extract<ScenarioWhatsAppServiceMessagePayload, { kind: "list" }>
): ScenarioWhatsAppServiceMessage {
  const next = {
    ...message,
    sections: message.sections.filter(section => section.rows.length > 0),
  };
  const rows = listRows(next);
  if (rows.length === 0) return removeAction(value);
  if (
    rows.length <= WHATSAPP_SERVICE_MESSAGE_LIMITS.replyButtons.max &&
    isSimpleList(next)
  ) {
    return wrap({
      kind: "reply_buttons",
      body: message.body,
      footerText: message.footerText,
      options: rows.map(row => ({ id: row.id, label: row.title })),
    });
  }
  return wrap(next);
}

function setListButtonLabel(
  value: ScenarioWhatsAppServiceMessage,
  buttonLabel: string
): ScenarioWhatsAppServiceMessage {
  return value.message.kind === "list" &&
    value.message.buttonLabel !== buttonLabel
    ? wrap({ ...value.message, buttonLabel })
    : value;
}

function addListSection(
  value: ScenarioWhatsAppServiceMessage,
  section: ScenarioWhatsAppListSection
): ScenarioWhatsAppServiceMessage {
  const message = value.message;
  if (
    message.kind !== "list" ||
    message.sections.length >=
      WHATSAPP_SERVICE_MESSAGE_LIMITS.list.sections.max ||
    message.sections.some(current => current.id === section.id)
  ) {
    return value;
  }
  return wrap({ ...message, sections: [...message.sections, section] });
}

function removeListSection(
  value: ScenarioWhatsAppServiceMessage,
  sectionId: string
): ScenarioWhatsAppServiceMessage {
  const message = value.message;
  if (
    message.kind !== "list" ||
    !message.sections.some(section => section.id === sectionId)
  ) {
    return value;
  }
  return finishListRemoval(value, {
    ...message,
    sections: message.sections.filter(section => section.id !== sectionId),
  });
}

function setListSectionTitle(
  value: ScenarioWhatsAppServiceMessage,
  sectionId: string,
  title: string
): ScenarioWhatsAppServiceMessage {
  const message = value.message;
  if (
    message.kind !== "list" ||
    !message.sections.some(section => section.id === sectionId)
  ) {
    return value;
  }
  return wrap({
    ...message,
    sections: message.sections.map(section =>
      section.id === sectionId ? { ...section, title } : section
    ),
  });
}

function addListRow(
  value: ScenarioWhatsAppServiceMessage,
  sectionId: string,
  row: ScenarioWhatsAppListRow
): ScenarioWhatsAppServiceMessage {
  const message = value.message;
  if (
    message.kind !== "list" ||
    listRows(message).length >= WHATSAPP_SERVICE_MESSAGE_LIMITS.list.rows.max ||
    !message.sections.some(section => section.id === sectionId) ||
    listRows(message).some(current => current.id === row.id)
  ) {
    return value;
  }
  return wrap({
    ...message,
    sections: message.sections.map(section =>
      section.id === sectionId
        ? { ...section, rows: [...section.rows, row] }
        : section
    ),
  });
}

function setListRowTitle(
  value: ScenarioWhatsAppServiceMessage,
  rowId: string,
  title: string
): ScenarioWhatsAppServiceMessage {
  const message = value.message;
  if (
    message.kind !== "list" ||
    !listRows(message).some(row => row.id === rowId)
  ) {
    return value;
  }
  return wrap({
    ...message,
    sections: message.sections.map(section => ({
      ...section,
      rows: section.rows.map(row =>
        row.id === rowId ? { ...row, title } : row
      ),
    })),
  });
}

function setListRowDescription(
  value: ScenarioWhatsAppServiceMessage,
  rowId: string,
  description: string
): ScenarioWhatsAppServiceMessage {
  const message = value.message;
  if (
    message.kind !== "list" ||
    !listRows(message).some(row => row.id === rowId)
  ) {
    return value;
  }
  return wrap({
    ...message,
    sections: message.sections.map(section => ({
      ...section,
      rows: section.rows.map(row =>
        row.id === rowId
          ? { ...row, description: description || undefined }
          : row
      ),
    })),
  });
}

export function applyServiceMessageEditorIntent(
  value: ScenarioWhatsAppServiceMessage,
  intent: ServiceMessageEditorIntent
): ScenarioWhatsAppServiceMessage {
  return retainScenarioPromptInputs(
    value,
    resolveServiceMessageEditorIntent(value, intent)
  );
}

function resolveServiceMessageEditorIntent(
  value: ScenarioWhatsAppServiceMessage,
  intent: ServiceMessageEditorIntent
): ScenarioWhatsAppServiceMessage {
  switch (intent.type) {
    case "set_body":
      return withBody(value, body => bodyWithValue(body, intent.value));
    case "set_body_mode":
      return withBody(value, body => bodyWithMode(body, intent.mode));
    case "set_header_text":
      return setHeaderText(value, intent.value);
    case "set_footer_text":
      return setFooterText(value, intent.value);
    case "attach_media":
      return attachMedia(value, intent.attachment, intent.deliverAsVoice);
    case "remove_media":
      return removeMedia(value);
    case "set_deliver_as_voice":
      return setDeliverAsVoice(value, intent.value);
    case "select_action":
      return selectAction(
        value,
        intent.action,
        intent.createDraftChoice,
        intent.createCarouselCards
      );
    case "remove_action":
      return removeAction(value);
    case "add_choice":
      return addChoice(value, intent.option, intent.listButtonLabel);
    case "remove_choice":
      return removeChoice(value, intent.optionId);
    case "set_list_button_label":
      return setListButtonLabel(value, intent.value);
    case "add_list_section":
      return addListSection(value, intent.section);
    case "remove_list_section":
      return removeListSection(value, intent.sectionId);
    case "set_list_section_title":
      return setListSectionTitle(value, intent.sectionId, intent.value);
    case "add_list_row":
      return addListRow(value, intent.sectionId, intent.row);
    case "set_list_row_title":
      return setListRowTitle(value, intent.rowId, intent.value);
    case "set_list_row_description":
      return setListRowDescription(value, intent.rowId, intent.value);
    default: {
      const exhaustive: never = intent;
      return exhaustive;
    }
  }
}
