import { randomUUID } from "crypto";
import {
  buildCurrentConversationClassificationFilter,
  CONVERSATION_CLASSIFICATION_PROVENANCE_KINDS,
  CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION,
} from "@icecore/shared/lib/conversation-classification-freshness";
import type { ClientSession } from "mongoose";
import mongoose from "mongoose";

import {
  CONVERSATION_ANALYSIS_EFFECT_STEPS,
  ConversationAnalysisRevision,
  assertConversationClassificationEffectInputs,
  buildConversationAnalysisRevisionId,
  type ConversationAnalysisEffectStep,
  type ConversationClassificationEffectInputs,
  type IConversationAnalysisRevision,
} from "@/models/conversation-analysis-revision";
import {
  CONVERSATION_CLASSIFICATION_STATUSES,
  Conversation,
} from "@/models/conversation";
import type { ConversationClassificationStatus } from "@/types/models";
import {
  isPlainRecord,
  hasExactKeys,
  isValidDate,
  isNonNegativeSafeInteger,
} from "@icecore/shared/lib/value-utils";
import {
  CONVERSATION_ANALYSIS_EFFECTS_LEASE_MS,
  CONVERSATION_CLASSIFICATION_LEASE_MS,
} from "./classification-contract";

export { CONVERSATION_ANALYSIS_EFFECT_STEPS };
export type { ConversationAnalysisEffectStep };

const CLASSIFICATION_RETRY_DELAYS_MS = [
  60 * 1000,
  5 * 60 * 1000,
  20 * 60 * 1000,
] as const;
const CLASSIFICATION_MAX_ATTEMPTS = 4;
export const CONVERSATION_CLASSIFICATION_MEDIA_RECHECK_MS = 20 * 60 * 1000;
const EFFECT_RETRY_DELAYS_MS = [
  60 * 1000,
  5 * 60 * 1000,
  20 * 60 * 1000,
  60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
] as const;
const MAX_SAFE_ERROR_CODE_LENGTH = 64;
const MAX_SAFE_ERROR_MESSAGE_LENGTH = 240;

export type ConversationClassificationLeaseIdentity = {
  conversationId: mongoose.Types.ObjectId | string;
  revision: number;
  ownerToken: string;
  fence: number;
  expiresAt: Date;
};

export type ClaimedConversationClassification =
  ConversationClassificationLeaseIdentity & {
    workspaceId: string;
    generation: number;
    attemptCount: number;
    requestedAt: Date;
  };

export type ConversationAnalysisEffectsLeaseIdentity = {
  analysisRevisionId: string;
  conversationId: mongoose.Types.ObjectId | string;
  sourceRevision: number;
  ownerToken: string;
  fence: number;
  expiresAt: Date;
  attemptCount: number;
};

export type ConversationClassificationProvenance = {
  taxonomyId: string | null;
  taxonomyDigest: string | null;
  classifierVersion: string | null;
  classifierContractRevision: number;
};

export type ConversationClassificationStoreDependencies = {
  conversationModel: typeof Conversation;
  analysisRevisionModel: typeof ConversationAnalysisRevision;
  now: () => Date;
  createOwnerToken: () => string;
};

const READY_PROJECTION_PATHS = new Set([
  "classification",
  "shadow_classification",
  "agent_performance_scorecard",
  "is_best_practice",
  "extracted_entities",
  "payment_suggestions",
  "key_moments",
  "interaction_metrics",
  "history_summary",
  "embedding",
  "embeddingProvider",
  "embeddingModel",
  "embeddingTaskType",
  "embeddingDimensions",
]);

export class ConversationClassificationCasError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationClassificationCasError";
  }
}

export class ConversationAnalysisRevisionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationAnalysisRevisionConflictError";
  }
}

function dependencies(
  overrides: Partial<ConversationClassificationStoreDependencies> = {}
): ConversationClassificationStoreDependencies {
  return {
    conversationModel: overrides.conversationModel ?? Conversation,
    analysisRevisionModel:
      overrides.analysisRevisionModel ?? ConversationAnalysisRevision,
    now: overrides.now ?? (() => new Date()),
    createOwnerToken: overrides.createOwnerToken ?? randomUUID,
  };
}

export type ConversationClassificationWakeState = {
  conversationId: string;
  workspaceId: string;
  classificationRevision: number;
  isClassified: boolean;
  classificationMeta: {
    sourceRevision: number | null;
    analysisRevisionId: string | null;
  } | null;
  state: {
    contractVersion: 2;
    status: ConversationClassificationStatus;
    requestedRevision: number;
    processingRevision: number | null;
    appliedRevision: number | null;
    generation: number;
    fence: number;
    requestedAt: Date;
    nextAttemptAt: Date | null;
    lease: {
      ownerToken: string;
      claimedAt: Date;
      expiresAt: Date;
    } | null;
  };
};

const CONVERSATION_CLASSIFICATION_WAKE_PROJECTION = {
  _id: 1,
  workspaceId: 1,
  classification_revision: 1,
  is_classified: 1,
  "classification_meta.provenance_kind": 1,
  "classification_meta.source_revision": 1,
  "classification_meta.analysis_revision_id": 1,
  "classification_state.contractVersion": 1,
  "classification_state.status": 1,
  "classification_state.requestedRevision": 1,
  "classification_state.processingRevision": 1,
  "classification_state.appliedRevision": 1,
  "classification_state.generation": 1,
  "classification_state.fence": 1,
  "classification_state.requestedAt": 1,
  "classification_state.nextAttemptAt": 1,
  "classification_state.lease": 1,
} as const;

const CONVERSATION_CLASSIFICATION_WAKE_LEASE_FIELDS = [
  "ownerToken",
  "claimedAt",
  "expiresAt",
] as const;

type CompleteConversationClassificationWakeLease = {
  ownerToken: string;
  claimedAt: Date;
  expiresAt: Date;
};

function wakeStateInvariant(message: string): never {
  throw new Error(`Conversation classification wake state invariant: ${message}`);
}

function hasCompleteConversationClassificationWakeLease(
  value: unknown
): value is CompleteConversationClassificationWakeLease {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, CONVERSATION_CLASSIFICATION_WAKE_LEASE_FIELDS) &&
    typeof value.ownerToken === "string" &&
    value.ownerToken.length > 0 &&
    value.ownerToken === value.ownerToken.trim() &&
    isValidDate(value.claimedAt) &&
    isValidDate(value.expiresAt) &&
    value.claimedAt.getTime() <= value.expiresAt.getTime()
  );
}

