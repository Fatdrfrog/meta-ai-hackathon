import connectDB from "@/lib/mongoose";
import AiriRecommendation from "@/models/airi-recommendation";
import {
  buildGapRecommendationCopy as buildSharedGapRecommendationCopy,
  normalizeGapIntegrationTopic,
} from "@/lib/airi/ops/gap-copy";

export function buildGapRecommendationCopy(params: {
  workspaceId: string;
  intent: string;
  askCount: number;
  topic?: string | null;
}): {
  title: string;
  description: string;
  links: Array<{ label: string; href: string }>;
} {
  return buildSharedGapRecommendationCopy(params);
}

export async function upsertGapRecommendationCard(params: {
  workspaceId: string;
  intent: string;
  askCount: number;
  reason: string;
  lastSeenAt?: Date;
  topic?: string | null;
}): Promise<void> {
  const workspaceId = String(params.workspaceId || "").trim();
  if (!workspaceId) return;

  await connectDB();

  const integrationTopic =
    params.intent === "integration_request"
      ? normalizeGapIntegrationTopic(params.topic)
      : null;
  const dedupeKey = integrationTopic
    ? `gap:${params.intent}:${integrationTopic}`
    : `gap:${params.intent}`;
  const copy = buildGapRecommendationCopy({
    workspaceId,
    intent: params.intent,
    askCount: params.askCount,
    topic: integrationTopic,
  });

  const now = params.lastSeenAt || new Date();

  const isIntegration = params.intent === "integration_request";
  const isUnknown = params.intent === "unknown";
  const category = isIntegration ? "integration_demand" : "knowledge_gap";
  const priority = isUnknown ? "medium" : "high";

  await AiriRecommendation.findOneAndUpdate(
    { workspaceId, dedupeKey },
    {
      $setOnInsert: {
        workspaceId,
        dedupeKey,
        status: "new",
        source: "auto_gap",
        priority,
      },
      $set: {
        title: copy.title,
        description: copy.description,
        intent: params.intent,
        category,
        lastSeenAt: now,
        links: copy.links,
        metadata: {
          latestReason: params.reason,
          latestAskCount: params.askCount,
          ...(integrationTopic ? { integrationTopic } : {}),
        },
      },
      $max: {
        occurrences: Math.max(1, Math.floor(params.askCount)),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}
