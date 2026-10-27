import { isRecord } from "@icecore/shared/lib/value-utils";
import type { useSWRConfig } from "swr";

type ConversationDetailMutator = ReturnType<typeof useSWRConfig>["mutate"];

type ConversationDetailView = "chat" | "full";

const CHAT_PAGE_SIZE = "30";
const DETAIL_PRELOAD_FRESHNESS_MS = 5_000;
const DETAIL_PRELOAD_MAX_ENTRIES = 50;
const detailRequestsInFlight = new Map<string, Promise<unknown>>();
const detailPreloadedAt = new Map<string, number>();

function buildConversationUrl(
  conversationId: string,
  workspaceId: string | undefined,
  query: Record<string, string>
): string {
  const params = new URLSearchParams(query);
  if (workspaceId) {
    params.set("workspaceId", workspaceId);
  }

  return `/api/conversations/${encodeURIComponent(conversationId)}?${params.toString()}`;
}

function buildConversationDetailKey(
  conversationId: string,
  workspaceId: string | undefined,
  view: ConversationDetailView
): string {
  return buildConversationUrl(conversationId, workspaceId, {
    page: "1",
    limit: view === "chat" ? CHAT_PAGE_SIZE : "1",
    view,
  });
}

export function buildConversationChatKey(
  conversationId: string,
  workspaceId?: string
): string {
  return buildConversationDetailKey(conversationId, workspaceId, "chat");
}

export function buildConversationFullKey(
  conversationId: string,
  workspaceId?: string
): string {
  return buildConversationDetailKey(conversationId, workspaceId, "full");
}

/** One chat-sized page of messages only, newest first, for paging and catch-up. */
export function buildConversationMessagesPageUrl(
  conversationId: string,
  page: number,
  workspaceId?: string
): string {
  return buildConversationUrl(conversationId, workspaceId, {
    page: String(page),
    limit: CHAT_PAGE_SIZE,
    messagesOnly: "1",
  });
}

export type ConversationPlanGate = {
  hiddenCount: number;
  reason: "trial_expired" | "conversation_limit";
};

/** The workspace's plan hides this conversation (HTTP 402 with `planGate`). */
export class ConversationPlanGateError extends Error {
  readonly planGate: ConversationPlanGate;

  constructor(message: string, planGate: ConversationPlanGate) {
    super(message);
    this.name = "ConversationPlanGateError";
    this.planGate = planGate;
  }
}

function readPlanGate(
  payload: Record<string, unknown>
): ConversationPlanGate | null {
  // The structured gate marks a plan-hidden conversation; the route answers
  // with the conversation-limit code, so the code alone cannot tell it apart.
  if (!isRecord(payload.planGate)) return null;
  const hiddenCount = Number(payload.planGate.hiddenCount);
  return {
    hiddenCount: Number.isFinite(hiddenCount) ? Math.max(0, hiddenCount) : 0,
    reason:
      payload.planGate.reason === "trial_expired"
        ? "trial_expired"
        : "conversation_limit",
  };
}

function toResponseError(response: Response, responseText: string): Error {
  if (!responseText) {
    return new Error(`HTTP ${response.status}`);
  }

  try {
    const payload = JSON.parse(responseText) as unknown;
    if (isRecord(payload)) {
      const message =
        typeof payload.error === "string" ? payload.error.trim() : "";
      const planGate = readPlanGate(payload);
      if (planGate) {
        return new ConversationPlanGateError(
          message || "Conversation is hidden by your current plan.",
          planGate
        );
      }
      if (message) {
        return new Error(message);
      }
    }
  } catch {
    // Preserve a non-JSON response as the useful server error.
  }

  return new Error(responseText);
}

export function fetchConversationDetail<T>(key: string): Promise<T> {
  const existing = detailRequestsInFlight.get(key) as Promise<T> | undefined;
  if (existing) {
    return existing;
  }

  const request = (async () => {
    const response = await fetch(key, { credentials: "same-origin" });
    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      throw toResponseError(response, responseText);
    }

    return response.json() as Promise<T>;
  })();

  detailRequestsInFlight.set(key, request);
  const clearInFlight = () => {
    if (detailRequestsInFlight.get(key) === request) {
      detailRequestsInFlight.delete(key);
    }
  };
  void request.then(clearInFlight, clearInFlight);

  return request;
}

function prunePreloadFreshness(now: number): void {
  for (const [key, preloadedAt] of detailPreloadedAt) {
    if (now - preloadedAt > DETAIL_PRELOAD_FRESHNESS_MS) {
      detailPreloadedAt.delete(key);
    }
  }

  while (detailPreloadedAt.size > DETAIL_PRELOAD_MAX_ENTRIES) {
    const oldestKey = detailPreloadedAt.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    detailPreloadedAt.delete(oldestKey);
  }
}

export function isConversationDetailPreloaded(key: string): boolean {
  const now = Date.now();
  prunePreloadFreshness(now);
  const preloadedAt = detailPreloadedAt.get(key);
  return Boolean(
    preloadedAt && now - preloadedAt <= DETAIL_PRELOAD_FRESHNESS_MS
  );
}

export async function preloadConversationDetail<T = unknown>(
  mutate: ConversationDetailMutator,
  conversationId: string,
  workspaceId?: string
): Promise<T | undefined> {
  const key = buildConversationChatKey(conversationId, workspaceId);
  if (isConversationDetailPreloaded(key)) {
    return undefined;
  }

  try {
    const request = fetchConversationDetail<T>(key).then(data => {
      // SWR can render subscribers as soon as mutate publishes this payload.
      // Mark it fresh first so that render does not schedule a duplicate GET.
      detailPreloadedAt.delete(key);
      detailPreloadedAt.set(key, Date.now());
      prunePreloadFreshness(Date.now());
      return data;
    });
    const data = await mutate(key, request, {
      populateCache: true,
      revalidate: false,
      rollbackOnError: false,
      throwOnError: true,
    });
    return data as T | undefined;
  } catch (error) {
    detailPreloadedAt.delete(key);
    throw error;
  }
}