function normalizeConversationClassificationWakeState(
  value: unknown
): ConversationClassificationWakeState {
  if (!isPlainRecord(value)) wakeStateInvariant("conversation row is invalid");
  const id = value._id;
  if (
    (!(id instanceof mongoose.Types.ObjectId) &&
      (typeof id !== "string" || !mongoose.Types.ObjectId.isValid(id))) ||
    typeof value.workspaceId !== "string" ||
    value.workspaceId.length === 0 ||
    value.workspaceId !== value.workspaceId.trim() ||
    !Number.isSafeInteger(value.classification_revision) ||
    (value.classification_revision as number) < 1 ||
    typeof value.is_classified !== "boolean"
  ) {
    wakeStateInvariant("conversation identity is invalid");
  }

  const classificationRevision = value.classification_revision as number;
  const state = value.classification_state;
  if (!isPlainRecord(state)) wakeStateInvariant("state is missing");
  const status = state.status;
  if (
    state.contractVersion !==
      CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION ||
    typeof status !== "string" ||
    !(CONVERSATION_CLASSIFICATION_STATUSES as readonly string[]).includes(
      status
    ) ||
    state.requestedRevision !== classificationRevision ||
    !isNonNegativeSafeInteger(state.generation) ||
    !isNonNegativeSafeInteger(state.fence) ||
    !isValidDate(state.requestedAt)
  ) {
    wakeStateInvariant("state identity is invalid");
  }

  const processingRevision = state.processingRevision;
  if (
    processingRevision !== null &&
    (!Number.isSafeInteger(processingRevision) ||
      (processingRevision as number) < 1 ||
      (processingRevision as number) > classificationRevision)
  ) {
    wakeStateInvariant("processing revision is invalid");
  }
  const appliedRevision = state.appliedRevision;
  if (
    appliedRevision !== null &&
    (!Number.isSafeInteger(appliedRevision) ||
      (appliedRevision as number) < 1 ||
      (appliedRevision as number) > classificationRevision)
  ) {
    wakeStateInvariant("applied revision is invalid");
  }
  if (state.nextAttemptAt !== null && !isValidDate(state.nextAttemptAt)) {
    wakeStateInvariant("next attempt time is invalid");
  }

  let classificationMeta: ConversationClassificationWakeState["classificationMeta"] =
    null;
  let provenanceKind: "v2" | "legacy_unknown" | null = null;
  const rawMeta = value.classification_meta;
  if (rawMeta !== null && rawMeta !== undefined) {
    if (!isPlainRecord(rawMeta)) {
      wakeStateInvariant("classification metadata is invalid");
    }
    const sourceRevision = rawMeta.source_revision ?? null;
    const analysisRevisionId = rawMeta.analysis_revision_id ?? null;
    const rawProvenanceKind = rawMeta.provenance_kind ?? null;
    if (
      (sourceRevision !== null &&
        (!Number.isSafeInteger(sourceRevision) ||
          (sourceRevision as number) < 1 ||
          (sourceRevision as number) > classificationRevision)) ||
      (analysisRevisionId !== null &&
        (typeof analysisRevisionId !== "string" ||
          analysisRevisionId.length === 0 ||
          analysisRevisionId !== analysisRevisionId.trim())) ||
      (rawProvenanceKind !== null &&
        rawProvenanceKind !== "v2" &&
        rawProvenanceKind !== "legacy_unknown") ||
      (sourceRevision === null) !== (analysisRevisionId === null) ||
      (rawProvenanceKind === "v2" && sourceRevision === null)
    ) {
      wakeStateInvariant("classification metadata is partial");
    }
    provenanceKind = rawProvenanceKind;
    classificationMeta = {
      sourceRevision: sourceRevision as number | null,
      analysisRevisionId: analysisRevisionId as string | null,
    };
  }

  let lease: CompleteConversationClassificationWakeLease | null = null;
  if (status === "processing") {
    if (
      processingRevision === null ||
      state.fence < 1 ||
      !hasCompleteConversationClassificationWakeLease(state.lease) ||
      value.is_classified !== false
    ) {
      wakeStateInvariant("processing ownership is invalid");
    }
    if (processingRevision === classificationRevision) {
      if (state.nextAttemptAt !== null) {
        wakeStateInvariant("current processing retry time is invalid");
      }
    } else if (
      !isValidDate(state.nextAttemptAt) ||
      state.nextAttemptAt.getTime() !== state.requestedAt.getTime()
    ) {
      wakeStateInvariant("superseded processing retry time is invalid");
    }
    lease = state.lease;
  } else {
    if (processingRevision !== null || state.lease !== null) {
      wakeStateInvariant("non-processing ownership is invalid");
    }
    if (status === "pending" || status === "blocked") {
      if (!isValidDate(state.nextAttemptAt) || value.is_classified !== false) {
        wakeStateInvariant("scheduled state is invalid");
      }
    } else if (state.nextAttemptAt !== null) {
      wakeStateInvariant("terminal retry time is invalid");
    }

    if (status === "ready") {
      if (
        value.is_classified !== true ||
        appliedRevision !== classificationRevision ||
        provenanceKind !== "v2" ||
        classificationMeta?.sourceRevision !== classificationRevision ||
        !classificationMeta.analysisRevisionId
      ) {
        wakeStateInvariant("current-ready projection is invalid");
      }
    } else if (value.is_classified !== false) {
      wakeStateInvariant("non-ready classification flag is invalid");
    }
  }

  return {
    conversationId: String(id),
    workspaceId: value.workspaceId,
    classificationRevision,
    isClassified: value.is_classified,
    classificationMeta,
    state: {
      contractVersion: CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION,
      status: status as ConversationClassificationStatus,
      requestedRevision: classificationRevision,
      processingRevision: processingRevision as number | null,
      appliedRevision: appliedRevision as number | null,
      generation: state.generation,
      fence: state.fence,
      requestedAt: state.requestedAt,
      nextAttemptAt: state.nextAttemptAt as Date | null,
      lease,
    },
  };
}

export async function readConversationClassificationWakeState(
  conversationId: mongoose.Types.ObjectId | string,
  overrides: Partial<ConversationClassificationStoreDependencies> = {}
): Promise<ConversationClassificationWakeState | null> {
  const deps = dependencies(overrides);
  const row = await deps.conversationModel
    .findById(
      toObjectId(conversationId),
      CONVERSATION_CLASSIFICATION_WAKE_PROJECTION
    )
    .read("primary")
    .lean()
    .exec();
  return row === null ? null : normalizeConversationClassificationWakeState(row);
}

export type ExpiredSupersededClassificationLeaseObservation = {
  conversationId: mongoose.Types.ObjectId | string;
  requestedRevision: number;
  generation: number;
  processingRevision: number;
  ownerToken: string;
  fence: number;
  expiresAt: Date;
};

function assertExpiredSupersededClassificationLeaseObservation(
  observed: ExpiredSupersededClassificationLeaseObservation,
  recoveredAt: Date
): void {
  if (
    !Number.isSafeInteger(observed.requestedRevision) ||
    observed.requestedRevision < 1 ||
    !isNonNegativeSafeInteger(observed.generation) ||
    !Number.isSafeInteger(observed.processingRevision) ||
    observed.processingRevision < 1 ||
    observed.processingRevision > observed.requestedRevision ||
    typeof observed.ownerToken !== "string" ||
    observed.ownerToken.length === 0 ||
    observed.ownerToken !== observed.ownerToken.trim() ||
    !Number.isSafeInteger(observed.fence) ||
    observed.fence < 1 ||
    !isValidDate(observed.expiresAt) ||
    !isValidDate(recoveredAt)
  ) {
    throw new Error(
      "Expired superseded classification lease observation is invalid"
    );
  }
}

export async function recoverExpiredSupersededConversationClassificationLease(
  input: {
    observed: ExpiredSupersededClassificationLeaseObservation;
    recoveredAt?: Date;
  },
  overrides: Partial<ConversationClassificationStoreDependencies> = {}
): Promise<"recovered" | "not_superseded" | "not_expired" | "changed"> {
  const deps = dependencies(overrides);
  const recoveredAt = input.recoveredAt ?? deps.now();
  const observed = input.observed;
  assertExpiredSupersededClassificationLeaseObservation(
    observed,
    recoveredAt
  );
  const conversationId = toObjectId(observed.conversationId);
  if (observed.processingRevision === observed.requestedRevision) {
    return "not_superseded";
  }
  if (observed.expiresAt.getTime() > recoveredAt.getTime()) {
    return "not_expired";
  }

  const result = await deps.conversationModel.updateOne(
    {
      _id: conversationId,
      classification_revision: observed.requestedRevision,
      "classification_state.contractVersion":
        CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION,
      "classification_state.status": "processing",
      "classification_state.requestedRevision": observed.requestedRevision,
      "classification_state.processingRevision": observed.processingRevision,
      "classification_state.generation": observed.generation,
      "classification_state.fence": observed.fence,
      "classification_state.lease.ownerToken": observed.ownerToken,
      "classification_state.lease.expiresAt": {
        $eq: observed.expiresAt,
        $lte: recoveredAt,
      },
    },
    {
      $set: {
        "classification_state.status": "pending",
        "classification_state.processingRevision": null,
        "classification_state.nextAttemptAt": recoveredAt,
        "classification_state.lease": null,
        is_classified: false,
        is_qa_analyzed: false,
      },
    },
    { timestamps: false }
  );
  return matchedCount(result) === 1 ? "recovered" : "changed";
}

function toObjectId(
  value: mongoose.Types.ObjectId | string
): mongoose.Types.ObjectId {
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new Error("conversationId must be a valid ObjectId");
  }
  return new mongoose.Types.ObjectId(value);
}

function addMilliseconds(value: Date, milliseconds: number): Date {
  return new Date(value.getTime() + milliseconds);
}

