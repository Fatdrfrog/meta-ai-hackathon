import { extractWhatsAppTemplateNameFromText } from "@/lib/whatsapp/templates/preview";
import {
  hasStoredWhatsAppServiceMessage,
  resolveStoredWhatsAppServiceMessagePreview,
} from "@icecore/shared/lib/whatsapp/service-message-preview";
import type {
  RequestConversationMessage,
  StoredMessageMediaType,
} from "@icecore/shared/types/message-preview";

type ConversationListPreviewTone =
  | "neutral"
  | "success"
  | "accent"
  | "telegram";

type ConversationListPreviewIcon =
  | "flow"
  | "template"
  | "link"
  | "selection"
  | "contact"
  | "media"
  | "carousel"
  | "buttons"
  | "deleted"
  | "location"
  | "call"
  | "catalog";

export type ConversationListPreview =
  | {
      kind: "plain";
      text: string;
    }
  | {
      kind: "structured";
      tone: ConversationListPreviewTone;
      icon: ConversationListPreviewIcon;
      title: string;
      details?: string;
    };

const FLOW_RESPONSE_REGEX = /^\[Flow response:\s*([^\]]+)\](?:\s*(.*))?$/i;
const BUTTON_REPLY_REGEX = /^\[Button reply\]\s*(.*)$/i;
const LIST_REPLY_REGEX = /^\[List reply\]\s*(.*)$/i;
const CONTACT_SHARE_REGEX = /^\[Contact info shared(?::\s*([^\]]+))?\]$/i;
const MESSAGE_DELETED_REGEX = /^\[Message deleted\]$/i;
const INTERACTIVE_MESSAGE_REGEX = /^\[Interactive message\]$/i;
const ROUND_VIDEO_REGEX = /^\[Round video(?: - upload failed)?\]$/i;
const UPLOAD_FAILED_REGEX =
  /^\[(audio|voice|video|image|document|sticker|file)\s+-\s+upload failed\]$/i;
const PLACEHOLDER_REGEX =
  /^\[(audio|voice|video|image|document|sticker|file)(?:\s+(?:message|attachment))?\]$/i;

function decodePreviewEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function normalizeMessagePreviewText(text?: string | null): string {
  if (!text) return "";

  return decodePreviewEntities(
    text
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[^\S\n]{2,}/g, " ")
    .trim();
}

function toSingleLine(text?: string | null): string {
  return normalizeMessagePreviewText(text).replace(/\s+/g, " ").trim();
}

function truncate(text: string, maxLength = 68): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

/** One line of preview text, cut to `maxLength` characters with "...". */
export function compactPreviewText(
  text: string | null | undefined,
  maxLength: number
): string {
  return truncate(toSingleLine(text), maxLength);
}

function humanizeMediaTitle(mediaType?: StoredMessageMediaType | null): string {
  switch (mediaType) {
    case "image":
      return "Photo";
    case "video":
      return "Video";
    case "voice":
      return "Voice message";
    case "audio":
      return "Audio file";
    case "document":
      return "Document";
    case "sticker":
      return "Sticker";
    case "file":
      return "File";
    default:
      return "Attachment";
  }
}

function formatFlowTitle(
  current?: RequestConversationMessage,
  previous?: RequestConversationMessage
): string {
  const previousCta = toSingleLine(previous?.whatsappFlow?.flowCta);
  if (previousCta) return truncate(previousCta, 52);

  const currentCta = toSingleLine(current?.whatsappFlow?.flowCta);
  if (currentCta) return truncate(currentCta, 52);

  const previousBody = toSingleLine(
    previous?.whatsappFlow?.bodyText || previous?.text
  );
  if (previousBody) return truncate(previousBody, 52);

  const currentBody = toSingleLine(
    current?.whatsappFlowReply?.body || current?.text
  );
  if (currentBody) return truncate(currentBody, 52);

  const flowName =
    current?.whatsappFlowReply?.flowName ||
    normalizeMessagePreviewText(current?.text).match(
      FLOW_RESPONSE_REGEX
    )?.[1] ||
    "WhatsApp flow";

  return truncate(toSingleLine(flowName) || "WhatsApp flow", 52);
}

