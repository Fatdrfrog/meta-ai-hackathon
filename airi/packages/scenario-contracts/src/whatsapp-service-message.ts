import type { ScenarioActionAttachment } from "./scenario-action-attachments";
import {
  listScenarioWhatsAppServicePayloadOptions,
  type ScenarioWhatsAppServiceOption,
} from "./whatsapp-service-options";

export {
  findScenarioWhatsAppServiceOption,
  listScenarioWhatsAppServicePayloadOptions,
  type ScenarioWhatsAppServiceOption,
} from "./whatsapp-service-options";
import {
  resolveSendableWhatsAppFlowIdentity,
  type ScenarioWhatsAppBookCallConfig,
  type ScenarioWhatsAppContactConfig,
  type ScenarioWhatsAppLocationConfig,
  type WhatsAppFlowConfig,
} from "./scenario-channel-configs";
import {
  normalizeScenarioPromptInputBehavior,
  readScenarioPromptInputAskKind,
  readScenarioPromptInputDraft,
  validateScenarioPromptInputs,
  type ScenarioPromptInputBehavior,
  type ScenarioPromptInputDiagnosticCode,
  type ScenarioPromptInputField,
} from "./scenario-prompt-inputs";
import { isRecord, readTrimmedString as text } from "./value-guards";

export const SCENARIO_WHATSAPP_SERVICE_MESSAGE_VERSION = 1 as const;

export const WHATSAPP_SERVICE_MESSAGE_LIMITS = {
  body: {
    text: 4096,
    interactive: 1024,
    mediaCaption: 1024,
  },
  header: {
    text: 60,
  },
  footer: {
    text: 60,
  },
  button: {
    label: 20,
    replyId: 256,
    flowCta: 30,
  },
  replyButtons: {
    min: 1,
    max: 3,
  },
  list: {
    sections: { min: 1, max: 10 },
    rows: { min: 1, max: 10 },
    sectionTitle: 24,
    rowId: 200,
    rowTitle: 24,
    rowDescription: 72,
  },
  carousel: {
    cards: { min: 2, max: 10 },
    cardBody: 160,
  },
  commerce: {
    body: 1024,
    header: 60,
    footer: 60,
    multiProduct: {
      sections: { min: 1, max: 10 },
      sectionTitle: 24,
      products: { min: 1, max: 30 },
    },
    productCarousel: {
      products: { min: 2, max: 10 },
    },
  },
  voice: {
    ttlMinutes: { min: 1, max: 43_200 },
    payloadBytes: 512,
  },
} as const;

export const SCENARIO_WHATSAPP_SERVICE_MESSAGE_KINDS = [
  "text",
  "media",
  "reply_buttons",
  "list",
  "cta_url",
  "media_carousel",
  "flow",
  "appointment",
  "contacts",
  "location",
  "location_request",
  "request_contact_info",
  "voice_call",
  "commerce",
] as const;

export type ScenarioWhatsAppServiceMessageKind =
  (typeof SCENARIO_WHATSAPP_SERVICE_MESSAGE_KINDS)[number];

export type ScenarioWhatsAppBodySource =
  | { mode: "fixed"; text: string }
  | { mode: "ai"; instruction: string };

export type ScenarioWhatsAppInteractiveOption = {
  id: string;
  label: string;
};

export type ScenarioWhatsAppListRow = {
  id: string;
  title: string;
  description?: string;
};

export type ScenarioWhatsAppListSection = {
  id: string;
  title?: string;
  rows: ScenarioWhatsAppListRow[];
};

export type ScenarioWhatsAppInteractiveHeader =
  | { kind: "text"; text: string }
  | {
      kind: "media";
      attachment: ScenarioActionAttachment & {
        mediaType: "image" | "video" | "document";
      };
    };

export type ScenarioWhatsAppCtaUrlSource =
  | { kind: "fixed"; url: string }
  | {
      kind: "signup_link";
      signupLinkId: string;
      signupLinkName?: string;
      fallbackUrl?: string;
    };

export type ScenarioWhatsAppCarouselInteraction =
  | {
      kind: "url";
      buttonLabel: string;
      url: string;
    }
  | {
      kind: "quick_replies";
      options: ScenarioWhatsAppInteractiveOption[];
    };

export type ScenarioWhatsAppCarouselCard = {
  id: string;
  media: ScenarioActionAttachment & { mediaType: "image" | "video" };
  bodyText?: string;
  interaction: ScenarioWhatsAppCarouselInteraction;
};

export type ScenarioWhatsAppCommerceConfig =
  | {
      mode: "catalog";
      catalogId: string;
      bodyText?: string;
      footerText?: string;
      thumbnailProductRetailerId?: string;
    }
  | {
      mode: "single_product";
      catalogId: string;
      productRetailerId: string;
      bodyText?: string;
      footerText?: string;
    }
  | {
      mode: "multi_product";
      catalogId: string;
      headerText: string;
      bodyText: string;
      footerText?: string;
      sections: Array<{
        id: string;
        title: string;
        productRetailerIds: string[];
      }>;
    }
  | {
      mode: "product_carousel";
      catalogId: string;
      bodyText: string;
      productRetailerIds: string[];
    };

