import "server-only";

import { createLogger } from "@icecore/shared/lib/logger";

import type { GeneratedEmbedding } from "@/lib/ai/embedding-types";
import { trackConversationClassificationCompleted } from "@/lib/analytics";
import { persistConversationSummaryRevision } from "@/lib/airi/rag/conversation-summary/conversation-summary-storage";
import { emitWorkspaceUsageDelta } from "@/lib/limits/company-usage-events";
import { enqueueConversationClassificationReadyRealtimeEvent } from "@/lib/realtime/server";
import { triggerClassificationCompletedStrict } from "@/lib/webhook-events";
import {
  assertConversationClassificationEffectInputs,
  type ConversationClassificationEffectInputs,
} from "@/models/conversation-analysis-revision";
import { isPlainRecord, hasExactKeys } from "@icecore/shared/lib/value-utils";
import { CLASSIFICATION_OUTPUT_LIMITS } from "./conversation-analysis-constants";
import { CONVERSATION_ANALYSIS_EFFECTS_LEASE_MS } from "./classification-contract";
import {
  CONVERSATION_ANALYSIS_EFFECT_STEPS,
  authorizeConversationAnalysisEffectStep,
  claimConversationAnalysisEffects,
  completeConversationAnalysisEffects,
  completeConversationAnalysisEffectStep,
  recordConversationAnalysisEffectsFailure,
  renewConversationAnalysisEffectsLease,
  type ConversationAnalysisEffectStep,
  type ConversationAnalysisEffectsLeaseIdentity,
  type ConversationAnalysisEffectsSnapshot,
} from "./conversation-classification-store";

const classificationEffectsLog = createLogger(
  "conversation-classification-effects"
);
const EFFECTS_HEARTBEAT_DELAY_MS = Math.max(
  1,
  Math.floor(CONVERSATION_ANALYSIS_EFFECTS_LEASE_MS / 3)
);
const MAX_EFFECT_ID_LENGTH = 256;
const MAX_EFFECT_CLASSIFICATION_LABEL_LENGTH = 256;

type EffectsOwnershipOutcome = "superseded" | "lease_lost";
type EffectsErrorScope = ConversationAnalysisEffectStep | "control";

export type ClassificationEffectsSanitizedError = Readonly<{
  scope: EffectsErrorScope;
  name: "Error" | "InvariantError";
  code: string;
  message: string;
}>;

export type ClassificationEffectsStepOutcome = Readonly<{
  step: ConversationAnalysisEffectStep;
  status:
    | "already_completed"
    | "completed"
    | "failed"
    | "ownership_lost"
    | "authority_conflict";
  durationMs: number;
}>;

export type ClassificationEffectsWideEvent = Readonly<{
  event: "classification.effects";
  service: "conversation-classification-effects";
  environment: string;
  timestamp: string;
  analysisRevisionId: string;
  conversationId: string;
  workspaceId: string;
  sourceRevision: number | null;
  attemptCount: number;
  fence: number;
  steps: readonly ClassificationEffectsStepOutcome[];
  errors: readonly ClassificationEffectsSanitizedError[];
  terminalStatus:
    | "completed"
    | "retry_scheduled"
    | "superseded"
    | "lease_lost"
    | "unpersisted_error";
  durationMs: number;
}>;

export type DispatchConversationClassificationEffectsResult =
  | { status: "completed" }
  | { status: "retry_scheduled"; nextAttemptAt: Date }
  | { status: "superseded" }
  | { status: "lease_lost" };

export type ConversationClassificationEffectsDependencies = Readonly<{
  claimConversationAnalysisEffects: typeof claimConversationAnalysisEffects;
  renewConversationAnalysisEffectsLease: typeof renewConversationAnalysisEffectsLease;
  authorizeConversationAnalysisEffectStep: typeof authorizeConversationAnalysisEffectStep;
  completeConversationAnalysisEffectStep: typeof completeConversationAnalysisEffectStep;
  completeConversationAnalysisEffects: typeof completeConversationAnalysisEffects;
  recordConversationAnalysisEffectsFailure: typeof recordConversationAnalysisEffectsFailure;
  persistConversationSummaryRevision: typeof persistConversationSummaryRevision;
  trackConversationClassificationCompleted: typeof trackConversationClassificationCompleted;
  enqueueConversationClassificationReadyRealtimeEvent: typeof enqueueConversationClassificationReadyRealtimeEvent;
  emitWorkspaceUsageDelta: typeof emitWorkspaceUsageDelta;
  triggerClassificationCompletedStrict: typeof triggerClassificationCompletedStrict;
  now: () => Date;
  setTimer: (
    callback: () => void,
    delayMs: number
  ) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  writeWideEvent: (event: ClassificationEffectsWideEvent) => void;
}>;

const productionDependencies: ConversationClassificationEffectsDependencies =
  Object.freeze({
    claimConversationAnalysisEffects,
    renewConversationAnalysisEffectsLease,
    authorizeConversationAnalysisEffectStep,
    completeConversationAnalysisEffectStep,
    completeConversationAnalysisEffects,
    recordConversationAnalysisEffectsFailure,
    persistConversationSummaryRevision,
    trackConversationClassificationCompleted,
    enqueueConversationClassificationReadyRealtimeEvent,
    emitWorkspaceUsageDelta,
    triggerClassificationCompletedStrict,
    now: () => new Date(),
    setTimer: (callback: () => void, delayMs: number) =>
      setTimeout(callback, delayMs),
    clearTimer: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    writeWideEvent: (event: ClassificationEffectsWideEvent) => {
      classificationEffectsLog.info("classification.effects", event);
    },
  });

