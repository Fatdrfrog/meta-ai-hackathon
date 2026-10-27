import mongoose from "mongoose";
import {
  CONVERSATION_PREFERRED_LANGUAGES,
  type ConversationPreferredLanguage,
} from "@icecore/shared/types/conversation";
import {
  isRecord,
  isPlainRecord,
  hasExactKeys,
} from "@icecore/shared/lib/value-utils";

export const CONVERSATION_ANALYSIS_EFFECT_STEPS = [
  "summary",
  "analytics",
  "realtime",
  "usage",
  "webhook",
] as const;
export type ConversationAnalysisEffectStep =
  (typeof CONVERSATION_ANALYSIS_EFFECT_STEPS)[number];

export const CONVERSATION_CLASSIFICATION_EFFECT_INPUT_LIMITS = Object.freeze({
  companyIdLength: 128,
  sourceIdLength: 128,
  sourceTypeLength: 64,
  providerLength: 64,
  modelLength: 128,
  processingTimeMs: 24 * 60 * 60 * 1000,
  ragSummaryLength: 32_000,
  ragChunkCount: 64,
  ragChunkLength: 16_000,
  ragGenerationTimeMs: 24 * 60 * 60 * 1000,
  count: Number.MAX_SAFE_INTEGER,
} as const);

export type ConversationClassificationEffectInputs = {
  companyId: string;
  source: {
    id: string | null;
    type: string | null;
  };
  predictedCategoryConfidence: number;
  processingTimeMs: number;
  provider: string;
  model: string;
  ragSummary: null | {
    mode: "replace" | "promote";
    language: ConversationPreferredLanguage;
    summary: string;
    chunks: string[];
    metadata: {
      wordCount: number;
      messageCount: number;
      chunkCount: number;
      generationTimeMs: number;
    };
  };
};

function effectInputError(path: string): Error {
  return new Error(`Conversation classification effect input ${path} is invalid`);
}

function assertExactEffectInputRecord(
  value: unknown,
  path: string,
  fields: readonly string[]
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value) || !hasExactKeys(value, fields)) {
    throw effectInputError(path);
  }
}

function assertCanonicalBoundedText(
  value: unknown,
  path: string,
  maximumLength: number
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    value.trim().length === 0 ||
    value !== value.trim()
  ) {
    throw effectInputError(path);
  }
}

function assertSafeIntegerInRange(
  value: unknown,
  path: string,
  maximum: number
): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maximum
  ) {
    throw effectInputError(path);
  }
}

function assertRagContentText(
  value: unknown,
  path: string,
  maximumLength: number
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    value.trim().length === 0
  ) {
    throw effectInputError(path);
  }
}

