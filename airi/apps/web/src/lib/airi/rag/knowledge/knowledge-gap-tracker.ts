import { buildCacheKey, cache } from "@/lib/cache";
import {
  detectIntegrationTopic,
  type MissingKnowledgeIntent,
} from "@/lib/airi/grounding/factual-grounding-guard";
import connectDB from "@/lib/mongoose";
import AiriGapEvent, {
  type AiriGapIntent,
  type AiriGapSource,
} from "@/models/airi-gap-event";
import type { Channel } from "@/types/models";
import { upsertGapRecommendationCard } from "@/lib/airi/recommendation-board";
import {
  normalizeGapIntegrationTopic,
  shouldPromptForGapIntent,
} from "@/lib/airi/ops/gap-copy";
import { ragLogger } from "@/lib/airi/shared/logger";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";

const KNOWLEDGE_GAP_TTL_SECONDS = 30 * 24 * 60 * 60;
const KNOWLEDGE_GAP_CTA_THRESHOLDS = new Set<number>([3, 5, 10, 20]);
const UNKNOWN_GAP_CTA_THRESHOLDS = new Set<number>([5, 10, 20, 50]);
const MAX_GAP_QUERY_CHARS = 600;

export type GapTrackingIntent = MissingKnowledgeIntent | "unknown";

export type GapTrackingResult = {
  askCount: number;
  shouldPromptWorkspace: boolean;
  persisted: boolean;
};

function toPositiveInteger(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  return 0;
}

function normalizeIntent(intent: GapTrackingIntent): AiriGapIntent {
  if (
    intent === "business_hours" ||
    intent === "pricing" ||
    intent === "policy" ||
    intent === "integration_request"
  ) {
    return intent;
  }
  return "unknown";
}

function resolveIntentTopic(params: {
  intent: AiriGapIntent;
  topic?: string | null;
  query?: string;
  metadata?: Record<string, unknown>;
}): string | null {
  if (params.intent !== "integration_request") return null;

  const fromTopic = normalizeGapIntegrationTopic(params.topic);
  if (fromTopic) return fromTopic;

  const metadataTopic =
    typeof params.metadata?.integrationTopic === "string"
      ? params.metadata.integrationTopic
      : null;
  const fromMetadata = normalizeGapIntegrationTopic(metadataTopic);
  if (fromMetadata) return fromMetadata;

  const detected = params.query ? detectIntegrationTopic(params.query) : null;
  return normalizeGapIntegrationTopic(detected);
}

function toGapDedupeKey(params: {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  intent: AiriGapIntent;
  intentTopic?: string | null;
  reason: string;
}): string {
  const topicPart = params.intentTopic ? `:${params.intentTopic}` : "";
  return [
    "airi-gap",
    params.workspaceId.trim(),
    params.conversationId.trim(),
    params.messageId.trim(),
    `${params.intent}${topicPart}`,
    params.reason.trim().toLowerCase(),
  ].join(":");
}

function normalizeGapQuery(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_GAP_QUERY_CHARS);
}

async function readCachedGapCount(
  workspaceId: string,
  intent: AiriGapIntent,
  intentTopic?: string | null
): Promise<number> {
  const topic = normalizeGapIntegrationTopic(intentTopic);
  const key = buildCacheKey("airi:missing-knowledge", [
    workspaceId,
    intent,
    topic || "_",
  ]);
  const currentRaw = await cache.get<string | number | null>(key);
  return toPositiveInteger(currentRaw);
}

async function writeCachedGapCount(
  workspaceId: string,
  intent: AiriGapIntent,
  intentTopic: string | null | undefined,
  value: number
): Promise<void> {
  const topic = normalizeGapIntegrationTopic(intentTopic);
  const key = buildCacheKey("airi:missing-knowledge", [
    workspaceId,
    intent,
    topic || "_",
  ]);
  await cache.set(
    key,
    String(Math.max(0, Math.floor(value))),
    KNOWLEDGE_GAP_TTL_SECONDS
  );
}

async function incrementCachedGapCount(
  workspaceId: string,
  intent: AiriGapIntent,
  intentTopic?: string | null
): Promise<number> {
  const current = await readCachedGapCount(workspaceId, intent, intentTopic);
  const next = current + 1;
  await writeCachedGapCount(workspaceId, intent, intentTopic, next);
  return next;
}

async function hydrateGapCountFromStorage(
  workspaceId: string,
  intent: AiriGapIntent,
  intentTopic?: string | null
): Promise<number> {
  try {
    const normalizedTopic = normalizeGapIntegrationTopic(intentTopic);
    const count = await AiriGapEvent.countDocuments({
      workspaceId,
      intent,
      ...(normalizedTopic ? { intentTopic: normalizedTopic } : {}),
    });
    await writeCachedGapCount(workspaceId, intent, normalizedTopic, count);
    return count;
  } catch {
    return readCachedGapCount(workspaceId, intent, intentTopic);
  }
}

async function persistGapEvent(params: {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  channel: Channel;
  intent: AiriGapIntent;
  intentTopic?: string | null;
  reason: string;
  query: string;
  source: AiriGapSource;
  responseConfidence?: number;
  retrievalPriority?: string;
  metadata?: Record<string, unknown>;
}): Promise<boolean> {
  const dedupeKey = toGapDedupeKey({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    messageId: params.messageId,
    intent: params.intent,
    intentTopic: params.intentTopic,
    reason: params.reason,
  });

  try {
    const result = await AiriGapEvent.updateOne(
      { dedupeKey },
      {
        $setOnInsert: {
          dedupeKey,
          workspaceId: params.workspaceId,
          conversationId: params.conversationId,
          messageId: params.messageId,
          channel: params.channel,
          intent: params.intent,
          intentTopic: params.intentTopic || null,
          reason: params.reason,
          query: normalizeGapQuery(params.query),
          source: params.source,
          responseConfidence:
            typeof params.responseConfidence === "number"
              ? Math.max(0, Math.min(1, params.responseConfidence))
              : null,
          retrievalPriority: params.retrievalPriority || null,
          metadata: params.metadata,
        },
      },
      { upsert: true }
    );

    return (result.upsertedCount || 0) > 0;
  } catch (error) {
    if (isMongoDuplicateKeyError(error)) {
      return false;
    }
    throw error;
  }
}