function safeText(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

function matchedCount(result: unknown): number {
  if (!result || typeof result !== "object") return 0;
  const candidate = result as {
    matchedCount?: number;
    n?: number;
  };
  return candidate.matchedCount ?? candidate.n ?? 0;
}

export function buildConversationClassificationLeaseFilter(
  input: ConversationClassificationLeaseIdentity & { now: Date }
): Record<string, unknown> {
  return {
    _id: input.conversationId,
    classification_revision: input.revision,
    "classification_state.contractVersion":
      CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION,
    "classification_state.requestedRevision": input.revision,
    "classification_state.processingRevision": input.revision,
    "classification_state.status": "processing",
    "classification_state.lease.ownerToken": input.ownerToken,
    "classification_state.fence": input.fence,
    "classification_state.lease.expiresAt": {
      $eq: input.expiresAt,
      $gt: input.now,
    },
  };
}

export function buildStaleConversationClassificationLeaseFilter(
  input: ConversationClassificationLeaseIdentity & { now: Date }
): Record<string, unknown> {
  return {
    _id: input.conversationId,
    "classification_state.contractVersion":
      CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION,
    "classification_state.processingRevision": input.revision,
    "classification_state.status": "processing",
    "classification_state.lease.ownerToken": input.ownerToken,
    "classification_state.fence": input.fence,
    "classification_state.lease.expiresAt": {
      $eq: input.expiresAt,
      $gt: input.now,
    },
  };
}

export function buildDueConversationClassificationsFilter(
  now: Date
): Record<string, unknown> {
  return {
    "classification_state.contractVersion":
      CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION,
    "classification_state.status": { $in: ["pending", "blocked"] },
    "classification_state.nextAttemptAt": { $lte: now },
    $expr: {
      $eq: [
        "$classification_state.requestedRevision",
        "$classification_revision",
      ],
    },
  };
}

export function buildExpiredConversationClassificationsFilter(
  now: Date
): Record<string, unknown> {
  return {
    "classification_state.contractVersion":
      CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION,
    "classification_state.status": "processing",
    "classification_state.lease.expiresAt": { $lte: now },
    $expr: {
      $eq: [
        "$classification_state.requestedRevision",
        "$classification_revision",
      ],
    },
  };
}

export function buildDueConversationAnalysisEffectsFilter(
  now: Date
): Record<string, unknown> {
  return {
    "effects.status": { $in: ["pending", "failed"] },
    "effects.nextAttemptAt": { $lte: now },
  };
}

export function buildExpiredConversationAnalysisEffectsFilter(
  now: Date
): Record<string, unknown> {
  return {
    "effects.status": "processing",
    "effects.lease.expiresAt": { $lte: now },
  };
}

export function getConversationClassificationFailureDecision(input: {
  attemptCount: number;
  retryable: boolean;
  now: Date;
}): { status: "pending" | "failed"; nextAttemptAt: Date | null } {
  if (!input.retryable || input.attemptCount >= CLASSIFICATION_MAX_ATTEMPTS) {
    return { status: "failed", nextAttemptAt: null };
  }
  const delay = CLASSIFICATION_RETRY_DELAYS_MS[input.attemptCount - 1];
  if (delay === undefined) {
    return { status: "failed", nextAttemptAt: null };
  }
  return {
    status: "pending",
    nextAttemptAt: addMilliseconds(input.now, delay),
  };
}

export function getConversationAnalysisEffectsRetryAt(input: {
  attemptCount: number;
  now: Date;
}): Date {
  const index = Math.max(0, input.attemptCount - 1);
  const delay =
    EFFECT_RETRY_DELAYS_MS[Math.min(index, EFFECT_RETRY_DELAYS_MS.length - 1)];
  return addMilliseconds(input.now, delay);
}

type LeanClaimedConversation = {
  _id: mongoose.Types.ObjectId;
  workspaceId: string;
  classification_state: {
    processingRevision: number;
    generation: number;
    attemptCount: number;
    fence: number;
    requestedAt: Date;
    lease: { ownerToken: string; expiresAt: Date };
  };
};

function safeIntegerExpression(path: string, minimum: number) {
  return {
    $and: [
      { $isNumber: path },
      { $gte: [path, minimum] },
      { $lte: [path, Number.MAX_SAFE_INTEGER] },
      { $eq: [{ $trunc: path }, path] },
    ],
  };
}

function nullablePositiveSafeIntegerExpression(path: string) {
  return {
    $or: [{ $eq: [{ $type: path }, "null"] }, safeIntegerExpression(path, 1)],
  };
}

export function buildConversationClassificationClaimFilter(input: {
  conversationId: mongoose.Types.ObjectId | string;
  now: Date;
}): Record<string, unknown> {
  return {
    _id: toObjectId(input.conversationId),
    "classification_state.contractVersion":
      CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION,
    "classification_state.requestedAt": { $type: "date" },
    $expr: {
      $and: [
        safeIntegerExpression("$classification_revision", 1),
        safeIntegerExpression("$classification_state.requestedRevision", 1),
        {
          $eq: [
            "$classification_state.requestedRevision",
            "$classification_revision",
          ],
        },
        safeIntegerExpression("$classification_state.attemptRevision", 0),
        safeIntegerExpression("$classification_state.attemptCount", 0),
        safeIntegerExpression("$classification_state.generation", 0),
        safeIntegerExpression("$classification_state.fence", 0),
        {
          $lte: [
            "$classification_state.attemptRevision",
            "$classification_revision",
          ],
        },
        nullablePositiveSafeIntegerExpression(
          "$classification_state.appliedRevision"
        ),
        {
          $or: [
            {
              $eq: [{ $type: "$classification_state.appliedRevision" }, "null"],
            },
            {
              $lte: [
                "$classification_state.appliedRevision",
                "$classification_revision",
              ],
            },
          ],
        },
      ],
    },
    $or: [
      {
        "classification_state.status": { $in: ["pending", "blocked"] },
        "classification_state.processingRevision": { $type: "null" },
        "classification_state.nextAttemptAt": {
          $type: "date",
          $lte: input.now,
        },
        "classification_state.lease": { $type: "null" },
      },
      {
        "classification_state.status": "processing",
        "classification_state.lease.ownerToken": {
          $type: "string",
          $ne: "",
        },
        "classification_state.lease.claimedAt": { $type: "date" },
        "classification_state.lease.expiresAt": {
          $type: "date",
          $lte: input.now,
        },
        $expr: {
          $and: [
            safeIntegerExpression(
              "$classification_state.processingRevision",
              1
            ),
            {
              $eq: [
                "$classification_state.processingRevision",
                "$classification_state.requestedRevision",
              ],
            },
            {
              $eq: [
                "$classification_state.processingRevision",
                "$classification_revision",
              ],
            },
            safeIntegerExpression("$classification_state.fence", 1),
          ],
        },
      },
    ],
  };
}

export function buildConversationClassificationClaimPipeline(input: {
  now: Date;
  ownerToken: string;
  expiresAt: Date;
}): mongoose.PipelineStage[] {
  return [
    {
      $set: {
        "classification_state.status": "processing",
        "classification_state.processingRevision": "$classification_revision",
        "classification_state.attemptRevision": "$classification_revision",
        "classification_state.attemptCount": {
          $cond: [
            {
              $eq: [
                "$classification_state.attemptRevision",
                "$classification_revision",
              ],
            },
            { $add: ["$classification_state.attemptCount", 1] },
            1,
          ],
        },
        "classification_state.fence": {
          $add: ["$classification_state.fence", 1],
        },
        "classification_state.nextAttemptAt": null,
        "classification_state.lease": {
          ownerToken: input.ownerToken,
          claimedAt: input.now,
          expiresAt: input.expiresAt,
        },
        "classification_state.error": null,
        "classification_state.blocked": null,
        is_classified: false,
        is_qa_analyzed: false,
      },
    },
  ];
}

export async function claimConversationClassification(
  input: { conversationId: mongoose.Types.ObjectId | string },
  overrides: Partial<ConversationClassificationStoreDependencies> = {}
): Promise<ClaimedConversationClassification | null> {
  const deps = dependencies(overrides);
  const now = deps.now();
  const ownerToken = deps.createOwnerToken();
  const expiresAt = addMilliseconds(now, CONVERSATION_CLASSIFICATION_LEASE_MS);
  const filter = buildConversationClassificationClaimFilter({
    conversationId: input.conversationId,
    now,
  });
  const pipeline = buildConversationClassificationClaimPipeline({
    now,
    ownerToken,
    expiresAt,
  });
  const claimed = (await deps.conversationModel
    .findOneAndUpdate(filter, pipeline, {
      new: true,
      timestamps: false,
      projection: {
        _id: 1,
        workspaceId: 1,
        classification_state: 1,
      },
    })
    .lean()
    .exec()) as LeanClaimedConversation | null;

  if (!claimed) return null;
  const state = claimed.classification_state;
  return {
    conversationId: claimed._id,
    workspaceId: claimed.workspaceId,
    revision: state.processingRevision,
    generation: state.generation,
    attemptCount: state.attemptCount,
    requestedAt: state.requestedAt,
    ownerToken: state.lease.ownerToken,
    fence: state.fence,
    expiresAt: state.lease.expiresAt,
  };
}

export async function renewConversationClassificationLease(
  lease: ConversationClassificationLeaseIdentity,
  overrides: Partial<ConversationClassificationStoreDependencies> = {}
): Promise<ConversationClassificationLeaseIdentity | null> {
  const deps = dependencies(overrides);
  const now = deps.now();
  const nextExpiresAt = new Date(
    Math.max(
      addMilliseconds(now, CONVERSATION_CLASSIFICATION_LEASE_MS).getTime(),
      lease.expiresAt.getTime() + 1
    )
  );
  const result = await deps.conversationModel.updateOne(
    buildConversationClassificationLeaseFilter({ ...lease, now }),
    { $set: { "classification_state.lease.expiresAt": nextExpiresAt } },
    { timestamps: false }
  );
  return matchedCount(result) === 1
    ? { ...lease, expiresAt: nextExpiresAt }
    : null;
}

export async function deferClaimedConversationClassification(
  input: {
    lease: ConversationClassificationLeaseIdentity;
    recheckAt: Date;
  },
  overrides: Partial<ConversationClassificationStoreDependencies> = {}
): Promise<boolean> {
  const deps = dependencies(overrides);
  const now = deps.now();
  const recheckTime =
    input.recheckAt instanceof Date ? input.recheckAt.getTime() : Number.NaN;
  if (
    !Number.isFinite(recheckTime) ||
    recheckTime <= now.getTime() ||
    recheckTime > now.getTime() + CONVERSATION_CLASSIFICATION_MEDIA_RECHECK_MS
  ) {
    throw new Error(
      "media recheckAt must be a valid future Date within twenty minutes"
    );
  }
  const result = await deps.conversationModel.updateOne(
    buildConversationClassificationLeaseFilter({ ...input.lease, now }),
    [
      {
        $set: {
          "classification_state.status": "blocked",
          "classification_state.processingRevision": null,
          "classification_state.nextAttemptAt": input.recheckAt,
          "classification_state.lease": null,
          "classification_state.error": null,
          "classification_state.review": null,
          "classification_state.blocked": {
            code: "media_pending",
            reason: "Inbound media analysis is still pending",
            recheckAt: input.recheckAt,
          },
          "classification_state.attemptCount": {
            $max: [0, { $subtract: ["$classification_state.attemptCount", 1] }],
          },
          is_classified: false,
          is_qa_analyzed: false,
        },
      },
    ],
    { timestamps: false }
  );
  return matchedCount(result) === 1;
}

function assertReadyProjection(projection: Record<string, unknown>): void {
  if (
    !projection.classification ||
    typeof projection.classification !== "object" ||
    Array.isArray(projection.classification)
  ) {
    throw new Error("Ready classification projection is required");
  }
  for (const path of Object.keys(projection)) {
    if (!READY_PROJECTION_PATHS.has(path)) {
      throw new Error(`Ready projection path ${path} is not allowed`);
    }
  }
}

function initialEffects(input: {
  outcome: "ready" | "review_required";
  completedAt: Date;
}): IConversationAnalysisRevision["effects"] {
  return {
    status: input.outcome === "ready" ? "pending" : "not_applicable",
    attemptCount: 0,
    fence: 0,
    nextAttemptAt: input.outcome === "ready" ? input.completedAt : null,
    completedAt: input.outcome === "review_required" ? input.completedAt : null,
    lease: null,
    checklist: Object.fromEntries(
      CONVERSATION_ANALYSIS_EFFECT_STEPS.map(step => [step, null])
    ) as Record<ConversationAnalysisEffectStep, null>,
  };
}

function comparable(value: unknown): unknown {
  if (value instanceof mongoose.Types.ObjectId) {
    return { $objectId: value.toHexString() };
  }
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Buffer.isBuffer(value)) return { $binary: value.toString("base64") };
  if (Array.isArray(value)) return value.map(comparable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, comparable(entry)])
    );
  }
  return value;
}

