import "server-only";

import {
  AIChatProviderAggregateError,
  buildEmbeddingMetadata,
  chatCompletionWithFallback,
  getDocumentEmbeddingResult,
  getHeavyTextModel,
  getLightTextModel,
} from "@/lib/ai";
import { extractJsonObject } from "@/lib/ai/json-object";
import { withWorkspaceTextAiAction } from "@/lib/ai/workspace-ai-policy";
import { isWorkspaceAiPolicyError } from "@/lib/ai/workspace-ai-errors";
import { getAppVersion } from "@/lib/app-version";
import { CATEGORY_CHANGE_CONFIDENCE_FLOOR } from "@/lib/classifier/conversation-analysis-constants";
import {
  CLASSIFICATION_MESSAGE_SELECT,
  buildConversationMetadataContext,
  resolveConversationClassificationBusinessContextStrict,
  type ClassificationConversationContext,
} from "@/lib/classifier/conversation-analysis-context";
import {
  calculateInteractionMetrics,
  mapKeyMoments,
  prepareTextForAnalysis,
} from "@/lib/classifier/conversation-analysis-helpers";
import type {
  ClassificationResult,
  ConversationClassificationAttemptTrace,
  ConversationClassificationBusinessContext,
  ConversationClassificationProposal,
  ExecuteConversationClassificationResult,
  ResolvedConversationClassificationTaxonomy,
} from "@/lib/classifier/conversation-analysis-types";
import {
  ConversationAnalysisRevisionConflictError,
  CONVERSATION_CLASSIFICATION_MEDIA_RECHECK_MS,
  ConversationClassificationCasError,
  buildConversationClassificationLeaseFilter,
  commitConversationClassificationReady,
  commitConversationClassificationReviewRequired,
  deferClaimedConversationClassification,
  recordConversationClassificationFailure,
  releaseStaleConversationClassificationLease,
  renewConversationClassificationLease,
  type ClaimedConversationClassification,
  type ConversationClassificationLeaseIdentity,
} from "@/lib/classifier/conversation-classification-store";
import {
  InvalidClassificationOutputError,
  areAllConversationClassificationAttemptsSafetyBlocked,
  classifyConversationClassificationAttemptError,
  createConversationClassificationError,
  normalizeConversationClassificationFailure,
  serializeConversationClassificationLogError,
} from "@/lib/classifier/conversation-classification-errors";
import {
  buildConversationClassificationPrompt,
  parseConversationClassificationOutput,
} from "@/lib/classifier/conversation-classification-output";
import { resolveConversationClassificationSummaryProposal } from "@/lib/classifier/conversation-classification-summary-proposal";
import { processConversationImageAnalysis } from "@/lib/classifier/conversation-media-analysis";
import {
  getPaymentEvidenceCandidateIndices,
  mapClassificationPaymentSuggestions,
} from "@/lib/classifier/conversation-payment-evidence";
import {
  matchAllowedOption,
  resolveStableCategory,
} from "@/lib/classifier/decision";
import { getWorkspaceTaxonomyStrict } from "@/lib/classifier/taxonomy-server";
import { CONVERSATION_CLASSIFICATION_LEASE_MS } from "@/lib/classifier/classification-contract";
import {
  assertConversationClassificationEffectInputs,
  type ConversationClassificationEffectInputs,
} from "@/models/conversation-analysis-revision";
import { Conversation } from "@/models/conversation";
import type { PopulatedMessage } from "@/types/models";
import { createLogger } from "@icecore/shared/lib/logger";

import "@/models/chat";
import "@/models/user";

export type { ExecuteConversationClassificationResult } from "@/lib/classifier/conversation-analysis-types";

const classificationLog = createLogger("conversation-classification-executor");
const CLASSIFIER_CONTRACT_REVISION = 2;
const CLASSIFICATION_CANONICAL_ATTEMPTS = 2;
const CLASSIFICATION_PROVIDER_DEADLINE_MS = 60_000;
const CLASSIFICATION_PROVIDER_ATTEMPT_TIMEOUT_MS = 30_000;
const CLASSIFICATION_HEARTBEAT_INTERVAL_MS = Math.floor(
  CONVERSATION_CLASSIFICATION_LEASE_MS / 3
);
const PENDING_MEDIA_STATUSES = new Set(["queued", "processing", "submitted"]);

