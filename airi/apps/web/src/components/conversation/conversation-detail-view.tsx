"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ui/conversation";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useCoachTyping, type CoachingPayload } from "@/hooks/use-coach-typing";
import { useIsMobile } from "@/hooks/use-mobile";
import { useManagerTypingIndicator } from "@/hooks/use-manager-typing-indicator";
import { useRealtime } from "@/hooks/use-realtime";
import { buildWhatsAppReplyTextPreview } from "@icecore/shared/lib/whatsapp/message-id";
import type { MobileWindowStatusResponse } from "@icecore/shared/types/mobile-api";
import type { RealtimeEventEnvelope } from "@icecore/shared/types/realtime";
import {
  AlertTriangle,
  ArrowRight,
  Loader2,
  LockKeyhole,
  PanelRight,
  UploadCloud,
} from "lucide-react";
import {
  type DragEvent,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { ConversationThread } from "./conversation-thread";

import type { PopulatedMessage } from "@/types/models";
import type { OutboundAttachment } from "@/types/outbound-attachment";
import type { FormattedRequest } from "@/features/panel/requests/formatting";

import { checkProfanity } from "@/lib/airi/coach/coach-utils";
import {
  airiTypingAtom,
  coachOpenAtom,
  coachUnreadAtom,
  coachUserClosedAtom,
} from "@/components/conversation/airi-coach-state";
import {
  joinWhatsAppCallMedia,
  type WhatsAppCallMediaJoinOptions,
  type WhatsAppCallMediaJoinResult,
} from "@/lib/calling/browser-call-media";
import {
  buildConversationChatKey,
  buildConversationFullKey,
  buildConversationMessagesPageUrl,
  ConversationPlanGateError,
  fetchConversationDetail,
  isConversationDetailPreloaded,
} from "@/lib/conversation/detail-client";
import {
  getConversationTitle,
  isGroupLikeChatType,
} from "@/lib/conversation/display-name";
import type { InstagramHumanAgentCapability } from "@/lib/instagram/human-agent";
import { requiresMessagingWindow } from "@/lib/messaging-window-utils";
import { loadPostHogClient } from "@/lib/posthog/client";
import { getWhatsAppSendBlockingReason } from "@/lib/whatsapp/account/health";
import {
  fetchWhatsAppOnboardingHealth,
  resolveWhatsAppAccountHealth,
  type WhatsAppOnboardingHealthResponse,
} from "@/lib/whatsapp/onboarding-health-response";
import {
  AttachmentUploadBatchError,
  AttachmentUploadError,
  AttachmentUploadTimeoutError,
  uploadAttachmentDirectly,
  uploadAttachmentThroughApi,
} from "@/lib/conversation/attachment-upload";
import { resolveConversationScenariosEnabled } from "@/lib/airi/workspace-bot-contract";
import { cn } from "@/lib/utils";
import { useAtom, useSetAtom } from "jotai";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import useSWR from "swr";
import type { StickToBottomContext } from "use-stick-to-bottom";
import { AiriCoachPanel } from "./airi-coach-panel";
import { ConversationHeader } from "./conversation-header";
import { ConversationBackButton } from "./conversation-back-button";
import { ConversationSelectionPreview } from "./conversation-selection-preview";
import { ConversationInfoSheet } from "./conversation-info-sheet";
import type { ConversationInfoDetails } from "./conversation-info-view-model";
import { ConversationSales } from "./conversation-sales";
import { MetaWindowStatus } from "./meta-window-status";
import type { MessageTextUpdatedHandler } from "./outbound-whatsapp-message-shell";
import { ReplyForm } from "./reply-form";
import {
  WhatsAppCallBanner,
  type WhatsAppCallSessionPreview,
} from "./whatsapp-call-banner";
import { isReplyComposerDisabled } from "./window-status-utils";

type MessagePaginationState = {
  page: number;
  has_more: boolean;
  total?: number;
  limit?: number;
};

/**
 * The chat payload. Most of it only passes through to the info sheet; the
 * fields below are the ones this view reads that the sheet does not declare.
 */
type Detail = ConversationInfoDetails & {
  workspaceId?: string;
  messages: PopulatedMessage[];
  chat?: {
    whatsappGroup?: { groupId?: string | null } | null;
  } | null;
  whatsappGroup?: { groupId?: string | null } | null;
  quick_note?: string | null;
  quick_note_updated_at?: string | Date | null;
  quick_note_updated_by?: string | null;
  message_count?: number | null;
  message_pagination?: MessagePaginationState;
  whatsapp_call_sessions?: WhatsAppCallSessionPreview[];
  messaging_window?: MobileWindowStatusResponse | null;
};

type AiriSuppressedReason = NonNullable<Detail["airi_last_suppressed_reason"]>;

type AiriSuppressedState = {
  reason: AiriSuppressedReason;
  managerUserId?: string | null;
  messageId?: string | null;
  suppressedAt?: string | Date | null;
} | null;

const OPTIMISTIC_OUTBOUND_PREFIX = "optimistic-outbound-";
const REALTIME_CATCH_UP_MIN_INTERVAL_MS = 3000;
const ACTIVE_THREAD_RECONCILIATION_INTERVAL_MS = 30_000;

const INITIAL_MESSAGE_PAGINATION: MessagePaginationState = {
  page: 1,
  has_more: true,
  total: 0,
  limit: 30,
};

type ConversationViewState = {
  details: Detail | null;
  messages: PopulatedMessage[];
  pagination: MessagePaginationState;
  airiCoachEnabled: boolean;
  airiSuppressed: AiriSuppressedState;
};

type ConversationViewAction =
  | {
      type: "hydrate";
      details: Detail;
      messages: PopulatedMessage[];
      pagination: MessagePaginationState;
      airiCoachEnabled: boolean;
      airiSuppressed: AiriSuppressedState;
    }
  | { type: "set_messages"; messages: PopulatedMessage[] }
  | { type: "set_pagination"; pagination: MessagePaginationState }
  | { type: "set_airi_coach_enabled"; value: boolean }
  | { type: "set_airi_suppressed"; value: AiriSuppressedState }
  | {
      type: "patch_details";
      updater: (previous: Detail | null) => Detail | null;
    };

type ConversationDetailAiriSnapshot = Pick<
  Detail,
  | "airi_coach_enabled"
  | "airi_enabled"
  | "airi_last_suppressed_at"
  | "airi_last_suppressed_reason"
  | "airi_last_suppressed_manager_user_id"
  | "airi_last_suppressed_message_id"
>;

export type ConversationDetailViewProps = {
  conversationId: string;
  workspaceId?: string;
  initialHighlightedMessageId?: string;
  searchQuery?: string | null;
  onBack?: () => void;
  requestPreview?: FormattedRequest | null;
};

const INITIAL_CONVERSATION_VIEW_STATE: ConversationViewState = {
  details: null,
  messages: [],
  pagination: INITIAL_MESSAGE_PAGINATION,
  airiCoachEnabled: true,
  airiSuppressed: null,
};

function buildPaginationState(
  pagination?: Detail["message_pagination"] | null,
  fallbackMessageCount = 0
): MessagePaginationState {
  if (pagination) {
    return pagination;
  }

  return {
    ...INITIAL_MESSAGE_PAGINATION,
    has_more: false,
    total: fallbackMessageCount,
  };
}

function getAiriCoachEnabledFromDetails(
  details?: ConversationDetailAiriSnapshot | null
): boolean {
  return details?.airi_coach_enabled ?? details?.airi_enabled ?? true;
}

function getAiriSuppressedStateFromDetails(
  details?: ConversationDetailAiriSnapshot | null
): AiriSuppressedState {
  if (!details?.airi_last_suppressed_reason) {
    return null;
  }

  return {
    reason: details.airi_last_suppressed_reason,
    managerUserId: details.airi_last_suppressed_manager_user_id ?? null,
    messageId: details.airi_last_suppressed_message_id ?? null,
    suppressedAt: details.airi_last_suppressed_at ?? null,
  };
}

function isWhatsAppGroupConversation(details: Detail): boolean {
  if (details.channel !== "whatsapp") return false;
  return Boolean(
    details.whatsappGroup?.groupId || details.chat?.whatsappGroup?.groupId
  );
}

function conversationViewReducer(
  state: ConversationViewState,
  action: ConversationViewAction
): ConversationViewState {
  switch (action.type) {
    case "hydrate":
      return {
        details: action.details,
        messages: action.messages,
        pagination: action.pagination,
        airiCoachEnabled: action.airiCoachEnabled,
        airiSuppressed: action.airiSuppressed,
      };
    case "set_messages":
      return {
        ...state,
        messages: action.messages,
      };
    case "set_pagination":
      return {
        ...state,
        pagination: action.pagination,
      };
    case "set_airi_coach_enabled":
      return {
        ...state,
        airiCoachEnabled: action.value,
      };
    case "set_airi_suppressed":
      return {
        ...state,
        airiSuppressed: action.value,
      };
    case "patch_details":
      return {
        ...state,
        details: action.updater(state.details),
      };
    default:
      return state;
  }
}

// Background reads (window status, older pages, missed-event catch-up) never
// show the server's error text, so a failed response only needs to reject.
async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// SWR rejects a revalidation promise when its fetcher throws — for example a
// dropped request while the tab was offline or the machine asleep. These are
// background refreshes that SWR retries on its own through errorRetryCount, so
// ignore the rejection here instead of letting it escape as an unhandled
// "TypeError: Failed to fetch".
function ignoreBackgroundRevalidationError(): void {}

function dataTransferHasFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;

  if (Array.from(dataTransfer.types || []).includes("Files")) {
    return true;
  }

  return Array.from(dataTransfer.items || []).some(
    item => item.kind === "file"
  );
}