function immutableRevisionMatches(
  row: IConversationAnalysisRevision,
  candidate: Omit<IConversationAnalysisRevision, "createdAt" | "updatedAt">
): boolean {
  const actual = {
    _id: row._id,
    conversationId: row.conversationId,
    workspaceId: row.workspaceId,
    sourceRevision: row.sourceRevision,
    completedAt: row.completedAt,
    outcome: row.outcome,
    projection: row.projection,
    review: row.review,
    effectInputs: row.effectInputs,
    provenance: row.provenance,
  };
  const expected = {
    _id: candidate._id,
    conversationId: candidate.conversationId,
    workspaceId: candidate.workspaceId,
    sourceRevision: candidate.sourceRevision,
    completedAt: candidate.completedAt,
    outcome: candidate.outcome,
    projection: candidate.projection,
    review: candidate.review,
    effectInputs: candidate.effectInputs,
    provenance: candidate.provenance,
  };
  return (
    JSON.stringify(comparable(actual)) === JSON.stringify(comparable(expected))
  );
}

async function insertOrVerifyAnalysisRevision(
  candidate: Omit<IConversationAnalysisRevision, "createdAt" | "updatedAt">,
  session: ClientSession,
  deps: ConversationClassificationStoreDependencies
): Promise<void> {
  await new deps.analysisRevisionModel(candidate).validate();
  const row = (await deps.analysisRevisionModel
    .findOneAndUpdate(
      { _id: candidate._id },
      { $setOnInsert: candidate },
      {
        upsert: true,
        new: true,
        session,
        timestamps: false,
        setDefaultsOnInsert: false,
      }
    )
    .lean()
    .exec()) as IConversationAnalysisRevision | null;
  if (!row || !immutableRevisionMatches(row, candidate)) {
    throw new ConversationAnalysisRevisionConflictError(
      `Analysis revision ${candidate._id} conflicts with immutable data`
    );
  }
}

async function withTransaction<T>(
  deps: ConversationClassificationStoreDependencies,
  operation: (session: ClientSession) => Promise<T>
): Promise<T> {
  const session = await deps.conversationModel.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(async () => {
      result = await operation(session);
    });
    return result as T;
  } finally {
    await session.endSession();
  }
}

function analysisRevisionId(
  lease: ConversationClassificationLeaseIdentity
): string {
  return buildConversationAnalysisRevisionId({
    conversationId: String(lease.conversationId),
    sourceRevision: lease.revision,
  });
}

export async function commitConversationClassificationReady(
  input: {
    lease: ConversationClassificationLeaseIdentity;
    workspaceId: string;
    projection: Record<string, unknown>;
    provenance: ConversationClassificationProvenance;
    effectInputs: ConversationClassificationEffectInputs;
  },
  overrides: Partial<ConversationClassificationStoreDependencies> = {}
): Promise<{ analysisRevisionId: string; completedAt: Date }> {
  assertReadyProjection(input.projection);
  assertConversationClassificationEffectInputs(input.effectInputs);
  const deps = dependencies(overrides);
  const completedAt = deps.now();
  const id = analysisRevisionId(input.lease);
  const conversationId = toObjectId(input.lease.conversationId);
  const candidate: Omit<
    IConversationAnalysisRevision,
    "createdAt" | "updatedAt"
  > = {
    _id: id,
    conversationId,
    workspaceId: input.workspaceId,
    sourceRevision: input.lease.revision,
    completedAt,
    outcome: "ready",
    projection: input.projection,
    review: null,
    effectInputs: input.effectInputs,
    provenance: input.provenance,
    effects: initialEffects({ outcome: "ready", completedAt }),
  };

  await withTransaction(deps, async session => {
    const projectionSet = Object.fromEntries(
      Object.entries(input.projection).map(([key, value]) => [key, value])
    );
    const result = await deps.conversationModel.updateOne(
      {
        ...buildConversationClassificationLeaseFilter({
          ...input.lease,
          conversationId,
          now: completedAt,
        }),
        workspaceId: input.workspaceId,
      },
      {
        $set: {
          ...projectionSet,
          classification_meta: {
            provenance_kind: CONVERSATION_CLASSIFICATION_PROVENANCE_KINDS[0],
            taxonomy_id: input.provenance.taxonomyId,
            taxonomy_digest: input.provenance.taxonomyDigest,
            classifier_version: input.provenance.classifierVersion,
            classifier_contract_revision:
              input.provenance.classifierContractRevision,
            source_revision: input.lease.revision,
            analysis_revision_id: id,
            completed_at: completedAt,
          },
          "classification_state.status": "ready",
          "classification_state.appliedRevision": input.lease.revision,
          "classification_state.processingRevision": null,
          "classification_state.completedAt": completedAt,
          "classification_state.nextAttemptAt": null,
          "classification_state.lease": null,
          "classification_state.error": null,
          "classification_state.review": null,
          "classification_state.blocked": null,
          classification_error: null,
          is_classified: true,
          is_qa_analyzed:
            input.projection.agent_performance_scorecard !== undefined &&
            input.projection.agent_performance_scorecard !== null,
        },
      },
      { session, timestamps: false }
    );
    if (matchedCount(result) !== 1) {
      throw new ConversationClassificationCasError(
        "Ready classification lease is stale"
      );
    }
    await insertOrVerifyAnalysisRevision(candidate, session, deps);
  });

  return { analysisRevisionId: id, completedAt };
}

export async function commitConversationClassificationReviewRequired(
  input: {
    lease: ConversationClassificationLeaseIdentity;
    workspaceId: string;
    review: { code: string; reason: string };
    provenance: ConversationClassificationProvenance;
  },
  overrides: Partial<ConversationClassificationStoreDependencies> = {}
): Promise<{ analysisRevisionId: string; completedAt: Date }> {
  const deps = dependencies(overrides);
  const completedAt = deps.now();
  const id = analysisRevisionId(input.lease);
  const conversationId = toObjectId(input.lease.conversationId);
  const review = {
    code: safeText(input.review.code, MAX_SAFE_ERROR_CODE_LENGTH),
    reason: safeText(input.review.reason, MAX_SAFE_ERROR_MESSAGE_LENGTH),
  };
  if (!review.code || !review.reason) {
    throw new Error("Review code and reason are required");
  }
  const candidate: Omit<
    IConversationAnalysisRevision,
    "createdAt" | "updatedAt"
  > = {
    _id: id,
    conversationId,
    workspaceId: input.workspaceId,
    sourceRevision: input.lease.revision,
    completedAt,
    outcome: "review_required",
    projection: null,
    review,
    effectInputs: null,
    provenance: input.provenance,
    effects: initialEffects({ outcome: "review_required", completedAt }),
  };

  await withTransaction(deps, async session => {
    const result = await deps.conversationModel.updateOne(
      {
        ...buildConversationClassificationLeaseFilter({
          ...input.lease,
          conversationId,
          now: completedAt,
        }),
        workspaceId: input.workspaceId,
      },
      {
        $set: {
          "classification_state.status": "review_required",
          "classification_state.processingRevision": null,
          "classification_state.completedAt": completedAt,
          "classification_state.nextAttemptAt": null,
          "classification_state.lease": null,
          "classification_state.error": null,
          "classification_state.review": {
            code: review.code,
            reason: review.reason,
            at: completedAt,
          },
          "classification_state.blocked": null,
          classification_error: null,
          is_classified: false,
          is_qa_analyzed: false,
        },
      },
      { session, timestamps: false }
    );
    if (matchedCount(result) !== 1) {
      throw new ConversationClassificationCasError(
        "Review classification lease is stale"
      );
    }
    await insertOrVerifyAnalysisRevision(candidate, session, deps);
  });

  return { analysisRevisionId: id, completedAt };
}

