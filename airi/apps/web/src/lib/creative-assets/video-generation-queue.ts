import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  CREATIVE_ASSET_EDIT_TASK_QUEUE,
  VIDEO_GENERATION_WORKFLOW_CONTRACT_VERSION,
  buildVideoGenerationWorkflowId,
  type CompiledVideoPrompt,
  type VideoGenerationCompletionTarget,
  type VideoGenerationSpec,
  type VideoGenerationWorkflowInput,
  normalizeVideoGenerationCompletionTarget,
} from "@icecore/temporal";
import { Types } from "mongoose";

import {
  getGoogleFreeGenerationLimit,
  getGoogleVideoGenerationModel,
  isGoogleCreativeGenerationConfigured,
} from "@/lib/google/creative-assets";
import {
  withWorkspacePlatformCreativeGenerationQuotaAdmission,
  type PlatformCreativeGenerationQuotaAdmissionResult,
} from "@/lib/creative-assets/platform-creative-generation-quota-ledger";
import {
  getHappyHorseDefaultRatio,
  getHappyHorseDefaultResolution,
  getHappyHorseModelForMode,
  normalizeHappyHorseDuration,
  normalizeHappyHorseRatio,
  normalizeHappyHorseResolution,
  type HappyHorseMode,
} from "@/lib/happyhorse/happyhorse-config";
import { getHiggsfieldImageToVideoModel } from "@/lib/higgsfield/higgsfield-client";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import {
  startVideoGenerationWorkflow,
  VideoGenerationWorkflowNotRunningError,
  VideoGenerationWorkflowStartAmbiguousError,
} from "@/lib/temporal/video-generation";
import {
  CreativeAsset,
  type CreativeAssetVideoGeneration,
} from "@/models/creative-asset";

import { CreativeGenerationAdmissionBusyError } from "./creative-generation-admission";
import {
  compileVideoPrompt,
  VideoPromptCompileError,
} from "./video-generation-prompt";
import {
  resolveVideoGenerationProviderResultResume,
  resolveVideoGenerationRetryAvailability,
  type VideoGenerationRetryAvailability,
} from "./video-generation-retry-availability";
import {
  buildVideoGenerationNsfwAliasFilter,
  buildVideoGenerationNsfwUpdatePipeline,
  MAX_VIDEO_GENERATION_SAFETY_ANCESTOR_ID_LENGTH,
  MAX_VIDEO_GENERATION_SAFETY_ANCESTORS,
  MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_ID_LENGTH,
  MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_IDS,
} from "./video-generation-nsfw";
import {
  findVideoGenerationNsfwVerdict,
  type VideoGenerationNsfwVerdictIdentity,
  type VideoGenerationSafetyAncestor,
} from "./video-generation-nsfw-verdict-store";

export type VideoProviderPolicy =
  | { provider: "happyhorse" }
  | { provider: "higgsfield"; providerSourceId: string }
  | { provider: "google"; providerSourceId: string };

export type VideoGenerationRouteRequest = {
  mode: "text_to_video" | "image_to_video" | "reference_to_video";
  prompt: string;
  skill?: "video" | "character";
  durationSeconds?: number;
  aspectRatio?: unknown;
  resolution?: unknown;
  sourceAssetId?: string | null;
  referenceAssetIds?: string[] | null;
  seed?: unknown;
};

export type QueueVideoGenerationInput = {
  workspaceId: string;
  createdBy: string | null;
  idempotencyKey: string;
  providerPolicy: VideoProviderPolicy;
  request: VideoGenerationRouteRequest;
  completionTarget?: VideoGenerationCompletionTarget | null;
};

export type RetryVideoGenerationInput = {
  workspaceId: string;
  assetId: string;
  createdBy: string | null;
  idempotencyKey: string;
  acknowledgePossibleDuplicateCharge?: boolean;
};

export type VideoAssetRecord = Record<string, unknown> & {
  _id: unknown;
  id?: string;
  workspaceId: string;
  status: string;
  storageProvider?: string | null;
  bucket?: string | null;
  path?: string | null;
  providerSourceId?: string | null;
  providerRequestId?: string | null;
  providerStatusUrl?: string | null;
  generation?: CreativeAssetVideoGeneration | null;
};

type VideoRecoverySource = NonNullable<
  CreativeAssetVideoGeneration["recoverySource"]
>;

type SourceAssetRecord = {
  _id: unknown;
  workspaceId: string;
  kind: string;
  status: string;
};

type OrchestrationState = "pending" | "started" | "unknown";
export type VideoGenerationQueueDependencies = {
  validateCustomerCredentials(input: {
    workspaceId: string;
    provider: string;
    providerSourceId: string | null;
  }): Promise<void>;
  ensureIndexes(): Promise<void>;
  findSources(query: Record<string, unknown>): Promise<SourceAssetRecord[]>;
  findAsset(query: Record<string, unknown>): Promise<VideoAssetRecord | null>;
  createAsset(value: Record<string, unknown>): Promise<VideoAssetRecord>;
  compareAndSetOrchestration(input: {
    assetId: string;
    workspaceId: string;
    attemptToken: string;
    fromStates: OrchestrationState[];
    toState: "started" | "unknown";
    startedAt: Date | null;
  }): Promise<VideoAssetRecord | null>;
  findNsfwProviderRequestAlias(input: {
    workspaceId: string;
    providerRequestId: string;
  }): Promise<VideoAssetRecord | null>;
  findNsfwSafetyVerdict(input: {
    workspaceId: string;
    providerRequestIds: string[];
    ancestors: VideoGenerationSafetyAncestor[];
  }): Promise<VideoGenerationNsfwVerdictIdentity | null>;
  markAssetNsfwFromAlias(input: {
    assetId: string;
    workspaceId: string;
    providerRequestId: string;
    now: Date;
  }): Promise<boolean>;
  mergeAssetSafetyLineage(input: {
    asset: VideoAssetRecord;
    workspaceId: string;
    providerRequestIds: string[];
    ancestors: VideoGenerationSafetyAncestor[];
  }): Promise<VideoAssetRecord | null>;
  withPlatformQuotaAdmission<T>(
    input: {
      workspaceId: string;
      limit: number;
      claimKey: string;
      assetId: string;
    },
    run: (reservation: { assetId: string; replay: boolean }) => Promise<T>
  ): Promise<PlatformCreativeGenerationQuotaAdmissionResult<T>>;
  getGoogleGenerationLimit(): number;
  isGoogleGenerationConfigured(): boolean;
  startWorkflow(
    input: VideoGenerationWorkflowInput
  ): ReturnType<typeof startVideoGenerationWorkflow>;
  newAssetId(): string;
  newAttemptToken(): string;
  now(): Date;
};