function getDroppedFiles(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer?.files?.length) return [];
  return Array.from(dataTransfer.files);
}

// Object URLs exist in browsers; server rendering and jsdom go without previews.
function createLocalPreviewUrl(file: File): string | undefined {
  return typeof URL.createObjectURL === "function"
    ? URL.createObjectURL(file)
    : undefined;
}

function revokeLocalPreviewUrl(url: string): void {
  if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
}

type MessageDelivery = NonNullable<PopulatedMessage["delivery"]>;

/**
 * A `conversation.message.updated` patch. Delivery fields arrive either
 * nested under `delivery` or flat beside the content fields.
 */
type MessageUpdate = Partial<MessageDelivery> & {
  messageId: string;
  text?: string;
  imageAnalysis?: string;
  audioAnalysis?: string;
  videoAnalysis?: string;
  reactions?: PopulatedMessage["reactions"];
  editMeta?: PopulatedMessage["editMeta"];
  delivery?: PopulatedMessage["delivery"];
};

const MESSAGE_UPDATE_CONTENT_FIELDS = [
  "text",
  "imageAnalysis",
  "audioAnalysis",
  "videoAnalysis",
  "reactions",
  "editMeta",
] as const satisfies ReadonlyArray<keyof MessageUpdate>;

const MESSAGE_UPDATE_DELIVERY_FIELDS = [
  "status",
  "sentAt",
  "deliveredAt",
  "readAt",
  "playedAt",
  "failedAt",
  "lastEventAt",
  "recipientId",
  "recipientWaId",
  "recipientUserId",
  "recipientParentUserId",
  "recipientUsername",
  "recipientType",
  "recipientParticipantId",
  "recipientIdentityKeyHash",
  "errorCode",
  "errorMessage",
  "pricingCategory",
  "pricingType",
  "pricingModel",
  "conversationCategory",
] as const satisfies ReadonlyArray<keyof MessageDelivery>;

function pickDefined<T extends object, K extends keyof T>(
  source: T,
  keys: readonly K[]
): Partial<Pick<T, K>> {
  const picked: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  return picked;
}

function applyMessageUpdate(
  message: PopulatedMessage,
  update: MessageUpdate
): PopulatedMessage {
  const providerMessageId =
    message.messageId !== null && message.messageId !== undefined
      ? String(message.messageId)
      : null;
  if (
    message._id.toString() !== update.messageId &&
    providerMessageId !== update.messageId
  ) {
    return message;
  }

  const flatDelivery = pickDefined(update, MESSAGE_UPDATE_DELIVERY_FIELDS);
  const deliveryPatch =
    update.delivery !== undefined
      ? update.delivery || {}
      : Object.keys(flatDelivery).length > 0
        ? flatDelivery
        : null;

  return {
    ...message,
    ...pickDefined(update, MESSAGE_UPDATE_CONTENT_FIELDS),
    ...(deliveryPatch && {
      delivery: { ...(message.delivery || {}), ...deliveryPatch },
    }),
  };
}

function sortMessagesByDate(items: PopulatedMessage[]): PopulatedMessage[] {
  return [...items].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );
}

/**
 * Merge an API page (newest first) with messages already on screen, keeping
 * realtime arrivals the page does not include yet, in chronological order.
 */
function mergeMessages(
  apiMessages: PopulatedMessage[],
  currentMessages: PopulatedMessage[]
): PopulatedMessage[] {
  const mergedById = new Map<string, PopulatedMessage>();
  for (const apiMsg of [...apiMessages].reverse()) {
    mergedById.set(apiMsg._id.toString(), apiMsg);
  }
  for (const currentMsg of currentMessages) {
    const msgId = currentMsg._id.toString();
    if (!mergedById.has(msgId)) {
      mergedById.set(msgId, currentMsg);
    }
  }

  const mergedMessages = Array.from(mergedById.values());
  // Fast path: keep the existing order when it is already chronological.
  for (let index = 1; index < mergedMessages.length; index += 1) {
    const prevTime = new Date(mergedMessages[index - 1].date).getTime();
    const nextTime = new Date(mergedMessages[index].date).getTime();
    if (
      Number.isNaN(prevTime) ||
      Number.isNaN(nextTime) ||
      nextTime < prevTime
    ) {
      return sortMessagesByDate(mergedMessages);
    }
  }
  return mergedMessages;
}

// Compare datasets rather than build a selector from an id that may hold quotes.
function findMessageElement(
  viewport: HTMLElement,
  messageId: string
): HTMLElement | undefined {
  return Array.from(
    viewport.querySelectorAll<HTMLElement>("[data-message-id]")
  ).find(element => element.dataset.messageId === messageId);
}