type ValidatedEffectsSnapshot = Readonly<{
  analysisRevisionId: string;
  conversationId: string;
  workspaceId: string;
  sourceRevision: number;
  completedAtMs: number;
  completedAtIso: string;
  existingEmbedding?: { text: string; result: GeneratedEmbedding };
  projection: Readonly<{
    classification: Readonly<{
      category: string;
      priority: string;
      sentiment: string;
      summary: string;
      confidence: Readonly<{ category: number }>;
    }>;
  }>;
  effectInputs: Readonly<ConversationClassificationEffectInputs>;
  checklist: Readonly<Record<ConversationAnalysisEffectStep, number | null>>;
}>;

function hasOwnField(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function hasPlainOwnFields(
  value: unknown,
  fields: readonly string[]
): value is Record<string, unknown> {
  return (
    isPlainRecord(value) && fields.every(field => hasOwnField(value, field))
  );
}

function readOwnField(value: Record<string, unknown>, field: string): unknown {
  return hasOwnField(value, field) ? value[field] : undefined;
}

function boundedNonEmptyText(
  value: unknown,
  field: string,
  maximumLength: number
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximumLength ||
    value !== value.trim()
  ) {
    throw new Error(`Claimed effects snapshot ${field} is invalid`);
  }
  return value;
}

function validDateMs(value: unknown, field: string): number {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`Claimed effects snapshot ${field} is invalid`);
  }
  return value.getTime();
}

function clonePlainValue<T>(value: T): T {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new Error("Claimed effects snapshot contains a sparse array");
      }
    }
    const hasExtraEnumerableKey = Object.keys(value).some(key => {
      const index = Number(key);
      return (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= value.length ||
        String(index) !== key
      );
    });
    const hasEnumerableSymbol = Object.getOwnPropertySymbols(value).some(
      symbol => Object.prototype.propertyIsEnumerable.call(value, symbol)
    );
    if (hasExtraEnumerableKey || hasEnumerableSymbol) {
      throw new Error("Claimed effects snapshot array shape is invalid");
    }
    return value.map(item => clonePlainValue(item)) as T;
  }
  if (!isPlainRecord(value)) {
    throw new Error("Claimed effects snapshot contains a non-plain value");
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, clonePlainValue(item)])
  ) as T;
}

function deepFreezePlain<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreezePlain(item);
    return Object.freeze(value);
  }
  if (isPlainRecord(value)) {
    for (const item of Object.values(value)) deepFreezePlain(item);
    return Object.freeze(value) as T;
  }
  return value;
}

function validateLeaseIdentity(
  lease: unknown
): asserts lease is ConversationAnalysisEffectsLeaseIdentity {
  if (
    !isPlainRecord(lease) ||
    !hasExactKeys(lease, [
      "analysisRevisionId",
      "conversationId",
      "sourceRevision",
      "ownerToken",
      "fence",
      "expiresAt",
      "attemptCount",
    ])
  ) {
    throw new Error("Claimed effects lease identity is invalid");
  }
  let conversationId: string;
  try {
    conversationId = String(lease.conversationId);
  } catch {
    throw new Error("Claimed effects lease identity is invalid");
  }
  if (
    typeof lease.analysisRevisionId !== "string" ||
    lease.analysisRevisionId.trim().length === 0 ||
    lease.analysisRevisionId !== lease.analysisRevisionId.trim() ||
    lease.analysisRevisionId.length > MAX_EFFECT_ID_LENGTH ||
    conversationId.trim().length === 0 ||
    conversationId !== conversationId.trim() ||
    conversationId.length > MAX_EFFECT_ID_LENGTH ||
    typeof lease.sourceRevision !== "number" ||
    !Number.isSafeInteger(lease.sourceRevision) ||
    lease.sourceRevision <= 0 ||
    typeof lease.ownerToken !== "string" ||
    lease.ownerToken.trim().length === 0 ||
    lease.ownerToken !== lease.ownerToken.trim() ||
    lease.ownerToken.length > MAX_EFFECT_ID_LENGTH ||
    typeof lease.fence !== "number" ||
    !Number.isSafeInteger(lease.fence) ||
    lease.fence <= 0 ||
    typeof lease.attemptCount !== "number" ||
    !Number.isSafeInteger(lease.attemptCount) ||
    lease.attemptCount <= 0 ||
    !(lease.expiresAt instanceof Date) ||
    !Number.isFinite(lease.expiresAt.getTime())
  ) {
    throw new Error("Claimed effects lease identity is invalid");
  }
}