export async function recordConversationClassificationFailure(
  input: {
    lease: ConversationClassificationLeaseIdentity;
    code: string;
    message: string;
    retryable: boolean;
  },
  overrides: Partial<ConversationClassificationStoreDependencies> = {}
): Promise<{
  status: "pending" | "failed";
  nextAttemptAt: Date | null;
} | null> {
  const deps = dependencies(overrides);
  const now = deps.now();
  const conversation = (await deps.conversationModel
    .findOne(
      buildConversationClassificationLeaseFilter({ ...input.lease, now })
    )
    .select({ "classification_state.attemptCount": 1 })
    .lean()
    .exec()) as { classification_state?: { attemptCount?: number } } | null;
  if (!conversation) return null;
  const attemptCount = conversation.classification_state?.attemptCount ?? 0;
  const decision = getConversationClassificationFailureDecision({
    attemptCount,
    retryable: input.retryable,
    now,
  });
  const code = safeText(input.code, MAX_SAFE_ERROR_CODE_LENGTH);
  const message = safeText(input.message, MAX_SAFE_ERROR_MESSAGE_LENGTH);
  const result = await deps.conversationModel.updateOne(
    buildConversationClassificationLeaseFilter({ ...input.lease, now }),
    {
      $set: {
        "classification_state.status": decision.status,
        "classification_state.processingRevision": null,
        "classification_state.nextAttemptAt": decision.nextAttemptAt,
        "classification_state.lease": null,
        "classification_state.error": {
          code,
          message,
          retryable: input.retryable && decision.status === "pending",
          at: now,
        },
        classification_error: message,
        is_classified: false,
        is_qa_analyzed: false,
      },
    },
    { timestamps: false }
  );
  return matchedCount(result) === 1 ? decision : null;
}

export async function releaseStaleConversationClassificationLease(
  input: { lease: ConversationClassificationLeaseIdentity },
  overrides: Partial<ConversationClassificationStoreDependencies> = {}
): Promise<boolean> {
  const deps = dependencies(overrides);
  const now = deps.now();
  const result = await deps.conversationModel.updateOne(
    buildStaleConversationClassificationLeaseFilter({ ...input.lease, now }),
    {
      $set: {
        "classification_state.status": "pending",
        "classification_state.processingRevision": null,
        "classification_state.nextAttemptAt": now,
        "classification_state.lease": null,
        is_classified: false,
        is_qa_analyzed: false,
      },
    },
    { timestamps: false }
  );
  return matchedCount(result) === 1;
}

export type ConversationClassificationBlockObservation =
  | {
      kind: "due";
      conversationId: mongoose.Types.ObjectId | string;
      revision: number;
    }
  | {
      kind: "expired_processing";
      lease: ConversationClassificationLeaseIdentity;
    };

export async function markConversationClassificationBlocked(
  input: {
    observation: ConversationClassificationBlockObservation;
    code: string;
    reason: string;
    recheckAt: Date;
  },
  overrides: Partial<ConversationClassificationStoreDependencies> = {}
): Promise<boolean> {
  const deps = dependencies(overrides);
  const now = deps.now();
  if (
    !(input.recheckAt instanceof Date) ||
    !Number.isFinite(input.recheckAt.getTime()) ||
    input.recheckAt.getTime() <= now.getTime()
  ) {
    throw new Error(
      "classification block recheckAt must be a valid future Date"
    );
  }
  let filter: Record<string, unknown>;
  if (input.observation.kind === "due") {
    if (
      !Number.isSafeInteger(input.observation.revision) ||
      input.observation.revision < 1
    ) {
      throw new Error(
        "classification block revision must be a positive safe integer"
      );
    }
    filter = {
      _id: toObjectId(input.observation.conversationId),
      classification_revision: input.observation.revision,
      "classification_state.contractVersion":
        CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION,
      "classification_state.requestedRevision": input.observation.revision,
      "classification_state.status": { $in: ["pending", "blocked"] },
      "classification_state.processingRevision": null,
      "classification_state.nextAttemptAt": { $type: "date", $lte: now },
      "classification_state.lease": null,
    };
  } else {
    const lease = input.observation.lease;
    if (
      !(lease.expiresAt instanceof Date) ||
      !Number.isFinite(lease.expiresAt.getTime())
    ) {
      throw new Error("classification block expiresAt must be a valid Date");
    }
    if (
      !Number.isSafeInteger(lease.revision) ||
      lease.revision < 1 ||
      typeof lease.ownerToken !== "string" ||
      !lease.ownerToken.trim() ||
      !Number.isSafeInteger(lease.fence) ||
      lease.fence < 1
    ) {
      throw new Error("classification block expired observation is invalid");
    }
    if (lease.expiresAt.getTime() > now.getTime()) return false;
    filter = {
      _id: toObjectId(lease.conversationId),
      classification_revision: lease.revision,
      "classification_state.contractVersion":
        CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION,
      "classification_state.requestedRevision": lease.revision,
      "classification_state.processingRevision": lease.revision,
      "classification_state.status": "processing",
      "classification_state.lease.ownerToken": lease.ownerToken,
      "classification_state.fence": lease.fence,
      "classification_state.lease.expiresAt": {
        $eq: lease.expiresAt,
        $lte: now,
      },
    };
  }
  const result = await deps.conversationModel.updateOne(
    filter,
    {
      $set: {
        "classification_state.status": "blocked",
        "classification_state.processingRevision": null,
        "classification_state.nextAttemptAt": input.recheckAt,
        "classification_state.lease": null,
        "classification_state.error": null,
        "classification_state.review": null,
        "classification_state.blocked": {
          code: safeText(input.code, MAX_SAFE_ERROR_CODE_LENGTH),
          reason: safeText(input.reason, MAX_SAFE_ERROR_MESSAGE_LENGTH),
          recheckAt: input.recheckAt,
        },
        is_classified: false,
        is_qa_analyzed: false,
      },
    },
    { timestamps: false }
  );
  return matchedCount(result) === 1;
}

export type ConversationClassificationWakeMarker =
  | { kind: "classification" }
  | { kind: "effects"; analysisRevisionId: string };

export async function markConversationClassificationEnqueued(
  input: {
    conversationId: mongoose.Types.ObjectId | string;
    revision: number;
    generation: number;
    marker: ConversationClassificationWakeMarker;
    enqueuedAt?: Date;
  },
  overrides: Partial<ConversationClassificationStoreDependencies> = {}
): Promise<boolean> {
  const deps = dependencies(overrides);
  const enqueuedAt = input.enqueuedAt ?? deps.now();
  if (
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1 ||
    !isNonNegativeSafeInteger(input.generation) ||
    !isValidDate(enqueuedAt) ||
    !isPlainRecord(input.marker) ||
    (input.marker.kind !== "classification" &&
      input.marker.kind !== "effects")
  ) {
    throw new Error("Conversation classification enqueue marker is invalid");
  }
  const commonFilter = {
    _id: toObjectId(input.conversationId),
    classification_revision: input.revision,
    "classification_state.contractVersion":
      CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION,
    "classification_state.requestedRevision": input.revision,
    "classification_state.generation": input.generation,
  };
  let filter: Record<string, unknown>;
  if (input.marker.kind === "classification") {
    filter = {
      ...commonFilter,
      "classification_state.status": {
        $in: ["pending", "blocked", "processing"],
      },
    };
  } else {
    if (
      typeof input.marker.analysisRevisionId !== "string" ||
      input.marker.analysisRevisionId.length === 0 ||
      input.marker.analysisRevisionId !==
        input.marker.analysisRevisionId.trim()
    ) {
      throw new Error("Conversation analysis revision marker is invalid");
    }
    filter = {
      ...buildCurrentConversationClassificationFilter(),
      ...commonFilter,
      is_classified: true,
      "classification_state.status": "ready",
      "classification_state.appliedRevision": input.revision,
      "classification_meta.source_revision": input.revision,
      "classification_meta.provenance_kind":
        CONVERSATION_CLASSIFICATION_PROVENANCE_KINDS[0],
      "classification_meta.analysis_revision_id":
        input.marker.analysisRevisionId,
    };
  }
  const result = await deps.conversationModel.updateOne(
    filter,
    { $set: { "classification_state.lastEnqueuedAt": enqueuedAt } },
    { timestamps: false }
  );
  return matchedCount(result) === 1;
}

function analysisCurrentConversationFilter(row: {
  _id: string;
  conversationId: mongoose.Types.ObjectId;
  sourceRevision: number;
  completedAt: Date;
}): Record<string, unknown> {
  return {
    ...buildCurrentConversationClassificationFilter(),
    _id: row.conversationId,
    classification_revision: row.sourceRevision,
    "classification_state.completedAt": row.completedAt,
    "classification_meta.analysis_revision_id": row._id,
  };
}

async function currentConversationWriteBarrier(
  row: {
    _id: string;
    conversationId: mongoose.Types.ObjectId;
    sourceRevision: number;
    completedAt: Date;
  },
  session: ClientSession,
  deps: ConversationClassificationStoreDependencies
): Promise<boolean> {
  const result = await deps.conversationModel.updateOne(
    analysisCurrentConversationFilter(row),
    { $set: { "classification_state.completedAt": row.completedAt } },
    { session, timestamps: false }
  );
  return matchedCount(result) === 1;
}

function effectLeaseFilter(
  lease: ConversationAnalysisEffectsLeaseIdentity,
  now: Date
): Record<string, unknown> {
  return {
    _id: lease.analysisRevisionId,
    "effects.status": "processing",
    "effects.lease.ownerToken": lease.ownerToken,
    "effects.fence": lease.fence,
    "effects.lease.expiresAt": { $eq: lease.expiresAt, $gt: now },
  };
}