type SourceIdentityConversation = {
  _id: unknown;
  workspaceId?: string | null;
  sourceId?: unknown;
};

type ClassificationConversation = SourceIdentityConversation &
  ClassificationConversationContext & {
    messages: PopulatedMessage[];
    history_summary?: string | null;
    classification?: { category?: string | null } | null;
  };

type ClassificationComputation = {
  proposal: ConversationClassificationProposal;
  projection: Record<string, unknown>;
  effectInputs: ConversationClassificationEffectInputs;
  taxonomy: ResolvedConversationClassificationTaxonomy;
};

class ConversationClassificationLeaseLostError extends Error {
  constructor() {
    super("Conversation classification lease was lost");
    this.name = "ConversationClassificationLeaseLostError";
  }
}

class SerializedClassificationLeaseController {
  private lease: ConversationClassificationLeaseIdentity;
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private lost = false;
  private heartbeatError: unknown = null;

  constructor(claim: ClaimedConversationClassification) {
    this.lease = leaseFromClaim(claim);
  }

  start(): void {
    this.scheduleHeartbeat();
  }

  currentLease(): ConversationClassificationLeaseIdentity {
    return { ...this.lease };
  }

  serialize<T>(
    operation: (lease: ConversationClassificationLeaseIdentity) => Promise<T>
  ): Promise<T> {
    const queued = this.chain.then(() => operation(this.currentLease()));
    this.chain = queued.then(
      () => undefined,
      () => undefined
    );
    return queued;
  }

  async renew(
    manual = false
  ): Promise<ConversationClassificationLeaseIdentity | null> {
    return this.renewInternal({
      allowStopped: manual,
      allowHeartbeatRecovery: false,
    });
  }

  async renewForFailure(): Promise<ConversationClassificationLeaseIdentity | null> {
    return this.renewInternal({
      allowStopped: true,
      allowHeartbeatRecovery: true,
    });
  }

  async assertOwned(): Promise<void> {
    return this.serialize(async () => {
      if (this.heartbeatError) throw this.heartbeatError;
      if (this.lost) throw new ConversationClassificationLeaseLostError();
      if (this.lease.expiresAt.getTime() <= Date.now()) {
        this.lost = true;
        throw new ConversationClassificationLeaseLostError();
      }
    });
  }

  private async renewInternal(input: {
    allowStopped: boolean;
    allowHeartbeatRecovery: boolean;
  }): Promise<ConversationClassificationLeaseIdentity | null> {
    if (this.heartbeatError && !input.allowHeartbeatRecovery) {
      throw this.heartbeatError;
    }
    if (this.lost || (this.stopped && !input.allowStopped)) return null;
    return this.serialize(async lease => {
      if (this.heartbeatError && !input.allowHeartbeatRecovery) {
        throw this.heartbeatError;
      }
      if (this.lost || (this.stopped && !input.allowStopped)) return null;
      const renewed = await renewConversationClassificationLease(lease);
      if (!renewed) {
        this.lost = true;
        return null;
      }
      this.lease = renewed;
      return this.currentLease();
    });
  }

  async stopAndDrain(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.chain;
  }

  private scheduleHeartbeat(): void {
    if (this.stopped || this.lost || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.renew().then(
        () => this.scheduleHeartbeat(),
        error => {
          this.heartbeatError = error;
          classificationLog.warn("classification.heartbeat_failed", {
            conversation_id: String(this.lease.conversationId),
            revision: this.lease.revision,
            fence: this.lease.fence,
            error: serializeConversationClassificationLogError(error),
          });
        }
      );
    }, CLASSIFICATION_HEARTBEAT_INTERVAL_MS);
  }
}

function leaseFromClaim(
  claim: ClaimedConversationClassification
): ConversationClassificationLeaseIdentity {
  return {
    conversationId: claim.conversationId,
    revision: claim.revision,
    ownerToken: claim.ownerToken,
    fence: claim.fence,
    expiresAt: claim.expiresAt,
  };
}

