import "server-only";

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import connectDB from "@/lib/mongoose";
import {
  claimAiriIngress,
  finishAiriIngressClaim,
  getAiriIngressRetryDate,
  type ClaimedAiriIngress,
} from "@/lib/temporal/airi-ingress-lease";
import { replanRemappedPostActionTimer } from "./recover";
import { buildTimerReplanMessageId } from "./identity";
import AiriTurnContext, {
  AIRI_TIMER_REPLAN_INGRESS_QUEUE_INDEX,
  AIRI_TIMER_REPLAN_INGRESS_SCENARIO_STATUS_INDEX,
  AIRI_TIMER_REPLAN_INGRESS_UNIQUE_INDEX,
  buildAiriIngressKeyFilter,
} from "@/models/airi-turn-context";
import type { ClientSession } from "mongoose";
import { readUniqueStringArray } from "@icecore/shared/lib/value-utils";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";

const TIMER_REPLAN_TRIGGER_KIND = "timer_replan";
const MAX_TIMER_REPLAN_INGRESS_ATTEMPTS = 5;
const MAX_TIMER_REPLAN_INGRESS_BATCH_SIZE = 50;
const COMPLETED_TIMER_REPLAN_INGRESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type TimerReplanIngressStatus = "pending" | "signaled" | "failed";

type TimerReplanIngressPayload = {
  expectedScenarioId: string;
  expectedConditionNodeId: string;
  expectedSourceActionNodeId: string;
  messageDate: Date;
  enqueuedAt: Date;
};

export type TimerReplanIngressDocument = {
  _id?: unknown;
  turnContextId: string;
  ingressKey: string;
  ingressStatus: TimerReplanIngressStatus;
  ingressAttempts: number;
  ingressNextRetryAt?: Date | null;
  ingressLeaseToken?: string | null;
  ingressLeaseExpiresAt?: Date | null;
  workspaceId: string;
  conversationId: string;
  messageId: string;
  triggerEventKind: typeof TIMER_REPLAN_TRIGGER_KIND;
  timerReplanIngress: TimerReplanIngressPayload;
  expiresAt?: Date | null;
};

export type TimerReplanIngressProcessSummary = {
  claimed: number;
  signaled: number;
  retryScheduled: number;
  failed: number;
  superseded: number;
  leaseLost: number;
};

export type OutstandingTimerReplanIngress = {
  status: "pending" | "failed" | null;
  affectedConversationIds: string[];
  hasMore: boolean;
};

type EnqueueTimerReplanIngressParams = {
  workspaceId: string;
  conversationId: string;
  expectedScenarioId: string;
  expectedConditionNodeId: string;
  expectedSourceActionNodeId: string;
  anchorId: string;
  messageDate: Date;
  enqueuedAt: Date;
  session?: ClientSession;
};

type ClaimedTimerReplanIngress = ClaimedAiriIngress<TimerReplanIngressDocument>;

export type ProcessedTimerReplanIngressStatus =
  | "signaled"
  | "superseded"
  | "retry_scheduled"
  | "failed"
  | "lease_lost";

export type TimerReplanIngressProcessResult = {
  ingressKey: string;
  conversationId: string;
  status: ProcessedTimerReplanIngressStatus;
};

export type TimerReplanIngressKeyBatchResult = {
  summary: TimerReplanIngressProcessSummary;
  results: TimerReplanIngressProcessResult[];
};

export class TimerReplanIngressIndexError extends Error {
  readonly code = "timer_replan_ingress_indexes_missing";

  constructor() {
    super(
      "The exact timer-replan idempotency and queue indexes are not deployed. Run the canonical Mongo index ensureer before conversion."
    );
    this.name = "TimerReplanIngressIndexError";
  }
}

export async function assertTimerReplanIngressIndexes(): Promise<void> {
  await connectDB();
  const indexes = await AiriTurnContext.collection.listIndexes().toArray();
  const required = [
    AIRI_TIMER_REPLAN_INGRESS_UNIQUE_INDEX,
    AIRI_TIMER_REPLAN_INGRESS_QUEUE_INDEX,
    AIRI_TIMER_REPLAN_INGRESS_SCENARIO_STATUS_INDEX,
  ];
  const exact = required.every(contract => {
    const deployed = indexes.find(
      index => index.name === contract.options.name
    );
    if (
      !deployed ||
      !isDeepStrictEqual(deployed.key, contract.keys) ||
      !isDeepStrictEqual(
        deployed.partialFilterExpression,
        contract.options.partialFilterExpression
      )
    ) {
      return false;
    }
    return (
      !("unique" in contract.options) ||
      deployed.unique === contract.options.unique
    );
  });
  if (!exact) throw new TimerReplanIngressIndexError();
}