export type ScenarioWhatsAppServiceMessagePayload =
  | {
      kind: "text";
      body: ScenarioWhatsAppBodySource;
      previewUrl?: boolean;
    }
  | {
      kind: "media";
      attachment: ScenarioActionAttachment;
      body?: ScenarioWhatsAppBodySource;
      /** Graph `audio.voice: true`. Only valid when attachment.mediaType is audio. */
      deliverAsVoice?: boolean;
    }
  | {
      kind: "reply_buttons";
      body: ScenarioWhatsAppBodySource;
      header?: ScenarioWhatsAppInteractiveHeader;
      footerText?: string;
      options: ScenarioWhatsAppInteractiveOption[];
    }
  | {
      kind: "list";
      body: ScenarioWhatsAppBodySource;
      headerText?: string;
      footerText?: string;
      buttonLabel: string;
      sections: ScenarioWhatsAppListSection[];
    }
  | {
      kind: "cta_url";
      body: ScenarioWhatsAppBodySource;
      header?: ScenarioWhatsAppInteractiveHeader;
      footerText?: string;
      buttonLabel: string;
      urlSource: ScenarioWhatsAppCtaUrlSource;
    }
  | {
      kind: "media_carousel";
      body: ScenarioWhatsAppBodySource;
      cards: ScenarioWhatsAppCarouselCard[];
    }
  | {
      kind: "flow";
      body: ScenarioWhatsAppBodySource;
      flowConfig: WhatsAppFlowConfig | null;
    }
  | {
      kind: "appointment";
      body: ScenarioWhatsAppBodySource;
      config: ScenarioWhatsAppBookCallConfig;
    }
  | {
      kind: "contacts";
      contacts: ScenarioWhatsAppContactConfig[];
    }
  | {
      kind: "location";
      location: ScenarioWhatsAppLocationConfig;
    }
  | {
      kind: "location_request";
      body: ScenarioWhatsAppBodySource;
    }
  | {
      kind: "request_contact_info";
      body: ScenarioWhatsAppBodySource;
    }
  | {
      kind: "voice_call";
      body: ScenarioWhatsAppBodySource;
      buttonLabel: string;
      ttlMinutes: number;
      payload: string;
    }
  | {
      kind: "commerce";
      commerce: ScenarioWhatsAppCommerceConfig;
    };

export type ScenarioWhatsAppServiceMessage = {
  version: typeof SCENARIO_WHATSAPP_SERVICE_MESSAGE_VERSION;
  message: ScenarioWhatsAppServiceMessagePayload;
  promptInputs?: ScenarioPromptInputField[];
  /** How the ask treats replies; kept only while it asks for details. */
  promptInputBehavior?: ScenarioPromptInputBehavior;
};

export type ScenarioWhatsAppServiceMessageDiagnosticCode =
  | "unsupported_version"
  | "message_kind_invalid"
  | "body_required"
  | "body_too_long"
  | "header_required"
  | "header_too_long"
  | "footer_too_long"
  | "button_label_required"
  | "button_label_too_long"
  | "reply_button_count_invalid"
  | "interactive_id_required"
  | "interactive_id_too_long"
  | "interactive_id_duplicate"
  | "list_section_count_invalid"
  | "list_row_count_invalid"
  | "list_section_title_too_long"
  | "list_row_title_required"
  | "list_row_title_too_long"
  | "list_row_description_too_long"
  | "url_invalid"
  | "signup_link_required"
  | "media_required"
  | "media_type_invalid"
  | "media_caption_unsupported"
  | "voice_format_invalid"
  | "carousel_card_count_invalid"
  | "carousel_card_id_required"
  | "carousel_button_shape_mismatch"
  | "flow_invalid"
  | "flow_source_mismatch"
  | "appointment_invalid"
  | "contact_invalid"
  | "location_coordinates_invalid"
  | "voice_call_ttl_invalid"
  | "voice_call_payload_too_long"
  | "commerce_invalid"
  | "managed_url_unresolved"
  | "appointment_slots_unresolved"
  | "voice_call_unavailable"
  | "catalog_unavailable"
  | ScenarioPromptInputDiagnosticCode;

export type ScenarioWhatsAppServiceMessageDiagnostic = {
  code: ScenarioWhatsAppServiceMessageDiagnosticCode;
  path?: string;
};

export type ScenarioWhatsAppServiceMessageNormalization =
  | { status: "supported"; value: ScenarioWhatsAppServiceMessage }
  | { status: "unsupported_version"; version: number }
  | {
      status: "invalid";
      diagnostics: ScenarioWhatsAppServiceMessageDiagnostic[];
    };

function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

function isKnownKind(
  value: unknown,
): value is ScenarioWhatsAppServiceMessageKind {
  return (
    typeof value === "string" &&
    (SCENARIO_WHATSAPP_SERVICE_MESSAGE_KINDS as readonly string[]).includes(
      value,
    )
  );
}

