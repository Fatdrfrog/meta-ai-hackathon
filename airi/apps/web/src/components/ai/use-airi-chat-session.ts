"use client";

import type { ActiveAiriBuilderInput } from "@/lib/airi-chats/builder-state";
import {
  retainTerminalAiriChatRunEvents,
  type AiriChatRunEvent,
  type AiriChatRunLifecycleStatus,
} from "@/lib/airi-chats/run-events";
import type { AiriChatSourceRef } from "@/lib/airi-chats/source-types";
import { useOptionalAuth } from "@/lib/auth/auth-context";
import { useTranslations } from "next-intl";
import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import useSWR, { SWRConfig, unstable_serialize, useSWRConfig } from "swr";
import { readAiriChatEventStream } from "./airi-chat-event-stream";

/**
 * Airi chat session state shared by the drawer and the /airi page: the chat
 * list, each chat's loaded message pages and the run this view is attached
 * to.
 *
 * - Threads and message pages live in one SWR cache shared by every mount
 *   (AiriChatSessionScope), so reopening the drawer or returning to a chat
 *   shows what was loaded at once and then revalidates.
 * - Runs are durable on the server (lib/airi-chats/turn/run.ts): closing the
 *   drawer or leaving the page only detaches this client's stream. The run
 *   goes on, and a chat whose run is still active resumes its stream when it
 *   is opened again. Only Stop cancels a run.
 */

export type AiriChatThread = {
  id: string;
  title: string;
  source: string;
  pinnedAt?: string | null;
  updatedAt: string;
};

export type AiriChatMessage = {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
};

/** GET thread/messages: the chat's run still answering, if any. */
export type AiriChatActiveRunSummary = {
  runId: string;
  status: AiriChatRunLifecycleStatus;
  startedAt: string;
};

/** The loaded messages of one chat (oldest first) and what is left to load. */
export type AiriChatMessagePage = {
  messages: AiriChatMessage[];
  /** Older messages exist before the first loaded one. */
  hasMore: boolean;
  activeRun: AiriChatActiveRunSummary | null;
};

export type AiriChatAttachmentPayload = {
  name: string;
  type?: string;
  size: number;
  lastModified?: number;
  textExcerpt?: string;
  truncated?: boolean;
  creativeAssetId?: string;
};

/** What the workspace hands the session for one turn. */
export type AiriChatTurnInput = {
  content: string;
  selectedSources: AiriChatSourceRef[];
  optimisticMetadata: Record<string, unknown> | null;
  prepareAttachments: () => Promise<AiriChatAttachmentPayload[]>;
};

/** Workspace behavior the session calls back into during a turn. */
export type AiriChatSessionCallbacks = {
  /** A turn starts (the onboarding quick actions and mobile view react). */
  onTurnStart: () => void;
  /** The open builder, sent with a selected chat's turn. */
  getActiveBuilder: () => ActiveAiriBuilderInput | undefined;
  /** An assistant message arrived (it can carry a builder patch). */
  onAssistantMessage: (metadata: AiriChatMessage["metadata"]) => void;
};

/**
 * Streamed answer text (server contract): `text` is the whole answer so far,
 * not an increment, so a provider fallback simply sends a shorter text. The
 * final assistant_message replaces it.
 */
type AiriChatAssistantDeltaEvent = {
  type: "assistant_delta";
  threadId: string;
  text: string;
};

type AiriChatStreamEvent = AiriChatRunEvent | AiriChatAssistantDeltaEvent;

export type AiriStreamingAnswer = { threadId: string; text: string };

/** At most one streamed-text render per interval while an answer streams. */
const AIRI_STREAMING_ANSWER_RENDER_INTERVAL_MS = 80;

/**
 * A new chat's generated title is written after its stream closes, so the
 * chat list is read once more this long after the turn ends.
 */
export const AIRI_NEW_THREAD_TITLE_REFRESH_DELAY_MS = 6000;

/** The chat list and a chat's history give up after this long. */
const AIRI_CHAT_LOAD_TIMEOUT_MS = 10_000;

/** Messages per page; the server's default page size. */
export const AIRI_CHAT_MESSAGE_PAGE_SIZE = 50;

const DRAFT_THREAD_ID = "draft";
const NO_THREADS: AiriChatThread[] = [];
const NO_MESSAGES: AiriChatMessage[] = [];

export function resolveStateAction<T>(
  current: T,
  action: SetStateAction<T>
): T {
  return typeof action === "function"
    ? (action as (current: T) => T)(current)
    : action;
}

export async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

