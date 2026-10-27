import { analyzeAudio, analyzeImage, analyzeVideo } from "@/lib/ai/multimodal";
import {
  MAX_WORKSPACE_TEXT_AI_REQUEST_BYTES,
  withWorkspaceTextAiAction,
} from "@/lib/ai/workspace-ai-policy";
import {
  JsonBodyTooLargeError,
  readBodyBytesWithinLimit,
} from "@/lib/api/json-body";
import { getConversationAttachmentUrlByType } from "@/lib/conversation-attachments";
import { CrawlSsrfError, safeCrawlFetch } from "@/lib/crawler/url-safety";
import {
  CUSTOMER_MEDIA_PROVIDER_TTL_SECONDS,
  downloadCustomerMediaObject,
  parseCustomerMediaObject,
  resolveCustomerMediaReadUrl,
} from "@/lib/media/customer-media-read-url";
import { isMeaningfulMessageText } from "@/lib/media/message-media-utils";
import { isProviderLabelText } from "@/lib/provider-message-display";
import { isPermanentWhatsAppMediaProviderError } from "@/lib/media/whatsapp-media-graph";
import { downloadOwnedWhatsAppMedia } from "@/lib/media/whatsapp-media-server";
import { parseWhatsAppMediaProxyUrl } from "@/lib/media/whatsapp-media-url";
import { realtime } from "@/lib/realtime/server";
import Message from "@/models/message";
import type { PopulatedMessage } from "@/types/models";
import { createLogger } from "@icecore/shared/lib/logger";
import { isMetaGraphAuthorizationError } from "@icecore/shared/lib/meta/api";
import {
  reserveWorkspaceAiSpend,
  settleWorkspaceAiSpend,
  type WorkspaceAiSpendReservation,
} from "@icecore/airi-runtime/workspace-ai-spend";
import {
  CONVERSATION_MEDIA_ANALYSIS_ACTIVITY_CONTRACT_VERSION,
  type ConversationMediaTranscriptionCompletedSignalInput,
} from "@icecore/temporal";
import { normalizeMediaMimeType } from "@/lib/whatsapp/media-types";

import { updateClassificationInputMessageAndInvalidate } from "./classification-input-mutation";
import type {
  AiriLanguage,
  ConversationMediaMessageAnalysisResult,
  ConversationMediaTranscriptionSubmitter,
  MediaAnalysisContext,
  MediaResolution,
  ResolvedAnalysisMedia,
} from "./conversation-analysis-types";

const classificationMediaLog = createLogger("conversation-media-analysis");
const MAX_SAFE_MEDIA_ERROR_LENGTH = 240;
const MAX_SAFE_MEDIA_ERROR_NAME_LENGTH = 64;
const IMAGE_UNAVAILABLE_MARKER =
  "Image media is no longer available for AI analysis.";
const IMAGE_TOO_LARGE_MARKER = "Image is too large for AI analysis.";
// Platform-billed Vertex refuses remote URIs, so images and videos go inline as
// base64 (4 chars per 3 bytes) and must leave room for the prompt in one request.
const INLINE_MEDIA_MAX_BYTES = Math.floor(
  ((MAX_WORKSPACE_TEXT_AI_REQUEST_BYTES - 16_384) * 3) / 4
);
const AUDIO_UNAVAILABLE_MARKER =
  "Audio media is no longer available for AI analysis.";
const VIDEO_UNAVAILABLE_MARKER =
  "Video media is no longer available for AI analysis.";
const IMAGE_LIKE_MEDIA_TYPES = new Set(["image", "sticker"]);
const EXPLICITLY_NON_IMAGE_MEDIA_TYPES = new Set([
  "audio",
  "voice",
  "video",
  "document",
  "file",
]);
const IMAGE_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp)(\?|$)/i;
const NON_IMAGE_EXTENSION_REGEX =
  /\.(mp3|wav|ogg|opus|m4a|mp4|mov|webm|mkv|avi|pdf|docx?|xlsx?|pptx?|zip|rar)(\?|$)/i;

type MediaKind = "audio" | "voice" | "video";
type MediaAnalysisField = "audioAnalysis" | "videoAnalysis";

