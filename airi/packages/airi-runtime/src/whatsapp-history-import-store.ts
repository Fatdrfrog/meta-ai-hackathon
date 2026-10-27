import type { WhatsAppHistorySyncState } from "@icecore/whatsapp/historySyncState";
import {
  buildWhatsAppHistoryMessageEnvelopes,
  getWhatsAppHistoryProviderErrors,
} from "./whatsapp-history-import";
import type { WhatsAppWebhookEventEnvelope } from "./whatsapp-webhook-event-envelopes";
import WhatsAppWebhookEvent from "./whatsapp-webhook-event-model";
import mongoose from "mongoose";
import HistoryImportBudget from "./whatsapp-history-import-budget-model";
import {
  WHATSAPP_HISTORY_IMPORT_DEFAULT_MESSAGE_LIMIT,
  WHATSAPP_HISTORY_IMPORT_DEFAULT_BYTE_LIMIT,
  type WhatsAppHistoryPauseReason,
} from "@icecore/shared/lib/whatsapp/history-sync-state";
import { isMongoDuplicateKeyError } from "@icecore/shared/lib/mongo-errors";
import {
  buildWhatsAppPlanSkippedReceiptFilter,
  WHATSAPP_INTAKE_TRIAL_EXPIRED_REASON,
} from "./whatsapp-intake-plan-gate";

export type WhatsAppHistoryCapacityPauseReason = WhatsAppHistoryPauseReason;

export class WhatsAppHistoryCapacityPausedError extends Error {
  constructor(
    readonly companyId: string,
    readonly reason: WhatsAppHistoryCapacityPauseReason = "history_import_allowance",
  ) {
    super(
      reason === WHATSAPP_INTAKE_TRIAL_EXPIRED_REASON
        ? "WhatsApp history import paused: company plan locked; received history is preserved until the company upgrades"
        : "Company history import allowance exhausted; received history is preserved until capacity is increased",
    );
  }
}

function assertCapacityInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("History capacity must be a finite nonnegative integer");
}

export async function readWhatsAppHistoryImportCapacity(companyId: string) {
  if (!companyId.trim()) throw new Error("History capacity company is missing");
  return HistoryImportBudget.findById(companyId)
    .select("maxMessages maxBytes messagesUsed bytesUsed updatedAt")
    .lean();
}

export async function reserveWhatsAppHistoryImportCapacity(params: {
  companyId: string;
  eventId: string;
  processingLeaseId: string;
  messages: number;
  bytes: number;
}): Promise<"reserved" | "limited"> {
  assertCapacityInteger(params.messages);
  assertCapacityInteger(params.bytes);
  if (!params.companyId.trim())
    throw new Error("History capacity company is missing");
  try {
    await HistoryImportBudget.updateOne(
      { _id: params.companyId },
      {
        $setOnInsert: {
          maxMessages: WHATSAPP_HISTORY_IMPORT_DEFAULT_MESSAGE_LIMIT,
          maxBytes: WHATSAPP_HISTORY_IMPORT_DEFAULT_BYTE_LIMIT,
          messagesUsed: 0,
          bytesUsed: 0,
        },
      },
      { upsert: true },
    );
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) throw error;
  }
  return mongoose.connection.transaction(async (session) => {
    const filter = {
      _id: params.eventId,
      status: "processing",
      processingLeaseId: params.processingLeaseId,
    };
    const parent = await WhatsAppWebhookEvent.findOne(filter)
      .select("historyImport")
      .session(session)
      .lean<{ historyImport?: { capacityReservedAt?: string } } | null>();
    if (!parent)
      throw new Error(
        "WhatsApp history capacity reservation lost its processing lease",
      );
    if (
      (parent.historyImport as { capacityReservedAt?: string })
        ?.capacityReservedAt
    )
      return "reserved" as const;
    const admission = await HistoryImportBudget.updateOne(
      {
        _id: params.companyId,
        $expr: {
          $and: [
            {
              $lte: [
                { $add: ["$messagesUsed", params.messages] },
                "$maxMessages",
              ],
            },
            { $lte: [{ $add: ["$bytesUsed", params.bytes] }, "$maxBytes"] },
          ],
        },
      },
      { $inc: { messagesUsed: params.messages, bytesUsed: params.bytes } },
      { session },
    );
    if (admission.matchedCount !== 1) return "limited" as const;
    const receipt = await WhatsAppWebhookEvent.updateOne(
      filter,
      {
        $set: {
          "historyImport.capacityCompanyId": params.companyId,
          "historyImport.capacityReservedAt": new Date().toISOString(),
          "historyImport.capacityPaused": false,
        },
      },
      { session },
    );
    if (receipt.matchedCount !== 1)
      throw new Error(
        "WhatsApp history capacity reservation lost its processing lease",
      );
    return "reserved" as const;
  });
}