export function assertConversationClassificationEffectInputs(
  value: unknown
): asserts value is ConversationClassificationEffectInputs {
  const limits = CONVERSATION_CLASSIFICATION_EFFECT_INPUT_LIMITS;
  assertExactEffectInputRecord(value, "object", [
    "companyId",
    "source",
    "predictedCategoryConfidence",
    "processingTimeMs",
    "provider",
    "model",
    "ragSummary",
  ]);
  assertCanonicalBoundedText(
    value.companyId,
    "companyId",
    limits.companyIdLength
  );
  assertExactEffectInputRecord(value.source, "source", ["id", "type"]);
  const sourceId = value.source.id;
  const sourceType = value.source.type;
  if (sourceId === null && sourceType === null) {
    // A source-less conversation has an explicit paired-null identity.
  } else if (sourceId !== null && sourceType !== null) {
    assertCanonicalBoundedText(sourceId, "source.id", limits.sourceIdLength);
    assertCanonicalBoundedText(
      sourceType,
      "source.type",
      limits.sourceTypeLength
    );
  } else {
    throw effectInputError("source");
  }
  if (
    typeof value.predictedCategoryConfidence !== "number" ||
    !Number.isFinite(value.predictedCategoryConfidence) ||
    value.predictedCategoryConfidence < 0 ||
    value.predictedCategoryConfidence > 1
  ) {
    throw effectInputError("predictedCategoryConfidence");
  }
  assertSafeIntegerInRange(
    value.processingTimeMs,
    "processingTimeMs",
    limits.processingTimeMs
  );
  assertCanonicalBoundedText(value.provider, "provider", limits.providerLength);
  assertCanonicalBoundedText(value.model, "model", limits.modelLength);

  if (value.ragSummary === null) return;
  assertExactEffectInputRecord(value.ragSummary, "ragSummary", [
    "mode",
    "language",
    "summary",
    "chunks",
    "metadata",
  ]);
  if (value.ragSummary.mode !== "replace" && value.ragSummary.mode !== "promote") {
    throw effectInputError("ragSummary.mode");
  }
  if (
    typeof value.ragSummary.language !== "string" ||
    !CONVERSATION_PREFERRED_LANGUAGES.includes(
      value.ragSummary.language as ConversationPreferredLanguage
    )
  ) {
    throw effectInputError("ragSummary.language");
  }
  assertRagContentText(
    value.ragSummary.summary,
    "ragSummary.summary",
    limits.ragSummaryLength
  );
  if (
    !Array.isArray(value.ragSummary.chunks) ||
    value.ragSummary.chunks.length > limits.ragChunkCount
  ) {
    throw effectInputError("ragSummary.chunks");
  }
  value.ragSummary.chunks.forEach((chunk, index) =>
    assertRagContentText(
      chunk,
      `ragSummary.chunks.${index}`,
      limits.ragChunkLength
    )
  );
  assertExactEffectInputRecord(value.ragSummary.metadata, "ragSummary.metadata", [
    "wordCount",
    "messageCount",
    "chunkCount",
    "generationTimeMs",
  ]);
  assertSafeIntegerInRange(
    value.ragSummary.metadata.wordCount,
    "ragSummary.metadata.wordCount",
    limits.count
  );
  assertSafeIntegerInRange(
    value.ragSummary.metadata.messageCount,
    "ragSummary.metadata.messageCount",
    limits.count
  );
  assertSafeIntegerInRange(
    value.ragSummary.metadata.chunkCount,
    "ragSummary.metadata.chunkCount",
    limits.count
  );
  assertSafeIntegerInRange(
    value.ragSummary.metadata.generationTimeMs,
    "ragSummary.metadata.generationTimeMs",
    limits.ragGenerationTimeMs
  );
  if (value.ragSummary.metadata.chunkCount !== value.ragSummary.chunks.length) {
    throw effectInputError("ragSummary.metadata.chunkCount");
  }
}

export const ANALYSIS_REVISION_EFFECT_STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed",
  "superseded",
  "not_applicable",
] as const;

export const ANALYSIS_REVISION_OUTCOMES = [
  "ready",
  "review_required",
] as const;

export type AnalysisRevisionEffectStatus =
  (typeof ANALYSIS_REVISION_EFFECT_STATUSES)[number];
export type AnalysisRevisionOutcome =
  (typeof ANALYSIS_REVISION_OUTCOMES)[number];

export type AnalysisRevisionReview = {
  code: string;
  reason: string;
};

export interface IConversationAnalysisRevision {
  _id: string;
  conversationId: mongoose.Types.ObjectId;
  workspaceId: string;
  sourceRevision: number;
  completedAt: Date;
  outcome: AnalysisRevisionOutcome;
  projection: Record<string, unknown> | null;
  review: AnalysisRevisionReview | null;
  effectInputs: ConversationClassificationEffectInputs | null;
  provenance: {
    taxonomyId: string | null;
    taxonomyDigest: string | null;
    classifierVersion: string | null;
    classifierContractRevision: number;
  };
  effects: {
    status: AnalysisRevisionEffectStatus;
    attemptCount: number;
    fence: number;
    nextAttemptAt: Date | null;
    completedAt: Date | null;
    lease: {
      ownerToken: string | null;
      claimedAt: Date | null;
      expiresAt: Date | null;
    } | null;
    checklist: Record<ConversationAnalysisEffectStep, Date | null>;
  };
  createdAt: Date;
  updatedAt: Date;
}

