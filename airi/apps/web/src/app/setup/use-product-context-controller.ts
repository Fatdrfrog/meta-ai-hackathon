"use client";

import type { IndexedUrlPublicSource } from "@/lib/kb/indexed-url-public-contract";
import {
  hasVerifiedWhatsAppHistory,
  isWhatsAppHistorySyncActive,
} from "@/lib/whatsapp/history-sync/status";
import {
  getWhatsAppHistoryRequestAvailability,
  type WhatsAppHistorySyncState,
} from "@icecore/whatsapp/historySyncState";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { captureOnboardingAnalytics } from "./onboarding-analytics";
import {
  createInitialProductContextState,
  deriveProductContextReadiness,
  productContextReducer,
  type ConnectedSources,
  type ProductContextAction,
  type ProductContextSnapshot,
  type ProductContextStartErrorCode,
  type ProductContextState,
  type ProductTrainingHandoffState,
} from "./product-context-state";
import { isRecord } from "@icecore/shared/lib/value-utils";

export const FOREGROUND_OBSERVATION_MS = 80_000;
export const POLL_BACKOFF_MS = [
  2_000, 3_000, 5_000, 8_000, 13_000, 21_000, 28_000,
] as const;
export const START_TRAINING_TIMEOUT_MS = 15_000;

const WHATSAPP_HISTORY_RANGE_DAYS = 180;
const PRODUCT_CONTEXT_READ_TIMEOUT_MS = 10_000;

export type UseProductContextControllerParams = {
  workspaceId: string;
  onHandoffStateChange?: (state: ProductTrainingHandoffState) => void;
};

export type StartProductContextTrainingInput = {
  websites: string[];
  includeInstagram: boolean;
  includeWhatsapp: boolean;
};

export type UseProductContextControllerResult = {
  state: ProductContextState;
  startTraining(input: StartProductContextTrainingInput): Promise<void>;
  checkAgain(): Promise<void>;
};

type WhatsAppStartResult = {
  accepted: boolean;
  historyEligible?: boolean;
  historyRequested?: boolean;
  historySync?: WhatsAppHistorySyncState | null;
  historyCanRequest?: boolean;
};

type CrawlStartFailureCode =
  | "indexed_url_limit_exceeded"
  | "invalid_training_source"
  | "background_processing_unavailable"
  | "training_start_failed";

type CrawlStartResult =
  | {
      accepted: true;
      shouldObserve: true;
      failureCode: null;
    }
  | {
      accepted: false;
      shouldObserve: boolean;
      failureCode: CrawlStartFailureCode | null;
    };

type BoundedReadResult<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown }
  | { status: "timed_out" }
  | { status: "aborted" };

type ProductContextReader<T> = (signal: AbortSignal) => Promise<T>;
type BoundedReadResults<T extends readonly unknown[]> = {
  [Key in keyof T]: BoundedReadResult<T[Key]>;
};

type WorkspaceOwnedProductContextState = {
  workspaceId: string;
  state: ProductContextState;
};

type WorkspaceOwnedProductContextAction = {
  workspaceId: string;
  action: ProductContextAction;
};

function workspaceOwnedProductContextReducer(
  current: WorkspaceOwnedProductContextState,
  dispatched: WorkspaceOwnedProductContextAction
): WorkspaceOwnedProductContextState {
  if (dispatched.action.type === "reset") {
    return {
      workspaceId: dispatched.workspaceId,
      state: createInitialProductContextState(),
    };
  }
  if (dispatched.workspaceId !== current.workspaceId) return current;

  const state = productContextReducer(current.state, dispatched.action);
  return state === current.state ? current : { ...current, state };
}

function finiteCount(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function toPublicSource(value: unknown): IndexedUrlPublicSource | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || typeof value.url !== "string") {
    return null;
  }
  if (
    value.index_status !== "pending" &&
    value.index_status !== "indexed" &&
    value.index_status !== "failed"
  ) {
    return null;
  }

  const failureCode =
    value.failure_code === "no_content" ||
    value.failure_code === "timeout" ||
    value.failure_code === "generic"
      ? value.failure_code
      : null;

  return {
    id: value.id,
    url: value.url,
    title: typeof value.title === "string" ? value.title : null,
    index_status: value.index_status,
    failure_code: failureCode,
    error_message:
      typeof value.error_message === "string" ? value.error_message : null,
  };
}