function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRecord);
}

function isOptionalRecordArray(value: unknown): boolean {
  return isNullish(value) || isRecordArray(value);
}

function isStringArray(value: unknown): boolean {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function hasSafeHeaderShape(value: unknown): boolean {
  if (isNullish(value)) return true;
  if (!isRecord(value)) return false;
  if (value.kind === "text") return true;
  return value.kind === "media" && isRecord(value.attachment);
}

function hasSafeListShape(message: Record<string, unknown>): boolean {
  return (
    isRecordArray(message.sections) &&
    message.sections.every((section) => isRecordArray(section.rows))
  );
}

function hasSafeCarouselShape(message: Record<string, unknown>): boolean {
  if (!isRecordArray(message.cards)) return false;
  return message.cards.every((card) => {
    if (!isRecord(card.interaction) || !isRecord(card.media)) return false;
    if (card.interaction.kind === "url") return true;
    return (
      card.interaction.kind === "quick_replies" &&
      isRecordArray(card.interaction.options)
    );
  });
}

function hasSafeCommerceShape(message: Record<string, unknown>): boolean {
  const commerce = message.commerce;
  if (!isRecord(commerce)) return false;
  if (commerce.mode === "multi_product") {
    if (!isRecordArray(commerce.sections)) return false;
    return commerce.sections.every((section) =>
      isStringArray(section.productRetailerIds),
    );
  }
  if (commerce.mode === "product_carousel") {
    return isStringArray(commerce.productRetailerIds);
  }
  return commerce.mode === "catalog" || commerce.mode === "single_product";
}

function hasSafeBodyShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    (value.mode === "fixed" && typeof value.text === "string") ||
    (value.mode === "ai" && typeof value.instruction === "string")
  );
}

function hasSafeFlowShape(value: unknown): boolean {
  if (value === null) return true;
  return (
    isRecord(value) &&
    isRecordArray(value.screens) &&
    value.screens.every(
      (screen) =>
        isRecordArray(screen.fields) &&
        screen.fields.every((field) => isOptionalRecordArray(field.options)),
    )
  );
}

function hasSafeKnownMessageShape(message: Record<string, unknown>): boolean {
  // Empty authored values stay editable; sendability is validated separately.
  switch (message.kind) {
    case "media":
      return (
        isRecord(message.attachment) &&
        (isNullish(message.body) || hasSafeBodyShape(message.body))
      );
    case "reply_buttons":
      return (
        hasSafeBodyShape(message.body) &&
        hasSafeHeaderShape(message.header) &&
        isRecordArray(message.options)
      );
    case "list":
      return hasSafeBodyShape(message.body) && hasSafeListShape(message);
    case "cta_url":
      return (
        hasSafeBodyShape(message.body) &&
        hasSafeHeaderShape(message.header) &&
        isRecord(message.urlSource) &&
        (message.urlSource.kind === "fixed" ||
          message.urlSource.kind === "signup_link")
      );
    case "media_carousel":
      return hasSafeBodyShape(message.body) && hasSafeCarouselShape(message);
    case "flow":
      return (
        hasSafeBodyShape(message.body) && hasSafeFlowShape(message.flowConfig)
      );
    case "appointment":
      return hasSafeBodyShape(message.body) && isRecord(message.config);
    case "contacts":
      return isRecordArray(message.contacts);
    case "location":
      return isRecord(message.location);
    case "commerce":
      return hasSafeCommerceShape(message);
    case "text":
    case "location_request":
    case "request_contact_info":
    case "voice_call":
      return hasSafeBodyShape(message.body);
    default:
      return false;
  }
}

export function normalizeScenarioWhatsAppServiceMessage(
  value: unknown,
): ScenarioWhatsAppServiceMessageNormalization {
  if (!isRecord(value)) {
    return {
      status: "invalid",
      diagnostics: [{ code: "message_kind_invalid", path: "message" }],
    };
  }

  const version = value.version;
  if (
    typeof version === "number" &&
    Number.isFinite(version) &&
    version !== 1
  ) {
    return { status: "unsupported_version", version };
  }
  if (version !== 1 || !isRecord(value.message)) {
    return {
      status: "invalid",
      diagnostics: [{ code: "message_kind_invalid", path: "message" }],
    };
  }
  if (!isKnownKind(value.message.kind)) {
    return {
      status: "invalid",
      diagnostics: [{ code: "message_kind_invalid", path: "message.kind" }],
    };
  }
  if (!hasSafeKnownMessageShape(value.message)) {
    return {
      status: "invalid",
      diagnostics: [{ code: "message_kind_invalid", path: "message" }],
    };
  }

  const supported = value as ScenarioWhatsAppServiceMessage;
  // Text, buttons, list and carousel messages can ask for details.
  const promptInputs = readScenarioPromptInputAskKind(value.message.kind)
    ? readScenarioPromptInputDraft(value.promptInputs)
    : undefined;
  if (promptInputs) {
    const { promptInputBehavior: storedBehavior, ...rest } = supported;
    const promptInputBehavior =
      normalizeScenarioPromptInputBehavior(storedBehavior);
    return {
      status: "supported",
      value: {
        ...rest,
        promptInputs,
        ...(promptInputBehavior ? { promptInputBehavior } : {}),
      },
    };
  }
  if (
    supported.promptInputs !== undefined ||
    supported.promptInputBehavior !== undefined
  ) {
    const rest = { ...supported };
    delete rest.promptInputs;
    delete rest.promptInputBehavior;
    return { status: "supported", value: rest };
  }

  return {
    status: "supported",
    value: supported,
  };
}

