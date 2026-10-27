/** Turn work that needs no intent: workspace retrieval and the language. */

import { awaitWithCancellation, throwIfCancelled } from "@/lib/ai/cancellation";
import { isWorkspaceAiPolicyError } from "@/lib/ai/workspace-ai-errors";
import { searchAskDataContextLocal } from "@/lib/ai/ask-data-search-local";
import {
  canCallGcpAIGateway,
  getRemoteAskDataContext,
} from "@/lib/ai/gcp-ai-gateway";
import { normalizeAiriLanguage } from "@/lib/airi/shared/language-policy";
import type { AskDataContextGatewayResponse } from "@icecore/airi-runtime/ai-gateway";
import type { SupabaseClient, AiriChatProgressRecorder } from "./types";
import { stageEvent } from "./progress";
import type { AiriTurnDeadline } from "./deadline";

export function hasAiriChatSearchContext(
  result: AskDataContextGatewayResponse
) {
  return result.conversations.length > 0 || result.kbArticles.length > 0;
}

export function hasAiriChatConversationContext(
  result: AskDataContextGatewayResponse
) {
  return result.conversations.length > 0;
}

export function hasAiriChatKnowledgeContext(
  result: AskDataContextGatewayResponse
) {
  return result.kbArticles.length > 0;
}

export function mergeAiriChatSearchContext(
  primary: AskDataContextGatewayResponse,
  fill: AskDataContextGatewayResponse
): AskDataContextGatewayResponse {
  return {
    conversations:
      primary.conversations.length > 0
        ? primary.conversations
        : fill.conversations,
    kbArticles:
      primary.kbArticles.length > 0 ? primary.kbArticles : fill.kbArticles,
    metadata: {
      ...(fill.metadata || {}),
      ...(primary.metadata || {}),
      retrievalPath:
        primary.metadata?.retrievalPath || fill.metadata?.retrievalPath,
      vectorIndex: primary.metadata?.vectorIndex || fill.metadata?.vectorIndex,
      vectorConversationCount:
        primary.metadata?.vectorConversationCount ??
        fill.metadata?.vectorConversationCount,
      fallbackConversationCount:
        primary.metadata?.fallbackConversationCount ??
        fill.metadata?.fallbackConversationCount,
    },
  };
}

/** How long the GCP gateway may take before local search answers alone. */
export const AIRI_CHAT_GATEWAY_RETRIEVAL_BUDGET_MS = 3_000;
/** Upper bound on local search; past it the turn continues without context. */
export const AIRI_CHAT_LOCAL_RETRIEVAL_TIMEOUT_MS = 8_000;

export type AiriChatRetrievalLeg = {
  status: "complete" | "timeout" | "error" | "skipped" | "cancelled";
  durationMs: number | null;
};

export type AiriChatWorkspaceRetrieval = {
  result: AskDataContextGatewayResponse;
  gateway: AiriChatRetrievalLeg;
  local: AiriChatRetrievalLeg;
  /**
   * No leg answered in time (local timed out, the gateway did not complete):
   * the empty result says nothing about what the workspace contains.
   */
  unavailable: boolean;
  durationMs: number;
};

export const WORKSPACE_CONTEXT_UNAVAILABLE_TEXT =
  "Workspace context could not be loaded in time; this is not evidence that the workspace has none.";

export const EMPTY_AIRI_CHAT_SEARCH_RESULT: AskDataContextGatewayResponse = {
  conversations: [],
  kbArticles: [],
  metadata: {
    retrievalPath: "none",
    vectorIndex: null,
    vectorConversationCount: 0,
    fallbackConversationCount: 0,
  },
};

/**
 * Workspace context for one turn. Local search starts at once and runs
 * alongside the GCP gateway (it is both the KB/chat fill and the fallback).
 * The gateway gets a short budget and is dropped as soon as local search
 * returns both chats and KB; local search has its own time limit, and when it
 * runs out the turn continues without workspace context (marked unavailable).
 */