type LeanAnalysisEffectsObservation = Pick<
  IConversationAnalysisRevision,
  | "_id"
  | "conversationId"
  | "sourceRevision"
  | "completedAt"
  | "outcome"
  | "effects"
>;

type LeanClaimedAnalysisRevision = LeanAnalysisEffectsObservation &
  Pick<
    IConversationAnalysisRevision,
    "workspaceId" | "projection" | "effectInputs"
  >;

export type ConversationAnalysisEffectsSnapshot = Readonly<{
  analysisRevisionId: string;
  conversationId: string;
  workspaceId: string;
  sourceRevision: number;
  completedAt: Date;
  outcome: "ready";
  projection: Readonly<Record<string, unknown>>;
  effectInputs: Readonly<ConversationClassificationEffectInputs>;
  checklist: Readonly<Record<ConversationAnalysisEffectStep, Date | null>>;
}>;

export type ClaimConversationAnalysisEffectsResult =
  | {
      status: "claimed";
      lease: ConversationAnalysisEffectsLeaseIdentity;
      analysis: ConversationAnalysisEffectsSnapshot;
    }
  | { status: "completed" }
  | { status: "retry_scheduled"; nextAttemptAt: Date }
  | { status: "superseded" }
  | { status: "lease_lost" };

const MAX_EFFECTS_CLAIM_CAS_ATTEMPTS = 8;
const OBSERVED_EFFECT_FIELDS = [
  "status",
  "attemptCount",
  "fence",
  "nextAttemptAt",
  "completedAt",
  "lease",
  "checklist",
] as const;
const OBSERVED_EFFECT_LEASE_FIELDS = [
  "ownerToken",
  "claimedAt",
  "expiresAt",
] as const;

type CompleteObservedEffectsLease = {
  ownerToken: string;
  claimedAt: Date;
  expiresAt: Date;
};

function effectsInvariant(message: string): never {
  throw new Error(`Conversation analysis effects invariant: ${message}`);
}

function hasCompleteEffectsLease(
  value: unknown
): value is CompleteObservedEffectsLease {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, OBSERVED_EFFECT_LEASE_FIELDS) &&
    typeof value.ownerToken === "string" &&
    value.ownerToken.trim().length > 0 &&
    value.ownerToken === value.ownerToken.trim() &&
    isValidDate(value.claimedAt) &&
    isValidDate(value.expiresAt) &&
    value.claimedAt.getTime() <= value.expiresAt.getTime()
  );
}

function assertObservedAnalysisEffectsState(
  row: LeanAnalysisEffectsObservation | null
): asserts row is LeanAnalysisEffectsObservation {
  if (!row) effectsInvariant("analysis revision is missing");
  if (typeof row._id !== "string" || row._id.trim().length === 0) {
    effectsInvariant("analysis revision ID is missing");
  }
  if (
    (!(row.conversationId instanceof mongoose.Types.ObjectId) &&
      (typeof row.conversationId !== "string" ||
        !mongoose.Types.ObjectId.isValid(row.conversationId))) ||
    !Number.isSafeInteger(row.sourceRevision) ||
    row.sourceRevision <= 0 ||
    !isValidDate(row.completedAt)
  ) {
    effectsInvariant("analysis identity is invalid");
  }
  if (row.outcome !== "ready" && row.outcome !== "review_required") {
    effectsInvariant("analysis outcome is invalid");
  }

  const effects = row.effects as unknown;
  if (
    !isPlainRecord(effects) ||
    !hasExactKeys(effects, OBSERVED_EFFECT_FIELDS) ||
    !isNonNegativeSafeInteger(effects.attemptCount) ||
    !isNonNegativeSafeInteger(effects.fence)
  ) {
    effectsInvariant("effect state shape is invalid");
  }
  const checklist = effects.checklist;
  if (
    !isPlainRecord(checklist) ||
    !hasExactKeys(checklist, CONVERSATION_ANALYSIS_EFFECT_STEPS) ||
    Object.values(checklist).some(
      value => value !== null && !isValidDate(value)
    )
  ) {
    effectsInvariant("effect checklist is invalid");
  }

  const allComplete = CONVERSATION_ANALYSIS_EFFECT_STEPS.every(step =>
    isValidDate(checklist[step])
  );
  const allIncomplete = CONVERSATION_ANALYSIS_EFFECT_STEPS.every(
    step => checklist[step] === null
  );
  const status = effects.status;
  if (
    status !== "pending" &&
    status !== "processing" &&
    status !== "completed" &&
    status !== "failed" &&
    status !== "superseded" &&
    status !== "not_applicable"
  ) {
    effectsInvariant("effect status is invalid");
  }
  const hasReconciliationTerminalFence =
    status === "superseded" &&
    effects.attemptCount >= 1 &&
    effects.fence === effects.attemptCount + 1;
  if (
    effects.attemptCount !== effects.fence &&
    !hasReconciliationTerminalFence
  ) {
    effectsInvariant("effect attempt and fence counters diverge");
  }

  if (row.outcome === "review_required") {
    if (
      status !== "not_applicable" ||
      effects.attemptCount !== 0 ||
      effects.nextAttemptAt !== null ||
      effects.lease !== null ||
      !isValidDate(effects.completedAt) ||
      effects.completedAt.getTime() !== row.completedAt.getTime() ||
      !allIncomplete
    ) {
      effectsInvariant("review-required effects state is impossible");
    }
    return;
  }

  if (status === "not_applicable") {
    effectsInvariant("ready effects cannot be not applicable");
  }
  if (status === "completed") {
    if (
      effects.attemptCount < 1 ||
      !allComplete ||
      effects.nextAttemptAt !== null ||
      effects.lease !== null ||
      !isValidDate(effects.completedAt)
    ) {
      effectsInvariant("completed effects state is invalid");
    }
    return;
  }
  if (status === "superseded") {
    if (
      (effects.attemptCount === 0 && !allIncomplete) ||
      effects.nextAttemptAt !== null ||
      effects.lease !== null ||
      !isValidDate(effects.completedAt)
    ) {
      effectsInvariant("superseded effects state is invalid");
    }
    return;
  }
  if (status === "pending" || status === "failed") {
    if (
      (status === "pending" &&
        (effects.attemptCount !== 0 || !allIncomplete)) ||
      (status === "failed" && effects.attemptCount < 1) ||
      !isValidDate(effects.nextAttemptAt) ||
      effects.completedAt !== null ||
      effects.lease !== null
    ) {
      effectsInvariant("scheduled effects state is invalid");
    }
    return;
  }
  if (
    effects.attemptCount < 1 ||
    effects.nextAttemptAt !== null ||
    effects.completedAt !== null ||
    !hasCompleteEffectsLease(effects.lease)
  ) {
    effectsInvariant("processing effects lease is invalid");
  }
}

function mapObservedAnalysisEffectsState(
  row: LeanAnalysisEffectsObservation,
  now: Date
):
  | { kind: "claim"; status: "pending" | "failed" | "processing" }
  | { kind: "return"; result: ClaimConversationAnalysisEffectsResult } {
  const status = row.effects.status;
  if (status === "completed" || status === "not_applicable") {
    return { kind: "return", result: { status: "completed" } };
  }
  if (status === "superseded") {
    return { kind: "return", result: { status: "superseded" } };
  }
  if (status === "pending" || status === "failed") {
    const nextAttemptAt = row.effects.nextAttemptAt as Date;
    if (nextAttemptAt.getTime() > now.getTime()) {
      return {
        kind: "return",
        result: { status: "retry_scheduled", nextAttemptAt },
      };
    }
    return { kind: "claim", status };
  }
  const lease = row.effects.lease as CompleteObservedEffectsLease;
  if (lease.expiresAt.getTime() > now.getTime()) {
    return { kind: "return", result: { status: "lease_lost" } };
  }
  return { kind: "claim", status: "processing" };
}

function buildObservedAnalysisEffectsClaimFilter(
  row: LeanAnalysisEffectsObservation,
  status: "pending" | "failed" | "processing",
  now: Date
): Record<string, unknown> {
  const common = {
    _id: row._id,
    "effects.status": status,
    "effects.attemptCount": row.effects.attemptCount,
    "effects.fence": row.effects.fence,
    "effects.nextAttemptAt": null,
    "effects.completedAt": null,
  };
  if (status !== "processing") {
    return {
      ...common,
      "effects.nextAttemptAt": {
        $eq: row.effects.nextAttemptAt,
        $lte: now,
      },
      "effects.lease": null,
    };
  }
  const lease = row.effects.lease as CompleteObservedEffectsLease;
  return {
    ...common,
    "effects.lease.ownerToken": lease.ownerToken,
    "effects.lease.claimedAt": { $eq: lease.claimedAt },
    "effects.lease.expiresAt": { $eq: lease.expiresAt, $lte: now },
  };
}