function parseSelectionReply(
  text: string
): { title: string; details: string } | null {
  const buttonReply = text.match(BUTTON_REPLY_REGEX);
  if (buttonReply) {
    return {
      title: truncate(buttonReply[1]?.trim() || "Button reply"),
      details: "Selected option",
    };
  }

  const listReply = text.match(LIST_REPLY_REGEX);
  if (listReply) {
    return {
      title: truncate(listReply[1]?.trim() || "List reply"),
      details: "Selected option",
    };
  }

  return null;
}

function parseContactShare(
  text: string
): { title: string; details?: string } | null {
  const match = text.match(CONTACT_SHARE_REGEX);
  if (!match) return null;

  return {
    title: truncate(match[1]?.trim() || "Shared contact"),
    details: match[1] ? "Contact shared" : undefined,
  };
}

function parseMediaPlaceholder(text: string): {
  title: string;
  details?: string;
} | null {
  if (!text) return null;

  if (ROUND_VIDEO_REGEX.test(text)) {
    return { title: "Round video" };
  }

  const failedMatch = text.match(UPLOAD_FAILED_REGEX);
  if (failedMatch?.[1]) {
    return {
      title: `${humanizeMediaTitle(
        failedMatch[1].toLowerCase() as StoredMessageMediaType
      )} upload failed`,
    };
  }

  if (/^\[video note\]$/i.test(text)) {
    return { title: "Video note" };
  }

  if (/^\[animation attachment\]$/i.test(text)) {
    return { title: "Animation" };
  }

  if (/^\[attachment\]$/i.test(text)) {
    return { title: "Attachment" };
  }

  const placeholderMatch = text.match(PLACEHOLDER_REGEX);
  if (!placeholderMatch?.[1]) return null;

  return {
    title: humanizeMediaTitle(
      placeholderMatch[1].toLowerCase() as StoredMessageMediaType
    ),
  };
}

function getMessageMediaPreview(
  message?: RequestConversationMessage
): { title: string; details?: string } | null {
  if (!message) return null;

  const normalizedText = normalizeMessagePreviewText(message.text);
  const placeholderPreview = parseMediaPlaceholder(normalizedText);
  const fileName = toSingleLine(message.fileName);
  const captionText =
    normalizedText && !placeholderPreview
      ? truncate(toSingleLine(normalizedText), 72)
      : "";

  if (message.mediaType) {
    return {
      title: humanizeMediaTitle(message.mediaType),
      details: fileName || captionText || placeholderPreview?.details,
    };
  }

  if (placeholderPreview) {
    return {
      title: placeholderPreview.title,
      details: fileName || captionText || placeholderPreview.details,
    };
  }

  return null;
}

function getFirstTemplateButtonText(
  message?: RequestConversationMessage
): string {
  const buttons = message?.whatsappTemplate?.buttons || [];
  const firstButton = buttons.find(
    button => typeof button.text === "string" && button.text.trim().length > 0
  );
  return firstButton?.text?.trim() || "";
}

function flattenTelegramButtons(
  message?: RequestConversationMessage
): string[] {
  const rows = message?.telegramReplyMarkup?.inlineKeyboard || [];
  if (!Array.isArray(rows)) return [];

  return rows
    .flatMap(row => (Array.isArray(row) ? row : []))
    .map(button =>
      button && typeof button.text === "string" ? button.text.trim() : ""
    )
    .filter(Boolean);
}

