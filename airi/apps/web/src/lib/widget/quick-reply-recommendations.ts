import "server-only";

import connectDB from "@/lib/mongoose";
import AiriRecommendation from "@/models/airi-recommendation";
import AnswerSnippet, {
  ensureAnswerSnippetIndexes,
} from "@/models/answer-snippet";
import { Scenario } from "@/models/scenario";
export {
  MAX_WIDGET_QUICK_REPLIES,
  isLegacyDefaultWidgetQuickReplies,
  normalizeWidgetQuickReply,
} from "@icecore/shared/lib/widget-localization";
import {
  MAX_WIDGET_QUICK_REPLIES,
  normalizeWidgetQuickReply,
} from "@icecore/shared/lib/widget-localization";

type QuickReplyRecommendationOptions = {
  limit?: number;
};

const COMPLETED_GAP_STATUSES = ["completed"] as const;
const COMPLETED_GAP_CATEGORIES = [
  "knowledge_gap",
  "integration_demand",
] as const;

const INTENT_QUESTION_MAP: Record<string, string> = {
  business_hours: "What are your business hours?",
  pricing: "How much does this cost?",
  policy: "What is your refund policy?",
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function normalizeIntegrationTopicLabel(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map(part => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function buildIntegrationQuestion(topic: unknown): string {
  const topicLabel = normalizeIntegrationTopicLabel(topic);
  if (!topicLabel) {
    return "Do you support this integration?";
  }
  return `Do you support ${topicLabel} integration?`;
}

function toScenarioQuestion(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const name = value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.?!]+$/, "");
  if (!name) {
    return null;
  }

  return `Can you help me with ${name}?`;
}

function mapCompletedTaskToQuestion(card: {
  intent?: unknown;
  metadata?: Record<string, unknown>;
}): string | null {
  const intent =
    typeof card.intent === "string" ? card.intent.trim().toLowerCase() : "";
  if (!intent) {
    return null;
  }

  if (intent === "integration_request") {
    return buildIntegrationQuestion(card.metadata?.integrationTopic);
  }

  return INTENT_QUESTION_MAP[intent] || null;
}

export async function getWorkspaceRecommendedQuickReplies(
  workspaceId: string,
  options: QuickReplyRecommendationOptions = {}
): Promise<string[]> {
  const normalizedWorkspaceId = String(workspaceId || "").trim();
  if (!normalizedWorkspaceId) {
    return [];
  }

  const limit = clamp(
    options.limit ?? MAX_WIDGET_QUICK_REPLIES,
    1,
    MAX_WIDGET_QUICK_REPLIES
  );

  try {
    await connectDB();
    await ensureAnswerSnippetIndexes();

    const [snippetRows, completedGapRows, activeScenarioRows] =
      await Promise.all([
        AnswerSnippet.find({
          workspaceId: normalizedWorkspaceId,
          safe: { $ne: false },
        })
          .select("question updatedAt")
          .sort({ updatedAt: -1 })
          .limit(limit * 3)
          .lean<Array<{ question?: unknown }>>(),
        AiriRecommendation.find({
          workspaceId: normalizedWorkspaceId,
          status: { $in: COMPLETED_GAP_STATUSES },
          category: { $in: COMPLETED_GAP_CATEGORIES },
          source: "auto_gap",
        })
          .select("intent metadata occurrences updatedAt")
          .sort({ occurrences: -1, updatedAt: -1 })
          .limit(limit * 2)
          .lean<
            Array<{ intent?: unknown; metadata?: Record<string, unknown> }>
          >(),
        Scenario.find({
          workspaceId: normalizedWorkspaceId,
          status: "active",
          mode: "conversation",
        })
          .select("name priority updatedAt")
          .sort({ priority: -1, updatedAt: -1 })
          .limit(limit * 2)
          .lean<Array<{ name?: unknown }>>(),
      ]);

    const candidates: string[] = [];
    const seen = new Set<string>();

    const addCandidate = (value: string | null | undefined) => {
      if (!value) {
        return;
      }

      const normalized = normalizeWidgetQuickReply(value);
      if (!normalized) {
        return;
      }

      const key = normalized.toLowerCase();
      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      candidates.push(normalized);
    };

    snippetRows.forEach(row => {
      if (typeof row.question === "string") {
        addCandidate(row.question);
      }
    });

    completedGapRows.forEach(row => {
      addCandidate(mapCompletedTaskToQuestion(row));
    });

    activeScenarioRows.forEach(row => {
      addCandidate(toScenarioQuestion(row.name));
    });

    return candidates.slice(0, limit);
  } catch (error) {
    console.warn(
      "[Widget Quick Replies] Failed to build workspace recommendations",
      {
        workspaceId: normalizedWorkspaceId,
        error,
      }
    );
    return [];
  }
}