export async function trackMissingKnowledgeGap(params: {
  workspaceId: string;
  intent: GapTrackingIntent;
  topic?: string | null;
  conversationId?: string;
  messageId?: string;
  channel?: Channel;
  query?: string;
  reason?: string;
  source?: AiriGapSource;
  responseConfidence?: number;
  retrievalPriority?: string;
  metadata?: Record<string, unknown>;
}): Promise<GapTrackingResult> {
  const intent = normalizeIntent(params.intent);
  const intentTopic = resolveIntentTopic({
    intent,
    topic: params.topic,
    query: params.query,
    metadata: params.metadata,
  });
  const hasPersistenceContext = Boolean(
    params.conversationId &&
      params.messageId &&
      params.channel &&
      params.reason &&
      typeof params.reason === "string"
  );

  let persisted = false;
  let shouldIncrementCounter = !hasPersistenceContext;
  let dbConnected = false;

  const ensureDBConnection = async () => {
    if (dbConnected) return;
    await connectDB();
    dbConnected = true;
  };

  if (hasPersistenceContext) {
    try {
      await ensureDBConnection();
      persisted = await persistGapEvent({
        workspaceId: params.workspaceId,
        conversationId: String(params.conversationId),
        messageId: String(params.messageId),
        channel: params.channel as Channel,
        intent,
        intentTopic,
        reason: String(params.reason),
        query: params.query || "",
        source: params.source || "runtime",
        responseConfidence: params.responseConfidence,
        retrievalPriority: params.retrievalPriority,
        metadata: params.metadata,
      });
      shouldIncrementCounter = persisted;
    } catch (error) {
      ragLogger.general.warn("Failed to persist knowledge gap event", {
        workspaceId: params.workspaceId,
        intent,
        reason: params.reason,
        error,
      });
      // Keep gap counting alive even if persistence fails.
      shouldIncrementCounter = true;
    }
  }

  let askCount = 0;
  if (shouldIncrementCounter) {
    askCount = await incrementCachedGapCount(
      params.workspaceId,
      intent,
      intentTopic
    );
  } else {
    await ensureDBConnection();
    askCount = await hydrateGapCountFromStorage(
      params.workspaceId,
      intent,
      intentTopic
    );
  }

  const shouldPromptWorkspace =
    (shouldPromptForGapIntent(intent) &&
      KNOWLEDGE_GAP_CTA_THRESHOLDS.has(askCount)) ||
    (intent === "unknown" && UNKNOWN_GAP_CTA_THRESHOLDS.has(askCount));

  const shouldUpsertCard =
    (shouldPromptForGapIntent(intent) && askCount > 0) ||
    (intent === "unknown" && askCount >= 5);

  if (shouldUpsertCard) {
    await upsertGapRecommendationCard({
      workspaceId: params.workspaceId,
      intent,
      askCount,
      reason: params.reason || "missing_grounded_context",
      lastSeenAt: new Date(),
      topic: intentTopic,
    }).catch(error => {
      ragLogger.general.warn("Failed to upsert gap recommendation card", {
        workspaceId: params.workspaceId,
        intent,
        askCount,
        error,
      });
    });
  }

  return {
    askCount,
    shouldPromptWorkspace,
    persisted,
  };
}

export type WorkspaceGapInsight = {
  intent: AiriGapIntent;
  topic?: string | null;
  count: number;
  lastSeenAt: string | null;
  reasons: string[];
};

export async function getWorkspaceGapInsights(params: {
  workspaceId: string;
  sinceDays?: number;
  limit?: number;
}): Promise<WorkspaceGapInsight[]> {
  const sinceDays = Number.isFinite(params.sinceDays)
    ? Math.max(1, Math.floor(params.sinceDays as number))
    : 30;
  const limit = Number.isFinite(params.limit)
    ? Math.max(1, Math.min(20, Math.floor(params.limit as number)))
    : 5;
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

  try {
    await connectDB();
    const rows = await AiriGapEvent.aggregate<{
      _id: { intent: AiriGapIntent; topic?: string | null };
      count: number;
      lastSeenAt: Date | null;
      reasons: string[];
    }>([
      {
        $match: {
          workspaceId: params.workspaceId,
          createdAt: { $gte: since },
        },
      },
      {
        $group: {
          _id: {
            intent: "$intent",
            topic: "$intentTopic",
          },
          count: { $sum: 1 },
          lastSeenAt: { $max: "$createdAt" },
          reasons: { $addToSet: "$reason" },
        },
      },
      { $sort: { count: -1, lastSeenAt: -1 } },
      { $limit: limit },
    ]);

    return rows.map(row => ({
      intent: row._id?.intent || "unknown",
      topic: row._id?.topic || null,
      count: row.count || 0,
      lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
      reasons: Array.isArray(row.reasons) ? row.reasons.slice(0, 3) : [],
    }));
  } catch (error) {
    ragLogger.general.warn("Failed to aggregate workspace gap insights", {
      workspaceId: params.workspaceId,
      error,
    });
    return [];
  }
}
