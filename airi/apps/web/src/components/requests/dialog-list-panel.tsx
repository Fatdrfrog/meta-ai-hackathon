"use client";

import { useRequestsRealtime } from "@/components/tables/requests-realtime-provider";
import { PlanUpgradeDialog } from "@/components/billing/plan-upgrade-dialog";
import { SourceRequiredState } from "@/components/onboarding/source-required-state";
import { useLazyRef } from "@/hooks/use-lazy-ref";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  requestsDialogSearchTypeAtom,
  requestsDialogSelectedCategoryAtom,
  requestsDialogSelectedInternalLabelAtom,
  requestsDialogSelectedSourceTypeAtom,
  type RequestsDialogSearchType,
} from "@/components/requests/requests-state";
import { formatDateOrTime } from "@/lib/date-utils";
import {
  buildConversationListPreview,
  compactPreviewText,
  type ConversationListPreview,
} from "@/features/panel/requests/message-preview";
import { formatTelegramTopicLabel } from "@/lib/telegram/message-identity";
import { getNameInitials } from "@/lib/conversation/display-name";
import { cn } from "@/lib/utils";
import { AnimatePresence, motion } from "framer-motion";
import { useAtom } from "jotai";
import {
  Check,
  FileText,
  Images,
  Lightbulb,
  Link2,
  ListChecks,
  Loader2,
  MapPin,
  MessageSquareReply,
  Paperclip,
  Pencil,
  Phone,
  PhoneCall,
  Save,
  Search,
  ShoppingBag,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import React, {
  Suspense,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import useSWR, { useSWRConfig } from "swr";

import type { RequestsPlanGate } from "@/features/panel/requests/data-projection";
import {
  formatConversationToRequest,
  type FormattedRequest as RequestItem,
  type RawConversation,
} from "@/features/panel/requests/formatting";
import {
  CONVERSATION_CHANNELS,
  isConversationChannel,
  type ConversationChannel,
} from "@icecore/shared/types/sources";
import { isConversationStatus } from "@icecore/shared/types/conversation";
import { mergeDisplayRequests } from "./dialog-list-display";
import { RequestRowSkeleton } from "./request-row-skeleton";
import {
  normalizeInternalLabelOptions,
  normalizeSelectStringOptions,
  type InternalLabelOption,
} from "./dialog-list-filter-options";
import {
  clearRequestsListQueryParams,
  hasRequestsListQuery,
  parseRequestsListQuery,
  requestMatchesListQuery,
} from "@/features/panel/requests/list-query";
import { preloadConversationDetailView } from "@/components/conversation/conversation-detail-loader";
import { preloadConversationDetail } from "@/lib/conversation/detail-client";
import {
  buildConversationSelectionUrl,
  updateUrlWithoutNavigation,
} from "./dialog-list-panel-url";

function preloadChatModuleOnIntent(): void {
  // A failed speculative load must not interrupt list interaction.
  void preloadConversationDetailView().catch(() => undefined);
}

interface DialogListPanelProps {
  workspaceId: string;
  requests: RequestItem[];
  initialAvailableChannels: string[];
  initialAvailableCategories?: string[];
  initialHasMore: boolean;
  initialPlanGate?: RequestsPlanGate | null;
  shouldHydrateFromApiOnMount?: boolean;
  initialRenderNowMs: number;
  activeConversationId: string | null;
  onSelectConversation: (
    id: string,
    options?: {
      messageSearchQuery?: string | null;
      requestPreview?: RequestItem | null;
    }
  ) => void;
  isMobile?: boolean;
  hasConfiguredSources?: boolean | Promise<boolean>;
}

type RequestsFirstPageResult = {
  requests: RequestItem[];
  hasNextPage: boolean;
  planGate: RequestsPlanGate | null;
  totalCount: number;
};

type RequestsFirstPageCacheEntry = RequestsFirstPageResult & {
  cachedAtMs: number;
};

const REQUESTS_PAGE_LIMIT = 50;
const REQUESTS_TEXT_SEARCH_DEBOUNCE_MS = 180;
const REQUESTS_PAGE_TIMEOUT_MS = 15_000;
const REQUESTS_FILTER_CACHE_TTL_MS = 15_000;
const REQUESTS_FILTER_CACHE_MAX_ENTRIES = 8;
const UNREAD_REFRESH_DEBOUNCE_MS = 300;
const UNREAD_REFRESH_MIN_INTERVAL_MS = 5_000;
const EMPTY_AVAILABLE_CATEGORIES: string[] = [];
const EMPTY_RECENTLY_READ_CONVERSATIONS = new Set<string>();
const DEFAULT_DIALOG_SEARCH_TYPE: RequestsDialogSearchType =
  "message_within_chat";
const SERVER_RENDER_TIME_ZONE = "UTC";

type DialogListTranslator = ReturnType<typeof useTranslations>;

function readFreshRequestsCacheEntry(
  cache: Map<string, RequestsFirstPageCacheEntry>,
  key: string
) {
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }

  if (Date.now() - entry.cachedAtMs > REQUESTS_FILTER_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }

  return entry;
}

function writeRequestsCacheEntry(
  cache: Map<string, RequestsFirstPageCacheEntry>,
  key: string,
  result: RequestsFirstPageResult
) {
  cache.delete(key);
  cache.set(key, { ...result, cachedAtMs: Date.now() });

  while (cache.size > REQUESTS_FILTER_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    cache.delete(oldestKey);
  }
}

// Filter label, row badge text and badge colour for each stored channel.
const REQUEST_CHANNELS: Record<
  ConversationChannel,
  { label: string; badge: string; color: string }
> = {
  telegram: {
    label: "Telegram",
    badge: "telegram",
    color: "bg-sky-100 text-sky-700 border-sky-200",
  },
  whatsapp: {
    label: "WhatsApp",
    badge: "whatsapp",
    color: "bg-green-100 text-green-700 border-green-200",
  },
  email: {
    label: "Email",
    badge: "email",
    color: "bg-yellow-100 text-yellow-700 border-yellow-200",
  },
  instagram: {
    label: "Instagram",
    badge: "instagram",
    color: "bg-pink-100 text-pink-700 border-pink-200",
  },
  web_widget: {
    label: "Web Widget",
    badge: "web",
    color: "bg-indigo-100 text-indigo-700 border-indigo-200",
  },
};

function channelLabel(channel: string): string {
  return isConversationChannel(channel)
    ? REQUEST_CHANNELS[channel].label
    : channel;
}

const FILTER_OPTION_LIMIT = 5;
// The first mode is the default.
const REQUEST_SEARCH_MODE_OPTIONS = [
  {
    value: "message_within_chat",
    labelKey: "searchTypeMessage",
    placeholderKey: "searchPlaceholderMessage",
  },
  {
    value: "profile_name",
    labelKey: "searchTypeProfile",
    placeholderKey: "searchPlaceholderProfile",
  },
  {
    value: "phone_number",
    labelKey: "searchTypePhone",
    placeholderKey: "searchPlaceholderPhone",
  },
  {
    value: "source_type",
    labelKey: "searchTypeSource",
    placeholderKey: "searchPlaceholderSource",
  },
] as const satisfies readonly {
  value: RequestsDialogSearchType;
  labelKey: string;
  placeholderKey: string;
}[];

const internalLabelsFetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch internal labels");
  return res.json();
};

function getVisibleFilterValues(
  values: readonly string[],
  selectedValue: string,
  limit = FILTER_OPTION_LIMIT
) {
  const visible = values.slice(0, limit);
  if (
    selectedValue &&
    selectedValue !== "all" &&
    !visible.includes(selectedValue)
  ) {
    visible.push(selectedValue);
  }
  return visible;
}

function FilterChoiceButton({
  active,
  children,
  className,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex min-h-11 min-w-0 max-w-full items-center rounded-full border px-3 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-7 md:px-2.5 md:py-0 md:text-[11px]",
        "border-border/60 bg-background text-muted-foreground hover:border-border hover:bg-muted/60 hover:text-foreground",
        active &&
          "border-foreground bg-foreground text-background hover:bg-foreground/90 hover:text-background",
        className
      )}
    >
      <span className="min-w-0 max-w-full [overflow-wrap:anywhere] md:max-w-28 md:truncate">
        {children}
      </span>
    </button>
  );
}

function getStatusColor(status: string) {
  switch (status) {
    case "open":
      return "bg-green-500/10 text-green-700 hover:bg-green-500/20 border-green-200";
    case "closed":
      return "bg-gray-100 text-gray-600 hover:bg-gray-200 border-gray-200";
    case "in_progress":
      return "bg-blue-500/10 text-blue-700 hover:bg-blue-500/20 border-blue-200";
    case "rated":
      return "bg-purple-500/10 text-purple-700 hover:bg-purple-500/20 border-purple-200";
    case "awaiting_rating":
      return "bg-yellow-500/10 text-yellow-700 hover:bg-yellow-500/20 border-yellow-200";
    case "expired":
      return "bg-red-500/10 text-red-700 hover:bg-red-500/20 border-red-200";
    default:
      return "bg-gray-100 text-gray-600 border-gray-200";
  }
}

const MUTED_CHIP_COLOR = "bg-muted/50 text-muted-foreground";

function ChipBadge({
  color,
  textCase = "capitalize",
  children,
}: {
  color: string;
  textCase?: "capitalize" | "lowercase" | "none";
  children: React.ReactNode;
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "text-[10px] h-4 px-1.5 py-0 font-normal border",
        textCase !== "none" && textCase,
        color
      )}
    >
      {children}
    </Badge>
  );
}

function StatusChip({
  status,
  t,
}: {
  status: string;
  t: DialogListTranslator;
}) {
  return (
    <ChipBadge color={getStatusColor(status)}>
      {isConversationStatus(status) ? t(`statuses.${status}`) : status}
    </ChipBadge>
  );
}

function WhatsAppStatus({
  lastInboundMessageAt,
  nowMs,
  t,
}: {
  lastInboundMessageAt?: Date | string | null;
  nowMs: number;
  t: DialogListTranslator;
}) {
  const windowDuration = 24 * 60 * 60 * 1000;
  const timeLeft = lastInboundMessageAt
    ? windowDuration - (nowMs - new Date(lastInboundMessageAt).getTime())
    : 0;

  // No inbound message yet and an expired window both read as closed.
  if (timeLeft <= 0) {
    return (
      <ChipBadge color={getStatusColor("expired")}>
        {t("windowClosed")}
      </ChipBadge>
    );
  }

  const hours = Math.floor(timeLeft / (1000 * 60 * 60));
  const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));

  let color = "bg-green-500/10 text-green-700 border-green-200";
  if (hours < 1) color = "bg-red-500/10 text-red-700 border-red-200";
  else if (hours < 4)
    color = "bg-yellow-500/10 text-yellow-700 border-yellow-200";

  return (
    <ChipBadge color={color} textCase="lowercase">
      {hours > 0 ? `${hours}h ` : ""}
      {minutes}m {t("left")}
    </ChipBadge>
  );
}

function TelegramStatus({
  req,
  t,
}: {
  req: RequestItem;
  t: DialogListTranslator;
}) {
  if (req.customerSatisfactionScore) {
    return (
      <ChipBadge color={getStatusColor("rated")}>
        {t("rated")} ★{req.customerSatisfactionScore}
      </ChipBadge>
    );
  }

  if (req.awaitingCsat) {
    return (
      <ChipBadge color={getStatusColor("awaiting_rating")}>
        {t("awaitingRating")}
      </ChipBadge>
    );
  }

  return <StatusChip status={req.status} t={t} />;
}

function SourceChip({ channel }: { channel?: string }) {
  const known = isConversationChannel(channel)
    ? REQUEST_CHANNELS[channel]
    : null;
  return (
    <ChipBadge
      color={known?.color ?? "bg-slate-100 text-slate-600 border-slate-200"}
    >
      {known?.badge ?? (channel || "other").toLowerCase()}
    </ChipBadge>
  );
}

function formatInstagramMediaTypeLabel(value?: string): string {
  switch ((value || "").toUpperCase()) {
    case "IMAGE":
      return "Image";
    case "VIDEO":
      return "Video";
    case "CAROUSEL_ALBUM":
      return "Carousel";
    case "REELS":
      return "Reel";
    default:
      return "Post";
  }
}