export async function searchWorkspaceContextForAiriChat(params: {
  signal?: AbortSignal;
  workspaceId: string;
  query: string;
  conversationLimit: number;
  kbLimit: number;
  gatewayBudgetMs?: number;
  localTimeoutMs?: number;
}): Promise<AiriChatWorkspaceRetrieval> {
  const startedAt = Date.now();
  const {
    signal,
    gatewayBudgetMs = AIRI_CHAT_GATEWAY_RETRIEVAL_BUDGET_MS,
    localTimeoutMs = AIRI_CHAT_LOCAL_RETRIEVAL_TIMEOUT_MS,
    ...request
  } = params;
  const withCaller = (own: AbortSignal[]) =>
    AbortSignal.any(signal ? [...own, signal] : own);

  const local: AiriChatRetrievalLeg = { status: "skipped", durationMs: null };
  const localCancel = new AbortController();
  const localSignal = withCaller([
    localCancel.signal,
    AbortSignal.timeout(localTimeoutMs),
  ]);
  let localError: unknown = null;
  const localSearch = searchAskDataContextLocal({
    ...request,
    signal: localSignal,
  }).then(
    result => {
      local.status = "complete";
      local.durationMs = Date.now() - startedAt;
      return result;
    },
    error => {
      local.durationMs = Date.now() - startedAt;
      throwIfCancelled(signal);
      if (isWorkspaceAiPolicyError(error)) throw error;
      local.status = localCancel.signal.aborted
        ? "cancelled"
        : localSignal.aborted
          ? "timeout"
          : "error";
      localError = error;
      return null;
    }
  );
  // Observed below; never an unhandled rejection while the gateway runs.
  void localSearch.catch(() => undefined);

  const gateway: AiriChatRetrievalLeg = { status: "skipped", durationMs: null };
  const gatewayCancel = new AbortController();
  let gatewayRun: Promise<AskDataContextGatewayResponse | null> | null = null;
  if (canCallGcpAIGateway()) {
    const gatewaySignal = withCaller([
      gatewayCancel.signal,
      AbortSignal.timeout(gatewayBudgetMs),
    ]);
    gatewayRun = getRemoteAskDataContext(request, {
      signal: gatewaySignal,
    }).then(
      result => {
        // Local search already answered; the late gateway result is unused.
        if (gatewayCancel.signal.aborted) return null;
        gateway.status = "complete";
        gateway.durationMs = Date.now() - startedAt;
        return result;
      },
      error => {
        if (gatewayCancel.signal.aborted) return null;
        gateway.durationMs = Date.now() - startedAt;
        throwIfCancelled(signal);
        if (isWorkspaceAiPolicyError(error)) throw error;
        gateway.status = gatewaySignal.aborted ? "timeout" : "error";
        return null;
      }
    );
    // Observed below; never an unhandled rejection while local search runs.
    void gatewayRun.catch(() => undefined);
  }

  const finish = (
    result: AskDataContextGatewayResponse,
    unavailable = false
  ): AiriChatWorkspaceRetrieval => ({
    result,
    gateway,
    local,
    unavailable,
    durationMs: Date.now() - startedAt,
  });

  let remote: AskDataContextGatewayResponse | null = null;
  if (gatewayRun) {
    try {
      // Local search usually answers well inside the gateway budget; when it
      // brings both chats and KB, the gateway is no longer worth waiting for.
      const firstLeg = await awaitWithCancellation(
        Promise.race([
          gatewayRun.then(() => "gateway" as const),
          localSearch.then(() => "local" as const),
        ]),
        signal
      );
      if (firstLeg === "local") {
        const early = await localSearch;
        if (
          early &&
          hasAiriChatConversationContext(early) &&
          hasAiriChatKnowledgeContext(early)
        ) {
          gatewayCancel.abort();
          gateway.status = "cancelled";
          gateway.durationMs = Date.now() - startedAt;
          return finish(early);
        }
      }
      remote = await awaitWithCancellation(gatewayRun, signal);
    } catch (error) {
      localCancel.abort();
      gatewayCancel.abort();
      throw error;
    }
  }

  if (
    remote &&
    hasAiriChatConversationContext(remote) &&
    hasAiriChatKnowledgeContext(remote)
  ) {
    localCancel.abort();
    return finish(remote);
  }
  const localResult = await awaitWithCancellation(localSearch, signal);
  if (remote) {
    if (!localResult) return finish(remote);
    const merged = mergeAiriChatSearchContext(remote, localResult);
    return finish(hasAiriChatSearchContext(merged) ? merged : remote);
  }
  if (localResult) return finish(localResult);
  // Neither source answered: a local failure still fails the turn as before,
  // while a local timeout lets the turn continue without workspace context,
  // marked unavailable so it is not mistaken for an empty workspace.
  if (local.status === "error") throw localError;
  return finish(EMPTY_AIRI_CHAT_SEARCH_RESULT, true);
}

export function describeRetrievalLeg(leg: AiriChatRetrievalLeg): string {
  if (leg.status === "timeout") return "Timed out";
  if (leg.status === "error") return "Failed";
  if (leg.status === "cancelled") return "Not needed";
  return "Done";
}

/**
 * Emits the retrieval stage around the work itself: "running" before the
 * search starts, then gateway and local sub-stages and "complete", each
 * with its measured duration.
 */