function parseProgressPayload(
  payload: unknown,
  current: ProductContextSnapshot
): ProductContextSnapshot {
  if (!isRecord(payload)) throw new Error("Invalid progress response");

  const sources = Array.isArray(payload.sources)
    ? payload.sources
        .map(toPublicSource)
        .filter((source): source is IndexedUrlPublicSource => source !== null)
    : [];
  const derivedIndexed = sources.filter(
    source => source.index_status === "indexed"
  ).length;
  const derivedFailed = sources.filter(
    source => source.index_status === "failed"
  ).length;
  const derivedPending = sources.filter(
    source => source.index_status === "pending"
  ).length;

  return {
    ...current,
    sources,
    counts: {
      total: finiteCount(payload.total, sources.length),
      indexed: finiteCount(payload.indexed, derivedIndexed),
      pending: finiteCount(payload.pending, derivedPending),
      failed: finiteCount(payload.failed, derivedFailed),
    },
  };
}

function snapshotFromState(state: ProductContextState): ProductContextSnapshot {
  return {
    sources: state.sources,
    counts: state.counts,
    connected: state.connected,
    whatsappStatusKnown: state.whatsappStatusKnown,
    whatsappHistoryEligible: state.whatsappHistoryEligible,
    whatsappHistoryRequested: state.whatsappHistoryRequested,
    whatsappHistorySync: state.whatsappHistorySync,
    whatsappHistoryCanRequest: state.whatsappHistoryCanRequest,
  };
}

async function readJsonRecord(
  response: Response
): Promise<Record<string, unknown>> {
  const payload = await response.json().catch(() => null);
  return isRecord(payload) ? payload : {};
}

function shouldContinueObservation(
  snapshot: ProductContextSnapshot,
  state: ProductContextState
): boolean {
  return (
    snapshot.counts.pending > 0 ||
    isWhatsAppHistorySyncActive(snapshot.whatsappHistorySync) ||
    (snapshot.counts.total === 0 && state.awaitingCrawlProgress)
  );
}

function hasDurableTrainingEvidence(
  snapshot: ProductContextSnapshot,
  state: ProductContextState
): boolean {
  return (
    state.acceptedRun ||
    snapshot.counts.pending > 0 ||
    snapshot.counts.indexed > 0 ||
    hasVerifiedWhatsAppHistory(snapshot.whatsappHistorySync) ||
    snapshot.sources.some(
      source =>
        source.index_status === "pending" || source.index_status === "indexed"
    )
  );
}

function toProductContextCrawlErrorCode(
  failureCode: CrawlStartFailureCode | null
): Exclude<ProductContextStartErrorCode, "whatsapp_history_failed"> | null {
  if (
    failureCode === "indexed_url_limit_exceeded" ||
    failureCode === "invalid_training_source"
  ) {
    return failureCode;
  }
  return failureCode === null ? null : "training_start_failed";
}