export function ConversationDetailView({
  conversationId,
  workspaceId,
  initialHighlightedMessageId,
  onBack,
  searchQuery = null,
  requestPreview = null,
}: ConversationDetailViewProps) {
  const [viewState, dispatchViewState] = useReducer(
    conversationViewReducer,
    INITIAL_CONVERSATION_VIEW_STATE
  );
  const { details, messages, pagination, airiCoachEnabled, airiSuppressed } =
    viewState;
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [attachments, setAttachments] = useState<OutboundAttachment[]>([]);
  const [isUploadingAttachments, setIsUploadingAttachments] = useState(false);
  const [highlightedMessageId, setHighlightedMessageId] = useState<
    string | null
  >(null);
  const [coachTips, setCoachTips] = useState<CoachingPayload | null>(null);
  const [showTypingIndicator, setShowTypingIndicator] = useState(false);
  // The coach suggestion the operator put in the composer, if any.
  const [appliedSuggestionText, setAppliedSuggestionText] = useState("");
  const suggestionApplied = Boolean(appliedSuggestionText);
  const [replyingToMessage, setReplyingToMessage] =
    useState<PopulatedMessage | null>(null);
  const [showInfoDialog, setShowInfoDialog] = useState(false);
  const [fileDragDepth, setFileDragDepth] = useState(0);
  const [instagramReplyMode, setInstagramReplyMode] = useState<
    "comment" | "private"
  >("comment");
  const isFileDragActive = fileDragDepth > 0;
  const setAiriIsTyping = useSetAtom(airiTypingAtom);
  const [coachOpen, setCoachOpen] = useAtom(coachOpenAtom);
  const [coachUserClosed, setCoachUserClosed] = useAtom(coachUserClosedAtom);
  const [coachUnread, setCoachUnread] = useAtom(coachUnreadAtom);

  const openCoachPanel = useCallback(() => {
    setCoachOpen(true);
    setCoachUserClosed(false);
    setCoachUnread(false);
  }, [setCoachOpen, setCoachUnread, setCoachUserClosed]);

  const closeCoachPanel = useCallback(() => {
    setCoachOpen(false);
    setCoachUserClosed(true);
  }, [setCoachOpen, setCoachUserClosed]);

  const clearCoachSuggestion = useCallback(() => {
    setCoachTips(null);
    setShowTypingIndicator(false);
    setAppliedSuggestionText("");
  }, []);

  const presentCoachTips = useCallback(
    (value: CoachingPayload | null) => {
      setCoachTips(value);
      if (!value?.tips?.length) {
        return;
      }
      if (coachUserClosed) {
        setCoachUnread(true);
        return;
      }
      setCoachOpen(true);
      setCoachUnread(false);
    },
    [coachUserClosed, setCoachOpen, setCoachUnread]
  );
  const t = useTranslations("ConversationDetailView");
  const isMobileView = useIsMobile();
  const hasScrolledToBottomOnMount = useRef(false);
  const lastMessageCountRef = useRef(0);
  const isLoadingOldMessagesRef = useRef(false);
  const messagesRef = useRef<PopulatedMessage[]>([]);
  // The host remounts this view per conversation. Uploads, sends and other
  // requests can settle after it left, so their results must not reach the
  // next conversation's screen (a late failure toast, for one).
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  const {
    control,
    register,
    handleSubmit,
    reset,
    setValue,
    getValues,
    formState: { isSubmitting },
  } = useForm<{ reply: string }>({
    defaultValues: { reply: "" },
  });

  // Ref to textarea element to read value directly without re-renders
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const setAiriCoachEnabled = useCallback(
    (value: boolean) => {
      dispatchViewState({
        type: "set_airi_coach_enabled",
        value,
      });
      if (!value) {
        setCoachOpen(false);
      }
    },
    [setCoachOpen]
  );
  const setAiriSuppressed = useCallback((value: AiriSuppressedState) => {
    dispatchViewState({
      type: "set_airi_suppressed",
      value,
    });
  }, []);

  // The host's workspace, or the conversation's own once its detail loads.
  const effectiveWorkspaceId = workspaceId || details?.workspaceId;
  const realtimeScope = useMemo(
    () =>
      effectiveWorkspaceId
        ? {
            kind: "conversation" as const,
            workspaceId: effectiveWorkspaceId,
            conversationId,
          }
        : null,
    [conversationId, effectiveWorkspaceId]
  );
  const { channel, isConnected } = useRealtime(realtimeScope);
  const previousRealtimeConnectedRef = useRef(isConnected);
  const lastRealtimeCatchUpAtRef = useRef(0);
  const realtimeCatchUpInFlightRef = useRef<AbortController | null>(null);

  // Initialize coach typing hook
  const { onTextChange: onCoachTextChange } = useCoachTyping({
    conversationId,
    textareaRef,
    airiCoachEnabled,
    setCoachTips: presentCoachTips,
    setShowTypingIndicator,
    suggestionApplied,
    getTextValue: () => getValues("reply"),
  });
  const { onTextChange: onManagerTypingTextChange } = useManagerTypingIndicator(
    {
      conversationId,
      channel: details?.channel,
      getTextValue: () => getValues("reply"),
    }
  );
  const onTextChange = useCallback(() => {
    onCoachTextChange();
    onManagerTypingTextChange();
  }, [onCoachTextChange, onManagerTypingTextChange]);
  const hydrateConversationData = useEffectEvent((data: Detail) => {
    const mergedMessages = mergeMessages(
      data.messages || [],
      messagesRef.current
    );
    messagesRef.current = mergedMessages;
    dispatchViewState({
      type: "hydrate",
      details: data,
      messages: mergedMessages,
      pagination: buildPaginationState(
        data.message_pagination,
        data.messages?.length || 0
      ),
      airiCoachEnabled: getAiriCoachEnabledFromDetails(data),
      airiSuppressed: getAiriSuppressedStateFromDetails(data),
    });
  });
  const conversationChatKey = buildConversationChatKey(
    conversationId,
    workspaceId
  );
  const {
    data: swrConversationData,
    error: swrError,
    isLoading: swrLoading,
    isValidating,
    mutate,
  } = useSWR<Detail>(conversationChatKey, fetchConversationDetail, {
    // A completed pointer/keyboard preload already populated this exact key.
    // Normal entries and failed/in-flight preloads still use SWR's mount request.
    revalidateOnMount: !isConversationDetailPreloaded(conversationChatKey),
    revalidateOnFocus: false,
    revalidateOnReconnect: true,
    dedupingInterval: 5000,
    errorRetryInterval: 10000,
    errorRetryCount: 2,
  });
  const {
    data: fullConversationData,
    error: fullConversationError,
    isLoading: isFullConversationLoading,
    mutate: refreshFullConversation,
  } = useSWR<Detail>(
    showInfoDialog && details
      ? buildConversationFullKey(conversationId, workspaceId)
      : null,
    fetchConversationDetail,
    {
      revalidateOnFocus: false,
      dedupingInterval: 15000,
      errorRetryCount: 1,
    }
  );

  const planGateError =
    swrError instanceof ConversationPlanGateError ? swrError : null;
  const error =
    swrError && !planGateError ? swrError.message || t("unknownError") : null;

  useLayoutEffect(() => {
    if (swrConversationData) hydrateConversationData(swrConversationData);
  }, [swrConversationData]);

  const isInitialLoading =
    !error &&
    !details &&
    (swrLoading || isValidating || swrConversationData != null);

  // Meta's messaging window gates WhatsApp and Instagram DMs; Instagram
  // comment replies are public and never expire.
  const requiresWindowStatus = Boolean(
    details?.channel &&
      requiresMessagingWindow(details.channel) &&
      details.external_thread?.type !== "comment"
  );
  const embeddedWindowStatus =
    swrConversationData?.messaging_window ?? details?.messaging_window ?? null;
  const {
    data: windowStatusData,
    isLoading: isLoadingWindowStatus,
    mutate: mutateWindowStatus,
  } = useSWR<MobileWindowStatusResponse>(
    requiresWindowStatus
      ? `/api/conversations/${conversationId}/window-status`
      : null,
    fetchJson,
    {
      fallbackData: embeddedWindowStatus ?? undefined,
      // Chat payload already embeds window status — only hit dedicated route on mutate/catch-up.
      revalidateOnMount: !embeddedWindowStatus,
      revalidateOnFocus: false,
    }
  );
  const windowInfo = windowStatusData?.windowInfo ?? null;
  const humanAgent: InstagramHumanAgentCapability =
    windowStatusData?.humanAgent ?? { supported: false, enabled: false };

  // A WhatsApp account the provider cannot send from (for example an
  // incomplete phone registration) fails every reply. Read the same account
  // health the onboarding and campaign screens use so the panel can warn and
  // gate the composer before the operator wastes attempts.
  const { data: whatsappAccountHealthData } =
    useSWR<WhatsAppOnboardingHealthResponse>(
      details?.channel === "whatsapp" && effectiveWorkspaceId
        ? `/api/whatsapp/onboarding?workspaceId=${encodeURIComponent(
            effectiveWorkspaceId
          )}`
        : null,
      fetchWhatsAppOnboardingHealth,
      { revalidateOnFocus: false }
    );
  const whatsappSendBlockingReason = useMemo(
    () =>
      getWhatsAppSendBlockingReason(
        resolveWhatsAppAccountHealth(whatsappAccountHealthData)
      ),
    [whatsappAccountHealthData]
  );

  const requestRealtimeCatchUp = useEffectEvent((messagesOnly = false) => {
    if (
      !realtimeScope ||
      document.visibilityState !== "visible" ||
      realtimeCatchUpInFlightRef.current
    ) {
      return;
    }

    const now = Date.now();
    if (
      now - lastRealtimeCatchUpAtRef.current <
      REALTIME_CATCH_UP_MIN_INTERVAL_MS
    ) {
      return;
    }
    lastRealtimeCatchUpAtRef.current = now;

    const request = new AbortController();
    realtimeCatchUpInFlightRef.current = request;
    const deadline = setTimeout(() => {
      request.abort();
      // SWR mutate does not consume this signal. Release only this operation
      // so a stalled refresh cannot block later lightweight reconciliation.
      if (realtimeCatchUpInFlightRef.current === request)
        realtimeCatchUpInFlightRef.current = null;
    }, 15_000);
    const reconcile = async () => {
      if (!messagesOnly) {
        await mutate();
        return;
      }
      const data = await fetchJson<Detail>(
        buildConversationMessagesPageUrl(
          conversationId,
          1,
          effectiveWorkspaceId
        ),
        { signal: request.signal, cache: "no-store" }
      );
      if (
        !request.signal.aborted &&
        realtimeCatchUpInFlightRef.current === request
      ) {
        applyMessages(mergeMessages(data.messages || [], messagesRef.current));
      }
    };
    void reconcile()
      .catch(ignoreBackgroundRevalidationError)
      .finally(() => {
        clearTimeout(deadline);
        if (realtimeCatchUpInFlightRef.current === request)
          realtimeCatchUpInFlightRef.current = null;
      });
    if (!messagesOnly && requiresWindowStatus) {
      void mutateWindowStatus().catch(ignoreBackgroundRevalidationError);
    }
  });

  useEffect(() => {
    lastRealtimeCatchUpAtRef.current = 0;
    realtimeCatchUpInFlightRef.current = null;
    // Only the open thread reconciles its latest page. Older history stays
    // paginated; no full chat/info hydration or inbox polling is needed.
    const timer = setInterval(
      () => requestRealtimeCatchUp(true),
      ACTIVE_THREAD_RECONCILIATION_INTERVAL_MS
    );
    return () => {
      clearInterval(timer);
      realtimeCatchUpInFlightRef.current?.abort();
      realtimeCatchUpInFlightRef.current = null;
    };
  }, [conversationChatKey]);

  useEffect(() => {
    const wasConnected = previousRealtimeConnectedRef.current;
    previousRealtimeConnectedRef.current = isConnected;

    if (!wasConnected && isConnected) {
      requestRealtimeCatchUp();
    }
  }, [isConnected]);

  useEffect(() => {
    const catchUpIfVisible = () => {
      if (document.visibilityState === "visible") {
        requestRealtimeCatchUp();
      }
    };

    document.addEventListener("visibilitychange", catchUpIfVisible);
    window.addEventListener("focus", catchUpIfVisible);

    return () => {
      document.removeEventListener("visibilitychange", catchUpIfVisible);
      window.removeEventListener("focus", catchUpIfVisible);
    };
  }, []);

  const scrollContextRef = useRef<StickToBottomContext | null>(null);
  // The deep-linked message the first frame was positioned at; undefined until
  // messages render.
  const initialScrollTargetRef = useRef<string | null | undefined>(undefined);
  const typingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const clearTypingTimer = useCallback(() => {
    const timer = typingTimerRef.current;
    typingTimerRef.current = null;
    if (timer) {
      clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // The chat scrolls inside the StickToBottom owner of <Conversation>.
  const getScrollViewport = useCallback(
    (): HTMLElement | null =>
      scrollContextRef.current?.scrollRef.current ?? null,
    []
  );

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const viewport = getScrollViewport();
      if (viewport) {
        viewport.scrollTo({
          top: viewport.scrollHeight,
          behavior,
        });
      }
    },
    [getScrollViewport]
  );

  const isAtBottom = useCallback(() => {
    const viewport = getScrollViewport();
    if (!viewport) return true;
    const { scrollTop, scrollHeight, clientHeight } = viewport;
    return scrollHeight - scrollTop - clientHeight < 100;
  }, [getScrollViewport]);

  const isAtTop = useCallback(() => {
    const viewport = getScrollViewport();
    if (!viewport) return false;
    const { scrollTop } = viewport;
    return scrollTop < 200; // Trigger when within 200px of top
  }, [getScrollViewport]);

  const applyMessages = useCallback((nextMessages: PopulatedMessage[]) => {
    messagesRef.current = nextMessages;
    dispatchViewState({
      type: "set_messages",
      messages: nextMessages,
    });
  }, []);

  const loadMoreMessages = useCallback(async () => {
    if (!pagination.has_more || isLoadingMore) {
      return;
    }

    // Save current scroll position
    const viewport = getScrollViewport();
    const previousScrollHeight = viewport?.scrollHeight || 0;
    const previousScrollTop = viewport?.scrollTop || 0;

    setIsLoadingMore(true);
    isLoadingOldMessagesRef.current = true; // Flag that we're loading old messages

    try {
      const nextPage = pagination.page + 1;
      const data = await fetchJson<Detail>(
        buildConversationMessagesPageUrl(
          conversationId,
          nextPage,
          effectiveWorkspaceId
        )
      );
      const mergedMessages = mergeMessages(
        data.messages || [],
        messagesRef.current
      );
      const nextPagination = data.message_pagination || {
        page: nextPage,
        has_more: false,
        limit: pagination.limit,
        total: pagination.total,
      };

      applyMessages(mergedMessages);
      dispatchViewState({
        type: "set_pagination",
        pagination: {
          ...pagination,
          ...nextPagination,
          total: nextPagination.total ?? pagination.total,
        },
      });

      // Restore scroll position after new messages are loaded
      setTimeout(() => {
        if (viewport) {
          const newScrollHeight = viewport.scrollHeight;
          const scrollDifference = newScrollHeight - previousScrollHeight;
          viewport.scrollTop = previousScrollTop + scrollDifference;
        }

        isLoadingOldMessagesRef.current = false;
      }, 100);
    } catch {
      if (isMountedRef.current) toast.error(t("errorLoadingMessages"));
      isLoadingOldMessagesRef.current = false;
    } finally {
      setIsLoadingMore(false);
    }
  }, [
    conversationId,
    effectiveWorkspaceId,
    getScrollViewport,
    pagination,
    isLoadingMore,
    setIsLoadingMore,
    applyMessages,
    t,
  ]);

  const handleNewMessage = useEffectEvent((newMessage: PopulatedMessage) => {
    let nextMessages = messagesRef.current;

    if (newMessage.direction === "outbound" && !newMessage.author?.isBot) {
      const incomingText = (newMessage.text || "").trim().toLowerCase();
      const matchingOptimisticMessage = messagesRef.current.find(message => {
        const messageId = message._id.toString();
        if (!messageId.startsWith(OPTIMISTIC_OUTBOUND_PREFIX)) {
          return false;
        }
        if (message.direction !== "outbound") {
          return false;
        }

        const optimisticText = (message.text || "").trim().toLowerCase();
        if (!incomingText || !optimisticText) {
          return true;
        }

        return (
          incomingText === optimisticText ||
          incomingText.endsWith(optimisticText) ||
          optimisticText.endsWith(incomingText)
        );
      });

      if (matchingOptimisticMessage) {
        const optimisticMessageId = matchingOptimisticMessage._id.toString();
        nextMessages = messagesRef.current.filter(
          message => message._id.toString() !== optimisticMessageId
        );
      }
    }

    const messageExists = nextMessages.some(
      message => message._id.toString() === newMessage._id.toString()
    );
    if (!messageExists) {
      applyMessages(sortMessagesByDate([...nextMessages, newMessage]));
    }

    if (newMessage.direction === "outbound" && newMessage.author?.isBot) {
      setAiriSuppressed(null);
    }

    if (requiresWindowStatus && newMessage.direction === "inbound") {
      void mutateWindowStatus().catch(ignoreBackgroundRevalidationError);
    }
  });

  const handleAiriSuggestion = useEffectEvent((payload: CoachingPayload) => {
    setShowTypingIndicator(false);
    presentCoachTips(payload);
  });

  const handleAiriSuppressedEvent = useEffectEvent(
    (payload: {
      reason?: AiriSuppressedReason;
      managerUserId?: string | null;
      messageId?: string | null;
      suppressedAt?: string | Date | null;
    }) => {
      if (!payload?.reason) return;
      setAiriSuppressed({
        reason: payload.reason,
        managerUserId: payload.managerUserId ?? null,
        messageId: payload.messageId ?? null,
        suppressedAt: payload.suppressedAt ?? null,
      });
    }
  );

  const handleAiriHandoff = useEffectEvent(
    (payload: {
      scenarioName?: string | null;
      reason?: string | null;
      handoffAt?: string;
      handoffReason?: string | null;
      botPaused?: boolean;
    }) => {
      const isInstagramHumanAgentMode =
        details?.channel === "instagram" &&
        windowInfo?.isWithinWindow === false &&
        humanAgent.enabled;
      const handoffAt = payload.handoffAt || new Date().toISOString();
      const handoffReason =
        payload.handoffReason ||
        payload.reason ||
        (payload.scenarioName
          ? `Triggered by ${payload.scenarioName}`
          : "Scenario requested handoff");

      dispatchViewState({
        type: "patch_details",
        updater: previous => {
          if (!previous) return previous;
          return {
            ...previous,
            status: "in_progress",
            airi_bot_enabled:
              payload.botPaused === true ? false : previous.airi_bot_enabled,
            airi_handoff_active: true,
            airi_handoff_started_at: handoffAt,
          };
        },
      });
      setAiriSuppressed({
        reason: "scenario_handoff",
        managerUserId: null,
        messageId: null,
        suppressedAt: handoffAt,
      });
      toast.info(
        isInstagramHumanAgentMode
          ? "Conversation assigned to human (Human Agent mode)"
          : "Conversation assigned to human",
        {
          description: handoffReason,
        }
      );
    }
  );

  const handleQuickNoteChanged = useEffectEvent(
    (payload: {
      conversationId?: string | null;
      note?: string | null;
      updatedAt?: string | Date | null;
      updatedBy?: string | null;
    }) => {
      if (payload.conversationId && payload.conversationId !== conversationId) {
        return;
      }

      dispatchViewState({
        type: "patch_details",
        updater: previous => {
          if (!previous) return previous;
          return {
            ...previous,
            quick_note: payload.note ?? null,
            quick_note_updated_at:
              payload.updatedAt ?? new Date().toISOString(),
            quick_note_updated_by: payload.updatedBy ?? null,
          };
        },
      });
    }
  );

  const handleQuickNoteChange = useCallback((note: string | null) => {
    dispatchViewState({
      type: "patch_details",
      updater: previous => {
        if (!previous) return previous;
        return {
          ...previous,
          quick_note: note,
          quick_note_updated_at: new Date().toISOString(),
        };
      },
    });
  }, []);

  const handleMessageUpdated = useCallback(
    (update: MessageUpdate) => {
      const applyUpdate = (message: PopulatedMessage) =>
        applyMessageUpdate(message, update);

      applyMessages(messagesRef.current.map(applyUpdate));
      dispatchViewState({
        type: "patch_details",
        updater: previous => {
          if (!previous) return previous;
          return {
            ...previous,
            messages: previous.messages.map(applyUpdate),
          };
        },
      });
    },
    [applyMessages]
  );

  const handleMessageTextUpdated = useCallback<MessageTextUpdatedHandler>(
    (messageId, text, editMeta) =>
      handleMessageUpdated({ messageId, text, editMeta }),
    [handleMessageUpdated]
  );

  const handleCallCommand = useCallback(
    async (
      session: WhatsAppCallSessionPreview,
      action: "accept" | "reject" | "terminate"
    ) => {
      if (!effectiveWorkspaceId) {
        toast.error(t("callCommandFailed"));
        return;
      }

      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(
          effectiveWorkspaceId
        )}/whatsapp/calls/${encodeURIComponent(session._id)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ action }),
        }
      );

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        if (isMountedRef.current) {
          toast.error(t("callCommandFailed"), {
            description: payload?.error,
          });
        }
        return;
      }

      await mutate();
    },
    [effectiveWorkspaceId, mutate, t]
  );

  const handleCallMediaJoin = useCallback(
    async (
      session: WhatsAppCallSessionPreview,
      options: WhatsAppCallMediaJoinOptions
    ): Promise<WhatsAppCallMediaJoinResult> => {
      if (!effectiveWorkspaceId) {
        return {
          ok: false,
          reason: "token_failed",
          error: t("callMediaJoinFailed"),
        };
      }

      const result = await joinWhatsAppCallMedia({
        workspaceId: effectiveWorkspaceId,
        callSessionId: session._id,
        ...options,
      });
      if (
        !result.ok &&
        result.reason === "token_failed" &&
        isMountedRef.current
      ) {
        toast.error(t("callMediaJoinFailed"), {
          description: result.error,
        });
      }
      return result;
    },
    [effectiveWorkspaceId, t]
  );

  const handleAiriTyping = useEffectEvent(() => {
    setAiriIsTyping(true);
    clearTypingTimer();
    typingTimerRef.current = setTimeout(() => {
      setAiriIsTyping(false);
      typingTimerRef.current = null;
    }, 3000);
  });

  useEffect(() => {
    if (!channel) return;

    const getEventData = (event: RealtimeEventEnvelope) => {
      const payload = event.payload as Record<string, unknown>;
      const nestedData = payload.data;
      return nestedData && typeof nestedData === "object"
        ? (nestedData as Record<string, unknown>)
        : payload;
    };

    const onMessageCreated = (event: RealtimeEventEnvelope) => {
      const data = getEventData(event);
      if (typeof data._id === "string") {
        handleNewMessage(data as unknown as PopulatedMessage);
        return;
      }
      // Malformed realtime payload — skip full conversation refetch.
      console.warn(
        "[conversation-detail] conversation.message.created missing _id",
        data
      );
    };

    const onMessageUpdated = (event: RealtimeEventEnvelope) => {
      const data = getEventData(event);
      const messageId =
        typeof data.messageId === "string"
          ? data.messageId
          : typeof data._id === "string"
            ? data._id
            : null;
      if (!messageId) {
        void mutate().catch(ignoreBackgroundRevalidationError);
        return;
      }
      handleMessageUpdated({ ...(data as MessageUpdate), messageId });
    };

    const onCallUpdated = (event: RealtimeEventEnvelope) => {
      if (event.conversationId && event.conversationId !== conversationId) {
        return;
      }
      void mutate().catch(ignoreBackgroundRevalidationError);
    };

    const onAiriSuggestion = (event: RealtimeEventEnvelope) => {
      handleAiriSuggestion(getEventData(event) as unknown as CoachingPayload);
    };

    const onAiriSuppressed = (event: RealtimeEventEnvelope) => {
      handleAiriSuppressedEvent(
        getEventData(event) as Parameters<typeof handleAiriSuppressedEvent>[0]
      );
    };

    const onAiriHandoff = (event: RealtimeEventEnvelope) => {
      handleAiriHandoff(
        getEventData(event) as Parameters<typeof handleAiriHandoff>[0]
      );
    };

    const onQuickNoteChanged = (event: RealtimeEventEnvelope) => {
      handleQuickNoteChanged(
        getEventData(event) as Parameters<typeof handleQuickNoteChanged>[0]
      );
    };

    channel.bind("conversation.message.created", onMessageCreated);
    channel.bind("conversation.message.updated", onMessageUpdated);
    channel.bind("conversation.call.updated", onCallUpdated);
    channel.bind("conversation.note.changed", onQuickNoteChanged);
    channel.bind("airi.suggestion", onAiriSuggestion);
    channel.bind("airi.typing", handleAiriTyping);
    channel.bind("airi.suppressed", onAiriSuppressed);
    channel.bind("airi.handoff", onAiriHandoff);

    return () => {
      channel.unbind("conversation.message.created", onMessageCreated);
      channel.unbind("conversation.message.updated", onMessageUpdated);
      channel.unbind("conversation.call.updated", onCallUpdated);
      channel.unbind("conversation.note.changed", onQuickNoteChanged);
      channel.unbind("airi.suggestion", onAiriSuggestion);
      channel.unbind("airi.typing", handleAiriTyping);
      channel.unbind("airi.suppressed", onAiriSuppressed);
      channel.unbind("airi.handoff", onAiriHandoff);

      clearTypingTimer();
    };
  }, [channel, clearTypingTimer, conversationId, handleMessageUpdated, mutate]);

  // Position the first message-bearing frame once. The existing Conversation
  // owner follows later content sizing and lets the reader leave the bottom.
  useLayoutEffect(() => {
    if (messages.length === 0) {
      return;
    }
    const messageId = initialHighlightedMessageId || null;
    if (initialScrollTargetRef.current === messageId) {
      return;
    }
    const viewport = getScrollViewport();
    if (!viewport) return;
    const messageElement = messageId
      ? findMessageElement(viewport, messageId)
      : undefined;
    if (messageElement) {
      scrollContextRef.current?.stopScroll();
      setHighlightedMessageId(messageId);
      messageElement.scrollIntoView({ behavior: "instant", block: "center" });
    } else {
      // Stale/foreign message links also open at the latest message.
      setHighlightedMessageId(null);
      viewport.scrollTop = viewport.scrollHeight;
      // Keep the owner locked to the bottom it was just moved to.
      void scrollContextRef.current?.scrollToBottom("instant");
    }
    hasScrolledToBottomOnMount.current = true;
    lastMessageCountRef.current = messages.length;
    initialScrollTargetRef.current = messageId;
  }, [
    getScrollViewport,
    initialHighlightedMessageId,
    messages.length,
    setHighlightedMessageId,
  ]);

  const hasChatSurface =
    Boolean(details) && !isInitialLoading && !error && !planGateError;
  useLayoutEffect(() => {
    if (!hasChatSurface || typeof ResizeObserver === "undefined") return;
    const viewport = getScrollViewport();
    if (!viewport) return;
    let previousHeight = viewport.clientHeight;
    const observer = new ResizeObserver(() => {
      const height = viewport.clientHeight;
      if (height === previousHeight) return;
      previousHeight = height;
      const owner = scrollContextRef.current;
      if (!owner?.state.isAtBottom) return;
      // Composer banners, split panes and the mobile keyboard can change the
      // viewport without resizing its content. Preserve the owner's lock.
      viewport.scrollTop = viewport.scrollHeight;
      void owner.scrollToBottom("instant");
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [conversationId, getScrollViewport, hasChatSurface]);

  // Auto-scroll on new messages if user is at bottom
  useEffect(() => {
    if (!hasScrolledToBottomOnMount.current) return;

    if (isLoadingOldMessagesRef.current) {
      lastMessageCountRef.current = messages.length;
      return;
    }

    if (
      messages.length > 0 &&
      messages.length > lastMessageCountRef.current &&
      !isLoadingOldMessagesRef.current
    ) {
      lastMessageCountRef.current = messages.length;

      // Only auto-scroll if already at bottom
      if (isAtBottom()) {
        const timer = setTimeout(() => scrollToBottom("smooth"), 50);
        return () => clearTimeout(timer);
      }
    } else if (messages.length > 0) {
      lastMessageCountRef.current = messages.length;
    }
  }, [messages.length, scrollToBottom, isAtBottom]);

  // Infinite scroll: load more messages when scrolling to top
  useEffect(() => {
    const viewport = getScrollViewport();

    if (!viewport) {
      return;
    }

    let scrollTimeout: NodeJS.Timeout | null = null;
    const handleScroll = () => {
      // Debounce scroll events
      if (scrollTimeout) {
        clearTimeout(scrollTimeout);
      }

      scrollTimeout = setTimeout(() => {
        if (isAtTop() && pagination.has_more && !isLoadingMore) {
          loadMoreMessages();
        }
      }, 150);
    };

    viewport.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      viewport.removeEventListener("scroll", handleScroll);
      if (scrollTimeout) {
        clearTimeout(scrollTimeout);
      }
    };
  }, [
    getScrollViewport,
    isAtTop,
    pagination.has_more,
    isLoadingMore,
    loadMoreMessages,
  ]);

  const handleAddAttachments = useCallback(
    async (files: File[], options?: { isRetry?: boolean }) => {
      if (files.length === 0) return;

      const uploadConversationId = conversationId;
      const uploadMode = details?.channel === "whatsapp" ? "api" : "direct";
      const uploadFile =
        uploadMode === "api"
          ? uploadAttachmentThroughApi
          : uploadAttachmentDirectly;
      const startedAt = Date.now();

      // Recorder stop and image processing can finish after this composer left.
      if (!isMountedRef.current) return;

      setIsUploadingAttachments(true);
      try {
        const uploadResults = await Promise.allSettled(
          files.map(file => uploadFile(uploadConversationId, file))
        );

        // A slow upload must not act on a conversation the operator has left.
        if (!isMountedRef.current) {
          return;
        }

        // One pass splits the settled results into what to attach and what to
        // retry; each rejection keeps its source File so the composer can resend
        // the exact files that failed instead of discarding them.
        const uploadedAttachments: OutboundAttachment[] = [];
        const failedUploads: { file: File; reason: unknown }[] = [];
        uploadResults.forEach((result, index) => {
          if (result.status === "fulfilled") {
            uploadedAttachments.push({
              ...result.value,
              previewUrl: createLocalPreviewUrl(files[index]),
            });
          } else {
            failedUploads.push({ file: files[index], reason: result.reason });
          }
        });

        if (uploadedAttachments.length > 0) {
          setAttachments(prev => [...prev, ...uploadedAttachments]);
        }

        const hasFailures = failedUploads.length > 0;
        const timedOut = failedUploads.some(
          entry => entry.reason instanceof AttachmentUploadTimeoutError
        );
        // One sampled cause carries the route's HTTP status and reason so the
        // failure event has a cause breakdown, which today it lacks.
        const firstCause = failedUploads.find(
          entry => entry.reason instanceof AttachmentUploadError
        )?.reason as AttachmentUploadError | undefined;

        // Both events share these fields; load the memoized client once and
        // capture whichever apply.
        const baseUploadProps = {
          conversation_id: uploadConversationId,
          workspace_id: effectiveWorkspaceId,
          channel: details?.channel,
          upload_mode: uploadMode,
          file_count: files.length,
          failed_count: failedUploads.length,
          duration_ms: Date.now() - startedAt,
        };
        if (options?.isRetry || hasFailures) {
          void loadPostHogClient()
            .then(posthog => {
              if (options?.isRetry) {
                // Retry-outcome event: successful retries should replace
                // abandoned sends, the new number to watch.
                posthog?.capture("conversation_attachment_upload_retried", {
                  ...baseUploadProps,
                  succeeded: !hasFailures,
                });
              }
              if (hasFailures) {
                // Make the failure visible: today it fires zero events.
                posthog?.capture("conversation_attachment_upload_failed", {
                  ...baseUploadProps,
                  direction: "outbound",
                  timed_out: timedOut,
                  is_retry: Boolean(options?.isRetry),
                  http_status: firstCause?.status,
                  reason: firstCause?.reason,
                });
              }
            })
            .catch(() => {});
        }

        if (!hasFailures) {
          return;
        }

        // Propagate to the composer so it clears its pending state and shows an
        // error next to a real retry button, instead of a spinner that never
        // ends or inert "Try again." text.
        const message = failedUploads
          .map(entry =>
            entry.reason instanceof Error
              ? entry.reason.message
              : t("failedToUploadAttachment", {
                  default: "Failed to upload attachment",
                })
          )
          .join("\n");
        throw new AttachmentUploadBatchError(
          message,
          failedUploads.map(entry => entry.file)
        );
      } finally {
        setIsUploadingAttachments(false);
      }
    },
    [
      conversationId,
      details?.channel,
      effectiveWorkspaceId,
      setAttachments,
      setIsUploadingAttachments,
      t,
    ]
  );

  const handleRemoveAttachment = useCallback(
    (index: number) => {
      setAttachments(prev =>
        prev.filter((_, currentIndex) => currentIndex !== index)
      );
    },
    [setAttachments]
  );

  // Local previews are released once their attachment leaves the composer
  // (removed, sent, or the conversation changes) and when the view unmounts.
  const attachmentPreviewUrlsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const current = new Set(
      attachments.flatMap(attachment =>
        attachment.previewUrl ? [attachment.previewUrl] : []
      )
    );
    for (const url of attachmentPreviewUrlsRef.current) {
      if (!current.has(url)) revokeLocalPreviewUrl(url);
    }
    attachmentPreviewUrlsRef.current = current;
  }, [attachments]);
  useEffect(
    () => () => {
      for (const url of attachmentPreviewUrlsRef.current) {
        revokeLocalPreviewUrl(url);
      }
    },
    []
  );

  const onSubmitReply = async (data: { reply: string }) => {
    const trimmedReply = data.reply.trim();
    if (!trimmedReply && attachments.length === 0) return;

    const isAppliedSuggestion =
      Boolean(trimmedReply) && appliedSuggestionText.trim() === trimmedReply;

    if (trimmedReply && !isAppliedSuggestion) {
      const profanityCheck = checkProfanity("", trimmedReply);
      if (profanityCheck.toxic) {
        toast.error(t("profanityDetected"), {
          description: t("profanityDescription"),
        });
        return;
      }
    }

    let optimisticMessageId: string | null = null;
    const canRenderOptimisticMessage =
      attachments.length === 0 &&
      trimmedReply.length > 0 &&
      details?.channel !== "email";

    if (canRenderOptimisticMessage) {
      optimisticMessageId = `${OPTIMISTIC_OUTBOUND_PREFIX}${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 10)}`;

      const optimisticMessage = {
        _id: optimisticMessageId,
        author: {
          firstName: details?.handled_by_agent?.name || "Manager",
          isBot: false,
        },
        text: trimmedReply,
        date: new Date().toISOString(),
        direction: "outbound",
        ...(replyingToMessage
          ? {
              whatsappMeta: {
                replyToWhatsAppMessageId:
                  typeof replyingToMessage.messageId === "string"
                    ? replyingToMessage.messageId
                    : null,
                replyToTextPreview:
                  buildWhatsAppReplyTextPreview(replyingToMessage) ??
                  "Earlier message",
              },
            }
          : {}),
      } as unknown as PopulatedMessage;

      applyMessages(
        sortMessagesByDate([...messagesRef.current, optimisticMessage])
      );
      requestAnimationFrame(() => scrollToBottom("smooth"));
    }

    try {
      const res = await fetch(`/api/conversations/${conversationId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: trimmedReply,
          attachments: attachments.map(
            ({ previewUrl: _previewUrl, ...attachment }) => attachment
          ),
          isAppliedSuggestion: isAppliedSuggestion,
          replyToMessageId: replyingToMessage?._id?.toString(),
          ...(details?.channel === "instagram" ? { instagramReplyMode } : {}),
        }),
      });

      const payload = (await res.json().catch(() => null)) as {
        error?: string;
        code?: string;
        partial?: boolean;
        message?: PopulatedMessage;
      } | null;

      const persistedMessage = payload?.message;
      if (!res.ok) {
        // Instagram can deliver the text and then reject an attachment; the
        // delivered part is saved, so keep it in the thread with the error.
        if (payload?.partial && persistedMessage) {
          applyMessages(
            sortMessagesByDate([
              ...messagesRef.current.filter(
                message =>
                  message._id.toString() !== optimisticMessageId &&
                  message._id.toString() !== persistedMessage._id.toString()
              ),
              persistedMessage,
            ])
          );
        }
        const translationKey = payload?.code
          ? `instagramSendErrors.${payload.code}`
          : "";
        const msg =
          translationKey && t.has(translationKey)
            ? t(translationKey)
            : payload?.error || t("failedToSendReply");
        throw new Error(msg);
      }
      if (optimisticMessageId || persistedMessage) {
        let nextMessages = messagesRef.current;

        if (optimisticMessageId) {
          nextMessages = nextMessages.filter(
            message => message._id.toString() !== optimisticMessageId
          );
        }

        if (
          persistedMessage &&
          !nextMessages.some(
            message =>
              message._id.toString() === persistedMessage._id.toString()
          )
        ) {
          nextMessages = [...nextMessages, persistedMessage];
        }

        applyMessages(sortMessagesByDate(nextMessages));
      }

      const matchedCoachSuggestion = Boolean(
        coachTips &&
          [coachTips.suggestedEdit, coachTips.suggestedEditInCustomerLanguage]
            .filter((value): value is string => Boolean(value))
            .some(value => value.trim() === trimmedReply)
      );
      if (matchedCoachSuggestion && coachTips?.suggestionId) {
        void fetch("/api/airi/adopt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: effectiveWorkspaceId ?? "",
            suggestionId: coachTips.suggestionId,
          }),
        }).catch(() => {});
      }
      setCoachOpen(false);
      setCoachUserClosed(true);
      setCoachUnread(false);
      reset({ reply: "" });
      setAttachments([]);
      setReplyingToMessage(null);
      clearCoachSuggestion();
    } catch (error) {
      if (optimisticMessageId) {
        applyMessages(
          messagesRef.current.filter(
            message => message._id.toString() !== optimisticMessageId
          )
        );
      }
      const msg =
        error instanceof Error ? error.message : t("failedToSendReply");

      // Make the failure countable: today the project fires zero events for a
      // failed reply, so replay is the only way this class of block is seen.
      void loadPostHogClient()
        .then(posthog => {
          posthog?.capture("conversation_reply_send_failed", {
            conversation_id: conversationId,
            workspace_id: effectiveWorkspaceId,
            channel: details?.channel,
            has_attachments: attachments.length > 0,
            error_message: msg.slice(0, 300),
          });
        })
        .catch(() => {});

      // A late failure never pops up on a conversation the operator has since
      // opened, and the stable id makes repeated failures replace, not stack.
      if (isMountedRef.current) {
        toast.error(t("failedToSendReply"), {
          id: `conversation-reply-send-failed-${conversationId}`,
          description: msg,
        });
      }
    }
  };

  const handleApplySuggestedEdit = useCallback(
    (text: string, suggestionId?: string) => {
      setValue("reply", text, {
        shouldDirty: true,
        shouldTouch: true,
      });
      setAppliedSuggestionText(text);
      setReplyingToMessage(null);
      setCoachTips(null);
      setAiriIsTyping(false);
      requestAnimationFrame(() => textareaRef.current?.focus());

      toast.success(t("suggestionApplied"), { duration: 2000 });

      fetch("/api/airi/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "applied",
          conversationId,
          suggestionId,
          appliedText: text.slice(0, 100),
        }),
      }).catch(() => {});

      setCoachOpen(false);
      setCoachUserClosed(true);
      setCoachUnread(false);
    },
    [
      conversationId,
      setAiriIsTyping,
      setCoachOpen,
      setCoachUnread,
      setCoachUserClosed,
      setValue,
      t,
    ]
  );

  const handleDismissCoachSuggestion = useCallback(
    (suggestionId?: string) => {
      clearCoachSuggestion();
      setCoachUnread(false);
      fetch("/api/airi/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "dismissed",
          conversationId,
          suggestionId,
        }),
      }).catch(() => {});
    },
    [clearCoachSuggestion, conversationId, setCoachUnread]
  );

  const handleCoachFeedback = useCallback(
    async (feedback: "helpful" | "not_helpful", suggestionId: string) => {
      try {
        await fetch("/api/airi/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            suggestionId,
            conversationId,
            feedback,
            tipType: coachTips?.tips?.[0]?.type || "unknown",
          }),
        });
        if (!isMountedRef.current) return;

        toast.success(
          feedback === "helpful" ? t("feedbackThanks") : t("feedbackSorry"),
          { duration: 2000 }
        );
      } catch {
        if (isMountedRef.current) toast.error(t("failedToSubmitFeedback"));
      }
    },
    [coachTips, conversationId, t]
  );

  const handleMomentClick = (messageId: string) => {
    const viewport = getScrollViewport();
    const messageElement = viewport
      ? findMessageElement(viewport, messageId)
      : undefined;

    if (messageElement) {
      messageElement.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlightedMessageId(messageId);
      return true;
    }
    return false;
  };

  useEffect(() => {
    if (highlightedMessageId) {
      const timer = setTimeout(() => {
        setHighlightedMessageId(null);
      }, 2000);

      return () => clearTimeout(timer);
    }
    return undefined;
  }, [highlightedMessageId, setHighlightedMessageId]);

  if (isInitialLoading) {
    return (
      <ConversationSelectionPreview
        request={requestPreview}
        onBack={onBack}
      />
    );
  }

  if (planGateError) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4 md:p-6">
        <Alert className="my-auto max-w-xl shrink-0 self-center border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-50">
          <LockKeyhole className="size-4" />
          <AlertTitle>{t("conversationPlanBlockedTitle")}</AlertTitle>
          <AlertDescription>
            <p>
              {planGateError.planGate.reason === "trial_expired"
                ? t("conversationPlanBlockedTrialDescription")
                : t("conversationPlanBlockedDescription", {
                    hiddenCount: planGateError.planGate.hiddenCount,
                  })}
            </p>
            {onBack ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={onBack}
              >
                {t("conversationPlanBlockedBack")}
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (error || !details) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {onBack && (
          <div className="shrink-0 border-b px-1 py-1.5 md:px-3 md:py-2.5">
            <ConversationBackButton onBack={onBack} />
          </div>
        )}
        <div
          role={error ? "alert" : "status"}
          className={cn(
            "min-h-0 overflow-y-auto break-words p-4",
            error && "text-destructive"
          )}
        >
          {error ? (
            <>
              {t("error")} {error}
            </>
          ) : (
            t("noData")
          )}
        </div>
      </div>
    );
  }

  const isConversationResolved = details.status === "closed";
  const isInstagramCommentThread =
    details.channel === "instagram" &&
    details.external_thread?.type === "comment";
  const isGroupLikeChat =
    isGroupLikeChatType(details.chat?.type) ||
    isWhatsAppGroupConversation(details);
  const isComposerDisabled = isReplyComposerDisabled({
    isConversationResolved,
    channel: details.channel,
    requiresWindowCheck: requiresWindowStatus,
    isWithinWindow: windowInfo?.isWithinWindow,
    humanAgent,
    accountCannotSend: Boolean(whatsappSendBlockingReason),
  });

  // Get Airi settings from details
  const initialBotEnabled =
    details.airi_bot_enabled ?? details.airi_enabled ?? false;
  const initialScenariosEnabled = resolveConversationScenariosEnabled(
    details,
    initialBotEnabled
  );
  const initialCoachEnabled = getAiriCoachEnabledFromDetails(details);

  const conversationStatus = details.status;
  const handoffStartedAt =
    details.airi_handoff_started_at &&
    !Number.isNaN(new Date(details.airi_handoff_started_at).getTime())
      ? new Date(details.airi_handoff_started_at)
      : null;
  const handoff = details.airi_handoff_active
    ? { startedAt: handoffStartedAt }
    : null;
  const isScenarioHandoffSuppressed =
    airiSuppressed?.reason === "scenario_handoff";
  const showSuppressedBanner = Boolean(
    airiSuppressed && !isScenarioHandoffSuppressed
  );
  const suppressedDate =
    airiSuppressed?.suppressedAt &&
    !Number.isNaN(new Date(airiSuppressed.suppressedAt).getTime())
      ? new Date(airiSuppressed.suppressedAt)
      : null;
  const suppressedReasonText =
    airiSuppressed?.reason === "tagged_manager_message"
      ? t("airiSuppressedTaggedManager")
      : airiSuppressed?.reason === "manager_recently_replied"
        ? t("airiSuppressedRecentManager")
        : "";

  const conversationTitle = getConversationTitle(details, {
    customer: t("unnamedCustomer"),
    group: t("unnamedGroup"),
  });
  const totalMessages = Math.max(
    pagination.total ?? details.message_count ?? 0,
    messages.length
  );
  const conversationSubtitle = t("messageCountLabel", {
    count: totalMessages,
  });
  const supportsAttachmentDrop =
    details.channel === "whatsapp" ||
    details.channel === "telegram" ||
    (details.channel === "instagram" && !isInstagramCommentThread);
  const canDropAttachments =
    supportsAttachmentDrop &&
    !isComposerDisabled &&
    !isUploadingAttachments &&
    !isSubmitting;

  const applyDropEffect = (event: DragEvent<HTMLDivElement>) => {
    event.dataTransfer.dropEffect = canDropAttachments ? "copy" : "none";
  };

  const handlePanelDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    applyDropEffect(event);
    setFileDragDepth(depth => depth + 1);
  };

  const handlePanelDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    applyDropEffect(event);
  };

  const handlePanelDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setFileDragDepth(depth => Math.max(0, depth - 1));
  };

  const handlePanelDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setFileDragDepth(0);

    if (!canDropAttachments) {
      toast.error(t("dropUnavailable"));
      return;
    }

    const files = getDroppedFiles(event.dataTransfer);
    if (files.length > 0) {
      // The composer surfaces upload errors for its own inputs; the drop zone
      // has no such path, so report failures here.
      void handleAddAttachments(files).catch(error => {
        if (!isMountedRef.current) return;
        toast.error(t("failedToUploadAttachment"), {
          description: error instanceof Error ? error.message : undefined,
        });
      });
    }
  };

  const coachPanelToggleLabel = "Open coach panel";

  const coachPanel = (
    <AiriCoachPanel
      coachTips={coachTips}
      showTypingIndicator={showTypingIndicator}
      onApplySuggestedEdit={handleApplySuggestedEdit}
      onDismiss={handleDismissCoachSuggestion}
      onFeedback={handleCoachFeedback}
      onClose={closeCoachPanel}
    />
  );

  const chatSurface = (
    <div
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="conversation-chat-surface"
    >
      <div className="min-h-0 min-w-0 flex-1 select-text">
        <Conversation
          className="h-full min-h-0"
          contextRef={scrollContextRef}
          initial={initialHighlightedMessageId ? false : "instant"}
          resize="instant"
        >
          <ConversationContent
            className="space-y-3 px-2 py-3 md:px-4 md:py-4 md:pb-6"
            scrollClassName="conversation-scroll-viewport"
          >
            {pagination.has_more && (
              <div className="mb-4 text-center">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={loadMoreMessages}
                  disabled={isLoadingMore}
                >
                  {isLoadingMore ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    t("loadPrevious")
                  )}
                </Button>
              </div>
            )}
            <WhatsAppCallBanner
              callSessions={details.whatsapp_call_sessions}
              onCallCommand={handleCallCommand}
              onCallMediaJoin={handleCallMediaJoin}
            />
            {messages.length > 0 && (
              <ConversationThread
                conversationId={conversationId}
                workspaceId={effectiveWorkspaceId}
                messages={messages}
                channel={details.channel}
                highlightedMessageId={highlightedMessageId}
                searchQuery={searchQuery}
                showInboundAuthorNames={
                  isInstagramCommentThread || isGroupLikeChat
                }
                isInstagramCommentThread={isInstagramCommentThread}
                onReplyTargetSelect={setReplyingToMessage}
                onMessageTextUpdated={handleMessageTextUpdated}
              />
            )}
          </ConversationContent>
          <ConversationScrollButton
            className="size-[44px] md:size-8"
            aria-label={t("scrollToLatestMessage")}
          />
        </Conversation>
      </div>

      <div className="relative z-10 min-w-0 shrink-0 flex flex-col border-t border-border/70 bg-background pb-[env(safe-area-inset-bottom)] md:pb-0">
        {whatsappSendBlockingReason && (
          <div className="border-b border-border/70 bg-background px-4 py-2">
            <Alert
              variant="destructive"
              className="flex items-start gap-3 border-0 bg-transparent p-0"
            >
              <AlertTriangle className="shrink-0" />
              <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <div className="min-w-0">
                  <AlertTitle>{whatsappSendBlockingReason.title}</AlertTitle>
                  <AlertDescription className="break-words">
                    {whatsappSendBlockingReason.message}
                  </AlertDescription>
                </div>
                {effectiveWorkspaceId && (
                  <Button asChild size="sm" className="shrink-0">
                    <Link
                      href={`/panel/w/${effectiveWorkspaceId}/settings/integrations?type=whatsapp`}
                    >
                      {t("whatsappAccountBlockedCta")}
                      <ArrowRight className="size-3.5" />
                    </Link>
                  </Button>
                )}
              </div>
            </Alert>
          </div>
        )}
        {requiresWindowStatus && (windowInfo || isLoadingWindowStatus) && (
          <MetaWindowStatus
            conversationId={conversationId}
            windowInfo={windowInfo}
            channel={details.channel as "whatsapp" | "instagram"}
            humanAgent={humanAgent}
            isLoading={isLoadingWindowStatus}
          />
        )}

        <div className="mb-0 p-2 md:px-4 md:py-2.5">
          <ReplyForm
            onSubmitReply={onSubmitReply}
            control={control}
            handleSubmit={handleSubmit}
            register={register}
            isSubmitting={isSubmitting}
            isUploadingAttachments={isUploadingAttachments}
            disabled={isComposerDisabled}
            channel={details.channel}
            attachments={attachments}
            onAddAttachments={handleAddAttachments}
            onRemoveAttachment={handleRemoveAttachment}
            textareaRef={textareaRef}
            onTextChange={onTextChange}
            replyingToMessage={replyingToMessage}
            onClearReplyTo={() => setReplyingToMessage(null)}
            isInstagramCommentThread={isInstagramCommentThread}
            instagramReplyMode={instagramReplyMode}
            onInstagramReplyModeChange={setInstagramReplyMode}
          />
        </div>
      </div>
    </div>
  );

  return (
    <div
      className="relative flex flex-col flex-1 h-full min-h-0 min-w-0 overflow-hidden"
      onDragEnter={handlePanelDragEnter}
      onDragOver={handlePanelDragOver}
      onDragLeave={handlePanelDragLeave}
      onDrop={handlePanelDrop}
    >
      {isFileDragActive && (
        <div
          className={cn(
            "pointer-events-none absolute inset-0 z-50 flex items-center justify-center border-2 border-dashed bg-background/90 px-6 text-center backdrop-blur-[2px] transition-colors",
            canDropAttachments
              ? "border-primary/70 text-primary"
              : "border-destructive/60 text-destructive"
          )}
        >
          <div className="flex max-w-sm flex-col items-center gap-3">
            <span
              className={cn(
                "flex h-14 w-14 items-center justify-center rounded-full border",
                canDropAttachments
                  ? "border-primary/30 bg-primary/10"
                  : "border-destructive/30 bg-destructive/10"
              )}
            >
              <UploadCloud className="h-7 w-7" />
            </span>
            <div className="space-y-1">
              <p className="text-2xl font-semibold leading-tight">
                {canDropAttachments ? t("dropFilesHere") : t("dropUnavailable")}
              </p>
              {canDropAttachments && (
                <p className="text-sm text-muted-foreground">
                  {t("dropFilesToAttach")}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
      <div className="flex min-w-0 shrink-0 items-center gap-1 px-1 py-1.5 border-b md:gap-2 md:px-3 md:py-2.5">
        <ConversationBackButton onBack={onBack} />

        <div className="min-w-0 flex-1">
          <ConversationHeader
            avatarUrl={details.user?.avatar_url}
            conversationId={conversationId}
            mutate={mutate}
            onCoachToggle={setAiriCoachEnabled}
            airiBotEnabled={initialBotEnabled}
            airiScenariosEnabled={initialScenariosEnabled}
            airiCoachEnabled={initialCoachEnabled}
            conversationStatus={conversationStatus}
            conversationChannel={details.channel}
            onOpenInfo={() => setShowInfoDialog(true)}
            actions={
              !isMobileView && effectiveWorkspaceId ? (
                <ConversationSales
                  conversationId={conversationId}
                  workspaceId={effectiveWorkspaceId}
                  onViewMessage={handleMomentClick}
                />
              ) : undefined
            }
            renderInfo={controls => (
              <ConversationInfoSheet
                open={showInfoDialog}
                onOpenChange={setShowInfoDialog}
                details={fullConversationData ?? details}
                isLoading={isFullConversationLoading}
                hasError={Boolean(fullConversationError)}
                onRetry={() => {
                  void refreshFullConversation();
                }}
                conversationId={conversationId}
                messages={fullConversationData?.messages ?? messages}
                messageTotal={Math.max(
                  fullConversationData?.message_pagination?.total ?? 0,
                  totalMessages
                )}
                onMomentClick={id => {
                  setShowInfoDialog(false);
                  handleMomentClick(id);
                }}
                actions={
                  <>
                    {controls}
                    {isMobileView && effectiveWorkspaceId && (
                      <ConversationSales
                        presentation="info"
                        conversationId={conversationId}
                        workspaceId={effectiveWorkspaceId}
                        onViewMessage={id => {
                          setShowInfoDialog(false);
                          return handleMomentClick(id);
                        }}
                      />
                    )}
                  </>
                }
              />
            )}
            conversationTitle={conversationTitle}
            conversationSubtitle={conversationSubtitle}
            handoff={handoff}
            whatsappReferral={details.whatsappReferral ?? null}
            quickNote={details.quick_note ?? null}
            onQuickNoteChange={handleQuickNoteChange}
            whatsappIdentity={
              details.channel === "whatsapp" && details.chat?.whatsapp
                ? {
                    waId: details.chat.whatsapp.waId ?? null,
                    previousWaIds: Array.isArray(
                      details.chat.whatsapp.previousWaIds
                    )
                      ? details.chat.whatsapp.previousWaIds
                      : null,
                  }
                : null
            }
            suppressedTooltipContent={
              showSuppressedBanner ? (
                <div className="space-y-0.5 text-left">
                  <p className="font-medium">{t("airiSuppressedTitle")}</p>
                  <p>{suppressedReasonText}</p>
                  {suppressedDate && (
                    <p className="text-[11px] opacity-90">
                      {t("airiSuppressedAt", {
                        time: suppressedDate.toLocaleString(),
                      })}
                    </p>
                  )}
                </div>
              ) : undefined
            }
          />
        </div>
        {airiCoachEnabled && !coachOpen ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="relative h-8 w-8 shrink-0 rounded-full"
            aria-label={coachPanelToggleLabel}
            title={coachPanelToggleLabel}
            onClick={openCoachPanel}
          >
            <PanelRight className="h-4 w-4" />
            {coachUnread ? (
              <span
                className="absolute right-1 top-1 h-2 w-2 rounded-full bg-primary"
                aria-hidden
              />
            ) : null}
          </Button>
        ) : null}
      </div>

      {isMobileView ? (
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          {chatSurface}
          {coachOpen ? (
            <div className="absolute inset-y-0 right-0 z-40 w-full max-w-sm border-l bg-background shadow-2xl">
              {coachPanel}
            </div>
          ) : null}
        </div>
      ) : (
        <ResizablePanelGroup
          direction="horizontal"
          className="min-h-0 flex-1 overflow-hidden"
        >
          <ResizablePanel
            defaultSize={coachOpen ? 68 : 100}
            minSize={38}
            className="min-h-0 min-w-0 overflow-hidden"
          >
            {chatSurface}
          </ResizablePanel>
          {coachOpen ? (
            <>
              <ResizableHandle
                withHandle
                className="bg-transparent after:w-2 hover:bg-muted/70"
              />
              <ResizablePanel
                defaultSize={32}
                minSize={26}
                maxSize={46}
                className="min-h-0 min-w-[280px] max-w-[560px] overflow-hidden"
              >
                {coachPanel}
              </ResizablePanel>
            </>
          ) : null}
        </ResizablePanelGroup>
      )}
    </div>
  );
}