export const conversationTranscriptionBilling = {
  async claimSubmission(input: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    credentialSource: "workspace_source" | "platform";
    sourceId: string | null;
  }) {
    const claimed = await Message.findOneAndUpdate({
      _id: input.messageId,
      conversation: input.conversationId,
      workspaceId: input.workspaceId,
      "mediaAnalysis.submissionClaimedAt": null,
      "mediaAnalysis.providerRequestId": null,
    }, { $set: {
      "mediaAnalysis.submissionClaimedAt": new Date(),
      "mediaAnalysis.credentialSource": input.credentialSource,
      "mediaAnalysis.credentialSourceId": input.sourceId,
    } }, { new: true }).select("_id").lean();
    return Boolean(claimed);
  },
  async resolveAccess(workspaceId: string) {
    const [{ supabaseAdmin }, { resolveElevenLabsCredentialsForWorkspace }] =
      await Promise.all([
        import("@/lib/supabase/admin"),
        import("@/lib/elevenlabs/elevenlabs-source"),
      ]);
    return resolveElevenLabsCredentialsForWorkspace({
      supabase: supabaseAdmin,
      workspaceId,
      allowPlatform: true,
    });
  },
  async reserve(input: WorkspaceAiSpendReservation & { provider: "elevenlabs" }) {
    const { supabaseAdmin } = await import("@/lib/supabase/admin");
    return reserveWorkspaceAiSpend({ ...input, supabase: supabaseAdmin });
  },
  async settle(reservation: WorkspaceAiSpendReservation, actualCostMicros: number) {
    const { supabaseAdmin } = await import("@/lib/supabase/admin");
    await settleWorkspaceAiSpend({
      supabase: supabaseAdmin,
      reservation,
      actualCostMicros,
    });
  },
};

function safeMediaErrorText(
  value: unknown,
  fallback: string,
  maxLength = MAX_SAFE_MEDIA_ERROR_LENGTH
): string {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, maxLength);
}

export function serializeLogError(error: unknown): {
  message: string;
  name?: string;
} {
  if (error instanceof Error) {
    return {
      message: safeMediaErrorText(error.message, error.name || "Error"),
      name: safeMediaErrorText(
        error.name,
        "Error",
        MAX_SAFE_MEDIA_ERROR_NAME_LENGTH
      ),
    };
  }
  return { message: safeMediaErrorText(String(error), "Unknown error") };
}

function resolveImageAttachment(
  attachments: Array<{ url?: string; contentType?: string }> | undefined
): { url?: string; contentType?: string } | null {
  if (!Array.isArray(attachments) || attachments.length === 0) return null;
  const withImageMime = attachments.find(attachment =>
    normalizeMediaMimeType(attachment?.contentType).startsWith("image/")
  );
  if (withImageMime?.url) return withImageMime;
  const withImageExtension = attachments.find(attachment =>
    IMAGE_EXTENSION_REGEX.test(attachment?.url || "")
  );
  return withImageExtension?.url ? withImageExtension : null;
}

function shouldSkipImageAnalysis(message: {
  mediaType?: string | null;
  mimeType?: string | null;
  imageUrl?: string | null;
  attachments?: Array<{ url?: string; contentType?: string }>;
}): boolean {
  const mediaType = (message.mediaType || "").trim().toLowerCase();
  if (mediaType && EXPLICITLY_NON_IMAGE_MEDIA_TYPES.has(mediaType)) return true;
  const attachment = resolveImageAttachment(message.attachments);
  const imageUrl = message.imageUrl || attachment?.url || "";
  const mimeType = normalizeMediaMimeType(
    message.mimeType || attachment?.contentType
  );
  if (mimeType && !mimeType.startsWith("image/")) return true;
  if (!mimeType && NON_IMAGE_EXTENSION_REGEX.test(imageUrl)) return true;
  return Boolean(
    mediaType &&
      !IMAGE_LIKE_MEDIA_TYPES.has(mediaType) &&
      !mimeType.startsWith("image/") &&
      !IMAGE_EXTENSION_REGEX.test(imageUrl)
  );
}

async function resolveMediaForAnalysis(input: {
  url: string;
  mimeType?: string | null;
  conversationId: string;
  messageId: unknown;
  context: MediaAnalysisContext;
  analysisKind: "image" | "audio" | "video";
}): Promise<MediaResolution> {
  const proxyRef = parseWhatsAppMediaProxyUrl(input.url);
  if (!proxyRef) {
    // Vertex and ElevenLabs download the URL themselves, possibly later.
    return {
      kind: "resolved",
      media: {
        url: await resolveCustomerMediaReadUrl(
          input.url,
          CUSTOMER_MEDIA_PROVIDER_TTL_SECONDS
        ),
        mimeType: input.mimeType,
      },
    };
  }
  try {
    const media = await downloadOwnedWhatsAppMedia({
      conversationId: proxyRef.conversationId || input.conversationId,
      mediaId: proxyRef.mediaId,
      workspaceId: input.context.workspaceId,
      sourceId: input.context.sourceId,
    });
    return {
      kind: "resolved",
      media: {
        url: input.url,
        mimeType: media.contentType || input.mimeType,
        inlineDataBase64: media.buffer.toString("base64"),
      },
    };
  } catch (error) {
    const logContext = {
      conversation_id: input.conversationId,
      message_id: String(input.messageId),
      media_id: proxyRef.mediaId,
      analysis_kind: input.analysisKind,
      error: serializeLogError(error),
    };
    if (
      isPermanentWhatsAppMediaProviderError(error) &&
      !isMetaGraphAuthorizationError(error)
    ) {
      classificationMediaLog.info("classification.media_unavailable", {
        ...logContext,
        reason: "provider_media_unavailable",
      });
      return { kind: "permanently_unavailable" };
    }
    classificationMediaLog.warn(
      "classification.media_resolution_failed",
      logContext
    );
    throw error;
  }
}