function sourceIdFromRoot(
  conversation: SourceIdentityConversation
): string | null {
  if (!Object.prototype.hasOwnProperty.call(conversation, "sourceId")) {
    return null;
  }
  if (conversation.sourceId === null) return null;
  return typeof conversation.sourceId === "string" ? conversation.sourceId : "";
}

async function loadClaimedSourceIdentity(input: {
  claim: ClaimedConversationClassification;
  controller: SerializedClassificationLeaseController;
}): Promise<SourceIdentityConversation | null> {
  return input.controller.serialize(
    async lease =>
      (await Conversation.findOne({
        ...buildConversationClassificationLeaseFilter({
          ...lease,
          now: new Date(),
        }),
        workspaceId: input.claim.workspaceId,
      })
        .select("_id workspaceId sourceId")
        .lean()
        .exec()) as SourceIdentityConversation | null
  );
}

async function loadClaimedConversation(input: {
  claim: ClaimedConversationClassification;
  controller: SerializedClassificationLeaseController;
}): Promise<ClassificationConversation | null> {
  return input.controller.serialize(
    async lease =>
      (await Conversation.findOne({
        ...buildConversationClassificationLeaseFilter({
          ...lease,
          now: new Date(),
        }),
        workspaceId: input.claim.workspaceId,
      })
        .select(
          [
            "_id",
            "workspaceId",
            "sourceId",
            "channel",
            "subject",
            "page_url",
            "preferred_language",
            "last_inbound_at",
            "last_outbound_at",
            "engagement_metrics",
            "whatsappReferral",
            "external_thread",
            "history_summary",
            "classification",
            "messages",
          ].join(" ")
        )
        .populate({
          path: "messages",
          select: CLASSIFICATION_MESSAGE_SELECT,
          populate: { path: "author", select: "firstName isBot" },
        })
        .lean()
        .exec()) as ClassificationConversation | null
  );
}

function hasPendingInboundMedia(messages: PopulatedMessage[]): boolean {
  return messages.some(message => {
    if (message.direction !== "inbound") return false;
    if (
      message.mediaType !== "audio" &&
      message.mediaType !== "voice" &&
      message.mediaType !== "video"
    ) {
      return false;
    }
    const status = message.mediaAnalysis?.status;
    if (!status || !PENDING_MEDIA_STATUSES.has(status)) return false;
    const terminalAnalysis =
      message.mediaType === "video"
        ? message.videoAnalysis
        : message.audioAnalysis;
    if (typeof terminalAnalysis === "string" && terminalAnalysis.trim()) {
      return false;
    }
    return Boolean(
      (typeof message.imageUrl === "string" && message.imageUrl.trim()) ||
        message.attachments?.some(
          attachment =>
            typeof attachment?.url === "string" && attachment.url.trim()
        ) ||
        message.mediaAnalysis?.workflowId ||
        message.mediaAnalysis?.providerRequestId
    );
  });
}

function attemptIdentity(error: unknown): {
  provider: string | null;
  model: string | null;
} {
  if (!(error instanceof AIChatProviderAggregateError)) {
    return { provider: null, model: null };
  }
  const first = error.providerErrors[0];
  return {
    provider:
      first && typeof first.provider === "string" ? first.provider : null,
    model: first && typeof first.model === "string" ? first.model : null,
  };
}

async function runCanonicalClassificationAttempts(input: {
  claim: ClaimedConversationClassification;
  businessContext: ConversationClassificationBusinessContext;
  conversationContext: string;
  textForAnalysis: string;
  taxonomy: ResolvedConversationClassificationTaxonomy["taxonomy"];
  existingCategory: string | null;
  presentedMessageCount: number;
  paymentEvidenceMessageIndices: number[];
  controller: SerializedClassificationLeaseController;
}): Promise<
  | { kind: "ready"; proposal: ConversationClassificationProposal }
  | {
      kind: "review_required";
      attempts: ConversationClassificationAttemptTrace[];
    }
