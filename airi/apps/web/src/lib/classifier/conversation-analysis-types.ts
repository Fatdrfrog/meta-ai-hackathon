import type {
  ElevenLabsTranscriptionSubmissionResult,
  ElevenLabsTranscriptionWebhookMetadata,
  SubmitTranscriptionOptions,
} from "@icecore/airi-runtime/elevenlabs-stt";
import type { ConversationPreferredLanguage } from "@icecore/shared/types/conversation";
import type {
  AgentPerformanceScorecard,
  ClassificationPriority,
  ClassificationSentiment,
  ExtractedEntity,
} from "@icecore/shared/types/models";

import type { WorkspaceTaxonomy } from "@/lib/classifier/taxonomy";
import type { ClassificationPaymentEvidence } from "@/lib/classifier/conversation-payment-evidence";
import type { ConversationClassificationEffectInputs } from "@/models/conversation-analysis-revision";

export type AiriLanguage = ConversationPreferredLanguage;

export const CLASSIFICATION_ENTITY_TYPES = [
  "product",
  "competitor",
  "price",
  "order_number",
  "feature_request",
] as const;
export type ClassificationEntityType =
  (typeof CLASSIFICATION_ENTITY_TYPES)[number];

export const CLASSIFICATION_KEY_MOMENT_TYPES = [
  "price_inquiry",
  "objection",
  "positive_feedback",
  "negative_feedback",
  "upsell_attempt",
] as const;
export type ClassificationKeyMomentType =
  (typeof CLASSIFICATION_KEY_MOMENT_TYPES)[number];

export interface ClassificationResult {
  category: string;
  priority: ClassificationPriority;
  sentiment: ClassificationSentiment;
  summary: string;
  action: string;
  tags: string[];
  confidence: {
    category: number;
    priority: number;
    sentiment: number;
  };
  extracted_entities: Array<
    ExtractedEntity & { type: ClassificationEntityType }
  >;
  key_moments: Array<{
    type: ClassificationKeyMomentType;
    message_index: number;
  }>;
  agent_performance_scorecard?: AgentPerformanceScorecard;
  is_best_practice: boolean;
  payment_evidence?: ClassificationPaymentEvidence[];
}

export type ConversationClassificationBusinessContext = {
  workspaceId: string;
  companyId: string;
  businessContext: string;
  airiLanguage: ConversationPreferredLanguage;
  source: { id: string; type: string } | null;
};

export type ResolvedConversationClassificationTaxonomy = {
  taxonomy: WorkspaceTaxonomy;
  digest: string;
};

export type ConversationClassificationAttemptOutcome =
  | "success"
  | "safety_blocked"
  | "invalid_output"
  | "operational_failure";

export type ConversationClassificationAttemptTrace = {
  outcome: ConversationClassificationAttemptOutcome;
  provider: string | null;
  model: string | null;
  error?: { message: string; name?: string; code?: string };
};

export type ConversationClassificationProposal = {
  result: ClassificationResult;
  provider: string;
  model: string;
  attempts: ConversationClassificationAttemptTrace[];
};

export type ConversationClassificationSummaryProposal = NonNullable<
  ConversationClassificationEffectInputs["ragSummary"]
>;

export type ResolvedAnalysisMedia = {
  url: string;
  mimeType?: string | null;
  inlineDataBase64?: string;
};

export type MediaResolution =
  | { kind: "resolved"; media: ResolvedAnalysisMedia }
  | { kind: "permanently_unavailable" };

export type MediaAnalysisContext = {
  workspaceId: string;
  sourceId: string | null;
};

export type ConversationMediaTranscriptionSubmitter = {
  submitAudio: (
    mediaUrl: string,
    mimeType: string | undefined,
    metadata: ElevenLabsTranscriptionWebhookMetadata,
    options?: SubmitTranscriptionOptions
  ) => Promise<ElevenLabsTranscriptionSubmissionResult>;
  submitVideo: (
    mediaUrl: string,
    mimeType: string | undefined,
    metadata: ElevenLabsTranscriptionWebhookMetadata,
    options?: SubmitTranscriptionOptions
  ) => Promise<ElevenLabsTranscriptionSubmissionResult>;
};

export type ConversationMediaMessageAnalysisResult = {
  status: "submitted" | "completed" | "skipped" | "failed";
  transcriptStored: boolean;
  analysisStored: boolean;
  providerRequestId?: string | null;
  error?: string | null;
};

export type ExecuteConversationClassificationResult =
  | { status: "ready"; analysisRevisionId: string }
  | { status: "review_required" }
  | { status: "retry_scheduled"; nextAttemptAt: Date }
  | { status: "failed" }
  | { status: "media_deferred"; recheckAt: Date }
  | { status: "stale" };