export function sortThreads(threads: AiriChatThread[]): AiriChatThread[] {
  return threads.toSorted((a, b) => {
    const aPinned = a.pinnedAt ? new Date(a.pinnedAt).getTime() : 0;
    const bPinned = b.pinnedAt ? new Date(b.pinnedAt).getTime() : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

function readAssistantDelta(
  event: AiriChatStreamEvent
): AiriStreamingAnswer | null {
  if (event.type !== "assistant_delta") return null;
  const { threadId, text } = event as Partial<AiriChatAssistantDeltaEvent>;
  return typeof threadId === "string" && typeof text === "string"
    ? { threadId, text }
    : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** A v4 uuid for the turn's idempotency key (the server checks the format). */
export function createAiriClientTurnId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

// ---------------------------------------------------------------------------
// Shared cache

let airiChatSessionCache = new Map();
/**
 * The signed-in user the shared cache belongs to. Chats are per user, and a
 * sign-out and sign-in in the same tab keep this module loaded.
 */
let airiChatSessionOwner: string | null = null;

/**
 * A chat whose run was still answering when its view went away (the drawer
 * closed, the page was left), per workspace. The next mount opens that chat,
 * so the user sees the answer, or its progress, when they come back.
 */
const pendingRunThreads = new Map<
  string,
  { threadId: string; runId: string }
>();

/** Tests: start from an empty cache. */
export function resetAiriChatSessionCache() {
  airiChatSessionCache = new Map();
  airiChatSessionOwner = null;
  pendingRunThreads.clear();
}

/**
 * Hands the shared cache to `owner`, emptying it when it belonged to another
 * user. Idempotent, so it is safe in render: the scope must claim the cache
 * before its children read it on mount.
 */
function claimAiriChatSessionCache(owner: string) {
  if (owner === airiChatSessionOwner) return;
  airiChatSessionCache = new Map();
  pendingRunThreads.clear();
  airiChatSessionOwner = owner;
}

const AIRI_CHAT_SWR_OPTIONS = {
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  shouldRetryOnError: false,
  dedupingInterval: 0,
};

const AIRI_CHAT_SWR_CONFIG = {
  ...AIRI_CHAT_SWR_OPTIONS,
  provider: () => airiChatSessionCache,
};

/**
 * The Airi chat cache, shared by every workspace mount in this tab, for one
 * signed-in user. Another user empties it first; while no user is known
 * (signing in or out) the view gets a cache of its own that is never shared.
 * Without an auth context (tests, isolated renders) the cache is shared.
 */
export function AiriChatSessionScope({ children }: { children: ReactNode }) {
  const auth = useOptionalAuth();
  const owner =
    auth === undefined
      ? undefined
      : auth.loading
        ? null
        : auth.user?.id || null;
  if (owner) claimAiriChatSessionCache(owner);
  const isolatedConfig = useMemo(() => {
    const cache = new Map();
    return { ...AIRI_CHAT_SWR_OPTIONS, provider: () => cache };
  }, []);
  return createElement(
    SWRConfig,
    {
      // A new owner mounts a new provider (SWR reads it once per mount).
      key: owner === undefined ? "shared" : (owner ?? "no-user"),
      value: owner === null ? isolatedConfig : AIRI_CHAT_SWR_CONFIG,
    },
    children
  );
}

function threadsKey(workspaceId: string) {
  return ["airi-chat/threads", workspaceId] as const;
}

function messagesKey(workspaceId: string, threadId: string) {
  return ["airi-chat/messages", workspaceId, threadId] as const;
}

async function fetchWithTimeout<T>(
  url: string,
  timeoutMessage: string
): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    AIRI_CHAT_LOAD_TIMEOUT_MS
  );
  try {
    return await readJson<T>(
      await fetch(url, { cache: "no-store", signal: controller.signal })
    );
  } catch (error) {
    if (isAbortError(error)) throw new Error(timeoutMessage);
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function loadThreadList(workspaceId: string) {
  try {
    const payload = await fetchWithTimeout<{ threads?: AiriChatThread[] }>(
      `/api/workspaces/${workspaceId}/airi-chats`,
      "Chats are taking too long to load. Try again."
    );
    return sortThreads(payload.threads || []);
  } catch (error) {
    throw error instanceof Error ? error : new Error("Failed to load chats");
  }
}

function normalizeActiveRun(value: unknown): AiriChatActiveRunSummary | null {
  if (!value || typeof value !== "object") return null;
  const run = value as Partial<AiriChatActiveRunSummary>;
  return typeof run.runId === "string" && typeof run.status === "string"
    ? {
        runId: run.runId,
        status: run.status,
        startedAt: typeof run.startedAt === "string" ? run.startedAt : "",
      }
    : null;
}

export function toAiriChatMessagePage(payload: {
  messages?: AiriChatMessage[];
  hasMore?: unknown;
  activeRun?: unknown;
}): AiriChatMessagePage {
  return {
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    hasMore: payload.hasMore === true,
    activeRun: normalizeActiveRun(payload.activeRun),
  };
}

/** The newest page, or the page before `before` (GET ?before=&limit=). */
async function loadMessagePage(
  workspaceId: string,
  threadId: string,
  before?: string
): Promise<AiriChatMessagePage> {
  const url = before
    ? `/api/workspaces/${workspaceId}/airi-chats/${threadId}/messages?${new URLSearchParams(
        { before, limit: String(AIRI_CHAT_MESSAGE_PAGE_SIZE) }
      ).toString()}`
    : `/api/workspaces/${workspaceId}/airi-chats/${threadId}/messages`;
  try {
    return toAiriChatMessagePage(
      await fetchWithTimeout<{
        messages?: AiriChatMessage[];
        hasMore?: unknown;
        activeRun?: unknown;
      }>(url, "Messages are taking too long to load. Try again.")
    );
  } catch (error) {
    throw error instanceof Error ? error : new Error("Failed to load messages");
  }
}

/**
 * A fresh newest page keeps the older pages loaded before it ("Load
 * earlier"), when it still connects to them.
 */
export function mergeAiriChatNewestPage(
  current: AiriChatMessagePage | undefined,
  page: AiriChatMessagePage
): AiriChatMessagePage {
  if (!current || page.messages.length === 0) return page;
  const firstId = page.messages[0].id;
  const index = current.messages.findIndex(message => message.id === firstId);
  if (index <= 0) return page;
  return {
    ...page,
    messages: [...current.messages.slice(0, index), ...page.messages],
    hasMore: current.hasMore,
  };
}

/** Adds or replaces a message by id, keeping the list's order. */
function upsertMessage(
  messages: AiriChatMessage[],
  message: AiriChatMessage
): AiriChatMessage[] {
  const index = messages.findIndex(current => current.id === message.id);
  if (index < 0) return [...messages, message];
  const next = messages.slice();
  next[index] = message;
  return next;
}

// ---------------------------------------------------------------------------
// Runs

type RunAttachment = {
  controller: AbortController;
  /** The chat the run writes to; null while a new chat has no id yet. */
  threadId: string | null;
  /** Set by the run's first event. */
  runId: string | null;
  optimisticId: string | null;
  isNewChat: boolean;
  /** The view went away (drawer closed, workspace left): ignore everything. */
  detached: boolean;
  stopRequested: boolean;
  userMessagePersisted: boolean;
  assistantMessageReceived: boolean;
  finalStatus: Exclude<AiriChatRunLifecycleStatus, "running"> | null;
  queueStreamingAnswer: (answer: AiriStreamingAnswer) => void;
  clearStreamingAnswer: () => void;
  dropStreamingTimer: () => void;
};

type RunView = {
  threadId: string | null;
  runId: string | null;
  stopping: boolean;
};

type EarlierMessagesState = {
  threadId: string;
  status: "loading" | "failed";
};

type ErrorState = { threadId: string | null; message: string | null };

export type UseAiriChatSessionParams = {
  workspaceId: string;
  initialSource: "manual" | "onboarding" | "global";
  callbacksRef: RefObject<AiriChatSessionCallbacks>;
};

export function useAiriChatSession({
  workspaceId,
  initialSource,
  callbacksRef,
}: UseAiriChatSessionParams) {
  const chatT = useTranslations("AiriChat");
  const { cache, mutate: mutateCache } = useSWRConfig();

  // --- Chat list ----------------------------------------------------------
  const threadsQuery = useSWR(threadsKey(workspaceId), () =>
    loadThreadList(workspaceId)
  );
  const threads = threadsQuery.data ?? NO_THREADS;
  const isLoadingThreads =
    threadsQuery.data === undefined &&
    (threadsQuery.isValidating || threadsQuery.error === undefined);
  const threadsLoadError =
    threadsQuery.error && !threadsQuery.isValidating
      ? threadsQuery.error instanceof Error
        ? threadsQuery.error.message
        : "Failed to load chats"
      : null;
  const mutateThreads = threadsQuery.mutate;
  const setThreads = useCallback(
    (action: SetStateAction<AiriChatThread[]>) => {
      void mutateThreads(
        current => resolveStateAction(current ?? NO_THREADS, action),
        { revalidate: false }
      );
    },
    [mutateThreads]
  );
  const retryThreadsLoad = useCallback(() => {
    void mutateThreads();
  }, [mutateThreads]);
  const upsertThread = useCallback(
    (thread: AiriChatThread) =>
      setThreads(current =>
        sortThreads([thread, ...current.filter(item => item.id !== thread.id)])
      ),
    [setThreads]
  );

  // --- Selection ----------------------------------------------------------
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(
    () => pendingRunThreads.get(workspaceId)?.threadId ?? null
  );
  const selectedThreadIdRef = useRef(selectedThreadId);
  selectedThreadIdRef.current = selectedThreadId;

  // --- Errors (each belongs to the chat it happened in) -------------------
  const [errorState, setErrorState] = useState<ErrorState>({
    threadId: null,
    message: null,
  });
  const setErrorFor = useCallback(
    (threadId: string | null, action: SetStateAction<string | null>) => {
      setErrorState(current => ({
        threadId,
        message: resolveStateAction(
          current.threadId === threadId ? current.message : null,
          action
        ),
      }));
    },
    []
  );
  const setError = useCallback(
    (action: SetStateAction<string | null>) =>
      setErrorFor(selectedThreadIdRef.current, action),
    [setErrorFor]
  );
  const error =
    errorState.threadId === selectedThreadId ? errorState.message : null;

  // --- Runs ---------------------------------------------------------------
  const [runView, setRunView] = useState<RunView | null>(null);
  const [liveRunEvents, setLiveRunEvents] = useState<AiriChatRunEvent[]>([]);
  const [streamingAnswer, setStreamingAnswer] =
    useState<AiriStreamingAnswer | null>(null);
  const attachmentRef = useRef<RunAttachment | null>(null);
  const resumedRunIdsRef = useRef(new Set<string>());
  const isSending = runView !== null;
  const detachContextRef = useRef({ cache, workspaceId });
  detachContextRef.current = { cache, workspaceId };
  useEffect(
    () => () => {
      // Leaving only detaches this view; the run goes on on the server.
      const attachment = attachmentRef.current;
      if (attachment) {
        attachment.detached = true;
        attachment.dropStreamingTimer();
        attachment.controller.abort();
        // The question not yet saved leaves the shared cache: the next
        // mount reads the chat (and the saved question) from the server.
        // The cache is written directly: the scope may already be gone, and
        // nothing on screen reads it any more.
        const { threadId, optimisticId } = attachment;
        if (threadId && optimisticId && !attachment.userMessagePersisted) {
          const context = detachContextRef.current;
          const key = unstable_serialize(
            messagesKey(context.workspaceId, threadId)
          );
          const state = context.cache.get(key);
          const page = state?.data as AiriChatMessagePage | undefined;
          if (state && page) {
            context.cache.set(key, {
              ...state,
              data: {
                ...page,
                messages: page.messages.filter(
                  message => message.id !== optimisticId
                ),
              },
            });
          }
        }
      }
      attachmentRef.current = null;
    },
    []
  );

  // --- Messages -----------------------------------------------------------
  const [draftMessages, setDraftMessagesState] = useState<AiriChatMessage[]>(
    []
  );
  const draftMessagesRef = useRef<AiriChatMessage[]>([]);
  const setDraftMessages = useCallback(
    (action: SetStateAction<AiriChatMessage[]>) => {
      draftMessagesRef.current = resolveStateAction(
        draftMessagesRef.current,
        action
      );
      setDraftMessagesState(draftMessagesRef.current);
    },
    []
  );
  const selectedMessagesKey = selectedThreadId
    ? messagesKey(workspaceId, selectedThreadId)
    : null;
  const messagesQuery = useSWR(
    selectedMessagesKey,
    async (key: ReturnType<typeof messagesKey>) => {
      const page = await loadMessagePage(key[1], key[2]);
      const current = cache.get(unstable_serialize(key))?.data as
        | AiriChatMessagePage
        | undefined;
      return mergeAiriChatNewestPage(current, page);
    },
    {
      // A chat this view's run writes to is already on screen: a read of it
      // mid-run would race the streamed messages.
      revalidateIfStale: runView?.threadId !== selectedThreadId,
    }
  );
  const messagePage = selectedThreadId ? messagesQuery.data : undefined;
  const messages = selectedThreadId
    ? (messagePage?.messages ?? NO_MESSAGES)
    : draftMessages;
  const isLoadingMessages =
    Boolean(selectedThreadId) &&
    !messagePage &&
    (messagesQuery.isValidating || messagesQuery.error === undefined);
  const messagesLoadFailed =
    Boolean(selectedThreadId) &&
    !messagePage &&
    !messagesQuery.isValidating &&
    messagesQuery.error !== undefined;
  const messagesLoadError = messagesLoadFailed
    ? messagesQuery.error instanceof Error
      ? messagesQuery.error.message
      : "Failed to load messages"
    : null;
  // A selected chat takes no new turn until its history is on screen, so
  // the reply never lands under another thread's (or no) history.
  const sendBlocked = Boolean(selectedThreadId) && !messagePage;
  const mutateSelectedMessages = messagesQuery.mutate;
  const retryMessagesLoad = useCallback(() => {
    void mutateSelectedMessages();
  }, [mutateSelectedMessages]);

  const updateThreadMessages = useCallback(
    (
      threadId: string,
      update: (current: AiriChatMessage[]) => AiriChatMessage[]
    ) => {
      void mutateCache(
        messagesKey(workspaceId, threadId),
        (current?: AiriChatMessagePage) => ({
          messages: update(current?.messages ?? NO_MESSAGES),
          hasMore: current?.hasMore ?? false,
          activeRun: current?.activeRun ?? null,
        }),
        { revalidate: false }
      );
    },
    [mutateCache, workspaceId]
  );

  /** A fresh newest page for a chat (e.g. after a Meta Ads confirmation). */
  const replaceThreadMessages = useCallback(
    (threadId: string, page: AiriChatMessagePage) => {
      void mutateCache(
        messagesKey(workspaceId, threadId),
        (current?: AiriChatMessagePage) =>
          mergeAiriChatNewestPage(current, page),
        { revalidate: false }
      );
    },
    [mutateCache, workspaceId]
  );

  // --- Load earlier -------------------------------------------------------
  const [earlierMessages, setEarlierMessages] =
    useState<EarlierMessagesState | null>(null);
  const earlierStatus: "idle" | EarlierMessagesState["status"] =
    earlierMessages && earlierMessages.threadId === selectedThreadId
      ? earlierMessages.status
      : "idle";
  const hasEarlierMessages = Boolean(messagePage?.hasMore);
  const loadEarlierMessages = useCallback(async () => {
    const threadId = selectedThreadIdRef.current;
    if (!threadId) return;
    const key = messagesKey(workspaceId, threadId);
    const current = cache.get(unstable_serialize(key))?.data as
      | AiriChatMessagePage
      | undefined;
    const oldest = current?.messages[0];
    if (!current?.hasMore || !oldest) return;
    setEarlierMessages({ threadId, status: "loading" });
    try {
      const older = await loadMessagePage(workspaceId, threadId, oldest.id);
      void mutateCache(
        key,
        (latest?: AiriChatMessagePage) => {
          if (!latest) return latest;
          const loaded = new Set(latest.messages.map(message => message.id));
          return {
            ...latest,
            messages: [
              ...older.messages.filter(message => !loaded.has(message.id)),
              ...latest.messages,
            ],
            hasMore: older.hasMore,
          };
        },
        { revalidate: false }
      );
      setEarlierMessages(current =>
        current?.threadId === threadId ? null : current
      );
    } catch {
      setEarlierMessages(current =>
        current?.threadId === threadId
          ? { threadId, status: "failed" }
          : current
      );
    }
  }, [cache, mutateCache, workspaceId]);

  // --- Title refresh ------------------------------------------------------
  // One deferred chat-list read after a turn that created a chat, so its
  // generated title replaces the first-message fallback.
  const titleRefreshRef = useRef<{ threadId: string; timer: number } | null>(
    null
  );
  const cancelTitleRefresh = useCallback(() => {
    if (titleRefreshRef.current) {
      window.clearTimeout(titleRefreshRef.current.timer);
      titleRefreshRef.current = null;
    }
  }, []);
  const scheduleTitleRefresh = useCallback(
    (threadId: string) => {
      cancelTitleRefresh();
      const timer = window.setTimeout(() => {
        titleRefreshRef.current = null;
        // A background read: no loading state, no error, the open chat stays.
        void loadThreadList(workspaceId)
          .then(nextThreads => {
            const currentThreadId = selectedThreadIdRef.current;
            if (
              currentThreadId &&
              !nextThreads.some(thread => thread.id === currentThreadId)
            ) {
              return;
            }
            void mutateThreads(nextThreads, { revalidate: false });
          })
          .catch(() => undefined);
      }, AIRI_NEW_THREAD_TITLE_REFRESH_DELAY_MS);
      titleRefreshRef.current = { threadId, timer };
    },
    [cancelTitleRefresh, mutateThreads, workspaceId]
  );
  useEffect(() => {
    if (
      titleRefreshRef.current &&
      titleRefreshRef.current.threadId !== selectedThreadId
    ) {
      cancelTitleRefresh();
    }
  }, [cancelTitleRefresh, selectedThreadId]);
  useEffect(() => cancelTitleRefresh, [cancelTitleRefresh]);

  // --- Run plumbing -------------------------------------------------------
  const isCurrentAttachment = useCallback(
    (attachment: RunAttachment) =>
      attachmentRef.current === attachment && !attachment.detached,
    []
  );

  const createAttachment = useCallback(
    (params: {
      threadId: string | null;
      runId: string | null;
      isNewChat: boolean;
    }): RunAttachment => {
      // Streamed answer text renders at most every 80 ms (latest text wins)
      // until the final assistant_message replaces it.
      let pendingAnswer: AiriStreamingAnswer | null = null;
      let answerTimer: number | null = null;
      let lastAnswerRenderAt = 0;
      const attachment: RunAttachment = {
        controller: new AbortController(),
        threadId: params.threadId,
        runId: params.runId,
        optimisticId: null,
        isNewChat: params.isNewChat,
        detached: false,
        stopRequested: false,
        userMessagePersisted: false,
        assistantMessageReceived: false,
        finalStatus: null,
        queueStreamingAnswer: answer => {
          pendingAnswer = answer;
          if (answerTimer !== null) return;
          const wait =
            AIRI_STREAMING_ANSWER_RENDER_INTERVAL_MS -
            (Date.now() - lastAnswerRenderAt);
          if (wait <= 0) flushStreamingAnswer();
          else answerTimer = window.setTimeout(flushStreamingAnswer, wait);
        },
        clearStreamingAnswer: () => {
          attachment.dropStreamingTimer();
          setStreamingAnswer(null);
        },
        dropStreamingTimer: () => {
          if (answerTimer !== null) window.clearTimeout(answerTimer);
          answerTimer = null;
          pendingAnswer = null;
        },
      };
      const flushStreamingAnswer = () => {
        answerTimer = null;
        if (!pendingAnswer || !isCurrentAttachment(attachment)) return;
        lastAnswerRenderAt = Date.now();
        setStreamingAnswer(pendingAnswer);
        pendingAnswer = null;
      };
      return attachment;
    },
    [isCurrentAttachment]
  );

  /**
   * Writes the run's messages to its chat. A new chat's draft messages move
   * to the chat id the server gave it, and the view follows them there.
   */
  const commitRunMessages = useCallback(
    (
      attachment: RunAttachment,
      threadId: string,
      update: (current: AiriChatMessage[]) => AiriChatMessage[]
    ) => {
      const ownerThreadId = attachment.threadId;
      attachment.threadId = threadId;
      if (ownerThreadId === null) {
        const moved = update(draftMessagesRef.current);
        void mutateCache(
          messagesKey(workspaceId, threadId),
          (current?: AiriChatMessagePage) => ({
            messages: current
              ? moved.reduce(upsertMessage, current.messages)
              : moved,
            hasMore: current?.hasMore ?? false,
            activeRun: null,
          }),
          { revalidate: false }
        );
        setDraftMessages([]);
        setRunView(view => (view ? { ...view, threadId } : view));
        setSelectedThreadId(threadId);
        return;
      }
      updateThreadMessages(threadId, update);
    },
    [mutateCache, setDraftMessages, updateThreadMessages, workspaceId]
  );

  const removeOptimisticMessage = useCallback(
    (attachment: RunAttachment) => {
      const optimisticId = attachment.optimisticId;
      if (!optimisticId) return;
      const drop = (current: AiriChatMessage[]) =>
        current.filter(message => message.id !== optimisticId);
      if (attachment.threadId === null) setDraftMessages(drop);
      else updateThreadMessages(attachment.threadId, drop);
    },
    [setDraftMessages, updateThreadMessages]
  );

  const requestCancel = useCallback(
    async (attachment: RunAttachment) => {
      const { threadId, runId } = attachment;
      if (!threadId || !runId) return;
      try {
        const response = await fetch(
          `/api/workspaces/${workspaceId}/airi-chats/${threadId}/runs/${runId}/cancel`,
          { method: "POST" }
        );
        // 404: the run is gone; its stream ends on its own.
        if (!response.ok && response.status !== 404) {
          throw new Error(`Request failed: ${response.status}`);
        }
      } catch {
        if (!isCurrentAttachment(attachment)) return;
        attachment.stopRequested = false;
        setRunView(view => (view ? { ...view, stopping: false } : view));
        setErrorFor(threadId, chatT("stopFailed"));
      }
    },
    [chatT, isCurrentAttachment, setErrorFor, workspaceId]
  );

  const handleRunEvent = useCallback(
    (attachment: RunAttachment, event: AiriChatStreamEvent) => {
      if (!isCurrentAttachment(attachment)) return;
      if (event.type === "assistant_delta") {
        // Answer text so far, shown as it streams; not a progress step.
        const answer = readAssistantDelta(event);
        if (answer) attachment.queueStreamingAnswer(answer);
        return;
      }
      if (event.type === "run") {
        attachment.runId = event.runId;
        setRunView(view => (view ? { ...view, runId: event.runId } : view));
        if (attachment.threadId !== event.threadId) {
          commitRunMessages(attachment, event.threadId, current => current);
        }
        pendingRunThreads.set(workspaceId, {
          threadId: event.threadId,
          runId: event.runId,
        });
        // Stop pressed before the run had an id.
        if (attachment.stopRequested) void requestCancel(attachment);
        return;
      }
      setLiveRunEvents(current => [...current, event]);
      if (event.type === "thread") {
        commitRunMessages(attachment, event.thread.id, current => current);
        setSelectedThreadId(event.thread.id);
        upsertThread(event.thread);
      }
      if (event.type === "user_message") {
        attachment.userMessagePersisted = true;
        const optimisticId = attachment.optimisticId;
        commitRunMessages(attachment, event.message.threadId, current =>
          upsertMessage(
            current.filter(
              message =>
                message.id !== optimisticId &&
                // An attached run's question may still show as an unsaved
                // copy from the view that sent it.
                !(
                  optimisticId === null &&
                  message.role === "user" &&
                  message.id.startsWith("pending-") &&
                  message.content === event.message.content
                )
            ),
            event.message
          )
        );
      }
      if (event.type === "assistant_message") {
        attachment.assistantMessageReceived = true;
        attachment.clearStreamingAnswer();
        callbacksRef.current.onAssistantMessage(event.message.metadata);
        const optimisticId = attachment.optimisticId;
        commitRunMessages(attachment, event.message.threadId, current =>
          upsertMessage(
            current.filter(message => message.id !== optimisticId),
            event.message
          )
        );
      }
      if (event.type === "done") {
        attachment.finalStatus = event.status ?? "completed";
        setSelectedThreadId(event.thread.id);
        upsertThread(event.thread);
        // The new chat's title is generated after the stream closes.
        if (attachment.isNewChat) scheduleTitleRefresh(event.thread.id);
      }
      if (event.type === "error") {
        throw Object.assign(new Error(event.message), {
          persisted: event.persisted,
          code: event.code,
        });
      }
    },
    [
      callbacksRef,
      commitRunMessages,
      isCurrentAttachment,
      requestCancel,
      scheduleTitleRefresh,
      upsertThread,
      workspaceId,
    ]
  );

  /** Follows a durable run's stream (GET .../runs/[runId]/stream). */
  const followRun = useCallback(
    async (attachment: RunAttachment) => {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/airi-chats/${attachment.threadId}/runs/${attachment.runId}/stream`,
        { cache: "no-store", signal: attachment.controller.signal }
      );
      if (!isCurrentAttachment(attachment)) return;
      if (!response.ok) {
        throw new Error(
          (
            (await response.json().catch(() => ({}))) as {
              error?: string;
            }
          ).error || `Request failed: ${response.status}`
        );
      }
      await readAiriChatEventStream<AiriChatStreamEvent>(response, event =>
        handleRunEvent(attachment, event)
      );
    },
    [handleRunEvent, isCurrentAttachment, workspaceId]
  );

  const finishAttachment = useCallback(
    (attachment: RunAttachment) => {
      if (!isCurrentAttachment(attachment)) {
        attachment.dropStreamingTimer();
        return;
      }
      attachment.clearStreamingAnswer();
      attachmentRef.current = null;
      setRunView(null);
      setLiveRunEvents(retainTerminalAiriChatRunEvents);
      if (attachment.runId) {
        if (pendingRunThreads.get(workspaceId)?.runId === attachment.runId) {
          pendingRunThreads.delete(workspaceId);
        }
        if (attachment.threadId) {
          void mutateCache(
            messagesKey(workspaceId, attachment.threadId),
            (current?: AiriChatMessagePage) =>
              current?.activeRun?.runId === attachment.runId
                ? { ...current, activeRun: null }
                : current,
            { revalidate: false }
          );
        }
      }
    },
    [isCurrentAttachment, mutateCache, workspaceId]
  );

  /**
   * Attaches this view to a run already answering in a chat (the chat was
   * opened again, or a second send met it): progress and the streaming
   * answer show, and its messages land in the chat when it ends.
   */
  const attachRun = useCallback(
    async (threadId: string, runId: string) => {
      if (attachmentRef.current) return;
      resumedRunIdsRef.current.add(runId);
      const attachment = createAttachment({
        threadId,
        runId,
        isNewChat: false,
      });
      attachmentRef.current = attachment;
      pendingRunThreads.set(workspaceId, { threadId, runId });
      setRunView({ threadId, runId, stopping: false });
      setLiveRunEvents([]);
      setStreamingAnswer(null);
      try {
        await followRun(attachment);
        if (!isCurrentAttachment(attachment)) return;
        if (
          !attachment.assistantMessageReceived &&
          attachment.finalStatus !== "cancelled"
        ) {
          throw new Error("Airi response did not finish");
        }
        // The run this view waited on has ended: a "still answering" note
        // (a second send met it) no longer applies.
        setErrorFor(threadId, null);
        // The chat may have been read from a cache older than this run (a
        // revalidation a send discarded): read it once more.
        void mutateCache(messagesKey(workspaceId, threadId));
      } catch (err) {
        if (!isCurrentAttachment(attachment)) return;
        if (!(attachment.stopRequested && isAbortError(err))) {
          setErrorFor(
            threadId,
            err instanceof Error ? err.message : "Airi response did not finish"
          );
        }
        // Show whatever the run saved.
        void mutateCache(messagesKey(workspaceId, threadId));
      } finally {
        finishAttachment(attachment);
      }
    },
    [
      createAttachment,
      finishAttachment,
      followRun,
      isCurrentAttachment,
      mutateCache,
      setErrorFor,
      workspaceId,
    ]
  );

  const sendTurn = useCallback(
    async (input: AiriChatTurnInput): Promise<boolean> => {
      const content = input.content.trim();
      if (!content || attachmentRef.current || sendBlocked) return false;

      const threadId = selectedThreadId;
      const attachment = createAttachment({
        threadId,
        runId: null,
        isNewChat: !threadId,
      });
      attachmentRef.current = attachment;
      const isCurrentRun = () => isCurrentAttachment(attachment);
      const clientTurnId = createAiriClientTurnId();
      let conflictRunId: string | null = null;

      callbacksRef.current.onTurnStart();
      setRunView({ threadId, runId: null, stopping: false });
      setErrorFor(threadId, null);
      setLiveRunEvents([]);
      setStreamingAnswer(null);
      const optimistic: AiriChatMessage = {
        id: `pending-${clientTurnId}`,
        threadId: threadId || DRAFT_THREAD_ID,
        role: "user",
        content,
        metadata: input.optimisticMetadata,
        createdAt: new Date().toISOString(),
      };
      attachment.optimisticId = optimistic.id;
      if (threadId) {
        updateThreadMessages(threadId, current => [...current, optimistic]);
      } else {
        setDraftMessages(current => [...current, optimistic]);
      }

      const run = async (): Promise<boolean> => {
        try {
          const attachments = await input.prepareAttachments();
          if (!isCurrentRun()) return false;
          const activeBuilder = threadId
            ? callbacksRef.current.getActiveBuilder()
            : undefined;
          const body = JSON.stringify({
            content,
            clientTurnId,
            selectedSources: input.selectedSources,
            attachments,
            activeBuilder,
            source: threadId ? undefined : initialSource,
          });

          const sendJsonFallback = async () => {
            if (!isCurrentRun()) return false;
            const payload = await readJson<{
              userMessage: AiriChatMessage;
              assistantMessage: AiriChatMessage;
              thread: AiriChatThread;
            }>(
              await fetch(
                threadId
                  ? `/api/workspaces/${workspaceId}/airi-chats/${threadId}/messages`
                  : `/api/workspaces/${workspaceId}/airi-chats/messages`,
                {
                  method: "POST",
                  signal: attachment.controller.signal,
                  headers: { "Content-Type": "application/json" },
                  body,
                }
              )
            );
            if (!isCurrentRun()) return false;
            commitRunMessages(attachment, payload.thread.id, current => [
              ...current.filter(message => message.id !== optimistic.id),
              payload.userMessage,
              payload.assistantMessage,
            ]);
            callbacksRef.current.onAssistantMessage(
              payload.assistantMessage.metadata
            );
            setSelectedThreadId(payload.thread.id);
            upsertThread(payload.thread);
            return true;
          };

          const streamResponse = await fetch(
            threadId
              ? `/api/workspaces/${workspaceId}/airi-chats/${threadId}/messages/stream`
              : `/api/workspaces/${workspaceId}/airi-chats/messages/stream`,
            {
              method: "POST",
              signal: attachment.controller.signal,
              headers: { "Content-Type": "application/json" },
              body,
            }
          );
          if (!isCurrentRun()) return false;
          const contentType = streamResponse.headers.get("content-type") || "";
          if (!streamResponse.ok) {
            const payload = (await streamResponse.json().catch(() => ({}))) as {
              error?: string;
              code?: string;
              runId?: unknown;
            };
            if (
              streamResponse.status === 409 &&
              payload.code === "airi_run_active"
            ) {
              // This chat is still answering an earlier turn: show that run
              // and keep this message in the composer.
              removeOptimisticMessage(attachment);
              setErrorFor(threadId, chatT("runActive"));
              conflictRunId =
                typeof payload.runId === "string" ? payload.runId : null;
              return false;
            }
            throw new Error(
              payload.error || `Request failed: ${streamResponse.status}`
            );
          }
          if (
            !streamResponse.body ||
            !contentType.includes("text/event-stream")
          ) {
            return await sendJsonFallback();
          }

          await readAiriChatEventStream<AiriChatStreamEvent>(
            streamResponse,
            event => handleRunEvent(attachment, event)
          );
          if (!isCurrentRun()) return false;

          if (
            !attachment.assistantMessageReceived &&
            attachment.finalStatus === null &&
            attachment.runId &&
            attachment.threadId
          ) {
            // The stream ended before the run did (a dropped connection):
            // follow the run itself; it never stopped.
            setLiveRunEvents([]);
            await followRun(attachment);
            if (!isCurrentRun()) return false;
          }
          if (!attachment.assistantMessageReceived) {
            if (attachment.finalStatus === "cancelled") {
              // Stopped before Airi saved the question: it stays in the
              // composer.
              removeOptimisticMessage(attachment);
              return attachment.userMessagePersisted;
            }
            if (!attachment.userMessagePersisted && !attachment.runId) {
              return await sendJsonFallback();
            }
            throw new Error("Airi response did not finish");
          }
          return true;
        } catch (err) {
          if (!isCurrentRun()) return false;
          removeOptimisticMessage(attachment);
          const stopped =
            attachment.stopRequested &&
            (isAbortError(err) ||
              (err as { code?: unknown } | null)?.code === "cancelled");
          if (stopped) {
            // Stopped: show what the server kept.
            if (attachment.threadId) {
              void mutateCache(messagesKey(workspaceId, attachment.threadId));
            }
            return attachment.userMessagePersisted;
          }
          setErrorFor(
            attachment.threadId,
            err instanceof Error ? err.message : "Failed to send message"
          );
          // The composer clears an accepted message even if its answer failed.
          return attachment.userMessagePersisted;
        } finally {
          finishAttachment(attachment);
        }
      };

      const accepted = await run();
      if (conflictRunId && threadId && !attachment.detached) {
        void attachRun(threadId, conflictRunId);
      }
      return accepted;
    },
    [
      attachRun,
      callbacksRef,
      chatT,
      commitRunMessages,
      createAttachment,
      finishAttachment,
      followRun,
      handleRunEvent,
      initialSource,
      isCurrentAttachment,
      mutateCache,
      removeOptimisticMessage,
      selectedThreadId,
      sendBlocked,
      setDraftMessages,
      setErrorFor,
      updateThreadMessages,
      upsertThread,
      workspaceId,
    ]
  );

  /** The composer's Stop: cancels the run on the server. */
  const stopRun = useCallback(() => {
    const attachment = attachmentRef.current;
    if (!attachment || attachment.stopRequested) return;
    attachment.stopRequested = true;
    setRunView(view => (view ? { ...view, stopping: true } : view));
    // Before the run has an id, its "run" event sends the cancel.
    if (attachment.runId) void requestCancel(attachment);
  }, [requestCancel]);

  // A chat opened while its run still answers attaches to that run.
  const activeRun = messagePage?.activeRun ?? null;
  useEffect(() => {
    if (!selectedThreadId || !activeRun || activeRun.status !== "running") {
      return;
    }
    if (
      attachmentRef.current ||
      resumedRunIdsRef.current.has(activeRun.runId)
    ) {
      return;
    }
    void attachRun(selectedThreadId, activeRun.runId);
  }, [activeRun, attachRun, selectedThreadId]);

  // The chat reopened for a run that was still answering has now been
  // shown; a later mount starts from the start screen again.
  const messagesSettled = Boolean(messagePage) || messagesLoadFailed;
  useEffect(() => {
    if (!messagesSettled || attachmentRef.current) return;
    const pending = pendingRunThreads.get(workspaceId);
    if (pending && pending.threadId === selectedThreadId) {
      pendingRunThreads.delete(workspaceId);
    }
  }, [messagesSettled, selectedThreadId, workspaceId]);

  // --- Navigation ---------------------------------------------------------
  const clearViewState = useCallback(() => {
    setErrorState({ threadId: null, message: null });
    setLiveRunEvents([]);
    setEarlierMessages(null);
    pendingRunThreads.delete(workspaceId);
  }, [workspaceId]);

  /** Opens a chat; false while a run is attached or it is already open. */
  const selectThread = useCallback(
    (threadId: string) => {
      if (attachmentRef.current) return false;
      if (threadId === selectedThreadIdRef.current) return false;
      clearViewState();
      setSelectedThreadId(threadId);
      return true;
    },
    [clearViewState]
  );

  /** Shows the empty start screen for a new chat. */
  const startDraft = useCallback(() => {
    if (attachmentRef.current) return;
    clearViewState();
    setDraftMessages([]);
    setSelectedThreadId(null);
  }, [clearViewState, setDraftMessages]);

  const clearLiveRunEvents = useCallback(() => setLiveRunEvents([]), []);
  const hasAttachedRun = useCallback(() => attachmentRef.current !== null, []);

  const visibleStreamingAnswer =
    streamingAnswer && streamingAnswer.threadId === selectedThreadId
      ? streamingAnswer.text
      : null;
  const runVisible = runView !== null && runView.threadId === selectedThreadId;

  return {
    threads,
    setThreads,
    isLoadingThreads,
    threadsLoadError,
    retryThreadsLoad,
    selectedThreadId,
    selectThread,
    startDraft,
    messages,
    isLoadingMessages,
    messagesLoadFailed,
    messagesLoadError,
    retryMessagesLoad,
    sendBlocked,
    hasEarlierMessages,
    earlierMessagesStatus: earlierStatus,
    loadEarlierMessages,
    updateThreadMessages,
    replaceThreadMessages,
    error,
    setError,
    isSending,
    liveRunEvents,
    clearLiveRunEvents,
    streamingAnswerText: visibleStreamingAnswer,
    canStop: runVisible,
    isStopping: runVisible && runView.stopping,
    stopRun,
    sendTurn,
    hasAttachedRun,
  };
}