> {
  const attempts: ConversationClassificationAttemptTrace[] = [];
  let repairReason: string | undefined;
  const deadlineAt = Date.now() + CLASSIFICATION_PROVIDER_DEADLINE_MS;
  // High-volume background work: light tier first, heavy tier for the
  // repair/escalation attempt.
  const models = [getLightTextModel(), getHeavyTextModel()];

  for (
    let attemptIndex = 0;
    attemptIndex < CLASSIFICATION_CANONICAL_ATTEMPTS;
    attemptIndex += 1
  ) {
    await input.controller.assertOwned();
    const remainingTotalMs = deadlineAt - Date.now();
    if (remainingTotalMs < 1_000) {
      attempts.push({
        outcome: "operational_failure",
        provider: null,
        model: models[attemptIndex] ?? null,
        error: {
          message: "Classification provider deadline was exhausted",
          code: "classification_provider_deadline_exhausted",
        },
      });
      break;
    }
    const timeoutMs = Math.min(
      CLASSIFICATION_PROVIDER_ATTEMPT_TIMEOUT_MS,
      remainingTotalMs
    );
    try {
      const response = await chatCompletionWithFallback({
        model: models[attemptIndex],
        trace: false,
        analytics: {
          workspaceId: input.claim.workspaceId,
          conversationId: String(input.claim.conversationId),
          operation: "classification.contract_v2",
          sourceService: "web.classifier",
        },
        messages: buildConversationClassificationPrompt({
          businessContext: input.businessContext,
          conversationContext: input.conversationContext,
          textForAnalysis: input.textForAnalysis,
          taxonomy: input.taxonomy,
          existingCategory: input.existingCategory,
          presentedMessageCount: input.presentedMessageCount,
          paymentEvidenceMessageIndices: input.paymentEvidenceMessageIndices,
          repairReason,
        }),
        responseFormat: { type: "json_object" },
        temperature: 0,
        resilience: {
          maxRetries: 0,
          disableInternalFallbacks: true,
          timeoutMs,
        },
      });
      let parsed: unknown;
      try {
        parsed = extractJsonObject(response.content);
      } catch (error) {
        throw new InvalidClassificationOutputError("$json", String(error));
      }
      const result = parseConversationClassificationOutput(parsed, {
        taxonomyLabels: input.taxonomy.labels,
        presentedMessageCount: input.presentedMessageCount,
      });
      attempts.push({
        outcome: "success",
        provider: response.provider,
        model: response.model,
      });
      return {
        kind: "ready",
        proposal: {
          result,
          provider: response.provider,
          model: response.model,
          attempts,
        },
      };
    } catch (error) {
      if (isWorkspaceAiPolicyError(error)) throw error;
      if (error instanceof InvalidClassificationOutputError) {
        attempts.push({
          outcome: "invalid_output",
          provider: null,
          model: null,
          error: serializeConversationClassificationLogError(error),
        });
        repairReason = "Previous classification output was invalid";
        continue;
      }
      const outcome = classifyConversationClassificationAttemptError(error);
      attempts.push({
        outcome,
        ...attemptIdentity(error),
        error: serializeConversationClassificationLogError(error),
      });
      repairReason =
        outcome === "safety_blocked"
          ? "Previous provider attempt was safety blocked"
          : "Previous classification provider attempt failed";
    }
  }

  if (areAllConversationClassificationAttemptsSafetyBlocked(attempts)) {
    return { kind: "review_required", attempts };
  }
  if (attempts.every(attempt => attempt.outcome === "invalid_output")) {
    throw createConversationClassificationError(
      "invalid_classification_output"
    );
  }
  throw createConversationClassificationError("classification_provider_failed");
}