function validateAndFreezeConversationAnalysisEffectsSnapshot(input: {
  requestedAnalysisRevisionId: string;
  lease: ConversationAnalysisEffectsLeaseIdentity;
  analysis: ConversationAnalysisEffectsSnapshot;
}): ValidatedEffectsSnapshot {
  validateLeaseIdentity(input.lease);
  const raw = input.analysis as unknown;
  if (
    !isPlainRecord(raw) ||
    !hasExactKeys(raw, [
      "analysisRevisionId",
      "conversationId",
      "workspaceId",
      "sourceRevision",
      "completedAt",
      "outcome",
      "projection",
      "effectInputs",
      "checklist",
    ])
  ) {
    throw new Error("Claimed effects snapshot shape is invalid");
  }

  const analysisRevisionId = boundedNonEmptyText(
    raw.analysisRevisionId,
    "analysisRevisionId",
    MAX_EFFECT_ID_LENGTH
  );
  const conversationId = boundedNonEmptyText(
    raw.conversationId,
    "conversationId",
    MAX_EFFECT_ID_LENGTH
  );
  const workspaceId = boundedNonEmptyText(
    raw.workspaceId,
    "workspaceId",
    MAX_EFFECT_ID_LENGTH
  );
  if (
    input.requestedAnalysisRevisionId !== analysisRevisionId ||
    input.lease.analysisRevisionId !== analysisRevisionId ||
    String(input.lease.conversationId) !== conversationId ||
    input.lease.sourceRevision !== raw.sourceRevision
  ) {
    throw new Error("Claimed effects snapshot identity is inconsistent");
  }
  if (
    !Number.isSafeInteger(raw.sourceRevision) ||
    (raw.sourceRevision as number) <= 0 ||
    raw.outcome !== "ready"
  ) {
    throw new Error("Claimed effects snapshot outcome or revision is invalid");
  }
  const completedAtMs = validDateMs(raw.completedAt, "completedAt");

  const rawChecklist = raw.checklist;
  if (!isPlainRecord(rawChecklist)) {
    throw new Error("Claimed effects snapshot checklist is invalid");
  }
  if (!hasExactKeys(rawChecklist, CONVERSATION_ANALYSIS_EFFECT_STEPS)) {
    throw new Error("Claimed effects snapshot checklist is not exact");
  }
  const checklist = Object.fromEntries(
    CONVERSATION_ANALYSIS_EFFECT_STEPS.map(step => {
      const value = rawChecklist[step];
      if (value === null) return [step, null];
      return [step, validDateMs(value, `checklist.${step}`)];
    })
  ) as Record<ConversationAnalysisEffectStep, number | null>;

  if (!isPlainRecord(raw.effectInputs)) {
    throw new Error("Claimed effects snapshot effectInputs is invalid");
  }
  assertConversationClassificationEffectInputs(raw.effectInputs);
  const effectInputs = clonePlainValue(raw.effectInputs);
  assertConversationClassificationEffectInputs(effectInputs);

  if (
    !isPlainRecord(raw.projection) ||
    !hasOwnField(raw.projection, "classification")
  ) {
    throw new Error("Claimed effects snapshot projection is invalid");
  }
  const rawClassification = raw.projection.classification;
  if (
    !isPlainRecord(rawClassification) ||
    !["category", "priority", "sentiment", "summary", "confidence"].every(
      field => hasOwnField(rawClassification, field)
    )
  ) {
    throw new Error("Claimed effects snapshot classification is invalid");
  }
  const rawConfidence = rawClassification.confidence;
  if (
    !isPlainRecord(rawConfidence) ||
    !hasOwnField(rawConfidence, "category")
  ) {
    throw new Error("Claimed effects snapshot confidence is invalid");
  }
  const projectionConfidence = rawConfidence.category;
  if (
    typeof projectionConfidence !== "number" ||
    !Number.isFinite(projectionConfidence) ||
    projectionConfidence < 0 ||
    projectionConfidence > 1
  ) {
    throw new Error(
      "Claimed effects snapshot projection category confidence is invalid"
    );
  }
  const projection = {
    classification: {
      category: boundedNonEmptyText(
        rawClassification.category,
        "classification.category",
        MAX_EFFECT_CLASSIFICATION_LABEL_LENGTH
      ),
      priority: boundedNonEmptyText(
        rawClassification.priority,
        "classification.priority",
        MAX_EFFECT_CLASSIFICATION_LABEL_LENGTH
      ),
      sentiment: boundedNonEmptyText(
        rawClassification.sentiment,
        "classification.sentiment",
        MAX_EFFECT_CLASSIFICATION_LABEL_LENGTH
      ),
      summary: boundedNonEmptyText(
        rawClassification.summary,
        "classification.summary",
        CLASSIFICATION_OUTPUT_LIMITS.summaryLength
      ),
      confidence: { category: projectionConfidence },
    },
  };

  const stored = raw.projection;
  const existingEmbedding =
    Array.isArray(stored.embedding) &&
    stored.embedding.length > 0 &&
    stored.embedding.length <= 65536 &&
    stored.embedding.every(
      value => typeof value === "number" && Number.isFinite(value)
    ) &&
    stored.embeddingDimensions === stored.embedding.length &&
    (stored.embeddingProvider === "vertex" ||
      stored.embeddingProvider === "openai") &&
    stored.embeddingTaskType === "RETRIEVAL_DOCUMENT" &&
    typeof stored.embeddingModel === "string" &&
    stored.embeddingModel.length > 0 &&
    stored.embeddingModel.length <= 256
      ? {
          text: projection.classification.summary,
          result: {
            embedding: [...stored.embedding] as number[],
            provider: stored.embeddingProvider,
            model: stored.embeddingModel,
            dimensions: stored.embedding.length,
            taskType: "RETRIEVAL_DOCUMENT",
          } as GeneratedEmbedding,
        }
      : undefined;

  return deepFreezePlain({
    ...(existingEmbedding ? { existingEmbedding } : {}),
    analysisRevisionId,
    conversationId,
    workspaceId,
    sourceRevision: raw.sourceRevision as number,
    completedAtMs,
    completedAtIso: new Date(completedAtMs).toISOString(),
    projection,
    effectInputs,
    checklist,
  });
}