function getHostname(url?: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function formatPlainPreviewText(params: {
  current?: RequestConversationMessage;
  fallbackText?: string;
  isTelegramGroupLike?: boolean;
  lastMessageAuthor?: string;
}): string {
  const current = params.current;
  const normalized = truncate(
    toSingleLine(current?.text ?? params.fallbackText ?? ""),
    120
  );

  if (
    normalized &&
    params.isTelegramGroupLike &&
    current?.direction === "inbound" &&
    params.lastMessageAuthor
  ) {
    return `${params.lastMessageAuthor}: ${normalized}`;
  }

  return normalized;
}

// Projected rows keep only the service message kind and body text, never the
// send command (see lib/requests-projection/derive.ts).
function buildWhatsAppServiceMessageListPreview(
  message?: RequestConversationMessage
): ConversationListPreview | null {
  const { bodyText, kind } = resolveStoredWhatsAppServiceMessagePreview(
    message?.whatsappServiceMessage,
    message?.text
  );
  // Plain text/media service payloads still use the normal text/media preview.
  if (!kind || kind === "text" || kind === "media") return null;

  const body = toSingleLine(bodyText);

  switch (kind) {
    case "media_carousel":
      return {
        kind: "structured",
        tone: "accent",
        icon: "carousel",
        title: "Carousel",
        details: body || undefined,
      };
    case "reply_buttons":
      return {
        kind: "structured",
        tone: "accent",
        icon: "buttons",
        title: "Reply buttons",
        details: body || undefined,
      };
    case "list":
      return {
        kind: "structured",
        tone: "accent",
        icon: "selection",
        title: "List message",
        details: body || undefined,
      };
    case "cta_url":
      return {
        kind: "structured",
        tone: "accent",
        icon: "link",
        title: "Link button",
        details: body || undefined,
      };
    case "flow":
      return {
        kind: "structured",
        tone: "accent",
        icon: "flow",
        title: "WhatsApp flow",
        details: body || undefined,
      };
    case "location_request":
      return {
        kind: "structured",
        tone: "neutral",
        icon: "location",
        title: "Location request",
        details: body || undefined,
      };
    case "location":
      return {
        kind: "structured",
        tone: "neutral",
        icon: "location",
        title: "Location",
        details: body || undefined,
      };
    case "contacts":
      return {
        kind: "structured",
        tone: "neutral",
        icon: "contact",
        title: "Contact card",
        details: body || undefined,
      };
    case "request_contact_info":
      return {
        kind: "structured",
        tone: "neutral",
        icon: "contact",
        title: "Contact request",
        details: body || undefined,
      };
    case "voice_call":
      return {
        kind: "structured",
        tone: "accent",
        icon: "call",
        title: "WhatsApp call",
        details: body || undefined,
      };
    case "commerce":
      return {
        kind: "structured",
        tone: "accent",
        icon: "catalog",
        title: "Catalog",
        details: body || undefined,
      };
    case "appointment":
      return {
        kind: "structured",
        tone: "accent",
        icon: "selection",
        title: "Book a call",
        details: body || undefined,
      };
    default:
      return {
        kind: "structured",
        tone: "neutral",
        icon: "selection",
        title: "Interactive message",
        details: body || undefined,
      };
  }
}

export function buildConversationListPreview(params: {
  messages?: RequestConversationMessage[];
  fallbackText?: string;
  lastMessageAuthor?: string;
  isTelegramGroupLike?: boolean;
}): ConversationListPreview {
  const current = params.messages?.[0];
  const previous = params.messages?.[1];
  const currentText = normalizeMessagePreviewText(
    current?.text ?? params.fallbackText
  );
  const isContactInfoFlowReply =
    current?.whatsappFlowReply?.flowName?.trim().toLowerCase() ===
    "address_message";

  // Projected Flow replies carry a bounded answer count, never responseJson.
  const hasWhatsAppFlowReplyPayload =
    Boolean(current?.whatsappFlowReply) &&
    !isContactInfoFlowReply &&
    (current?.whatsappFlowReply?.responseSubmitted === true ||
      Boolean(current?.whatsappFlowReply?.flowToken));

  if (hasWhatsAppFlowReplyPayload) {
    const fieldCount = current?.whatsappFlowReply?.responseFieldCount ?? 0;
    return {
      kind: "structured",
      tone: "success",
      icon: "flow",
      title: formatFlowTitle(current, previous),
      details: fieldCount > 0 ? `${fieldCount} answers` : "Response sent",
    };
  }

  const hasCanonicalWhatsAppServiceMessage =
    current?.direction === "outbound" &&
    hasStoredWhatsAppServiceMessage(current.whatsappServiceMessage);
  const serviceMessagePreview = hasCanonicalWhatsAppServiceMessage
    ? buildWhatsAppServiceMessageListPreview(current)
    : null;
  if (serviceMessagePreview) {
    return serviceMessagePreview;
  }

  // A template send also stores the Flow its FLOW button opens; it still
  // previews as the template.
  if (
    !hasCanonicalWhatsAppServiceMessage &&
    current?.whatsappFlow?.flowId &&
    !current.whatsappTemplate?.name?.trim() &&
    current.direction === "outbound"
  ) {
    const cta = toSingleLine(current.whatsappFlow.flowCta);
    const body = toSingleLine(current.whatsappFlow.bodyText || current.text);
    const title = truncate(cta || body || "WhatsApp flow");
    return {
      kind: "structured",
      tone: "accent",
      icon: "flow",
      title,
      details: body && body !== title ? truncate(body, 72) : "WhatsApp flow",
    };
  }

  const templateName =
    current?.whatsappTemplate?.name?.trim() ||
    (current?.direction === "outbound"
      ? extractWhatsAppTemplateNameFromText(current?.text) || ""
      : "");
  if (
    !hasCanonicalWhatsAppServiceMessage &&
    (current?.whatsappTemplate ||
      (templateName && current?.direction === "outbound"))
  ) {
    const buttonText = getFirstTemplateButtonText(current);
    const derivedTemplateText = toSingleLine(
      current?.whatsappTemplate?.bodyText ||
        current?.whatsappTemplate?.headerText ||
        current?.text
    ).replace(/^\[Template:\s*[^\]]+\]\s*/i, "");
    const bodyText = /^with variables:/i.test(derivedTemplateText)
      ? ""
      : derivedTemplateText;

    return {
      kind: "structured",
      tone: "accent",
      icon: "template",
      title: truncate(
        bodyText || buttonText || templateName || "WhatsApp template"
      ),
    };
  }

  if (!hasCanonicalWhatsAppServiceMessage && current?.whatsappCtaLink?.url) {
    const label = toSingleLine(current.whatsappCtaLink.title);
    const hostname = getHostname(current.whatsappCtaLink.url);
    return {
      kind: "structured",
      tone: "accent",
      icon: "link",
      title: truncate(label || hostname || "Open link"),
      details: truncate(hostname || "Link button", 72),
    };
  }

  const groundedOptions =
    !hasCanonicalWhatsAppServiceMessage &&
    Array.isArray(current?.groundedReplyOptions?.options)
      ? current.groundedReplyOptions.options.filter(
          option =>
            typeof option?.label === "string" && option.label.trim().length > 0
        )
      : [];
  if (groundedOptions.length > 0) {
    const firstOption = toSingleLine(groundedOptions[0]?.label);
    const surface = current?.groundedReplyOptions?.surface || "text";
    const details =
      groundedOptions.length > 1
        ? `${groundedOptions.length} grounded options via ${surface}`
        : `Grounded option via ${surface}`;
    return {
      kind: "structured",
      tone:
        surface === "telegram_inline"
          ? "telegram"
          : surface === "whatsapp_button" || surface === "whatsapp_list"
            ? "accent"
            : "neutral",
      icon: "selection",
      title: truncate(firstOption || "Grounded option"),
      details,
    };
  }

  const telegramButtons = flattenTelegramButtons(current);
  if (telegramButtons.length > 0) {
    const firstButton = telegramButtons[0];
    return {
      kind: "structured",
      tone: "telegram",
      icon: "buttons",
      title: truncate(
        firstButton || `${telegramButtons.length} inline buttons`
      ),
      details:
        telegramButtons.length > 1
          ? `${telegramButtons.length} inline buttons`
          : "Inline button",
    };
  }

  if (currentText) {
    const selectionReply = parseSelectionReply(currentText);
    if (selectionReply) {
      return {
        kind: "structured",
        tone: "neutral",
        icon: "selection",
        title: selectionReply.title,
        details: selectionReply.details,
      };
    }

    const contactShare = parseContactShare(currentText);
    if (contactShare) {
      return {
        kind: "structured",
        tone: "neutral",
        icon: "contact",
        title: contactShare.title,
        details: contactShare.details,
      };
    }

    if (MESSAGE_DELETED_REGEX.test(currentText)) {
      return {
        kind: "structured",
        tone: "neutral",
        icon: "deleted",
        title: "Message deleted",
      };
    }

    if (INTERACTIVE_MESSAGE_REGEX.test(currentText)) {
      return {
        kind: "structured",
        tone: "neutral",
        icon: "selection",
        title: "Interactive message",
      };
    }
  }

  const mediaPreview = getMessageMediaPreview(current);
  if (mediaPreview) {
    return {
      kind: "structured",
      tone: "neutral",
      icon: "media",
      title: truncate(mediaPreview.title),
      details: mediaPreview.details
        ? truncate(mediaPreview.details, 72)
        : undefined,
    };
  }

  return {
    kind: "plain",
    text: formatPlainPreviewText({
      current,
      fallbackText: params.fallbackText,
      isTelegramGroupLike: params.isTelegramGroupLike,
      lastMessageAuthor: params.lastMessageAuthor,
    }),
  };
}