async function buildEmbeddingProjection(
  summary: string,
  controller: SerializedClassificationLeaseController
): Promise<Record<string, unknown>> {
  await controller.assertOwned();
  try {
    const generated = await getDocumentEmbeddingResult(summary);
    if (
      generated &&
      Array.isArray(generated.embedding) &&
      generated.embedding.length > 0 &&
      generated.embedding.every(Number.isFinite) &&
      typeof generated.provider === "string" &&
      generated.provider.trim() === generated.provider &&
      generated.provider.length > 0 &&
      typeof generated.model === "string" &&
      generated.model.trim() === generated.model &&
      generated.model.length > 0 &&
      typeof generated.taskType === "string" &&
      generated.taskType.trim() === generated.taskType &&
      generated.taskType.length > 0 &&
      Number.isSafeInteger(generated.dimensions) &&
      generated.dimensions === generated.embedding.length
    ) {
      const metadata = buildEmbeddingMetadata(generated);
      if (
        metadata.embeddingProvider !== generated.provider ||
        metadata.embeddingModel !== generated.model ||
        metadata.embeddingTaskType !== generated.taskType ||
        metadata.embeddingDimensions !== generated.dimensions
      ) {
        throw new Error(
          "Embedding metadata does not match the generated vector"
        );
      }
      return {
        embedding: generated.embedding,
        ...metadata,
      };
    }
  } catch (error) {
    classificationLog.warn("classification.embedding_unavailable", {
      error: serializeConversationClassificationLogError(error),
    });
  }
  return {
    embedding: null,
    embeddingProvider: null,
    embeddingModel: null,
    embeddingTaskType: null,
    embeddingDimensions: null,
  };
}

function buildReadyProjection(input: {
  result: ClassificationResult;
  finalCategory: string;
  finalCategoryConfidence: number;
  messages: PopulatedMessage[];
  messagesOffset: number;
  metrics: ReturnType<typeof calculateInteractionMetrics>;
  historySummary: string | null;
  embedding: Record<string, unknown>;
}): Record<string, unknown> {
  const confidence = {
    ...input.result.confidence,
    category: input.finalCategoryConfidence,
  };
  return {
    classification: {
      category: input.finalCategory,
      priority: input.result.priority,
      sentiment: input.result.sentiment,
      summary: input.result.summary,
      action: input.result.action,
      tags: input.result.tags,
      confidence,
    },
    shadow_classification: {
      category: input.result.category,
      priority: input.result.priority,
      sentiment: input.result.sentiment,
      summary: input.result.summary,
      action: input.result.action,
      tags: input.result.tags,
      confidence: input.result.confidence,
    },
    agent_performance_scorecard:
      input.result.agent_performance_scorecard ?? null,
    is_best_practice: input.result.is_best_practice,
    extracted_entities: input.result.extracted_entities,
    payment_suggestions: mapClassificationPaymentSuggestions(
      input.result.payment_evidence ?? [],
      input.messages.slice(input.messagesOffset)
    ),
    key_moments: mapKeyMoments(
      input.result.key_moments,
      input.messages,
      input.messagesOffset
    ),
    interaction_metrics: input.metrics,
    ...(input.historySummary ? { history_summary: input.historySummary } : {}),
    ...input.embedding,
  };
}

async function computeClassification(input: {
  claim: ClaimedConversationClassification;
  conversation: ClassificationConversation;
  businessContext: ConversationClassificationBusinessContext;
  startedAt: number;
  controller: SerializedClassificationLeaseController;
}): Promise<
  | { kind: "ready"; computation: ClassificationComputation }
  | {
      kind: "review_required";
      taxonomy: ResolvedConversationClassificationTaxonomy;
    }