function cloneLease(
  lease: ConversationAnalysisEffectsLeaseIdentity
): ConversationAnalysisEffectsLeaseIdentity {
  return { ...lease, expiresAt: new Date(lease.expiresAt) };
}

function assertRenewedLease(
  previous: ConversationAnalysisEffectsLeaseIdentity,
  renewed: unknown
): asserts renewed is ConversationAnalysisEffectsLeaseIdentity {
  validateLeaseIdentity(renewed);
  if (
    renewed.analysisRevisionId !== previous.analysisRevisionId ||
    String(renewed.conversationId) !== String(previous.conversationId) ||
    renewed.sourceRevision !== previous.sourceRevision ||
    renewed.ownerToken !== previous.ownerToken ||
    renewed.fence !== previous.fence ||
    renewed.attemptCount !== previous.attemptCount ||
    renewed.expiresAt.getTime() <= previous.expiresAt.getTime()
  ) {
    throw new Error("Renewed effects lease identity is invalid");
  }
}

type SerializedControllerResult<T> =
  | { status: "ok"; value: T }
  | { status: EffectsOwnershipOutcome }
  | {
      status: "control_error";
      kind: "renewal" | "store";
    };

class SerializedEffectsLeaseController {
  private latestLease: ConversationAnalysisEffectsLeaseIdentity;
  private tail: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatStopped = false;
  private ownership: EffectsOwnershipOutcome | null = null;
  private controlFailure: {
    kind: "renewal" | "store";
  } | null = null;

  constructor(
    lease: ConversationAnalysisEffectsLeaseIdentity,
    private readonly deps: ConversationClassificationEffectsDependencies
  ) {
    this.latestLease = cloneLease(lease);
  }

