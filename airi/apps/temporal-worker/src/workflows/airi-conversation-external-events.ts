import type {
  AiriConversationControlExternalEvent,
  AiriConversationExternalEvent,
  AiriConversationExternalEventLifecycleSnapshot,
  AiriConversationExternalEventRetryItem,
  AiriConversationPaymentConfirmedEvent,
  AiriConversationTurnRetryWork,
} from "@icecore/temporal";
import { nextAiriConversationRetryAt } from "./airi-conversation-retry.js";

export const AIRI_CONVERSATION_EXTERNAL_EVENT_HISTORY_LIMIT = 256;
export const AIRI_CONVERSATION_EXTERNAL_EVENT_PENDING_LIMIT = 256;

const MAX_RETRY_ATTEMPT = 1_000_000;

type ExternalEventQueueItem = AiriConversationExternalEventRetryItem & {
  key: string;
};

export type AiriConversationExternalEventReady = Omit<
  ExternalEventQueueItem,
  "dueAtMs"
>;

export type AiriConversationExternalEventEnqueueResult = {
  classification: "enqueued" | "duplicate" | "capacity_exceeded";
  key: string;
};

export type AiriConversationExternalEventCompletion =
  | {
      classification: "control_processed";
      key: string;
    }
  | {
      classification: "generative_processed" | "payment_processed";
      key: string;
    };

export type AiriConversationExternalEventFailure =
  | {
      classification: "control_dropped";
      key: string;
    }
  | {
      classification: "generative_requeued" | "payment_requeued";
      key: string;
      attempt: number;
      dueAtMs: number;
    }
  | {
      classification: "timer_replan_requeued";
      key: string;
      attempt: number;
      dueAtMs: number;
    };

export type AiriConversationExternalEventLifecycle = {
  enqueue(
    event: AiriConversationExternalEvent,
    nowMs: number,
  ): AiriConversationExternalEventEnqueueResult;
  hasReady(nowMs: number): boolean;
  takeReady(nowMs: number): AiriConversationExternalEventReady | null;
  checkpointPayment(
    event: AiriConversationPaymentConfirmedEvent,
    work?: AiriConversationTurnRetryWork,
  ): void;
  completeInFlight(): AiriConversationExternalEventCompletion | null;
  failInFlight(
    nowMs: number,
    retryTimerReplan?: boolean,
  ): AiriConversationExternalEventFailure | null;
  nextDueAtMs(): number | null;
  snapshot(): AiriConversationExternalEventLifecycleSnapshot;
};

function isGenerativeEvent(
  event: AiriConversationExternalEvent,
): event is Extract<
  AiriConversationExternalEvent,
  { kind: "generative_ai_result" }
> {
  return event.kind === "generative_ai_result";
}

function isControlEvent(
  event: AiriConversationExternalEvent,
): event is AiriConversationControlExternalEvent {
  return event.kind === "human_outbound" || event.kind === "timer_replan";
}

function buildEventKey(event: AiriConversationExternalEvent): string {
  if (event.kind === "payment_confirmed")
    return `payment_confirmed:${event.conversionId}`;
  return isGenerativeEvent(event)
    ? `generative_ai_result:${event.executionId}`
    : `${event.kind}:${event.messageId}`;
}

function assertNowMs(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("nowMs must be a non-negative safe integer");
  }
}

function normalizeAttempt(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) return 0;
  return Math.min(value, MAX_RETRY_ATTEMPT);
}

function normalizeDueAtMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) return 0;
  return value;
}

function limitRecentKeys(keys: readonly string[]): string[] {
  const unique = Array.from(
    new Set(keys.filter((key) => typeof key === "string" && key.length > 0)),
  );
  return unique.slice(-AIRI_CONVERSATION_EXTERNAL_EVENT_HISTORY_LIMIT);
}