> {
  const messages = Array.isArray(input.conversation.messages)
    ? input.conversation.messages
    : [];
  const metrics = calculateInteractionMetrics(messages);
  await input.controller.assertOwned();
  const ragSummary = await resolveConversationClassificationSummaryProposal({
    conversationId: String(input.claim.conversationId),
    workspaceId: input.claim.workspaceId,
    messages,
    historySummary: input.conversation.history_summary,
    language: input.businessContext.airiLanguage,
  });
  const prepared = prepareTextForAnalysis(
    messages,
    input.conversation.history_summary || undefined,
    ragSummary?.summary || null
  );
  const conversationContext = buildConversationMetadataContext(
    input.conversation
  );
  await input.controller.assertOwned();
  const taxonomy = await getWorkspaceTaxonomyStrict(input.claim.workspaceId);
  const existingCategory =
    typeof input.conversation.classification?.category === "string"
      ? input.conversation.classification.category
      : null;
  const attempts = await runCanonicalClassificationAttempts({
    claim: input.claim,
    businessContext: input.businessContext,
    conversationContext,
    textForAnalysis: prepared.text,
    taxonomy: taxonomy.taxonomy,
    existingCategory,
    presentedMessageCount: Math.max(
      0,
      messages.length - prepared.messagesOffset
    ),
    paymentEvidenceMessageIndices: getPaymentEvidenceCandidateIndices(
      messages.slice(prepared.messagesOffset)
    ),
    controller: input.controller,
  });
  if (attempts.kind === "review_required") {
    return { kind: "review_required", taxonomy };
  }

  const proposal = attempts.proposal;
  const predictedCategory = matchAllowedOption(
    proposal.result.category,
    taxonomy.taxonomy.labels
  );
  const defaultCategory =
    matchAllowedOption("Other", taxonomy.taxonomy.labels) ||
    taxonomy.taxonomy.labels[0] ||
    "Other";
  const confidenceThreshold = taxonomy.taxonomy.confidenceThreshold ?? 0.7;
  const finalCategory = resolveStableCategory({
    predictedCategory,
    predictedConfidence: proposal.result.confidence.category,
    confidenceThreshold,
    existingCategory,
    allowedCategories: taxonomy.taxonomy.labels,
    defaultCategory,
    changeConfidenceFloor: CATEGORY_CHANGE_CONFIDENCE_FLOOR,
  });
  const finalCategoryConfidence =
    finalCategory === proposal.result.category
      ? proposal.result.confidence.category
      : confidenceThreshold;
  const embedding = await buildEmbeddingProjection(
    proposal.result.summary,
    input.controller
  );
  const projection = buildReadyProjection({
    result: proposal.result,
    finalCategory,
    finalCategoryConfidence,
    messages,
    messagesOffset: prepared.messagesOffset,
    metrics,
    historySummary: ragSummary?.summary || null,
    embedding,
  });
  const elapsed = Date.now() - input.startedAt;
  const effectInputs: ConversationClassificationEffectInputs = {
    companyId: input.businessContext.companyId,
    source: input.businessContext.source
      ? {
          id: input.businessContext.source.id,
          type: input.businessContext.source.type,
        }
      : { id: null, type: null },
    predictedCategoryConfidence: proposal.result.confidence.category,
    processingTimeMs: elapsed,
    provider: proposal.provider,
    model: proposal.model,
    ragSummary,
  };
  assertConversationClassificationEffectInputs(effectInputs);
  return {
    kind: "ready",
    computation: { proposal, projection, effectInputs, taxonomy },
  };
}

async function returnStale(
  controller: SerializedClassificationLeaseController
): Promise<ExecuteConversationClassificationResult> {
  await controller.stopAndDrain();
  await releaseStaleConversationClassificationLease({
    lease: controller.currentLease(),
  });
  return { status: "stale" };
}

async function persistFailure(input: {
  error: unknown;
  controller: SerializedClassificationLeaseController;
  terminalLease: ConversationClassificationLeaseIdentity | null;
}): Promise<ExecuteConversationClassificationResult> {
  const failedLease = input.terminalLease ?? input.controller.currentLease();
  classificationLog.warn("classification.execution_failed", {
    conversation_id: String(failedLease.conversationId),
    revision: failedLease.revision,
    error: serializeConversationClassificationLogError(input.error),
  });
  await input.controller.stopAndDrain();
  const lease =
    input.terminalLease ?? (await input.controller.renewForFailure());
  if (!lease) return returnStale(input.controller);

  const conflict =
    input.error instanceof ConversationAnalysisRevisionConflictError
      ? createConversationClassificationError(
          "analysis_revision_conflict",
          input.error
        )
      : input.error;
  const failure = normalizeConversationClassificationFailure(conflict);
  const persisted = await recordConversationClassificationFailure({
    lease,
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
  });
  if (!persisted) return { status: "stale" };
  if (persisted.status === "failed") return { status: "failed" };
  if (!persisted.nextAttemptAt) {
    throw new Error("Pending classification failure has no retry time");
  }
  return {
    status: "retry_scheduled",
    nextAttemptAt: persisted.nextAttemptAt,
  };
}

