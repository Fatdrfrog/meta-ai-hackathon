import type {
  GenerativeAIInputKind,
  GenerativeAIInboundCandidate,
  GenerativeAIInboundClassification,
} from "@icecore/airi-runtime/scenario-generative-ai-input-types";
import { normalizeWhatsAppMimeType } from "@/lib/whatsapp/media-types";
import { WHATSAPP_OFFICIAL_MEDIA_MIME_TYPES } from "@icecore/whatsapp/mediaTypes";
import { readMeaningfulMessageText } from "@icecore/scenario-contracts";
import { readNonEmptyString } from "@icecore/shared/lib/value-utils";

const ALLOWED_IMAGE_MIME_TYPES = new Set(
  WHATSAPP_OFFICIAL_MEDIA_MIME_TYPES.image
);

export function classifyGenerativeAIInbound(params: {
  expectedInputKind: GenerativeAIInputKind;
  inbound: GenerativeAIInboundCandidate;
}): GenerativeAIInboundClassification {
  const messageId = readNonEmptyString(params.inbound.messageId);
  const kind = readNonEmptyString(params.inbound.kind)?.toLowerCase();
  const textOrCaption =
    readMeaningfulMessageText(params.inbound.textOrCaption) || null;
  const whatsappMediaId = readNonEmptyString(params.inbound.whatsappMediaId);
  const declaredMimeType = normalizeWhatsAppMimeType(
    params.inbound.declaredMimeType
  );
  const fileName = readNonEmptyString(params.inbound.fileName);

  if (!messageId) {
    return {
      status: "wrong_type",
      expectedInputKind: params.expectedInputKind,
    };
  }

  if (params.expectedInputKind === "text") {
    const hasMediaIdentity = Boolean(
      whatsappMediaId || declaredMimeType || fileName
    );
    // A reply that completed a prompt-input collector is the answer that
    // collector accepted, even as a voice note, video or captioned image.
    const answerText =
      kind === "text" && textOrCaption && !hasMediaIdentity
        ? textOrCaption
        : readNonEmptyString(params.inbound.promptInputAnswerText);
    if (!answerText) {
      return { status: "wrong_type", expectedInputKind: "text" };
    }

    return {
      status: "compatible",
      input: {
        messageId,
        kind: "text",
        textOrCaption: answerText,
        whatsappMediaId: null,
        declaredMimeType: null,
        fileName: null,
      },
    };
  }

  if (
    kind !== "image" ||
    !declaredMimeType ||
    !ALLOWED_IMAGE_MIME_TYPES.has(declaredMimeType)
  ) {
    return { status: "wrong_type", expectedInputKind: "image" };
  }
  if (!whatsappMediaId) {
    return { status: "missing_owned_media", expectedInputKind: "image" };
  }

  return {
    status: "compatible",
    input: {
      messageId,
      kind: "image",
      textOrCaption,
      whatsappMediaId,
      declaredMimeType,
      fileName,
    },
  };
}