export type QueueVideoGenerationDependencies = VideoGenerationQueueDependencies;

export class VideoGenerationQueueError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 503,
    readonly code: string,
    message: string,
    readonly maxLength?: number
  ) {
    super(message);
    this.name = "VideoGenerationQueueError";
  }
}

const defaultDependencies: QueueVideoGenerationDependencies = {
  async validateCustomerCredentials(input) {
    try {
      const { assertWorkspaceCreativeCustomerSource } = await import(
        "@/lib/google/creative-credentials"
      );
      await assertWorkspaceCreativeCustomerSource(input);
    } catch {
      throw new VideoGenerationQueueError(
        403,
        "own_ai_source_required",
        "Connect your own compatible AI source in Settings > Integrations to generate images or video."
      );
    }
  },
  async ensureIndexes() {
    const { ensureCreativeAssetGenerationIndexes } = await import(
      "@/lib/creative-assets/creative-asset-generation-indexes"
    );
    await ensureCreativeAssetGenerationIndexes();
  },
  async findSources(query) {
    return (await CreativeAsset.find(query)
      .select({ _id: 1, workspaceId: 1, kind: 1, status: 1 })
      .lean()) as unknown as SourceAssetRecord[];
  },
  async findAsset(query) {
    return (await CreativeAsset.findOne(
      query
    ).lean()) as VideoAssetRecord | null;
  },
  async createAsset(value) {
    const document = await CreativeAsset.create(value);
    const asset = document.toObject() as VideoAssetRecord;
    return withAssetId(asset);
  },
  async compareAndSetOrchestration(input) {
    return (await CreativeAsset.findOneAndUpdate(
      {
        _id: input.assetId,
        workspaceId: input.workspaceId,
        "generation.submission.attemptToken": input.attemptToken,
        "generation.orchestration.state": { $in: input.fromStates },
      },
      {
        $set: {
          "generation.orchestration.state": input.toState,
          "generation.orchestration.startedAt": input.startedAt,
          updatedAt: new Date(),
        },
      },
      { new: true }
    ).lean()) as VideoAssetRecord | null;
  },
  async findNsfwProviderRequestAlias(input) {
    return (await CreativeAsset.findOne({
      ...buildVideoGenerationNsfwAliasFilter(input),
      status: "nsfw",
    }).lean()) as VideoAssetRecord | null;
  },
  findNsfwSafetyVerdict: input => findVideoGenerationNsfwVerdict(input),
  async markAssetNsfwFromAlias(input) {
    const result = await CreativeAsset.updateOne(
      {
        _id: input.assetId,
        workspaceId: input.workspaceId,
        status: { $in: ["queued", "in_progress", "complete", "failed"] },
        "generation.contractVersion": 1,
      },
      buildVideoGenerationNsfwUpdatePipeline({
        providerRequestId: input.providerRequestId,
        receivedAt: input.now,
      })
    );
    return result.matchedCount === 1;
  },
  async mergeAssetSafetyLineage(input) {
    const generation = input.asset.generation;
    if (!generation || generation.contractVersion !== 1) return null;
    const providerPath = "$generation.safetyProviderRequestIds";
    const ancestorPath = "$generation.safetyAncestors";
    const existingProviderIds = {
      $cond: [{ $isArray: providerPath }, providerPath, []],
    };
    const existingAncestors = {
      $cond: [{ $isArray: ancestorPath }, ancestorPath, []],
    };
    const mergedProviderIds = {
      $setUnion: [existingProviderIds, { $literal: input.providerRequestIds }],
    };
    const mergedAncestors = {
      $setUnion: [existingAncestors, { $literal: input.ancestors }],
    };
    return (await CreativeAsset.findOneAndUpdate(
      {
        _id: input.asset._id,
        workspaceId: input.workspaceId,
        "generation.contractVersion": 1,
        "generation.requestIdempotencyKey": generation.requestIdempotencyKey,
        "generation.recipeFingerprint": generation.recipeFingerprint,
        $expr: {
          $and: [
            {
              $lte: [
                { $size: mergedProviderIds },
                MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_IDS,
              ],
            },
            {
              $lte: [
                { $size: mergedAncestors },
                MAX_VIDEO_GENERATION_SAFETY_ANCESTORS,
              ],
            },
          ],
        },
      },
      [
        {
          $set: {
            "generation.safetyProviderRequestIds": mergedProviderIds,
            "generation.safetyAncestors": mergedAncestors,
          },
        },
      ],
      { new: true }
    ).lean()) as VideoAssetRecord | null;
  },
  async withPlatformQuotaAdmission(input, run) {
    try {
      return await withWorkspacePlatformCreativeGenerationQuotaAdmission(
        input,
        run
      );
    } catch (error) {
      if (error instanceof CreativeGenerationAdmissionBusyError) {
        throw new VideoGenerationQueueError(
          503,
          "generation_admission_busy",
          "Creative generation is busy. Retry with the same Idempotency-Key."
        );
      }
      throw error;
    }
  },
  getGoogleGenerationLimit: getGoogleFreeGenerationLimit,
  isGoogleGenerationConfigured: isGoogleCreativeGenerationConfigured,
  startWorkflow: startVideoGenerationWorkflow,
  newAssetId: () => String(new Types.ObjectId()),
  newAttemptToken: () => randomUUID(),
  now: () => new Date(),
};