function push(
  diagnostics: ScenarioWhatsAppServiceMessageDiagnostic[],
  code: ScenarioWhatsAppServiceMessageDiagnosticCode,
  path?: string,
): void {
  diagnostics.push(path ? { code, path } : { code });
}

function validateBody(
  body: ScenarioWhatsAppBodySource | undefined,
  diagnostics: ScenarioWhatsAppServiceMessageDiagnostic[],
  maxLength: number,
  path = "message.body",
): void {
  const bodyText =
    body?.mode === "fixed"
      ? text(body.text)
      : body?.mode === "ai"
        ? text(body.instruction)
        : "";
  if (!bodyText) {
    push(diagnostics, "body_required", path);
  } else if (bodyText.length > maxLength) {
    push(diagnostics, "body_too_long", path);
  }
}

function validateOptionalText(
  value: unknown,
  maxLength: number,
  code: "body_too_long" | "header_too_long" | "footer_too_long",
  path: string,
  diagnostics: ScenarioWhatsAppServiceMessageDiagnostic[],
): void {
  if (typeof value === "string" && value.trim().length > maxLength) {
    push(diagnostics, code, path);
  }
}

function validateButtonLabel(
  value: unknown,
  diagnostics: ScenarioWhatsAppServiceMessageDiagnostic[],
  path: string,
  maxLength = WHATSAPP_SERVICE_MESSAGE_LIMITS.button.label,
): void {
  const label = text(value);
  if (!label) push(diagnostics, "button_label_required", path);
  else if (label.length > maxLength) {
    push(diagnostics, "button_label_too_long", path);
  }
}

function isHttpUrl(value: unknown): boolean {
  const normalized = text(value);
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Voice notes require OGG (OPUS). MIME and/or .ogg filename. */
function isWhatsAppVoiceEligibleAttachment(
  attachment: ScenarioActionAttachment | null | undefined,
): boolean {
  if (!attachment || attachment.mediaType !== "audio") return false;
  const mime = text(attachment.mimeType).toLowerCase();
  if (mime === "audio/ogg" || mime.startsWith("audio/ogg;")) return true;
  const name = text(attachment.fileName || attachment.url).toLowerCase();
  return name.endsWith(".ogg");
}

function validateOptions(params: {
  options: ScenarioWhatsAppInteractiveOption[];
  min: number;
  max: number;
  idMax: number;
  path: string;
  diagnostics: ScenarioWhatsAppServiceMessageDiagnostic[];
}): void {
  if (
    params.options.length < params.min ||
    params.options.length > params.max
  ) {
    push(params.diagnostics, "reply_button_count_invalid", params.path);
  }
  const seen = new Set<string>();
  params.options.forEach((option, index) => {
    const optionPath = `${params.path}.${index}`;
    const id = text(option?.id);
    if (!id)
      push(params.diagnostics, "interactive_id_required", `${optionPath}.id`);
    else if (id.length > params.idMax) {
      push(params.diagnostics, "interactive_id_too_long", `${optionPath}.id`);
    } else if (seen.has(id)) {
      push(params.diagnostics, "interactive_id_duplicate", `${optionPath}.id`);
    }
    if (id) seen.add(id);
    validateButtonLabel(
      option?.label,
      params.diagnostics,
      `${optionPath}.label`,
    );
  });
}

function validateHeader(
  header: ScenarioWhatsAppInteractiveHeader | undefined,
  diagnostics: ScenarioWhatsAppServiceMessageDiagnostic[],
): void {
  if (!header) return;
  if (header.kind === "text") {
    const headerText = text(header.text);
    if (!headerText) {
      push(diagnostics, "header_required", "message.header.text");
    } else if (
      headerText.length > WHATSAPP_SERVICE_MESSAGE_LIMITS.header.text
    ) {
      push(diagnostics, "header_too_long", "message.header.text");
    }
    return;
  }
  const attachment = header.attachment;
  if (!attachment?.url) {
    push(diagnostics, "media_required", "message.header.attachment");
  } else if (
    attachment.mediaType !== "image" &&
    attachment.mediaType !== "video" &&
    attachment.mediaType !== "document"
  ) {
    push(
      diagnostics,
      "media_type_invalid",
      "message.header.attachment.mediaType",
    );
  }
}

function validateLocation(
  location: ScenarioWhatsAppLocationConfig,
  diagnostics: ScenarioWhatsAppServiceMessageDiagnostic[],
): void {
  if (
    [location?.latitude, location?.longitude].some(
      (value) =>
        typeof value !== "number" &&
        (typeof value !== "string" || !value.trim()),
    )
  ) {
    push(diagnostics, "location_coordinates_invalid", "message.location");
    return;
  }
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
    push(diagnostics, "location_coordinates_invalid", "message.location");
  }
}