/** Operator-only capacity adjustment; increasing a limit wakes preserved receipts. */
export async function setWhatsAppHistoryImportCapacity(params: {
  companyId: string;
  maxMessages: number;
  maxBytes: number;
}): Promise<void> {
  assertCapacityInteger(params.maxMessages);
  assertCapacityInteger(params.maxBytes);
  if (!params.companyId.trim())
    throw new Error("History capacity company is missing");
  try {
    await HistoryImportBudget.updateOne(
      {
        _id: params.companyId,
        messagesUsed: { $not: { $gt: params.maxMessages } },
        bytesUsed: { $not: { $gt: params.maxBytes } },
      },
      {
        $set: { maxMessages: params.maxMessages, maxBytes: params.maxBytes },
        $setOnInsert: { messagesUsed: 0, bytesUsed: 0 },
      },
      { upsert: true },
    );
  } catch (error) {
    if (isMongoDuplicateKeyError(error))
      throw new Error(
        "History capacity cannot be lower than already used capacity",
      );
    throw error;
  }
  const pausedFilter = {
    status: "received",
    "historyImport.capacityCompanyId": params.companyId,
    "historyImport.capacityPaused": true,
  };
  const paused = await WhatsAppWebhookEvent.find(pausedFilter)
    .sort({ _id: 1 })
    .select("_id")
    .limit(1000)
    .lean<Array<{ _id: unknown }>>();
  if (!paused.length) return;
  await WhatsAppWebhookEvent.updateMany(
    { ...pausedFilter, _id: { $in: paused.map((receipt) => receipt._id) } },
    {
      $set: {
        nextRetryAt: new Date(),
        "historyImport.capacityDeferredUntil": new Date(),
        "historyImport.capacityPaused": false,
      },
    },
  );
}

export type WhatsAppHistoryReceiptSummary = {
  role: string;
  status: string;
  outcome?: string | null;
  count: number;
  progress?: number | null;
  receivedAt?: string | Date | null;
  completedAt?: string | Date | null;
  capacityPaused?: boolean;
  /** True when a paused receipt in the group waits for a plan upgrade. */
  planPaused?: boolean;
  /** Receipts in the group that carry a plan-skip marker. */
  planSkipped?: number;
  providerErrors?: Array<{
    code?: number | string;
    message?: string;
    title?: string;
  }>;
};

/** Provider progress describes transfer. Only the durable receipts describe
 * which received messages are synchronized, pending, intentionally skipped, or failed. */
