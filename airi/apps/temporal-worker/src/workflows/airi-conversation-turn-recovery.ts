import {
  AIRI_TURN_PREPARATION_NOT_STARTED,
  AIRI_COMPANY_CAPACITY_DEFERRED,
  AIRI_TURN_PREPARATION_OUTCOME_UNKNOWN,
  AIRI_OUTBOUND_PREPARATION_FAILED,
  AIRI_OUTBOUND_PROVIDER_REJECTED_RETRYABLE,
  getAiriConversationTurnKey,
  type AiriConversationTurnDisposition,
  type AiriConversationTurnDispositionStatus,
  type AiriConversationTurnLifecycleSnapshot,
  type AiriConversationTurnProcessResult,
  type AiriConversationTurnRetryWork,
  type AiriConversationTurnStage,
} from "@icecore/temporal";
import { nextAiriConversationRetryAt } from "./airi-conversation-retry.js";

export const nextTurnRetryAt = nextAiriConversationRetryAt;
export const MAX_TURN_RECOVERY_ATTEMPTS = 5;
const RECENT_DISPOSITIONS_LIMIT = 256;

const isKnownUnsentFailureType = (type: unknown) =>
  type === AIRI_OUTBOUND_PREPARATION_FAILED ||
  type === AIRI_OUTBOUND_PROVIDER_REJECTED_RETRYABLE;

function hasFailureType(
  error: unknown,
  matches: (type: unknown) => boolean,
): boolean {
  let cause = error;
  const visited = new Set<unknown>();
  while (cause && typeof cause === "object" && !visited.has(cause)) {
    visited.add(cause);
    const failure = cause as { type?: unknown; cause?: unknown };
    if (matches(failure.type)) return true;
    cause = failure.cause;
  }
  return false;
}

export const isKnownUnsentDeliveryFailure = (error: unknown) =>
  hasFailureType(error, isKnownUnsentFailureType);
export const isCompanyCapacityDeferredFailure = (error: unknown) =>
  hasFailureType(error, (type) => type === AIRI_COMPANY_CAPACITY_DEFERRED);

export class TurnDispositionError extends Error {
  constructor(
    message: string,
    readonly disposition: AiriConversationTurnDispositionStatus,
  ) {
    super(message);
  }
}

export function classifyTurnFailure(
  stage: AiriConversationTurnStage,
  error: unknown,
  options?: {
    retryKnownUnsentDelivery?: boolean;
    retryCompanyCapacity?: boolean;
  },
): AiriConversationTurnDispositionStatus {
  if (error instanceof TurnDispositionError) return error.disposition;
  let cause = error;
  let nonRetryable = false;
  const visited = new Set<unknown>();
  while (cause && typeof cause === "object" && !visited.has(cause)) {
    visited.add(cause);
    const failure = cause as {
      type?: unknown;
      nonRetryable?: unknown;
      cause?: unknown;
    };
    if (
      stage === "prepare" &&
      failure.type === AIRI_TURN_PREPARATION_NOT_STARTED
    )
      return "retryable";
    if (
      stage === "prepare" &&
      options?.retryCompanyCapacity &&
      failure.type === AIRI_COMPANY_CAPACITY_DEFERRED
    )
      return "retryable";
    if (failure.type === AIRI_TURN_PREPARATION_OUTCOME_UNKNOWN)
      return "outcome_unknown";
    if (
      stage === "delivery" &&
      options?.retryKnownUnsentDelivery &&
      isKnownUnsentFailureType(failure.type)
    )
      return "retryable";
    nonRetryable ||= failure.nonRetryable === true;
    cause = failure.cause;
  }
  if (nonRetryable) return "terminal";
  // Only planning is read-only. A lost preparation/delivery response is ambiguous.
  return stage === "timer_plan" ? "retryable" : "outcome_unknown";
}

export function getPreparedTurnFailure(
  process: AiriConversationTurnProcessResult,
): "terminal" | "outcome_unknown" | null {
  const status = process.outcome.responseStatus;
  if (status !== null && status >= 500) return "outcome_unknown";
  if (status !== null && status >= 400) return "terminal";
  if (process.outcome.executionStatus === "failed") return "outcome_unknown";
  return null;
}

export function createTurnRecovery(
  snapshot?: AiriConversationTurnLifecycleSnapshot | null,
) {
  let retries = [...(snapshot?.retries || [])];
  let recentDispositions = [...(snapshot?.recentDispositions || [])].slice(
    -RECENT_DISPOSITIONS_LIMIT,
  );
  return {
    schedule(work: AiriConversationTurnRetryWork) {
      retries = retries.filter(
        (item) =>
          getAiriConversationTurnKey(item.turn) !==
          getAiriConversationTurnKey(work.turn),
      );
      retries.push(work);
    },
    takeReady(nowMs: number): AiriConversationTurnRetryWork | null {
      const index = retries.findIndex((item) => item.dueAtMs <= nowMs);
      return index < 0 ? null : retries.splice(index, 1)[0];
    },
    hasReady(nowMs: number) {
      return retries.some((item) => item.dueAtMs <= nowMs);
    },
    hasMessage(turnKey: string) {
      return retries.some(
        (item) => getAiriConversationTurnKey(item.turn) === turnKey,
      );
    },
    nextDueAtMs(): number | null {
      return retries.length
        ? Math.min(...retries.map((item) => item.dueAtMs))
        : null;
    },
    hasUnstartedRetry(
      matches: (work: AiriConversationTurnRetryWork) => boolean,
    ): boolean {
      return retries.some((item) => item.stage === "prepare" && matches(item));
    },
    /**
     * Removes and returns the earliest-scheduled unstarted retry that
     * matches, whether or not its backoff has passed.
     */
    takeUnstartedRetry(
      matches: (work: AiriConversationTurnRetryWork) => boolean,
    ): AiriConversationTurnRetryWork | null {
      const index = retries.findIndex(
        (item) => item.stage === "prepare" && matches(item),
      );
      return index < 0 ? null : retries.splice(index, 1)[0];
    },
    /** A fresh turn can replace unstarted work and delivery proven not sent. */
    takeSupersedableRetries(
      supersedable: (work: AiriConversationTurnRetryWork) => boolean = () =>
        true,
    ): AiriConversationTurnRetryWork[] {
      const unstarted = retries.filter(
        (item) =>
          (item.stage === "prepare" ||
            (item.stage === "delivery" &&
              item.deliveryNotAttempted === true)) &&
          supersedable(item),
      );
      retries = retries.filter((item) => !unstarted.includes(item));
      return unstarted;
    },
    record(disposition: AiriConversationTurnDisposition) {
      recentDispositions = recentDispositions.filter(
        (item) =>
          getAiriConversationTurnKey(item.turn) !==
          getAiriConversationTurnKey(disposition.turn),
      );
      recentDispositions.push(disposition);
      recentDispositions = recentDispositions.slice(-RECENT_DISPOSITIONS_LIMIT);
    },
    snapshot(): AiriConversationTurnLifecycleSnapshot {
      return {
        version: 1,
        retries: [...retries],
        recentDispositions: [...recentDispositions],
      };
    },
  };
}

export type TurnRecovery = ReturnType<typeof createTurnRecovery>;