function requireIdentifier(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Timer replan ingress requires ${name}`);
  }
  return normalized;
}

function requireDate(value: Date, name: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`Timer replan ingress requires a valid ${name}`);
  }
  return value;
}

function asDate(value: unknown): Date | null {
  const date = value instanceof Date ? value : new Date(String(value || ""));
  return Number.isNaN(date.getTime()) ? null : date;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeBatchSize(value: number | undefined): number {
  if (!Number.isFinite(value)) return 25;
  return Math.max(
    1,
    Math.min(MAX_TIMER_REPLAN_INGRESS_BATCH_SIZE, Math.trunc(value || 1))
  );
}

function normalizeIngressKeys(values: readonly string[]): string[] {
  return readUniqueStringArray(values).slice(
    0,
    MAX_TIMER_REPLAN_INGRESS_BATCH_SIZE
  );
}

function toPlainDocument(value: unknown): TimerReplanIngressDocument | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { toObject?: () => unknown };
  const plain =
    typeof record.toObject === "function" ? record.toObject() : value;
  return plain && typeof plain === "object"
    ? (plain as TimerReplanIngressDocument)
    : null;
}

function isExactTimerReplanIngress(
  value: TimerReplanIngressDocument,
  expected: TimerReplanIngressDocument
): boolean {
  return (
    value.ingressKey === expected.ingressKey &&
    value.workspaceId === expected.workspaceId &&
    value.conversationId === expected.conversationId &&
    value.messageId === expected.messageId &&
    value.triggerEventKind === TIMER_REPLAN_TRIGGER_KIND &&
    value.timerReplanIngress?.expectedScenarioId ===
      expected.timerReplanIngress.expectedScenarioId &&
    value.timerReplanIngress?.expectedConditionNodeId ===
      expected.timerReplanIngress.expectedConditionNodeId &&
    value.timerReplanIngress?.expectedSourceActionNodeId ===
      expected.timerReplanIngress.expectedSourceActionNodeId
  );
}

function buildTimerReplanIngressIdentity(params: {
  workspaceId: string;
  conversationId: string;
  expectedScenarioId: string;
  expectedConditionNodeId: string;
  expectedSourceActionNodeId: string;
  anchorId: string;
}): string {
  return [
    requireIdentifier(params.workspaceId, "workspaceId"),
    requireIdentifier(params.conversationId, "conversationId"),
    requireIdentifier(params.expectedScenarioId, "expectedScenarioId"),
    requireIdentifier(
      params.expectedConditionNodeId,
      "expectedConditionNodeId"
    ),
    requireIdentifier(
      params.expectedSourceActionNodeId,
      "expectedSourceActionNodeId"
    ),
    requireIdentifier(params.anchorId, "anchorId"),
  ].join("\u0000");
}

export async function enqueueTimerReplanIngress(
  params: EnqueueTimerReplanIngressParams
): Promise<TimerReplanIngressDocument> {
  const identity = buildTimerReplanIngressIdentity(params);
  const identityDigest = digest(identity);
  const ingressKey = `timer-replan-ingress:${identityDigest}`;
  const messageId = buildTimerReplanMessageId({
    scenarioId: params.expectedScenarioId.trim(),
    actionNodeId: params.expectedSourceActionNodeId.trim(),
    anchorId: params.anchorId.trim(),
  });
  const turnContextId = `airi-turn:${digest(ingressKey)}`;
  const messageDate = requireDate(params.messageDate, "messageDate");
  const enqueuedAt = requireDate(params.enqueuedAt, "enqueuedAt");
  const document: TimerReplanIngressDocument = {
    turnContextId,
    ingressKey,
    ingressStatus: "pending",
    ingressAttempts: 0,
    ingressNextRetryAt: enqueuedAt,
    workspaceId: params.workspaceId.trim(),
    conversationId: params.conversationId.trim(),
    messageId,
    triggerEventKind: TIMER_REPLAN_TRIGGER_KIND,
    expiresAt: null,
    timerReplanIngress: {
      expectedScenarioId: params.expectedScenarioId.trim(),
      expectedConditionNodeId: params.expectedConditionNodeId.trim(),
      expectedSourceActionNodeId: params.expectedSourceActionNodeId.trim(),
      messageDate,
      enqueuedAt,
    },
  };

  if (!params.session) await connectDB();
  let stored: unknown;
  try {
    stored = await AiriTurnContext.findOneAndUpdate(
      buildAiriIngressKeyFilter(ingressKey),
      { $setOnInsert: document },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
        ...(params.session ? { session: params.session } : {}),
      }
    );
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) throw error;
    const existingQuery = AiriTurnContext.findOne(
      buildAiriIngressKeyFilter(ingressKey)
    );
    if (params.session) existingQuery.session(params.session);
    const existing = toPlainDocument(await existingQuery.lean());
    if (!existing || !isExactTimerReplanIngress(existing, document)) {
      throw error;
    }
    return existing;
  }
  const plain = toPlainDocument(stored);
  if (!plain) {
    throw new Error("Timer replan ingress could not be persisted");
  }
  return plain;
}

async function claimTimerReplanIngress(params: {
  now: Date;
  workspaceId?: string;
  scenarioId?: string;
  ingressKeys?: string[];
}): Promise<ClaimedTimerReplanIngress | null> {
  return claimAiriIngress<TimerReplanIngressDocument>({
    now: params.now,
    filter: {
      triggerEventKind: TIMER_REPLAN_TRIGGER_KIND,
      ingressStatus: "pending",
      ingressNextRetryAt: { $lte: params.now },
      ingressAttempts: { $lt: MAX_TIMER_REPLAN_INGRESS_ATTEMPTS },
      ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
      ...(params.scenarioId
        ? { "timerReplanIngress.expectedScenarioId": params.scenarioId }
        : {}),
      ...(params.ingressKeys?.length
        ? buildAiriIngressKeyFilter(params.ingressKeys)
        : {}),
    },
    sort: { ingressNextRetryAt: 1, _id: 1 },
    ...(params.ingressKeys?.length
      ? {}
      : { hint: AIRI_TIMER_REPLAN_INGRESS_QUEUE_INDEX.options.name }),
  });
}

async function processClaimedTimerReplanIngress(params: {
  claimed: ClaimedTimerReplanIngress;
  now: Date;
}): Promise<ProcessedTimerReplanIngressStatus> {
  const payload = params.claimed.timerReplanIngress;
  const messageDate = asDate(payload?.messageDate);
  const enqueuedAt = asDate(payload?.enqueuedAt);
  try {
    if (!messageDate || !enqueuedAt) {
      throw new Error("Timer replan ingress event timestamps are invalid");
    }
    const result = await replanRemappedPostActionTimer({
      workspaceId: params.claimed.workspaceId,
      conversationId: params.claimed.conversationId,
      expectedScenarioId: payload.expectedScenarioId,
      expectedConditionNodeId: payload.expectedConditionNodeId,
      expectedSourceActionNodeId: payload.expectedSourceActionNodeId,
      apply: true,
      event: {
        messageId: params.claimed.messageId,
        messageDate: messageDate.toISOString(),
        enqueuedAt: enqueuedAt.toISOString(),
      },
    });
    if (result.status !== "replanned") {
      if (
        result.status === "conflict" &&
        result.reason === "conversation_state_changed"
      ) {
        const updated = await finishAiriIngressClaim({
          claimed: params.claimed,
          update: {
            $set: {
              ingressStatus: "signaled",
              ingressLastError: null,
              "timerReplanIngress.completion": "superseded",
              "timerReplanIngress.completedAt": params.now,
              expiresAt: new Date(
                params.now.getTime() + COMPLETED_TIMER_REPLAN_INGRESS_TTL_MS
              ),
            },
            $unset: {
              ingressLeaseToken: "",
              ingressLeaseExpiresAt: "",
              ingressNextRetryAt: "",
            },
          },
        });
        return updated ? "superseded" : "lease_lost";
      }
      const reason = result.reason ? `: ${result.reason}` : "";
      const updated = await finishAiriIngressClaim({
        claimed: params.claimed,
        update: {
          $set: {
            ingressStatus: "failed",
            ingressLastError: `${result.status}${reason}`,
          },
          $unset: {
            ingressLeaseToken: "",
            ingressLeaseExpiresAt: "",
            ingressNextRetryAt: "",
            expiresAt: "",
          },
        },
      });
      return updated ? "failed" : "lease_lost";
    }

    const updated = await finishAiriIngressClaim({
      claimed: params.claimed,
      update: {
        $set: {
          ingressStatus: "signaled",
          ingressSignaledAt: params.now,
          ingressLastError: null,
          "timerReplanIngress.completion": "signaled",
          "timerReplanIngress.completedAt": params.now,
          expiresAt: new Date(
            params.now.getTime() + COMPLETED_TIMER_REPLAN_INGRESS_TTL_MS
          ),
        },
        $unset: {
          ingressLeaseToken: "",
          ingressLeaseExpiresAt: "",
          ingressNextRetryAt: "",
        },
      },
    });
    return updated ? "signaled" : "lease_lost";
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const attempts = Number(params.claimed.ingressAttempts) || 0;
    const terminal = attempts >= MAX_TIMER_REPLAN_INGRESS_ATTEMPTS;
    const updated = await finishAiriIngressClaim({
      claimed: params.claimed,
      update: terminal
        ? {
            $set: {
              ingressStatus: "failed",
              ingressLastError: reason,
            },
            $unset: {
              ingressLeaseToken: "",
              ingressLeaseExpiresAt: "",
              ingressNextRetryAt: "",
              expiresAt: "",
            },
          }
        : {
            $set: {
              ingressStatus: "pending",
              ingressLastError: reason,
              ingressNextRetryAt: getAiriIngressRetryDate(params.now, attempts),
            },
            $unset: {
              ingressLeaseToken: "",
              ingressLeaseExpiresAt: "",
            },
          },
    });
    if (!updated) return "lease_lost";
    return terminal ? "failed" : "retry_scheduled";
  }
}

async function processTimerReplanIngressBatch(params: {
  limit?: number;
  now?: Date;
  workspaceId?: string;
  scenarioId?: string;
  ingressKeys?: string[];
}): Promise<TimerReplanIngressKeyBatchResult> {
  await connectDB();
  const now = params.now || new Date();
  const ingressKeys = normalizeIngressKeys(params.ingressKeys ?? []);
  const limit = ingressKeys.length
    ? Math.min(
        normalizeBatchSize(params.limit ?? ingressKeys.length),
        ingressKeys.length
      )
    : normalizeBatchSize(params.limit);
  const claims = await Promise.all(
    Array.from({ length: limit }, () =>
      claimTimerReplanIngress({
        now,
        workspaceId: params.workspaceId?.trim() || undefined,
        scenarioId: params.scenarioId?.trim() || undefined,
        ingressKeys: ingressKeys.length ? ingressKeys : undefined,
      })
    )
  );
  const claimed = claims.filter(
    (value): value is ClaimedTimerReplanIngress => value !== null
  );
  const results = await Promise.all(
    claimed.map(async item => ({
      ingressKey: item.ingressKey,
      conversationId: item.conversationId,
      status: await processClaimedTimerReplanIngress({ claimed: item, now }),
    }))
  );
  return {
    summary: {
      claimed: claimed.length,
      signaled: results.filter(result => result.status === "signaled").length,
      retryScheduled: results.filter(
        result => result.status === "retry_scheduled"
      ).length,
      failed: results.filter(result => result.status === "failed").length,
      superseded: results.filter(result => result.status === "superseded")
        .length,
      leaseLost: results.filter(result => result.status === "lease_lost")
        .length,
    },
    results,
  };
}

export async function processTimerReplanIngressQueue(
  params: {
    limit?: number;
    now?: Date;
    workspaceId?: string;
    scenarioId?: string;
  } = {}
): Promise<TimerReplanIngressProcessSummary> {
  return (await processTimerReplanIngressBatch(params)).summary;
}

export async function processTimerReplanIngressKeys(params: {
  ingressKeys: string[];
  now?: Date;
}): Promise<TimerReplanIngressKeyBatchResult> {
  const ingressKeys = normalizeIngressKeys(params.ingressKeys);
  if (ingressKeys.length === 0) {
    return {
      summary: {
        claimed: 0,
        signaled: 0,
        retryScheduled: 0,
        failed: 0,
        superseded: 0,
        leaseLost: 0,
      },
      results: [],
    };
  }
  const processed = await processTimerReplanIngressBatch({
    ingressKeys,
    limit: ingressKeys.length,
    now: params.now,
  });
  const processedKeys = new Set(
    processed.results.map(result => result.ingressKey)
  );
  const unresolvedKeys = ingressKeys.filter(key => !processedKeys.has(key));
  if (unresolvedKeys.length === 0) return processed;

  const terminalRows = await AiriTurnContext.find({
    triggerEventKind: TIMER_REPLAN_TRIGGER_KIND,
    ...buildAiriIngressKeyFilter(unresolvedKeys),
    ingressStatus: { $in: ["signaled", "failed"] },
  })
    .select(
      "ingressKey conversationId ingressStatus timerReplanIngress.completion"
    )
    .lean<
      Array<{
        ingressKey?: unknown;
        conversationId?: unknown;
        ingressStatus?: unknown;
        timerReplanIngress?: { completion?: unknown };
      }>
    >();
  const terminalByKey = new Map<string, TimerReplanIngressProcessResult>();
  for (const row of terminalRows) {
    const ingressKey = String(row.ingressKey || "").trim();
    const conversationId = String(row.conversationId || "").trim();
    if (!ingressKey || !conversationId) continue;
    if (row.ingressStatus === "failed") {
      terminalByKey.set(ingressKey, {
        ingressKey,
        conversationId,
        status: "failed",
      });
      continue;
    }
    if (row.ingressStatus === "signaled") {
      terminalByKey.set(ingressKey, {
        ingressKey,
        conversationId,
        status:
          row.timerReplanIngress?.completion === "superseded"
            ? "superseded"
            : "signaled",
      });
    }
  }
  const resultByKey = new Map(
    processed.results.map(result => [result.ingressKey, result] as const)
  );
  for (const [key, result] of terminalByKey) resultByKey.set(key, result);

  return {
    summary: processed.summary,
    results: ingressKeys.flatMap(key => {
      const result = resultByKey.get(key);
      return result ? [result] : [];
    }),
  };
}

export async function listOutstandingTimerReplanIngressForScenario(params: {
  workspaceId: string;
  scenarioId: string;
  limit?: number;
}): Promise<OutstandingTimerReplanIngress> {
  await connectDB();
  const limit = normalizeBatchSize(params.limit);
  const rows = await AiriTurnContext.find({
    workspaceId: requireIdentifier(params.workspaceId, "workspaceId"),
    triggerEventKind: TIMER_REPLAN_TRIGGER_KIND,
    "timerReplanIngress.expectedScenarioId": requireIdentifier(
      params.scenarioId,
      "scenarioId"
    ),
    ingressStatus: { $in: ["pending", "failed"] },
  })
    .hint(AIRI_TIMER_REPLAN_INGRESS_SCENARIO_STATUS_INDEX.options.name)
    .select("conversationId ingressStatus")
    .sort({ ingressStatus: 1, updatedAt: -1, _id: 1 })
    .limit(limit + 1)
    .lean<Array<{ conversationId?: unknown; ingressStatus?: unknown }>>();
  const limited = rows.slice(0, limit);
  const affectedConversationIds = Array.from(
    new Set(
      limited
        .map(row => String(row.conversationId || "").trim())
        .filter(Boolean)
    )
  ).sort();
  return {
    status:
      affectedConversationIds.length === 0
        ? null
        : limited.some(row => row.ingressStatus === "failed")
          ? "failed"
          : "pending",
    affectedConversationIds,
    hasMore: rows.length > limit,
  };
}

export async function retryTimerReplanIngressForScenario(params: {
  workspaceId: string;
  scenarioId: string;
  limit?: number;
  now?: Date;
}) {
  await connectDB();
  const now = params.now || new Date();
  const limit = normalizeBatchSize(params.limit);
  const workspaceId = requireIdentifier(params.workspaceId, "workspaceId");
  const scenarioId = requireIdentifier(params.scenarioId, "scenarioId");
  const failed = await AiriTurnContext.find({
    workspaceId,
    triggerEventKind: TIMER_REPLAN_TRIGGER_KIND,
    "timerReplanIngress.expectedScenarioId": scenarioId,
    ingressStatus: "failed",
  })
    .hint(AIRI_TIMER_REPLAN_INGRESS_SCENARIO_STATUS_INDEX.options.name)
    .select("_id")
    .sort({ updatedAt: 1, _id: 1 })
    .limit(limit)
    .lean<Array<{ _id: unknown }>>();
  const failedIds = failed.map(row => row._id);
  const reopened = failedIds.length
    ? await AiriTurnContext.updateMany(
        { _id: { $in: failedIds }, ingressStatus: "failed" },
        {
          $set: {
            ingressStatus: "pending",
            ingressAttempts: 0,
            ingressLastError: null,
            ingressNextRetryAt: now,
            expiresAt: null,
          },
          $unset: {
            ingressLeaseToken: "",
            ingressLeaseExpiresAt: "",
          },
        }
      )
    : { modifiedCount: 0 };
  const processed = await processTimerReplanIngressQueue({
    workspaceId,
    scenarioId,
    limit,
    now,
  });
  const outstanding = await listOutstandingTimerReplanIngressForScenario({
    workspaceId,
    scenarioId,
    limit,
  });
  return {
    reopened: Number(reopened.modifiedCount) || 0,
    processed,
    outstanding,
  };
}