export function useProductContextController({
  workspaceId,
  onHandoffStateChange,
}: UseProductContextControllerParams): UseProductContextControllerResult {
  const [workspaceState, reactDispatch] = useReducer(
    workspaceOwnedProductContextReducer,
    {
      workspaceId,
      state: createInitialProductContextState(),
    }
  );
  const state = workspaceState.state;
  const stateRef = useRef(state);
  const mountedRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const observationControllerRef = useRef<AbortController | null>(null);
  const observationGenerationRef = useRef(0);
  const mutationControllerRef = useRef<AbortController | null>(null);
  const mutationGenerationRef = useRef(0);
  const readyTrackedRef = useRef(false);
  const activeWorkspaceIdRef = useRef(workspaceId);
  const selectionRef = useRef<StartProductContextTrainingInput>({
    websites: [],
    includeInstagram: false,
    includeWhatsapp: false,
  });
  const handoffCallbackRef = useRef(onHandoffStateChange);
  const publicState =
    workspaceState.workspaceId === workspaceId
      ? state
      : createInitialProductContextState();
  const semanticReady = deriveProductContextReadiness(publicState).ready;

  useEffect(() => {
    handoffCallbackRef.current = onHandoffStateChange;
  }, [onHandoffStateChange]);

  const dispatchState = useCallback(
    (action: ProductContextAction) => {
      if (!mountedRef.current || activeWorkspaceIdRef.current !== workspaceId) {
        return;
      }
      stateRef.current = productContextReducer(stateRef.current, action);
      reactDispatch({ workspaceId, action });
    },
    [workspaceId]
  );

  const cancelObservation = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    observationControllerRef.current?.abort();
    observationControllerRef.current = null;
    observationGenerationRef.current += 1;
  }, []);

  const cancelMutation = useCallback(() => {
    mutationControllerRef.current?.abort();
    mutationControllerRef.current = null;
    mutationGenerationRef.current += 1;
  }, []);

  const settleBoundedReads = useCallback(
    async <T extends readonly unknown[]>(
      ownerController: AbortController,
      timeoutMs: number,
      readers: { [Key in keyof T]: ProductContextReader<T[Key]> }
    ): Promise<BoundedReadResults<T>> => {
      const readController = new AbortController();
      let deadlineExpired = false;
      const abortRead = () => readController.abort();
      if (ownerController.signal.aborted) {
        abortRead();
      } else {
        ownerController.signal.addEventListener("abort", abortRead, {
          once: true,
        });
      }

      const deadlineTimer = setTimeout(
        () => {
          deadlineExpired = true;
          if (timerRef.current === deadlineTimer) timerRef.current = null;
          readController.abort();
        },
        Math.max(0, timeoutMs)
      );
      timerRef.current = deadlineTimer;

      let resolveAbort!: (result: BoundedReadResult<never>) => void;
      const abortResult = new Promise<BoundedReadResult<never>>(resolve => {
        resolveAbort = resolve;
      });
      const onReadAbort = () => {
        resolveAbort({ status: deadlineExpired ? "timed_out" : "aborted" });
      };
      if (readController.signal.aborted) {
        onReadAbort();
      } else {
        readController.signal.addEventListener("abort", onReadAbort, {
          once: true,
        });
      }

      const results = await Promise.all(
        readers.map(async reader => {
          const readResult = Promise.resolve()
            .then(() => reader(readController.signal))
            .then<BoundedReadResult<unknown>, BoundedReadResult<unknown>>(
              value => ({ status: "fulfilled", value }),
              reason => ({ status: "rejected", reason })
            );
          return Promise.race([readResult, abortResult]);
        })
      );

      if (timerRef.current === deadlineTimer) {
        clearTimeout(deadlineTimer);
        timerRef.current = null;
      }
      ownerController.signal.removeEventListener("abort", abortRead);
      readController.signal.removeEventListener("abort", onReadAbort);
      return results as unknown as BoundedReadResults<T>;
    },
    []
  );

  const fetchCrawlProgress = useCallback(
    async (signal: AbortSignal): Promise<ProductContextSnapshot> => {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/onboarding/crawl`,
        { signal }
      );
      if (!response.ok) {
        throw new Error("training_progress_unavailable");
      }
      const payload = await response.json();
      return parseProgressPayload(payload, snapshotFromState(stateRef.current));
    },
    [workspaceId]
  );

  const fetchConnectedSources = useCallback(
    async (signal: AbortSignal): Promise<ConnectedSources> => {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/integrations`,
        { signal }
      );
      if (!response.ok) throw new Error("integrations_unavailable");
      const payload = await readJsonRecord(response);
      const sourceTypes = new Set<string>();
      if (Array.isArray(payload.sources)) {
        for (const source of payload.sources) {
          if (isRecord(source) && typeof source.type === "string") {
            sourceTypes.add(source.type);
          }
        }
      }
      return {
        instagram: sourceTypes.has("instagram"),
        whatsapp: sourceTypes.has("whatsapp"),
      };
    },
    [workspaceId]
  );

  const fetchWhatsAppStatus = useCallback(
    async (
      signal: AbortSignal
    ): Promise<{
      whatsappStatusKnown: true;
      whatsappHistoryEligible: boolean;
      whatsappHistoryRequested: boolean;
      whatsappHistorySync: WhatsAppHistorySyncState | null;
      whatsappHistoryCanRequest: boolean;
    }> => {
      const response = await fetch(
        `/api/whatsapp/smb-app-data?workspaceId=${encodeURIComponent(workspaceId)}`,
        { signal }
      );
      if (!response.ok) throw new Error("whatsapp_status_unavailable");
      const payload = await readJsonRecord(response);
      const data = isRecord(payload.data) ? payload.data : {};
      const historySync = isRecord(data.history_sync)
        ? (data.history_sync as WhatsAppHistorySyncState)
        : null;
      return {
        whatsappStatusKnown: true,
        whatsappHistoryEligible: data.history_sync_eligible === true,
        whatsappHistoryRequested:
          typeof historySync?.requested_at === "string" ||
          Boolean(
            historySync?.request_state &&
              historySync.request_state !== "rejected"
          ),
        whatsappHistorySync: historySync,
        whatsappHistoryCanRequest: data.history_sync_can_request === true,
      };
    },
    [workspaceId]
  );

  const fetchProgress = useCallback(
    (signal: AbortSignal): Promise<ProductContextSnapshot> => {
      if (!stateRef.current.connected.whatsapp)
        return fetchCrawlProgress(signal);
      return Promise.allSettled([
        fetchCrawlProgress(signal),
        fetchWhatsAppStatus(signal),
      ]).then(([crawl, whatsapp]) => {
        if (crawl.status !== "fulfilled") throw crawl.reason;
        return {
          ...crawl.value,
          ...(whatsapp.status === "fulfilled" ? whatsapp.value : {}),
        };
      });
    },
    [fetchCrawlProgress, fetchWhatsAppStatus]
  );

  const trackReadiness = useCallback(
    (snapshot: ProductContextSnapshot) => {
      const readiness = deriveProductContextReadiness(snapshot);
      if (
        readiness.ready &&
        hasDurableTrainingEvidence(snapshot, stateRef.current) &&
        !readyTrackedRef.current
      ) {
        readyTrackedRef.current = true;
        captureOnboardingAnalytics({
          workspaceId,
          event: "onboarding_training_ready",
          stepId: "product_context_ready",
          metadata: {
            website_count: selectionRef.current.websites.length,
            has_website: selectionRef.current.websites.length > 0,
            include_instagram: selectionRef.current.includeInstagram,
            include_whatsapp: selectionRef.current.includeWhatsapp,
            connected_instagram: snapshot.connected.instagram,
            connected_whatsapp: snapshot.connected.whatsapp,
            whatsapp_history_eligible: snapshot.whatsappHistoryEligible,
            whatsapp_history_requested: snapshot.whatsappHistoryRequested,
            ready_context_source: readiness.source,
          },
        });
      }
      return readiness;
    },
    [workspaceId]
  );

  const beginObservation = useCallback(() => {
    cancelObservation();
    const generation = observationGenerationRef.current;
    const controller = new AbortController();
    observationControllerRef.current = controller;
    const startedAt = Date.now();
    let backoffIndex = 0;

    const ownsGeneration = () =>
      mountedRef.current &&
      generation === observationGenerationRef.current &&
      observationControllerRef.current === controller &&
      !controller.signal.aborted;

    const scheduleNext = () => {
      if (!ownsGeneration()) return;
      const backoff = POLL_BACKOFF_MS[backoffIndex];
      if (backoff === undefined) {
        cancelObservation();
        dispatchState({ type: "observation_expired" });
        return;
      }
      const delay = Math.min(
        backoff,
        Math.max(0, FOREGROUND_OBSERVATION_MS - (Date.now() - startedAt))
      );

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (!ownsGeneration()) return;
        if (Date.now() - startedAt >= FOREGROUND_OBSERVATION_MS) {
          cancelObservation();
          dispatchState({ type: "observation_expired" });
          return;
        }

        void settleBoundedReads(
          controller,
          Math.max(0, FOREGROUND_OBSERVATION_MS - (Date.now() - startedAt)),
          [signal => fetchProgress(signal)] as const
        ).then(([progressResult]) => {
          if (!ownsGeneration()) return;
          if (progressResult.status === "timed_out") {
            cancelObservation();
            dispatchState({ type: "observation_expired" });
            return;
          }
          if (progressResult.status !== "fulfilled") {
            dispatchState({
              type: "poll_failed",
              code: "training_progress_unavailable",
            });
            cancelObservation();
            return;
          }

          const snapshot = progressResult.value;
          dispatchState({ type: "poll_succeeded", snapshot });
          const readiness = trackReadiness(snapshot);

          if (!shouldContinueObservation(snapshot, stateRef.current)) {
            cancelObservation();
            if (readiness.ready) dispatchState({ type: "ready" });
            return;
          }

          backoffIndex += 1;
          if (
            backoffIndex >= POLL_BACKOFF_MS.length ||
            Date.now() - startedAt >= FOREGROUND_OBSERVATION_MS
          ) {
            cancelObservation();
            dispatchState({ type: "observation_expired" });
            return;
          }
          scheduleNext();
        });
      }, delay);
    };

    scheduleNext();
  }, [
    cancelObservation,
    dispatchState,
    fetchProgress,
    settleBoundedReads,
    trackReadiness,
  ]);

  const checkAgain = useCallback((): Promise<void> => {
    if (stateRef.current.phase === "starting") return Promise.resolve();
    cancelObservation();
    const generation = observationGenerationRef.current;
    const controller = new AbortController();
    observationControllerRef.current = controller;

    return settleBoundedReads(controller, PRODUCT_CONTEXT_READ_TIMEOUT_MS, [
      signal => fetchProgress(signal),
    ] as const).then(([progressResult]) => {
      if (
        !mountedRef.current ||
        generation !== observationGenerationRef.current ||
        observationControllerRef.current !== controller ||
        controller.signal.aborted
      ) {
        return;
      }

      if (progressResult.status === "timed_out") {
        const snapshot = snapshotFromState(stateRef.current);
        if (shouldContinueObservation(snapshot, stateRef.current)) {
          dispatchState({ type: "poll_succeeded", snapshot });
          beginObservation();
        } else {
          dispatchState({
            type: "poll_failed",
            code: "training_progress_unavailable",
          });
          cancelObservation();
        }
        return;
      }
      if (progressResult.status !== "fulfilled") {
        dispatchState({
          type: "poll_failed",
          code: "training_progress_unavailable",
        });
        cancelObservation();
        return;
      }

      const snapshot = progressResult.value;
      dispatchState({ type: "poll_succeeded", snapshot });
      const readiness = trackReadiness(snapshot);
      if (shouldContinueObservation(snapshot, stateRef.current)) {
        beginObservation();
      } else {
        cancelObservation();
        if (readiness.ready) dispatchState({ type: "ready" });
      }
    });
  }, [
    beginObservation,
    cancelObservation,
    dispatchState,
    fetchProgress,
    settleBoundedReads,
    trackReadiness,
  ]);

  const requestWhatsAppHistory = useCallback(
    async (signal: AbortSignal): Promise<WhatsAppStartResult> => {
      try {
        const response = await fetch("/api/whatsapp/smb-app-data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            syncType: "history",
            rangeValue: WHATSAPP_HISTORY_RANGE_DAYS,
            rangeUnit: "days",
          }),
          signal,
        });
        const payload = await readJsonRecord(response);
        const resultData = isRecord(payload.data) ? payload.data : {};
        const historySync = isRecord(resultData.history_sync)
          ? (resultData.history_sync as WhatsAppHistorySyncState)
          : null;

        if (response.status === 409) {
          if (payload.error_code === "already_requested") {
            return { accepted: true, historyRequested: true, historySync };
          }
          if (payload.error_code === "not_coexistence") {
            return { accepted: true, historyEligible: false };
          }
        }
        if (!response.ok) {
          if (!historySync) {
            return {
              accepted: true,
              historyRequested: true,
              historySync: {
                ...stateRef.current.whatsappHistorySync,
                request_state: "unknown",
                request_attempted_at: new Date().toISOString(),
              },
            };
          }
          return {
            accepted: Boolean(
              historySync?.request_state &&
                historySync.request_state !== "rejected"
            ),
            historyRequested: Boolean(
              historySync?.request_state &&
                historySync.request_state !== "rejected"
            ),
            historySync,
            historyCanRequest:
              getWhatsAppHistoryRequestAvailability(historySync).canRequest,
          };
        }
        return {
          accepted: true,
          historyRequested: true,
          historySync: historySync ?? {
            ...stateRef.current.whatsappHistorySync,
            requested_at: new Date().toISOString(),
            request_state: "accepted",
            status: "requested",
          },
        };
      } catch {
        return {
          accepted: true,
          historyRequested: true,
          historySync: {
            ...stateRef.current.whatsappHistorySync,
            request_state: "unknown",
            request_attempted_at: new Date().toISOString(),
          },
        };
      }
    },
    [workspaceId]
  );

  const requestCrawlStart = useCallback(
    async (
      input: StartProductContextTrainingInput,
      signal: AbortSignal
    ): Promise<CrawlStartResult> => {
      try {
        const response = await fetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/onboarding/crawl`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              websites: input.websites,
              includeInstagram:
                input.includeInstagram && stateRef.current.connected.instagram,
            }),
            signal,
          }
        );
        if (response.status === 202 && response.ok) {
          return {
            accepted: true,
            shouldObserve: true,
            failureCode: null,
          };
        }

        const payload = await readJsonRecord(response);
        if (
          response.status === 400 &&
          payload.code !== "background_processing_unavailable" &&
          payload.code !== "training_start_failed"
        ) {
          return {
            accepted: false,
            shouldObserve: false,
            failureCode:
              payload.code === "indexed_url_limit_exceeded"
                ? "indexed_url_limit_exceeded"
                : "invalid_training_source",
          };
        }

        if (
          payload.code === "background_processing_unavailable" ||
          payload.code === "training_start_failed"
        ) {
          return {
            accepted: false,
            shouldObserve: true,
            failureCode: payload.code,
          };
        }

        return {
          accepted: false,
          shouldObserve: response.status >= 500,
          failureCode: "training_start_failed",
        };
      } catch {
        return {
          accepted: false,
          shouldObserve: true,
          failureCode: "training_start_failed",
        };
      }
    },
    [workspaceId]
  );

  const startTraining = useCallback(
    (rawInput: StartProductContextTrainingInput): Promise<void> => {
      cancelObservation();
      cancelMutation();
      const mutationGeneration = mutationGenerationRef.current;
      const controller = new AbortController();
      mutationControllerRef.current = controller;
      const input: StartProductContextTrainingInput = {
        websites: rawInput.websites.reduce<string[]>((websites, website) => {
          const normalized = website.trim();
          if (normalized) websites.push(normalized);
          return websites;
        }, []),
        includeInstagram: rawInput.includeInstagram,
        includeWhatsapp: rawInput.includeWhatsapp,
      };
      selectionRef.current = input;
      dispatchState({ type: "start_requested" });

      const current = stateRef.current;
      const whatsappSelected =
        input.includeWhatsapp && current.connected.whatsapp;
      const historyNeeded =
        whatsappSelected &&
        !current.whatsappHistoryRequested &&
        current.whatsappHistoryCanRequest === true;
      const whatsappAlreadyUsable =
        whatsappSelected &&
        current.whatsappStatusKnown &&
        (!current.whatsappHistoryEligible ||
          isWhatsAppHistorySyncActive(current.whatsappHistorySync) ||
          hasVerifiedWhatsAppHistory(current.whatsappHistorySync));
      const crawlNeeded =
        input.websites.length > 0 ||
        (input.includeInstagram && current.connected.instagram);

      captureOnboardingAnalytics({
        workspaceId,
        event: "onboarding_training_started",
        stepId: "product_context_training",
        metadata: {
          website_count: input.websites.length,
          has_website: input.websites.length > 0,
          include_instagram:
            input.includeInstagram && current.connected.instagram,
          include_whatsapp: whatsappSelected,
          connected_instagram: current.connected.instagram,
          connected_whatsapp: current.connected.whatsapp,
          whatsapp_history_eligible: current.whatsappHistoryEligible,
          whatsapp_history_requested: current.whatsappHistoryRequested,
        },
      });

      return settleBoundedReads(controller, START_TRAINING_TIMEOUT_MS, [
        signal =>
          historyNeeded
            ? requestWhatsAppHistory(signal)
            : Promise.resolve<WhatsAppStartResult>({
                accepted: whatsappAlreadyUsable,
              }),
        signal =>
          crawlNeeded
            ? requestCrawlStart(input, signal)
            : Promise.resolve<CrawlStartResult>({
                accepted: false,
                shouldObserve: false,
                failureCode: null,
              }),
      ] as const).then(([whatsappSettled, crawlSettled]) => {
        if (
          !mountedRef.current ||
          mutationGeneration !== mutationGenerationRef.current ||
          mutationControllerRef.current !== controller ||
          controller.signal.aborted
        ) {
          return;
        }
        mutationControllerRef.current = null;

        const whatsappResult: WhatsAppStartResult =
          whatsappSettled.status === "fulfilled"
            ? whatsappSettled.value
            : historyNeeded
              ? {
                  accepted: true,
                  historyRequested: true,
                  historySync: {
                    ...current.whatsappHistorySync,
                    request_state: "unknown",
                    request_attempted_at: new Date().toISOString(),
                  },
                }
              : { accepted: false };
        const crawlResult: CrawlStartResult =
          crawlSettled.status === "fulfilled"
            ? crawlSettled.value
            : {
                accepted: false,
                shouldObserve: crawlNeeded,
                failureCode: crawlNeeded ? "training_start_failed" : null,
              };

        if (
          whatsappResult.historyEligible !== undefined ||
          whatsappResult.historyRequested !== undefined
        ) {
          const snapshot = snapshotFromState(stateRef.current);
          dispatchState({
            type: "poll_succeeded",
            snapshot: {
              ...snapshot,
              whatsappStatusKnown: true,
              whatsappHistoryEligible:
                whatsappResult.historyEligible ??
                snapshot.whatsappHistoryEligible,
              whatsappHistoryRequested:
                whatsappResult.historyRequested ??
                snapshot.whatsappHistoryRequested,
              whatsappHistorySync:
                whatsappResult.historySync ?? snapshot.whatsappHistorySync,
              whatsappHistoryCanRequest:
                whatsappResult.historyCanRequest ?? false,
            },
          });
        }

        const accepted = whatsappResult.accepted || crawlResult.accepted;
        const crawlErrorCode = toProductContextCrawlErrorCode(
          crawlResult.failureCode
        );
        if (!accepted && !crawlResult.shouldObserve) {
          const code =
            whatsappSelected && !crawlNeeded
              ? "whatsapp_history_failed"
              : (crawlErrorCode ?? "training_start_failed");
          dispatchState({ type: "start_failed", code });
          captureOnboardingAnalytics({
            workspaceId,
            event: "onboarding_training_failed",
            stepId: "product_context_training",
            metadata: { error_type: code },
          });
          return;
        }

        // A timeout or post-persistence failure can hide a started crawl, so
        // observation owns the result until progress becomes terminal/bounded.
        dispatchState({
          type: "start_accepted",
          awaitingCrawlProgress: crawlResult.shouldObserve,
        });
        const snapshot = snapshotFromState(stateRef.current);
        const readiness = trackReadiness(snapshot);
        if (crawlResult.shouldObserve) {
          beginObservation();
        } else if (crawlErrorCode) {
          dispatchState({ type: "start_failed", code: crawlErrorCode });
          captureOnboardingAnalytics({
            workspaceId,
            event: "onboarding_training_failed",
            stepId: "product_context_training",
            metadata: { error_type: crawlErrorCode },
          });
        } else if (isWhatsAppHistorySyncActive(snapshot.whatsappHistorySync)) {
          beginObservation();
        } else if (readiness.ready) {
          dispatchState({ type: "ready" });
        }
      });
    },
    [
      beginObservation,
      cancelMutation,
      cancelObservation,
      dispatchState,
      requestCrawlStart,
      requestWhatsAppHistory,
      settleBoundedReads,
      trackReadiness,
      workspaceId,
    ]
  );

  useEffect(() => {
    const handoff: ProductTrainingHandoffState = {
      mutationPending: publicState.phase === "starting",
      started:
        publicState.acceptedRun ||
        publicState.counts.total > 0 ||
        publicState.whatsappHistoryRequested,
      ready: semanticReady,
      background: publicState.phase === "background",
    };
    handoffCallbackRef.current?.(handoff);
  }, [
    publicState.acceptedRun,
    publicState.counts.total,
    publicState.phase,
    publicState.whatsappHistoryRequested,
    semanticReady,
    workspaceId,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    cancelObservation();
    cancelMutation();
    activeWorkspaceIdRef.current = workspaceId;
    dispatchState({ type: "reset" });
    readyTrackedRef.current = false;
    selectionRef.current = {
      websites: [],
      includeInstagram: false,
      includeWhatsapp: false,
    };
    const generation = observationGenerationRef.current;
    const controller = new AbortController();
    observationControllerRef.current = controller;

    void settleBoundedReads(controller, PRODUCT_CONTEXT_READ_TIMEOUT_MS, [
      signal => fetchProgress(signal),
      signal => fetchConnectedSources(signal),
      signal => fetchWhatsAppStatus(signal),
    ] as const).then(([progressResult, connectedResult, whatsappResult]) => {
      if (
        !mountedRef.current ||
        generation !== observationGenerationRef.current ||
        observationControllerRef.current !== controller ||
        controller.signal.aborted
      ) {
        return;
      }

      const currentSnapshot = snapshotFromState(stateRef.current);
      const optionalSnapshot = {
        connected:
          connectedResult.status === "fulfilled"
            ? connectedResult.value
            : currentSnapshot.connected,
        ...(whatsappResult.status === "fulfilled"
          ? whatsappResult.value
          : {
              whatsappStatusKnown: currentSnapshot.whatsappStatusKnown,
              whatsappHistoryEligible: currentSnapshot.whatsappHistoryEligible,
              whatsappHistoryRequested:
                currentSnapshot.whatsappHistoryRequested,
            }),
      };
      if (progressResult.status !== "fulfilled") {
        const snapshot: ProductContextSnapshot = {
          ...currentSnapshot,
          ...optionalSnapshot,
        };
        if (snapshot.connected.whatsapp && snapshot.whatsappHistoryRequested) {
          selectionRef.current = {
            ...selectionRef.current,
            includeWhatsapp: true,
          };
        }
        observationControllerRef.current = null;
        dispatchState({
          type: "load_succeeded",
          snapshot,
        });
        trackReadiness(snapshot);
        dispatchState({
          type: "load_failed",
          code: "training_progress_unavailable",
        });
        return;
      }

      const snapshot: ProductContextSnapshot = {
        ...progressResult.value,
        ...optionalSnapshot,
      };
      if (snapshot.connected.whatsapp && snapshot.whatsappHistoryRequested) {
        selectionRef.current = {
          ...selectionRef.current,
          includeWhatsapp: true,
        };
      }
      observationControllerRef.current = null;
      dispatchState({ type: "load_succeeded", snapshot });
      const readiness = trackReadiness(snapshot);
      if (
        snapshot.counts.pending > 0 ||
        isWhatsAppHistorySyncActive(snapshot.whatsappHistorySync)
      ) {
        dispatchState({ type: "poll_succeeded", snapshot });
        beginObservation();
      } else if (readiness.ready) {
        dispatchState({ type: "ready" });
      }
    });

    return () => {
      mountedRef.current = false;
      cancelObservation();
      cancelMutation();
    };
  }, [
    beginObservation,
    cancelMutation,
    cancelObservation,
    dispatchState,
    fetchConnectedSources,
    fetchProgress,
    fetchWhatsAppStatus,
    settleBoundedReads,
    trackReadiness,
    workspaceId,
  ]);

  return { state: publicState, startTraining, checkAgain };
}