function buildMediaAnalysisPatch(input: {
  status:
    | "queued"
    | "processing"
    | "submitted"
    | "completed"
    | "failed"
    | "skipped";
  kind: MediaKind;
  workflowId?: string | null;
  sourceId?: string | null;
  requestedAt?: Date | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  lastError?: string | null;
  transcriptSource?: string | null;
  analysisSource?: string | null;
  provider?: string | null;
  providerRequestId?: string | null;
  providerWebhookId?: string | null;
}): Record<string, unknown> {
  return {
    status: input.status,
    kind: input.kind,
    workflowId: input.workflowId || null,
    sourceId: input.sourceId || null,
    ...(input.requestedAt ? { requestedAt: input.requestedAt } : {}),
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    ...(input.completedAt ? { completedAt: input.completedAt } : {}),
    lastError: input.lastError || null,
    transcriptSource: input.transcriptSource || null,
    analysisSource: input.analysisSource || null,
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.providerRequestId !== undefined
      ? { providerRequestId: input.providerRequestId }
      : {}),
    ...(input.providerWebhookId !== undefined
      ? { providerWebhookId: input.providerWebhookId }
      : {}),
    contractVersion: CONVERSATION_MEDIA_ANALYSIS_ACTIVITY_CONTRACT_VERSION,
  };
}

function flattenMediaAnalysisPatch(
  patch: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(patch).map(([key, value]) => [`mediaAnalysis.${key}`, value])
  );
}

async function persistTransportMediaAnalysis(input: {
  conversationId: string;
  messageId: unknown;
  mediaAnalysis: Record<string, unknown>;
}): Promise<void> {
  await updateClassificationInputMessageAndInvalidate({
    conversationId: input.conversationId,
    messageId: String(input.messageId),
    set: flattenMediaAnalysisPatch(input.mediaAnalysis),
    semanticPaths: [],
  });
}

async function persistSemanticMediaAnalysis(input: {
  conversationId: string;
  messageId: unknown;
  semanticSet: Record<string, unknown>;
  semanticPaths: string[];
  mediaAnalysis?: Record<string, unknown>;
  realtimePayload: Record<string, unknown>;
}): Promise<boolean> {
  const result = await updateClassificationInputMessageAndInvalidate({
    conversationId: input.conversationId,
    messageId: String(input.messageId),
    set: {
      ...input.semanticSet,
      ...(input.mediaAnalysis
        ? flattenMediaAnalysisPatch(input.mediaAnalysis)
        : {}),
    },
    semanticPaths: input.semanticPaths,
  });
  if (!result.semanticChanged) return false;
  try {
    await realtime.trigger(
      `private-conversation-${input.conversationId}`,
      "message-updated",
      input.realtimePayload
    );
  } catch (error) {
    classificationMediaLog.warn("classification.media_realtime_failed", {
      conversation_id: input.conversationId,
      message_id: String(input.messageId),
      event: "message-updated",
      error: serializeLogError(error),
    });
  }
  return true;
}

function mediaAnalysisRealtimePayload(input: {
  messageId: unknown;
  field: MediaAnalysisField;
  analysisText: string;
  transcriptText?: string | null;
  mediaAnalysis: Record<string, unknown>;
}) {
  return {
    messageId: String(input.messageId),
    [input.field]: input.analysisText,
    ...(input.transcriptText ? { text: input.transcriptText } : {}),
    mediaAnalysis: input.mediaAnalysis,
  };
}

type ImageResolution = MediaResolution | { kind: "too_large" };

const REMOTE_IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000;
const REMOTE_IMAGE_USER_AGENT =
  "Airi.chat Media Analysis/1.0 (https://airi.chat; support@airi.chat)";

/**
 * Images outside the customer buckets and the WhatsApp proxy (business media
 * such as template headers, external links). Platform-billed Vertex refuses a
 * remote URI (reported as workspace_ai_spend_limit), which failed the whole
 * classification and retried it, so the bytes are read here within the same
 * inline limit.
 */