export function summarizeWhatsAppHistoryReceipts(
  current: WhatsAppHistorySyncState,
  rows: WhatsAppHistoryReceiptSummary[],
  identities?: {
    received: number;
    synchronized: number;
    skipped: number;
    planSkipped?: number;
  },
) {
  if (rows.length === 0) {
    return {
      ...current,
      counts_verified: true,
      received_count_total: 0,
      synchronized_count_total: 0,
      processed_count_total: 0,
      skipped_count_total: 0,
      plan_skipped_count_total: 0,
      pending_count_total: 0,
      failed_count_total: 0,
      pending_chunk_count_total: 0,
      failed_chunk_count_total: 0,
      webhook_count: 0,
    };
  }
  const chunks = rows.filter((row) => row.role === "chunk");
  const messages = rows.filter((row) => row.role === "message");
  const sum = (items: WhatsAppHistoryReceiptSummary[]) =>
    items.reduce((total, row) => total + row.count, 0);
  const synchronized =
    identities?.synchronized ??
    sum(
      messages.filter(
        (row) => row.status === "completed" && row.outcome === "synchronized",
      ),
    );
  const skipped =
    identities?.skipped ??
    sum(
      messages.filter(
        (row) =>
          row.status === "completed" &&
          ["skipped", "superseded"].includes(row.outcome || ""),
      ),
    );
  // A plan skip completes the receipt, so it never shows as pending or paused;
  // count it so the import is not presented as fully saved.
  const planSkipped =
    identities?.planSkipped ??
    messages
      .filter((row) => row.status === "completed" && row.outcome === "skipped")
      .reduce((total, row) => total + (row.planSkipped ?? 0), 0);
  const failedRows = rows.filter(
    (row) => row.status === "dead" || row.status === "failed",
  );
  const pendingRows = rows.filter(
    (row) => !["completed", "dead"].includes(row.status),
  );
  const failed = sum(failedRows);
  const pending = sum(pendingRows);
  const providerError = chunks.flatMap((row) => row.providerErrors || [])[0];
  const completedProviderRows = chunks.filter(
    (row) => (row.progress ?? 0) >= 100,
  );
  const latestDate = (values: Array<string | Date | null | undefined>) => {
    const dates = values
      .map((value) => (value ? new Date(value).getTime() : NaN))
      .filter(Number.isFinite);
    return dates.length
      ? new Date(Math.max(...dates)).toISOString()
      : undefined;
  };
  const providerCompletedAt = latestDate(
    completedProviderRows.map((row) => row.receivedAt),
  );
  const hasDead = rows.some((row) => row.status === "dead");
  const complete = Boolean(
    providerCompletedAt && !pending && !failed && !providerError,
  );
  const capacityPaused = rows.some(
    (row) => row.capacityPaused && row.status !== "completed",
  );
  // A plan lock is the first blocker: an allowance raise cannot resume it.
  const pauseReason: WhatsAppHistoryPauseReason | undefined = !capacityPaused
    ? undefined
    : rows.some(
          (row) =>
            row.capacityPaused && row.planPaused && row.status !== "completed",
        )
      ? WHATSAPP_INTAKE_TRIAL_EXPIRED_REASON
      : "history_import_allowance";
  const status: WhatsAppHistorySyncState["status"] = capacityPaused
    ? "paused"
    : providerError
      ? Number(providerError.code) === 2593109
        ? "declined"
        : "error"
      : hasDead
        ? "error"
        : complete
          ? "completed"
          : rows.length
            ? "in_progress"
            : current.status;
  return {
    ...current,
    status,
    pause_reason: pauseReason,
    counts_verified: true,
    received_count_total: identities?.received ?? sum(messages),
    synchronized_count_total: synchronized,
    processed_count_total: synchronized,
    skipped_count_total: skipped,
    plan_skipped_count_total: planSkipped,
    pending_count_total: sum(
      pendingRows.filter((row) => row.role === "message"),
    ),
    failed_count_total: sum(failedRows.filter((row) => row.role === "message")),
    pending_chunk_count_total: sum(
      pendingRows.filter((row) => row.role === "chunk"),
    ),
    failed_chunk_count_total: sum(
      failedRows.filter((row) => row.role === "chunk"),
    ),
    webhook_count: sum(chunks),
    last_progress: chunks.length
      ? Math.max(...chunks.map((row) => row.progress ?? 0))
      : undefined,
    provider_completed_at: providerCompletedAt,
    last_webhook_at: latestDate(chunks.map((row) => row.receivedAt)),
    completed_at: complete
      ? latestDate(rows.map((row) => row.completedAt)) || providerCompletedAt
      : undefined,
    error:
      providerError?.message ||
      providerError?.title ||
      (hasDead
        ? "Some received history messages could not be synchronized."
        : undefined),
    error_code: providerError?.code,
  };
}