const AnalysisRevisionProvenanceSchema = new mongoose.Schema<
  Record<string, unknown>
>(
  {
    taxonomyId: { type: String, default: null },
    taxonomyDigest: { type: String, default: null },
    classifierVersion: { type: String, default: null },
    classifierContractRevision: { type: Number, required: true, min: 1 },
  },
  { _id: false }
);

const AnalysisRevisionReviewSchema = new mongoose.Schema<
  Record<string, unknown>
>(
  {
    code: { type: String, required: true },
    reason: { type: String, required: true },
  },
  { _id: false }
);

const AnalysisRevisionEffectInputSourceSchema = new mongoose.Schema<
  Record<string, unknown>
>(
  {
    id: { type: String, default: undefined },
    type: { type: String, default: undefined },
  },
  { _id: false, strict: "throw" }
);

const AnalysisRevisionEffectInputMetadataSchema = new mongoose.Schema<
  Record<string, unknown>
>(
  {
    wordCount: { type: Number, required: true },
    messageCount: { type: Number, required: true },
    chunkCount: { type: Number, required: true },
    generationTimeMs: { type: Number, required: true },
  },
  { _id: false, strict: "throw" }
);

const AnalysisRevisionEffectInputRagSummarySchema = new mongoose.Schema<
  Record<string, unknown>
>(
  {
    mode: { type: String, enum: ["replace", "promote"], required: true },
    language: {
      type: String,
      enum: CONVERSATION_PREFERRED_LANGUAGES,
      required: true,
    },
    summary: { type: String, required: true },
    chunks: { type: [String], default: undefined, required: true },
    metadata: {
      type: AnalysisRevisionEffectInputMetadataSchema,
      default: undefined,
      required: true,
    },
  },
  { _id: false, strict: "throw" }
);

const AnalysisRevisionEffectInputsSchema = new mongoose.Schema<
  Record<string, unknown>
>(
  {
    companyId: { type: String, required: true },
    source: {
      type: AnalysisRevisionEffectInputSourceSchema,
      default: undefined,
      required: true,
    },
    predictedCategoryConfidence: { type: Number, required: true },
    processingTimeMs: { type: Number, required: true },
    provider: { type: String, required: true },
    model: { type: String, required: true },
    ragSummary: {
      type: AnalysisRevisionEffectInputRagSummarySchema,
      default: undefined,
    },
  },
  { _id: false, strict: "throw" }
);

const AnalysisRevisionEffectsLeaseSchema = new mongoose.Schema<
  Record<string, unknown>
>(
  {
    ownerToken: { type: String, default: null },
    claimedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
  },
  { _id: false }
);

const AnalysisRevisionEffectsChecklistSchema = new mongoose.Schema<
  Record<string, unknown>
>(
  Object.fromEntries(
    CONVERSATION_ANALYSIS_EFFECT_STEPS.map(step => [
      step,
      { type: Date, default: null },
    ])
  ),
  { _id: false, strict: "throw" }
);

const AnalysisRevisionEffectsSchema = new mongoose.Schema<
  Record<string, unknown>