  private cancelHeartbeat(): void {
    this.heartbeatStopped = true;
    if (this.timer) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private setOwnership(outcome: EffectsOwnershipOutcome): void {
    if (!this.ownership) this.ownership = outcome;
    this.cancelHeartbeat();
  }

  private serialize<T>(
    kind: "renewal" | "store",
    operation: (lease: ConversationAnalysisEffectsLeaseIdentity) => Promise<T>,
    options: { recoverControlFailure?: boolean } = {}
  ): Promise<SerializedControllerResult<T>> {
    const result = this.tail.then(
      async (): Promise<SerializedControllerResult<T>> => {
        if (this.ownership) return { status: this.ownership };
        if (this.controlFailure && !options.recoverControlFailure) {
          return { status: "control_error", ...this.controlFailure };
        }
        try {
          const value = await operation(cloneLease(this.latestLease));
          if (options.recoverControlFailure) this.controlFailure = null;
          return { status: "ok", value };
        } catch {
          this.controlFailure = { kind };
          this.cancelHeartbeat();
          return { status: "control_error", kind };
        }
      }
    );
    this.tail = result.then(() => undefined);
    return result;
  }

  async renew(
    options: {
      recoverControlFailure?: boolean;
    } = {}
  ): Promise<
    | { status: "renewed" }
    | { status: EffectsOwnershipOutcome }
    | { status: "control_error"; kind: "renewal" | "store" }
  > {
    return this.serialize(
      "renewal",
      async current => {
        const rawResult: unknown =
          await this.deps.renewConversationAnalysisEffectsLease(current);
        if (!hasPlainOwnFields(rawResult, ["status"])) {
          throw new Error("Unexpected effects lease renewal result");
        }
        const status = rawResult.status;
        if (status === "renewed") {
          if (!hasOwnField(rawResult, "lease")) {
            throw new Error("Unexpected effects lease renewal result");
          }
          const renewedLease = rawResult.lease;
          assertRenewedLease(current, renewedLease);
          this.latestLease = cloneLease(renewedLease);
          return "renewed" as const;
        }
        if (status === "superseded" || status === "lease_lost") {
          this.setOwnership(status);
          return status;
        }
        throw new Error("Unexpected effects lease renewal result");
      },
      options
    ).then(result => {
      if (result.status !== "ok") return result;
      return result.value === "renewed"
        ? { status: "renewed" as const }
        : { status: result.value };
    });
  }

  async authorize(
    step: ConversationAnalysisEffectStep
  ): Promise<
    | { status: "authorized" | "already_completed" }
    | { status: EffectsOwnershipOutcome }
    | { status: "control_error"; kind: "renewal" | "store" }
  > {
    return this.serialize("store", async current => {
      const result = await this.deps.authorizeConversationAnalysisEffectStep({
        lease: current,
        step,
      });
      if (result === "superseded" || result === "lease_lost") {
        this.setOwnership(result);
        return result;
      }
      if (result !== "authorized" && result !== "already_completed") {
        throw new Error("Unexpected effect authorization result");
      }
      return result;
    }).then(result =>
      result.status === "ok" ? { status: result.value } : result
    );
  }

  async completeStep(
    step: ConversationAnalysisEffectStep
  ): Promise<
    | { status: "completed" | "already_completed" }
    | { status: EffectsOwnershipOutcome }
    | { status: "control_error"; kind: "renewal" | "store" }
  > {
    return this.serialize("store", async current => {
      const result = await this.deps.completeConversationAnalysisEffectStep({
        lease: current,
        step,
      });
      if (result === "superseded" || result === "lease_lost") {
        this.setOwnership(result);
        return result;
      }
      if (result !== "completed" && result !== "already_completed") {
        throw new Error("Unexpected effect step completion result");
      }
      return result;
    }).then(result =>
      result.status === "ok" ? { status: result.value } : result
    );
  }

  async completeAll(): Promise<
    | { status: "completed" | "incomplete" }
    | { status: EffectsOwnershipOutcome }
    | { status: "control_error"; kind: "renewal" | "store" }
  > {
    return this.serialize("store", async current => {
      const result = await this.deps.completeConversationAnalysisEffects({
        lease: current,
      });
      if (result === "superseded" || result === "lease_lost") {
        this.setOwnership(result);
        return result;
      }
      if (result !== "completed" && result !== "incomplete") {
        throw new Error("Unexpected effects terminal completion result");
      }
      return result;
    }).then(result =>
      result.status === "ok" ? { status: result.value } : result
    );
  }

  async recordFailure(): Promise<
    | { status: "retry_scheduled"; nextAttemptAt: Date }
    | { status: EffectsOwnershipOutcome }
    | { status: "control_error"; kind: "renewal" | "store" }
  > {
    return this.serialize("store", async current => {
      const rawResult: unknown =
        await this.deps.recordConversationAnalysisEffectsFailure({
          lease: current,
        });
      if (!hasPlainOwnFields(rawResult, ["status"])) {
        throw new Error("Unexpected effects failure persistence result");
      }
      const status = rawResult.status;
      if (status === "superseded" || status === "lease_lost") {
        this.setOwnership(status);
        return { status } as const;
      }
      if (
        status !== "retry_scheduled" ||
        !hasOwnField(rawResult, "nextAttemptAt")
      ) {
        throw new Error("Unexpected effects failure persistence result");
      }
      const nextAttemptAt = rawResult.nextAttemptAt;
      if (
        !(nextAttemptAt instanceof Date) ||
        !Number.isFinite(nextAttemptAt.getTime())
      ) {
        throw new Error("Unexpected effects failure persistence result");
      }
      return {
        status: "retry_scheduled" as const,
        nextAttemptAt: new Date(nextAttemptAt),
      };
    }).then(result => (result.status === "ok" ? result.value : result));
  }

  startHeartbeat(): void {
    this.heartbeatStopped = false;
    this.scheduleHeartbeat();
  }

  private scheduleHeartbeat(): void {
    if (
      this.heartbeatStopped ||
      this.ownership ||
      this.controlFailure ||
      this.timer
    ) {
      return;
    }
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.renew().then(result => {
        if (result.status === "renewed") this.scheduleHeartbeat();
      });
    }, EFFECTS_HEARTBEAT_DELAY_MS);
  }

  async stopAndDrain(): Promise<void> {
    this.cancelHeartbeat();
    while (true) {
      const observedTail = this.tail;
      await observedTail;
      if (observedTail === this.tail) return;
    }
  }

  hasControlFailure(): boolean {
    return this.controlFailure !== null;
  }
}

function safeEventIdentity(value: unknown): string {
  if (typeof value !== "string") return "invalid";
  const compact = value.trim();
  return compact ? compact.slice(0, MAX_EFFECT_ID_LENGTH) : "invalid";
}

type SafeClaimEventContext = Readonly<{
  analysisRevisionId: string;
  conversationId: string;
  workspaceId: string;
  sourceRevision: number | null;
  attemptCount: number;
  fence: number;
}>;

function safePositiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : null;
}