export function validateScenarioWhatsAppServiceMessage(
  value: unknown,
): ScenarioWhatsAppServiceMessageDiagnostic[] {
  const normalized = normalizeScenarioWhatsAppServiceMessage(value);
  if (normalized.status === "unsupported_version") {
    return [{ code: "unsupported_version", path: "version" }];
  }
  if (normalized.status === "invalid") return normalized.diagnostics;

  const diagnostics: ScenarioWhatsAppServiceMessageDiagnostic[] = [];
  const message = normalized.value.message;

  switch (message.kind) {
    case "text":
      validateBody(
        message.body,
        diagnostics,
        WHATSAPP_SERVICE_MESSAGE_LIMITS.body.text,
      );
      break;
    case "media": {
      if (!message.attachment?.url) {
        push(diagnostics, "media_required", "message.attachment");
      }
      if (
        !["image", "video", "audio", "document", "sticker"].includes(
          message.attachment?.mediaType,
        )
      ) {
        push(diagnostics, "media_type_invalid", "message.attachment.mediaType");
      }
      if (message.deliverAsVoice) {
        if (message.attachment?.mediaType !== "audio") {
          push(diagnostics, "media_type_invalid", "message.deliverAsVoice");
        } else if (!isWhatsAppVoiceEligibleAttachment(message.attachment)) {
          push(diagnostics, "voice_format_invalid", "message.attachment");
        }
      }
      if (message.body) {
        if (
          message.attachment?.mediaType === "audio" ||
          message.attachment?.mediaType === "sticker"
        ) {
          push(diagnostics, "media_caption_unsupported", "message.body");
        } else {
          validateBody(
            message.body,
            diagnostics,
            WHATSAPP_SERVICE_MESSAGE_LIMITS.body.mediaCaption,
          );
        }
      }
      break;
    }
    case "reply_buttons":
      validateBody(
        message.body,
        diagnostics,
        WHATSAPP_SERVICE_MESSAGE_LIMITS.body.interactive,
      );
      validateHeader(message.header, diagnostics);
      validateOptionalText(
        message.footerText,
        WHATSAPP_SERVICE_MESSAGE_LIMITS.footer.text,
        "footer_too_long",
        "message.footerText",
        diagnostics,
      );
      validateOptions({
        options: Array.isArray(message.options) ? message.options : [],
        min: WHATSAPP_SERVICE_MESSAGE_LIMITS.replyButtons.min,
        max: WHATSAPP_SERVICE_MESSAGE_LIMITS.replyButtons.max,
        idMax: WHATSAPP_SERVICE_MESSAGE_LIMITS.button.replyId,
        path: "message.options",
        diagnostics,
      });
      break;
    case "list": {
      validateBody(
        message.body,
        diagnostics,
        WHATSAPP_SERVICE_MESSAGE_LIMITS.body.text,
      );
      validateOptionalText(
        message.headerText,
        WHATSAPP_SERVICE_MESSAGE_LIMITS.header.text,
        "header_too_long",
        "message.headerText",
        diagnostics,
      );
      validateOptionalText(
        message.footerText,
        WHATSAPP_SERVICE_MESSAGE_LIMITS.footer.text,
        "footer_too_long",
        "message.footerText",
        diagnostics,
      );
      validateButtonLabel(
        message.buttonLabel,
        diagnostics,
        "message.buttonLabel",
      );
      const sections = Array.isArray(message.sections) ? message.sections : [];
      if (
        sections.length < WHATSAPP_SERVICE_MESSAGE_LIMITS.list.sections.min ||
        sections.length > WHATSAPP_SERVICE_MESSAGE_LIMITS.list.sections.max
      ) {
        push(diagnostics, "list_section_count_invalid", "message.sections");
      }
      const rows = sections.flatMap((section) =>
        Array.isArray(section.rows) ? section.rows : [],
      );
      if (
        rows.length < WHATSAPP_SERVICE_MESSAGE_LIMITS.list.rows.min ||
        rows.length > WHATSAPP_SERVICE_MESSAGE_LIMITS.list.rows.max
      ) {
        push(diagnostics, "list_row_count_invalid", "message.sections");
      }
      const seen = new Set<string>();
      sections.forEach((section, sectionIndex) => {
        if (
          text(section.title).length >
          WHATSAPP_SERVICE_MESSAGE_LIMITS.list.sectionTitle
        ) {
          push(
            diagnostics,
            "list_section_title_too_long",
            `message.sections.${sectionIndex}.title`,
          );
        }
        (section.rows || []).forEach((row, rowIndex) => {
          const path = `message.sections.${sectionIndex}.rows.${rowIndex}`;
          const id = text(row.id);
          if (!id) push(diagnostics, "interactive_id_required", `${path}.id`);
          else if (id.length > WHATSAPP_SERVICE_MESSAGE_LIMITS.list.rowId) {
            push(diagnostics, "interactive_id_too_long", `${path}.id`);
          } else if (seen.has(id)) {
            push(diagnostics, "interactive_id_duplicate", `${path}.id`);
          }
          if (id) seen.add(id);
          if (!text(row.title)) {
            push(diagnostics, "list_row_title_required", `${path}.title`);
          } else if (
            text(row.title).length >
            WHATSAPP_SERVICE_MESSAGE_LIMITS.list.rowTitle
          ) {
            push(diagnostics, "list_row_title_too_long", `${path}.title`);
          }
          if (
            text(row.description).length >
            WHATSAPP_SERVICE_MESSAGE_LIMITS.list.rowDescription
          ) {
            push(
              diagnostics,
              "list_row_description_too_long",
              `${path}.description`,
            );
          }
        });
      });
      break;
    }
    case "cta_url":
      validateBody(
        message.body,
        diagnostics,
        WHATSAPP_SERVICE_MESSAGE_LIMITS.body.interactive,
      );
      validateHeader(message.header, diagnostics);
      validateOptionalText(
        message.footerText,
        WHATSAPP_SERVICE_MESSAGE_LIMITS.footer.text,
        "footer_too_long",
        "message.footerText",
        diagnostics,
      );
      validateButtonLabel(
        message.buttonLabel,
        diagnostics,
        "message.buttonLabel",
      );
      if (message.urlSource?.kind === "fixed") {
        if (!isHttpUrl(message.urlSource.url)) {
          push(diagnostics, "url_invalid", "message.urlSource.url");
        }
      } else if (
        message.urlSource?.kind !== "signup_link" ||
        !text(message.urlSource.signupLinkId)
      ) {
        push(diagnostics, "signup_link_required", "message.urlSource");
      }
      break;
    case "media_carousel": {
      validateBody(
        message.body,
        diagnostics,
        WHATSAPP_SERVICE_MESSAGE_LIMITS.body.interactive,
      );
      const cards = Array.isArray(message.cards) ? message.cards : [];
      if (
        cards.length < WHATSAPP_SERVICE_MESSAGE_LIMITS.carousel.cards.min ||
        cards.length > WHATSAPP_SERVICE_MESSAGE_LIMITS.carousel.cards.max
      ) {
        push(diagnostics, "carousel_card_count_invalid", "message.cards");
      }
      const interactionKinds = new Set<string>();
      const interactionCounts = new Set<number>();
      const optionIds = new Set<string>();
      cards.forEach((card, cardIndex) => {
        const path = `message.cards.${cardIndex}`;
        validateOptionalText(
          card.bodyText,
          WHATSAPP_SERVICE_MESSAGE_LIMITS.carousel.cardBody,
          "body_too_long",
          `${path}.bodyText`,
          diagnostics,
        );
        if (!text(card.id)) {
          push(diagnostics, "carousel_card_id_required", `${path}.id`);
        }
        if (!card.media?.url) {
          push(diagnostics, "media_required", `${path}.media`);
        }
        if (
          card.media?.mediaType !== "image" &&
          card.media?.mediaType !== "video"
        ) {
          push(diagnostics, "media_type_invalid", `${path}.media.mediaType`);
        }
        interactionKinds.add(card.interaction?.kind || "");
        if (card.interaction?.kind === "url") {
          interactionCounts.add(1);
          validateButtonLabel(
            card.interaction.buttonLabel,
            diagnostics,
            `${path}.interaction.buttonLabel`,
          );
          if (!isHttpUrl(card.interaction.url)) {
            push(diagnostics, "url_invalid", `${path}.interaction.url`);
          }
        } else if (card.interaction?.kind === "quick_replies") {
          const options = Array.isArray(card.interaction.options)
            ? card.interaction.options
            : [];
          interactionCounts.add(options.length);
          if (
            options.length < WHATSAPP_SERVICE_MESSAGE_LIMITS.replyButtons.min ||
            options.length > WHATSAPP_SERVICE_MESSAGE_LIMITS.replyButtons.max
          ) {
            push(
              diagnostics,
              "reply_button_count_invalid",
              `${path}.interaction.options`,
            );
          }
          options.forEach((option, optionIndex) => {
            const optionPath = `${path}.interaction.options.${optionIndex}`;
            const id = text(option.id);
            if (!id)
              push(diagnostics, "interactive_id_required", `${optionPath}.id`);
            else if (
              id.length > WHATSAPP_SERVICE_MESSAGE_LIMITS.button.replyId
            ) {
              push(diagnostics, "interactive_id_too_long", `${optionPath}.id`);
            } else if (optionIds.has(id)) {
              push(diagnostics, "interactive_id_duplicate", `${optionPath}.id`);
            }
            if (id) optionIds.add(id);
            validateButtonLabel(
              option.label,
              diagnostics,
              `${optionPath}.label`,
            );
          });
        }
      });
      if (interactionKinds.size > 1 || interactionCounts.size > 1) {
        push(diagnostics, "carousel_button_shape_mismatch", "message.cards");
      }
      break;
    }
    case "flow":
      validateBody(
        message.body,
        diagnostics,
        WHATSAPP_SERVICE_MESSAGE_LIMITS.body.interactive,
      );
      const flowIdentity = resolveSendableWhatsAppFlowIdentity({
        flowConfig: message.flowConfig,
      });
      const flowCta = text(message.flowConfig?.ctaText);
      if (
        !message.flowConfig ||
        !flowIdentity ||
        !flowCta ||
        flowCta.length > WHATSAPP_SERVICE_MESSAGE_LIMITS.button.flowCta
      ) {
        push(diagnostics, "flow_invalid", "message.flowConfig");
      }
      break;
    case "appointment":
      validateBody(
        message.body,
        diagnostics,
        WHATSAPP_SERVICE_MESSAGE_LIMITS.body.interactive,
      );
      if (
        message.config?.enabled === false ||
        Number(message.config?.maxSlots || 0) < 1 ||
        Number(message.config?.maxSlots || 0) > 10
      ) {
        push(diagnostics, "appointment_invalid", "message.config");
      }
      break;
    case "contacts":
      if (
        !Array.isArray(message.contacts) ||
        message.contacts.length < 1 ||
        message.contacts.length > 10 ||
        message.contacts.some((contact) => !text(contact?.formattedName))
      ) {
        push(diagnostics, "contact_invalid", "message.contacts");
      }
      break;
    case "location":
      validateLocation(message.location, diagnostics);
      break;
    case "location_request":
    case "request_contact_info":
      validateBody(
        message.body,
        diagnostics,
        WHATSAPP_SERVICE_MESSAGE_LIMITS.body.interactive,
      );
      break;
    case "voice_call":
      validateBody(
        message.body,
        diagnostics,
        WHATSAPP_SERVICE_MESSAGE_LIMITS.body.interactive,
      );
      validateButtonLabel(
        message.buttonLabel,
        diagnostics,
        "message.buttonLabel",
      );
      if (
        !Number.isInteger(message.ttlMinutes) ||
        message.ttlMinutes <
          WHATSAPP_SERVICE_MESSAGE_LIMITS.voice.ttlMinutes.min ||
        message.ttlMinutes >
          WHATSAPP_SERVICE_MESSAGE_LIMITS.voice.ttlMinutes.max
      ) {
        push(diagnostics, "voice_call_ttl_invalid", "message.ttlMinutes");
      }
      if (
        new TextEncoder().encode(text(message.payload)).length >
        WHATSAPP_SERVICE_MESSAGE_LIMITS.voice.payloadBytes
      ) {
        push(diagnostics, "voice_call_payload_too_long", "message.payload");
      }
      break;
    case "commerce": {
      const commerce = message.commerce;
      let invalid = !commerce || !text(commerce.catalogId);
      if (commerce?.mode === "catalog") {
        validateOptionalText(
          commerce.bodyText,
          WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.body,
          "body_too_long",
          "message.commerce.bodyText",
          diagnostics,
        );
        validateOptionalText(
          commerce.footerText,
          WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.footer,
          "footer_too_long",
          "message.commerce.footerText",
          diagnostics,
        );
      } else if (commerce?.mode === "single_product") {
        invalid ||= !text(commerce.productRetailerId);
        validateOptionalText(
          commerce.bodyText,
          WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.body,
          "body_too_long",
          "message.commerce.bodyText",
          diagnostics,
        );
        validateOptionalText(
          commerce.footerText,
          WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.footer,
          "footer_too_long",
          "message.commerce.footerText",
          diagnostics,
        );
      } else if (commerce?.mode === "multi_product") {
        const sections = commerce.sections || [];
        const productCount = sections.reduce(
          (count, section) => count + (section.productRetailerIds || []).length,
          0,
        );
        validateOptionalText(
          commerce.headerText,
          WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.header,
          "header_too_long",
          "message.commerce.headerText",
          diagnostics,
        );
        validateOptionalText(
          commerce.bodyText,
          WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.body,
          "body_too_long",
          "message.commerce.bodyText",
          diagnostics,
        );
        validateOptionalText(
          commerce.footerText,
          WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.footer,
          "footer_too_long",
          "message.commerce.footerText",
          diagnostics,
        );
        if (
          sections.length <
            WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.multiProduct.sections
              .min ||
          sections.length >
            WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.multiProduct.sections.max
        ) {
          push(
            diagnostics,
            "list_section_count_invalid",
            "message.commerce.sections",
          );
        }
        sections.forEach((section, sectionIndex) => {
          if (
            text(section.title).length >
            WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.multiProduct.sectionTitle
          ) {
            push(
              diagnostics,
              "list_section_title_too_long",
              `message.commerce.sections.${sectionIndex}.title`,
            );
          }
        });
        invalid ||=
          !text(commerce.headerText) ||
          !text(commerce.bodyText) ||
          productCount <
            WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.multiProduct.products
              .min ||
          productCount >
            WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.multiProduct.products.max;
      } else if (commerce?.mode === "product_carousel") {
        validateOptionalText(
          commerce.bodyText,
          WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.body,
          "body_too_long",
          "message.commerce.bodyText",
          diagnostics,
        );
        invalid ||=
          !text(commerce.bodyText) ||
          commerce.productRetailerIds.length <
            WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.productCarousel.products
              .min ||
          commerce.productRetailerIds.length >
            WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.productCarousel.products
              .max;
      } else if (commerce) {
        invalid = true;
      }
      if (invalid) push(diagnostics, "commerce_invalid", "message.commerce");
      break;
    }
    default: {
      const exhaustive: never = message;
      return exhaustive;
    }
  }

  diagnostics.push(
    ...validateScenarioPromptInputs({
      fields: normalized.value.promptInputs,
      message,
    }),
  );

  return diagnostics;
}