export async function runAiriChatWorkspaceRetrieval(params: {
  signal?: AbortSignal;
  workspaceId: string;
  query: string;
  progress: AiriChatProgressRecorder;
  /** Each leg's time limit is its own, capped by what is left of the turn. */
  deadline?: AiriTurnDeadline;
}): Promise<AiriChatWorkspaceRetrieval> {
  await params.progress.emit(
    stageEvent("workspace_retrieval", "Searching workspace context", "running")
  );
  const retrieval = await searchWorkspaceContextForAiriChat({
    signal: params.signal,
    workspaceId: params.workspaceId,
    query: params.query,
    conversationLimit: 5,
    kbLimit: 3,
    ...(params.deadline
      ? {
          gatewayBudgetMs: params.deadline.stepTimeoutMs(
            AIRI_CHAT_GATEWAY_RETRIEVAL_BUDGET_MS
          ),
          localTimeoutMs: params.deadline.stepTimeoutMs(
            AIRI_CHAT_LOCAL_RETRIEVAL_TIMEOUT_MS
          ),
        }
      : {}),
  });
  for (const [id, label, leg] of [
    [
      "workspace_retrieval_gateway",
      "Searching workspace index",
      retrieval.gateway,
    ],
    ["workspace_retrieval_local", "Searching workspace data", retrieval.local],
  ] as const) {
    if (leg.status === "skipped" || leg.durationMs === null) continue;
    await params.progress.emit(
      stageEvent(
        id,
        label,
        leg.status === "timeout" || leg.status === "error"
          ? "error"
          : "complete",
        describeRetrievalLeg(leg),
        leg.durationMs
      )
    );
  }
  await params.progress.emit(
    stageEvent(
      "workspace_retrieval",
      "Searching workspace context",
      retrieval.unavailable ? "error" : "complete",
      retrieval.unavailable
        ? "Workspace context unavailable: search timed out"
        : `Found ${retrieval.result.kbArticles.length} KB articles and ${retrieval.result.conversations.length} conversations`,
      retrieval.durationMs
    )
  );
  return retrieval;
}

/** Starts work now while letting a later await observe its result. */
export function startEarly<T>(work: Promise<T>): Promise<T> {
  void work.catch(() => undefined);
  return work;
}

/**
 * A turn that answers without the workspace search: Meta Ads turns work
 * from their own tools and the thread, never the tenant KB or chats.
 */
export const SKIPPED_AIRI_CHAT_WORKSPACE_RETRIEVAL: AiriChatWorkspaceRetrieval =
  {
    result: EMPTY_AIRI_CHAT_SEARCH_RESULT,
    gateway: { status: "skipped", durationMs: null },
    local: { status: "skipped", durationMs: null },
    unavailable: false,
    durationMs: 0,
  };

/** Turn work that depends on neither the intent nor the attached sources. */
export type AiriChatWorkspaceWork = {
  language: ReturnType<typeof getWorkspaceLanguage>;
  retrieval: Promise<AiriChatWorkspaceRetrieval>;
  /** Stops the retrieval when the turn fails before it is used. */
  cancel: () => void;
  /**
   * Stops a search the turn no longer uses (a Meta Ads turn the classifier
   * found) and closes its stage; the turn continues without its context.
   */
  skipRetrieval: () => Promise<AiriChatWorkspaceRetrieval>;
};

export function startAiriChatWorkspaceWork(params: {
  signal?: AbortSignal;
  supabase: SupabaseClient;
  workspaceId: string;
  query: string;
  progress: AiriChatProgressRecorder;
  deadline?: AiriTurnDeadline;
  /** Known up front (an explicit Meta Ads request): never search at all. */
  skipRetrieval?: boolean;
}): AiriChatWorkspaceWork {
  const cancellation = new AbortController();
  let searching = !params.skipRetrieval;
  return {
    language: startEarly(
      getWorkspaceLanguage({
        supabase: params.supabase,
        workspaceId: params.workspaceId,
      })
    ),
    retrieval: params.skipRetrieval
      ? Promise.resolve(SKIPPED_AIRI_CHAT_WORKSPACE_RETRIEVAL)
      : startEarly(
          runAiriChatWorkspaceRetrieval({
            signal: params.signal
              ? AbortSignal.any([params.signal, cancellation.signal])
              : cancellation.signal,
            workspaceId: params.workspaceId,
            query: params.query,
            progress: params.progress,
            deadline: params.deadline,
          }).finally(() => {
            searching = false;
          })
        ),
    cancel: () => cancellation.abort(),
    skipRetrieval: async () => {
      cancellation.abort();
      if (searching) {
        searching = false;
        await params.progress.emit(
          stageEvent(
            "workspace_retrieval",
            "Searching workspace context",
            "complete",
            "Not used for Meta Ads"
          )
        );
      }
      return SKIPPED_AIRI_CHAT_WORKSPACE_RETRIEVAL;
    },
  };
}

export async function getWorkspaceLanguage(params: {
  supabase: SupabaseClient;
  workspaceId: string;
}) {
  const { data } = await params.supabase
    .from("workspaces")
    .select("companies!workspaces_company_id_fkey(airi_language)")
    .eq("id", params.workspaceId)
    .maybeSingle();

  const company = Array.isArray(data?.companies)
    ? data?.companies[0]
    : data?.companies;
  return normalizeAiriLanguage(company?.airi_language);
}