function buildSafeClaimEventContext(input: {
  requestedAnalysisRevisionId: unknown;
  rawClaim: unknown;
}): SafeClaimEventContext {
  const fallback: SafeClaimEventContext = {
    analysisRevisionId: safeEventIdentity(input.requestedAnalysisRevisionId),
    conversationId: "invalid",
    workspaceId: "invalid",
    sourceRevision: null,
    attemptCount: 0,
    fence: 0,
  };
  try {
    if (!hasPlainOwnFields(input.rawClaim, ["status"])) return fallback;
    const leaseValue = readOwnField(input.rawClaim, "lease");
    const analysisValue = readOwnField(input.rawClaim, "analysis");
    const rawLease = isPlainRecord(leaseValue) ? leaseValue : null;
    const rawAnalysis = isPlainRecord(analysisValue) ? analysisValue : null;
    return {
      analysisRevisionId: fallback.analysisRevisionId,
      conversationId: safeEventIdentity(
        (rawAnalysis
          ? readOwnField(rawAnalysis, "conversationId")
          : undefined) ??
          (rawLease ? readOwnField(rawLease, "conversationId") : undefined)
      ),
      workspaceId: safeEventIdentity(
        rawAnalysis ? readOwnField(rawAnalysis, "workspaceId") : undefined
      ),
      sourceRevision:
        safePositiveInteger(
          (rawLease ? readOwnField(rawLease, "sourceRevision") : undefined) ??
            (rawAnalysis
              ? readOwnField(rawAnalysis, "sourceRevision")
              : undefined)
        ) ?? null,
      attemptCount:
        safePositiveInteger(
          rawLease ? readOwnField(rawLease, "attemptCount") : undefined
        ) ?? 0,
      fence:
        safePositiveInteger(
          rawLease ? readOwnField(rawLease, "fence") : undefined
        ) ?? 0,
    };
  } catch {
    return fallback;
  }
}

function fixedSanitizedError(input: {
  scope: EffectsErrorScope;
  kind: "handler" | "control" | "invariant";
}): ClassificationEffectsSanitizedError {
  if (input.kind === "invariant") {
    return {
      scope: input.scope,
      name: "InvariantError",
      code: "invariant_violation",
      message: "Classification effects invariant failed",
    };
  }
  if (input.kind === "control") {
    return {
      scope: input.scope,
      name: "Error",
      code: "control_operation_failed",
      message: "Classification effects control operation failed",
    };
  }
  return {
    scope: input.scope,
    name: "Error",
    code: "effect_handler_failed",
    message: "Classification effect handler failed",
  };
}

function durationMs(
  dependencies: ConversationClassificationEffectsDependencies,
  startedAtMs: number
): number {
  const value = dependencies.now().getTime() - startedAtMs;
  return Number.isFinite(value) ? Math.max(0, Math.min(value, 86_400_000)) : 0;
}

class ClassificationEffectsControlError extends Error {
  readonly code = "classification_effects_control_failed";

  constructor() {
    super("Classification effects control operation failed");
    this.name = "ClassificationEffectsControlError";
  }
}

function asError(): Error {
  return new ClassificationEffectsControlError();
}

function cloneEffectInputs(
  input: Readonly<ConversationClassificationEffectInputs>
): ConversationClassificationEffectInputs {
  const cloned = clonePlainValue(
    input
  ) as ConversationClassificationEffectInputs;
  assertConversationClassificationEffectInputs(cloned);
  return deepFreezePlain(cloned);
}

async function executeEffectHandler(
  step: ConversationAnalysisEffectStep,
  snapshot: ValidatedEffectsSnapshot,
  dependencies: ConversationClassificationEffectsDependencies
): Promise<"completed" | "summary_superseded"> {
  if (step === "summary") {
    const result = await dependencies.persistConversationSummaryRevision({
      ...(snapshot.existingEmbedding
        ? { existingEmbedding: snapshot.existingEmbedding }
        : {}),
      workspaceId: snapshot.workspaceId,
      conversationId: snapshot.conversationId,
      analysisRevisionId: snapshot.analysisRevisionId,
      sourceRevision: snapshot.sourceRevision,
      completedAt: new Date(snapshot.completedAtMs),
      ragSummary: deepFreezePlain(
        clonePlainValue(snapshot.effectInputs.ragSummary)
      ),
    });
    if (!hasPlainOwnFields(result, ["status"])) {
      throw new Error("Unexpected conversation summary persistence result");
    }
    if (result.status === "completed") return "completed";
    if (result.status === "superseded") return "summary_superseded";
    throw new Error("Unexpected conversation summary persistence result");
  }
  if (step === "analytics") {
    const result = await dependencies.trackConversationClassificationCompleted({
      analysisRevisionId: snapshot.analysisRevisionId,
      conversationId: snapshot.conversationId,
      sourceRevision: snapshot.sourceRevision,
      completedAt: new Date(snapshot.completedAtMs),
      workspaceId: snapshot.workspaceId,
      effectInputs: cloneEffectInputs(snapshot.effectInputs),
    });
    if (!hasPlainOwnFields(result, ["status"])) {
      throw new Error("Unexpected classification analytics result");
    }
    if (result.status !== "accepted" && result.status !== "disabled") {
      throw new Error("Unexpected classification analytics result");
    }
    return "completed";
  }
  if (step === "realtime") {
    await dependencies.enqueueConversationClassificationReadyRealtimeEvent({
      analysisRevisionId: snapshot.analysisRevisionId,
      conversationId: snapshot.conversationId,
      workspaceId: snapshot.workspaceId,
      completedAt: new Date(snapshot.completedAtMs),
    });
    return "completed";
  }
  if (step === "usage") {
    const result = await dependencies.emitWorkspaceUsageDelta({
      workspaceId: snapshot.workspaceId,
      companyId: snapshot.effectInputs.companyId,
      metric: "classification_count",
      delta: 1,
      objectId: snapshot.conversationId,
      occurredAt: new Date(snapshot.completedAtMs),
      source: "classification",
      metadata: {
        analysisRevisionId: snapshot.analysisRevisionId,
        sourceRevision: snapshot.sourceRevision,
      },
    });
    if (!hasPlainOwnFields(result, ["ok"])) {
      throw new Error("Unexpected classification usage result");
    }
    if (result.ok === true) return "completed";
    if (
      result.ok === false &&
      hasOwnField(result, "skipped") &&
      hasOwnField(result, "reason") &&
      result.skipped === true &&
      result.reason === "disabled"
    ) {
      return "completed";
    }
    throw new Error("Unexpected classification usage result");
  }

  await dependencies.triggerClassificationCompletedStrict(
    snapshot.workspaceId,
    deepFreezePlain({
      conversation_id: snapshot.conversationId,
      category: snapshot.projection.classification.category,
      priority: snapshot.projection.classification.priority,
      sentiment: snapshot.projection.classification.sentiment,
      summary: snapshot.projection.classification.summary,
      confidence: snapshot.projection.classification.confidence.category,
      completed_at: snapshot.completedAtIso,
      analysis_revision_id: snapshot.analysisRevisionId,
      source_revision: snapshot.sourceRevision,
    })
  );
  return "completed";
}