function buildClaimedAnalysisEffects(row: LeanClaimedAnalysisRevision): {
  lease: ConversationAnalysisEffectsLeaseIdentity;
  analysis: ConversationAnalysisEffectsSnapshot;
} {
  const lease = row.effects.lease;
  if (!hasCompleteEffectsLease(lease)) {
    effectsInvariant("post-update claim lease is invalid");
  }
  return {
    lease: {
      analysisRevisionId: row._id,
      conversationId: row.conversationId,
      sourceRevision: row.sourceRevision,
      ownerToken: lease.ownerToken,
      fence: row.effects.fence,
      expiresAt: lease.expiresAt,
      attemptCount: row.effects.attemptCount,
    },
    analysis: {
      analysisRevisionId: row._id,
      conversationId: String(row.conversationId),
      workspaceId: row.workspaceId,
      sourceRevision: row.sourceRevision,
      completedAt: row.completedAt,
      outcome: row.outcome as "ready",
      projection: row.projection as Readonly<Record<string, unknown>>,
      effectInputs:
        row.effectInputs as Readonly<ConversationClassificationEffectInputs>,
      checklist: row.effects.checklist,
    },
  };
}

async function readAnalysisRevision(
  id: string,
  session: ClientSession,
  deps: ConversationClassificationStoreDependencies
): Promise<LeanAnalysisEffectsObservation | null> {
  return (await deps.analysisRevisionModel
    .findById(id, {
      _id: 1,
      conversationId: 1,
      sourceRevision: 1,
      completedAt: 1,
      outcome: 1,
      effects: 1,
    })
    .session(session)
    .lean()
    .exec()) as LeanAnalysisEffectsObservation | null;
}

export async function claimConversationAnalysisEffects(
  input: { analysisRevisionId: string },
  overrides: Partial<ConversationClassificationStoreDependencies> = {}
): Promise<ClaimConversationAnalysisEffectsResult> {
  const deps = dependencies(overrides);
  const now = deps.now();
  const ownerToken = deps.createOwnerToken();
  const expiresAt = addMilliseconds(
    now,
    CONVERSATION_ANALYSIS_EFFECTS_LEASE_MS
  );

  if (
    typeof input.analysisRevisionId !== "string" ||
    input.analysisRevisionId.trim().length === 0
  ) {
    effectsInvariant("requested analysis revision ID is missing");
  }

  for (
    let attempt = 0;
    attempt < MAX_EFFECTS_CLAIM_CAS_ATTEMPTS;
    attempt += 1
  ) {
    const result = await withTransaction(deps, async session => {
      const row = await readAnalysisRevision(
        input.analysisRevisionId,
        session,
        deps
      );
      assertObservedAnalysisEffectsState(row);
      const observed = mapObservedAnalysisEffectsState(row, now);
      if (observed.kind === "return") return observed;

      const claimed = (await deps.analysisRevisionModel
        .findOneAndUpdate(
          buildObservedAnalysisEffectsClaimFilter(row, observed.status, now),
          {
            $set: {
              "effects.status": "processing",
              "effects.nextAttemptAt": null,
              "effects.lease": { ownerToken, claimedAt: now, expiresAt },
            },
            $inc: {
              "effects.attemptCount": 1,
              "effects.fence": 1,
            },
          },
          {
            new: true,
            session,
            timestamps: false,
            projection: {
              _id: 1,
              conversationId: 1,
              workspaceId: 1,
              sourceRevision: 1,
              completedAt: 1,
              outcome: 1,
              projection: 1,
              effectInputs: 1,
              effects: 1,
            },
          }
        )
        .lean()
        .exec()) as LeanClaimedAnalysisRevision | null;
      if (!claimed) return { kind: "retry" as const };
      assertObservedAnalysisEffectsState(claimed);
      const claimedLease = claimed.effects.lease;
      if (!hasCompleteEffectsLease(claimedLease)) {
        effectsInvariant("post-update claim lease is invalid");
      }
      if (
        claimed.effects.status !== "processing" ||
        claimed.effects.attemptCount !== row.effects.attemptCount + 1 ||
        claimed.effects.fence !== row.effects.fence + 1 ||
        claimedLease.ownerToken !== ownerToken ||
        claimedLease.claimedAt.getTime() !== now.getTime() ||
        claimedLease.expiresAt.getTime() !== expiresAt.getTime()
      ) {
        effectsInvariant("post-update claim identity is invalid");
      }
      const owned = buildClaimedAnalysisEffects(claimed);
      if (await currentConversationWriteBarrier(claimed, session, deps)) {
        return {
          kind: "return" as const,
          result: {
            status: "claimed" as const,
            lease: owned.lease,
            analysis: owned.analysis,
          },
        };
      }

      const superseded = await deps.analysisRevisionModel.updateOne(
        effectLeaseFilter(owned.lease, now),
        {
          $set: {
            "effects.status": "superseded",
            "effects.completedAt": now,
            "effects.nextAttemptAt": null,
            "effects.lease": null,
          },
        },
        { session, timestamps: false }
      );
      if (matchedCount(superseded) !== 1) {
        throw new ConversationClassificationCasError(
          "Superseded effects lease changed during claim"
        );
      }
      return {
        kind: "return" as const,
        result: { status: "superseded" as const },
      };
    });

    if (result.kind === "return") return result.result;
  }

  throw new ConversationClassificationCasError(
    `Analysis effects claim CAS exhausted for ${input.analysisRevisionId}`
  );
}

export async function renewConversationAnalysisEffectsLease(
  lease: ConversationAnalysisEffectsLeaseIdentity,
  overrides: Partial<ConversationClassificationStoreDependencies> = {}
): Promise<
  | {
      status: "renewed";
      lease: ConversationAnalysisEffectsLeaseIdentity;
    }
  | { status: "superseded" }
  | { status: "lease_lost" }
> {
  const deps = dependencies(overrides);
  const now = deps.now();
  const nextExpiresAt = new Date(
    Math.max(
      addMilliseconds(now, CONVERSATION_ANALYSIS_EFFECTS_LEASE_MS).getTime(),
      lease.expiresAt.getTime() + 1
    )
  );
  return withTransaction(deps, async session => {
    const row = await readAnalysisRevision(
      lease.analysisRevisionId,
      session,
      deps
    );
    if (!row || !rowHasLiveEffectsLease(row, lease, now)) {
      return { status: "lease_lost" as const };
    }

    if (!(await currentConversationWriteBarrier(row, session, deps))) {
      const superseded = await deps.analysisRevisionModel.updateOne(
        effectLeaseFilter(lease, now),
        {
          $set: {
            "effects.status": "superseded",
            "effects.completedAt": now,
            "effects.nextAttemptAt": null,
            "effects.lease": null,
          },
        },
        { session, timestamps: false }
      );
      return matchedCount(superseded) === 1
        ? { status: "superseded" as const }
        : { status: "lease_lost" as const };
    }

    const renewed = await deps.analysisRevisionModel.updateOne(
      effectLeaseFilter(lease, now),
      { $set: { "effects.lease.expiresAt": nextExpiresAt } },
      { session, timestamps: false }
    );
    if (matchedCount(renewed) !== 1) {
      return { status: "lease_lost" as const };
    }
    return {
      status: "renewed" as const,
      lease: { ...lease, expiresAt: nextExpiresAt },
    };
  });
}

export type ConversationAnalysisEffectsLeaseOutcome =
  | "superseded"
  | "lease_lost";

function assertEffectStep(
  step: string
): asserts step is ConversationAnalysisEffectStep {
  if (
    !CONVERSATION_ANALYSIS_EFFECT_STEPS.includes(
      step as ConversationAnalysisEffectStep
    )
  ) {
    throw new Error(`Unknown analysis effect step ${step}`);
  }
}

function rowHasLiveEffectsLease(
  row: LeanAnalysisEffectsObservation,
  lease: ConversationAnalysisEffectsLeaseIdentity,
  now: Date
): boolean {
  const rowLease = row.effects.lease;
  return (
    row._id === lease.analysisRevisionId &&
    String(row.conversationId) === String(lease.conversationId) &&
    row.sourceRevision === lease.sourceRevision &&
    row.effects.status === "processing" &&
    row.effects.fence === lease.fence &&
    row.effects.attemptCount === lease.attemptCount &&
    rowLease?.ownerToken === lease.ownerToken &&
    rowLease.expiresAt instanceof Date &&
    rowLease.expiresAt.getTime() === lease.expiresAt.getTime() &&
    rowLease.expiresAt.getTime() > now.getTime()
  );
}

async function supersedeOwnedEffects(
  lease: ConversationAnalysisEffectsLeaseIdentity,
  now: Date,
  session: ClientSession,
  deps: ConversationClassificationStoreDependencies
): Promise<void> {
  const superseded = await deps.analysisRevisionModel.updateOne(
    effectLeaseFilter(lease, now),
    {
      $set: {
        "effects.status": "superseded",
        "effects.completedAt": now,
        "effects.nextAttemptAt": null,
        "effects.lease": null,
      },
    },
    { session, timestamps: false }
  );
  if (matchedCount(superseded) !== 1) {
    throw new ConversationClassificationCasError(
      "Claimed effects ownership changed while superseding"
    );
  }
}

async function prepareCurrentClaimedEffects(
  lease: ConversationAnalysisEffectsLeaseIdentity,
  now: Date,
  session: ClientSession,
  deps: ConversationClassificationStoreDependencies
): Promise<
  | { status: "current"; row: LeanAnalysisEffectsObservation }
  | { status: ConversationAnalysisEffectsLeaseOutcome }
