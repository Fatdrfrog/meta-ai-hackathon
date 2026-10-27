export const WHATSAPP_WEBHOOK_PAYLOAD_RETENTION_DEFAULT_DAYS = 30;
export const WHATSAPP_WEBHOOK_PAYLOAD_COMPACTION_DEFAULT_LIMIT = 100;
export const WHATSAPP_WEBHOOK_PAYLOAD_COMPACTION_MAX_LIMIT = 500;

export type WhatsAppWebhookPayloadRetentionModel = {
  find: (filter: Record<string, unknown>) => {
    select: (projection: string) => {
      sort: (sort: Record<string, 1 | -1>) => {
        limit: (limit: number) => {
          maxTimeMS: (timeout: number) => {
            lean: () => Promise<Array<{ _id: unknown }>>;
          };
        };
      };
    };
  };
  updateMany: (
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: { maxTimeMS: number },
  ) => Promise<{ modifiedCount: number }>;
};

export type WhatsAppWebhookPayloadRetentionResult = {
  dryRun: boolean;
  retentionDays: number;
  cutoff: string;
  scanned: number;
  compacted: number;
};

// Also used by operator replay: a compacted receipt cannot be resurrected
// without the payload needed to recover its original processing effects.
export function buildWhatsAppWebhookReplayablePayloadFilter() {
  return {
    payloadCompactedAt: null,
    payload: { $exists: true, $ne: null },
  };
}

export function resolveWhatsAppWebhookPayloadRetentionPolicy(params: {
  retentionDays?: number;
  limit?: number;
  env?: Record<string, string | undefined>;
}) {
  const retentionDaysEnv =
    params.env?.WHATSAPP_WEBHOOK_PAYLOAD_RETENTION_DAYS?.trim();
  const limitEnv =
    params.env?.WHATSAPP_WEBHOOK_PAYLOAD_COMPACTION_LIMIT?.trim();
  const retentionDays =
    params.retentionDays ??
    (retentionDaysEnv
      ? Number(retentionDaysEnv)
      : WHATSAPP_WEBHOOK_PAYLOAD_RETENTION_DEFAULT_DAYS);
  const limit =
    params.limit ??
    (limitEnv
      ? Number(limitEnv)
      : WHATSAPP_WEBHOOK_PAYLOAD_COMPACTION_DEFAULT_LIMIT);
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > 3_650
  ) {
    throw new Error("retentionDays must be an integer between 1 and 3650");
  }
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > WHATSAPP_WEBHOOK_PAYLOAD_COMPACTION_MAX_LIMIT
  ) {
    throw new Error("limit must be an integer between 1 and 500");
  }
  return { retentionDays, limit };
}

export async function compactCompletedWhatsAppWebhookEventPayloads(params: {
  model: WhatsAppWebhookPayloadRetentionModel;
  retentionDays?: number;
  limit?: number;
  now?: Date;
  dryRun?: boolean;
}): Promise<WhatsAppWebhookPayloadRetentionResult> {
  const { retentionDays, limit } =
    resolveWhatsAppWebhookPayloadRetentionPolicy(params);
  const now = params.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error("now must be a valid date");
  }
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000);
  const filter = {
    status: "completed",
    completedAt: { $type: "date", $lte: cutoff },
    ...buildWhatsAppWebhookReplayablePayloadFilter(),
  };
  const events = await params.model
    .find(filter)
    .select("_id")
    .sort({ completedAt: 1, _id: 1 })
    .limit(limit)
    .maxTimeMS(10_000)
    .lean();
  const dryRun = params.dryRun ?? true;
  const result = {
    dryRun,
    retentionDays,
    cutoff: cutoff.toISOString(),
    scanned: events.length,
    compacted: 0,
  };
  if (dryRun || !events.length) return result;

  // Recheck eligibility atomically: replay can claim a row between the scan
  // and update, and completedAt changes when processing finishes again.
  const update = await params.model.updateMany(
    { _id: { $in: events.map((event) => event._id) }, ...filter },
    {
      $set: { payloadCompactedAt: now },
      $unset: { payload: "", processingCursor: "" },
    },
    { maxTimeMS: 10_000 },
  );
  return { ...result, compacted: update.modifiedCount };
}