export async function readWhatsAppHistorySyncState(params: {
  workspaceId: string;
  sourceId: string;
  historySync?: WhatsAppHistorySyncState | null;
}): Promise<WhatsAppHistorySyncState | null> {
  const current = params.historySync;
  const sessionId = (current as { session_id?: string } | null | undefined)
    ?.session_id;
  if (!current || !sessionId) return current || null;
  const { default: connectDB } = await import("./mongoose");
  await connectDB();
  const isPlanSkipped = {
    $in: [
      "$planSkipReason",
      buildWhatsAppPlanSkippedReceiptFilter().planSkipReason.$in,
    ],
  };
  const results = await WhatsAppWebhookEvent.aggregate<{
    rows: WhatsAppHistoryReceiptSummary[];
    identities: Array<{
      received: number;
      synchronized: number;
      skipped: number;
      planSkipped: number;
    }>;
  }>([
    {
      $match: {
        workspaceId: params.workspaceId,
        sourceId: params.sourceId,
        "historyImport.sessionId": sessionId,
      },
    },
    {
      $facet: {
        rows: [
          {
            $group: {
              _id: {
                role: "$historyImport.role",
                status: "$status",
                outcome: "$historyImport.outcome",
              },
              count: { $sum: 1 },
              progress: { $max: "$historyMetadata.progress" },
              receivedAt: { $max: "$firstReceivedAt" },
              completedAt: { $max: "$completedAt" },
              capacityPaused: { $max: "$historyImport.capacityPaused" },
              planPaused: {
                $max: {
                  $and: [
                    { $eq: ["$historyImport.capacityPaused", true] },
                    {
                      $eq: [
                        "$historyImport.capacityPauseReason",
                        WHATSAPP_INTAKE_TRIAL_EXPIRED_REASON,
                      ],
                    },
                  ],
                },
              },
              planSkipped: { $sum: { $cond: [isPlanSkipped, 1, 0] } },
              providerErrors: { $first: "$historyImport.providerErrors" },
            },
          },
          {
            $project: {
              _id: 0,
              role: "$_id.role",
              status: "$_id.status",
              outcome: "$_id.outcome",
              count: 1,
              progress: 1,
              receivedAt: 1,
              completedAt: 1,
              capacityPaused: 1,
              planPaused: 1,
              planSkipped: 1,
              providerErrors: 1,
            },
          },
        ],
        identities: [
          { $match: { "historyImport.role": "message" } },
          {
            $group: {
              _id: "$historyImport.providerMessageId",
              synchronized: {
                $max: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ["$status", "completed"] },
                        { $eq: ["$historyImport.outcome", "synchronized"] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              skipped: {
                $max: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ["$status", "completed"] },
                        {
                          $in: [
                            "$historyImport.outcome",
                            ["skipped", "superseded"],
                          ],
                        },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              planSkipped: {
                $max: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ["$status", "completed"] },
                        { $eq: ["$historyImport.outcome", "skipped"] },
                        isPlanSkipped,
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          },
          {
            $group: {
              _id: null,
              received: { $sum: 1 },
              synchronized: { $sum: "$synchronized" },
              skipped: {
                $sum: { $cond: [{ $eq: ["$synchronized", 0] }, "$skipped", 0] },
              },
              planSkipped: {
                $sum: {
                  $cond: [{ $eq: ["$synchronized", 0] }, "$planSkipped", 0],
                },
              },
            },
          },
        ],
      },
    },
  ])
    .read("primary")
    .option({ maxTimeMS: 10_000 });
  return summarizeWhatsAppHistoryReceipts(
    current,
    results[0]?.rows || [],
    results[0]?.identities[0],
  );
}

type ExpansionDependencies = {
  persistChildren(children: WhatsAppWebhookEventEnvelope[]): Promise<void>;
  commitExpansion(
    expectedChildren: number,
    providerErrors: ReturnType<typeof getWhatsAppHistoryProviderErrors>,
  ): Promise<boolean>;
};

export async function expandWhatsAppHistoryChunk(
  params: {
    parent: WhatsAppWebhookEventEnvelope;
    eventId: string;
    processingLeaseId: string;
    providerSignatureVerified: boolean;
    companyId?: string;
    heartbeat?: () => void;
  },
  overrides?: ExpansionDependencies,
): Promise<WhatsAppWebhookEventEnvelope[]> {
  if (!params.providerSignatureVerified)
    throw new Error("A history import requires a verified provider signature");
  const children = buildWhatsAppHistoryMessageEnvelopes(params.parent);
  if (params.parent.historyImport?.capacityPolicyVersion === 1) {
    if (!params.companyId)
      throw new Error("History import company capacity is unavailable");
    const admitted = await reserveWhatsAppHistoryImportCapacity({
      companyId: params.companyId,
      eventId: params.eventId,
      processingLeaseId: params.processingLeaseId,
      messages: children.length,
      bytes: children.reduce(
        (total, child) =>
          total + Buffer.byteLength(child.payload.rawBody, "utf8"),
        0,
      ),
    });
    if (admitted === "limited")
      throw new WhatsAppHistoryCapacityPausedError(params.companyId);
  }
  const deps: ExpansionDependencies = overrides || {
    persistChildren: async (batch) => {
      await WhatsAppWebhookEvent.bulkWrite(
        batch.map((child) => ({
          updateOne: {
            filter: { dedupeKey: child.dedupeKey },
            update: {
              $setOnInsert: {
                ...child,
                provider: "whatsapp",
                status: "received",
                providerSignatureVerified: params.providerSignatureVerified,
                originalPayloadHash: child.payload.originalRawBodyHash,
                firstReceivedAt: child.receivedAt,
                lastReceivedAt: child.receivedAt,
                nextRetryAt: new Date(),
                attempts: 0,
                maxAttempts: 12,
              },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    },
    commitExpansion: async (expectedChildren, providerErrors) => {
      const result = await WhatsAppWebhookEvent.updateOne(
        {
          _id: params.eventId,
          processingLeaseId: params.processingLeaseId,
          status: "processing",
        },
        {
          $set: {
            "historyImport.expectedChildren": expectedChildren,
            "historyImport.expandedAt": new Date().toISOString(),
            "historyImport.providerErrors": providerErrors,
            "historyImport.outcome": providerErrors.length
              ? "provider_error"
              : "synchronized",
          },
        },
      );
      return result.matchedCount === 1;
    },
  };
  for (let offset = 0; offset < children.length; offset += 100) {
    params.heartbeat?.();
    await deps.persistChildren(children.slice(offset, offset + 100));
  }
  if (
    !(await deps.commitExpansion(
      children.length,
      getWhatsAppHistoryProviderErrors(params.parent.payload.body),
    ))
  ) {
    throw new Error("WhatsApp history chunk processing lease was lost");
  }
  return children;
}
