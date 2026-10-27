import type { OutboundAttachment } from "@/types/outbound-attachment";
import { utf8ByteLength } from "@icecore/shared/lib/utf8";
import { readIdString } from "@icecore/shared/lib/value-utils";

/**
 * The Graph id that sends messages: the Instagram account under Instagram
 * Login, otherwise the linked Facebook Page. Kept here, away from the source
 * loader, so turn and scenario contexts can use it without loading Supabase.
 */
export function resolveInstagramSenderId(
  credentials: {
    page_id?: unknown;
    instagram_business_account_id?: unknown;
    instagram_scoped_id?: unknown;
  },
  authMethod: string | null | undefined
): string {
  const pageId = readIdString(credentials.page_id) ?? "";
  const businessAccountId =
    readIdString(credentials.instagram_business_account_id) ?? "";
  const scopedId = readIdString(credentials.instagram_scoped_id) ?? "";
  return authMethod === "instagram_business_login"
    ? scopedId || businessAccountId || pageId
    : pageId || businessAccountId || scopedId;
}

/** Meta rejects Instagram message text over 1000 UTF-8 bytes. */
export const INSTAGRAM_TEXT_MAX_BYTES = 1000;
/** Button template text has its own, character-based limit. */
export const INSTAGRAM_BUTTON_TEMPLATE_TEXT_MAX_CHARS = 640;

export function isInstagramTextTooLong(text: string): boolean {
  return utf8ByteLength(text) > INSTAGRAM_TEXT_MAX_BYTES;
}

type InstagramAttachmentMediaType =
  | OutboundAttachment["mediaType"]
  | "document"
  | "file";

function toInstagramAttachmentType(
  mediaType: InstagramAttachmentMediaType | null | undefined
): "image" | "video" | "audio" | "file" {
  if (mediaType === "image" || mediaType === "video" || mediaType === "audio") {
    return mediaType;
  }
  return "file";
}

export function buildInstagramAttachmentMessagePayload(params: {
  mediaType: InstagramAttachmentMediaType;
  url: string;
}) {
  return {
    attachment: {
      type: toInstagramAttachmentType(params.mediaType),
      payload: {
        url: params.url,
      },
    },
  };
}

export function buildInstagramDmMessageBody(params: {
  recipientId: string;
  message: Record<string, unknown>;
  useHumanAgentTag?: boolean;
}) {
  return {
    recipient: { id: params.recipientId },
    message: params.message,
    messaging_type: params.useHumanAgentTag ? "MESSAGE_TAG" : "RESPONSE",
    ...(params.useHumanAgentTag ? { tag: "HUMAN_AGENT" } : {}),
  };
}

export function buildInstagramPrivateReplyMessageBody(params: {
  commentId: string;
  text: string;
}) {
  return {
    recipient: {
      comment_id: params.commentId,
    },
    message: {
      text: params.text,
    },
  };
}

/** POSTs a JSON body to the Instagram Graph API with a bearer token. */
export function postInstagramGraph(
  url: string,
  accessToken: string,
  body: unknown
) {
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/** The id Meta returns for a sent message (`message_id`) or comment reply (`id`). */
export async function readInstagramSendId(
  response: Response
): Promise<string | undefined> {
  const data = (await response.json().catch(() => ({}))) as {
    message_id?: unknown;
    id?: unknown;
  };
  if (typeof data.message_id === "string" && data.message_id) {
    return data.message_id;
  }
  return typeof data.id === "string" && data.id ? data.id : undefined;
}
