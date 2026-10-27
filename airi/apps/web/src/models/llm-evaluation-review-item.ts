import mongoose, { Schema, model, models } from "mongoose";

export const LLM_EVALUATION_REVIEW_STATUSES = [
  "open",
  "resolved",
  "ignored",
] as const;

export const LLM_EVALUATION_ISSUE_TYPES = [
  "knowledge_gap",
  "unsupported_answer",
  "bad_retrieval",
  "scenario_action_mismatch",
  "escalation_issue",
  "tone_policy_issue",
  "cost_latency_spike",
  "other",
] as const;

export const LLM_EVALUATION_FIX_TYPES = [
  "knowledge_base_update",
  "scenario_change",
  "prompt_rubric_change",
  "handoff_rule_change",
  "no_change",
] as const;

export type LlmEvaluationReviewStatus =
  (typeof LLM_EVALUATION_REVIEW_STATUSES)[number];
export type LlmEvaluationIssueType =
  (typeof LLM_EVALUATION_ISSUE_TYPES)[number];
export type LlmEvaluationFixType = (typeof LLM_EVALUATION_FIX_TYPES)[number];

export const LLM_EVALUATION_REVIEW_ITEM_LEGACY_DEDUPE_INDEX_NAME =
  "workspaceId_1_dedupeKey_1";

export const LLM_EVALUATION_REVIEW_ITEM_DEDUPE_INDEX = {
  key: { workspaceId: 1, dedupeKey: 1 } as const,
  options: {
    background: true,
    name: "llm_review_items_workspace_dedupe_unique_v2",
    partialFilterExpression: { dedupeKey: { $type: "string" } },
    unique: true,
  } as const,
};

export type LlmEvaluationReviewItemDoc = mongoose.Document & {
  workspaceId: string;
  dedupeKey?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  traceId?: string | null;
  scoreEventId?: string | null;
  status: LlmEvaluationReviewStatus;
  issueType: LlmEvaluationIssueType;
  severity: "critical" | "high" | "medium" | "low" | "info";
  source: "system_eval" | "llm_judge" | "human_review" | "customer_feedback";
  title: string;
  summary?: string | null;
  inputExcerpt?: string | null;
  outputExcerpt?: string | null;
  reasoningExcerpt?: string | null;
  humanEvaluation?: {
    relevanceScore?: number | null;
    trustworthinessScore?: number | null;
    concisenessScore?: number | null;
    completenessScore?: number | null;
    safetyScore?: number | null;
    overallScore?: number | null;
    judgeExplanation?: string | null;
    datasetDecision?:
      | "candidate"
      | "add_to_golden"
      | "do_not_add"
      | "needs_more_context"
      | null;
    datasetSplit?: "train" | "validation" | "test" | null;
  };
  suggestedFix?: {
    type?: LlmEvaluationFixType;
    title?: string;
    description?: string;
    targetId?: string;
    payload?: Record<string, unknown>;
  };
  resolvedByUserId?: string | null;
  resolvedAt?: Date | null;
  ignoredReason?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
};

const SuggestedFixSchema = new Schema<Record<string, unknown>>(
  {
    type: {
      type: String,
      enum: LLM_EVALUATION_FIX_TYPES,
      default: "no_change",
    },
    title: { type: String, default: null },
    description: { type: String, default: null },
    targetId: { type: String, default: null, index: true },
    payload: { type: Schema.Types.Mixed, default: undefined },
  },
  { _id: false }
);

const HumanEvaluationSchema = new Schema<Record<string, unknown>>(
  {
    relevanceScore: { type: Number, min: 0, max: 1, default: null },
    trustworthinessScore: { type: Number, min: 0, max: 1, default: null },
    concisenessScore: { type: Number, min: 0, max: 1, default: null },
    completenessScore: { type: Number, min: 0, max: 1, default: null },
    safetyScore: { type: Number, min: 0, max: 1, default: null },
    overallScore: { type: Number, min: 0, max: 1, default: null },
    judgeExplanation: { type: String, default: null },
    datasetDecision: {
      type: String,
      enum: ["candidate", "add_to_golden", "do_not_add", "needs_more_context"],
      default: "candidate",
      index: true,
    },
    datasetSplit: {
      type: String,
      enum: ["train", "validation", "test"],
      default: "validation",
      index: true,
    },
  },
  { _id: false }
);

const LlmEvaluationReviewItemSchema = new Schema<LlmEvaluationReviewItemDoc>(
  {
    workspaceId: { type: String, required: true, index: true },
    dedupeKey: { type: String, default: undefined, index: true },
    conversationId: { type: String, default: null, index: true },
    messageId: { type: String, default: null, index: true },
    traceId: { type: String, default: null, index: true },
    scoreEventId: { type: String, default: null, index: true },
    status: {
      type: String,
      enum: LLM_EVALUATION_REVIEW_STATUSES,
      default: "open",
      index: true,
    },
    issueType: {
      type: String,
      enum: LLM_EVALUATION_ISSUE_TYPES,
      required: true,
      index: true,
    },
    severity: {
      type: String,
      enum: ["critical", "high", "medium", "low", "info"],
      default: "medium",
      index: true,
    },
    source: {
      type: String,
      enum: ["system_eval", "llm_judge", "human_review", "customer_feedback"],
      default: "system_eval",
      index: true,
    },
    title: { type: String, required: true },
    summary: { type: String, default: null },
    inputExcerpt: { type: String, default: null },
    outputExcerpt: { type: String, default: null },
    reasoningExcerpt: { type: String, default: null },
    humanEvaluation: { type: HumanEvaluationSchema, default: undefined },
    suggestedFix: { type: SuggestedFixSchema, default: undefined },
    resolvedByUserId: { type: String, default: null, index: true },
    resolvedAt: { type: Date, default: null, index: true },
    ignoredReason: { type: String, default: null },
  },
  { timestamps: true }
);

LlmEvaluationReviewItemSchema.index({
  workspaceId: 1,
  status: 1,
  severity: 1,
  createdAt: -1,
});
LlmEvaluationReviewItemSchema.index({
  workspaceId: 1,
  issueType: 1,
  createdAt: -1,
});
LlmEvaluationReviewItemSchema.index(
  LLM_EVALUATION_REVIEW_ITEM_DEDUPE_INDEX.key,
  LLM_EVALUATION_REVIEW_ITEM_DEDUPE_INDEX.options
);

export default (models.LlmEvaluationReviewItem as mongoose.Model<LlmEvaluationReviewItemDoc>) ||
  model<LlmEvaluationReviewItemDoc>(
    "LlmEvaluationReviewItem",
    LlmEvaluationReviewItemSchema
  );