function normalizeQueueItem(
  item: AiriConversationExternalEventRetryItem,
): ExternalEventQueueItem {
  return {
    key: buildEventKey(item.event),
    event: item.event,
    attempt: normalizeAttempt(item.attempt),
    dueAtMs: normalizeDueAtMs(item.dueAtMs),
    ...(item.event.kind === "payment_confirmed" && item.paymentTurnWork
      ? { paymentTurnWork: item.paymentTurnWork }
      : {}),
  };
}

function addHistoryKey(keys: string[], keySet: Set<string>, key: string): void {
  if (keySet.has(key)) return;
  keys.push(key);
  keySet.add(key);
}

export function createAiriConversationExternalEventLifecycle(
  snapshot?: AiriConversationExternalEventLifecycleSnapshot | null,
): AiriConversationExternalEventLifecycle {
  const controlSeenKeys = limitRecentKeys(snapshot?.controlSeenKeys ?? []);
  const processedGenerativeKeys = limitRecentKeys(
    snapshot?.processedGenerativeKeys ?? [],
  );
  const controlSeenKeySet = new Set(controlSeenKeys);
  const processedGenerativeKeySet = new Set(processedGenerativeKeys);
  const processedPaymentKeys = limitRecentKeys(
    snapshot?.processedPaymentKeys ?? [],
  );
  const processedPaymentKeySet = new Set(processedPaymentKeys);
  const restoredItems = [
    ...(snapshot?.inFlight ? [snapshot.inFlight] : []),
    ...(snapshot?.queued ?? []),
  ];
  const restoredKeySet = new Set<string>();
  const queued: ExternalEventQueueItem[] = [];
  let restoredGenerativeCount = 0;

  for (const rawItem of restoredItems) {
    if (!rawItem?.event) continue;
    const item = normalizeQueueItem(rawItem);
    if (
      restoredKeySet.has(item.key) ||
      (isGenerativeEvent(item.event) &&
        processedGenerativeKeySet.has(item.key)) ||
      (item.event.kind === "payment_confirmed" &&
        processedPaymentKeySet.has(item.key))
    ) {
      continue;
    }
    if (
      isGenerativeEvent(item.event) &&
      restoredGenerativeCount >= AIRI_CONVERSATION_EXTERNAL_EVENT_PENDING_LIMIT
    ) {
      continue;
    }
    restoredKeySet.add(item.key);
    queued.push(item);
    if (isGenerativeEvent(item.event)) {
      restoredGenerativeCount += 1;
    }
    if (isControlEvent(item.event)) {
      addHistoryKey(controlSeenKeys, controlSeenKeySet, item.key);
    }
  }

  let inFlight: ExternalEventQueueItem | null = null;

  const hasActiveKey = (key: string): boolean =>
    inFlight?.key === key || queued.some((item) => item.key === key);

  return {
    enqueue(event, nowMs) {
      assertNowMs(nowMs);
      const key = buildEventKey(event);
      const duplicate = isGenerativeEvent(event)
        ? processedGenerativeKeySet.has(key) || hasActiveKey(key)
        : event.kind === "payment_confirmed"
          ? processedPaymentKeySet.has(key) || hasActiveKey(key)
          : controlSeenKeySet.has(key);
      if (duplicate) {
        return { classification: "duplicate", key };
      }
      const generativePendingCount =
        queued.filter((item) => isGenerativeEvent(item.event)).length +
        (inFlight && isGenerativeEvent(inFlight.event) ? 1 : 0);
      if (
        isGenerativeEvent(event) &&
        generativePendingCount >= AIRI_CONVERSATION_EXTERNAL_EVENT_PENDING_LIMIT
      ) {
        return { classification: "capacity_exceeded", key };
      }

      if (isControlEvent(event)) {
        addHistoryKey(controlSeenKeys, controlSeenKeySet, key);
      }
      queued.push({ key, event, attempt: 0, dueAtMs: nowMs });
      return { classification: "enqueued", key };
    },

    hasReady(nowMs) {
      assertNowMs(nowMs);
      return (
        !inFlight && queued.some((queueItem) => queueItem.dueAtMs <= nowMs)
      );
    },

    takeReady(nowMs) {
      assertNowMs(nowMs);
      if (inFlight) return null;
      const readyIndex = queued.findIndex(
        (queueItem) => queueItem.dueAtMs <= nowMs,
      );
      if (readyIndex < 0) return null;

      inFlight = queued.splice(readyIndex, 1)[0] ?? null;
      if (!inFlight) return null;
      const { dueAtMs: _dueAtMs, ...ready } = inFlight;
      return ready;
    },

    checkpointPayment(event, work) {
      if (
        inFlight?.event.kind !== "payment_confirmed" ||
        inFlight.key !== buildEventKey(event)
      ) {
        throw new Error(
          "Payment checkpoint does not match the in-flight event",
        );
      }
      inFlight.event = event;
      if (work) inFlight.paymentTurnWork = work;
      else delete inFlight.paymentTurnWork;
    },

    completeInFlight() {
      const completed = inFlight;
      inFlight = null;
      if (!completed) return null;

      if (completed.event.kind === "payment_confirmed") {
        addHistoryKey(
          processedPaymentKeys,
          processedPaymentKeySet,
          completed.key,
        );
        while (
          processedPaymentKeys.length >
          AIRI_CONVERSATION_EXTERNAL_EVENT_HISTORY_LIMIT
        ) {
          processedPaymentKeySet.delete(processedPaymentKeys.shift()!);
        }
        return { classification: "payment_processed", key: completed.key };
      }

      if (isGenerativeEvent(completed.event)) {
        addHistoryKey(
          processedGenerativeKeys,
          processedGenerativeKeySet,
          completed.key,
        );
        return {
          classification: "generative_processed",
          key: completed.key,
        };
      }

      return {
        classification: "control_processed",
        key: completed.key,
      };
    },

    failInFlight(nowMs, retryTimerReplan = false) {
      assertNowMs(nowMs);
      const failed = inFlight;
      inFlight = null;
      if (!failed) return null;

      if (
        isControlEvent(failed.event) &&
        (failed.event.kind !== "timer_replan" || !retryTimerReplan)
      ) {
        return {
          classification: "control_dropped",
          key: failed.key,
        };
      }

      const attempt = Math.min(failed.attempt + 1, MAX_RETRY_ATTEMPT);
      const dueAtMs = nextAiriConversationRetryAt(nowMs, attempt);
      if (failed.paymentTurnWork) {
        failed.paymentTurnWork.attempt = attempt;
        failed.paymentTurnWork.dueAtMs = dueAtMs;
      }
      queued.push({
        ...failed,
        attempt,
        dueAtMs,
      });
      return {
        classification:
          failed.event.kind === "timer_replan"
            ? "timer_replan_requeued"
            : failed.event.kind === "payment_confirmed"
              ? "payment_requeued"
              : "generative_requeued",
        key: failed.key,
        attempt,
        dueAtMs,
      };
    },

    nextDueAtMs() {
      if (queued.length === 0) return null;
      return queued.reduce(
        (earliest, queueItem) => Math.min(earliest, queueItem.dueAtMs),
        Number.MAX_SAFE_INTEGER,
      );
    },

    snapshot() {
      const toSnapshotItem = ({
        key: _key,
        ...item
      }: ExternalEventQueueItem): AiriConversationExternalEventRetryItem =>
        item;
      return {
        version: 1,
        queued: queued.map(toSnapshotItem),
        inFlight: inFlight ? toSnapshotItem(inFlight) : null,
        controlSeenKeys: limitRecentKeys(controlSeenKeys),
        processedGenerativeKeys: limitRecentKeys(processedGenerativeKeys),
        ...(processedPaymentKeys.length
          ? { processedPaymentKeys: [...processedPaymentKeys] }
          : {}),
      };
    },
  };
}
