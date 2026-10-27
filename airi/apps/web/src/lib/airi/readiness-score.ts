import AiriGapEvent from "@/models/airi-gap-event";
import AnswerSnippet from "@/models/answer-snippet";
import Message from "@/models/message";
import { Scenario } from "@/models/scenario";
import type { createClient } from "@/lib/supabase/server";
import type { WorkspaceGapInsight } from "@/lib/airi/rag/knowledge/knowledge-gap-tracker";

const DEFAULT_READINESS_TARGET = 0.95;
const DEFAULT_READINESS_WINDOW_DAYS = 30;

const COMPONENT_WEIGHTS = {
  scenarioCoverage: 0.4,
  knowledgeCoverage: 0.25,
  snippetCoverage: 0.15,
  gapPressure: 0.2,
} as const;

export type AiriReadinessMetrics = {
  publishedKbArticlesCount: number;
  verifiedSnippetsCount: number;
  activeScenariosCount: number;
  inboundMessagesCount: number;
  gapEventsCount: number;
};

export type AiriReadinessComponents = {
  scenarioCoverage: number;
  knowledgeCoverage: number;
  snippetCoverage: number;
  gapPressure: number;
};

export type AiriReadinessResult = {
  score: number;
  target: number;
  status: "ready" | "improving" | "risky";
  components: AiriReadinessComponents;
  metrics: AiriReadinessMetrics;
  topGaps: WorkspaceGapInsight[];
  windowDays: number;
};

function clamp(value: number, min: number = 0, max: number = 1): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function roundScore(value: number): number {
  return Math.round(clamp(value) * 1000) / 1000;
}

function normalizeTarget(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_READINESS_TARGET;
  return clamp(parsed, 0.5, 1);
}

function computeCoverage(value: number, targetCount: number): number {
  if (targetCount <= 0) return 0;
  return clamp(value / targetCount);
}

function computeGapPressure(params: {
  gapEventsCount: number;
  inboundMessagesCount: number;
}): number {
  const { gapEventsCount, inboundMessagesCount } = params;
  if (inboundMessagesCount <= 0) return 0.8;

  const gapRate = gapEventsCount / inboundMessagesCount;
  // 0% gaps => 1.0 score, >=20% gaps => 0 score.
  return clamp(1 - gapRate / 0.2);
}

export function calculateReadinessScore(params: {
  metrics: AiriReadinessMetrics;
  target?: number;
}): Omit<AiriReadinessResult, "topGaps" | "windowDays"> {
  const target = normalizeTarget(params.target);
  const metrics = params.metrics;

  const components: AiriReadinessComponents = {
    scenarioCoverage: computeCoverage(metrics.activeScenariosCount, 5),
    knowledgeCoverage: computeCoverage(metrics.publishedKbArticlesCount, 20),
    snippetCoverage: computeCoverage(metrics.verifiedSnippetsCount, 30),
    gapPressure: computeGapPressure({
      gapEventsCount: metrics.gapEventsCount,
      inboundMessagesCount: metrics.inboundMessagesCount,
    }),
  };

  const weightedScore =
    components.scenarioCoverage * COMPONENT_WEIGHTS.scenarioCoverage +
    components.knowledgeCoverage * COMPONENT_WEIGHTS.knowledgeCoverage +
    components.snippetCoverage * COMPONENT_WEIGHTS.snippetCoverage +
    components.gapPressure * COMPONENT_WEIGHTS.gapPressure;

  const score = roundScore(weightedScore);
  const status =
    score >= target ? "ready" : score >= target - 0.2 ? "improving" : "risky";

  return {
    score,
    target,
    status,
    components: {
      scenarioCoverage: roundScore(components.scenarioCoverage),
      knowledgeCoverage: roundScore(components.knowledgeCoverage),
      snippetCoverage: roundScore(components.snippetCoverage),
      gapPressure: roundScore(components.gapPressure),
    },
    metrics,
  };
}

async function getPublishedKbArticlesCount(
  supabase: Awaited<ReturnType<typeof createClient>>,
  workspaceId: string
): Promise<number> {
  const { count, error } = await supabase
    .from("kb_articles")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("status", "published");

  if (error) {
    console.warn("[Airi] Failed to fetch KB article count for readiness", {
      workspaceId,
      error,
    });
    return 0;
  }

  return count ?? 0;
}

export async function getWorkspaceAiriReadiness(params: {
  workspaceId: string;
  supabase: Awaited<ReturnType<typeof createClient>>;
  readinessTarget?: number;
  sinceDays?: number;
}): Promise<AiriReadinessResult> {
  const sinceDays =
    typeof params.sinceDays === "number" && Number.isFinite(params.sinceDays)
      ? Math.max(1, Math.floor(params.sinceDays))
      : DEFAULT_READINESS_WINDOW_DAYS;
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

  const { getWorkspaceGapInsights } = await import(
    "@/lib/airi/rag/knowledge/knowledge-gap-tracker"
  );

  const [
    publishedKbArticlesCount,
    verifiedSnippetsCount,
    activeScenariosCount,
    inboundMessagesCount,
    gapEventsCount,
    topGaps,
  ] = await Promise.all([
    getPublishedKbArticlesCount(params.supabase, params.workspaceId),
    AnswerSnippet.countDocuments({
      workspaceId: params.workspaceId,
    }),
    Scenario.countDocuments({
      workspaceId: params.workspaceId,
      status: "active",
      deletedAt: null,
    }),
    Message.countDocuments({
      workspaceId: params.workspaceId,
      direction: "inbound",
      date: { $gte: since },
    }),
    AiriGapEvent.countDocuments({
      workspaceId: params.workspaceId,
      createdAt: { $gte: since },
    }),
    getWorkspaceGapInsights({
      workspaceId: params.workspaceId,
      sinceDays,
      limit: 3,
    }),
  ]);

  const metrics: AiriReadinessMetrics = {
    publishedKbArticlesCount,
    verifiedSnippetsCount,
    activeScenariosCount,
    inboundMessagesCount,
    gapEventsCount,
  };

  const scoreResult = calculateReadinessScore({
    metrics,
    target: params.readinessTarget,
  });

  return {
    ...scoreResult,
    topGaps,
    windowDays: sinceDays,
  };
}
