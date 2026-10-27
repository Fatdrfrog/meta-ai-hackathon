import connectDB from "@/lib/mongoose";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  downloadWhatsAppMediaUrl,
  getWhatsAppMediaInfoFromMeta,
} from "@/lib/media/whatsapp-media-graph";
import { resolveWhatsAppSendContext } from "@/lib/whatsapp/send-context";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import { normalizeWhatsAppMimeType } from "@/lib/whatsapp/media-types";

type ConversationMediaAccess = {
  _id: unknown;
  workspaceId?: string | null;
  channel?: string | null;
  sourceId?: string | null;
};

type MessageMediaAccess = {
  _id: unknown;
};

export type WhatsAppMediaDownload = {
  buffer: Buffer;
  contentType: string;
  sizeBytes: number;
  sha256: string;
};

const normalizeMimeType = (value: string | null | undefined) =>
  normalizeWhatsAppMimeType(value) || "application/octet-stream";

function parseDeclaredMediaSize(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export async function downloadOwnedWhatsAppMedia(params: {
  conversationId: string;
  mediaId: string;
  workspaceId?: string | null;
  sourceId?: string | null;
  inputMessageId?: string | null;
  allowedMimeTypes?: readonly string[];
  maxBytes?: number;
}): Promise<WhatsAppMediaDownload> {
  const mediaId = params.mediaId.trim();
  if (!mediaId) {
    throw new Error("Missing WhatsApp media id");
  }

  await connectDB();

  const conversation = await Conversation.findById(params.conversationId)
    .select("_id workspaceId channel sourceId")
    .lean<ConversationMediaAccess | null>()
    .exec();

  if (!conversation) {
    throw new Error("Conversation not found for WhatsApp media");
  }

  if (conversation.channel !== "whatsapp") {
    throw new Error("Media is not attached to a WhatsApp conversation");
  }

  if (
    params.workspaceId &&
    conversation.workspaceId &&
    params.workspaceId !== conversation.workspaceId
  ) {
    throw new Error(
      "Supplied workspace does not match the conversation workspace"
    );
  }
  const workspaceId = conversation.workspaceId;
  if (!workspaceId) {
    throw new Error("Conversation has no workspace association");
  }

  const mediaMessage = await Message.findOne({
    conversation: conversation._id,
    workspaceId,
    channel: "whatsapp",
    whatsappMediaId: mediaId,
    ...(params.inputMessageId ? { _id: params.inputMessageId } : {}),
  })
    .select("_id")
    .lean<MessageMediaAccess | null>()
    .exec();

  if (!mediaMessage) {
    throw new Error("WhatsApp media not found for this conversation");
  }

  const sendContext = await resolveWhatsAppSendContext({
    workspaceId,
    sourceId: params.sourceId || conversation.sourceId,
  });

  if (!sendContext) {
    throw new Error("WhatsApp credentials incomplete");
  }

  const mediaInfo = await getWhatsAppMediaInfoFromMeta({
    mediaId,
    accessToken: sendContext.accessToken,
    phoneNumberId: sendContext.phoneNumberId,
  });
  if (mediaInfo.id && mediaInfo.id !== mediaId) {
    throw new Error(
      "WhatsApp media metadata did not match the requested media"
    );
  }

  const allowedMimeTypes = params.allowedMimeTypes
    ? new Set(params.allowedMimeTypes.map(normalizeMimeType))
    : null;
  const declaredMimeType = normalizeMimeType(mediaInfo.mime_type);
  if (allowedMimeTypes && !allowedMimeTypes.has(declaredMimeType)) {
    throw new Error("WhatsApp media MIME type is not allowed");
  }
  const maxBytes = params.maxBytes;
  if (
    maxBytes !== undefined &&
    (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
  ) {
    throw new Error("WhatsApp media maximum size is invalid");
  }
  if (maxBytes !== undefined && mediaInfo.file_size !== undefined) {
    const declaredSize = parseDeclaredMediaSize(mediaInfo.file_size);
    if (declaredSize === null) {
      throw new Error("WhatsApp media metadata size is invalid");
    }
    if (declaredSize > maxBytes) {
      throw new Error("WhatsApp media exceeds the allowed size");
    }
  }

  const downloadResponse = await downloadWhatsAppMediaUrl({
    mediaUrl: mediaInfo.url,
    accessToken: sendContext.accessToken,
  });

  if (!downloadResponse.ok) {
    throw new Error(
      `Failed to fetch WhatsApp media: HTTP ${downloadResponse.status}`
    );
  }

  const contentLength = Number.parseInt(
    downloadResponse.headers.get("content-length") || "",
    10
  );
  if (
    maxBytes !== undefined &&
    Number.isFinite(contentLength) &&
    contentLength > maxBytes
  ) {
    throw new Error("WhatsApp media Content-Length exceeds the allowed size");
  }

  const responseMimeType = normalizeMimeType(
    downloadResponse.headers.get("content-type")
  );
  if (allowedMimeTypes && !allowedMimeTypes.has(responseMimeType)) {
    throw new Error("WhatsApp media response MIME type is not allowed");
  }
  if (
    mediaInfo.mime_type &&
    downloadResponse.headers.get("content-type") &&
    responseMimeType !== declaredMimeType
  ) {
    throw new Error("WhatsApp media response MIME type did not match metadata");
  }
  if (!downloadResponse.body) {
    throw new Error("WhatsApp media response body is unavailable");
  }

  const reader = downloadResponse.body.getReader();
  const chunks: Buffer[] = [];
  let observedBytes = 0;
  const hash = createHash("sha256");
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      observedBytes += chunk.byteLength;
      if (maxBytes !== undefined && observedBytes > maxBytes) {
        await reader.cancel("WhatsApp media stream exceeded the allowed size");
        throw new Error("WhatsApp media stream exceeded the allowed size");
      }
      hash.update(chunk);
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  if (observedBytes === 0) throw new Error("WhatsApp media response is empty");
  const sha256 = hash.digest("hex");
  if (mediaInfo.sha256) {
    const expected = mediaInfo.sha256.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expected)) {
      throw new Error("WhatsApp media metadata SHA-256 is invalid");
    }
    if (
      !timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sha256, "hex"))
    ) {
      throw new Error("WhatsApp media content SHA-256 did not match metadata");
    }
  }
  const buffer = Buffer.concat(chunks, observedBytes);

  return {
    buffer,
    contentType:
      declaredMimeType === "application/octet-stream"
        ? responseMimeType
        : declaredMimeType,
    sizeBytes: observedBytes,
    sha256,
  };
}