>(
  {
    status: {
      type: String,
      enum: ANALYSIS_REVISION_EFFECT_STATUSES,
      default: "pending",
      required: true,
    },
    attemptCount: { type: Number, default: 0, min: 0, required: true },
    fence: { type: Number, default: 0, min: 0, required: true },
    nextAttemptAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    lease: { type: AnalysisRevisionEffectsLeaseSchema, default: null },
    checklist: {
      type: AnalysisRevisionEffectsChecklistSchema,
      default: () => ({}),
      required: true,
      set: (value: unknown) => {
        if (
          !isPlainRecord(value) ||
          !hasExactKeys(value, CONVERSATION_ANALYSIS_EFFECT_STEPS)
        ) {
          throw new Error(
            "Initial effects checklist must contain the complete exact fields"
          );
        }
        return value;
      },
    },
  },
  { _id: false }
);

const ConversationAnalysisRevisionSchema =
  new mongoose.Schema<IConversationAnalysisRevision>(
    {
      _id: { type: String, required: true },
      conversationId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Conversation",
        required: true,
      },
      workspaceId: { type: String, required: true },
      sourceRevision: {
        type: Number,
        required: true,
        min: 1,
      },
      completedAt: { type: Date, required: true },
      outcome: {
        type: String,
        enum: ANALYSIS_REVISION_OUTCOMES,
        required: true,
      },
      projection: {
        type: mongoose.Schema.Types.Mixed,
        default: null,
      },
      review: {
        type: AnalysisRevisionReviewSchema,
        default: null,
      },
      effectInputs: {
        type: AnalysisRevisionEffectInputsSchema,
        default: undefined,
        set: (value: unknown) => {
          if (value !== null && value !== undefined) {
            assertConversationClassificationEffectInputs(value);
          }
          return value;
        },
      },
      provenance: {
        type: AnalysisRevisionProvenanceSchema,
        required: true,
      },
      effects: {
        type: AnalysisRevisionEffectsSchema,
        default: () => ({}),
        required: true,
      },
    },
    { timestamps: true }
  );

const MUTABLE_REVISION_PATH_PREFIX = "effects";
const MUTABLE_REVISION_BOOKKEEPING_PATHS = new Set(["updatedAt", "__v"]);

function isAllowedRevisionMutationPath(
  path: string,
  operator: string | null = null
): boolean {
  return (
    path === MUTABLE_REVISION_PATH_PREFIX ||
    path.startsWith(`${MUTABLE_REVISION_PATH_PREFIX}.`) ||
    MUTABLE_REVISION_BOOKKEEPING_PATHS.has(path) ||
    (operator === "$setOnInsert" && path === "createdAt")
  );
}

function immutableRevisionMutationError(path: string): Error {
  return new Error(
    `Immutable analysis revision payload path ${path} cannot be updated`
  );
}

function appendOnlyRevisionError(operation: string): Error {
  return new Error(
    `Conversation analysis revisions are append-only; ${operation} is forbidden`
  );
}

function assertDocumentRevisionMutationAllowed(
  document: mongoose.HydratedDocument<IConversationAnalysisRevision>
): void {
  if (document.isNew) return;
  const forbiddenPath = document
    .modifiedPaths({ includeChildren: true })
    .find((path) => !isAllowedRevisionMutationPath(path));
  if (forbiddenPath) throw immutableRevisionMutationError(forbiddenPath);
}

const INITIAL_EFFECT_FIELDS = [
  "status",
  "attemptCount",
  "fence",
  "nextAttemptAt",
  "completedAt",
  "lease",
  "checklist",
] as const;
const INITIAL_EFFECT_CHECKLIST_FIELDS = CONVERSATION_ANALYSIS_EFFECT_STEPS;