function withAssetId<T extends VideoAssetRecord>(asset: T): T & { id: string } {
  if (typeof asset.id === "string" && asset.id) {
    return asset as T & { id: string };
  }
  return Object.assign(asset, { id: String(asset._id) });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function invalidRecipe(message: string): never {
  throw new VideoGenerationQueueError(400, "invalid_video_recipe", message);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function validateCommonInput(input: {
  workspaceId: string;
  idempotencyKey: string;
}): void {
  if (!input.workspaceId.trim()) {
    throw new VideoGenerationQueueError(
      400,
      "invalid_workspace_id",
      "Workspace id is required"
    );
  }
  if (!isUuid(input.idempotencyKey)) {
    throw new VideoGenerationQueueError(
      400,
      "invalid_idempotency_key",
      "Idempotency-Key must be an RFC-4122 UUID"
    );
  }
}

function canonicalizeAcceptedPrompt(value: unknown): string {
  if (typeof value !== "string") invalidRecipe("Prompt is required");
  const canonical = value.replace(/\r\n?/g, "\n");
  if (canonical.normalize("NFC").trim().length < 3) {
    invalidRecipe("Prompt must contain at least 3 characters");
  }
  if (canonical.length > 5_000) {
    invalidRecipe("Prompt may contain at most 5000 characters");
  }
  return canonical;
}

function noSource(value: unknown): boolean {
  return value === undefined || value === null;
}

function noReferences(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (Array.isArray(value) && value.length === 0)
  );
}

function requireSourceId(value: unknown): string {
  if (typeof value !== "string" || !Types.ObjectId.isValid(value)) {
    invalidRecipe("A valid completed source image asset is required");
  }
  return value;
}

function optionalHappyHorseDuration(
  value: unknown,
  fallback: number = 5
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    invalidRecipe("HappyHorse duration must be an integer from 3 to 15");
  }
  const duration = normalizeHappyHorseDuration(value);
  if (duration === null) {
    invalidRecipe("HappyHorse duration must be an integer from 3 to 15");
  }
  return duration;
}

function optionalHappyHorseResolution(
  value: unknown,
  fallback = getHappyHorseDefaultResolution()
) {
  if (value === undefined) return fallback;
  const resolution = normalizeHappyHorseResolution(value);
  if (!resolution) invalidRecipe("Unsupported HappyHorse resolution");
  return resolution;
}

function optionalHappyHorseRatio(
  value: unknown,
  fallback = getHappyHorseDefaultRatio()
) {
  if (value === undefined) return fallback;
  const ratio = normalizeHappyHorseRatio(value);
  if (!ratio) invalidRecipe("Unsupported HappyHorse aspect ratio");
  return ratio;
}

function validateSeed(seed: unknown): void {
  if (seed !== undefined && seed !== null) {
    invalidRecipe("Caller-supplied seeds are not supported");
  }
}

function buildHappyHorseSpec(
  request: VideoGenerationRouteRequest,
  userPrompt: string,
  frozenSpec?: VideoGenerationSpec
): VideoGenerationSpec {
  validateSeed(request.seed);
  const mode = request.mode as HappyHorseMode;
  if (
    mode !== "text_to_video" &&
    mode !== "image_to_video" &&
    mode !== "reference_to_video"
  ) {
    invalidRecipe("Unsupported HappyHorse video mode");
  }
  const frozen =
    frozenSpec?.provider === "happyhorse" && frozenSpec.mode === mode
      ? frozenSpec
      : null;
  const durationSeconds = optionalHappyHorseDuration(
    request.durationSeconds,
    frozen?.durationSeconds ?? 5
  );
  const resolution = optionalHappyHorseResolution(
    request.resolution,
    frozen?.resolution ?? getHappyHorseDefaultResolution()
  );

  if (mode === "text_to_video") {
    if (
      (request.skill !== undefined && request.skill !== "video") ||
      !noSource(request.sourceAssetId) ||
      !noReferences(request.referenceAssetIds)
    ) {
      invalidRecipe("Invalid HappyHorse text-to-video recipe");
    }
    return {
      contractVersion: 1,
      provider: "happyhorse",
      mode,
      skill: "video",
      userPrompt,
      modelId: frozen?.modelId ?? getHappyHorseModelForMode(mode),
      seed: null,
      durationSeconds,
      aspectRatio: optionalHappyHorseRatio(
        request.aspectRatio,
        frozen?.aspectRatio ?? getHappyHorseDefaultRatio()
      ),
      resolution,
      sourceAssetId: null,
      referenceAssetIds: [],
    };
  }

  if (mode === "image_to_video") {
    if (
      (request.skill !== undefined && request.skill !== "video") ||
      (request.aspectRatio !== undefined && request.aspectRatio !== null) ||
      !noReferences(request.referenceAssetIds)
    ) {
      invalidRecipe("Invalid HappyHorse image-to-video recipe");
    }
    return {
      contractVersion: 1,
      provider: "happyhorse",
      mode,
      skill: "video",
      userPrompt,
      modelId: frozen?.modelId ?? getHappyHorseModelForMode(mode),
      seed: null,
      durationSeconds,
      aspectRatio: null,
      resolution,
      sourceAssetId: requireSourceId(request.sourceAssetId),
      referenceAssetIds: [],
    };
  }

  if (
    (request.skill !== undefined && request.skill !== "character") ||
    !noSource(request.sourceAssetId) ||
    !Array.isArray(request.referenceAssetIds) ||
    request.referenceAssetIds.length < 1 ||
    request.referenceAssetIds.length > 9
  ) {
    invalidRecipe("Invalid HappyHorse reference-to-video recipe");
  }
  const referenceAssetIds = request.referenceAssetIds;
  if (
    referenceAssetIds.some(
      id => typeof id !== "string" || !Types.ObjectId.isValid(id)
    ) ||
    new Set(referenceAssetIds).size !== referenceAssetIds.length
  ) {
    invalidRecipe("Reference image asset ids must be valid and unique");
  }
  return {
    contractVersion: 1,
    provider: "happyhorse",
    mode,
    skill: "character",
    userPrompt,
    modelId: frozen?.modelId ?? getHappyHorseModelForMode(mode),
    seed: null,
    durationSeconds,
    aspectRatio: optionalHappyHorseRatio(
      request.aspectRatio,
      frozen?.aspectRatio ?? getHappyHorseDefaultRatio()
    ),
    resolution,
    sourceAssetId: null,
    referenceAssetIds: referenceAssetIds as [string, ...string[]],
  };
}

function integerInRange(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  label: string
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    invalidRecipe(label);
  }
  return value;
}

