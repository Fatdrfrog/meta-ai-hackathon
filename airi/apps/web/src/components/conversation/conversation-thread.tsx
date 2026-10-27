"use client";

import { ConversationMessageMarkdown } from "@/components/conversation/conversation-message-markdown";
import {
  OutboundWhatsAppMessageBubble,
  type MessageTextUpdatedHandler,
} from "@/components/conversation/outbound-whatsapp-message-shell";
import { VideoPlayer } from "@/components/conversation/video-player";
import {
  resolveWhatsAppServiceMessageCardPreview,
  WhatsAppServiceMessageCard,
} from "@/components/conversation/whatsapp-service-message-card";
import { waActionButton } from "@/components/scenarios/builders/whatsapp/action-colors";
import {
  AudioPlayerButton,
  AudioPlayerDuration,
  AudioPlayerError,
  AudioPlayerProgress,
  AudioPlayerProvider,
  AudioPlayerSpeed,
  AudioPlayerTime,
  type MediaLoadErrorInfo,
} from "@/components/ui/audio-player";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { MediaLoadError } from "@/components/ui/media-load-error";
import {
  Message,
  MessageAvatar,
  MessageContent,
} from "@/components/ui/message";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { normalizeMessagePreviewText } from "@/features/panel/requests/message-preview";
import {
  formatConversationAttachmentFileSize,
  getConversationAttachmentUrlByType,
  isConversationAttachmentLabelOnlyText,
  isConversationAudioMimeType,
  isConversationImageMimeType,
  isConversationVideoMimeType,
} from "@/lib/conversation-attachments";
import {
  buildReplyQuotePreviewIndex,
  resolveReplyQuotePreviewText,
} from "@/lib/conversation/reply-quote-preview";
import { stripInstagramCommentMeta } from "@/lib/instagram/comment-format";
import { isMediaPlaceholderText } from "@/lib/media/message-media-utils";
import {
  createStableMediaLinks,
  withStableMediaLinks,
} from "@/lib/media/stable-media-links";
import { resolveTelegramSenderDisplayName } from "@/lib/telegram/message-identity";
import { captureClientEvent } from "@/lib/posthog/client";
import { cn, groupMessagesByDate } from "@/lib/utils";
import { sanitizeWhatsAppUserFacingText } from "@icecore/shared/lib/whatsapp/message-id";
import { isStoredWhatsAppTextMessageEditable } from "@icecore/shared/lib/whatsapp/message-mutations";
import { hasStoredWhatsAppServiceMessage } from "@icecore/shared/lib/whatsapp/service-message-preview";
import { resolveWhatsAppReferralSourcePlatform } from "@icecore/whatsapp/referralFields";
import { extractWhatsAppTemplateNameFromText } from "@/lib/whatsapp/templates/preview";
import type { PopulatedMessage } from "@/types/models";
import type {
  StoredWhatsAppFlowFieldMetadataPreview,
  StoredWhatsAppTemplatePreview,
} from "@icecore/shared/types/message-preview";
import {
  Check,
  CheckCheck,
  CircleAlert,
  ExternalLink,
  FileText,
  LayoutTemplate,
  Loader2,
  Mail,
  MapPin,
  Mic,
  Minus,
  Package,
  Phone,
  Plus,
  Reply,
  RotateCcw,
  ShoppingCart,
  UserRound,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readTrimmedString } from "@icecore/shared/lib/value-utils";

type MessageReaction = NonNullable<PopulatedMessage["reactions"]>[number];

type ReactionGroup = {
  emoji: string;
  count: number;
  authors: Array<{ authorId: string; authorName: string }>;
};

type ImagePan = {
  x: number;
  y: number;
};

const highlightStyle = `
  @keyframes highlight-pulse {
    0% { background-color: transparent; }
    50% { background-color: #3b82f6; box-shadow: 0 0 12px #3b82f633; }
    100% { background-color: transparent; }
  }
  .highlight-animation {
    animation: highlight-pulse 1.5s ease-out;
    border-radius: 0.75rem;
  }
`;

function normalizeReactionAuthorId(authorId: string | number): string {
  if (typeof authorId === "number") return String(authorId);
  return authorId;
}

function getReactionGroups(reactions?: MessageReaction[]): ReactionGroup[] {
  if (!reactions || reactions.length === 0) {
    return [];
  }

  const grouped = new Map<string, ReactionGroup>();
  for (const reaction of reactions) {
    const emoji = reaction.emoji?.trim();
    if (!emoji) continue;

    const authorId = normalizeReactionAuthorId(reaction.authorId);
    const authorName = reaction.authorName?.trim() || "User";
    const existing = grouped.get(emoji);

    if (!existing) {
      grouped.set(emoji, {
        emoji,
        count: 1,
        authors: [{ authorId, authorName }],
      });
      continue;
    }

    if (!existing.authors.some(author => author.authorId === authorId)) {
      existing.authors.push({ authorId, authorName });
      existing.count += 1;
    }
  }

  return Array.from(grouped.values()).sort((a, b) => b.count - a.count);
}

const AUDIO_PLACEHOLDER_KINDS = new Set(["audio", "voice"]);
const NON_IMAGE_PLACEHOLDER_KINDS = new Set([
  "audio",
  "voice",
  "video",
  "document",
  "sticker",
  "file",
]);

/** The media word of a stored placeholder such as "[voice message]". */
function getMediaPlaceholderKind(text: string | undefined): string | null {
  if (!isMediaPlaceholderText(text)) return null;
  return /^\[(?:round\s+)?(\w+)/i.exec(text.trim())?.[1]?.toLowerCase() ?? null;
}

const MESSAGE_BUBBLE_MAX_WIDTH_CLASS = "max-w-[92%] md:max-w-[min(72%,38rem)]";
const STRUCTURED_MESSAGE_WIDTH_CLASS =
  "w-[min(19rem,calc(100vw-4.5rem))] max-w-full min-w-0 md:w-[360px]";
const MEDIA_MESSAGE_CARD_WIDTH_CLASS =
  "w-[min(18rem,calc(100vw-5rem))] max-w-full min-w-0";
const VISUAL_MEDIA_MESSAGE_WIDTH_CLASS =
  "w-fit max-w-[min(28rem,calc(100vw-5rem))] min-w-0";
const IMAGE_ZOOM_MIN = 1;
const IMAGE_ZOOM_MAX = 4;
const IMAGE_ZOOM_STEP = 0.25;
const IMAGE_PAN_DRAG_THRESHOLD = 2;

function clampImageZoom(value: number): number {
  return Math.min(
    IMAGE_ZOOM_MAX,
    Math.max(IMAGE_ZOOM_MIN, Number(value.toFixed(2)))
  );
}

// Inline image thumbnail. A bare `<img>` that fails leaves only the browser's
// broken-image glyph, and clicking it opens a dialog that fails the same way.
// This gives images the treatment the audio and video players already have: an
// error card with a retry and a direct link, plus a single load-failure report.
function ConversationImageThumbnail({
  src,
  alt,
  onOpen,
  onLoadError,
}: {
  src: string;
  alt: string;
  onOpen: () => void;
  onLoadError: (info: MediaLoadErrorInfo) => void;
}) {
  const [hasError, setHasError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [renderedSrc, setRenderedSrc] = useState(src);

  // Reset on a new src so a fresh attachment does not inherit a stale error.
  // The `<img>` fires `onError` once per load attempt, and retry remounts it
  // with a new key, so each attempt reports exactly once without a guard.
  if (src !== renderedSrc) {
    setRenderedSrc(src);
    setHasError(false);
  }

  const handleError = () => {
    onLoadError({ reason: "error" });
    setHasError(true);
  };

  const retry = () => {
    setHasError(false);
    setReloadKey(key => key + 1);
  };

  if (hasError) {
    return (
      <MediaLoadError
        message="Could not load image."
        href={src}
        onRetry={retry}
        className="mb-1.5 flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-xs text-destructive"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className="mb-1.5 inline-block max-w-full overflow-hidden rounded-lg align-top focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
      aria-label={alt}
    >
      <img
        key={reloadKey}
        src={src}
        alt={alt}
        onError={handleError}
        className="max-h-[360px] max-w-full rounded-lg object-contain"
      />
    </button>
  );
}

// Component to highlight search matches in text
function HighlightedText({
  text,
  searchQuery,
}: {
  text: string;
  searchQuery: string | null;
}) {
  if (!searchQuery || !searchQuery.trim()) {
    return <>{text}</>;
  }

  const escapedQuery = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escapedQuery})`, "gi");
  const parts = text.split(regex);

  return (
    <>
      {parts.map((part, index) => {
        // Check if this part matches the search query (case-insensitive)
        // Use a new regex instance for each test to avoid lastIndex issues
        const testRegex = new RegExp(`^${escapedQuery}$`, "i");
        if (testRegex.test(part)) {
          return (
            <mark
              key={index}
              className="bg-yellow-200 dark:bg-yellow-900/50 rounded px-0.5"
            >
              {part}
            </mark>
          );
        }
        return <span key={index}>{part}</span>;
      })}
    </>
  );
}

type WhatsAppFlowResponseField = {
  key: string;
  label: string;
  value: string;
  meta?: string[];
  resolved?: boolean;
};

type ParsedWhatsAppFlowResponse = {
  flowName: string;
  /** Answer fields worth showing: valued, and not a generic Flow key. */
  fields: WhatsAppFlowResponseField[];
};

const WHATSAPP_FLOW_RESPONSE_REGEX =
  /^\[Flow response:\s*([^\]]+)\](?:\s*(.*))?$/i;
const GENERIC_FLOW_RESPONSE_KEYS = new Set([
  "flow_token",
  "token",
  "message",
  "wa_flow_response_keys",
]);

type WhatsAppFlowFieldMeta = {
  label?: string;
  helperText?: string;
  screenTitle?: string;
  optionTitles: Map<string, string>;
};

function formatFlowFieldLabel(key: string): string {
  const normalized = key.replace(/[_-]+/g, " ").trim();
  if (!normalized) return "Field";

  return normalized.replace(/\b\w/g, char => char.toUpperCase());
}

function getStringValue(value: unknown): string {
  return typeof value === "string" ? normalizeMessagePreviewText(value) : "";
}

function getMessageFlowFieldMetadata(
  message?: PopulatedMessage | null
): StoredWhatsAppFlowFieldMetadataPreview[] | null {
  const flow = message?.whatsappFlow;

  if (Array.isArray(flow?.responseFieldMetadata)) {
    return flow.responseFieldMetadata;
  }

  return null;
}

function buildFlowFieldMetaMap(
  fieldMetadata?: StoredWhatsAppFlowFieldMetadataPreview[] | null
): Map<string, WhatsAppFlowFieldMeta> {
  const out = new Map<string, WhatsAppFlowFieldMeta>();
  const fields = Array.isArray(fieldMetadata) ? fieldMetadata : [];

  for (const field of fields) {
    const id = getStringValue(field.id);
    if (!id) continue;

    const optionTitles = new Map<string, string>();
    const options = Array.isArray(field.options) ? field.options : [];
    for (const option of options) {
      const optionId = getStringValue(option.id);
      const optionTitle = getStringValue(option.title);
      if (optionId && optionTitle) {
        optionTitles.set(optionId, optionTitle);
      }
    }

    out.set(id, {
      label: getStringValue(field.label) || undefined,
      helperText: getStringValue(field.helperText) || undefined,
      screenTitle: getStringValue(field.screenTitle) || undefined,
      optionTitles,
    });
  }

  return out;
}

function getFlowFieldDisplayMeta(meta?: WhatsAppFlowFieldMeta): string[] {
  const helperText = normalizeMessagePreviewText(meta?.helperText);
  const label = normalizeMessagePreviewText(meta?.label);
  if (!helperText || helperText.toLowerCase() === label.toLowerCase()) {
    return [];
  }

  return [helperText];
}

function formatFlowFieldValue(
  value: unknown,
  fieldMeta?: WhatsAppFlowFieldMeta
): string {
  if (value === null || value === undefined) return "";

  if (typeof value === "string") {
    const normalized = normalizeMessagePreviewText(value);
    return fieldMeta?.optionTitles.get(normalized) || normalized;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value
      .map(item => formatFlowFieldValue(item, fieldMeta))
      .filter(Boolean)
      .join(", ");
  }

  if (typeof value === "object") {
    try {
      const serialized = JSON.stringify(value);
      return serialized.length > 120
        ? `${serialized.slice(0, 117)}...`
        : serialized;
    } catch {
      return "{...}";
    }
  }

  return String(value);
}

function buildFlowResponseField(
  key: string,
  value: unknown,
  flowFieldMeta: Map<string, WhatsAppFlowFieldMeta>
): WhatsAppFlowResponseField {
  const meta = flowFieldMeta.get(key);
  return {
    key,
    label: meta?.label || formatFlowFieldLabel(key),
    value: formatFlowFieldValue(value, meta),
    meta: getFlowFieldDisplayMeta(meta),
    resolved: Boolean(meta),
  };
}

// A generic Flow key (the token, a raw message) is shown only when the Flow's
// own metadata names it as a field.
function isMeaningfulFlowResponseField(
  field: WhatsAppFlowResponseField
): boolean {
  const normalizedKey = field.key.trim().toLowerCase();
  return (
    Boolean(normalizedKey) &&
    Boolean(field.value) &&
    (!GENERIC_FLOW_RESPONSE_KEYS.has(normalizedKey) || Boolean(field.resolved))
  );
}

function parseFlowResponseFields(
  responseJson?: string | null,
  summaryText?: string | null,
  fieldMetadata?: StoredWhatsAppFlowFieldMetadataPreview[] | null
): WhatsAppFlowResponseField[] {
  const flowFieldMeta = buildFlowFieldMetaMap(fieldMetadata);

  if (responseJson) {
    try {
      const parsed = JSON.parse(responseJson) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return Object.entries(parsed as Record<string, unknown>)
          .map(([key, value]) =>
            buildFlowResponseField(key, value, flowFieldMeta)
          )
          .filter(isMeaningfulFlowResponseField);
      }
    } catch {
      // Fall back to summary parsing below.
    }
  }

  return normalizeMessagePreviewText(summaryText)
    .split(";")
    .map(part => part.trim())
    .filter(Boolean)
    .map((part, index) => {
      const separatorIndex = part.indexOf(":");
      if (separatorIndex <= 0) {
        return { key: `field_${index}`, label: "Response", value: part };
      }
      return buildFlowResponseField(
        part.slice(0, separatorIndex).trim(),
        part.slice(separatorIndex + 1).trim(),
        flowFieldMeta
      );
    })
    .filter(isMeaningfulFlowResponseField);
}

function parseWhatsAppFlowResponseMessage(
  message: PopulatedMessage,
  fieldMetadata?: StoredWhatsAppFlowFieldMetadataPreview[] | null
): ParsedWhatsAppFlowResponse | null {
  const flowReplyMeta = message.whatsappFlowReply;
  const normalizedText = normalizeMessagePreviewText(message.text);
  const regexMatch = normalizedText.match(WHATSAPP_FLOW_RESPONSE_REGEX);

  const flowName =
    flowReplyMeta?.flowName?.trim() || regexMatch?.[1]?.trim() || "";
  if (!flowName || flowName.toLowerCase() === "address_message") {
    return null;
  }

  const body = flowReplyMeta?.body?.trim() || regexMatch?.[2]?.trim() || null;
  return {
    flowName,
    fields: parseFlowResponseFields(
      flowReplyMeta?.responseJson,
      body,
      fieldMetadata
    ),
  };
}

function truncateFlowCardTitle(text: string, maxLength = 48): string {
  const normalized = normalizeMessagePreviewText(text);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trim()}...`;
}

function resolveWhatsAppFlowResponseTitle(params: {
  reply: ParsedWhatsAppFlowResponse;
  previousMessage?: PopulatedMessage | null;
}): string {
  const previousMessage = params.previousMessage;
  const previousFlowCta = previousMessage?.whatsappFlow?.flowCta?.trim() || "";
  if (previousFlowCta) {
    return truncateFlowCardTitle(previousFlowCta);
  }

  const previousTemplateName =
    previousMessage?.whatsappTemplate?.name?.trim() ||
    extractWhatsAppTemplateNameFromText(previousMessage?.text);
  if (previousTemplateName) {
    return truncateFlowCardTitle(previousTemplateName);
  }

  const previousStructuredFlowBody = truncateFlowCardTitle(
    previousMessage?.whatsappFlow?.bodyText || ""
  );
  if (previousStructuredFlowBody) {
    return previousStructuredFlowBody;
  }

  const prevTextNorm = normalizeMessagePreviewText(previousMessage?.text || "");
  if (prevTextNorm && !/^\[Template:\s*[^\]]+\]\s*$/i.test(prevTextNorm)) {
    return truncateFlowCardTitle(previousMessage?.text || "");
  }

  if (params.reply.flowName.toLowerCase() !== "flow") {
    return truncateFlowCardTitle(params.reply.flowName);
  }

  return "WhatsApp flow";
}