function isOwnershipResult(result: {
  status: string;
}): result is { status: EffectsOwnershipOutcome } {
  return result.status === "superseded" || result.status === "lease_lost";
}

export async function dispatchConversationClassificationEffects(
  input: { analysisRevisionId: string },
  dependencies: ConversationClassificationEffectsDependencies = productionDependencies
): Promise<DispatchConversationClassificationEffectsResult> {
  let rawClaim: unknown;
  try {
    rawClaim = await dependencies.claimConversationAnalysisEffects({
      analysisRevisionId: input.analysisRevisionId,
    });
  } catch {
    throw asError();
  }
  let claimStatus: unknown;
  try {
    if (!hasPlainOwnFields(rawClaim, ["status"])) {
      throw new Error("Invalid effects claim result");
    }
    claimStatus = rawClaim.status;
  } catch {
    throw asError();
  }
  if (claimStatus !== "claimed") {
    if (claimStatus === "retry_scheduled") {
      let nextAttemptAt: unknown;
      try {
        if (!hasPlainOwnFields(rawClaim, ["status", "nextAttemptAt"])) {
          throw new Error("Invalid effects retry claim result");
        }
        nextAttemptAt = rawClaim.nextAttemptAt;
        if (
          !(nextAttemptAt instanceof Date) ||
          !Number.isFinite(nextAttemptAt.getTime())
        ) {
          throw new Error("Invalid effects retry claim date");
        }
      } catch {
        throw asError();
      }
      return {
        status: "retry_scheduled",
        nextAttemptAt: new Date(nextAttemptAt),
      };
    }
    if (
      claimStatus === "completed" ||
      claimStatus === "superseded" ||
      claimStatus === "lease_lost"
    ) {
      return { status: claimStatus };
    }
    throw asError();
  }
  const startedAtMs = dependencies.now().getTime();
  const stepOutcomes: ClassificationEffectsStepOutcome[] = [];
  const errors: ClassificationEffectsSanitizedError[] = [];
  const eventContext = buildSafeClaimEventContext({
    requestedAnalysisRevisionId: input.analysisRevisionId,
    rawClaim,
  });
  let terminalStatus: ClassificationEffectsWideEvent["terminalStatus"] =
    "unpersisted_error";

  const retainError = (
    scope: EffectsErrorScope,
    kind: "handler" | "control" | "invariant"
  ) => {
    if (errors.some(error => error.scope === scope)) return;
    errors.push(fixedSanitizedError({ scope, kind }));
  };
  const finish = <T extends DispatchConversationClassificationEffectsResult>(
    result: T
  ): T => {
    terminalStatus = result.status;
    return result;
  };
  try {
    let controller: SerializedEffectsLeaseController;
    let claimedLease: ConversationAnalysisEffectsLeaseIdentity;
    let claimedAnalysis: unknown;
    try {
      if (!hasPlainOwnFields(rawClaim, ["status", "lease", "analysis"])) {
        throw new Error("Invalid claimed effects envelope");
      }
      const rawLease = rawClaim.lease;
      claimedAnalysis = rawClaim.analysis;
      validateLeaseIdentity(rawLease);
      claimedLease = rawLease;
      controller = new SerializedEffectsLeaseController(
        claimedLease,
        dependencies
      );
    } catch {
      retainError("control", "invariant");
      throw asError();
    }
    const persistFailure =
      async (): Promise<DispatchConversationClassificationEffectsResult> => {
        const result = await controller.recordFailure();
        if (result.status === "control_error") throw asError();
        if (isOwnershipResult(result)) return finish({ status: result.status });
        return finish({
          status: "retry_scheduled",
          nextAttemptAt: new Date(result.nextAttemptAt),
        });
      };

    let validated: ValidatedEffectsSnapshot;
    try {
      validated = validateAndFreezeConversationAnalysisEffectsSnapshot({
        requestedAnalysisRevisionId: input.analysisRevisionId,
        lease: claimedLease,
        analysis: claimedAnalysis as ConversationAnalysisEffectsSnapshot,
      });
    } catch {
      retainError("control", "invariant");
      const renewed = await controller.renew();
      if (renewed.status === "control_error") throw asError();
      if (isOwnershipResult(renewed)) return finish({ status: renewed.status });
      return await persistFailure();
    }

    controller.startHeartbeat();
    for (const step of CONVERSATION_ANALYSIS_EFFECT_STEPS) {
      if (validated.checklist[step] !== null) {
        stepOutcomes.push({
          step,
          status: "already_completed",
          durationMs: 0,
        });
        continue;
      }

      const renewed = await controller.renew();
      if (renewed.status === "control_error") {
        retainError("control", "control");
        break;
      }
      if (isOwnershipResult(renewed)) {
        await controller.stopAndDrain();
        return finish({ status: renewed.status });
      }

      const authorized = await controller.authorize(step);
      if (authorized.status === "control_error") {
        retainError("control", "control");
        break;
      }
      if (isOwnershipResult(authorized)) {
        await controller.stopAndDrain();
        return finish({ status: authorized.status });
      }
      if (authorized.status === "already_completed") {
        stepOutcomes.push({
          step,
          status: "already_completed",
          durationMs: 0,
        });
        continue;
      }

      const handlerStartedAtMs = dependencies.now().getTime();
      let handlerResult: "completed" | "summary_superseded";
      try {
        handlerResult = await executeEffectHandler(
          step,
          validated,
          dependencies
        );
      } catch {
        retainError(step, "handler");
        stepOutcomes.push({
          step,
          status: "failed",
          durationMs: durationMs(dependencies, handlerStartedAtMs),
        });
        continue;
      }

      if (handlerResult === "summary_superseded") {
        stepOutcomes.push({
          step,
          status: "authority_conflict",
          durationMs: durationMs(dependencies, handlerStartedAtMs),
        });
        const authorityRenewed = await controller.renew();
        if (authorityRenewed.status === "control_error") {
          retainError("control", "control");
          break;
        }
        if (isOwnershipResult(authorityRenewed)) {
          await controller.stopAndDrain();
          return finish({ status: authorityRenewed.status });
        }
        const reauthorized = await controller.authorize("summary");
        if (reauthorized.status === "control_error") {
          retainError("control", "control");
          break;
        }
        if (isOwnershipResult(reauthorized)) {
          await controller.stopAndDrain();
          return finish({ status: reauthorized.status });
        }
        retainError("control", "invariant");
        break;
      }

      const completed = await controller.completeStep(step);
      if (completed.status === "control_error") {
        retainError("control", "control");
        break;
      }
      if (isOwnershipResult(completed)) {
        stepOutcomes.push({
          step,
          status: "ownership_lost",
          durationMs: durationMs(dependencies, handlerStartedAtMs),
        });
        await controller.stopAndDrain();
        return finish({ status: completed.status });
      }
      stepOutcomes.push({
        step,
        status: "completed",
        durationMs: durationMs(dependencies, handlerStartedAtMs),
      });
    }

    await controller.stopAndDrain();
    if (controller.hasControlFailure()) {
      retainError("control", "control");
    }
    const finalRenewal = await controller.renew({
      recoverControlFailure: true,
    });
    if (finalRenewal.status === "control_error") {
      retainError("control", "control");
      throw asError();
    }
    if (isOwnershipResult(finalRenewal)) {
      return finish({ status: finalRenewal.status });
    }

    if (errors.length > 0) return await persistFailure();

    const terminal = await controller.completeAll();
    if (terminal.status === "control_error") {
      retainError("control", "control");
      const recovered = await controller.renew({ recoverControlFailure: true });
      if (recovered.status === "control_error") throw asError();
      if (isOwnershipResult(recovered)) {
        return finish({ status: recovered.status });
      }
      return await persistFailure();
    }
    if (isOwnershipResult(terminal)) {
      return finish({ status: terminal.status });
    }
    if (terminal.status === "incomplete") {
      retainError("control", "invariant");
      return await persistFailure();
    }
    return finish({ status: "completed" });
  } finally {
    const finishedAt = dependencies.now();
    const event: ClassificationEffectsWideEvent = {
      event: "classification.effects",
      service: "conversation-classification-effects",
      environment:
        process.env.VERCEL_ENV || process.env.NODE_ENV || "development",
      timestamp: Number.isFinite(finishedAt.getTime())
        ? finishedAt.toISOString()
        : new Date(0).toISOString(),
      analysisRevisionId: eventContext.analysisRevisionId,
      conversationId: eventContext.conversationId,
      workspaceId: eventContext.workspaceId,
      sourceRevision: eventContext.sourceRevision,
      attemptCount: eventContext.attemptCount,
      fence: eventContext.fence,
      steps: stepOutcomes.slice(0, CONVERSATION_ANALYSIS_EFFECT_STEPS.length),
      errors: errors.slice(0, CONVERSATION_ANALYSIS_EFFECT_STEPS.length + 1),
      terminalStatus,
      durationMs: durationMs(dependencies, startedAtMs),
    };
    try {
      dependencies.writeWideEvent(event);
    } catch {
      // Observability must not replace the persisted dispatcher outcome.
    }
  }
}