function validDateTimestamp(value: unknown): number | null {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function initialEffectsValidationError(input: {
  effects: unknown;
  outcome: unknown;
  rowCompletedAt: unknown;
}): string | null {
  if (
    !isRecord(input.effects) ||
    !hasExactKeys(input.effects, INITIAL_EFFECT_FIELDS)
  ) {
    return "Initial effects must contain the complete exact effects object";
  }
  const checklist = input.effects.checklist;
  if (
    !isRecord(checklist) ||
    !hasExactKeys(checklist, INITIAL_EFFECT_CHECKLIST_FIELDS) ||
    Object.values(checklist).some((value) => value !== null)
  ) {
    return "Initial effects checklist must be complete and all null";
  }
  if (
    input.effects.attemptCount !== 0 ||
    input.effects.fence !== 0 ||
    input.effects.lease !== null
  ) {
    return "Initial effects attempts, fence, and lease are invalid";
  }

  if (input.outcome === "ready") {
    if (
      input.effects.status !== "pending" ||
      validDateTimestamp(input.effects.nextAttemptAt) === null ||
      input.effects.completedAt !== null
    ) {
      return "Ready initial effects must be pending and due without completion";
    }
    return null;
  }

  if (input.outcome === "review_required") {
    const rowCompletedAt = validDateTimestamp(input.rowCompletedAt);
    const effectsCompletedAt = validDateTimestamp(input.effects.completedAt);
    if (
      input.effects.status !== "not_applicable" ||
      input.effects.nextAttemptAt !== null ||
      rowCompletedAt === null ||
      effectsCompletedAt !== rowCompletedAt
    ) {
      return "Review-required initial effects must be terminal at row completion";
    }
    return null;
  }

  return "Initial effects outcome is invalid";
}

type RevisionQueryMutationOptions = {
  allowImmutableSetOnInsert: boolean;
  filter: unknown;
};

function readEqualityId(filter: unknown): unknown {
  if (!isRecord(filter)) return undefined;
  const id = filter._id;
  if (isRecord(id) && Object.keys(id).length === 1) return id.$eq;
  return id;
}

function assertCanonicalSetOnInsertIdentity(
  setOnInsert: Record<string, unknown>,
  filter: unknown
): void {
  const conversationId = setOnInsert.conversationId;
  const sourceRevision = setOnInsert.sourceRevision;
  const id = setOnInsert._id ?? readEqualityId(filter);
  if (
    (typeof conversationId !== "string" &&
      !(conversationId instanceof mongoose.Types.ObjectId)) ||
    !Number.isSafeInteger(sourceRevision) ||
    (sourceRevision as number) <= 0 ||
    typeof id !== "string"
  ) {
    throw new Error(
      "Canonical analysis revision identity is required for immutable upsert data"
    );
  }
  const expectedId = buildConversationAnalysisRevisionId({
    conversationId: conversationId.toString(),
    sourceRevision: sourceRevision as number,
  });
  if (id !== expectedId) {
    throw new Error("Canonical analysis revision upsert identity does not match");
  }

  if (
    typeof setOnInsert.workspaceId !== "string" ||
    setOnInsert.workspaceId.length === 0 ||
    (!(setOnInsert.completedAt instanceof Date) &&
      (typeof setOnInsert.completedAt !== "string" ||
        !Number.isFinite(Date.parse(setOnInsert.completedAt)))) ||
    !isRecord(setOnInsert.provenance)
  ) {
    throw new Error("Immutable analysis revision upsert data is invalid");
  }

  const outcome = setOnInsert.outcome;
  if (outcome === "ready") {
    if (
      !isPlainRecord(setOnInsert.projection) ||
      (setOnInsert.review !== null && setOnInsert.review !== undefined) ||
      setOnInsert.effectInputs === null ||
      setOnInsert.effectInputs === undefined
    ) {
      throw new Error(
        "Ready upsert outcome projection, review, or effect input is invalid"
      );
    }
    assertConversationClassificationEffectInputs(setOnInsert.effectInputs);
  } else if (outcome === "review_required") {
    const review = setOnInsert.review;
    if (
      setOnInsert.projection !== null ||
      setOnInsert.effectInputs !== null ||
      !isRecord(review) ||
      typeof review.code !== "string" ||
      review.code.length === 0 ||
      typeof review.reason !== "string" ||
      review.reason.length === 0
    ) {
      throw new Error(
        "Review-required upsert outcome projection, review, effect input, or effects is invalid"
      );
    }
  } else {
    throw new Error("Immutable analysis revision upsert outcome is invalid");
  }

  const effectsError = initialEffectsValidationError({
    effects: setOnInsert.effects,
    outcome,
    rowCompletedAt: setOnInsert.completedAt,
  });
  if (effectsError) throw new Error(effectsError);
}

function assertQueryRevisionMutationAllowed(
  update: unknown,
  options: RevisionQueryMutationOptions
): void {
  if (update === null || update === undefined) return;
  if (Array.isArray(update)) {
    throw immutableRevisionMutationError("aggregation pipeline");
  }
  if (!isRecord(update)) {
    throw immutableRevisionMutationError("replacement");
  }

  let immutableSetOnInsert: Record<string, unknown> | null = null;
  for (const [operatorOrPath, payload] of Object.entries(update)) {
    if (!operatorOrPath.startsWith("$")) {
      if (
        options.allowImmutableSetOnInsert &&
        (operatorOrPath === MUTABLE_REVISION_PATH_PREFIX ||
          operatorOrPath.startsWith(`${MUTABLE_REVISION_PATH_PREFIX}.`))
      ) {
        throw new Error(
          "Upsert effects must exist only in the complete $setOnInsert object"
        );
      }
      if (!isAllowedRevisionMutationPath(operatorOrPath)) {
        throw immutableRevisionMutationError(operatorOrPath);
      }
      continue;
    }
    if (!isRecord(payload)) {
      throw immutableRevisionMutationError(operatorOrPath);
    }
    if (operatorOrPath === "$setOnInsert") {
      immutableSetOnInsert = payload;
    }
    for (const [path, value] of Object.entries(payload)) {
      const renameDestinationMutatesEffects =
        operatorOrPath === "$rename" &&
        typeof value === "string" &&
        (value === MUTABLE_REVISION_PATH_PREFIX ||
          value.startsWith(`${MUTABLE_REVISION_PATH_PREFIX}.`));
      if (
        options.allowImmutableSetOnInsert &&
        operatorOrPath !== "$setOnInsert" &&
        (path === MUTABLE_REVISION_PATH_PREFIX ||
          path.startsWith(`${MUTABLE_REVISION_PATH_PREFIX}.`) ||
          renameDestinationMutatesEffects)
      ) {
        throw new Error(
          "Upsert effects must exist only in the complete $setOnInsert object"
        );
      }
      const isImmutableInsertPath =
        operatorOrPath === "$setOnInsert" &&
        options.allowImmutableSetOnInsert;
      if (
        !isImmutableInsertPath &&
        !isAllowedRevisionMutationPath(path, operatorOrPath)
      ) {
        throw immutableRevisionMutationError(path);
      }
      if (
        operatorOrPath === "$rename" &&
        (typeof value !== "string" || !isAllowedRevisionMutationPath(value))
      ) {
        throw immutableRevisionMutationError(String(value));
      }
    }
  }

  if (options.allowImmutableSetOnInsert) {
    if (!immutableSetOnInsert) {
      throw new Error(
        "Canonical analysis revision immutable upsert data is required"
      );
    }
    assertCanonicalSetOnInsertIdentity(immutableSetOnInsert, options.filter);
  }
}

function assertRevisionUpdateQueryAllowed(
  query: mongoose.Query<unknown, IConversationAnalysisRevision>
): void {
  assertQueryRevisionMutationAllowed(query.getUpdate(), {
    allowImmutableSetOnInsert: query.getOptions().upsert === true,
    filter: query.getFilter(),
  });
}

ConversationAnalysisRevisionSchema.pre("validate", function () {
  assertDocumentRevisionMutationAllowed(this);

  if (!Number.isSafeInteger(this.sourceRevision) || this.sourceRevision <= 0) {
    this.invalidate(
      "sourceRevision",
      "Analysis revision sourceRevision must be a positive safe integer"
    );
  } else if (this.conversationId) {
    const expectedId = buildConversationAnalysisRevisionId({
      conversationId: this.conversationId.toString(),
      sourceRevision: this.sourceRevision,
    });
    if (!this._id) this._id = expectedId;
    else if (this._id !== expectedId) {
      this.invalidate("_id", "Analysis revision _id must be canonical");
    }
  }

  if (this.outcome === "ready") {
    if (!isPlainRecord(this.projection)) {
      this.invalidate(
        "projection",
        "Ready analysis revision outcome requires a projection"
      );
    }
    if (this.review !== null && this.review !== undefined) {
      this.invalidate(
        "review",
        "Ready analysis revision outcome cannot contain review metadata"
      );
    }
    if (this.effectInputs === null || this.effectInputs === undefined) {
      this.invalidate(
        "effectInputs",
        "Ready analysis revision outcome requires effect inputs"
      );
    } else {
      try {
        const effectInputs = this.get("effectInputs") as unknown;
        const plainEffectInputs =
          isRecord(effectInputs) &&
          typeof effectInputs.toObject === "function"
            ? (effectInputs.toObject as (options: {
                depopulate: boolean;
              }) => unknown)({ depopulate: true })
            : effectInputs;
        assertConversationClassificationEffectInputs(plainEffectInputs);
      } catch (error) {
        this.invalidate("effectInputs", (error as Error).message);
      }
    }
  } else if (this.outcome === "review_required") {
    if (this.projection !== null) {
      this.invalidate(
        "projection",
        "Review-required analysis revision outcome requires projection null"
      );
    }
    if (!this.review) {
      this.invalidate(
        "review",
        "Review-required analysis revision outcome requires review metadata"
      );
    }
    if (this.effectInputs !== null) {
      this.invalidate(
        "effectInputs",
        "Review-required analysis revision outcome requires effect inputs null"
      );
    }
  }

  if (this.isNew) {
    const effects = this.toObject({
      depopulate: true,
      flattenMaps: true,
      versionKey: false,
    }).effects;
    const effectsError = initialEffectsValidationError({
      effects,
      outcome: this.outcome,
      rowCompletedAt: this.completedAt,
    });
    if (effectsError) this.invalidate("effects", effectsError);
  }
});

ConversationAnalysisRevisionSchema.pre("save", function () {
  assertDocumentRevisionMutationAllowed(this);
});

ConversationAnalysisRevisionSchema.pre("updateOne", function () {
  assertRevisionUpdateQueryAllowed(this);
});
ConversationAnalysisRevisionSchema.pre("updateMany", function () {
  assertRevisionUpdateQueryAllowed(this);
});
ConversationAnalysisRevisionSchema.pre("findOneAndUpdate", function () {
  assertRevisionUpdateQueryAllowed(this);
});
ConversationAnalysisRevisionSchema.pre("replaceOne", function () {
  throw immutableRevisionMutationError("replacement");
});
ConversationAnalysisRevisionSchema.pre("findOneAndReplace", function () {
  throw immutableRevisionMutationError("replacement");
});
ConversationAnalysisRevisionSchema.pre(
  "deleteOne",
  { document: false, query: true },
  function () {
    throw appendOnlyRevisionError("deleteOne");
  }
);
ConversationAnalysisRevisionSchema.pre(
  "deleteOne",
  { document: true, query: false },
  function () {
    throw appendOnlyRevisionError("document deleteOne");
  }
);
ConversationAnalysisRevisionSchema.pre("deleteMany", function () {
  throw appendOnlyRevisionError("deleteMany");
});
ConversationAnalysisRevisionSchema.pre("findOneAndDelete", function () {
  throw appendOnlyRevisionError("findOneAndDelete");
});
ConversationAnalysisRevisionSchema.pre("insertMany", function () {
  throw appendOnlyRevisionError("insertMany");
});

ConversationAnalysisRevisionSchema.pre(
  "bulkWrite",
  function (next, operations) {
    try {
      for (const operation of operations) {
        if ("insertOne" in operation) {
          throw appendOnlyRevisionError("bulk insertOne");
        } else if ("deleteOne" in operation) {
          throw appendOnlyRevisionError("bulk deleteOne");
        } else if ("deleteMany" in operation) {
          throw appendOnlyRevisionError("bulk deleteMany");
        } else if ("updateOne" in operation) {
          assertQueryRevisionMutationAllowed(operation.updateOne.update, {
            allowImmutableSetOnInsert: operation.updateOne.upsert === true,
            filter: operation.updateOne.filter,
          });
        } else if ("updateMany" in operation) {
          assertQueryRevisionMutationAllowed(operation.updateMany.update, {
            allowImmutableSetOnInsert: operation.updateMany.upsert === true,
            filter: operation.updateMany.filter,
          });
        } else if ("replaceOne" in operation) {
          throw immutableRevisionMutationError("replacement");
        }
      }
      next();
    } catch (error) {
      next(error as Error);
    }
  }
);

export const ANALYSIS_REVISION_DUE_EFFECTS_INDEX_NAME =
  "conversation_analysis_revisions_effects_due";
export const ANALYSIS_REVISION_DUE_EFFECTS_INDEX_KEYS = {
  "effects.status": 1,
  "effects.nextAttemptAt": 1,
  completedAt: 1,
  _id: 1,
} as const;
export const ANALYSIS_REVISION_DUE_EFFECTS_PARTIAL_FILTER = {
  "effects.status": { $in: ["pending", "failed"] },
} as const;

export const ANALYSIS_REVISION_EXPIRED_EFFECTS_LEASE_INDEX_NAME =
  "conversation_analysis_revisions_effects_processing_expired";
export const ANALYSIS_REVISION_EXPIRED_EFFECTS_LEASE_INDEX_KEYS = {
  "effects.status": 1,
  "effects.lease.expiresAt": 1,
  completedAt: 1,
  _id: 1,
} as const;
export const ANALYSIS_REVISION_EXPIRED_EFFECTS_LEASE_PARTIAL_FILTER = {
  "effects.status": "processing",
} as const;

ConversationAnalysisRevisionSchema.index(
  ANALYSIS_REVISION_DUE_EFFECTS_INDEX_KEYS,
  {
    name: ANALYSIS_REVISION_DUE_EFFECTS_INDEX_NAME,
    partialFilterExpression: ANALYSIS_REVISION_DUE_EFFECTS_PARTIAL_FILTER,
  }
);
ConversationAnalysisRevisionSchema.index(
  ANALYSIS_REVISION_EXPIRED_EFFECTS_LEASE_INDEX_KEYS,
  {
    name: ANALYSIS_REVISION_EXPIRED_EFFECTS_LEASE_INDEX_NAME,
    partialFilterExpression:
      ANALYSIS_REVISION_EXPIRED_EFFECTS_LEASE_PARTIAL_FILTER,
  }
);

export function buildConversationAnalysisRevisionId(input: {
  conversationId: string;
  sourceRevision: number;
}): string {
  if (
    input.conversationId.length === 0 ||
    input.conversationId.trim() !== input.conversationId
  ) {
    throw new Error("conversationId is invalid");
  }
  if (!Number.isSafeInteger(input.sourceRevision) || input.sourceRevision <= 0) {
    throw new Error("sourceRevision must be a positive integer");
  }
  return `${input.conversationId}:${input.sourceRevision}`;
}

export const ConversationAnalysisRevision =
  (mongoose.models
    .ConversationAnalysisRevision as mongoose.Model<IConversationAnalysisRevision>) ||
  mongoose.model<IConversationAnalysisRevision>(
    "ConversationAnalysisRevision",
    ConversationAnalysisRevisionSchema
  );