function WhatsAppTemplateSendCard({
  preview,
  fallbackName,
}: {
  preview?: StoredWhatsAppTemplatePreview | null;
  fallbackName: string | null;
}) {
  const name =
    preview?.name?.trim() || fallbackName?.trim() || "WhatsApp template";
  const header = normalizeMessagePreviewText(preview?.headerText);
  const body = normalizeMessagePreviewText(preview?.bodyText);
  const footer = normalizeMessagePreviewText(preview?.footerText);
  const buttons = preview?.buttons ?? [];

  return (
    <div
      className={cn(
        STRUCTURED_MESSAGE_WIDTH_CLASS,
        "overflow-hidden rounded-[1.35rem] border border-white/25 bg-white/95 text-slate-900 shadow-sm dark:border-white/10 dark:bg-zinc-900 dark:text-white"
      )}
    >
      <div className="flex items-start gap-3 px-4 py-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary dark:bg-primary/20">
          <LayoutTemplate className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-white/60">
            WhatsApp template
          </p>
          <p className="truncate text-sm font-semibold text-slate-900 dark:text-white">
            {name}
          </p>
        </div>
      </div>
      {(header || body || footer) && (
        <div className="space-y-2 border-t border-slate-200/80 px-4 py-3 dark:border-white/10">
          {header ? (
            <p className="break-words text-sm font-semibold text-slate-900 [overflow-wrap:anywhere] dark:text-white">
              {header}
            </p>
          ) : null}
          {body ? (
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-800 [overflow-wrap:anywhere] dark:text-white/90">
              {body}
            </p>
          ) : null}
          {footer ? (
            <p className="break-words text-xs text-slate-500 [overflow-wrap:anywhere] dark:text-white/60">
              {footer}
            </p>
          ) : null}
        </div>
      )}
      {buttons.length > 0 ? (
        <div className="flex flex-wrap gap-2 border-t border-slate-200/80 px-4 py-2.5 dark:border-white/10">
          {buttons.map((b, i) => (
            <span
              key={`${b.text}-${i}`}
              className="max-w-full truncate rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 dark:border-white/15 dark:bg-white/5 dark:text-white/85"
            >
              {b.text}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function WhatsAppFlowSendCard({
  flow,
  fallbackText,
}: {
  flow: NonNullable<PopulatedMessage["whatsappFlow"]>;
  /** The message text, shown when the stored Flow has no body or header. */
  fallbackText?: string;
}) {
  const bodyText =
    normalizeMessagePreviewText(
      flow.bodyText || flow.headerText || fallbackText
    ) || "Open the flow below.";
  const footerText = normalizeMessagePreviewText(flow.footerText);
  const ctaLabel = normalizeMessagePreviewText(flow.flowCta) || "Open flow";

  return (
    <div
      className={cn(
        STRUCTURED_MESSAGE_WIDTH_CLASS,
        "overflow-hidden rounded-[1.35rem] border border-zinc-200 bg-white text-slate-900 shadow-sm dark:border-slate-700/80 dark:bg-[#1f2c34] dark:text-white"
      )}
    >
      <div className="px-4 py-3">
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-900 [overflow-wrap:anywhere] dark:text-white">
          {bodyText}
        </p>
        {footerText ? (
          <p className="mt-2 break-words text-xs text-slate-500 [overflow-wrap:anywhere] dark:text-white/65">
            {footerText}
          </p>
        ) : null}
      </div>
      <div className="border-t border-zinc-200 bg-zinc-50 px-4 py-2 text-center text-sm font-medium text-slate-600 dark:border-white/10 dark:bg-black/10 dark:text-[#53bdeb]">
        {ctaLabel}
      </div>
    </div>
  );
}

function WhatsAppFlowReplyCard({
  title,
  subtitle,
  fields,
}: {
  title: string;
  subtitle: string;
  fields: WhatsAppFlowResponseField[];
}) {
  return (
    <div
      className={cn(
        STRUCTURED_MESSAGE_WIDTH_CLASS,
        "overflow-hidden rounded-[1.35rem] border border-[#c8f7c5] bg-[#d9fdd3] text-emerald-950 shadow-sm dark:border-emerald-900/40 dark:bg-[#0b4f3d] dark:text-white"
      )}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <div
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white dark:bg-black/20",
            waActionButton.text
          )}
        >
          <FileText className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-emerald-950 dark:text-white">
            {title}
          </p>
          <p className="text-xs text-emerald-900/75 dark:text-emerald-100/80">
            {subtitle}
          </p>
        </div>
      </div>
      {fields.length > 0 ? (
        <div className="max-h-[min(22rem,50vh)] space-y-2 overflow-y-auto border-t border-emerald-900/10 px-4 py-3 dark:border-white/10">
          {fields.map(field => (
            <div key={`${field.key}-${field.value}`} className="space-y-0.5">
              <p className="text-[11px] font-medium uppercase tracking-wide text-emerald-900/55 dark:text-white/50">
                {field.label}
              </p>
              {field.meta && field.meta.length > 0 ? (
                <p className="break-words text-[11px] leading-snug text-emerald-900/55 [overflow-wrap:anywhere] dark:text-white/45">
                  {field.meta.join(" / ")}
                </p>
              ) : null}
              <p className="break-words text-sm text-emerald-950/90 dark:text-white/90">
                {field.value}
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

type WhatsAppLocationPayload = NonNullable<
  PopulatedMessage["whatsappLocation"]
>;
type WhatsAppContactPayload = NonNullable<
  PopulatedMessage["whatsappContacts"]
>[number];
type WhatsAppReferralPayload = NonNullable<
  PopulatedMessage["whatsappReferral"]
>;
type WhatsAppProductInquiryPayload = NonNullable<
  PopulatedMessage["whatsappProductInquiry"]
>;
type WhatsAppOrderPayload = NonNullable<PopulatedMessage["whatsappOrder"]>;

function getSafeExternalHref(value: unknown): string | null {
  const href = readTrimmedString(value);
  if (!href) return null;
  try {
    const parsed = new URL(href);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function resolveReferralPlatformLabel(
  referral: WhatsAppReferralPayload
): string {
  const platform = resolveWhatsAppReferralSourcePlatform(
    readTrimmedString(referral.sourceUrl)
  );
  if (platform === "instagram") return "Instagram";
  if (platform === "facebook") return "Facebook";
  return "WhatsApp";
}

function hasWhatsAppReferralPreview(
  referral: PopulatedMessage["whatsappReferral"] | null | undefined
): referral is WhatsAppReferralPayload {
  if (!referral) return false;
  return Boolean(
    readTrimmedString(referral.sourceType) ||
      readTrimmedString(referral.sourceId) ||
      readTrimmedString(referral.sourceUrl) ||
      readTrimmedString(referral.campaignName) ||
      readTrimmedString(referral.headline) ||
      readTrimmedString(referral.body) ||
      readTrimmedString(referral.ctwaClid) ||
      readTrimmedString(referral.ref)
  );
}

function hasWhatsAppProductInquiryPreview(
  inquiry: PopulatedMessage["whatsappProductInquiry"] | null | undefined
): inquiry is WhatsAppProductInquiryPayload {
  if (!inquiry) return false;
  return Boolean(
    readTrimmedString(inquiry.productRetailerId) ||
      readTrimmedString(inquiry.catalogId) ||
      readTrimmedString(inquiry.contextMessageId)
  );
}

function hasWhatsAppOrderPreview(
  order: PopulatedMessage["whatsappOrder"] | null | undefined
): order is WhatsAppOrderPayload {
  if (!order) return false;
  return Boolean(
    readTrimmedString(order.catalogId) ||
      readTrimmedString(order.text) ||
      typeof order.totalQuantity === "number" ||
      typeof order.totalAmount === "number" ||
      (Array.isArray(order.productItems) && order.productItems.length > 0)
  );
}

function formatCommerceNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(2)
    : "";
}

function formatOrderQuantity(order: WhatsAppOrderPayload) {
  const quantity =
    typeof order.totalQuantity === "number" &&
    Number.isFinite(order.totalQuantity)
      ? order.totalQuantity
      : (order.productItems || []).reduce(
          (sum, item) =>
            sum +
            (typeof item.quantity === "number" && Number.isFinite(item.quantity)
              ? item.quantity
              : 0),
          0
        );
  return quantity === 1 ? "1 item" : `${quantity} items`;
}

function formatOrderTotal(order: WhatsAppOrderPayload) {
  const amount = formatCommerceNumber(order.totalAmount);
  const currency = readTrimmedString(order.currency);
  if (!amount || amount === "0.00") return currency || "";
  return currency ? `${amount} ${currency}` : amount;
}

function getProductInquiryMessageText(text: string) {
  return text.replace(/^\[Product inquiry:\s*[^\]]+\]\s*/i, "").trim();
}

function isWhatsAppLocationPlaceholderText(text: string | undefined): boolean {
  return typeof text === "string" && /^\[Location\]/i.test(text.trim());
}

function isCommercePlaceholderOnly(text: string) {
  const trimmed = text.trim();
  return (
    /^\[WhatsApp order:[^\]]+\]\s*$/i.test(trimmed) ||
    /^\[Product inquiry:\s*[^\]]+\]\s*$/i.test(trimmed)
  );
}

function WhatsAppOrderPreviewCard({
  order,
  isOutbound,
}: {
  order: WhatsAppOrderPayload;
  isOutbound: boolean;
}) {
  const total = formatOrderTotal(order);
  const note = readTrimmedString(order.text);
  const items = Array.isArray(order.productItems) ? order.productItems : [];

  return (
    <div
      aria-label="WhatsApp order"
      className={cn(
        "mb-1.5 w-full max-w-[320px] rounded-xl p-2.5",
        isOutbound
          ? "bg-primary-foreground/12 text-primary-foreground"
          : "bg-background/85 text-foreground"
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-lg",
            isOutbound
              ? "bg-primary-foreground/15"
              : "bg-muted text-muted-foreground"
          )}
        >
          <ShoppingCart className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-5">Order</p>
          <div
            className={cn(
              "flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs",
              isOutbound
                ? "text-primary-foreground/75"
                : "text-muted-foreground"
            )}
          >
            <span>{formatOrderQuantity(order)}</span>
            {total ? <span>{total}</span> : null}
          </div>
        </div>
      </div>
      {items.length > 0 ? (
        <div className="mt-2 space-y-1">
          {items.slice(0, 4).map((item, index) => {
            const sku = readTrimmedString(item.productRetailerId);
            const quantity =
              typeof item.quantity === "number" &&
              Number.isFinite(item.quantity)
                ? item.quantity
                : null;
            const price = formatCommerceNumber(item.itemPrice);
            const currency = readTrimmedString(item.currency);
            return (
              <div
                key={`${sku || "item"}-${index}`}
                className={cn(
                  "flex min-w-0 items-center justify-between gap-2 text-xs",
                  isOutbound
                    ? "text-primary-foreground/80"
                    : "text-muted-foreground"
                )}
              >
                <span className="truncate font-medium text-inherit">
                  {sku || "Product"}
                </span>
                <span className="shrink-0">
                  {quantity !== null ? `x${quantity}` : ""}
                  {price ? ` @ ${price}${currency ? ` ${currency}` : ""}` : ""}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
      {note ? (
        <p
          className={cn(
            "mt-2 break-words text-xs leading-4 [overflow-wrap:anywhere]",
            isOutbound ? "text-primary-foreground/80" : "text-muted-foreground"
          )}
        >
          {note}
        </p>
      ) : null}
    </div>
  );
}

function WhatsAppProductInquiryPreviewCard({
  inquiry,
  isOutbound,
}: {
  inquiry: WhatsAppProductInquiryPayload;
  isOutbound: boolean;
}) {
  const sku = readTrimmedString(inquiry.productRetailerId);
  const catalogId = readTrimmedString(inquiry.catalogId);

  return (
    <div
      aria-label="WhatsApp product inquiry"
      className={cn(
        "mb-1.5 flex w-full max-w-[320px] min-w-0 items-center gap-2 rounded-xl p-2.5",
        isOutbound
          ? "bg-primary-foreground/12 text-primary-foreground"
          : "bg-background/85 text-foreground"
      )}
    >
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-lg",
          isOutbound
            ? "bg-primary-foreground/15"
            : "bg-muted text-muted-foreground"
        )}
      >
        <Package className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold leading-5">Product inquiry</p>
        <div
          className={cn(
            "flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs",
            isOutbound ? "text-primary-foreground/75" : "text-muted-foreground"
          )}
        >
          {sku ? <span className="font-medium">{sku}</span> : null}
          {catalogId ? <span>{catalogId}</span> : null}
        </div>
      </div>
    </div>
  );
}

function WhatsAppReferralPreviewCard({
  referral,
  isOutbound,
}: {
  referral: WhatsAppReferralPayload;
  isOutbound: boolean;
}) {
  const href = getSafeExternalHref(referral.sourceUrl);
  const platformLabel = resolveReferralPlatformLabel(referral);
  const sourceType = readTrimmedString(referral.sourceType).toLowerCase();
  const label =
    sourceType === "ad" ? `${platformLabel} ad` : `${platformLabel} referral`;
  const campaignName = readTrimmedString(referral.campaignName);
  const headline = readTrimmedString(referral.headline);
  const body = readTrimmedString(referral.body);
  const sourceId = readTrimmedString(referral.sourceId);
  const title = campaignName || headline || body || sourceId || label;
  const subtitle =
    title !== headline && headline
      ? headline
      : title !== body && body
        ? body
        : href
          ? new URL(href).hostname.replace(/^www\./, "")
          : "";
  const mediaUrl =
    getSafeExternalHref(referral.thumbnailUrl) ||
    getSafeExternalHref(referral.imageUrl);
  const Wrapper = href ? "a" : "div";

  return (
    <Wrapper
      {...(href
        ? {
            href,
            target: "_blank",
            rel: "noopener noreferrer",
          }
        : {})}
      aria-label="WhatsApp ad referral"
      className={cn(
        "mb-1.5 flex w-full min-w-0 items-center gap-2 rounded-xl p-2 text-left no-underline transition-colors",
        isOutbound
          ? "bg-primary-foreground/12 text-primary-foreground hover:bg-primary-foreground/18"
          : "bg-background/85 text-foreground hover:bg-background"
      )}
    >
      {mediaUrl ? (
        <img
          src={mediaUrl}
          alt="Ad preview"
          className="h-12 w-12 shrink-0 rounded-lg object-cover"
        />
      ) : (
        <div
          className={cn(
            "flex h-12 w-12 shrink-0 items-center justify-center rounded-lg",
            isOutbound
              ? "bg-primary-foreground/15"
              : "bg-muted text-muted-foreground"
          )}
        >
          <ExternalLink className="h-4 w-4" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "text-[11px] font-medium leading-4",
            isOutbound ? "text-primary-foreground/75" : "text-muted-foreground"
          )}
        >
          {label}
        </p>
        <p className="truncate text-sm font-semibold leading-5">{title}</p>
        {subtitle ? (
          <p
            className={cn(
              "line-clamp-1 break-words text-xs leading-4 [overflow-wrap:anywhere]",
              isOutbound
                ? "text-primary-foreground/75"
                : "text-muted-foreground"
            )}
          >
            {subtitle}
          </p>
        ) : null}
      </div>
      {href ? (
        <ExternalLink
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            isOutbound ? "text-primary-foreground/75" : "text-muted-foreground"
          )}
        />
      ) : null}
    </Wrapper>
  );
}

function buildLocationMapsUrl(
  latitude: number | null | undefined,
  longitude: number | null | undefined
): string | null {
  if (typeof latitude !== "number" || typeof longitude !== "number") {
    return null;
  }
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }
  return `https://www.google.com/maps?q=${latitude},${longitude}`;
}

function formatLatLng(
  latitude: number | null | undefined,
  longitude: number | null | undefined
): string | null {
  if (typeof latitude !== "number" || typeof longitude !== "number") {
    return null;
  }
  return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}

function WhatsAppLocationCard({
  location,
  isOutbound,
}: {
  location: WhatsAppLocationPayload;
  isOutbound: boolean;
}) {
  const mapsUrl =
    getSafeExternalHref(location.url) ||
    buildLocationMapsUrl(location.latitude, location.longitude);
  const coordsLabel = formatLatLng(location.latitude, location.longitude);
  const title =
    (typeof location.name === "string" && location.name.trim()) ||
    "Shared location";
  const address =
    typeof location.address === "string" && location.address.trim()
      ? location.address.trim()
      : null;

  return (
    <a
      href={mapsUrl || "#"}
      target={mapsUrl ? "_blank" : undefined}
      rel={mapsUrl ? "noopener noreferrer" : undefined}
      onClick={e => {
        if (!mapsUrl) e.preventDefault();
      }}
      className={cn(
        "mb-1.5 flex w-full max-w-[280px] min-w-0 items-start gap-2 rounded-lg border p-2 transition-colors",
        isOutbound
          ? "border-primary-foreground/30 bg-primary-foreground/10 text-primary-foreground hover:bg-primary-foreground/20"
          : "border-border/50 bg-background/70 text-foreground hover:bg-background"
      )}
    >
      <div
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
          isOutbound
            ? "bg-primary-foreground/20"
            : "bg-muted text-muted-foreground"
        )}
      >
        <MapPin className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{title}</p>
        {address ? (
          <p
            className={cn(
              "line-clamp-2 break-words text-xs [overflow-wrap:anywhere]",
              isOutbound
                ? "text-primary-foreground/80"
                : "text-muted-foreground"
            )}
          >
            {address}
          </p>
        ) : null}
        {coordsLabel ? (
          <p
            className={cn(
              "mt-0.5 text-[11px] font-mono",
              isOutbound
                ? "text-primary-foreground/70"
                : "text-muted-foreground/70"
            )}
          >
            {coordsLabel}
          </p>
        ) : null}
      </div>
      {mapsUrl ? (
        <ExternalLink
          className={cn(
            "h-3.5 w-3.5 shrink-0 opacity-70",
            isOutbound ? "text-primary-foreground" : "text-muted-foreground"
          )}
        />
      ) : null}
    </a>
  );
}

function getContactDisplayName(contact: WhatsAppContactPayload): string {
  const name = contact.name as Record<string, unknown> | undefined;
  if (name && typeof name === "object") {
    const formatted = name.formatted_name;
    if (typeof formatted === "string" && formatted.trim()) {
      return formatted.trim();
    }
    const first = typeof name.first_name === "string" ? name.first_name : "";
    const last = typeof name.last_name === "string" ? name.last_name : "";
    const combined = `${first} ${last}`.trim();
    if (combined) return combined;
  }
  const org = contact.org as Record<string, unknown> | undefined;
  if (org && typeof org.company === "string" && org.company.trim()) {
    return org.company.trim();
  }
  return "Shared contact";
}

function getContactPhones(
  contact: WhatsAppContactPayload
): Array<{ phone: string; waId?: string; type?: string }> {
  const phones = contact.phones;
  if (!Array.isArray(phones)) return [];
  return phones.flatMap(raw => {
    if (!raw || typeof raw !== "object") return [];
    const entry = raw as Record<string, unknown>;
    const phone = typeof entry.phone === "string" ? entry.phone.trim() : "";
    if (!phone) return [];
    return [
      {
        phone,
        waId: typeof entry.wa_id === "string" ? entry.wa_id : undefined,
        type: typeof entry.type === "string" ? entry.type : undefined,
      },
    ];
  });
}

function getContactEmails(
  contact: WhatsAppContactPayload
): Array<{ email: string; type?: string }> {
  const emails = contact.emails;
  if (!Array.isArray(emails)) return [];
  return emails.flatMap(raw => {
    if (!raw || typeof raw !== "object") return [];
    const entry = raw as Record<string, unknown>;
    const email = typeof entry.email === "string" ? entry.email.trim() : "";
    if (!email) return [];
    return [
      {
        email,
        type: typeof entry.type === "string" ? entry.type : undefined,
      },
    ];
  });
}

function escapeVCardText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function formatVCardType(value: string | undefined): string {
  return readTrimmedString(value)
    .replace(/[^\w-]/g, "")
    .toUpperCase();
}

function getContactNameParts(contact: WhatsAppContactPayload) {
  const name = contact.name as Record<string, unknown> | undefined;
  return {
    formatted: getContactDisplayName(contact),
    first: readTrimmedString(name?.first_name),
    last: readTrimmedString(name?.last_name),
    middle: readTrimmedString(name?.middle_name),
    prefix: readTrimmedString(name?.prefix),
    suffix: readTrimmedString(name?.suffix),
  };
}

function buildContactVCard(contact: WhatsAppContactPayload): string {
  const name = getContactNameParts(contact);
  const org = contact.org as Record<string, unknown> | undefined;
  const phones = getContactPhones(contact);
  const emails = getContactEmails(contact);
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${escapeVCardText(name.formatted)}`,
    `N:${escapeVCardText(name.last)};${escapeVCardText(name.first)};${escapeVCardText(name.middle)};${escapeVCardText(name.prefix)};${escapeVCardText(name.suffix)}`,
  ];

  for (const { phone, type } of phones) {
    const phoneType = formatVCardType(type);
    lines.push(
      `TEL${phoneType ? `;TYPE=${phoneType}` : ""}:${escapeVCardText(phone)}`
    );
  }

  for (const { email, type } of emails) {
    const emailType = formatVCardType(type);
    lines.push(
      `EMAIL${emailType ? `;TYPE=${emailType}` : ""}:${escapeVCardText(email)}`
    );
  }

  const company = readTrimmedString(org?.company);
  const title = readTrimmedString(org?.title);
  if (company) lines.push(`ORG:${escapeVCardText(company)}`);
  if (title) lines.push(`TITLE:${escapeVCardText(title)}`);

  lines.push("END:VCARD");
  return lines.join("\r\n");
}

function getContactVCardFileName(displayName: string): string {
  const normalizedName = displayName
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
  return `${normalizedName || "contact"}.vcf`;
}

function getCallablePhoneHref(phone: string): string {
  const compactPhone = phone.replace(/[^\d+]/g, "");
  return `tel:${compactPhone || phone}`;
}

function hasCoexistenceContactIdentity(
  contact: WhatsAppContactPayload
): boolean {
  const raw = contact as Record<string, unknown>;
  return Boolean(
    readTrimmedString(raw.user_id) || readTrimmedString(raw.parent_user_id)
  );
}

function downloadContactVCard(contact: WhatsAppContactPayload) {
  const blob = new Blob([buildContactVCard(contact)], {
    type: "text/vcard;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = getContactVCardFileName(getContactDisplayName(contact));
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function WhatsAppContactCard({
  contact,
  isOutbound,
}: {
  contact: WhatsAppContactPayload;
  isOutbound: boolean;
}) {
  const t = useTranslations("ConversationDetailView");
  const [copiedPhone, setCopiedPhone] = useState<string | null>(null);
  const copiedPhoneTimeoutRef = useRef<number | null>(null);
  const displayName = getContactDisplayName(contact);
  const phones = getContactPhones(contact);
  const emails = getContactEmails(contact);
  const primaryPhone = phones[0]?.phone || "";
  const canCall =
    Boolean(primaryPhone) && !hasCoexistenceContactIdentity(contact);
  const org = contact.org as Record<string, unknown> | undefined;
  const actionClassName = cn(
    "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium transition-colors",
    isOutbound
      ? "border-primary-foreground/25 bg-primary-foreground/10 text-primary-foreground hover:bg-primary-foreground/15"
      : "border-border bg-background text-foreground hover:bg-muted"
  );
  const orgLine = [
    readTrimmedString(org?.title),
    readTrimmedString(org?.company),
  ]
    .filter(Boolean)
    .join(" · ");

  useEffect(() => {
    return () => {
      if (copiedPhoneTimeoutRef.current) {
        window.clearTimeout(copiedPhoneTimeoutRef.current);
      }
    };
  }, []);

  const handlePhoneClick = useCallback(async (phone: string) => {
    try {
      await navigator.clipboard?.writeText(phone);
    } catch {
      // The click still gives feedback when clipboard access is blocked.
    }

    setCopiedPhone(phone);
    if (copiedPhoneTimeoutRef.current) {
      window.clearTimeout(copiedPhoneTimeoutRef.current);
    }
    copiedPhoneTimeoutRef.current = window.setTimeout(() => {
      setCopiedPhone(current => (current === phone ? null : current));
    }, 1800);
  }, []);

  const handleSaveContact = useCallback(() => {
    downloadContactVCard(contact);
  }, [contact]);

  return (
    <div
      className={cn(
        "mb-1.5 w-full max-w-[300px] min-w-0 rounded-lg border p-2",
        isOutbound
          ? "border-primary-foreground/30 bg-primary-foreground/10 text-primary-foreground"
          : "border-border/50 bg-background/70 text-foreground"
      )}
    >
      <div className="flex items-start gap-2">
        <div
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
            isOutbound
              ? "bg-primary-foreground/20"
              : "bg-muted text-muted-foreground"
          )}
        >
          <UserRound className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{displayName}</p>
          {orgLine ? (
            <p
              className={cn(
                "truncate text-xs",
                isOutbound
                  ? "text-primary-foreground/80"
                  : "text-muted-foreground"
              )}
            >
              {orgLine}
            </p>
          ) : null}
        </div>
      </div>
      {(phones.length > 0 || emails.length > 0) && (
        <div
          className={cn(
            "mt-1.5 space-y-1 border-t pt-1.5",
            isOutbound ? "border-primary-foreground/20" : "border-border/50"
          )}
        >
          {phones.map(({ phone, type }) => (
            <button
              type="button"
              key={`phone-${phone}`}
              onClick={() => void handlePhoneClick(phone)}
              className={cn(
                "flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-1 text-left text-xs transition-colors",
                isOutbound ? "text-primary-foreground" : "text-foreground"
              )}
            >
              <Phone className="h-3 w-3 shrink-0 opacity-70" />
              <span className="min-w-0 flex-1 truncate font-mono">{phone}</span>
              {type ? (
                <span
                  className={cn(
                    "shrink-0 text-[10px] uppercase tracking-wide opacity-60"
                  )}
                >
                  {type}
                </span>
              ) : null}
              <span
                aria-live="polite"
                className={cn(
                  "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                  isOutbound
                    ? "bg-primary-foreground/15 text-primary-foreground"
                    : "bg-muted text-muted-foreground"
                )}
              >
                {copiedPhone === phone
                  ? t("contactPhoneCopied")
                  : t("contactCopyPhone")}
              </span>
            </button>
          ))}
          {emails.map(({ email, type }) => (
            <a
              key={`email-${email}`}
              href={`mailto:${email}`}
              className={cn(
                "flex items-center gap-1.5 text-xs hover:underline",
                isOutbound ? "text-primary-foreground" : "text-foreground"
              )}
            >
              <Mail className="h-3 w-3 shrink-0 opacity-70" />
              <span className="truncate">{email}</span>
              {type ? (
                <span className="text-[10px] uppercase tracking-wide opacity-60">
                  {type}
                </span>
              ) : null}
            </a>
          ))}
        </div>
      )}
      <div
        className={cn(
          "mt-2 flex flex-wrap gap-1.5 border-t pt-2",
          isOutbound ? "border-primary-foreground/20" : "border-border/50"
        )}
      >
        {canCall ? (
          <a
            href={getCallablePhoneHref(primaryPhone)}
            className={actionClassName}
          >
            <Phone className="h-3 w-3" />
            {t("contactCall")}
          </a>
        ) : null}
        <button
          type="button"
          onClick={handleSaveContact}
          className={actionClassName}
        >
          <UserRound className="h-3 w-3" />
          {t("contactSave")}
        </button>
      </div>
    </div>
  );
}

const PRICING_CATEGORY_LABELS: Record<string, string> = {
  marketing: "Marketing",
  marketing_lite: "Marketing API",
  utility: "Utility",
  authentication: "Authentication",
  "authentication-international": "Authentication",
  authentication_international: "Authentication",
  service: "Service",
  referral_conversion: "Referral",
};

function formatPricingCategoryLabel(category: string): string {
  return (
    PRICING_CATEGORY_LABELS[category] ||
    category.replace(/[_-]/g, " ").replace(/\b\w/g, c => c.toUpperCase())
  );
}

function DeliveryPricingChip({
  delivery,
  isOutbound,
}: {
  delivery: NonNullable<PopulatedMessage["delivery"]>;
  isOutbound: boolean;
}) {
  const category =
    typeof delivery.pricingCategory === "string"
      ? delivery.pricingCategory.trim()
      : "";
  if (!category) return null;

  const label = formatPricingCategoryLabel(category);
  const pricingType =
    typeof delivery.pricingType === "string" ? delivery.pricingType : "";
  const conversationCategory =
    typeof delivery.conversationCategory === "string"
      ? delivery.conversationCategory
      : "";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "mr-1.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0 text-[9px] font-medium uppercase tracking-wide",
            isOutbound
              ? "bg-primary-foreground/15 text-primary-foreground/80"
              : "bg-muted text-muted-foreground"
          )}
        >
          <span
            className={cn(
              "h-1 w-1 rounded-full",
              isOutbound ? "bg-primary-foreground/80" : "bg-muted-foreground"
            )}
          />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        <div className="space-y-0.5 text-left">
          <p className="font-medium">WhatsApp billing: {label}</p>
          {pricingType ? (
            <p className="text-xs opacity-80">Pricing type: {pricingType}</p>
          ) : null}
          {conversationCategory ? (
            <p className="text-xs opacity-80">
              Conversation origin: {conversationCategory}
            </p>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

const DELIVERY_STATUS_LABELS: Record<string, string> = {
  sent: "Message sent",
  delivered: "Message delivered",
  read: "Message read",
  played: "Voice message played",
  failed: "Message failed",
};

function DeliveryStatusIndicator({
  delivery,
  isOutbound,
}: {
  delivery: NonNullable<PopulatedMessage["delivery"]>;
  isOutbound: boolean;
}) {
  const status = typeof delivery.status === "string" ? delivery.status : "";
  const label = DELIVERY_STATUS_LABELS[status];
  if (!label) return null;

  const Icon =
    status === "failed"
      ? CircleAlert
      : status === "played"
        ? Mic
        : status === "sent"
          ? Check
          : CheckCheck;
  const errorMessage =
    typeof delivery.errorMessage === "string" ? delivery.errorMessage : "";
  const recipientType =
    typeof delivery.recipientType === "string"
      ? delivery.recipientType.trim()
      : "";
  const recipientId =
    typeof delivery.recipientId === "string" ? delivery.recipientId.trim() : "";
  const participantId =
    typeof delivery.recipientParticipantId === "string"
      ? delivery.recipientParticipantId.trim()
      : "";
  const hasGroupRecipientInfo =
    recipientType === "group" || Boolean(participantId);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={label}
          className={cn(
            "ml-1 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center",
            status === "read" || status === "played"
              ? "text-sky-500 dark:text-sky-300"
              : status === "failed"
                ? "text-destructive"
                : isOutbound
                  ? "text-primary-foreground/75"
                  : "text-muted-foreground"
          )}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        <div className="space-y-0.5 text-left">
          <p>
            {status === "failed" && errorMessage
              ? `${label}: ${errorMessage}`
              : label}
          </p>
          {hasGroupRecipientInfo ? (
            <div className="text-xs opacity-80">
              {recipientId ? <p>Group recipient: {recipientId}</p> : null}
              {participantId ? <p>Participant: {participantId}</p> : null}
            </div>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

// The edit route accepts a sent WhatsApp text for 15 minutes.
const WHATSAPP_TEXT_EDIT_WINDOW_MS = 15 * 60 * 1000;

/** A message's sender label and the key that groups consecutive messages. */
function resolveMessageSender(
  message: PopulatedMessage,
  unnamedCustomer: string
): {
  name: string;
  key: string;
} {
  const name =
    message.direction === "outbound"
      ? message.author?.firstName?.trim() || "Airi"
      : resolveTelegramSenderDisplayName({
          author: message.author,
          telegramMeta: message.telegramMeta,
          fallback:
            message.whatsappGroup?.senderUsername?.trim() ||
            message.whatsappGroup?.senderWaId?.trim() ||
            unnamedCustomer,
        });
  const key =
    message.author?._id?.toString() ||
    message.telegramMeta?.senderChatId ||
    message.whatsappGroup?.senderUserId ||
    message.whatsappGroup?.senderWaId ||
    `${name}:${message.direction}`;
  return { name, key };
}

type MediaTranscriptState = {
  text?: string;
  expanded?: boolean;
  loading?: boolean;
  error?: string;
};

function ConversationThreadContent({
  conversationId,
  workspaceId,
  messages: fetchedMessages,
  channel,
  highlightedMessageId,
  searchQuery,
  showInboundAuthorNames = false,
  isInstagramCommentThread = false,
  onReplyTargetSelect,
  onMessageTextUpdated,
}: {
  conversationId: string;
  workspaceId?: string | null;
  messages: PopulatedMessage[];
  channel?: string | null;
  highlightedMessageId: string | null;
  searchQuery?: string | null;
  showInboundAuthorNames?: boolean;
  isInstagramCommentThread?: boolean;
  onReplyTargetSelect?: (message: PopulatedMessage) => void;
  onMessageTextUpdated?: MessageTextUpdatedHandler;
}) {
  // Each refetch re-signs media; reusing the first link keeps a refresh from
  // reloading videos and images already on screen.
  const [stableMediaLink] = useState(() => createStableMediaLinks());
  const messages = useMemo(
    () =>
      fetchedMessages.map(message =>
        withStableMediaLinks(message, stableMediaLink)
      ),
    [fetchedMessages, stableMediaLink]
  );
  const locale = useLocale();
  const t = useTranslations("ConversationDetailView");
  const unnamedCustomer = t("unnamedCustomer");
  const timeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }),
    [locale]
  );
  const isWhatsAppConversation = channel === "whatsapp";
  const supportsDeliveryStatus =
    channel === "whatsapp" || channel === "instagram";

  // Playback is otherwise uninstrumented: a stuck inbound player fires no
  // event, so this is the only signal that an operator could not open a file.
  const reportMediaLoadFailure = useMemo(() => {
    const reportFor =
      (mediaKind: "audio" | "video" | "image") => (info: MediaLoadErrorInfo) =>
        captureClientEvent("conversation_media_load_failed", {
          conversation_id: conversationId,
          workspace_id: workspaceId ?? undefined,
          channel: channel ?? undefined,
          media_kind: mediaKind,
          reason: info.reason,
          mime_type: info.mimeType,
          media_error_code: info.errorCode,
        });
    return {
      audio: reportFor("audio"),
      video: reportFor("video"),
      image: reportFor("image"),
    };
  }, [conversationId, workspaceId, channel]);
  const [selectedImageUrl, setSelectedImageUrl] = useState<string | null>(null);
  const [imageZoom, setImageZoom] = useState(IMAGE_ZOOM_MIN);
  const [selectedImageFailed, setSelectedImageFailed] = useState(false);
  const [dialogImageReloadKey, setDialogImageReloadKey] = useState(0);
  const [transcripts, setTranscripts] = useState<
    Record<string, MediaTranscriptState>
  >({});
  const imageViewportRef = useRef<HTMLDivElement>(null);
  const imageElementRef = useRef<HTMLImageElement>(null);
  const imagePanRef = useRef<ImagePan>({ x: 0, y: 0 });
  const imageZoomRef = useRef(IMAGE_ZOOM_MIN);
  const isImageDraggingRef = useRef(false);
  const imagePanFrameRef = useRef<number | null>(null);
  const imagePendingPanRef = useRef<ImagePan | null>(null);
  const imageDragStartRef = useRef<{
    pointerX: number;
    pointerY: number;
    panX: number;
    panY: number;
  } | null>(null);
  const hasImageDraggedRef = useRef(false);

  const clampImagePan = (pan: ImagePan, zoomLevel: number): ImagePan => {
    if (zoomLevel <= IMAGE_ZOOM_MIN) {
      return { x: 0, y: 0 };
    }

    const viewport = imageViewportRef.current;
    const image = imageElementRef.current;

    if (!viewport || !image) {
      return pan;
    }

    const viewportWidth = viewport.clientWidth;
    const viewportHeight = viewport.clientHeight;
    const baseImageWidth = image.offsetWidth;
    const baseImageHeight = image.offsetHeight;

    if (
      !viewportWidth ||
      !viewportHeight ||
      !baseImageWidth ||
      !baseImageHeight
    ) {
      return pan;
    }

    const maxPanX = Math.max(
      0,
      (baseImageWidth * zoomLevel - viewportWidth) / 2
    );
    const maxPanY = Math.max(
      0,
      (baseImageHeight * zoomLevel - viewportHeight) / 2
    );

    return {
      x: Math.min(maxPanX, Math.max(-maxPanX, pan.x)),
      y: Math.min(maxPanY, Math.max(-maxPanY, pan.y)),
    };
  };

  const applyImageTransform = (pan: ImagePan, zoomLevel: number) => {
    const image = imageElementRef.current;
    if (!image) return;

    image.style.transform = `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoomLevel})`;
  };

  const updateImageCursor = () => {
    const viewport = imageViewportRef.current;
    if (!viewport) return;

    if (imageZoomRef.current <= IMAGE_ZOOM_MIN) {
      viewport.style.cursor = "zoom-in";
      return;
    }

    viewport.style.cursor = isImageDraggingRef.current ? "grabbing" : "grab";
  };

  const scheduleImagePanUpdate = (nextPan: ImagePan) => {
    imagePendingPanRef.current = nextPan;
    if (imagePanFrameRef.current !== null) return;

    imagePanFrameRef.current = window.requestAnimationFrame(() => {
      imagePanFrameRef.current = null;
      if (!imagePendingPanRef.current) return;

      imagePanRef.current = imagePendingPanRef.current;
      imagePendingPanRef.current = null;
      applyImageTransform(imagePanRef.current, imageZoomRef.current);
    });
  };

  const clearScheduledImagePanUpdate = () => {
    if (imagePanFrameRef.current !== null) {
      window.cancelAnimationFrame(imagePanFrameRef.current);
      imagePanFrameRef.current = null;
    }
    imagePendingPanRef.current = null;
  };

  const zoomInImage = () => {
    setImageZoom(currentZoom => clampImageZoom(currentZoom + IMAGE_ZOOM_STEP));
  };

  const zoomOutImage = () => {
    setImageZoom(currentZoom => clampImageZoom(currentZoom - IMAGE_ZOOM_STEP));
  };

  const resetImageZoom = () => {
    setImageZoom(IMAGE_ZOOM_MIN);
    imageZoomRef.current = IMAGE_ZOOM_MIN;
    imagePanRef.current = { x: 0, y: 0 };
    isImageDraggingRef.current = false;
    imageDragStartRef.current = null;
    hasImageDraggedRef.current = false;
    clearScheduledImagePanUpdate();
    applyImageTransform(imagePanRef.current, imageZoomRef.current);
    updateImageCursor();
  };

  const openImageDialog = (imageUrl: string) => {
    setSelectedImageUrl(imageUrl);
    setSelectedImageFailed(false);
    resetImageZoom();
  };

  const closeImageDialog = () => {
    setSelectedImageUrl(null);
    setSelectedImageFailed(false);
    resetImageZoom();
  };

  const handleDialogImageError = () => {
    reportMediaLoadFailure.image({ reason: "error" });
    setSelectedImageFailed(true);
  };

  const retryDialogImage = () => {
    setSelectedImageFailed(false);
    setDialogImageReloadKey(key => key + 1);
    resetImageZoom();
  };

  const stopImageDragging = () => {
    isImageDraggingRef.current = false;
    imageDragStartRef.current = null;
    updateImageCursor();
  };

  const handleImagePointerDown = (
    event: React.PointerEvent<HTMLDivElement>
  ) => {
    if (event.button !== 0 || imageZoomRef.current <= IMAGE_ZOOM_MIN) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    hasImageDraggedRef.current = false;
    isImageDraggingRef.current = true;
    imageDragStartRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      panX: imagePanRef.current.x,
      panY: imagePanRef.current.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    updateImageCursor();
  };

  const handleImagePointerMove = (
    event: React.PointerEvent<HTMLDivElement>
  ) => {
    if (!isImageDraggingRef.current || !imageDragStartRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const deltaX = event.clientX - imageDragStartRef.current.pointerX;
    const deltaY = event.clientY - imageDragStartRef.current.pointerY;

    if (
      Math.abs(deltaX) > IMAGE_PAN_DRAG_THRESHOLD ||
      Math.abs(deltaY) > IMAGE_PAN_DRAG_THRESHOLD
    ) {
      hasImageDraggedRef.current = true;
    }

    const nextPan = clampImagePan(
      {
        x: imageDragStartRef.current.panX + deltaX,
        y: imageDragStartRef.current.panY + deltaY,
      },
      imageZoomRef.current
    );

    scheduleImagePanUpdate(nextPan);
  };

  const releaseImagePointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    stopImageDragging();
  };

  const handleImageCanvasClick = () => {
    if (hasImageDraggedRef.current) {
      hasImageDraggedRef.current = false;
      return;
    }

    if (imageZoom <= IMAGE_ZOOM_MIN) {
      zoomInImage();
    }
  };

  useEffect(() => {
    if (!selectedImageUrl) return;

    imageZoomRef.current = imageZoom;

    if (imageZoom <= IMAGE_ZOOM_MIN) {
      imagePanRef.current = { x: 0, y: 0 };
      stopImageDragging();
      hasImageDraggedRef.current = false;
    } else {
      imagePanRef.current = clampImagePan(imagePanRef.current, imageZoom);
    }

    applyImageTransform(imagePanRef.current, imageZoom);
    updateImageCursor();
  }, [imageZoom, selectedImageUrl]);

  useEffect(() => {
    if (!selectedImageUrl) return;

    const handleWindowResize = () => {
      imagePanRef.current = clampImagePan(
        imagePanRef.current,
        imageZoomRef.current
      );
      applyImageTransform(imagePanRef.current, imageZoomRef.current);
    };

    window.addEventListener("resize", handleWindowResize);

    return () => {
      window.removeEventListener("resize", handleWindowResize);
    };
  }, [imageZoom, selectedImageUrl]);

  useEffect(() => {
    return () => {
      clearScheduledImagePanUpdate();
      stopImageDragging();
    };
  }, []);

  useEffect(() => {
    if (!selectedImageUrl) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
        return;
      }

      const key = event.key;
      const code = event.code;

      const isZoomIn = key === "+" || key === "=" || code === "NumpadAdd";
      const isZoomOut = key === "-" || key === "_" || code === "NumpadSubtract";
      const isReset = key === "0" || code === "Digit0" || code === "Numpad0";

      if (isZoomIn) {
        event.preventDefault();
        zoomInImage();
        return;
      }

      if (isZoomOut) {
        event.preventDefault();
        zoomOutImage();
        return;
      }

      if (isReset) {
        event.preventDefault();
        resetImageZoom();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [selectedImageUrl]);

  const groupedMessages = groupMessagesByDate(messages, locale, (key: string) =>
    t(key)
  );

  const replyQuotePreviewIndex = useMemo(
    () => buildReplyQuotePreviewIndex(messages),
    [messages]
  );

  const flowMetadataByReplyMessageId = useMemo(() => {
    const byToken = new Map<string, StoredWhatsAppFlowFieldMetadataPreview[]>();

    for (const message of messages) {
      const flowMetadata = getMessageFlowFieldMetadata(message);
      const flowToken = normalizeMessagePreviewText(
        message.whatsappFlow?.flowToken
      );
      if (flowMetadata && flowToken) {
        byToken.set(flowToken, flowMetadata);
      }
    }

    const byReplyMessageId = new Map<
      string,
      StoredWhatsAppFlowFieldMetadataPreview[]
    >();
    let latestFlowMetadata: StoredWhatsAppFlowFieldMetadataPreview[] | null =
      null;

    for (const message of messages) {
      const messageId = message._id?.toString();
      const replyToken = normalizeMessagePreviewText(
        message.whatsappFlowReply?.flowToken
      );
      const replyFlowMetadata =
        (replyToken ? byToken.get(replyToken) : null) || latestFlowMetadata;

      if (messageId && message.direction === "inbound" && replyFlowMetadata) {
        byReplyMessageId.set(messageId, replyFlowMetadata);
      }

      const sentFlowMetadata = getMessageFlowFieldMetadata(message);
      if (message.direction === "outbound" && sentFlowMetadata) {
        latestFlowMetadata = sentFlowMetadata;
      }
    }

    return byReplyMessageId;
  }, [messages]);

  const handleTranscriptClick = useCallback(
    async (messageId: string) => {
      const patchTranscript = (
        patch: (current: MediaTranscriptState) => MediaTranscriptState
      ) =>
        setTranscripts(prev => ({
          ...prev,
          [messageId]: { ...prev[messageId], ...patch(prev[messageId] ?? {}) },
        }));

      if (transcripts[messageId]?.text) {
        patchTranscript(current => ({ expanded: !current.expanded }));
        return;
      }

      patchTranscript(() => ({ loading: true, error: undefined }));

      try {
        const response = await fetch(
          `/api/conversations/${conversationId}/transcript`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messageId }),
          }
        );

        const payload = (await response.json().catch(() => null)) as {
          transcript?: string;
          error?: string;
        } | null;

        if (!response.ok || !payload?.transcript) {
          throw new Error(payload?.error || "Failed to transcribe media");
        }

        const text = payload.transcript;
        patchTranscript(() => ({ text, expanded: true }));
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to transcribe media";
        patchTranscript(() => ({ error: message }));
      } finally {
        patchTranscript(() => ({ loading: false }));
      }
    },
    [conversationId, transcripts]
  );

  return (
    <div className="space-y-4 select-text">
      <style>{highlightStyle}</style>
      {groupedMessages.map(group => (
        <div key={group.date}>
          <div className="relative my-3">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-2 text-muted-foreground">
                {group.date}
              </span>
            </div>
          </div>
          <div className="space-y-0.5 md:space-y-1">
            {group.messages.map((msg, index) => {
              const messageId = msg._id.toString();
              // Inbound messages (customer) go LEFT.
              // Outbound messages (manager, Airi, business owner) go RIGHT.
              const isOutbound = msg.direction === "outbound";
              const sender = resolveMessageSender(msg, unnamedCustomer);
              const authorIsBot = msg.author?.isBot ?? false;
              const isHighlighted = highlightedMessageId === messageId;
              const previousMessage =
                index > 0 ? group.messages[index - 1] : null;
              const shouldShowAuthorLabel =
                showInboundAuthorNames &&
                !isOutbound &&
                !authorIsBot &&
                sender.key !==
                  (previousMessage
                    ? resolveMessageSender(previousMessage, unnamedCustomer).key
                    : null);
              const replyToMessageId =
                msg.telegramMeta?.replyToTelegramMessageId?.trim() ||
                msg.whatsappMeta?.replyToWhatsAppMessageId?.trim() ||
                null;
              const replyPreviewText = resolveReplyQuotePreviewText({
                storedPreview: sanitizeWhatsAppUserFacingText(
                  msg.telegramMeta?.replyToTextPreview ||
                    msg.whatsappMeta?.replyToTextPreview ||
                    null
                ),
                replyToMessageId,
                index: replyQuotePreviewIndex,
                missingPreviewFallback: "Earlier message",
              });
              const isRevokedMessage = msg.editMeta?.kind === "revoke";
              const isForwardedMessage = Boolean(
                msg.whatsappMeta?.frequentlyForwarded ||
                  msg.whatsappMeta?.forwarded
              );
              const forwardedLabel = msg.whatsappMeta?.frequentlyForwarded
                ? "Forwarded many times"
                : "Forwarded";
              const hasCanonicalWhatsAppServiceMessage =
                isWhatsAppConversation &&
                isOutbound &&
                hasStoredWhatsAppServiceMessage(msg.whatsappServiceMessage);
              const groundedReplyOptions =
                !hasCanonicalWhatsAppServiceMessage &&
                Array.isArray(msg.groundedReplyOptions?.options)
                  ? msg.groundedReplyOptions.options.filter(
                      option =>
                        typeof option?.label === "string" &&
                        option.label.trim().length > 0
                    )
                  : [];
              const whatsappCtaHref = hasCanonicalWhatsAppServiceMessage
                ? null
                : getSafeExternalHref(msg.whatsappCtaLink?.url);
              // For Instagram comment threads, strip the legacy metadata prefixes
              const displayText =
                isInstagramCommentThread && msg.text
                  ? stripInstagramCommentMeta(msg.text)
                  : msg.text;

              if (
                isWhatsAppConversation &&
                msg.direction === "inbound" &&
                msg.origin?.kind === "system" &&
                typeof displayText === "string" &&
                displayText.trim()
              ) {
                return (
                  <div
                    key={messageId}
                    className="flex w-full justify-center py-1"
                  >
                    <p className="max-w-[min(100%,32rem)] break-words rounded-full border border-amber-200/90 bg-amber-50/95 px-3 py-1.5 text-center text-[11px] leading-snug text-amber-950 [overflow-wrap:anywhere] dark:border-amber-900/50 dark:bg-amber-950/35 dark:text-amber-100/90">
                      {displayText}
                    </p>
                  </div>
                );
              }

              if (isRevokedMessage) {
                return (
                  <div
                    key={messageId}
                    data-message-id={messageId}
                    className={cn(
                      "flex w-full",
                      isOutbound ? "justify-end" : "justify-start"
                    )}
                  >
                    <div
                      className={cn(
                        "max-w-[85%] rounded-2xl px-3 py-2 text-sm italic text-muted-foreground",
                        isOutbound
                          ? "bg-primary/10 text-primary/80"
                          : "bg-muted/60"
                      )}
                    >
                      This message was deleted
                    </div>
                  </div>
                );
              }

              const whatsappFlowResponse =
                isWhatsAppConversation && !isOutbound
                  ? parseWhatsAppFlowResponseMessage(
                      msg,
                      flowMetadataByReplyMessageId.get(messageId) ||
                        getMessageFlowFieldMetadata(previousMessage)
                    )
                  : null;
              // A template whose FLOW button opens a Flow also stores that
              // Flow, to trace its reply; it still shows as the template.
              const whatsappFlowSend =
                isWhatsAppConversation &&
                isOutbound &&
                !hasCanonicalWhatsAppServiceMessage &&
                !msg.whatsappTemplate?.name?.trim() &&
                msg.whatsappFlow?.flowId
                  ? msg.whatsappFlow
                  : null;
              const whatsappServiceMessagePreview =
                isWhatsAppConversation &&
                isOutbound &&
                msg.whatsappServiceMessage
                  ? resolveWhatsAppServiceMessageCardPreview(
                      msg.whatsappServiceMessage
                    )
                  : null;
              // Carousel (and similar) also stash primary card media on imageUrl —
              // that must not render as a separate "Attached image".
              const serviceMessageOwnsVisualMedia =
                whatsappServiceMessagePreview?.kind === "media_carousel" ||
                whatsappServiceMessagePreview?.kind === "commerce";
              const templateNameFromText =
                extractWhatsAppTemplateNameFromText(displayText);
              const showsWhatsAppTemplateSendCard =
                isWhatsAppConversation &&
                isOutbound &&
                !hasCanonicalWhatsAppServiceMessage &&
                !whatsappFlowSend &&
                (Boolean(msg.whatsappTemplate) ||
                  Boolean(templateNameFromText));
              const whatsappReferralPreview =
                isWhatsAppConversation &&
                !isOutbound &&
                hasWhatsAppReferralPreview(msg.whatsappReferral)
                  ? msg.whatsappReferral
                  : null;
              const whatsappOrderPreview =
                isWhatsAppConversation &&
                hasWhatsAppOrderPreview(msg.whatsappOrder)
                  ? msg.whatsappOrder
                  : null;
              const whatsappProductInquiryPreview =
                isWhatsAppConversation &&
                hasWhatsAppProductInquiryPreview(msg.whatsappProductInquiry)
                  ? msg.whatsappProductInquiry
                  : null;
              const whatsappContacts =
                isWhatsAppConversation &&
                !hasCanonicalWhatsAppServiceMessage &&
                Array.isArray(msg.whatsappContacts) &&
                msg.whatsappContacts.length > 0
                  ? msg.whatsappContacts
                  : null;
              const whatsappLocation =
                isWhatsAppConversation &&
                !hasCanonicalWhatsAppServiceMessage &&
                msg.whatsappLocation &&
                (typeof msg.whatsappLocation.latitude === "number" ||
                  typeof msg.whatsappLocation.longitude === "number" ||
                  Boolean(readTrimmedString(msg.whatsappLocation.name)))
                  ? msg.whatsappLocation
                  : null;
              const templateBodyText =
                sanitizeWhatsAppUserFacingText(displayText);
              const templateSendIsStandalone =
                showsWhatsAppTemplateSendCard && templateBodyText.length === 0;
              const usesWhatsAppFlowCard =
                Boolean(
                  whatsappFlowSend ||
                    whatsappFlowResponse ||
                    whatsappServiceMessagePreview
                ) || templateSendIsStandalone;
              const textForMarkdown =
                whatsappServiceMessagePreview ||
                whatsappContacts ||
                templateSendIsStandalone ||
                (whatsappLocation &&
                  isWhatsAppLocationPlaceholderText(displayText))
                  ? ""
                  : showsWhatsAppTemplateSendCard
                    ? templateBodyText
                    : whatsappProductInquiryPreview
                      ? getProductInquiryMessageText(displayText || "")
                      : whatsappOrderPreview &&
                          isCommercePlaceholderOnly(displayText || "")
                        ? ""
                        : displayText || "";
              const baseMessageHasText =
                !usesWhatsAppFlowCard &&
                Boolean(textForMarkdown.trim()) &&
                !isMediaPlaceholderText(textForMarkdown);
              const reactionGroups = getReactionGroups(msg.reactions);
              const isEditedMessage =
                msg.editMeta?.kind === "edit" &&
                Boolean(msg.editMeta?.editedAt);
              const normalizedMediaType = msg.mediaType?.toLowerCase();
              const anyAttachmentUrl = getConversationAttachmentUrlByType(
                msg.attachments,
                "any"
              ).url;
              const imageAttachmentUrl = getConversationAttachmentUrlByType(
                msg.attachments,
                "image"
              ).url;
              const videoAttachmentUrl = getConversationAttachmentUrlByType(
                msg.attachments,
                "video"
              ).url;
              const audioAttachmentUrl = getConversationAttachmentUrlByType(
                msg.attachments,
                "audio"
              ).url;
              const documentAttachmentUrl = getConversationAttachmentUrlByType(
                msg.attachments,
                "document"
              ).url;

              const placeholderKind = getMediaPlaceholderKind(msg.text) ?? "";
              const isAudioKind =
                normalizedMediaType === "audio" ||
                normalizedMediaType === "voice" ||
                isConversationAudioMimeType(msg.mimeType) ||
                AUDIO_PLACEHOLDER_KINDS.has(placeholderKind);
              const isVideoKind =
                normalizedMediaType === "video" ||
                isConversationVideoMimeType(msg.mimeType);
              const isImageKind =
                normalizedMediaType === "image" ||
                normalizedMediaType === "sticker" ||
                isConversationImageMimeType(msg.mimeType) ||
                (!normalizedMediaType &&
                  !NON_IMAGE_PLACEHOLDER_KINDS.has(placeholderKind));

              // Resolve typed media by type only. Falling back to the first
              // attachment lets a document land in the audio or video element,
              // which then stalls with no error.
              const audioSourceUrl = isAudioKind
                ? msg.imageUrl || audioAttachmentUrl
                : undefined;
              const videoSourceUrl =
                !serviceMessageOwnsVisualMedia && !isAudioKind && isVideoKind
                  ? msg.imageUrl || videoAttachmentUrl
                  : undefined;
              const imageSourceUrl =
                !serviceMessageOwnsVisualMedia &&
                !isAudioKind &&
                !isVideoKind &&
                isImageKind
                  ? msg.imageUrl || imageAttachmentUrl
                  : undefined;
              const fallbackDocumentUrl =
                !audioSourceUrl && !videoSourceUrl && !imageSourceUrl
                  ? msg.imageUrl || documentAttachmentUrl || anyAttachmentUrl
                  : undefined;
              const documentSourceUrl =
                fallbackDocumentUrl &&
                (normalizedMediaType
                  ? !["audio", "voice", "image", "video", "sticker"].includes(
                      normalizedMediaType
                    )
                  : Boolean(documentAttachmentUrl))
                  ? fallbackDocumentUrl
                  : undefined;
              const documentDisplayName =
                msg.fileName || `${normalizedMediaType || "file"} attachment`;
              const documentFileSizeLabel =
                formatConversationAttachmentFileSize(msg.fileSize);
              const messageHasText =
                baseMessageHasText &&
                !(
                  documentSourceUrl &&
                  isConversationAttachmentLabelOnlyText(
                    textForMarkdown,
                    documentDisplayName
                  )
                );
              const messageDate = new Date(msg.date);
              const messageTimeLabel = Number.isNaN(messageDate.getTime())
                ? "Invalid Date"
                : timeFormatter.format(messageDate);
              const statusDelivery =
                isOutbound && supportsDeliveryStatus && msg.delivery
                  ? msg.delivery
                  : null;
              const pricingDelivery =
                isOutbound && isWhatsAppConversation && msg.delivery
                  ? msg.delivery
                  : null;
              const shouldInlineDocumentMeta =
                Boolean(documentSourceUrl) && !messageHasText;
              const hasVisualMedia = Boolean(imageSourceUrl || videoSourceUrl);
              const hasMediaPayload =
                hasVisualMedia ||
                Boolean(
                  audioSourceUrl || documentSourceUrl || whatsappContacts
                );
              const canEditWhatsAppOutbound =
                isWhatsAppConversation &&
                isOutbound &&
                messageHasText &&
                Boolean(String(msg.messageId || "").trim()) &&
                !showsWhatsAppTemplateSendCard &&
                isStoredWhatsAppTextMessageEditable(msg) &&
                !hasMediaPayload &&
                Date.now() - new Date(msg.date || Date.now()).getTime() <=
                  WHATSAPP_TEXT_EDIT_WINDOW_MS;
              const messageShellClassName = cn(
                "group relative min-w-0",
                usesWhatsAppFlowCard
                  ? STRUCTURED_MESSAGE_WIDTH_CLASS
                  : hasVisualMedia
                    ? VISUAL_MEDIA_MESSAGE_WIDTH_CLASS
                    : hasMediaPayload
                      ? `w-fit ${MESSAGE_BUBBLE_MAX_WIDTH_CLASS}`
                      : MESSAGE_BUBBLE_MAX_WIDTH_CLASS
              );
              const messageContentClassName = cn(
                "relative group min-w-0 transition-colors",
                usesWhatsAppFlowCard
                  ? "w-full max-w-none rounded-none bg-transparent p-0 shadow-none"
                  : hasVisualMedia
                    ? "w-fit max-w-full rounded-none bg-transparent p-0 shadow-none"
                    : hasMediaPayload
                      ? "w-full max-w-full px-1.5 pt-1.5 pb-1 shadow-sm"
                      : "w-full max-w-full px-2.5 pt-1.5 pb-1 shadow-sm md:max-w-md md:px-3 md:pt-2.5 md:pb-0.5",
                usesWhatsAppFlowCard || hasVisualMedia
                  ? null
                  : isOutbound
                    ? "bg-primary text-primary-foreground rounded-[1.25rem] rounded-br-none"
                    : "bg-muted text-foreground rounded-[1.25rem] rounded-bl-none border border-border/40"
              );
              const transcript = transcripts[messageId] ?? {};
              const isTranscriptExpanded = Boolean(
                transcript.text && transcript.expanded
              );
              const transcriptActionLabel = transcript.loading
                ? "Transcribing media"
                : isTranscriptExpanded
                  ? "Hide transcript"
                  : "Show transcript";

              return (
                <Message
                  key={messageId}
                  data-message-id={messageId}
                  from={isOutbound ? "user" : "assistant"}
                  className={cn(
                    "min-w-0 gap-1.5 py-0.5 md:gap-2 md:py-1",
                    usesWhatsAppFlowCard ? "items-start" : "items-end",
                    isHighlighted && "highlight-animation"
                  )}
                >
                  {!isOutbound && showInboundAuthorNames && (
                    <MessageAvatar
                      src={authorIsBot ? null : msg.author?.avatar_url || null}
                      name={authorIsBot ? "AI" : sender.name}
                      className="mb-0.5 h-7 w-7 shrink-0 border border-primary/20 bg-primary/10 text-primary ring-0 md:h-8 md:w-8"
                    />
                  )}
                  <OutboundWhatsAppMessageBubble
                    enabled={canEditWhatsAppOutbound}
                    message={msg}
                    conversationId={conversationId}
                    onTextUpdated={onMessageTextUpdated}
                    className={messageShellClassName}
                  >
                    <MessageContent
                      variant="flat"
                      className={messageContentClassName}
                    >
                      {/* Sender names are hidden for 1:1 conversations to avoid redundancy. */}
                      {shouldShowAuthorLabel && (
                        <p className="text-[10px] md:text-xs font-bold mb-1 opacity-70">
                          {sender.name}
                        </p>
                      )}

                      {isForwardedMessage ? (
                        <p className="mb-1 text-[10px] italic opacity-70">
                          {forwardedLabel}
                        </p>
                      ) : null}

                      {replyPreviewText && (
                        <div className="mb-1.5">
                          <div
                            className={cn(
                              "rounded-md border px-2 py-1 text-[11px] leading-snug",
                              isOutbound
                                ? "border-primary-foreground/20 bg-primary-foreground/10 text-primary-foreground/90"
                                : "border-border/50 bg-background/70 text-muted-foreground"
                            )}
                          >
                            {replyPreviewText}
                          </div>
                        </div>
                      )}

                      {whatsappReferralPreview ? (
                        <WhatsAppReferralPreviewCard
                          referral={whatsappReferralPreview}
                          isOutbound={isOutbound}
                        />
                      ) : null}

                      {whatsappOrderPreview ? (
                        <WhatsAppOrderPreviewCard
                          order={whatsappOrderPreview}
                          isOutbound={isOutbound}
                        />
                      ) : null}

                      {whatsappProductInquiryPreview ? (
                        <WhatsAppProductInquiryPreviewCard
                          inquiry={whatsappProductInquiryPreview}
                          isOutbound={isOutbound}
                        />
                      ) : null}

                      {whatsappServiceMessagePreview ? (
                        <WhatsAppServiceMessageCard
                          preview={whatsappServiceMessagePreview}
                          workspaceId={workspaceId}
                        />
                      ) : null}

                      {whatsappFlowSend ? (
                        <div className="mb-1.5">
                          <WhatsAppFlowSendCard
                            flow={whatsappFlowSend}
                            fallbackText={displayText}
                          />
                        </div>
                      ) : null}

                      {showsWhatsAppTemplateSendCard && (
                        <div className="mb-1.5">
                          <WhatsAppTemplateSendCard
                            preview={msg.whatsappTemplate}
                            fallbackName={templateNameFromText}
                          />
                        </div>
                      )}

                      {whatsappCtaHref ? (
                        <div className="mb-1.5 rounded-md border border-border/60 bg-background/70 px-2.5 py-2 text-xs">
                          <p className="font-medium">
                            {msg.whatsappCtaLink?.title?.trim() || "Open link"}
                          </p>
                          <a
                            href={whatsappCtaHref}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-0.5 block truncate text-primary underline-offset-2 hover:underline"
                          >
                            {msg.whatsappCtaLink?.url}
                          </a>
                        </div>
                      ) : null}

                      {groundedReplyOptions.length > 0 ? (
                        <div className="mb-1.5 flex flex-wrap gap-1.5">
                          {groundedReplyOptions.map(option => (
                            <span
                              key={option.id}
                              className="rounded-full border border-border/60 bg-background/80 px-2 py-0.5 text-[11px] text-muted-foreground"
                            >
                              {option.label}
                            </span>
                          ))}
                        </div>
                      ) : null}

                      {whatsappFlowResponse ? (
                        <div className="mb-1.5">
                          <WhatsAppFlowReplyCard
                            title={resolveWhatsAppFlowResponseTitle({
                              reply: whatsappFlowResponse,
                              previousMessage,
                            })}
                            subtitle="Response sent"
                            fields={whatsappFlowResponse.fields}
                          />
                        </div>
                      ) : null}

                      {whatsappLocation ? (
                        <WhatsAppLocationCard
                          location={whatsappLocation}
                          isOutbound={isOutbound}
                        />
                      ) : null}

                      {whatsappContacts ? (
                        <div className="space-y-1.5">
                          {whatsappContacts.map((contact, index) => (
                            <WhatsAppContactCard
                              key={`contact-${messageId}-${index}`}
                              contact={contact}
                              isOutbound={isOutbound}
                            />
                          ))}
                        </div>
                      ) : null}

                      {audioSourceUrl && (
                        <div
                          className={cn(
                            MEDIA_MESSAGE_CARD_WIDTH_CLASS,
                            "mb-1 rounded-lg border border-border/40 bg-background/60 p-1"
                          )}
                        >
                          <AudioPlayerProvider
                            mimeType={msg.mimeType}
                            onLoadError={reportMediaLoadFailure.audio}
                          >
                            <div className="flex min-w-0 items-center gap-1">
                              <AudioPlayerButton
                                item={{
                                  id: messageId,
                                  src: audioSourceUrl,
                                }}
                                variant="outline"
                                size="icon"
                                className="h-7 w-7 shrink-0"
                              />
                              <AudioPlayerProgress className="min-w-0 flex-1" />
                              <div className="flex shrink-0 items-center gap-1 text-[11px]">
                                <AudioPlayerTime className="text-[11px]" />
                                <span className="text-muted-foreground">/</span>
                                <AudioPlayerDuration className="text-[11px]" />
                              </div>
                              <AudioPlayerSpeed className="h-7 w-7 shrink-0" />
                            </div>
                            <AudioPlayerError
                              src={audioSourceUrl}
                              className="mt-1 px-1"
                            />
                          </AudioPlayerProvider>
                        </div>
                      )}

                      {videoSourceUrl && (
                        <div className="mb-2 flex items-center justify-end">
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={() =>
                              void handleTranscriptClick(messageId)
                            }
                            disabled={transcript.loading}
                            aria-label={transcriptActionLabel}
                            title={transcriptActionLabel}
                            className={cn(
                              "h-7 w-7",
                              isOutbound
                                ? "text-primary-foreground/90 hover:text-primary-foreground hover:bg-primary-foreground/15"
                                : "text-muted-foreground hover:text-foreground hover:bg-background/70"
                            )}
                          >
                            {transcript.loading ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <FileText className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </div>
                      )}

                      {transcript.error && (
                        <p
                          className={cn(
                            "mb-2 text-xs",
                            isOutbound
                              ? "text-primary-foreground/90"
                              : "text-destructive"
                          )}
                        >
                          {transcript.error}
                        </p>
                      )}

                      {isTranscriptExpanded && (
                        <div
                          className={cn(
                            "mb-2 rounded-md border px-2 py-1.5 text-xs leading-relaxed whitespace-pre-wrap break-words",
                            isOutbound
                              ? "border-primary-foreground/30 bg-primary-foreground/10 text-primary-foreground"
                              : "border-border/50 bg-background/70 text-foreground/90"
                          )}
                        >
                          {transcript.text}
                        </div>
                      )}

                      {imageSourceUrl && (
                        <ConversationImageThumbnail
                          src={imageSourceUrl}
                          alt={t("attachedImageAlt")}
                          onOpen={() => openImageDialog(imageSourceUrl)}
                          onLoadError={reportMediaLoadFailure.image}
                        />
                      )}

                      {videoSourceUrl && (
                        <div className="mb-1.5 w-full max-w-full">
                          <VideoPlayer
                            src={videoSourceUrl}
                            mimeType={msg.mimeType}
                            fileName={msg.fileName}
                            fileSize={msg.fileSize}
                            isPlatformMessage={!isOutbound}
                            onLoadError={reportMediaLoadFailure.video}
                          />
                        </div>
                      )}

                      {/* Text message */}
                      {messageHasText && (
                        <div
                          className={cn(
                            "flex min-w-0 flex-col",
                            hasVisualMedia && "max-w-full"
                          )}
                        >
                          {searchQuery?.trim() ? (
                            <p className="text-sm leading-relaxed break-words select-text [overflow-wrap:anywhere]">
                              <HighlightedText
                                text={textForMarkdown}
                                searchQuery={searchQuery}
                              />
                            </p>
                          ) : (
                            <div
                              className={cn(
                                "prose prose-sm break-words leading-relaxed select-text [overflow-wrap:anywhere]",
                                "prose-headings:my-1.5 prose-headings:text-sm prose-headings:font-semibold",
                                "prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5",
                                "prose-strong:font-semibold prose-code:text-inherit prose-pre:bg-transparent",
                                "prose-a:no-underline prose-a:inline-flex prose-a:max-w-full prose-a:w-fit prose-a:items-center prose-a:rounded-md prose-a:border prose-a:px-2 prose-a:py-1 prose-a:text-xs prose-a:font-semibold prose-a:transition-colors",
                                hasVisualMedia ? "max-w-full" : "max-w-none",
                                hasVisualMedia || !isOutbound
                                  ? "text-foreground prose-headings:text-foreground prose-strong:text-foreground prose-a:text-foreground prose-a:bg-background/60 prose-a:border-border/60 hover:prose-a:bg-background/90"
                                  : "text-primary-foreground prose-headings:text-primary-foreground prose-strong:text-primary-foreground prose-a:!text-primary-foreground prose-a:bg-primary-foreground/10 prose-a:border-primary-foreground/40 hover:prose-a:bg-primary-foreground/20"
                              )}
                            >
                              <ConversationMessageMarkdown
                                text={textForMarkdown}
                              />
                            </div>
                          )}
                        </div>
                      )}

                      {/* Document/File attachment (if not audio/video/image) */}
                      {documentSourceUrl && (
                        <div
                          className={cn(MEDIA_MESSAGE_CARD_WIDTH_CLASS, "mb-1")}
                        >
                          <a
                            href={documentSourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={cn(
                              "flex min-w-0 flex-col gap-2 overflow-hidden rounded-lg p-2.5 transition-colors",
                              isOutbound
                                ? "bg-primary/10 hover:bg-primary/20"
                                : "bg-muted/50 hover:bg-muted/70"
                            )}
                          >
                            <span
                              className={cn(
                                "flex min-w-0 items-center gap-1.5 truncate text-sm font-medium",
                                isOutbound
                                  ? "text-primary-foreground"
                                  : "text-foreground"
                              )}
                            >
                              <FileText className="h-4 w-4 shrink-0" />
                              <span className="truncate">
                                {documentDisplayName}
                              </span>
                            </span>
                            {shouldInlineDocumentMeta && (
                              <span
                                className={cn(
                                  "flex min-w-0 items-center justify-between gap-3 text-xs",
                                  isOutbound
                                    ? "text-primary-foreground/60"
                                    : "text-muted-foreground/80"
                                )}
                              >
                                <span className="truncate">
                                  {documentFileSizeLabel || ""}
                                </span>
                                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                                  {pricingDelivery ? (
                                    <DeliveryPricingChip
                                      delivery={pricingDelivery}
                                      isOutbound={isOutbound}
                                    />
                                  ) : null}
                                  <span>{messageTimeLabel}</span>
                                  {statusDelivery ? (
                                    <DeliveryStatusIndicator
                                      delivery={statusDelivery}
                                      isOutbound={isOutbound}
                                    />
                                  ) : null}
                                </span>
                              </span>
                            )}
                          </a>
                          {!shouldInlineDocumentMeta &&
                            documentFileSizeLabel && (
                              <p
                                className={cn(
                                  "text-xs mt-1.5",
                                  isOutbound
                                    ? "text-primary-foreground/50"
                                    : "text-muted-foreground/70"
                                )}
                              >
                                {documentFileSizeLabel}
                              </p>
                            )}
                        </div>
                      )}

                      {(!shouldInlineDocumentMeta ||
                        (onReplyTargetSelect && !isOutbound)) && (
                        <div
                          data-message-footer=""
                          className={cn(
                            "mt-1 flex flex-wrap items-center justify-end gap-x-1 text-[11px] font-medium",
                            usesWhatsAppFlowCard
                              ? "px-1 text-muted-foreground"
                              : hasVisualMedia
                                ? "text-muted-foreground"
                                : isOutbound
                                  ? "text-primary-foreground"
                                  : "text-foreground/70"
                          )}
                        >
                          {onReplyTargetSelect && !isOutbound && (
                            <button
                              type="button"
                              onClick={() => onReplyTargetSelect(msg)}
                              className="mr-auto grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-background/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              aria-label={t("replyToMessage")}
                              title={t("replyToMessage")}
                            >
                              <Reply className="size-3.5" aria-hidden />
                            </button>
                          )}
                          {pricingDelivery ? (
                            <DeliveryPricingChip
                              delivery={pricingDelivery}
                              isOutbound={isOutbound}
                            />
                          ) : null}
                          {!shouldInlineDocumentMeta && (
                            <span>{messageTimeLabel}</span>
                          )}
                          {statusDelivery ? (
                            <DeliveryStatusIndicator
                              delivery={statusDelivery}
                              isOutbound={isOutbound}
                            />
                          ) : null}
                          {isEditedMessage ? (
                            <span className="ml-1.5">
                              {t("editedMessageLabel")}
                            </span>
                          ) : null}
                        </div>
                      )}

                      {reactionGroups.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {reactionGroups.map(group => (
                            <div
                              key={`${messageId}-${group.emoji}`}
                              className={cn(
                                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium shadow-sm",
                                usesWhatsAppFlowCard || !isOutbound
                                  ? "bg-background border-border/70 text-foreground"
                                  : "bg-primary-foreground/95 border-primary-foreground/60 text-primary"
                              )}
                              title={group.authors
                                .map(author => author.authorName)
                                .join(", ")}
                            >
                              <span>{group.emoji}</span>
                              <div className="flex -space-x-1">
                                {group.authors.slice(0, 3).map(author => (
                                  <Avatar
                                    key={`${group.emoji}-${author.authorId}`}
                                    className="h-4 w-4 border border-background"
                                  >
                                    <AvatarFallback className="text-[8px]">
                                      {author.authorName
                                        .charAt(0)
                                        .toUpperCase()}
                                    </AvatarFallback>
                                  </Avatar>
                                ))}
                              </div>
                              {group.count > 1 && (
                                <span className="text-[10px] font-semibold">
                                  {group.count}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </MessageContent>
                  </OutboundWhatsAppMessageBubble>
                </Message>
              );
            })}
          </div>
        </div>
      ))}
      <Dialog
        open={Boolean(selectedImageUrl)}
        onOpenChange={open => {
          if (!open) {
            closeImageDialog();
          }
        }}
      >
        <DialogContent
          className="max-w-[95vw] w-full p-2 bg-black border-0"
          showCloseButton={true}
        >
          {selectedImageUrl && selectedImageFailed && (
            <MediaLoadError
              message="Could not load image."
              href={selectedImageUrl}
              onRetry={retryDialogImage}
              className="flex min-h-[40vh] flex-col items-center justify-center gap-3 p-6 text-center text-sm text-white"
              actionsClassName="justify-center gap-4 text-xs"
              linkClassName="text-blue-400"
            />
          )}
          {selectedImageUrl && !selectedImageFailed && (
            <div className="relative">
              <div className="absolute top-2 left-2 z-20 flex items-center gap-1 rounded-md bg-black/70 p-1.5 backdrop-blur-sm">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={zoomOutImage}
                  disabled={imageZoom <= IMAGE_ZOOM_MIN}
                  className="h-8 w-8 text-white hover:bg-white/10 hover:text-white disabled:opacity-50"
                  aria-label="Zoom out image"
                >
                  <Minus className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={zoomInImage}
                  disabled={imageZoom >= IMAGE_ZOOM_MAX}
                  className="h-8 w-8 text-white hover:bg-white/10 hover:text-white disabled:opacity-50"
                  aria-label="Zoom in image"
                >
                  <Plus className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={resetImageZoom}
                  className="h-8 w-8 text-white hover:bg-white/10 hover:text-white"
                  aria-label="Reset image zoom"
                >
                  <RotateCcw className="h-4 w-4" />
                </Button>
                <span className="ml-1 min-w-[56px] text-center text-xs font-medium text-white">
                  {Math.round(imageZoom * 100)}%
                </span>
              </div>
              <div className="flex max-h-[85vh] min-h-[60vh] items-center justify-center overflow-hidden rounded-md">
                <div
                  ref={imageViewportRef}
                  className="flex max-h-[85vh] w-full items-center justify-center overflow-hidden p-2 select-none"
                  style={{
                    cursor: imageZoom <= IMAGE_ZOOM_MIN ? "zoom-in" : "grab",
                  }}
                  onPointerDown={handleImagePointerDown}
                  onPointerMove={handleImagePointerMove}
                  onPointerUp={releaseImagePointer}
                  onPointerCancel={releaseImagePointer}
                  onClick={handleImageCanvasClick}
                >
                  <img
                    key={dialogImageReloadKey}
                    ref={imageElementRef}
                    src={selectedImageUrl}
                    alt={t("attachedImageAlt")}
                    className="max-h-[85vh] max-w-full w-auto object-contain rounded-md"
                    draggable={false}
                    onError={handleDialogImageError}
                    onLoad={() => {
                      imagePanRef.current = clampImagePan(
                        imagePanRef.current,
                        imageZoomRef.current
                      );
                      applyImageTransform(
                        imagePanRef.current,
                        imageZoomRef.current
                      );
                      updateImageCursor();
                    }}
                    style={{
                      transform: `translate3d(${imagePanRef.current.x}px, ${imagePanRef.current.y}px, 0) scale(${imageZoom})`,
                      transformOrigin: "center center",
                      willChange: "transform",
                    }}
                  />
                </div>
              </div>
              <p className="mt-2 px-2 text-center text-xs text-white/70">
                Hotkeys:{" "}
                <kbd className="rounded bg-white/10 px-1.5 py-0.5">+</kbd> zoom
                in, <kbd className="rounded bg-white/10 px-1.5 py-0.5">-</kbd>{" "}
                zoom out,{" "}
                <kbd className="rounded bg-white/10 px-1.5 py-0.5">0</kbd> reset
                {" • "}drag with left mouse when zoomed in
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export const ConversationThread = memo(ConversationThreadContent);
