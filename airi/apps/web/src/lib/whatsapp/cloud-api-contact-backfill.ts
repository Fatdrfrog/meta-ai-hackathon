import { ensureCustomerForConversation } from "@/lib/customers/service";
import connectDB from "@/lib/mongoose";
import { normalizeWhatsAppCredentials } from "@/lib/whatsapp/credentials";
import { asWhatsAppRecord } from "@icecore/shared/lib/whatsapp/value-utils";
import { Conversation } from "@/models/conversation";

const DEFAULT_CONTACT_BACKFILL_LIMIT = 25;
const MAX_CONTACT_BACKFILL_LIMIT = 100;

type BackfillReason = "coexistence" | "missing_source" | "missing_workspace";

type CloudApiContactBackfillResult = {
  attempted: boolean;
  skipped: boolean;
  queued: false;
  mode: "inline_bounded";
  reason?: BackfillReason;
  processedCount: number;
  linkedCount: number;
  errorCount: number;
  hasMore: boolean;
  completed: boolean;
  error?: string | null;
  errorCode?: string | null;
  errors?: string[];
  actionable?: string;
};

function readConversationId(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    "toString" in value &&
    typeof value.toString === "function"
  ) {
    const id = value.toString();
    return id && id !== "[object Object]" ? id : null;
  }
  return null;
}

function skippedBackfillResult(
  reason: BackfillReason
): CloudApiContactBackfillResult {
  return {
    attempted: false,
    skipped: true,
    queued: false,
    mode: "inline_bounded",
    reason,
    processedCount: 0,
    linkedCount: 0,
    errorCount: 0,
    hasMore: false,
    completed: false,
  };
}

export async function backfillCloudApiWhatsAppContacts({
  sourceId,
  workspaceId,
  credentials,
  saveCredentials,
  limit = DEFAULT_CONTACT_BACKFILL_LIMIT,
}: {
  sourceId: string;
  workspaceId: string;
  credentials: Record<string, unknown> | null | undefined;
  saveCredentials: (credentials: Record<string, unknown>) => Promise<void>;
  limit?: number;
}): Promise<CloudApiContactBackfillResult> {
  const currentCredentials = { ...asWhatsAppRecord(credentials) };
  const normalized = normalizeWhatsAppCredentials(currentCredentials);

  if (normalized.coexistenceMode) {
    return skippedBackfillResult("coexistence");
  }

  if (!sourceId) {
    return skippedBackfillResult("missing_source");
  }

  if (!workspaceId) {
    return skippedBackfillResult("missing_workspace");
  }

  const startedAt = new Date().toISOString();
  const requestedLimit = Number.isFinite(limit)
    ? Math.floor(limit)
    : DEFAULT_CONTACT_BACKFILL_LIMIT;
  const batchLimit = Math.min(
    MAX_CONTACT_BACKFILL_LIMIT,
    Math.max(1, requestedLimit)
  );
  let nextCredentials: Record<string, unknown> = {
    ...currentCredentials,
    cloud_contact_backfill: {
      status: "running",
      started_at: startedAt,
      processed_count: 0,
      linked_count: 0,
      error_count: 0,
      batch_limit: batchLimit,
    },
  };
  let processedCount = 0;
  let linkedCount = 0;
  const errors: string[] = [];
  try {
    await saveCredentials(nextCredentials);

    await connectDB();

    const rows = (await Conversation.find({
      workspaceId,
      channel: "whatsapp",
      sourceId,
      $or: [{ customerId: null }, { customerId: { $exists: false } }],
    })
      .select("_id")
      .sort({ lastMessageAt: -1, updatedAt: -1, createdAt: -1 })
      .limit(batchLimit + 1)
      .lean()) as Array<{ _id?: unknown }>;
    const hasMore = rows.length > batchLimit;
    const batchRows = hasMore ? rows.slice(0, batchLimit) : rows;

    for (const row of batchRows) {
      const conversationId = readConversationId(row._id);
      if (!conversationId) continue;

      processedCount += 1;
      try {
        await ensureCustomerForConversation({
          conversationId,
          linkMethod: "backfill",
          linkConfidence: 0.9,
        });
        linkedCount += 1;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    const completedAt = new Date().toISOString();
    const errorCount = errors.length;
    nextCredentials = {
      ...nextCredentials,
      cloud_contact_backfill: {
        status:
          errorCount > 0
            ? "partial_with_errors"
            : hasMore
              ? "partial"
              : "completed",
        started_at: startedAt,
        completed_at: completedAt,
        processed_count: processedCount,
        linked_count: linkedCount,
        error_count: errorCount,
        has_more: hasMore,
        batch_limit: batchLimit,
        ...(errors[0] ? { last_error: errors[0] } : {}),
      },
    };
    await saveCredentials(nextCredentials);

    return {
      attempted: true,
      skipped: false,
      queued: false,
      mode: "inline_bounded",
      processedCount,
      linkedCount,
      errorCount,
      hasMore,
      completed: !hasMore && errorCount === 0,
      ...(errors.length > 0 ? { errors } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    // This is optional work after the connection is saved. Preserve a retryable
    // failure instead of leaving the import running or failing the connection.
    try {
      await saveCredentials({
        ...nextCredentials,
        cloud_contact_backfill: {
          ...asWhatsAppRecord(nextCredentials.cloud_contact_backfill),
          status: "failed",
          completed_at: new Date().toISOString(),
          processed_count: processedCount,
          linked_count: linkedCount,
          error_count: errors.length,
          last_error: message,
        },
      });
    } catch (persistError) {
      errors.push(
        persistError instanceof Error
          ? persistError.message
          : String(persistError)
      );
    }

    return {
      attempted: true,
      skipped: false,
      queued: false,
      mode: "inline_bounded",
      processedCount,
      linkedCount,
      errorCount: errors.length,
      hasMore: true,
      completed: false,
      error: message,
      errors,
      actionable:
        "The WhatsApp connection is saved. Contact import is incomplete and can be retried independently.",
    };
  }
}