function fixedBody(): ScenarioWhatsAppBodySource {
  return { mode: "fixed", text: "" };
}

export function createDefaultScenarioWhatsAppServiceMessage(
  kind: ScenarioWhatsAppServiceMessageKind,
): ScenarioWhatsAppServiceMessage {
  const wrap = (
    message: ScenarioWhatsAppServiceMessagePayload,
  ): ScenarioWhatsAppServiceMessage => ({ version: 1, message });

  switch (kind) {
    case "text":
      return wrap({ kind, body: fixedBody(), previewUrl: true });
    case "media":
      return wrap({
        kind,
        attachment: { url: "", mediaType: "image" },
        body: fixedBody(),
      });
    case "reply_buttons":
      return wrap({ kind, body: fixedBody(), options: [] });
    case "list":
      return wrap({ kind, body: fixedBody(), buttonLabel: "", sections: [] });
    case "cta_url":
      return wrap({
        kind,
        body: fixedBody(),
        buttonLabel: "",
        urlSource: { kind: "fixed", url: "" },
      });
    case "media_carousel":
      return wrap({ kind, body: fixedBody(), cards: [] });
    case "flow":
      return wrap({ kind, body: fixedBody(), flowConfig: null });
    case "appointment":
      return wrap({
        kind,
        body: fixedBody(),
        config: { enabled: true, maxSlots: 5, timeZone: "UTC" },
      });
    case "contacts":
      return wrap({ kind, contacts: [{ version: 1 }] });
    case "location":
      return wrap({
        kind,
        location: { version: 1, latitude: "", longitude: "" },
      });
    case "location_request":
    case "request_contact_info":
      return wrap({ kind, body: fixedBody() });
    case "voice_call":
      return wrap({
        kind,
        body: fixedBody(),
        buttonLabel: "",
        ttlMinutes: 60,
        payload: "",
      });
    case "commerce":
      return wrap({
        kind,
        commerce: { mode: "catalog", catalogId: "" },
      });
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function getScenarioWhatsAppServiceBodySource(
  config: ScenarioWhatsAppServiceMessage,
): ScenarioWhatsAppBodySource | undefined {
  const message = config.message;
  switch (message.kind) {
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
      return message.body;
    case "contacts":
    case "location":
    case "commerce":
      return undefined;
    default: {
      const exhaustive: never = message;
      return exhaustive;
    }
  }
}

export function resolveOwnedScenarioWhatsAppServiceBodyMode(
  nodeData: Readonly<{ actionWhatsAppServiceMessage?: unknown }>,
): ScenarioWhatsAppBodySource["mode"] | undefined {
  if (nodeData.actionWhatsAppServiceMessage === undefined) return undefined;

  const normalized = normalizeScenarioWhatsAppServiceMessage(
    nodeData.actionWhatsAppServiceMessage,
  );
  if (normalized.status !== "supported") return "fixed";

  return (
    getScenarioWhatsAppServiceBodySource(normalized.value)?.mode ?? "fixed"
  );
}

export type ScenarioWhatsAppServiceBranchOption = {
  id: string;
  label: string;
};

/** Every choice a service message offers, with each carousel option's card. */
export function listScenarioWhatsAppServiceOptions(
  config: ScenarioWhatsAppServiceMessage,
): ScenarioWhatsAppServiceOption[] {
  return listScenarioWhatsAppServicePayloadOptions(config.message);
}

export function extractScenarioWhatsAppServiceBranchOptions(params: {
  config: ScenarioWhatsAppServiceMessage;
}): ScenarioWhatsAppServiceBranchOption[] {
  return listScenarioWhatsAppServiceOptions(params.config).map((option) => ({
    id: option.id,
    label: option.label || option.id,
  }));
}