function instagramMediaFacts(req: RequestItem) {
  return {
    author:
      req.instagramMeta?.mediaAuthorUsername?.trim().replace(/^@+/, "") ?? "",
    mediaTypeLabel: formatInstagramMediaTypeLabel(
      req.instagramMeta?.mediaType || req.instagramMeta?.mediaProductType
    ),
  };
}

function buildInstagramThreadTitle(req: RequestItem): string {
  const caption = req.instagramMeta?.mediaCaption?.trim();
  if (caption) {
    return compactPreviewText(caption, 52);
  }

  const { author, mediaTypeLabel } = instagramMediaFacts(req);
  if (author) {
    return `${mediaTypeLabel} by @${author}`;
  }

  if (mediaTypeLabel !== "Post") {
    return `Instagram ${mediaTypeLabel.toLowerCase()}`;
  }

  return "Instagram post";
}

function buildInstagramThreadMeta(req: RequestItem): string {
  if (!req.isInstagramCommentThread) return "";

  const { author, mediaTypeLabel } = instagramMediaFacts(req);
  const parts: string[] = [req.instagramMeta?.isReply ? "Reply" : "Comment"];
  if (mediaTypeLabel !== "Post") {
    parts.push(mediaTypeLabel);
  }
  if (author) {
    parts.push(`@${author}`);
  }

  if (typeof req.instagramMeta?.likeCount === "number") {
    const likeCount = req.instagramMeta.likeCount;
    parts.push(`${likeCount} like${likeCount === 1 ? "" : "s"}`);
  }

  if (req.instagramMeta?.isHidden) {
    parts.push("Hidden");
  }

  return parts.join(" | ");
}

function getStructuredPreviewClasses(
  tone: Exclude<ConversationListPreview, { kind: "plain" }>["tone"]
) {
  switch (tone) {
    case "success":
      return {
        container:
          "border-emerald-200/80 bg-emerald-50/80 text-emerald-950 dark:border-emerald-900/50 dark:bg-emerald-950/20 dark:text-emerald-50",
        iconWrapper:
          "bg-white text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-300",
        title: "text-emerald-950 dark:text-emerald-50",
        details: "text-emerald-700/80 dark:text-emerald-200/75",
      };
    case "accent":
      return {
        container:
          "border-amber-200/80 bg-amber-50/85 text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-50",
        iconWrapper:
          "bg-white text-amber-600 dark:bg-amber-900/40 dark:text-amber-300",
        title: "text-amber-950 dark:text-amber-50",
        details: "text-amber-700/80 dark:text-amber-200/75",
      };
    case "telegram":
      return {
        container:
          "border-sky-200/80 bg-sky-50/85 text-sky-950 dark:border-sky-900/50 dark:bg-sky-950/20 dark:text-sky-50",
        iconWrapper:
          "bg-white text-sky-600 dark:bg-sky-900/40 dark:text-sky-300",
        title: "text-sky-950 dark:text-sky-50",
        details: "text-sky-700/80 dark:text-sky-200/75",
      };
    default:
      return {
        container:
          "border-border/70 bg-muted/40 text-foreground dark:border-border/60 dark:bg-muted/20",
        iconWrapper:
          "bg-background text-muted-foreground dark:bg-background/60 dark:text-muted-foreground",
        title: "text-foreground",
        details: "text-muted-foreground",
      };
  }
}

function StructuredPreviewIcon({
  icon,
  className,
}: {
  icon: Exclude<ConversationListPreview, { kind: "plain" }>["icon"];
  className?: string;
}) {
  switch (icon) {
    case "flow":
      return <FileText className={className} />;
    case "template":
      return <MessageSquareReply className={className} />;
    case "link":
      return <Link2 className={className} />;
    case "selection":
      return <ListChecks className={className} />;
    case "contact":
      return <Phone className={className} />;
    case "deleted":
      return <Trash2 className={className} />;
    case "buttons":
      return <MessageSquareReply className={className} />;
    case "carousel":
      return <Images className={className} />;
    case "location":
      return <MapPin className={className} />;
    case "call":
      return <PhoneCall className={className} />;
    case "catalog":
      return <ShoppingBag className={className} />;
    case "media":
    default:
      return <Paperclip className={className} />;
  }
}

// Rows render in place (no enter animation) and slide out when removed.
const listItemVariants = {
  visible: { opacity: 1, y: 0 },
  exit: { opacity: 0, x: -20 },
};

const emptyStateVariants = {
  hidden: { opacity: 0, scale: 0.95 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: {
      staggerChildren: 0.1,
    },
  },
};

const emptyStateItemVariants = {
  hidden: { opacity: 0, y: 10 },
  visible: {
    opacity: 1,
    y: 0,
  },
};

function DialogListEmptyState({
  workspaceId,
  hasConfiguredSources,
}: {
  workspaceId: string;
  hasConfiguredSources: boolean | Promise<boolean>;
}) {
  const t = useTranslations("DialogListPanel");
  // Only the empty state needs source readiness; populated rows never suspend.
  const sourcesConfigured =
    typeof hasConfiguredSources === "boolean"
      ? hasConfiguredSources
      : use(hasConfiguredSources);

  if (!sourcesConfigured) {
    return (
      <motion.div
        className="p-3"
        variants={emptyStateVariants}
        initial="hidden"
        animate="visible"
      >
        <SourceRequiredState
          icon="sources"
          title={t("connectSourceEmptyTitle")}
          description={t("connectSourceEmptyDescription")}
          primaryHref={`/panel/w/${workspaceId}/airi?source=onboarding`}
          primaryLabel={t("connectSourceEmptyAction")}
          secondaryHref={`/panel/w/${workspaceId}/settings/integrations`}
          secondaryLabel={t("connectSourceEmptySecondaryAction")}
          className="min-h-[300px] border-dashed"
        />
      </motion.div>
    );
  }

  return (
    <motion.div
      className="p-8 text-center text-muted-foreground text-sm"
      variants={emptyStateVariants}
      initial="hidden"
      animate="visible"
    >
      <motion.div variants={emptyStateItemVariants} className="mb-4">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-muted mb-4">
          <Search className="w-6 h-6 text-muted-foreground/50" />
        </div>
      </motion.div>
      <motion.p
        variants={emptyStateItemVariants}
        className="text-base font-medium"
      >
        {t("noConversationsFound")}
      </motion.p>
    </motion.div>
  );
}

interface DialogListItemProps {
  req: RequestItem;
  isActive: boolean;
  isEditingName: boolean;
  isMobile: boolean;
  locale: string;
  recommendationLabel: string;
  renameDraft: string;
  isSavingRename: boolean;
  nowMs: number;
  timeZone: string;
  renameEditorRef: React.RefObject<HTMLDivElement | null>;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  onItemClick: (req: RequestItem) => void;
  onItemPressStart: (id: string) => void;
  onStartRenaming: (req: RequestItem) => void;
  onSaveRenaming: (id: string) => void;
  onCancelRenaming: () => void;
  onRenameDraftChange: (value: string) => void;
  t: ReturnType<typeof useTranslations>;
}