function buildHiggsfieldSpec(
  policy: Extract<VideoProviderPolicy, { provider: "higgsfield" }>,
  request: VideoGenerationRouteRequest,
  userPrompt: string,
  frozenSpec?: VideoGenerationSpec
): VideoGenerationSpec {
  validateSeed(request.seed);
  if (!policy.providerSourceId.trim()) {
    invalidRecipe("Higgsfield provider source is required");
  }
  if (
    request.mode !== "image_to_video" ||
    (request.skill !== undefined && request.skill !== "video") ||
    (request.aspectRatio !== undefined && request.aspectRatio !== null) ||
    (request.resolution !== undefined &&
      request.resolution !== "provider_default") ||
    !noReferences(request.referenceAssetIds)
  ) {
    invalidRecipe("Invalid Higgsfield image-to-video recipe");
  }
  const frozen = frozenSpec?.provider === "higgsfield" ? frozenSpec : null;
  return {
    contractVersion: 1,
    provider: "higgsfield",
    mode: "image_to_video",
    skill: "video",
    userPrompt,
    modelId: frozen?.modelId ?? getHiggsfieldImageToVideoModel(),
    seed: null,
    durationSeconds: integerInRange(
      request.durationSeconds,
      frozen?.durationSeconds ?? 5,
      3,
      8,
      "Higgsfield duration must be an integer from 3 to 8"
    ),
    aspectRatio: null,
    resolution: "provider_default",
    sourceAssetId: requireSourceId(request.sourceAssetId),
    referenceAssetIds: [],
  };
}

function buildGoogleSpec(
  request: VideoGenerationRouteRequest,
  userPrompt: string,
  frozenSpec?: VideoGenerationSpec
): VideoGenerationSpec {
  validateSeed(request.seed);
  const frozen = frozenSpec?.provider === "google" ? frozenSpec : null;
  const duration = request.durationSeconds ?? frozen?.durationSeconds ?? 6;
  const aspectRatio = request.aspectRatio ?? frozen?.aspectRatio ?? "9:16";
  const resolution = request.resolution ?? frozen?.resolution ?? "720p";
  if (
    request.mode !== "image_to_video" ||
    (request.skill !== undefined && request.skill !== "video") ||
    (duration !== 4 && duration !== 6 && duration !== 8) ||
    (aspectRatio !== "9:16" && aspectRatio !== "16:9") ||
    resolution !== "720p" ||
    !noReferences(request.referenceAssetIds)
  ) {
    invalidRecipe("Invalid Google image-to-video recipe");
  }
  return {
    contractVersion: 1,
    provider: "google",
    mode: "image_to_video",
    skill: "video",
    userPrompt,
    modelId: frozen?.modelId ?? getGoogleVideoGenerationModel(),
    seed: null,
    durationSeconds: duration,
    aspectRatio,
    resolution: "720p",
    sourceAssetId: requireSourceId(request.sourceAssetId),
    referenceAssetIds: [],
  };
}

function buildSpec(
  input: QueueVideoGenerationInput,
  frozenSpec?: VideoGenerationSpec
): VideoGenerationSpec {
  const userPrompt = canonicalizeAcceptedPrompt(input.request.prompt);
  if (input.providerPolicy.provider === "happyhorse") {
    return buildHappyHorseSpec(input.request, userPrompt, frozenSpec);
  }
  if (input.providerPolicy.provider === "higgsfield") {
    return buildHiggsfieldSpec(
      input.providerPolicy,
      input.request,
      userPrompt,
      frozenSpec
    );
  }
  if (input.providerPolicy.provider === "google") {
    return buildGoogleSpec(input.request, userPrompt, frozenSpec);
  }
  return invalidRecipe("Unsupported video provider");
}

function providerSourceId(policy: VideoProviderPolicy): string | null {
  return policy.provider === "higgsfield" || policy.provider === "google"
    ? policy.providerSourceId?.trim() || null
    : null;
}

async function validateSourceAssets(
  spec: VideoGenerationSpec,
  workspaceId: string,
  dependencies: QueueVideoGenerationDependencies
): Promise<void> {
  const requestedIds = [
    ...(spec.sourceAssetId ? [spec.sourceAssetId] : []),
    ...spec.referenceAssetIds,
  ];
  if (requestedIds.length === 0) return;

  if (new Set(requestedIds).size !== requestedIds.length) {
    invalidRecipe("Source image asset ids must be unique");
  }

  const assets = await dependencies.findSources({
    _id: { $in: requestedIds },
    workspaceId,
    kind: "image",
    status: "complete",
  });
  const assetsById = new Map(assets.map(asset => [String(asset._id), asset]));
  const orderedAssets = requestedIds.map(id => assetsById.get(id));
  const invalid = orderedAssets.some(
    asset =>
      !asset ||
      asset.workspaceId !== workspaceId ||
      asset.kind !== "image" ||
      asset.status !== "complete"
  );
  if (invalid) {
    throw new VideoGenerationQueueError(
      400,
      "invalid_source_asset",
      "Every source must be a completed image in this workspace"
    );
  }
}

function compileSpec(spec: VideoGenerationSpec): CompiledVideoPrompt {
  try {
    return compileVideoPrompt(spec);
  } catch (error) {
    if (error instanceof VideoPromptCompileError) {
      throw new VideoGenerationQueueError(
        400,
        "prompt_too_long_for_provider",
        error.message,
        error.maxUserPromptLength
      );
    }
    throw error;
  }
}

export function buildVideoRecipeFingerprint(input: {
  spec: VideoGenerationSpec;
  providerSourceId: string | null;
  retryOfAssetId?: string | null;
}): string {
  const canonical = {
    contractVersion: VIDEO_GENERATION_WORKFLOW_CONTRACT_VERSION,
    spec: input.spec,
    providerSourceId: input.providerSourceId,
    retryOfAssetId: input.retryOfAssetId ?? null,
  };
  return createHash("sha256")
    .update(stableJsonSerialize(canonical))
    .digest("hex");
}

function stableJsonSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "null" : serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => stableJsonSerialize(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .filter(key => record[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${stableJsonSerialize(record[key])}`);
  return `{${entries.join(",")}}`;
}

function buildGeneration(input: {
  spec: VideoGenerationSpec;
  prompt: CompiledVideoPrompt;
  idempotencyKey: string;
  retryOfAssetId: string | null;
  recipeFingerprint: string;
  assetId: string;
  attemptToken: string;
  safetyProviderRequestIds?: string[];
  safetyAncestors?: VideoGenerationSafetyAncestor[];
  completionTarget: VideoGenerationCompletionTarget | null;
}): CreativeAssetVideoGeneration {
  return {
    contractVersion: 1,
    spec: input.spec,
    prompt: input.prompt,
    requestIdempotencyKey: input.idempotencyKey,
    retryOfAssetId: input.retryOfAssetId,
    ...(input.safetyProviderRequestIds?.length
      ? { safetyProviderRequestIds: [...input.safetyProviderRequestIds] }
      : {}),
    ...(input.safetyAncestors?.length
      ? {
          safetyAncestors: input.safetyAncestors.map(ancestor => ({
            ...ancestor,
          })),
        }
      : {}),
    recoveryMode: null,
    recoverySource: null,
    recipeFingerprint: input.recipeFingerprint,
    orchestration: {
      workflowId: buildVideoGenerationWorkflowId({ assetId: input.assetId }),
      state: "pending",
      startedAt: null,
      completionTarget: input.completionTarget,
    },
    submission: {
      state: "pending",
      attemptToken: input.attemptToken,
      providerRequestId: null,
      submittedAt: null,
    },
    result: null,
    failure: null,
  };
}

function buildAssetCreate(input: {
  assetId: string;
  workspaceId: string;
  createdBy: string | null;
  spec: VideoGenerationSpec;
  providerSourceId: string | null;
  providerRequestLocator?: string | null;
  generation: CreativeAssetVideoGeneration;
}): Record<string, unknown> {
  return {
    _id: input.assetId,
    workspaceId: input.workspaceId,
    kind: "video",
    source: input.spec.provider,
    provider: input.spec.provider,
    status: "queued",
    prompt: input.spec.userPrompt,
    modelId: input.spec.modelId,
    sourceAssetId: input.spec.sourceAssetId,
    providerSourceId: input.providerSourceId,
    providerRequestId: input.generation.submission.providerRequestId,
    providerStatusUrl: input.providerRequestLocator ?? null,
    providerCancelUrl: null,
    providerPayload: null,
    generation: input.generation,
    error: null,
    createdBy: input.createdBy,
    updatedBy: input.createdBy,
    completedAt: null,
  };
}

async function createIdempotently(input: {
  asset: Record<string, unknown>;
  workspaceId: string;
  idempotencyKey: string;
  recipeFingerprint: string;
  completionTarget: VideoGenerationCompletionTarget | null;
  dependencies: QueueVideoGenerationDependencies;
}): Promise<VideoAssetRecord> {
  try {
    return withAssetId(await input.dependencies.createAsset(input.asset));
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) throw error;
    const winner = await findIdempotentWinner(input);
    if (!winner) throw error;
    return withAssetId(winner);
  }
}

async function findIdempotentWinner(input: {
  workspaceId: string;
  idempotencyKey: string;
  recipeFingerprint: string;
  completionTarget?: VideoGenerationCompletionTarget | null;
  dependencies: QueueVideoGenerationDependencies;
}): Promise<VideoAssetRecord | null> {
  const winner = await input.dependencies.findAsset({
    workspaceId: input.workspaceId,
    "generation.requestIdempotencyKey": input.idempotencyKey,
  });
  if (!winner) return null;
  return validateIdempotentWinner(winner, input);
}

function validateIdempotentWinner(
  winner: VideoAssetRecord,
  input: {
    idempotencyKey: string;
    recipeFingerprint: string;
    completionTarget?: VideoGenerationCompletionTarget | null;
  }
): VideoAssetRecord | null {
  if (winner.generation?.requestIdempotencyKey !== input.idempotencyKey) {
    return null;
  }
  if (winner.generation?.recipeFingerprint !== input.recipeFingerprint) {
    throw new VideoGenerationQueueError(
      409,
      "idempotency_key_conflict",
      "Idempotency-Key was already used for another video recipe"
    );
  }
  if (
    !hasSameCompletionTarget(
      winner.generation?.orchestration.completionTarget,
      input.completionTarget ?? null
    )
  ) {
    throw new VideoGenerationQueueError(
      409,
      "idempotency_key_conflict",
      "Idempotency-Key was already used for another video completion target"
    );
  }
  return withAssetId(winner);
}

function hasSameCompletionTarget(
  left: VideoGenerationCompletionTarget | null | undefined,
  right: VideoGenerationCompletionTarget | null
): boolean {
  if (left === null || left === undefined) return right === null;
  return (
    left.workflowId === right?.workflowId &&
    left.signalName === right?.signalName &&
    left.correlationId === right?.correlationId
  );
}

function buildWorkflowInput(
  asset: VideoAssetRecord
): VideoGenerationWorkflowInput {
  const generation = asset.generation;
  if (!generation || generation.contractVersion !== 1) {
    throw new VideoGenerationQueueError(
      409,
      "asset_not_retryable",
      "Asset does not contain a contract-v1 video recipe"
    );
  }
  const resume = resolveVideoGenerationProviderResultResume(asset);
  const completionTarget = normalizeVideoGenerationCompletionTarget(
    generation.orchestration.completionTarget
  );
  return {
    contractVersion: VIDEO_GENERATION_WORKFLOW_CONTRACT_VERSION,
    workspaceId: asset.workspaceId,
    assetId: String(asset._id),
    attemptToken: generation.submission.attemptToken,
    spec: generation.spec,
    prompt: generation.prompt,
    providerSourceId: asset.providerSourceId || null,
    mediaTaskQueue: CREATIVE_ASSET_EDIT_TASK_QUEUE,
    ...(completionTarget ? { completionTarget } : {}),
    ...(resume ? { resume } : {}),
  };
}

function applyOrchestrationState(
  asset: VideoAssetRecord,
  state: "started" | "unknown",
  startedAt: Date | null
): VideoAssetRecord {
  if (!asset.generation) return asset;
  return withAssetId({
    ...asset,
    generation: {
      ...asset.generation,
      orchestration: {
        ...asset.generation.orchestration,
        state,
        startedAt,
      },
    },
  });
}

export async function ensureVideoGenerationWorkflowStarted(
  asset: VideoAssetRecord,
  dependencies: QueueVideoGenerationDependencies = defaultDependencies
): Promise<VideoAssetRecord> {
  const generation = asset.generation;
  if (!generation || generation.contractVersion !== 1) {
    throw new VideoGenerationQueueError(
      409,
      "asset_not_retryable",
      "Asset does not contain a contract-v1 video recipe"
    );
  }
  if (
    generation.orchestration.state === "started" ||
    asset.status === "complete" ||
    asset.status === "failed" ||
    asset.status === "nsfw"
  ) {
    return withAssetId(asset);
  }
  const assetId = String(asset._id);
  try {
    await dependencies.startWorkflow(buildWorkflowInput(asset));
  } catch (error) {
    if (
      !(error instanceof VideoGenerationWorkflowStartAmbiguousError) &&
      !(error instanceof VideoGenerationWorkflowNotRunningError)
    ) {
      throw error;
    }
    const updated = await dependencies.compareAndSetOrchestration({
      assetId,
      workspaceId: asset.workspaceId,
      attemptToken: generation.submission.attemptToken,
      fromStates: ["pending"],
      toState: "unknown",
      startedAt: null,
    });
    return updated
      ? withAssetId(updated)
      : applyOrchestrationState(asset, "unknown", null);
  }

  const startedAt = dependencies.now();
  const updated = await dependencies.compareAndSetOrchestration({
    assetId,
    workspaceId: asset.workspaceId,
    attemptToken: generation.submission.attemptToken,
    fromStates: ["pending", "unknown"],
    toState: "started",
    startedAt,
  });
  return updated
    ? withAssetId(updated)
    : applyOrchestrationState(asset, "started", startedAt);
}

export async function acceptVideoGeneration(
  input: QueueVideoGenerationInput,
  dependencies: VideoGenerationQueueDependencies = defaultDependencies
): Promise<{
  asset: VideoAssetRecord;
  workflowInput: VideoGenerationWorkflowInput;
}> {
  validateCommonInput(input);
  let completionTarget: VideoGenerationCompletionTarget | null;
  try {
    completionTarget = normalizeVideoGenerationCompletionTarget(
      input.completionTarget
    );
  } catch (error) {
    throw new VideoGenerationQueueError(
      400,
      "invalid_completion_target",
      error instanceof Error ? error.message : "Invalid video completion target"
    );
  }
  await dependencies.ensureIndexes();
  const acceptedReplayCandidate = await dependencies.findAsset({
    workspaceId: input.workspaceId,
    "generation.requestIdempotencyKey": input.idempotencyKey,
  });
  const frozenReplaySpec =
    acceptedReplayCandidate?.generation?.contractVersion === 1
      ? acceptedReplayCandidate.generation.spec
      : undefined;
  const spec = buildSpec(input, frozenReplaySpec);
  const resolvedProviderSourceId = acceptedReplayCandidate
    ? typeof acceptedReplayCandidate.providerSourceId === "string"
      ? acceptedReplayCandidate.providerSourceId
      : null
    : providerSourceId(input.providerPolicy);
  const recipeFingerprint = buildVideoRecipeFingerprint({
    spec,
    providerSourceId: resolvedProviderSourceId,
    retryOfAssetId: null,
  });
  const existing = acceptedReplayCandidate
    ? validateIdempotentWinner(acceptedReplayCandidate, {
        idempotencyKey: input.idempotencyKey,
        recipeFingerprint,
        completionTarget,
      })
    : null;
  if (existing) {
    return {
      asset: existing,
      workflowInput: buildWorkflowInput(existing),
    };
  }

  await validateSourceAssets(spec, input.workspaceId, dependencies);
  const prompt = compileSpec(spec);
  const proposedAssetId = dependencies.newAssetId();
  const attemptToken = dependencies.newAttemptToken();
  const createAsset = (assetId: string = proposedAssetId) => {
    const generation = buildGeneration({
      spec,
      prompt,
      idempotencyKey: input.idempotencyKey,
      retryOfAssetId: null,
      recipeFingerprint,
      assetId,
      attemptToken,
      completionTarget,
    });
    return createIdempotently({
      asset: buildAssetCreate({
        assetId,
        workspaceId: input.workspaceId,
        createdBy: input.createdBy,
        spec,
        providerSourceId: resolvedProviderSourceId,
        generation,
      }),
      workspaceId: input.workspaceId,
      idempotencyKey: input.idempotencyKey,
      recipeFingerprint,
      completionTarget,
      dependencies,
    });
  };

  await dependencies.validateCustomerCredentials({
    workspaceId: input.workspaceId,
    provider: spec.provider,
    providerSourceId: resolvedProviderSourceId,
  });
  const asset = await createAsset();

  return {
    asset,
    workflowInput: buildWorkflowInput(asset),
  };
}

export async function queueVideoGeneration(
  input: QueueVideoGenerationInput,
  dependencies: VideoGenerationQueueDependencies = defaultDependencies
): Promise<{ asset: VideoAssetRecord }> {
  const { asset } = await acceptVideoGeneration(input, dependencies);
  return {
    asset: await ensureVideoGenerationWorkflowStarted(asset, dependencies),
  };
}

function assertRetryableParent(
  parent: VideoAssetRecord,
  acknowledgePossibleDuplicateCharge: boolean,
  availability: VideoGenerationRetryAvailability
): asserts parent is VideoAssetRecord & {
  generation: CreativeAssetVideoGeneration;
} {
  if (parent.status === "nsfw") {
    throw new VideoGenerationQueueError(
      409,
      "nsfw_not_retryable",
      "NSFW video generations cannot be retried"
    );
  }
  if (
    parent.status !== "failed" ||
    parent.generation?.contractVersion !== 1 ||
    !parent.generation.failure
  ) {
    throw new VideoGenerationQueueError(
      409,
      "asset_not_retryable",
      "Only failed contract-v1 video generations can be retried"
    );
  }
  if (!availability.canRetry) {
    throw new VideoGenerationQueueError(
      409,
      "asset_not_retryable",
      "This video generation failure is permanent"
    );
  }
  if (
    availability.requiresDuplicateChargeAcknowledgement &&
    !acknowledgePossibleDuplicateCharge
  ) {
    throw new VideoGenerationQueueError(
      409,
      "duplicate_charge_acknowledgement_required",
      "The original provider job may still complete and incur a charge"
    );
  }
}

function nsfwAliasError(): VideoGenerationQueueError {
  return new VideoGenerationQueueError(
    409,
    "nsfw_not_retryable",
    "A generation for this provider request was marked NSFW"
  );
}

function resolveSafetyProviderRequestIds(
  parent: VideoAssetRecord,
  currentProviderRequestId: string | null
): string[] {
  const inherited = parent.generation?.safetyProviderRequestIds;
  if (inherited !== undefined && !Array.isArray(inherited)) {
    throw new VideoGenerationQueueError(
      409,
      "video_safety_lineage_invalid",
      "The video generation safety lineage is invalid"
    );
  }

  const lineage = new Set<string>();
  for (const rawRequestId of [
    ...(inherited ?? []),
    ...(currentProviderRequestId ? [currentProviderRequestId] : []),
  ]) {
    const requestId =
      typeof rawRequestId === "string" ? rawRequestId.trim() : "";
    if (
      !requestId ||
      requestId.length > MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_ID_LENGTH
    ) {
      throw new VideoGenerationQueueError(
        409,
        "video_safety_lineage_invalid",
        "The video generation safety lineage is invalid"
      );
    }
    lineage.add(requestId);
    if (lineage.size > MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_IDS) {
      throw new VideoGenerationQueueError(
        409,
        "video_safety_lineage_limit_exceeded",
        "This video retry chain has reached its safety lineage limit"
      );
    }
  }
  return [...lineage];
}

function resolveCurrentSafetyProviderRequestId(
  parent: VideoAssetRecord
): string | null {
  const nested = parent.generation?.submission.providerRequestId;
  const topLevel = parent.providerRequestId;
  return typeof nested === "string" &&
    nested.length > 0 &&
    nested.length <= MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_ID_LENGTH &&
    nested === topLevel
    ? nested
    : null;
}

function resolveSafetyAncestors(
  parent: VideoAssetRecord
): VideoGenerationSafetyAncestor[] {
  const inherited = parent.generation?.safetyAncestors;
  if (inherited !== undefined && !Array.isArray(inherited)) {
    throw new VideoGenerationQueueError(
      409,
      "video_safety_lineage_invalid",
      "The video generation safety lineage is invalid"
    );
  }
  const current = {
    assetId: String(parent._id).trim(),
    attemptToken: String(
      parent.generation?.submission.attemptToken ?? ""
    ).trim(),
  };
  const lineage = new Map<string, VideoGenerationSafetyAncestor>();
  for (const rawAncestor of [...(inherited ?? []), current]) {
    const assetId =
      rawAncestor && typeof rawAncestor.assetId === "string"
        ? rawAncestor.assetId.trim()
        : "";
    const attemptToken =
      rawAncestor && typeof rawAncestor.attemptToken === "string"
        ? rawAncestor.attemptToken.trim()
        : "";
    if (
      !assetId ||
      !attemptToken ||
      assetId.length > MAX_VIDEO_GENERATION_SAFETY_ANCESTOR_ID_LENGTH ||
      attemptToken.length > MAX_VIDEO_GENERATION_SAFETY_ANCESTOR_ID_LENGTH
    ) {
      throw new VideoGenerationQueueError(
        409,
        "video_safety_lineage_invalid",
        "The video generation safety lineage is invalid"
      );
    }
    lineage.set(`${assetId}\u0000${attemptToken}`, {
      assetId,
      attemptToken,
    });
    if (lineage.size > MAX_VIDEO_GENERATION_SAFETY_ANCESTORS) {
      throw new VideoGenerationQueueError(
        409,
        "video_safety_lineage_limit_exceeded",
        "This video retry chain has reached its safety lineage limit"
      );
    }
  }
  return [...lineage.values()];
}

function hasStagedGcsResult(asset: VideoAssetRecord): boolean {
  return (
    asset.storageProvider === "gcs" &&
    typeof asset.bucket === "string" &&
    asset.bucket.trim().length > 0 &&
    typeof asset.path === "string" &&
    asset.path.trim().length > 0
  );
}

function resolveRecoverySource(
  parent: VideoAssetRecord,
  providerRequestId: string
): VideoRecoverySource {
  const generation = parent.generation!;
  const immediateParent: VideoRecoverySource = {
    assetId: String(parent._id),
    attemptToken: generation.submission.attemptToken,
    providerRequestId,
    recipeFingerprint: generation.recipeFingerprint,
    provider: generation.spec.provider,
  };
  const inherited = generation.recoverySource;

  if (
    hasStagedGcsResult(parent) ||
    !inherited ||
    inherited.provider !== generation.spec.provider ||
    inherited.providerRequestId !== providerRequestId ||
    !inherited.assetId ||
    !inherited.attemptToken ||
    !/^[a-f0-9]{64}$/.test(inherited.recipeFingerprint)
  ) {
    return immediateParent;
  }

  // A recovery attempt that failed before staging its own object must keep
  // pointing at the durable ancestor. Once it stages a GCS object, the child
  // itself becomes the next recovery source.
  return clone(inherited);
}

async function findNsfwAlias(
  input: { workspaceId: string; providerRequestId: string },
  dependencies: QueueVideoGenerationDependencies
): Promise<boolean> {
  return Boolean(await dependencies.findNsfwProviderRequestAlias(input));
}

async function findNsfwSafetyAlias(
  input: {
    workspaceId: string;
    providerRequestIds: string[];
    ancestors: VideoGenerationSafetyAncestor[];
  },
  dependencies: QueueVideoGenerationDependencies
): Promise<string | null> {
  const verdict = await dependencies.findNsfwSafetyVerdict(input);
  if (verdict) return verdict.providerRequestId;
  for (const providerRequestId of input.providerRequestIds) {
    if (
      await findNsfwAlias(
        { workspaceId: input.workspaceId, providerRequestId },
        dependencies
      )
    ) {
      return providerRequestId;
    }
  }
  return null;
}

async function quarantineChildAfterNsfwRace(
  input: {
    child: VideoAssetRecord;
    workspaceId: string;
    providerRequestIds: string[];
    ancestors: VideoGenerationSafetyAncestor[];
  },
  dependencies: QueueVideoGenerationDependencies
): Promise<void> {
  const providerRequestId = await findNsfwSafetyAlias(input, dependencies);
  if (!providerRequestId) return;
  await dependencies.markAssetNsfwFromAlias({
    assetId: String(input.child._id),
    workspaceId: input.workspaceId,
    providerRequestId,
    now: dependencies.now(),
  });
  throw nsfwAliasError();
}

export async function retryVideoGeneration(
  input: RetryVideoGenerationInput,
  dependencies: QueueVideoGenerationDependencies = defaultDependencies
): Promise<{ asset: VideoAssetRecord }> {
  validateCommonInput(input);
  if (!Types.ObjectId.isValid(input.assetId)) {
    throw new VideoGenerationQueueError(
      400,
      "invalid_asset_id",
      "Asset id is invalid"
    );
  }
  await dependencies.ensureIndexes();
  const parent = await dependencies.findAsset({
    _id: input.assetId,
    workspaceId: input.workspaceId,
  });
  if (!parent) {
    throw new VideoGenerationQueueError(
      404,
      "asset_not_found",
      "Asset not found"
    );
  }
  const retryAvailability = resolveVideoGenerationRetryAvailability(parent);
  assertRetryableParent(
    parent,
    input.acknowledgePossibleDuplicateCharge === true,
    retryAvailability
  );
  const recoveryResume = retryAvailability.providerResultResume;
  const currentSafetyProviderRequestId =
    resolveCurrentSafetyProviderRequestId(parent);
  const safetyProviderRequestIds = resolveSafetyProviderRequestIds(
    parent,
    currentSafetyProviderRequestId
  );
  const safetyAncestors = resolveSafetyAncestors(parent);
  const enforcesHiggsfieldNsfwLineage =
    parent.generation.spec.provider === "higgsfield";
  if (
    enforcesHiggsfieldNsfwLineage &&
    (await findNsfwSafetyAlias(
      {
        workspaceId: input.workspaceId,
        providerRequestIds: safetyProviderRequestIds,
        ancestors: safetyAncestors,
      },
      dependencies
    ))
  ) {
    throw nsfwAliasError();
  }

  const spec = clone(parent.generation.spec);
  const prompt = clone(parent.generation.prompt);
  const resolvedProviderSourceId = parent.providerSourceId || null;
  const recipeFingerprint = buildVideoRecipeFingerprint({
    spec,
    providerSourceId: resolvedProviderSourceId,
    retryOfAssetId: String(parent._id),
  });
  let existing = await findIdempotentWinner({
    workspaceId: input.workspaceId,
    idempotencyKey: input.idempotencyKey,
    recipeFingerprint,
    dependencies,
  });
  if (existing) {
    existing = await dependencies.mergeAssetSafetyLineage({
      asset: existing,
      workspaceId: input.workspaceId,
      providerRequestIds: safetyProviderRequestIds,
      ancestors: safetyAncestors,
    });
    if (!existing) {
      throw new VideoGenerationQueueError(
        409,
        "video_safety_lineage_limit_exceeded",
        "This video retry chain has reached its safety lineage limit"
      );
    }
    if (enforcesHiggsfieldNsfwLineage) {
      await quarantineChildAfterNsfwRace(
        {
          child: existing,
          workspaceId: input.workspaceId,
          providerRequestIds: safetyProviderRequestIds,
          ancestors: safetyAncestors,
        },
        dependencies
      );
    }
    return {
      asset: await ensureVideoGenerationWorkflowStarted(existing, dependencies),
    };
  }

  const proposedChildAssetId = dependencies.newAssetId();
  const createChild = async (
    assetId: string = proposedChildAssetId
  ): Promise<VideoAssetRecord> => {
    const attemptToken = dependencies.newAttemptToken();
    const generation = buildGeneration({
      spec,
      prompt,
      idempotencyKey: input.idempotencyKey,
      retryOfAssetId: String(parent._id),
      recipeFingerprint,
      assetId,
      attemptToken,
      completionTarget: null,
      safetyProviderRequestIds,
      safetyAncestors,
    });
    if (recoveryResume) {
      generation.recoveryMode = "provider_result";
      generation.recoverySource = resolveRecoverySource(
        parent,
        recoveryResume.providerRequestId
      );
      generation.submission = {
        state: "submitted",
        attemptToken,
        providerRequestId: recoveryResume.providerRequestId,
        submittedAt: parent.generation.submission.submittedAt,
      };
    }
    const child = await createIdempotently({
      asset: buildAssetCreate({
        assetId,
        workspaceId: input.workspaceId,
        createdBy: input.createdBy,
        spec,
        providerSourceId: resolvedProviderSourceId,
        providerRequestLocator: recoveryResume?.providerRequestLocator ?? null,
        generation,
      }),
      workspaceId: input.workspaceId,
      idempotencyKey: input.idempotencyKey,
      recipeFingerprint,
      completionTarget: null,
      dependencies,
    });

    return child;
  };

  if (!recoveryResume) {
    await dependencies.validateCustomerCredentials({
      workspaceId: input.workspaceId,
      provider: spec.provider,
      providerSourceId: resolvedProviderSourceId,
    });
  }
  let child = await createChild();

  const mergedChild = await dependencies.mergeAssetSafetyLineage({
    asset: child,
    workspaceId: input.workspaceId,
    providerRequestIds: safetyProviderRequestIds,
    ancestors: safetyAncestors,
  });
  if (!mergedChild) {
    throw new VideoGenerationQueueError(
      409,
      "video_safety_lineage_limit_exceeded",
      "This video retry chain has reached its safety lineage limit"
    );
  }
  child = mergedChild;
  if (enforcesHiggsfieldNsfwLineage) {
    await quarantineChildAfterNsfwRace(
      {
        child,
        workspaceId: input.workspaceId,
        providerRequestIds: safetyProviderRequestIds,
        ancestors: safetyAncestors,
      },
      dependencies
    );
  }

  return {
    asset: await ensureVideoGenerationWorkflowStarted(child, dependencies),
  };
}