> {
  const row = await readAnalysisRevision(
    lease.analysisRevisionId,
    session,
    deps
  );
  if (!row || !rowHasLiveEffectsLease(row, lease, now)) {
    return { status: "lease_lost" };
  }
  if (!(await currentConversationWriteBarrier(row, session, deps))) {
    await supersedeOwnedEffects(lease, now, session, deps);
    return { status: "superseded" };
  }
  return { status: "current", row };
}

export async function authorizeConversationAnalysisEffectStep(
  input: {
    lease: ConversationAnalysisEffectsLeaseIdentity;
    step: ConversationAnalysisEffectStep;
  },
  overrides: Partial<ConversationClassificationStoreDependencies> = {}
): Promise<
  "authorized" | "already_completed" | ConversationAnalysisEffectsLeaseOutcome
> {
  assertEffectStep(input.step);
  const deps = dependencies(overrides);
  const now = deps.now();
  return withTransaction(deps, async session => {
    const prepared = await prepareCurrentClaimedEffects(
      input.lease,
      now,
      session,
      deps
    );
    if (prepared.status !== "current") return prepared.status;
    if (prepared.row.effects.checklist[input.step] instanceof Date) {
      return "already_completed";
    }
    const authorized = await deps.analysisRevisionModel.updateOne(
      {
        ...effectLeaseFilter(input.lease, now),
        [`effects.checklist.${input.step}`]: null,
      },
      { $set: { "effects.lease.expiresAt": input.lease.expiresAt } },
      { session, timestamps: false }
    );
    if (matchedCount(authorized) !== 1) {
      throw new ConversationClassificationCasError(
        "Claimed effect step changed during authorization"
      );
    }
    return "authorized";
  });
}

export async function completeConversationAnalysisEffectStep(
  input: {
    lease: ConversationAnalysisEffectsLeaseIdentity;
    step: ConversationAnalysisEffectStep;
    completedAt?: Date;
  },
  overrides: Partial<ConversationClassificationStoreDependencies> = {}
): Promise<
  "completed" | "already_completed" | ConversationAnalysisEffectsLeaseOutcome
> {
  assertEffectStep(input.step);
  const deps = dependencies(overrides);
  const completedAt = deps.now();
  const current = dependencies({ ...overrides, now: () => completedAt });
  return withTransaction(current, async session => {
    const prepared = await prepareCurrentClaimedEffects(
      input.lease,
      completedAt,
      session,
      current
    );
    if (prepared.status !== "current") return prepared.status;
    if (prepared.row.effects.checklist[input.step] instanceof Date) {
      return "already_completed";
    }
    const result = await current.analysisRevisionModel.updateOne(
      {
        ...effectLeaseFilter(input.lease, completedAt),
        [`effects.checklist.${input.step}`]: null,
      },
      { $set: { [`effects.checklist.${input.step}`]: completedAt } },
      { session, timestamps: false }
    );
    if (matchedCount(result) !== 1) {
      throw new ConversationClassificationCasError(
        "Claimed effect step changed during completion"
      );
    }
    return "completed";
  });
}

export async function completeConversationAnalysisEffects(
  input: {
    lease: ConversationAnalysisEffectsLeaseIdentity;
    completedAt?: Date;
  },
  overrides: Partial<ConversationClassificationStoreDependencies> = {}
): Promise<
  "completed" | "incomplete" | ConversationAnalysisEffectsLeaseOutcome
> {
  const deps = dependencies(overrides);
  const completedAt = deps.now();
  const update = {
    $set: {
      "effects.status": "completed",
      "effects.completedAt": completedAt,
      "effects.nextAttemptAt": null,
      "effects.lease": null,
    },
  };
  const currentDeps = { ...overrides, now: () => completedAt };
  const current = dependencies(currentDeps);
  return withTransaction(current, async session => {
    const prepared = await prepareCurrentClaimedEffects(
      input.lease,
      completedAt,
      session,
      current
    );
    if (prepared.status !== "current") return prepared.status;
    if (
      CONVERSATION_ANALYSIS_EFFECT_STEPS.some(
        step => !(prepared.row.effects.checklist[step] instanceof Date)
      )
    ) {
      return "incomplete";
    }
    const checklistFilter = Object.fromEntries(
      CONVERSATION_ANALYSIS_EFFECT_STEPS.map(step => [
        `effects.checklist.${step}`,
        { $type: "date" },
      ])
    );
    const result = await current.analysisRevisionModel.updateOne(
      {
        ...effectLeaseFilter(input.lease, completedAt),
        ...checklistFilter,
      },
      update,
      { session, timestamps: false }
    );
    if (matchedCount(result) !== 1) {
      throw new ConversationClassificationCasError(
        "Claimed effects changed during terminal completion"
      );
    }
    return "completed";
  });
}

export async function recordConversationAnalysisEffectsFailure(
  input: {
    lease: ConversationAnalysisEffectsLeaseIdentity;
  },
  overrides: Partial<ConversationClassificationStoreDependencies> = {}
): Promise<
  | { status: "retry_scheduled"; nextAttemptAt: Date }
  | { status: ConversationAnalysisEffectsLeaseOutcome }
> {
  const deps = dependencies(overrides);
  const now = deps.now();
  const nextAttemptAt = getConversationAnalysisEffectsRetryAt({
    attemptCount: input.lease.attemptCount,
    now,
  });
  return withTransaction(deps, async session => {
    const prepared = await prepareCurrentClaimedEffects(
      input.lease,
      now,
      session,
      deps
    );
    if (prepared.status !== "current") return { status: prepared.status };
    const result = await deps.analysisRevisionModel.updateOne(
      effectLeaseFilter(input.lease, now),
      {
        $set: {
          "effects.status": "failed",
          "effects.nextAttemptAt": nextAttemptAt,
          "effects.lease": null,
        },
      },
      { session, timestamps: false }
    );
    if (matchedCount(result) !== 1) {
      throw new ConversationClassificationCasError(
        "Claimed effects changed while recording failure"
      );
    }
    return { status: "retry_scheduled" as const, nextAttemptAt };
  });
}

export type ObservedDueEffectsIdentity =
  | {
      status: "pending" | "failed";
      nextAttemptAt: Date;
      fence: number;
    }
  | {
      status: "processing";
      expiresAt: Date;
      fence: number;
    };

function assertObservedDueEffectsIdentity(
  analysisRevisionId: string,
  observed: ObservedDueEffectsIdentity,
  now: Date
): void {
  if (
    typeof analysisRevisionId !== "string" ||
    analysisRevisionId.length === 0 ||
    analysisRevisionId !== analysisRevisionId.trim() ||
    !isPlainRecord(observed) ||
    !isValidDate(now) ||
    !isNonNegativeSafeInteger(observed.fence)
  ) {
    throw new Error("Observed due effects observation is invalid");
  }
  if (observed.status === "pending" || observed.status === "failed") {
    if (
      !hasExactKeys(observed, ["status", "nextAttemptAt", "fence"]) ||
      !isValidDate(observed.nextAttemptAt) ||
      observed.nextAttemptAt.getTime() > now.getTime() ||
      (observed.status === "failed" && observed.fence < 1)
    ) {
      throw new Error("Observed due effects observation is invalid");
    }
    return;
  }
  if (
    observed.status !== "processing" ||
    !hasExactKeys(observed, ["status", "expiresAt", "fence"]) ||
    observed.fence < 1 ||
    !isValidDate(observed.expiresAt) ||
    observed.expiresAt.getTime() > now.getTime()
  ) {
    throw new Error("Observed due effects observation is invalid");
  }
}

export async function reconcileSupersededConversationAnalysisEffects(
  input: {
    analysisRevisionId: string;
    observed: ObservedDueEffectsIdentity;
    now?: Date;
  },
  overrides: Partial<ConversationClassificationStoreDependencies> = {}
): Promise<"current" | "superseded" | "changed" | "missing"> {
  const deps = dependencies(overrides);
  const now = input.now ?? deps.now();
  assertObservedDueEffectsIdentity(
    input.analysisRevisionId,
    input.observed,
    now
  );

  return withTransaction(deps, async session => {
    const row = await readAnalysisRevision(
      input.analysisRevisionId,
      session,
      deps
    );
    if (!row) return "missing";
    assertObservedAnalysisEffectsState(row);
    if (await currentConversationWriteBarrier(row, session, deps)) {
      return "current";
    }

    const commonFilter = {
      _id: input.analysisRevisionId,
      "effects.status": input.observed.status,
      "effects.fence": input.observed.fence,
      "effects.completedAt": null,
    };
    const filter =
      input.observed.status === "processing"
        ? {
            ...commonFilter,
            "effects.nextAttemptAt": null,
            "effects.lease.expiresAt": {
              $eq: input.observed.expiresAt,
              $lte: now,
            },
          }
        : {
            ...commonFilter,
            "effects.nextAttemptAt": {
              $eq: input.observed.nextAttemptAt,
              $lte: now,
            },
            "effects.lease": null,
          };
    const terminalSet = {
      "effects.status": "superseded",
      "effects.completedAt": now,
      "effects.nextAttemptAt": null,
      "effects.lease": null,
    };
    const update =
      input.observed.status === "processing"
        ? { $set: terminalSet, $inc: { "effects.fence": 1 } }
        : { $set: terminalSet };
    const result = await deps.analysisRevisionModel.updateOne(filter, update, {
      session,
      timestamps: false,
    });
    return matchedCount(result) === 1 ? "superseded" : "changed";
  });
}