const DialogListItem = React.memo(function DialogListItem({
  req,
  isActive,
  isEditingName,
  isMobile,
  locale,
  recommendationLabel,
  renameDraft,
  isSavingRename,
  nowMs,
  timeZone,
  renameEditorRef,
  renameInputRef,
  onItemClick,
  onItemPressStart,
  onStartRenaming,
  onSaveRenaming,
  onCancelRenaming,
  onRenameDraftChange,
  t,
}: DialogListItemProps) {
  const [showExtraBadges, setShowExtraBadges] = useState(false);
  const badgeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recommendationText = req.action ?? undefined;
  const isTelegramGroupLike =
    req.channel === "telegram" &&
    ["group", "supergroup", "channel"].includes(req.chatType || "");
  const fallbackClientName =
    req.client.trim() ||
    (isTelegramGroupLike ? t("unnamedGroup") : t("unnamedCustomer"));
  const instagramThreadMeta = buildInstagramThreadMeta(req);
  const clientName =
    req.rename?.trim() ||
    (req.isInstagramCommentThread
      ? buildInstagramThreadTitle(req)
      : fallbackClientName);
  const requestSummary = req.request ?? "";
  const latestMessageEditKind = req.lastMessages?.[0]?.editMeta?.kind;
  const latestMessageWasEdited = latestMessageEditKind === "edit";
  const topicLabel = formatTelegramTopicLabel(req.lastMessageThreadId);
  const messagePreview = buildConversationListPreview({
    messages: req.lastMessages,
    fallbackText: req.lastMessageText,
    lastMessageAuthor: req.lastMessageAuthor,
    isTelegramGroupLike,
  });
  const structuredPreviewClasses =
    messagePreview.kind === "structured"
      ? getStructuredPreviewClasses(messagePreview.tone)
      : null;
  const airiLastReplied = req.airiLastReplied === true;
  const formattedDate = formatDateOrTime(
    req.dateValue,
    locale,
    nowMs,
    timeZone,
    t("yesterday")
  );

  // The source badge is always shown; the rest expand on hover or tap.
  const secondaryBadges: React.ReactNode[] = [];
  if (req.category) {
    secondaryBadges.push(
      <ChipBadge key="category" color={MUTED_CHIP_COLOR} textCase="none">
        {req.category}
      </ChipBadge>
    );
  }
  if (isTelegramGroupLike) {
    secondaryBadges.push(
      <ChipBadge key="telegram-chat-type" color={MUTED_CHIP_COLOR}>
        {req.chatType}
      </ChipBadge>
    );
  }
  if (topicLabel) {
    secondaryBadges.push(
      <ChipBadge key="telegram-topic" color={MUTED_CHIP_COLOR} textCase="none">
        {topicLabel}
      </ChipBadge>
    );
  }
  secondaryBadges.push(
    req.channel === "whatsapp" ? (
      <WhatsAppStatus
        key="status"
        lastInboundMessageAt={req.lastInboundMessageAt}
        nowMs={nowMs}
        t={t}
      />
    ) : req.channel === "telegram" ? (
      <TelegramStatus key="status" req={req} t={t} />
    ) : (
      <StatusChip key="status" status={req.status} t={t} />
    )
  );

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (badgeTimeoutRef.current) clearTimeout(badgeTimeoutRef.current);
    };
  }, []);

  const handleBadgeToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isMobile) {
      setShowExtraBadges(prev => !prev);
    }
  };

  return (
    <motion.div
      key={req.id}
      layout={!isMobile}
      variants={listItemVariants}
      initial={false}
      animate="visible"
      exit="exit"
      transition={
        isMobile
          ? {
              opacity: { duration: 0.2, ease: "easeOut" },
              y: { duration: 0.2, ease: "easeOut" },
            }
          : {
              layout: { duration: 0.2, ease: "easeInOut" },
              opacity: { duration: 0.2, ease: "easeOut" },
              y: { duration: 0.2, ease: "easeOut" },
            }
      }
      whileTap={{
        scale: 0.99,
        transition: { duration: 0.1 },
      }}
      role="button"
      data-request-row-observer-key={req.id}
      tabIndex={0}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onItemPressStart(req.id);
          (event.currentTarget as HTMLDivElement).click();
        }
      }}
      onClick={() => onItemClick(req)}
      onPointerDown={() => onItemPressStart(req.id)}
      onPointerEnter={preloadChatModuleOnIntent}
      onFocus={preloadChatModuleOnIntent}
      className={cn(
        "relative box-border flex min-h-14 w-full min-w-0 max-w-full flex-col justify-center gap-px overflow-hidden border-b border-border/40 px-2 py-2 text-left md:gap-1.5 md:p-3",
        "transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        req.isInstagramCommentThread
          ? isActive
            ? "border-l-[3px] border-l-pink-300 bg-[linear-gradient(90deg,rgba(244,114,182,0.10),rgba(255,255,255,0))]"
            : "border-l-[3px] border-l-pink-200 hover:bg-[linear-gradient(90deg,rgba(244,114,182,0.08),rgba(255,255,255,0))]"
          : isActive
            ? "bg-muted"
            : "hover:bg-muted/50"
      )}
    >
      <div className="flex w-full min-w-0 items-start gap-1.5 overflow-hidden md:gap-2">
        <Avatar
          className={cn(
            "border shrink-0",
            req.isInstagramCommentThread
              ? "h-9 w-9 rounded-xl border-pink-200 bg-pink-50 ring-1 ring-pink-100 md:h-10 md:w-10"
              : "h-8 w-8"
          )}
        >
          <AvatarImage
            src={
              req.isInstagramCommentThread
                ? req.instagramMeta?.mediaPreviewUrl
                : req.avatarUrl
            }
          />
          <AvatarFallback
            className={cn(
              "text-[10px]",
              req.isInstagramCommentThread
                ? "rounded-xl bg-pink-50 text-pink-700"
                : ""
            )}
          >
            {req.isInstagramCommentThread ? "IG" : getNameInitials(clientName)}
          </AvatarFallback>
        </Avatar>
        <div className="flex w-0 min-w-0 flex-1 flex-col gap-px overflow-hidden md:gap-1">
          <div className="flex w-full min-w-0 items-center gap-1.5 overflow-hidden">
            <div className="flex w-0 min-w-0 flex-1 items-center gap-1 overflow-hidden md:gap-1.5">
              {isEditingName ? (
                <div
                  ref={renameEditorRef}
                  className="flex w-0 min-w-0 flex-1 items-center gap-1"
                  onClick={event => event.stopPropagation()}
                  onPointerDown={event => event.stopPropagation()}
                >
                  <Input
                    ref={renameInputRef}
                    value={renameDraft}
                    onChange={event => onRenameDraftChange(event.target.value)}
                    onKeyDown={event => {
                      event.stopPropagation();
                      if (event.key === "Enter") {
                        event.preventDefault();
                        onSaveRenaming(req.id);
                        return;
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        onCancelRenaming();
                      }
                    }}
                    className="h-6 text-xs font-semibold px-1.5 py-0"
                    maxLength={120}
                    disabled={isSavingRename}
                    aria-label={t("renameConversation")}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 shrink-0"
                    onClick={event => {
                      event.stopPropagation();
                      onSaveRenaming(req.id);
                    }}
                    onPointerDown={event => event.stopPropagation()}
                    disabled={isSavingRename}
                    aria-label={t("saveRename")}
                  >
                    {isSavingRename ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Save className="h-3 w-3" />
                    )}
                  </Button>
                </div>
              ) : (
                <div className="flex w-0 min-w-0 flex-1 items-center gap-1 overflow-hidden md:gap-1.5">
                  <span className="block min-w-0 flex-1 truncate text-sm font-semibold leading-5">
                    {clientName}
                  </span>
                  <span className="shrink-0 whitespace-nowrap text-[10px] leading-none text-muted-foreground md:hidden">
                    {formattedDate}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="hidden h-5 w-5 shrink-0 md:flex"
                    onClick={event => {
                      event.stopPropagation();
                      onStartRenaming(req);
                    }}
                    onPointerDown={event => event.stopPropagation()}
                    aria-label={t("renameConversation")}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                </div>
              )}
              {req.isReadByManager !== true ? (
                <span
                  className="block h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500 md:h-2 md:w-2"
                  aria-label={t("unreadConversation")}
                  title={t("unreadConversation")}
                />
              ) : (
                <Check
                  className="hidden h-3 w-3 shrink-0 text-emerald-600 md:block"
                  aria-label={t("readConversation")}
                />
              )}
            </div>
            <span className="hidden shrink-0 whitespace-nowrap pt-0.5 text-right text-[9px] text-muted-foreground md:block md:text-[10px]">
              {formattedDate}
            </span>
          </div>

          <div className="flex min-w-0 max-w-full flex-col gap-px overflow-hidden md:gap-1">
            {requestSummary && (
              <span
                className="min-w-0 overflow-hidden break-words text-xs font-semibold text-foreground line-clamp-1"
                title={requestSummary}
              >
                {requestSummary}
              </span>
            )}

            {req.isInstagramCommentThread && (
              <div className="inline-flex w-fit min-w-0 max-w-full items-center overflow-hidden rounded-lg border border-pink-200/80 bg-[linear-gradient(135deg,rgba(244,114,182,0.10),rgba(251,113,133,0.03))] px-2 py-1">
                <span
                  className="min-w-0 truncate text-[10px] font-medium text-pink-700"
                  title={instagramThreadMeta || "Instagram comment thread"}
                >
                  {instagramThreadMeta || "Instagram comment thread"}
                </span>
              </div>
            )}

            {messagePreview.kind === "structured" ? (
              <div
                className={cn(
                  "flex w-full min-w-0 max-w-full items-center gap-1.5 overflow-hidden text-muted-foreground md:gap-2 md:rounded-xl md:border md:px-2.5 md:py-2 md:shadow-[0_1px_0_rgba(0,0,0,0.02)]",
                  !isMobile && structuredPreviewClasses?.container
                )}
              >
                <span
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center md:h-7 md:w-7 md:rounded-full",
                    !isMobile && structuredPreviewClasses?.iconWrapper
                  )}
                  aria-hidden="true"
                >
                  <StructuredPreviewIcon
                    icon={messagePreview.icon}
                    className="h-3.5 w-3.5"
                  />
                </span>
                <span className="min-w-0 flex-1 overflow-hidden">
                  <span
                    className={cn(
                      "block truncate text-xs leading-4 md:text-[11px] md:font-semibold",
                      !isMobile && structuredPreviewClasses?.title
                    )}
                    title={messagePreview.title}
                  >
                    {messagePreview.title}
                  </span>
                  {messagePreview.details ? (
                    <span
                      className={cn(
                        "block truncate text-xs leading-4 md:mt-0.5 md:text-[10px]",
                        !isMobile && structuredPreviewClasses?.details
                      )}
                      title={messagePreview.details}
                    >
                      {messagePreview.details}
                    </span>
                  ) : null}
                </span>
              </div>
            ) : (
              <span
                className={cn(
                  "min-w-0 text-xs text-muted-foreground line-clamp-1 leading-4 break-words [overflow-wrap:anywhere] md:line-clamp-2",
                  !messagePreview.text && "italic"
                )}
              >
                {messagePreview.text ||
                  (!requestSummary ? t("noMessages") : null)}
              </span>
            )}

            {!isMobile && latestMessageWasEdited ? (
              <Badge
                variant="outline"
                className="hidden w-fit border-amber-200 bg-amber-50 px-1.5 py-0 text-[10px] font-medium text-amber-700 md:inline-flex"
              >
                {t("editedMessageBadge")}
              </Badge>
            ) : null}

            {!isMobile && (
              <div
                className="relative hidden min-h-4 min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden md:flex"
                onPointerEnter={() => {
                  if (badgeTimeoutRef.current)
                    clearTimeout(badgeTimeoutRef.current);
                  setShowExtraBadges(true);
                }}
                onPointerLeave={() => {
                  badgeTimeoutRef.current = setTimeout(
                    () => setShowExtraBadges(false),
                    200
                  );
                }}
              >
                {/* Recommendation badge: always first when present */}
                {recommendationText && (
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="inline-flex h-4 shrink-0 items-center justify-center gap-1 rounded-md border border-amber-200/70 bg-amber-50/60 px-1.5 py-0 text-[9px] font-medium uppercase tracking-wide text-amber-700 transition-colors hover:bg-amber-100/80"
                          onClick={e => {
                            e.stopPropagation();
                          }}
                          onPointerDown={e => e.stopPropagation()}
                          aria-label={t("recommendation", {
                            action: recommendationText,
                          })}
                        >
                          <Lightbulb className="h-3 w-3 shrink-0" />
                          <span>{recommendationLabel}</span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent
                        side="top"
                        sideOffset={6}
                        className="max-w-72 text-[11px] leading-snug break-words"
                      >
                        {recommendationText}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}

                {airiLastReplied && (
                  <Badge
                    variant="outline"
                    className="h-4 shrink-0 rounded-md border-transparent bg-[linear-gradient(90deg,#06b6d4_0%,#3b82f6_52%,#8b5cf6_100%)] px-1.5 py-0 text-[9px] font-semibold text-white shadow-[0_1px_4px_rgba(59,130,246,0.24)]"
                  >
                    {t("airiRepliedBadge")}
                  </Badge>
                )}

                {/* Primary badge: always visible */}
                <button
                  type="button"
                  onClick={handleBadgeToggle}
                  className="inline-flex shrink-0 cursor-pointer items-center"
                  aria-label={
                    secondaryBadges.length > 0
                      ? t("showMoreBadges", { count: secondaryBadges.length })
                      : undefined
                  }
                >
                  <SourceChip channel={req.channel} />
                </button>

                {/* Secondary badges: CSS transition instead of framer-motion to avoid layout shifts */}
                {secondaryBadges.map((badge, i) => (
                  <div
                    key={`secondary-${i}`}
                    className="flex min-w-0 max-w-full shrink-0 items-center transition-all duration-150 ease-out [&>[data-slot=badge]]:max-w-full [&>[data-slot=badge]]:truncate"
                    style={{
                      opacity: showExtraBadges ? 1 : 0,
                      transform: showExtraBadges
                        ? "translateX(0)"
                        : "translateX(8px)",
                      width: showExtraBadges ? "auto" : 0,
                      overflow: "hidden",
                      transitionDelay: showExtraBadges ? `${i * 30}ms` : "0ms",
                    }}
                  >
                    {badge}
                  </div>
                ))}

                {/* Badge count indicator when collapsed */}
                {!showExtraBadges && secondaryBadges.length > 0 && (
                  <button
                    type="button"
                    className="h-4 shrink-0 rounded-full bg-muted px-1.5 text-[9px] font-medium text-muted-foreground"
                    onClick={handleBadgeToggle}
                  >
                    +{secondaryBadges.length}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
});

export function DialogListPanel({
  workspaceId,
  requests,
  initialAvailableChannels,
  initialAvailableCategories = EMPTY_AVAILABLE_CATEGORIES,
  initialHasMore,
  initialPlanGate = null,
  shouldHydrateFromApiOnMount = false,
  initialRenderNowMs,
  activeConversationId,
  onSelectConversation,
  isMobile = false,
  hasConfiguredSources = true,
}: DialogListPanelProps) {
  const locale = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { mutate: mutateSWRCache } = useSWRConfig();
  const t = useTranslations("DialogListPanel");
  const requestsPath = `/panel/w/${workspaceId}/requests`;
  const listQuery = useMemo(
    () => parseRequestsListQuery(searchParams),
    [searchParams]
  );
  const hasUrlListQuery = hasRequestsListQuery(listQuery);
  const recommendationLabel = useMemo(() => {
    const base = t("recommendation", { action: "" });
    return base.replace(/\s*:\s*$/, "").trim();
  }, [t]);
  const { realtimeRows, updatedRowIds, patchRow, patchRows } =
    useRequestsRealtime();
  const [searchQuery, setSearchQuery] = useState("");
  const [storedSearchType, setSearchType] = useAtom(
    requestsDialogSearchTypeAtom
  );
  // A mode persisted by an older build (the retired churn-risk view) falls
  // back to the default instead of leaving the search box in no mode.
  const searchMode =
    REQUEST_SEARCH_MODE_OPTIONS.find(
      option => option.value === storedSearchType
    ) ?? REQUEST_SEARCH_MODE_OPTIONS[0];
  const searchType: RequestsDialogSearchType = searchMode.value;
  const [selectedSourceType, setSelectedSourceType] = useAtom(
    requestsDialogSelectedSourceTypeAtom
  );
  const [selectedInternalLabel, setSelectedInternalLabel] = useAtom(
    requestsDialogSelectedInternalLabelAtom
  );
  const [selectedCategory, setSelectedCategory] = useAtom(
    requestsDialogSelectedCategoryAtom
  );
  const [allRequests, setAllRequests] = useState<RequestItem[]>(requests);
  const availableChannels = useMemo(
    () => normalizeSelectStringOptions(initialAvailableChannels),
    [initialAvailableChannels]
  );
  const availableCategories = useMemo(
    () => normalizeSelectStringOptions(initialAvailableCategories),
    [initialAvailableCategories]
  );
  const { data: internalLabelsData } = useSWR<{
    labels: InternalLabelOption[];
  }>(
    workspaceId
      ? `/api/internal-labels?workspaceId=${workspaceId}&activeOnly=true`
      : null,
    internalLabelsFetcher,
    { revalidateOnFocus: false }
  );
  const availableLabels = useMemo(
    () => normalizeInternalLabelOptions(internalLabelsData?.labels ?? []),
    [internalLabelsData?.labels]
  );
  const sourceFilterValues: readonly string[] =
    availableChannels.length > 0 ? availableChannels : CONVERSATION_CHANNELS;
  const visibleSourceFilterValues = useMemo(
    () => getVisibleFilterValues(sourceFilterValues, selectedSourceType),
    [selectedSourceType, sourceFilterValues]
  );
  const labelFilterValues = useMemo(
    () => availableLabels.map(label => label.name),
    [availableLabels]
  );
  const visibleLabelFilterValues = useMemo(
    () => getVisibleFilterValues(labelFilterValues, selectedInternalLabel),
    [labelFilterValues, selectedInternalLabel]
  );
  const visibleCategoryFilterValues = useMemo(
    () => getVisibleFilterValues(availableCategories, selectedCategory),
    [availableCategories, selectedCategory]
  );
  const hasMoreSourceFilters =
    sourceFilterValues.length > visibleSourceFilterValues.length;
  const hasMoreLabelFilters =
    labelFilterValues.length > visibleLabelFilterValues.length;
  const hasMoreCategoryFilters =
    availableCategories.length > visibleCategoryFilterValues.length;
  const searchInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameEditorRef = useRef<HTMLDivElement>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);
  const [showAiriRepliedOnly, setShowAiriRepliedOnly] = useState(false);
  const [isUnreadFilterPending, setIsUnreadFilterPending] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [recentlyReadInUnreadView, setRecentlyReadInUnreadView] = useState<
    Set<string>
  >(new Set());
  const [locallyReadAtByConversation, setLocallyReadAtByConversation] =
    useState<Map<string, number>>(() => new Map());
  const [isMarkingAllRead, setIsMarkingAllRead] = useState(false);
  const [editingConversationId, setEditingConversationId] = useState<
    string | null
  >(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [isSavingRename, setIsSavingRename] = useState(false);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [mobileSearchAutoFocus, setMobileSearchAutoFocus] = useState(false);
  const mobileFilterOpenerRef = useRef<HTMLButtonElement | null>(null);
  const desktopFilterTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [desktopFiltersOpen, setDesktopFiltersOpen] = useState(false);
  const [planGate, setPlanGate] = useState<RequestsPlanGate | null>(
    initialPlanGate
  );
  const [upgradeDialogOpen, setUpgradeDialogOpen] = useState(false);
  const [renderNowMs, setRenderNowMs] = useState(initialRenderNowMs);
  const [renderTimeZone, setRenderTimeZone] = useState(SERVER_RENDER_TIME_ZONE);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const loadMoreAbortRef = useRef<AbortController | null>(null);
  const requestsFirstPageCacheRef = useRef(
    new Map<string, RequestsFirstPageCacheEntry>()
  );
  const sentinelRef = useRef<HTMLDivElement>(null);
  const sentinelWasIntersectingRef = useRef(false);
  const isLoadingRef = useRef(false); // Prevent multiple simultaneous loads
  const isLoadingMoreRef = useRef(isLoadingMore); // Track isLoadingMore state in ref for observer
  const isSearchingRef = useRef(isSearching); // Track active search state for observer
  const hasMoreRef = useRef(hasMore); // Track hasMore in ref for observer
  const currentPageRef = useRef(currentPage); // Track currentPage in ref
  const markReadInFlightRef = useLazyRef(() => new Set<string>());
  const unreadRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const unreadRefreshAbortRef = useRef<AbortController | null>(null);
  const lastUnreadRefreshAtRef = useRef(0);
  const hasHydratedInitialDataRef = useRef(false);
  const hadActiveFilterRef = useRef(false);
  const [realtimeRefreshVersion, setRealtimeRefreshVersion] = useState(0);
  const realtimeRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const realtimeRefreshPendingRef = useRef(false);
  const realtimeRefreshDirtyRef = useRef(false);
  const realtimeRefreshRetryDelayRef = useRef(3000);
  // Setters and refs only, so both helpers are stable across renders.
  const applyFirstPage = useCallback(
    (
      nextRequests: RequestItem[],
      hasNextPage: boolean,
      nextPlanGate: RequestsPlanGate | null
    ) => {
      setAllRequests(nextRequests);
      setHasMore(hasNextPage);
      hasMoreRef.current = hasNextPage;
      setPlanGate(nextPlanGate);
    },
    []
  );
  const releaseSearchController = useCallback((controller: AbortController) => {
    if (searchAbortRef.current === controller) {
      searchAbortRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!isMobile || activeConversationId) {
      setMobileFiltersOpen(false);
      setMobileSearchAutoFocus(false);
    }
    if (!isMobile) {
      // React may reuse the mobile trigger DOM node for a different desktop
      // control, so connectivity alone does not make it a valid return target.
      mobileFilterOpenerRef.current = null;
    }
  }, [activeConversationId, isMobile]);

  // Update refs when state changes
  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);

  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  useEffect(() => {
    isLoadingMoreRef.current = isLoadingMore;
  }, [isLoadingMore]);

  useEffect(() => {
    isSearchingRef.current = isSearching;
  }, [isSearching]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setRenderTimeZone(
        Intl.DateTimeFormat().resolvedOptions().timeZone ||
          SERVER_RENDER_TIME_ZONE
      );
      setRenderNowMs(Date.now());
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    if (!editingConversationId) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [editingConversationId]);

  useEffect(() => {
    if (!editingConversationId) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }

      if (renameEditorRef.current?.contains(target)) {
        return;
      }

      setEditingConversationId(null);
      setRenameDraft("");
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [editingConversationId]);

  const normalizedSearchQuery = searchQuery.trim();
  const hasSearchQuery = normalizedSearchQuery.length > 0;
  const hasSourceFilter = Boolean(
    selectedSourceType && selectedSourceType !== "all"
  );
  const hasLabelFilter = Boolean(
    selectedInternalLabel && selectedInternalLabel !== "all"
  );
  const hasCategoryFilter = Boolean(
    selectedCategory && selectedCategory !== "all"
  );
  const hasServerBackedFilter =
    hasSearchQuery ||
    hasSourceFilter ||
    hasLabelFilter ||
    hasCategoryFilter ||
    showAiriRepliedOnly ||
    hasUrlListQuery;
  const hasActiveFilter = hasServerBackedFilter || showUnreadOnly;

  const markFilterRefreshPending = useCallback(() => {
    setIsSearching(true);
    isSearchingRef.current = true;
    setIsLoadingMore(false);
    isLoadingMoreRef.current = false;
    isLoadingRef.current = false;
    setCurrentPage(1);
    currentPageRef.current = 1;
  }, []);

  const clearUrlListQuery = useCallback(() => {
    if (!hasUrlListQuery) return;

    const params = new URLSearchParams(searchParams.toString());
    clearRequestsListQueryParams(params);
    const qs = params.toString();
    markFilterRefreshPending();
    router.replace(qs ? `${requestsPath}?${qs}` : requestsPath, {
      scroll: false,
    });
  }, [
    hasUrlListQuery,
    markFilterRefreshPending,
    requestsPath,
    router,
    searchParams,
  ]);

  const setUnreadFilterEnabled = useCallback(
    (nextValue: React.SetStateAction<boolean>) => {
      setIsUnreadFilterPending(true);
      markFilterRefreshPending();
      setShowUnreadOnly(nextValue);
    },
    [markFilterRefreshPending]
  );

  const buildRequestsParams = useCallback(
    (page: number) => {
      const params = new URLSearchParams({
        workspaceId,
        page: String(page),
        limit: String(REQUESTS_PAGE_LIMIT),
        includeChannels: "false",
      });

      if (hasSearchQuery) {
        params.set("searchType", searchType);
        params.set("searchQuery", normalizedSearchQuery);
      }

      if (listQuery.filter) {
        params.set("filter", listQuery.filter);
      }

      if (listQuery.status) {
        params.set("status", listQuery.status);
      }

      if (showAiriRepliedOnly) {
        params.set("airiReplied", "true");
      }

      if (hasSourceFilter) {
        params.set("channel", selectedSourceType);
      }

      if (hasLabelFilter) {
        params.set("internalLabel", selectedInternalLabel);
      }

      if (hasCategoryFilter) {
        params.set("category", selectedCategory);
      }

      if (showUnreadOnly) {
        params.set("unread", "true");
      }

      return params.toString();
    },
    [
      hasCategoryFilter,
      showAiriRepliedOnly,
      hasLabelFilter,
      hasSearchQuery,
      hasSourceFilter,
      showUnreadOnly,
      listQuery.filter,
      listQuery.status,
      normalizedSearchQuery,
      searchType,
      selectedCategory,
      selectedInternalLabel,
      selectedSourceType,
      workspaceId,
    ]
  );

  const refreshSignature = useMemo(
    () =>
      hasActiveFilter
        ? `active:${buildRequestsParams(1)}`
        : "inactive:unfiltered",
    [buildRequestsParams, hasActiveFilter]
  );
  const [refreshStateSignature, setRefreshStateSignature] =
    useState(refreshSignature);

  if (refreshStateSignature !== refreshSignature) {
    setRefreshStateSignature(refreshSignature);
    setIsSearching(true);
    setIsLoadingMore(false);
    setCurrentPage(1);
  }

  const refreshUnreadCount = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const params = new URLSearchParams({
          workspaceId,
          unread: "true",
          countOnly: "true",
          page: "1",
          limit: "1",
          includeChannels: "false",
        });

        const response = await fetch(`/api/requests?${params.toString()}`, {
          cache: "no-store",
          headers: {
            "Cache-Control": "no-cache",
          },
          signal,
        });
        if (!response.ok) {
          return;
        }

        const data = await response.json();
        const totalCount = Number(data.pagination?.totalCount);
        if (Number.isFinite(totalCount)) {
          setUnreadCount(Math.max(0, totalCount));
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
        console.error("Error fetching unread count:", error);
      }
    },
    [workspaceId]
  );

  const scheduleUnreadCountRefresh = useCallback(
    (options?: { force?: boolean }) => {
      const force = options?.force === true;

      if (unreadRefreshTimeoutRef.current) {
        clearTimeout(unreadRefreshTimeoutRef.current);
      }

      const now = Date.now();
      const elapsed = now - lastUnreadRefreshAtRef.current;
      const throttleDelay = force
        ? 0
        : Math.max(0, UNREAD_REFRESH_MIN_INTERVAL_MS - elapsed);
      const delay = force
        ? 0
        : Math.max(UNREAD_REFRESH_DEBOUNCE_MS, throttleDelay);

      unreadRefreshTimeoutRef.current = setTimeout(() => {
        unreadRefreshTimeoutRef.current = null;

        if (unreadRefreshAbortRef.current) {
          unreadRefreshAbortRef.current.abort();
        }

        const controller = new AbortController();
        unreadRefreshAbortRef.current = controller;
        lastUnreadRefreshAtRef.current = Date.now();

        void refreshUnreadCount(controller.signal).finally(() => {
          if (unreadRefreshAbortRef.current === controller) {
            unreadRefreshAbortRef.current = null;
          }
        });
      }, delay);
    },
    [refreshUnreadCount]
  );

  const fetchRequestsPage = useCallback(
    async (page: number, signal?: AbortSignal) => {
      const requestParams = buildRequestsParams(page);
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      const deadline = setTimeout(cancel, REQUESTS_PAGE_TIMEOUT_MS);
      try {
        const response = await fetch(`/api/requests?${requestParams}`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `Failed to fetch requests: ${response.status} ${errorText}`
          );
        }

        const data = (await response.json()) as {
          data?: RawConversation[];
          pagination?: { hasNextPage?: boolean; totalCount?: number };
          planGate?: RequestsPlanGate;
        };
        const newRequests = Array.isArray(data.data)
          ? data.data.map(item => formatConversationToRequest(item))
          : [];
        const totalCount = Number(data.pagination?.totalCount);

        const result: RequestsFirstPageResult = {
          requests: newRequests,
          hasNextPage: Boolean(data.pagination?.hasNextPage),
          planGate: data.planGate ?? null,
          totalCount: Number.isFinite(totalCount)
            ? Math.max(0, totalCount)
            : newRequests.length,
        };

        if (page === 1 && !signal?.aborted) {
          writeRequestsCacheEntry(
            requestsFirstPageCacheRef.current,
            requestParams,
            result
          );
        }

        return result;
      } catch (error) {
        // A request deadline is retryable; scope cancellation must keep its
        // AbortError so the old workspace/filter cannot schedule another read.
        if (controller.signal.aborted && !signal?.aborted)
          throw new Error("Requests page timed out");
        throw error;
      } finally {
        clearTimeout(deadline);
        signal?.removeEventListener("abort", cancel);
      }
    },
    [buildRequestsParams]
  );

  const applyCachedRequestsFirstPage = useCallback(
    (cacheKey: string) => {
      const cached = readFreshRequestsCacheEntry(
        requestsFirstPageCacheRef.current,
        cacheKey
      );
      if (!cached) {
        return false;
      }

      setAllRequests(cached.requests);
      setHasMore(cached.hasNextPage);
      hasMoreRef.current = cached.hasNextPage;
      setPlanGate(cached.planGate);
      if (showUnreadOnly) {
        setUnreadCount(cached.totalCount);
      }
      return true;
    },
    [showUnreadOnly]
  );

  useEffect(() => {
    if (hasActiveFilter) {
      return;
    }

    writeRequestsCacheEntry(
      requestsFirstPageCacheRef.current,
      buildRequestsParams(1),
      {
        requests,
        hasNextPage: initialHasMore,
        planGate: initialPlanGate,
        totalCount: requests.length,
      }
    );
  }, [
    buildRequestsParams,
    hasActiveFilter,
    initialHasMore,
    initialPlanGate,
    requests,
  ]);

  const getScrollViewport = useCallback(() => {
    return scrollContainerRef.current
      ?.closest('[data-slot="scroll-area"]')
      ?.querySelector(
        '[data-slot="scroll-area-viewport"]'
      ) as HTMLElement | null;
  }, []);

  const preloadConversationSelection = useCallback(
    (conversationId: string) => {
      void preloadConversationDetail(
        mutateSWRCache,
        conversationId,
        workspaceId
      ).catch(() => undefined);
      preloadChatModuleOnIntent();
    },
    [mutateSWRCache, workspaceId]
  );

  const cancelRenaming = useCallback(() => {
    setEditingConversationId(null);
    setRenameDraft("");
  }, []);

  const startRenaming = useCallback((requestItem: RequestItem) => {
    const renameValue =
      typeof requestItem.rename === "string" ? requestItem.rename.trim() : "";
    const fallbackName = requestItem.isInstagramCommentThread
      ? buildInstagramThreadTitle(requestItem)
      : typeof requestItem.client === "string"
        ? requestItem.client.trim()
        : "";
    setEditingConversationId(requestItem.id);
    setRenameDraft(renameValue || fallbackName);
  }, []);

  const saveRenaming = useCallback(
    async (conversationId: string) => {
      if (isSavingRename) {
        return;
      }

      setIsSavingRename(true);
      const trimmedRename = renameDraft.trim();
      const renameToSave = trimmedRename.length > 0 ? trimmedRename : null;

      try {
        const response = await fetch(`/api/conversations/${conversationId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ rename: renameToSave }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `Failed to rename conversation: ${response.status} ${errorText}`
          );
        }

        const data = (await response.json()) as { rename?: string | null };
        const savedRename =
          typeof data?.rename === "string" || data?.rename === null
            ? data.rename
            : renameToSave;

        setAllRequests(prev =>
          prev.map(row =>
            row.id === conversationId ? { ...row, rename: savedRename } : row
          )
        );
        patchRow(conversationId, { rename: savedRename });
        cancelRenaming();
      } catch (error) {
        console.error("Error renaming conversation:", error);
      } finally {
        setIsSavingRename(false);
      }
    },
    [cancelRenaming, isSavingRename, patchRow, renameDraft]
  );

  const markConversationAsReadLocally = useCallback(
    (conversationId: string) => {
      const localRow = allRequests.find(row => row.id === conversationId);
      const realtimeRow = realtimeRows.find(row => row.id === conversationId);
      const shouldUpdateLocal = Boolean(
        localRow && localRow.isReadByManager !== true
      );
      const shouldUpdateRealtime = Boolean(
        realtimeRow && realtimeRow.isReadByManager !== true
      );

      if (!shouldUpdateLocal && !shouldUpdateRealtime) {
        return;
      }

      const readAt = Date.now();
      setLocallyReadAtByConversation(prev => {
        const next = new Map(prev);
        next.set(conversationId, readAt);
        return next;
      });

      if (shouldUpdateLocal) {
        setAllRequests(prev =>
          prev.map(row =>
            row.id === conversationId ? { ...row, isReadByManager: true } : row
          )
        );
      }

      if (shouldUpdateRealtime) {
        patchRow(conversationId, { isReadByManager: true });
      }

      if (showUnreadOnly) {
        setRecentlyReadInUnreadView(prev => {
          const next = new Set(prev);
          next.add(conversationId);
          return next;
        });
      }

      setUnreadCount(prev => Math.max(0, prev - 1));
    },
    [allRequests, patchRow, realtimeRows, showUnreadOnly]
  );

  const markConversationAsRead = useCallback(
    async (conversationId: string) => {
      markConversationAsReadLocally(conversationId);

      if (markReadInFlightRef.current.has(conversationId)) {
        return;
      }
      markReadInFlightRef.current.add(conversationId);

      try {
        await fetch(`/api/conversations/${conversationId}/read`, {
          method: "PATCH",
        });
      } catch (error) {
        console.error("Error marking conversation as read:", error);
      } finally {
        markReadInFlightRef.current.delete(conversationId);
        void refreshUnreadCount();
      }
    },
    [markConversationAsReadLocally, refreshUnreadCount]
  );

  const markAllAsRead = useCallback(async () => {
    setIsMarkingAllRead(true);

    try {
      const response = await fetch("/api/requests/read-all", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ workspaceId }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Failed to mark all as read: ${response.status} ${errorText}`
        );
      }

      setAllRequests(prev =>
        prev.map(row => ({ ...row, isReadByManager: true }))
      );

      const loadedIds = [
        ...new Set([
          ...allRequests.map(row => row.id),
          ...realtimeRows.map(row => row.id),
        ]),
      ];
      patchRows(loadedIds, { isReadByManager: true });
      setUnreadCount(0);

      if (showUnreadOnly) {
        setAllRequests([]);
        setHasMore(false);
        hasMoreRef.current = false;
      }
    } catch (error) {
      console.error("Error marking all conversations as read:", error);
    } finally {
      setIsMarkingAllRead(false);
    }
  }, [allRequests, patchRows, realtimeRows, showUnreadOnly, workspaceId]);

  const handleItemClick = useCallback(
    (req: RequestItem) => {
      const isMessageSearchActive =
        searchType === "message_within_chat" && searchQuery.trim().length > 0;
      const messageSearchQuery = isMessageSearchActive
        ? searchQuery.trim()
        : null;

      onSelectConversation(req.id, {
        messageSearchQuery,
        requestPreview: req,
      });

      const nextUrl = buildConversationSelectionUrl({
        currentSearchParams: searchParams.toString(),
        conversationId: req.id,
        pathname: requestsPath,
        messageSearchQuery,
      });
      updateUrlWithoutNavigation(nextUrl, isMobile);
    },
    [
      isMobile,
      onSelectConversation,
      requestsPath,
      searchParams,
      searchQuery,
      searchType,
    ]
  );

  const handleItemPressStart = useCallback(
    (id: string) => {
      preloadConversationSelection(id);
    },
    [preloadConversationSelection]
  );

  useEffect(() => {
    scheduleUnreadCountRefresh();

    return () => {
      if (unreadRefreshTimeoutRef.current) {
        clearTimeout(unreadRefreshTimeoutRef.current);
        unreadRefreshTimeoutRef.current = null;
      }

      if (unreadRefreshAbortRef.current) {
        unreadRefreshAbortRef.current.abort();
        unreadRefreshAbortRef.current = null;
      }
    };
  }, [scheduleUnreadCountRefresh]);

  useEffect(() => {
    if (realtimeRows.length === 0) {
      return;
    }

    scheduleUnreadCountRefresh();
  }, [scheduleUnreadCountRefresh, realtimeRows]);

  const effectiveRecentlyReadInUnreadView = useMemo(
    () =>
      showUnreadOnly
        ? recentlyReadInUnreadView
        : EMPTY_RECENTLY_READ_CONVERSATIONS,
    [recentlyReadInUnreadView, showUnreadOnly]
  );

  useEffect(() => {
    if (
      hasActiveFilter ||
      !shouldHydrateFromApiOnMount ||
      hasHydratedInitialDataRef.current
    ) {
      return;
    }

    hasHydratedInitialDataRef.current = true;

    const controller = new AbortController();
    searchAbortRef.current = controller;

    const hydrateInitialRequests = async () => {
      try {
        if (controller.signal.aborted) {
          return;
        }

        const {
          requests: newRequests,
          hasNextPage,
          planGate: nextPlanGate,
        } = await fetchRequestsPage(1, controller.signal);

        if (controller.signal.aborted) {
          return;
        }

        applyFirstPage(newRequests, hasNextPage, nextPlanGate);
        setCurrentPage(1);
        currentPageRef.current = 1;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }

        console.error("Error hydrating initial requests:", error);
        if (!controller.signal.aborted) {
          setAllRequests([]);
          setHasMore(false);
          hasMoreRef.current = false;
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsSearching(false);
        }
        releaseSearchController(controller);
      }
    };

    void hydrateInitialRequests();

    return () => {
      controller.abort();
      releaseSearchController(controller);
    };
  }, [
    applyFirstPage,
    fetchRequestsPage,
    hasActiveFilter,
    releaseSearchController,
    shouldHydrateFromApiOnMount,
  ]);

  const beginRequestsRefresh = useCallback(() => {
    if (loadMoreAbortRef.current) {
      loadMoreAbortRef.current.abort();
      loadMoreAbortRef.current = null;
    }
    isSearchingRef.current = true;
    isLoadingMoreRef.current = false;
    isLoadingRef.current = false;
    currentPageRef.current = 1;
  }, []);

  // Invalidate the filtered window, rather than inserting rows whose server
  // search membership is unknown. Coalesce bursts and wait for current reads.
  const scheduleFilteredRealtimeRefresh = useCallback(
    (delay = 1000) => {
      if (!hasServerBackedFilter || realtimeRefreshTimerRef.current) return;
      const flush = () => {
        realtimeRefreshTimerRef.current = null;
        if (
          document.visibilityState !== "visible" ||
          !realtimeRefreshDirtyRef.current
        )
          return;
        if (isSearchingRef.current || isLoadingMoreRef.current) {
          realtimeRefreshTimerRef.current = setTimeout(flush, 1000);
          return;
        }
        realtimeRefreshDirtyRef.current = false;
        realtimeRefreshPendingRef.current = true;
        setRealtimeRefreshVersion(version => version + 1);
      };
      realtimeRefreshTimerRef.current = setTimeout(flush, delay);
    },
    [hasServerBackedFilter]
  );

  useEffect(() => {
    const resume = () => scheduleFilteredRealtimeRefresh();
    document.addEventListener("visibilitychange", resume);
    return () => {
      document.removeEventListener("visibilitychange", resume);
      if (realtimeRefreshTimerRef.current)
        clearTimeout(realtimeRefreshTimerRef.current);
      realtimeRefreshTimerRef.current = null;
      realtimeRefreshDirtyRef.current = false;
      realtimeRefreshPendingRef.current = false;
      realtimeRefreshRetryDelayRef.current = 3000;
    };
  }, [workspaceId, refreshSignature, scheduleFilteredRealtimeRefresh]);

  useEffect(() => {
    if (realtimeRows.length === 0 || !hasServerBackedFilter) return;
    realtimeRefreshDirtyRef.current = true;
    scheduleFilteredRealtimeRefresh();
  }, [realtimeRows, hasServerBackedFilter, scheduleFilteredRealtimeRefresh]);

  // Fetch from API when filters/search are active.
  useEffect(() => {
    const isRealtimeRefresh = realtimeRefreshPendingRef.current;
    realtimeRefreshPendingRef.current = false;
    if (!hasActiveFilter) {
      // Without a filter to clear there is nothing to reload; in particular
      // the mount-time hydration (shouldHydrateFromApiOnMount) must survive.
      if (!hadActiveFilterRef.current) {
        return;
      }

      hadActiveFilterRef.current = false;
      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;
      const firstPageCacheKey = buildRequestsParams(1);
      beginRequestsRefresh();
      applyCachedRequestsFirstPage(firstPageCacheKey);

      const fetchUnfilteredRequests = async () => {
        try {
          const {
            requests: newRequests,
            hasNextPage,
            planGate: nextPlanGate,
          } = await fetchRequestsPage(1, controller.signal);
          if (controller.signal.aborted) {
            return;
          }

          applyFirstPage(newRequests, hasNextPage, nextPlanGate);
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            return;
          }

          console.error(
            "Error fetching requests after clearing filters:",
            error
          );
          if (!controller.signal.aborted) {
            applyFirstPage(requests, initialHasMore, initialPlanGate);
          }
        } finally {
          if (!controller.signal.aborted) {
            setIsSearching(false);
            setIsUnreadFilterPending(false);
            isSearchingRef.current = false;
          }
          releaseSearchController(controller);
        }
      };

      void fetchUnfilteredRequests();

      return () => {
        controller.abort();
        releaseSearchController(controller);
      };
    }

    hadActiveFilterRef.current = true;
    if (searchAbortRef.current) {
      searchAbortRef.current.abort();
    }
    const controller = new AbortController();
    searchAbortRef.current = controller;
    const firstPageCacheKey = buildRequestsParams(1);
    beginRequestsRefresh();
    applyCachedRequestsFirstPage(firstPageCacheKey);

    const fetchSearchResults = async () => {
      try {
        if (controller.signal.aborted) {
          return;
        }

        const {
          requests: newRequests,
          hasNextPage,
          planGate: nextPlanGate,
          totalCount,
        } = await fetchRequestsPage(1, controller.signal);
        if (controller.signal.aborted) {
          return;
        }

        applyFirstPage(newRequests, hasNextPage, nextPlanGate);
        realtimeRefreshRetryDelayRef.current = 3000;
        if (showUnreadOnly) {
          setUnreadCount(totalCount);
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }

        console.error("Error fetching search results:", error);
        if (!controller.signal.aborted && isRealtimeRefresh) {
          realtimeRefreshDirtyRef.current = true;
          const delay = realtimeRefreshRetryDelayRef.current;
          realtimeRefreshRetryDelayRef.current = Math.min(30_000, delay * 2);
          scheduleFilteredRealtimeRefresh(delay);
        }
        if (!controller.signal.aborted && !isRealtimeRefresh) {
          setAllRequests([]);
          setHasMore(false);
          hasMoreRef.current = false;
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsSearching(false);
          setIsUnreadFilterPending(false);
          isSearchingRef.current = false;
        }
      }
    };

    // Debounce only for text searches, not for filter changes.
    const debounceDelay = hasSearchQuery ? REQUESTS_TEXT_SEARCH_DEBOUNCE_MS : 0;
    const debounceTimer = setTimeout(fetchSearchResults, debounceDelay);

    return () => {
      clearTimeout(debounceTimer);
      controller.abort();
      releaseSearchController(controller);
    };
  }, [
    beginRequestsRefresh,
    applyCachedRequestsFirstPage,
    applyFirstPage,
    buildRequestsParams,
    fetchRequestsPage,
    hasActiveFilter,
    hasSearchQuery,
    showUnreadOnly,
    initialHasMore,
    initialPlanGate,
    releaseSearchController,
    requests,
    realtimeRefreshVersion,
    scheduleFilteredRealtimeRefresh,
  ]);

  const loadMoreRequests = useCallback(async () => {
    // Prevent multiple simultaneous loads or loads during active search fetches.
    if (
      isLoadingRef.current ||
      isLoadingMoreRef.current ||
      isSearchingRef.current ||
      !hasMoreRef.current
    ) {
      return;
    }

    isLoadingRef.current = true;
    setIsLoadingMore(true);
    const scrollViewport = getScrollViewport();
    const previousScrollTop = scrollViewport?.scrollTop ?? null;

    if (loadMoreAbortRef.current) {
      loadMoreAbortRef.current.abort();
    }
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;

    try {
      const nextPage = currentPageRef.current + 1;
      if (controller.signal.aborted) {
        return;
      }

      const {
        requests: newRequests,
        hasNextPage,
        planGate: nextPlanGate,
      } = await fetchRequestsPage(nextPage, controller.signal);
      if (controller.signal.aborted) {
        return;
      }

      if (newRequests.length === 0) {
        setHasMore(false);
        hasMoreRef.current = false;
        return;
      }

      setAllRequests(prev => {
        const existingIds = new Set(prev.map(r => r.id));
        const uniqueNew = newRequests.filter(
          (request: RequestItem) => !existingIds.has(request.id)
        );
        return [...prev, ...uniqueNew];
      });

      if (scrollViewport && previousScrollTop !== null) {
        window.requestAnimationFrame(() => {
          scrollViewport.scrollTop = previousScrollTop;
        });
      }

      setCurrentPage(nextPage);
      currentPageRef.current = nextPage;
      setHasMore(hasNextPage);
      hasMoreRef.current = hasNextPage;
      setPlanGate(nextPlanGate);
    } catch (error) {
      if (error instanceof Error && error.name !== "AbortError") {
        console.error("Error loading more requests:", error);
      }
    } finally {
      setIsLoadingMore(false);
      isLoadingRef.current = false;
      if (loadMoreAbortRef.current === controller) {
        loadMoreAbortRef.current = null;
      }
    }
  }, [fetchRequestsPage, getScrollViewport]);

  // Store loadMoreRequests in a ref to avoid recreating observer
  const loadMoreRequestsRef = useRef(loadMoreRequests);
  useEffect(() => {
    loadMoreRequestsRef.current = loadMoreRequests;
  }, [loadMoreRequests]);

  // Use Intersection Observer to detect when sentinel is visible (near bottom)
  // Now works for both search and non-search scenarios
  useEffect(() => {
    if (!hasMore) return;
    sentinelWasIntersectingRef.current = false;

    const scrollViewport = getScrollViewport();
    if (!scrollViewport || !sentinelRef.current) return;

    const observer = new IntersectionObserver(
      entries => {
        const entry = entries[0];
        const isIntersecting = Boolean(entry?.isIntersecting);
        const crossedIntoView =
          isIntersecting && !sentinelWasIntersectingRef.current;
        sentinelWasIntersectingRef.current = isIntersecting;

        if (!crossedIntoView) {
          return;
        }

        // Use refs to get current values (not closure values)
        const shouldLoad =
          hasMoreRef.current &&
          !isLoadingMoreRef.current &&
          !isLoadingRef.current &&
          !isSearchingRef.current;

        if (shouldLoad) {
          void loadMoreRequestsRef.current();
        }
      },
      {
        root: scrollViewport,
        rootMargin: "0px",
        threshold: 0,
      }
    );

    const sentinel = sentinelRef.current;
    observer.observe(sentinel);

    return () => {
      observer.disconnect();
    };
  }, [getScrollViewport, hasMore]); // Stable dependencies - use refs for loading state

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (searchAbortRef.current) {
        searchAbortRef.current.abort();
      }
      if (loadMoreAbortRef.current) {
        loadMoreAbortRef.current.abort();
      }
    };
  }, []);

  // Merge all requests with realtime updates
  const displayRequests = useMemo(() => {
    return mergeDisplayRequests({
      allRequests,
      realtimeRows,
      updatedRowIds,
      hasServerBackedFilter,
      hasUnreadFilter: showUnreadOnly,
      recentlyReadInUnreadView: effectiveRecentlyReadInUnreadView,
      locallyReadAtByConversation,
    });
  }, [
    allRequests,
    showUnreadOnly,
    hasServerBackedFilter,
    realtimeRows,
    updatedRowIds,
    effectiveRecentlyReadInUnreadView,
    locallyReadAtByConversation,
  ]);

  // Mark the open conversation read when it opens and again only if it turns
  // unread while open; unrelated realtime updates must not re-send /read.
  const activeRowIsUnread =
    activeConversationId !== null &&
    displayRequests.some(
      row => row.id === activeConversationId && row.isReadByManager !== true
    );
  const lastReadMarkRef = useRef<{ id: string; unread: boolean } | null>(null);
  useEffect(() => {
    if (!activeConversationId) {
      lastReadMarkRef.current = null;
      return;
    }
    const previous = lastReadMarkRef.current;
    const opened = previous?.id !== activeConversationId;
    const turnedUnread = !opened && activeRowIsUnread && !previous?.unread;
    lastReadMarkRef.current = {
      id: activeConversationId,
      unread: activeRowIsUnread,
    };
    if (opened || turnedUnread) {
      void markConversationAsRead(activeConversationId);
    }
  }, [activeConversationId, activeRowIsUnread, markConversationAsRead]);

  // Realtime in-memory filter to make transitions instantaneous
  const clientFilteredRequests = useMemo(() => {
    const q = normalizedSearchQuery.toLowerCase();
    if (!hasActiveFilter) {
      return displayRequests;
    }

    const filtered: RequestItem[] = [];
    for (const req of displayRequests) {
      if (hasUrlListQuery && !requestMatchesListQuery(req, listQuery)) {
        continue;
      }

      if (hasSourceFilter && req.channel !== selectedSourceType) {
        continue;
      }

      if (hasCategoryFilter && req.category !== selectedCategory) {
        continue;
      }

      if (
        hasLabelFilter &&
        !req.internalLabels?.includes(selectedInternalLabel)
      ) {
        continue;
      }

      if (
        showUnreadOnly &&
        req.isReadByManager === true &&
        !effectiveRecentlyReadInUnreadView.has(req.id)
      ) {
        continue;
      }

      if (showAiriRepliedOnly && req.airiLastReplied !== true) {
        continue;
      }

      if (q) {
        const client = req.client?.toLowerCase() ?? "";
        const rename = req.rename?.toLowerCase() ?? "";
        const lastMessageText = req.lastMessageText?.toLowerCase() ?? "";
        const requestText = req.request?.toLowerCase() ?? "";

        if (searchType === "profile_name") {
          if (!client.includes(q) && !rename.includes(q)) {
            continue;
          }
        } else if (searchType === "phone_number") {
          if (!client.includes(q)) {
            continue;
          }
        } else if (
          searchType === "message_within_chat" &&
          !lastMessageText.includes(q) &&
          !requestText.includes(q) &&
          !req.lastMessages?.some(message =>
            message.text?.toLowerCase().includes(q)
          )
        ) {
          continue;
        }
      }

      filtered.push(req);
    }

    return filtered;
  }, [
    displayRequests,
    hasActiveFilter,
    hasUrlListQuery,
    listQuery,
    hasSourceFilter,
    selectedSourceType,
    hasCategoryFilter,
    selectedCategory,
    hasLabelFilter,
    selectedInternalLabel,
    showUnreadOnly,
    showAiriRepliedOnly,
    effectiveRecentlyReadInUnreadView,
    normalizedSearchQuery,
    searchType,
  ]);

  const effectiveEditingConversationId =
    editingConversationId &&
    clientFilteredRequests.some(row => row.id === editingConversationId)
      ? editingConversationId
      : null;

  useEffect(() => {
    if (showUnreadOnly || recentlyReadInUnreadView.size === 0) {
      return;
    }
    setRecentlyReadInUnreadView(new Set());
  }, [showUnreadOnly, recentlyReadInUnreadView]);

  // Keyboard shortcut: Ctrl+F or Cmd+F
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const searchPlaceholder = t(searchMode.placeholderKey);
  const isTextSearchMode = searchType !== "source_type";
  const selectedSourceTypeLabel =
    selectedSourceType === "all"
      ? t("allSources")
      : channelLabel(selectedSourceType);

  const updateSearchType = useCallback(
    (value: RequestsDialogSearchType) => {
      if (value !== searchType) {
        markFilterRefreshPending();
      }
      setSearchType(value);
    },
    [markFilterRefreshPending, searchType, setSearchType]
  );

  const updateSelectedSourceType = useCallback(
    (value: string) => {
      if (value !== selectedSourceType) {
        markFilterRefreshPending();
      }
      setSelectedSourceType(value);
    },
    [markFilterRefreshPending, selectedSourceType, setSelectedSourceType]
  );

  const updateSelectedInternalLabel = useCallback(
    (value: string) => {
      if (value !== selectedInternalLabel) {
        markFilterRefreshPending();
      }
      setSelectedInternalLabel(value);
    },
    [markFilterRefreshPending, selectedInternalLabel, setSelectedInternalLabel]
  );

  const updateSelectedCategory = useCallback(
    (value: string) => {
      if (value !== selectedCategory) {
        markFilterRefreshPending();
      }
      setSelectedCategory(value);
    },
    [markFilterRefreshPending, selectedCategory, setSelectedCategory]
  );

  const updateAiriRepliedFilter = useCallback(
    (value: boolean) => {
      if (value !== showAiriRepliedOnly) {
        markFilterRefreshPending();
      }
      setShowAiriRepliedOnly(value);
    },
    [markFilterRefreshPending, showAiriRepliedOnly]
  );

  const resetToDefaultSearchMode = useCallback(
    (markPending = true) => {
      if (
        markPending &&
        (searchType !== DEFAULT_DIALOG_SEARCH_TYPE ||
          selectedSourceType !== "all")
      ) {
        markFilterRefreshPending();
      }
      setSearchType(DEFAULT_DIALOG_SEARCH_TYPE);
      setSelectedSourceType("all");
    },
    [
      markFilterRefreshPending,
      searchType,
      selectedSourceType,
      setSearchType,
      setSelectedSourceType,
    ]
  );

  const clearAllFilters = useCallback(() => {
    if (hasActiveFilter) {
      markFilterRefreshPending();
    }
    setSearchQuery("");
    setShowAiriRepliedOnly(false);
    setSelectedInternalLabel("all");
    setSelectedCategory("all");
    if (showUnreadOnly) {
      setUnreadFilterEnabled(false);
    }
    resetToDefaultSearchMode(false);
    if (hasUrlListQuery) {
      clearUrlListQuery();
    }
  }, [
    clearUrlListQuery,
    hasActiveFilter,
    hasUrlListQuery,
    markFilterRefreshPending,
    resetToDefaultSearchMode,
    setSearchQuery,
    setShowAiriRepliedOnly,
    setSelectedCategory,
    setSelectedInternalLabel,
    setUnreadFilterEnabled,
    showUnreadOnly,
  ]);

  const renderMoreSelect = ({
    ariaLabel,
    children,
    value,
    onValueChange,
  }: {
    ariaLabel: string;
    children: React.ReactNode;
    value: string;
    onValueChange: (value: string) => void;
  }) => (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger
        aria-label={ariaLabel}
        size="sm"
        className="!h-11 w-auto max-w-full gap-1 rounded-full border-border/60 bg-background px-3 py-0 text-xs font-medium leading-none shadow-none md:!h-7 md:max-w-36 md:px-2.5 md:text-[11px] [&>span]:truncate [&_svg]:!size-3"
      >
        <SelectValue placeholder={ariaLabel} />
      </SelectTrigger>
      <SelectContent>{children}</SelectContent>
    </Select>
  );

  const renderChoiceFilterGroup = ({
    title,
    allLabel,
    value,
    onChange,
    visibleValues,
    allValues,
    hasMore,
    moreAriaLabel,
    formatLabel = option => option,
  }: {
    title: string;
    allLabel: string;
    value: string;
    onChange: (value: string) => void;
    visibleValues: readonly string[];
    allValues: readonly string[];
    hasMore: boolean;
    moreAriaLabel: string;
    formatLabel?: (value: string) => string;
  }) => (
    <div className="space-y-1.5">
      <div className="text-[11px] text-muted-foreground">{title}</div>
      <div className="flex flex-wrap gap-1.5">
        <FilterChoiceButton
          active={value === "all"}
          onClick={() => onChange("all")}
        >
          {allLabel}
        </FilterChoiceButton>
        {visibleValues.map(option => (
          <FilterChoiceButton
            key={option}
            active={value === option}
            onClick={() => onChange(option)}
          >
            {formatLabel(option)}
          </FilterChoiceButton>
        ))}
        {hasMore &&
          renderMoreSelect({
            ariaLabel: moreAriaLabel,
            value,
            onValueChange: onChange,
            children: (
              <>
                <SelectItem value="all">{allLabel}</SelectItem>
                {allValues.map(option => (
                  <SelectItem key={option} value={option}>
                    {formatLabel(option)}
                  </SelectItem>
                ))}
              </>
            ),
          })}
      </div>
    </div>
  );

  const renderFilterTray = (options?: {
    mobile?: boolean;
    showHeader?: boolean;
  }) => {
    const isMobileTray = options?.mobile === true;
    const showHeader = options?.showHeader !== false;
    return (
      <div className={cn("space-y-3", isMobileTray ? "pb-2" : undefined)}>
        {showHeader && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold">{t("filterHeader")}</p>
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                  {t("filterTraySubtitle")}
                </p>
              </div>
              {hasActiveFilter && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0 rounded-full px-2.5 text-[11px]"
                  onClick={clearAllFilters}
                >
                  {t("clearFilters")}
                </Button>
              )}
            </div>

            {activeFilterSummaryItems.length > 0 && (
              <ScrollArea className="w-full overflow-hidden">
                <div className="flex min-w-max items-center gap-1.5 pb-1">
                  {activeFilterSummaryItems.map(item => (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => item.onClear?.()}
                      aria-label={
                        item.onClear
                          ? `${t("clearFilters")}: ${item.label}`
                          : item.label
                      }
                      className="inline-flex h-6 max-w-48 items-center gap-1 rounded-full border bg-muted/35 px-2 text-[11px] font-medium transition-colors hover:bg-muted"
                    >
                      <span className="truncate">{item.label}</span>
                      {item.onClear && <X className="h-3 w-3 shrink-0" />}
                    </button>
                  ))}
                </div>
                <ScrollBar orientation="horizontal" className="h-1.5" />
              </ScrollArea>
            )}
          </div>
        )}

        <div className="space-y-1.5">
          <div className="text-[11px] font-medium text-muted-foreground">
            {t("searchTypeTitle")}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {REQUEST_SEARCH_MODE_OPTIONS.map(option => (
              <FilterChoiceButton
                key={option.value}
                active={searchType === option.value}
                onClick={() => updateSearchType(option.value)}
              >
                {t(option.labelKey)}
              </FilterChoiceButton>
            ))}
          </div>
        </div>

        <div className="space-y-2.5">
          <div className="border-t border-border/60" aria-hidden="true" />

          <div className="space-y-1.5">
            <div className="text-[11px] text-muted-foreground">
              {t("replyOwnerTitle")}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <FilterChoiceButton
                active={showAiriRepliedOnly}
                onClick={() => updateAiriRepliedFilter(!showAiriRepliedOnly)}
              >
                {t("airiRepliedBadge")}
              </FilterChoiceButton>
            </div>
          </div>

          {renderChoiceFilterGroup({
            title: t("sourceTypeTitle"),
            allLabel: t("allSources"),
            value: selectedSourceType,
            onChange: updateSelectedSourceType,
            visibleValues: visibleSourceFilterValues,
            allValues: sourceFilterValues,
            hasMore: hasMoreSourceFilters,
            moreAriaLabel: t("filterMoreSources"),
            formatLabel: channelLabel,
          })}

          {renderChoiceFilterGroup({
            title: t("labelsTitle"),
            allLabel: t("allLabels"),
            value: selectedInternalLabel,
            onChange: updateSelectedInternalLabel,
            visibleValues: visibleLabelFilterValues,
            allValues: labelFilterValues,
            hasMore: hasMoreLabelFilters,
            moreAriaLabel: t("filterMoreLabels"),
          })}

          {renderChoiceFilterGroup({
            title: t("categoriesTitle"),
            allLabel: t("allCategories"),
            value: selectedCategory,
            onChange: updateSelectedCategory,
            visibleValues: visibleCategoryFilterValues,
            allValues: availableCategories,
            hasMore: hasMoreCategoryFilters,
            moreAriaLabel: t("filterMoreCategories"),
          })}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={cn(
              "h-11 px-3 text-xs md:h-7 md:px-2.5 md:text-[11px]",
              subtleFilterButtonClass,
              showUnreadOnly && subtleFilterButtonActiveClass
            )}
            onClick={() => setUnreadFilterEnabled(prev => !prev)}
            aria-pressed={showUnreadOnly}
          >
            {unreadFilterButtonContent}
          </Button>

          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-11 rounded-full px-3 text-xs md:h-7 md:px-2.5 md:text-[11px]"
            onClick={() => void markAllAsRead()}
            disabled={isMarkingAllRead || unreadCount === 0}
          >
            {isMarkingAllRead && (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            )}
            Read all
          </Button>
        </div>
      </div>
    );
  };

  const activeFilterSummaryItems = [
    hasSearchQuery
      ? {
          key: "search",
          label: `${t(searchMode.labelKey)}: ${normalizedSearchQuery}`,
          onClear: () => setSearchQuery(""),
        }
      : null,
    hasSourceFilter
      ? {
          key: "source",
          label: `${t("searchTypeSource")}: ${selectedSourceTypeLabel}`,
          onClear: resetToDefaultSearchMode,
        }
      : null,
    showAiriRepliedOnly
      ? {
          key: "airi-replied",
          label: t("airiRepliedBadge"),
          onClear: () => updateAiriRepliedFilter(false),
        }
      : null,
    hasLabelFilter
      ? {
          key: "label",
          label: selectedInternalLabel,
          onClear: () => updateSelectedInternalLabel("all"),
        }
      : null,
    hasCategoryFilter
      ? {
          key: "category",
          label: selectedCategory,
          onClear: () => updateSelectedCategory("all"),
        }
      : null,
    listQuery.filter
      ? {
          key: "analytics-filter",
          label: t(`analyticsFilters.${listQuery.filter}`),
          onClear: clearUrlListQuery,
        }
      : null,
    listQuery.status
      ? {
          key: "analytics-status",
          label: t(`statuses.${listQuery.status}`),
          onClear: clearUrlListQuery,
        }
      : null,
    showUnreadOnly
      ? {
          key: "unread",
          label:
            unreadCount > 0
              ? t("unreadFilterWithCount", { count: unreadCount })
              : t("unreadFilter"),
          onClear: () => setUnreadFilterEnabled(false),
        }
      : null,
  ].filter(Boolean) as Array<{
    key: string;
    label: string;
    onClear?: (() => void) | undefined;
  }>;

  const subtleFilterButtonClass =
    "rounded-full border-border/60 bg-background text-foreground shadow-none";
  const subtleFilterButtonActiveClass =
    "border-border/80 bg-muted text-foreground hover:bg-muted/90";
  const filterCountBadgeClass =
    "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-semibold";
  const unreadFilterButtonContent = (
    <>
      {isUnreadFilterPending && (
        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
      )}
      <span>{t("unreadFilter")}</span>
      {unreadCount > 0 && (
        <span
          className={cn(
            filterCountBadgeClass,
            "ml-1 bg-foreground text-background"
          )}
        >
          {unreadCount}
        </span>
      )}
    </>
  );

  const desktopSearchField = isTextSearchMode ? (
    <motion.div
      className="relative min-w-0 w-full"
      initial={false}
      animate={{ scale: 1 }}
      transition={{ duration: 0.2 }}
    >
      {isSearching ? (
        <Loader2 className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground animate-spin" />
      ) : (
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      )}
      <Input
        ref={searchInputRef}
        placeholder={searchPlaceholder}
        aria-label={searchPlaceholder}
        value={searchQuery}
        onChange={e => setSearchQuery(e.target.value)}
        className="h-9 w-full rounded-full border-border/60 bg-muted/40 pl-9 pr-9 text-sm shadow-none transition-all duration-200 focus:bg-background focus:border-primary/50"
      />
      {searchQuery && (
        <button
          type="button"
          onClick={() => setSearchQuery("")}
          aria-label={t("clearFilters")}
          className="absolute right-2 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </motion.div>
  ) : (
    <button
      type="button"
      onClick={() => setDesktopFiltersOpen(true)}
      className="flex h-9 w-full items-center gap-2 rounded-full border border-border/60 bg-muted/35 px-3 text-left text-sm transition-colors hover:bg-muted/50"
    >
      {isSearching ? (
        <Loader2 className="h-4 w-4 shrink-0 text-muted-foreground animate-spin" />
      ) : (
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
      )}
      <span className="truncate text-muted-foreground">
        {hasSourceFilter
          ? `${t("searchTypeSource")}: ${selectedSourceTypeLabel}`
          : t("selectSourceType")}
      </span>
    </button>
  );

  const conversationList = (
    <ScrollArea className="flex-1 min-h-0 pb-0">
      <div
        ref={scrollContainerRef}
        className={cn(
          "flex flex-col",
          isMobile ? "pb-[calc(env(safe-area-inset-bottom)+16px)]" : "pb-4"
        )}
      >
        <AnimatePresence mode={isMobile ? "sync" : "popLayout"}>
          {isSearching && clientFilteredRequests.length === 0
            ? [
                <span
                  key="loading-status"
                  role="status"
                  aria-live="polite"
                  className="sr-only"
                >
                  {t("loadingConversations")}
                </span>,
                ...Array.from({ length: 5 }).map((_, index) => (
                  <motion.div
                    key={`skeleton-${index}`}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                  >
                    <RequestRowSkeleton />
                  </motion.div>
                )),
              ]
            : clientFilteredRequests.map(req => {
                const isActive = activeConversationId === req.id;
                const isEditingName = effectiveEditingConversationId === req.id;

                return (
                  <DialogListItem
                    key={req.id}
                    req={req}
                    isActive={isActive}
                    isEditingName={isEditingName}
                    isMobile={isMobile}
                    locale={locale}
                    recommendationLabel={recommendationLabel}
                    renameDraft={renameDraft}
                    isSavingRename={isSavingRename}
                    nowMs={renderNowMs}
                    timeZone={renderTimeZone}
                    renameEditorRef={renameEditorRef}
                    renameInputRef={renameInputRef}
                    onItemClick={handleItemClick}
                    onItemPressStart={handleItemPressStart}
                    onStartRenaming={startRenaming}
                    onSaveRenaming={saveRenaming}
                    onCancelRenaming={cancelRenaming}
                    onRenameDraftChange={setRenameDraft}
                    t={t}
                  />
                );
              })}
        </AnimatePresence>

        <AnimatePresence>
          {clientFilteredRequests.length === 0 &&
            !isLoadingMore &&
            !isSearching && (
              <Suspense
                fallback={
                  <div
                    role="status"
                    className="flex items-center justify-center p-4 text-sm text-muted-foreground"
                  >
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t("loadingConversations")}
                  </div>
                }
              >
                <DialogListEmptyState
                  workspaceId={workspaceId}
                  hasConfiguredSources={hasConfiguredSources}
                />
              </Suspense>
            )}
        </AnimatePresence>

        <AnimatePresence>
          {isLoadingMore && !isSearching && (
            <motion.div
              className="flex items-center justify-center p-4"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
            >
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">
                {t("loadingMore")}
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Sentinel element for intersection observer */}
        <div ref={sentinelRef} className="h-1" aria-hidden="true" />

        <AnimatePresence>
          {!hasMore && clientFilteredRequests.length > 0 && (
            <motion.div
              className="p-4 text-center text-xs text-muted-foreground"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              {t("noMoreConversations")}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </ScrollArea>
  );

  // Count active filters for mobile badge
  const activeFilterCount = [
    hasSearchQuery,
    hasSourceFilter,
    hasLabelFilter,
    hasCategoryFilter,
    showAiriRepliedOnly,
    hasUrlListQuery,
    showUnreadOnly,
  ].filter(Boolean).length;

  // At the free cap nothing is hidden yet, so only the intake line shows.
  const planGateTitle =
    planGate?.reason === "trial_expired"
      ? t("planGateTrialEnded")
      : planGate && planGate.hiddenCount > 0
        ? t("planGateHiddenConversations", {
            hiddenCount: planGate.hiddenCount,
          })
        : null;
  const planGateNotice = planGate ? (
    <div className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-amber-950">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          {planGateTitle ? (
            <p className="text-sm font-semibold">{planGateTitle}</p>
          ) : null}
          <p
            className={
              planGateTitle
                ? "text-xs text-amber-900/80"
                : "text-sm font-semibold"
            }
          >
            {planGate.reason === "trial_expired"
              ? t("planGateTrialExpiredIntake")
              : t("planGateConversationLimitIntake")}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          className="shrink-0"
          onClick={() => setUpgradeDialogOpen(true)}
        >
          {t("planGateUpgrade")}
        </Button>
      </div>
    </div>
  ) : null;

  const upgradeDialog = planGate ? (
    <PlanUpgradeDialog
      workspaceId={workspaceId}
      subscriptionType={planGate.limit.subscriptionType}
      open={upgradeDialogOpen}
      onOpenChange={setUpgradeDialogOpen}
      reason={planGate.reason}
      hiddenCount={planGate.hiddenCount}
    />
  ) : null;

  // Reuse the shared modal focus/keyboard behavior for the mobile filter tray.
  if (isMobile) {
    return (
      <div className="flex flex-col h-full w-full overflow-x-hidden bg-background relative">
        {/* Floating sticky search bar */}
        <div className="sticky top-0 z-30 px-2 pt-2 pb-1 bg-background/95 backdrop-blur-sm">
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label={searchPlaceholder}
              aria-haspopup="dialog"
              aria-expanded={mobileFiltersOpen}
              onClick={event => {
                mobileFilterOpenerRef.current = event.currentTarget;
                setMobileSearchAutoFocus(true);
                setMobileFiltersOpen(true);
              }}
              className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-full border border-input bg-muted/40 px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch-manipulation"
            >
              <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="truncate">
                {searchQuery || searchPlaceholder}
              </span>
            </button>
            <Button
              type="button"
              size="icon"
              variant="outline"
              className={cn(
                "relative h-11 w-11 shrink-0",
                subtleFilterButtonClass,
                activeFilterCount > 0 && subtleFilterButtonActiveClass
              )}
              aria-label={t("filterHeader")}
              aria-haspopup="dialog"
              aria-expanded={mobileFiltersOpen}
              onClick={event => {
                mobileFilterOpenerRef.current = event.currentTarget;
                setMobileSearchAutoFocus(false);
                setMobileFiltersOpen(true);
              }}
            >
              {isSearching ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <SlidersHorizontal className="h-4 w-4" />
              )}
              {activeFilterCount > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-foreground text-[10px] font-medium text-background">
                  {activeFilterCount}
                </span>
              )}
            </Button>
          </div>
        </div>
        {planGateNotice}

        <Sheet
          open={mobileFiltersOpen && !activeConversationId}
          onOpenChange={open => {
            setMobileFiltersOpen(open);
            if (!open) setMobileSearchAutoFocus(false);
          }}
        >
          <SheetContent
            side="top"
            showCloseButton={false}
            className="h-dvh max-h-dvh gap-0 overflow-hidden pt-[env(safe-area-inset-top)]"
            onOpenAutoFocus={event => {
              if (mobileSearchAutoFocus && searchInputRef.current) {
                event.preventDefault();
                searchInputRef.current.focus();
              }
            }}
            onCloseAutoFocus={event => {
              event.preventDefault();
              // The master/detail owner focuses a newly selected conversation.
              if (activeConversationId) return;
              const opener = mobileFilterOpenerRef.current;
              const target = opener?.isConnected
                ? opener
                : (searchInputRef.current ?? desktopFilterTriggerRef.current);
              if (
                target?.isConnected &&
                !target.closest('[inert], [hidden], [aria-hidden="true"]')
              ) {
                target.focus({ preventScroll: true });
              }
            }}
          >
            <div className="flex items-center justify-between border-b px-3 py-2.5">
              <div className="min-w-0">
                <SheetTitle className="text-sm font-semibold">
                  {t("filterHeader")}
                </SheetTitle>
                <SheetDescription className="mt-0.5 text-xs text-muted-foreground">
                  {t("filterTraySubtitle")}
                </SheetDescription>
              </div>
              <SheetClose asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-11 w-11 shrink-0"
                  aria-label={t("closeFilters")}
                >
                  <X className="h-4 w-4" />
                </Button>
              </SheetClose>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">
              {isTextSearchMode ? (
                <div className="relative min-w-0 w-full">
                  <Search className="pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    ref={searchInputRef}
                    placeholder={searchPlaceholder}
                    aria-label={searchPlaceholder}
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    className="h-11 w-full border-input bg-muted/40 pl-9 text-base transition-colors focus:border-primary/50 focus:bg-background touch-manipulation"
                  />
                </div>
              ) : (
                <div className="rounded-xl border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                  {hasSourceFilter
                    ? `${t("searchTypeSource")}: ${selectedSourceTypeLabel}`
                    : t("selectSourceType")}
                </div>
              )}

              <div className="mt-3">
                {renderFilterTray({ mobile: true, showHeader: false })}
              </div>
            </div>

            <div className="shrink-0 border-t px-3 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
              <SheetClose asChild>
                <Button
                  type="button"
                  className="h-11 w-full"
                  aria-busy={isSearching}
                >
                  {isSearching ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      {t("applyingFilters")}
                    </>
                  ) : (
                    t("applyFilters")
                  )}
                </Button>
              </SheetClose>
            </div>
          </SheetContent>
        </Sheet>

        {/* Conversation list */}
        {conversationList}
        {upgradeDialog}
      </div>
    );
  }

  // Desktop: Original layout with filters in header
  return (
    <div className="flex flex-col h-full w-full overflow-x-hidden bg-background md:border-r relative">
      <div className="border-b border-border/60 bg-background/95 backdrop-blur-sm">
        <div className="flex h-11 items-center gap-2 px-3">
          <div className="min-w-0 flex-1">{desktopSearchField}</div>

          <Button
            type="button"
            size="sm"
            variant="outline"
            className={cn(
              "h-9 px-3 text-xs",
              subtleFilterButtonClass,
              showUnreadOnly && subtleFilterButtonActiveClass
            )}
            onClick={() => setUnreadFilterEnabled(prev => !prev)}
          >
            {unreadFilterButtonContent}
          </Button>

          <Popover
            open={desktopFiltersOpen}
            onOpenChange={setDesktopFiltersOpen}
          >
            <PopoverTrigger asChild>
              <Button
                ref={desktopFilterTriggerRef}
                type="button"
                size="sm"
                variant="outline"
                className={cn(
                  "h-9 px-3",
                  subtleFilterButtonClass,
                  activeFilterCount > 0 && subtleFilterButtonActiveClass
                )}
                title={t("filterHeader")}
                aria-label={t("filterHeader")}
              >
                <SlidersHorizontal className="h-4 w-4" />
                {activeFilterCount > 0 && (
                  <span
                    className={cn(
                      filterCountBadgeClass,
                      "bg-foreground text-background"
                    )}
                  >
                    {activeFilterCount}
                  </span>
                )}
              </Button>
            </PopoverTrigger>

            {desktopFiltersOpen && (
              <PopoverContent
                align="end"
                sideOffset={10}
                className="w-[26rem] max-w-[calc(100vw-1.5rem)] overflow-hidden p-0"
              >
                <ScrollArea className="max-h-[min(72vh,34rem)] overflow-hidden">
                  <div className="p-3">{renderFilterTray()}</div>
                </ScrollArea>
              </PopoverContent>
            )}
          </Popover>
        </div>
      </div>
      {planGateNotice}
      {conversationList}
      {upgradeDialog}
    </div>
  );
}
