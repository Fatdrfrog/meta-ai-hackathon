import {
  listCustomerMessageTextParts,
  type CustomerMessageTextParts,
  type CustomerMessageTextSource,
} from "@icecore/scenario-contracts";

// One definition of placeholder text, shared with scenario prompt inputs.
export {
  isDeletedMessagePlaceholderText,
  isMeaningfulMessageText,
  isMediaPlaceholderText,
  isNonLinguisticPlaceholderText,
} from "@icecore/scenario-contracts";

export type ReplyVisibleMessageTextSource = CustomerMessageTextSource | "none";

type ReplyVisibleMessageLike = CustomerMessageTextParts & {
  mediaType?: string | null;
};

function normalizeStoredMediaType(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Analysis is shown only for its own media type, or when the type is unknown. */
function mediaTypeAllowsPart(
  source: CustomerMessageTextSource,
  mediaType: string
): boolean {
  if (source === "text" || !mediaType) return true;
  if (source === "audio_analysis") {
    return mediaType === "audio" || mediaType === "voice";
  }
  return mediaType === "video";
}

const REPLY_VISIBLE_SUMMARY_PREFIX: Record<CustomerMessageTextSource, string> =
  {
    text: "",
    audio_analysis: "Audio message summary:\n",
    video_analysis: "Video message summary:\n",
  };

export function resolveReplyVisibleMessageText(
  message: ReplyVisibleMessageLike
): { text: string; source: ReplyVisibleMessageTextSource } {
  const mediaType = normalizeStoredMediaType(message.mediaType);
  const part = listCustomerMessageTextParts(message).find(candidate =>
    mediaTypeAllowsPart(candidate.source, mediaType)
  );
  if (!part) return { text: "", source: "none" };
  return {
    text: `${REPLY_VISIBLE_SUMMARY_PREFIX[part.source]}${part.text}`,
    source: part.source,
  };
}