export async function executeConversationClassification(
  claim: ClaimedConversationClassification
): Promise<ExecuteConversationClassificationResult> {
  return withWorkspaceTextAiAction(
    {
      workspaceId: claim.workspaceId,
      actionId: `classification:${claim.conversationId}:${claim.revision}`,
      // Background analysis nobody requested must not drain the allowance replies rely on.
      sponsorship: "platform",
    },
    () => executeConversationClassificationImpl(claim)
  );
}

async function executeConversationClassificationImpl(
  claim: ClaimedConversationClassification
): Promise<ExecuteConversationClassificationResult> {
  const startedAt = Date.now();
  const controller = new SerializedClassificationLeaseController(claim);
  let terminalLease: ConversationClassificationLeaseIdentity | null = null;
  controller.start();

  try {
    const root = await loadClaimedSourceIdentity({ claim, controller });
    if (!root) return returnStale(controller);
    const sourceId = sourceIdFromRoot(root);
    await controller.assertOwned();
    const businessContext =
      await resolveConversationClassificationBusinessContextStrict({
        workspaceId: claim.workspaceId,
        sourceId,
      });
    await controller.assertOwned();
    try {
      await processConversationImageAnalysis({
        conversationId: String(claim.conversationId),
        language: businessContext.airiLanguage,
        context: {
          workspaceId: claim.workspaceId,
          sourceId: businessContext.source?.id ?? null,
        },
      });
    } catch (error) {
      throw createConversationClassificationError(
        "media_preprocessing_failed",
        error
      );
    }

    if (!(await controller.renew(true))) return returnStale(controller);
    const conversation = await loadClaimedConversation({ claim, controller });
    if (!conversation) return returnStale(controller);
    if (hasPendingInboundMedia(conversation.messages || [])) {
      await controller.stopAndDrain();
      const recheckAt = new Date(
        Date.now() + CONVERSATION_CLASSIFICATION_MEDIA_RECHECK_MS
      );
      const deferred = await deferClaimedConversationClassification({
        lease: controller.currentLease(),
        recheckAt,
      });
      return deferred
        ? { status: "media_deferred", recheckAt }
        : { status: "stale" };
    }

    const computed = await computeClassification({
      claim,
      conversation,
      businessContext,
      startedAt,
      controller,
    });
    await controller.stopAndDrain();
    terminalLease = await controller.renew(true);
    if (!terminalLease) return returnStale(controller);
    const finalTaxonomy = await getWorkspaceTaxonomyStrict(claim.workspaceId);
    const initialTaxonomy =
      computed.kind === "ready"
        ? computed.computation.taxonomy
        : computed.taxonomy;
    if (finalTaxonomy.digest !== initialTaxonomy.digest) {
      throw createConversationClassificationError("taxonomy_changed");
    }
    const provenance = {
      taxonomyId: initialTaxonomy.taxonomy.id || null,
      taxonomyDigest: initialTaxonomy.digest,
      classifierVersion: getAppVersion().version,
      classifierContractRevision: CLASSIFIER_CONTRACT_REVISION,
    };

    if (computed.kind === "review_required") {
      await commitConversationClassificationReviewRequired({
        lease: terminalLease,
        workspaceId: claim.workspaceId,
        review: {
          code: "provider_safety_blocked",
          reason: "Every classification provider attempt was safety blocked",
        },
        provenance,
      });
      return { status: "review_required" };
    }

    const committed = await commitConversationClassificationReady({
      lease: terminalLease,
      workspaceId: claim.workspaceId,
      projection: computed.computation.projection,
      provenance,
      effectInputs: computed.computation.effectInputs,
    });
    return {
      status: "ready",
      analysisRevisionId: committed.analysisRevisionId,
    };
  } catch (error) {
    if (error instanceof ConversationClassificationLeaseLostError) {
      return returnStale(controller);
    }
    if (error instanceof ConversationClassificationCasError) {
      await controller.stopAndDrain();
      return { status: "stale" };
    }
    return persistFailure({ error, controller, terminalLease });
  }
}