async function downloadRemoteImageForAnalysis(input: {
  url: string;
  mimeType?: string | null;
  conversationId: string;
  messageId: unknown;
}): Promise<ImageResolution> {
  const unavailable = (reason: string): ImageResolution => {
    classificationMediaLog.info("classification.media_unavailable", {
      conversation_id: input.conversationId,
      message_id: String(input.messageId),
      analysis_kind: "image",
      reason,
    });
    return { kind: "permanently_unavailable" };
  };
  if (!/^https?:\/\//i.test(input.url)) {
    return unavailable("unsupported_image_url");
  }

  // safeCrawlFetch's own timeout ends with the headers; this bounds the body.
  const deadline = new AbortController();
  const timeoutId = setTimeout(
    () => deadline.abort(),
    REMOTE_IMAGE_DOWNLOAD_TIMEOUT_MS
  );
  try {
    let response: Response;
    try {
      response = await safeCrawlFetch(input.url, {
        timeoutMs: REMOTE_IMAGE_DOWNLOAD_TIMEOUT_MS,
        userAgent: REMOTE_IMAGE_USER_AGENT,
        signal: deadline.signal,
      });
    } catch (error) {
      if (error instanceof CrawlSsrfError) {
        return unavailable("unsafe_image_url");
      }
      throw error;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status >= 400 && response.status < 500) {
        return unavailable("remote_image_unavailable");
      }
      throw new Error(`Image download failed: HTTP ${response.status}`);
    }
    const contentType = normalizeMediaMimeType(
      response.headers.get("content-type")
    );
    if (contentType && !contentType.startsWith("image/")) {
      await response.body?.cancel().catch(() => undefined);
      return unavailable("remote_media_not_image");
    }
    const bytes = await readBodyBytesWithinLimit(
      response,
      INLINE_MEDIA_MAX_BYTES,
      { signal: deadline.signal }
    );
    return {
      kind: "resolved",
      media: {
        url: input.url,
        mimeType: contentType || input.mimeType,
        inlineDataBase64: Buffer.from(bytes).toString("base64"),
      },
    };
  } catch (error) {
    if (error instanceof JsonBodyTooLargeError) return { kind: "too_large" };
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function resolveImageForAnalysis(input: {
  url: string;
  mimeType?: string | null;
  conversationId: string;
  messageId: unknown;
  context: MediaAnalysisContext;
}): Promise<ImageResolution> {
  const object = parseCustomerMediaObject(input.url);
  if (!object && !parseWhatsAppMediaProxyUrl(input.url)) {
    return downloadRemoteImageForAnalysis(input);
  }
  if (!object) {
    const resolution = await resolveMediaForAnalysis({
      ...input,
      analysisKind: "image",
    });
    const inline =
      resolution.kind === "resolved" ? resolution.media.inlineDataBase64 : null;
    return inline &&
      Buffer.byteLength(inline, "base64") > INLINE_MEDIA_MAX_BYTES
      ? { kind: "too_large" }
      : resolution;
  }

  const download = await downloadCustomerMediaObject(
    object,
    INLINE_MEDIA_MAX_BYTES
  );
  if (download.kind === "missing") {
    classificationMediaLog.info("classification.media_unavailable", {
      conversation_id: input.conversationId,
      message_id: String(input.messageId),
      analysis_kind: "image",
      reason: "customer_media_missing",
    });
    return { kind: "permanently_unavailable" };
  }
  if (download.kind === "too_large") return { kind: "too_large" };
  return {
    kind: "resolved",
    media: {
      url: input.url,
      mimeType: download.contentType || input.mimeType,
      inlineDataBase64: Buffer.from(download.bytes).toString("base64"),
    },
  };
}

export async function processConversationImageAnalysis(input: {
  conversationId: string;
  language: AiriLanguage;
  context: MediaAnalysisContext;
}): Promise<{ semanticChanged: boolean }> {
  const messages = (await Message.find({
    conversation: input.conversationId,
    imageAnalysis: null,
    mediaType: { $nin: ["audio", "voice", "video", "document", "file"] },
    $or: [
      { imageUrl: { $ne: null } },
      { "attachments.0.url": { $exists: true, $ne: null } },
    ],
  }).select(
    "imageUrl imageAnalysis attachments mediaType mimeType"
  )) as unknown as PopulatedMessage[];
  let semanticChanged = false;

  for (const message of messages) {
    if (shouldSkipImageAnalysis(message)) continue;
    const attachment = resolveImageAttachment(message.attachments);
    const imageUrl = message.imageUrl || attachment?.url;
    if (!imageUrl) continue;
    let resolution: ImageResolution;
    try {
      resolution = await resolveImageForAnalysis({
        url: imageUrl,
        mimeType: message.mimeType || attachment?.contentType,
        conversationId: input.conversationId,
        messageId: message._id,
        context: input.context,
      });
    } catch (error) {
      // Meta refuses the media (an expired id answers 100/33). Retrying won't help,
      // so classify without it; nothing is stored, so a later revision retries.
      if (!isMetaGraphAuthorizationError(error)) throw error;
      classificationMediaLog.info("classification.media_skipped", {
        conversation_id: input.conversationId,
        message_id: String(message._id),
        analysis_kind: "image",
        reason: "provider_media_inaccessible",
      });
      continue;
    }
    const imageAnalysis =
      resolution.kind === "permanently_unavailable"
        ? IMAGE_UNAVAILABLE_MARKER
        : resolution.kind === "too_large"
          ? IMAGE_TOO_LARGE_MARKER
          : await analyzeImage(
            resolution.media.url,
            input.language,
            resolution.media.mimeType,
            { inlineDataBase64: resolution.media.inlineDataBase64 }
          );
    const changed = await persistSemanticMediaAnalysis({
      conversationId: input.conversationId,
      messageId: message._id,
      semanticSet: { imageAnalysis },
      semanticPaths: ["imageAnalysis"],
      realtimePayload: {
        messageId: String(message._id),
        imageAnalysis,
      },
    });
    semanticChanged ||= changed;
  }
  return { semanticChanged };
}

/** Stored text that is a transcript: not a placeholder or a provider label. */
function isStoredTranscript(value: unknown): value is string {
  return isMeaningfulMessageText(value) && !isProviderLabelText(value);
}

async function loadLatestMeaningfulTranscript(
  messageId: unknown
): Promise<string | null> {
  const latest = (await Message.findById(messageId).select("text").lean()) as {
    text?: string | null;
  } | null;
  return isStoredTranscript(latest?.text) ? latest.text.trim() : null;
}

/**
 * The video bytes Vertex receives inline. Platform billing takes media only
 * this way, so a video over the request limit (most of them) gets none and is
 * analyzed from its transcript.
 */
async function readInlineVideoForAnalysis(
  media: Pick<ResolvedAnalysisMedia, "inlineDataBase64">,
  storedUrl: string
): Promise<string | undefined> {
  if (media.inlineDataBase64) {
    return Buffer.byteLength(media.inlineDataBase64, "base64") <=
      INLINE_MEDIA_MAX_BYTES
      ? media.inlineDataBase64
      : undefined;
  }
  const object = parseCustomerMediaObject(storedUrl);
  if (!object) return undefined;
  const download = await downloadCustomerMediaObject(
    object,
    INLINE_MEDIA_MAX_BYTES
  );
  return download.kind === "downloaded"
    ? Buffer.from(download.bytes).toString("base64")
    : undefined;
}

function getStoredProviderRequestId(message: PopulatedMessage): string | null {
  const requestId = message.mediaAnalysis?.providerRequestId;
  return typeof requestId === "string" && requestId.trim()
    ? requestId.trim()
    : null;
}

function buildElevenLabsWebhookMetadata(input: {
  workflowId?: string | null;
  workspaceId: string;
  conversationId: string;
  messageId: unknown;
  mediaType: MediaKind;
}) {
  return {
    workflowId: input.workflowId || "",
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    messageId: String(input.messageId),
    mediaType: input.mediaType,
  };
}

function inlineDataToBuffer(value?: string | null): Buffer | null {
  if (!value) return null;
  try {
    const buffer = Buffer.from(value, "base64");
    return buffer.length ? buffer : null;
  } catch {
    return null;
  }
}

function readInlineTranscription(input: {
  deliveryMode: "webhook" | "inline";
  transcriptText: string | null;
}): string | null {
  if (input.deliveryMode !== "inline") return null;
  return isMeaningfulMessageText(input.transcriptText)
    ? input.transcriptText.trim()
    : null;
}

function resolveMessageMediaLocation(input: {
  message: PopulatedMessage;
  mediaType: MediaKind;
}): { url: string; mimeType?: string | null } {
  const attachmentType = input.mediaType === "video" ? "video" : "audio";
  const typedAttachment = getConversationAttachmentUrlByType(
    input.message.attachments,
    attachmentType
  );
  const fallbackAttachment = getConversationAttachmentUrlByType(
    input.message.attachments,
    "any"
  );
  return {
    url:
      input.message.imageUrl ||
      typedAttachment.url ||
      fallbackAttachment.url ||
      "",
    mimeType:
      input.message.mimeType ||
      typedAttachment.contentType ||
      fallbackAttachment.contentType ||
      null,
  };
}

async function processSubmittedMediaAnalysis(input: {
  conversationId: string;
  language: AiriLanguage;
  message: PopulatedMessage;
  context: MediaAnalysisContext;
  workflowId?: string | null;
  kind: MediaKind;
  field: MediaAnalysisField;
  unavailableMarker: string;
  submit: (
    media: ResolvedAnalysisMedia,
    metadata: ReturnType<typeof buildElevenLabsWebhookMetadata>
  ) => Promise<{
    requestId: string;
    deliveryMode: "webhook" | "inline";
    transcriptText: string | null;
  }>;
  analyze: (
    media: ResolvedAnalysisMedia,
    transcript: string,
    storedUrl: string
  ) => Promise<string>;
}): Promise<ConversationMediaMessageAnalysisResult> {
  await persistTransportMediaAnalysis({
    conversationId: input.conversationId,
    messageId: input.message._id,
    mediaAnalysis: buildMediaAnalysisPatch({
      status: "processing",
      kind: input.kind,
      workflowId: input.workflowId,
      sourceId: input.context.sourceId,
      startedAt: new Date(),
    }),
  });

  const location = resolveMessageMediaLocation({
    message: input.message,
    mediaType: input.kind,
  });
  if (!location.url) {
    const error = `${input.kind === "video" ? "Video" : "Audio"} media URL is missing for AI analysis.`;
    await persistTransportMediaAnalysis({
      conversationId: input.conversationId,
      messageId: input.message._id,
      mediaAnalysis: buildMediaAnalysisPatch({
        status: "skipped",
        kind: input.kind,
        workflowId: input.workflowId,
        sourceId: input.context.sourceId,
        completedAt: new Date(),
        lastError: error,
      }),
    });
    return {
      status: "skipped",
      transcriptStored: false,
      analysisStored: false,
      error,
    };
  }

  const resolution = await resolveMediaForAnalysis({
    url: location.url,
    mimeType: location.mimeType,
    conversationId: input.conversationId,
    messageId: input.message._id,
    context: input.context,
    analysisKind: input.kind === "video" ? "video" : "audio",
  });
  if (resolution.kind === "permanently_unavailable") {
    const skippedPatch = buildMediaAnalysisPatch({
      status: "skipped",
      kind: input.kind,
      workflowId: input.workflowId,
      sourceId: input.context.sourceId,
      completedAt: new Date(),
      lastError: input.unavailableMarker,
    });
    const changed = await persistSemanticMediaAnalysis({
      conversationId: input.conversationId,
      messageId: input.message._id,
      semanticSet: { [input.field]: input.unavailableMarker },
      semanticPaths: [input.field],
      mediaAnalysis: skippedPatch,
      realtimePayload: mediaAnalysisRealtimePayload({
        messageId: input.message._id,
        field: input.field,
        analysisText: input.unavailableMarker,
        mediaAnalysis: skippedPatch,
      }),
    });
    return {
      status: "skipped",
      transcriptStored: false,
      analysisStored: changed,
      error: input.unavailableMarker,
    };
  }

  let transcriptText: string | null = null;
  let transcriptSource: string | null = null;
  let transcript = isStoredTranscript(input.message.text)
    ? input.message.text.trim()
    : await loadLatestMeaningfulTranscript(input.message._id);
  if (transcript) transcriptSource = "stored_message_text";

  if (!transcript) {
    const storedRequestId = getStoredProviderRequestId(input.message);
    if (storedRequestId) {
      await persistTransportMediaAnalysis({
        conversationId: input.conversationId,
        messageId: input.message._id,
        mediaAnalysis: buildMediaAnalysisPatch({
          status: "submitted",
          kind: input.kind,
          workflowId: input.workflowId,
          sourceId: input.context.sourceId,
          transcriptSource: "elevenlabs_async",
          provider: "elevenlabs",
          providerRequestId: storedRequestId,
          providerWebhookId: process.env.ELEVENLABS_STT_WEBHOOK_ID || null,
        }),
      });
      return {
        status: "submitted",
        transcriptStored: false,
        analysisStored: false,
        providerRequestId: storedRequestId,
      };
    }

    const submission = await input.submit(
      resolution.media,
      buildElevenLabsWebhookMetadata({
        workflowId: input.workflowId,
        workspaceId: input.context.workspaceId,
        conversationId: input.conversationId,
        messageId: input.message._id,
        mediaType: input.kind,
      })
    );
    if (submission.deliveryMode === "inline") {
      const inlineTranscript = readInlineTranscription(submission);
      if (!inlineTranscript) {
        throw new Error(
          `ElevenLabs returned an empty ${input.kind === "video" ? "video" : "audio"} transcript.`
        );
      }
      transcript = inlineTranscript;
      transcriptText = inlineTranscript;
      transcriptSource = "elevenlabs_inline";
    } else {
      await persistTransportMediaAnalysis({
        conversationId: input.conversationId,
        messageId: input.message._id,
        mediaAnalysis: buildMediaAnalysisPatch({
          status: "submitted",
          kind: input.kind,
          workflowId: input.workflowId,
          sourceId: input.context.sourceId,
          transcriptSource: "elevenlabs_async",
          provider: "elevenlabs",
          providerRequestId: submission.requestId,
          providerWebhookId: process.env.ELEVENLABS_STT_WEBHOOK_ID || null,
        }),
      });
      return {
        status: "submitted",
        transcriptStored: false,
        analysisStored: false,
        providerRequestId: submission.requestId,
      };
    }
  }

  const analysisText = await withWorkspaceTextAiAction(
    {
      workspaceId: input.context.workspaceId,
      actionId: `media-analysis:${input.message._id}`,
    },
    () => input.analyze(resolution.media, transcript, location.url)
  );
  // A provider label ("Tagged in Instagram story") stays the message text;
  // its transcript only informs the analysis.
  if (isProviderLabelText(input.message.text)) transcriptText = null;
  const completedPatch = buildMediaAnalysisPatch({
    status: "completed",
    kind: input.kind,
    workflowId: input.workflowId,
    sourceId: input.context.sourceId,
    completedAt: new Date(),
    transcriptSource,
    analysisSource:
      input.field === "videoAnalysis" ? "video_analysis" : "audio_analysis",
  });
  const semanticSet: Record<string, unknown> = {
    [input.field]: analysisText,
  };
  const semanticPaths: string[] = [input.field];
  if (transcriptText) {
    semanticSet.text = transcriptText;
    semanticPaths.push("text");
  }
  const changed = await persistSemanticMediaAnalysis({
    conversationId: input.conversationId,
    messageId: input.message._id,
    semanticSet,
    semanticPaths,
    mediaAnalysis: completedPatch,
    realtimePayload: mediaAnalysisRealtimePayload({
      messageId: input.message._id,
      field: input.field,
      analysisText,
      transcriptText,
      mediaAnalysis: completedPatch,
    }),
  });
  return {
    status: "completed",
    transcriptStored: changed && Boolean(transcriptText),
    analysisStored: changed,
  };
}

export async function processAudioMessageAnalysis(input: {
  conversationId: string;
  language: AiriLanguage;
  message: PopulatedMessage;
  context: MediaAnalysisContext;
  workflowId?: string | null;
  transcriptionSubmitter: Pick<
    ConversationMediaTranscriptionSubmitter,
    "submitAudio"
  >;
}): Promise<ConversationMediaMessageAnalysisResult> {
  const kind = input.message.mediaType === "voice" ? "voice" : "audio";
  return processSubmittedMediaAnalysis({
    ...input,
    kind,
    field: "audioAnalysis",
    unavailableMarker: AUDIO_UNAVAILABLE_MARKER,
    submit: async (media, metadata) => {
      const fileBuffer = inlineDataToBuffer(media.inlineDataBase64);
      return input.transcriptionSubmitter.submitAudio(
        media.url,
        media.mimeType || undefined,
        metadata,
        fileBuffer ? { fileBuffer } : {}
      );
    },
    analyze: (media, transcript) =>
      analyzeAudio(media.url, input.language, media.mimeType || undefined, {
        precomputedTranscript: transcript,
      }),
  });
}

export async function processVideoMessageAnalysis(input: {
  conversationId: string;
  language: AiriLanguage;
  message: PopulatedMessage;
  context: MediaAnalysisContext;
  workflowId?: string | null;
  transcriptionSubmitter: Pick<
    ConversationMediaTranscriptionSubmitter,
    "submitVideo"
  >;
}): Promise<ConversationMediaMessageAnalysisResult> {
  return processSubmittedMediaAnalysis({
    ...input,
    kind: "video",
    field: "videoAnalysis",
    unavailableMarker: VIDEO_UNAVAILABLE_MARKER,
    submit: async (media, metadata) => {
      const fileBuffer = inlineDataToBuffer(media.inlineDataBase64);
      return input.transcriptionSubmitter.submitVideo(
        media.url,
        media.mimeType || undefined,
        metadata,
        fileBuffer ? { fileBuffer } : {}
      );
    },
    analyze: async (media, transcript, storedUrl) =>
      analyzeVideo(media.url, input.language, media.mimeType || undefined, {
        precomputedTranscript: transcript,
        inlineDataBase64: await readInlineVideoForAnalysis(media, storedUrl),
      }),
  });
}

export type { MediaResolution } from "./conversation-analysis-types";

export async function completeConversationMediaMessageAnalysis(input: {
  conversationId: string;
  language: AiriLanguage;
  message: PopulatedMessage;
  context: MediaAnalysisContext;
  workflowId?: string | null;
  transcription: ConversationMediaTranscriptionCompletedSignalInput;
}): Promise<ConversationMediaMessageAnalysisResult> {
  const kind: MediaKind =
    input.message.mediaType === "video"
      ? "video"
      : input.message.mediaType === "voice"
        ? "voice"
        : "audio";
  const field: MediaAnalysisField =
    kind === "video" ? "videoAnalysis" : "audioAnalysis";
  const requestId = input.transcription.requestId.trim();
  if (input.transcription.status === "failed") {
    const error = safeMediaErrorText(
      input.transcription.error,
      "ElevenLabs transcription failed."
    );
    await persistTransportMediaAnalysis({
      conversationId: input.conversationId,
      messageId: input.message._id,
      mediaAnalysis: buildMediaAnalysisPatch({
        status: "failed",
        kind,
        workflowId: input.workflowId,
        sourceId: input.context.sourceId,
        completedAt: new Date(),
        lastError: error,
        transcriptSource: "elevenlabs_async",
        provider: "elevenlabs",
        providerRequestId: requestId,
        providerWebhookId: process.env.ELEVENLABS_STT_WEBHOOK_ID || null,
      }),
    });
    return {
      status: "failed",
      transcriptStored: false,
      analysisStored: false,
      providerRequestId: requestId,
      error,
    };
  }

  const transcriptText = input.transcription.text?.trim() || "";
  if (!isMeaningfulMessageText(transcriptText)) {
    const error = "ElevenLabs transcription webhook did not include text.";
    await persistTransportMediaAnalysis({
      conversationId: input.conversationId,
      messageId: input.message._id,
      mediaAnalysis: buildMediaAnalysisPatch({
        status: "failed",
        kind,
        workflowId: input.workflowId,
        sourceId: input.context.sourceId,
        completedAt: new Date(),
        lastError: error,
        transcriptSource: "elevenlabs_async",
        provider: "elevenlabs",
        providerRequestId: requestId,
        providerWebhookId: process.env.ELEVENLABS_STT_WEBHOOK_ID || null,
      }),
    });
    return {
      status: "failed",
      transcriptStored: false,
      analysisStored: false,
      providerRequestId: requestId,
      error,
    };
  }

  const location = resolveMessageMediaLocation({
    message: input.message,
    mediaType: kind,
  });
  const analysisText = await withWorkspaceTextAiAction(
    {
      workspaceId: input.context.workspaceId,
      actionId: `media-analysis:${input.message._id}`,
    },
    async () =>
      kind === "video"
        ? analyzeVideo(
            await resolveCustomerMediaReadUrl(
              location.url,
              CUSTOMER_MEDIA_PROVIDER_TTL_SECONDS
            ),
            input.language,
            location.mimeType || undefined,
            {
              precomputedTranscript: transcriptText,
              inlineDataBase64: await readInlineVideoForAnalysis(
                {},
                location.url
              ),
            }
          )
        : analyzeAudio(
            location.url,
            input.language,
            location.mimeType || undefined,
            { precomputedTranscript: transcriptText }
          )
  );
  const completedPatch = buildMediaAnalysisPatch({
    status: "completed",
    kind,
    workflowId: input.workflowId,
    sourceId: input.context.sourceId,
    completedAt: new Date(),
    transcriptSource: "elevenlabs_async",
    analysisSource: kind === "video" ? "video_analysis" : "audio_analysis",
    provider: "elevenlabs",
    providerRequestId: requestId,
    providerWebhookId: process.env.ELEVENLABS_STT_WEBHOOK_ID || null,
  });
  // A provider label stays the message text; the transcript informed the
  // analysis above.
  const storedTranscript = isProviderLabelText(input.message.text)
    ? null
    : transcriptText;
  const changed = await persistSemanticMediaAnalysis({
    conversationId: input.conversationId,
    messageId: input.message._id,
    semanticSet: {
      [field]: analysisText,
      ...(storedTranscript ? { text: storedTranscript } : {}),
    },
    semanticPaths: storedTranscript ? [field, "text"] : [field],
    mediaAnalysis: completedPatch,
    realtimePayload: mediaAnalysisRealtimePayload({
      messageId: input.message._id,
      field,
      analysisText,
      transcriptText: storedTranscript,
      mediaAnalysis: completedPatch,
    }),
  });
  return {
    status: "completed",
    transcriptStored: changed && Boolean(storedTranscript),
    analysisStored: changed,
    providerRequestId: requestId,
  };
}
