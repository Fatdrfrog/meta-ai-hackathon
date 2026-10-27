import type {
  VideoGenerationActivityResult,
  VideoGenerationSpec,
} from "@icecore/temporal";
import { ApplicationFailure } from "@temporalio/activity";

import {
  copyGcsCreativeAssetObject,
  deleteGcsCreativeAssetObject,
  statGcsCreativeAssetObject,
  uploadGcsCreativeAssetFile,
} from "../../gcs-creative-assets.js";
import {
  materializeVideoGenerationResult,
  type MaterializedVideoResult,
  type ProviderVideoResult,
  type VideoGenerationMaterializerDependencies,
  type VideoGenerationMaterializerInput,
} from "../../media/video-generation-materializer.js";
import { loadFinalGoogleVideoResult } from "./providers/google.js";
import {
  loadFinalHappyHorseVideoResult,
  VideoProviderError,
} from "./providers/happyhorse.js";
import { loadFinalHiggsfieldVideoResult } from "./providers/higgsfield.js";
import {
  asVideoGenerationFinalizationError,
  VIDEO_GENERATION_FINALIZATION_FAILURE_TYPE,
  VideoGenerationFinalizationError,
} from "../../video-generation-finalization-failure.js";
import { readDate } from "@icecore/shared/lib/value-utils";

export type VideoGenerationFinalizeActivityInput = {
  contractVersion: 1;
  workspaceId: string;
  assetId: string;
  attemptToken: string;
  providerRequestId: string;
  providerRequestLocator: string;
};

export function buildVideoGenerationFinalizeIdentityFilter(
  input: VideoGenerationFinalizeActivityInput,
): Record<string, unknown> {
  return {
    _id: input.assetId,
    workspaceId: input.workspaceId,
    "generation.contractVersion": input.contractVersion,
    "generation.submission.attemptToken": input.attemptToken,
    "generation.submission.providerRequestId": input.providerRequestId,
    providerStatusUrl: input.providerRequestLocator,
  };
}

type FinalizeAsset = {
  _id: unknown;
  workspaceId: string;
  status: "queued" | "in_progress" | "complete" | "failed" | "nsfw";
  providerSourceId?: string | null;
  providerRequestId?: string | null;
  providerStatusUrl?: string | null;
  generation: {
    contractVersion: 1;
    recipeFingerprint: string;
    recoverySource?: {
      assetId: string;
      attemptToken: string;
      providerRequestId: string;
      recipeFingerprint: string;
      provider: VideoGenerationSpec["provider"];
    } | null;
    spec: VideoGenerationSpec;
    orchestration: { startedAt?: Date | null };
    submission: {
      state: VideoGenerationActivityResult["submissionState"];
      attemptToken: string;
      providerRequestId: string | null;
      submittedAt?: Date | null;
    };
    result: MaterializedVideoResult | null;
  };
};

type FinalizeContext = {
  asset: FinalizeAsset;
  materializerInput: VideoGenerationMaterializerInput;
};

export type VideoGenerationFinalizeActivityDependencies = {
  loadContext: (
    input: VideoGenerationFinalizeActivityInput,
  ) => Promise<FinalizeContext>;
  createMaterializerDependencies: (
    input: VideoGenerationFinalizeActivityInput,
  ) => VideoGenerationMaterializerDependencies;
  materialize: typeof materializeVideoGenerationResult;
};

function mapUsage(value: unknown): Record<string, number | string> | null {
  if (!value) return null;
  if (value instanceof Map) return Object.fromEntries(value);
  return typeof value === "object"
    ? (value as Record<string, number | string>)
    : null;
}

function normalizeResult(
  value: MaterializedVideoResult | null | undefined,
): MaterializedVideoResult | null {
  if (!value) return null;
  const completedAt = readDate(value.completedAt);
  if (!completedAt) return null;
  return {
    ...value,
    providerUsage: mapUsage(value.providerUsage),
    startedAt: readDate(value.startedAt),
    completedAt,
  };
}

async function loadFinalizeAsset(
  input: VideoGenerationFinalizeActivityInput,
): Promise<FinalizeAsset | null> {
  const CreativeAsset = await loadCreativeAssetModel();
  return CreativeAsset.findOne(
    buildVideoGenerationFinalizeIdentityFilter(input),
  ).lean<FinalizeAsset | null>();
}

async function loadCreativeAssetModel() {
  const [{ default: connectDB }, { CreativeAsset }] = await Promise.all([
    import("@/lib/mongoose"),
    import("@/models/creative-asset"),
  ]);
  await connectDB();
  return CreativeAsset;
}

function assertProviderIdentity(
  asset: FinalizeAsset,
  input: VideoGenerationFinalizeActivityInput,
): void {
  const persistedRequestId =
    asset.generation.submission.providerRequestId || asset.providerRequestId;
  if (persistedRequestId !== input.providerRequestId) {
    throw new Error("Video finalization request identity does not match Mongo");
  }
  if (
    !asset.providerStatusUrl ||
    asset.providerStatusUrl !== input.providerRequestLocator
  ) {
    throw new Error("Video finalization locator does not match Mongo");
  }
}

async function defaultLoadContext(
  input: VideoGenerationFinalizeActivityInput,
): Promise<FinalizeContext> {
  const asset = await loadFinalizeAsset(input);
  if (!asset) throw new Error("Video generation asset was not found");
  assertProviderIdentity(asset, input);
  return {
    asset,
    materializerInput: {
      workspaceId: input.workspaceId,
      assetId: input.assetId,
      attemptToken: input.attemptToken,
      providerRequestId: input.providerRequestId,
      recipeFingerprint: asset.generation.recipeFingerprint,
      provider: asset.generation.spec.provider,
      requestedDurationSeconds: asset.generation.spec.durationSeconds,
      startedAt:
        readDate(asset.generation.submission.submittedAt) ??
        readDate(asset.generation.orchestration.startedAt),
      recoverySource: asset.generation.recoverySource ?? null,
    },
  };
}

async function loadProviderResult(
  input: VideoGenerationMaterializerInput,
  providerRequestLocator: string,
): Promise<ProviderVideoResult> {
  const expectedIdentity: VideoGenerationFinalizeActivityInput = {
    contractVersion: 1,
    workspaceId: input.workspaceId,
    assetId: input.assetId,
    attemptToken: input.attemptToken,
    providerRequestId: input.providerRequestId,
    providerRequestLocator,
  };
  const asset = await loadFinalizeAsset(expectedIdentity);
  if (!asset) throw new Error("Video generation asset was not found");
  assertProviderIdentity(asset, expectedIdentity);

  if (asset.generation.spec.provider === "happyhorse") {
    const result = await loadFinalHappyHorseVideoResult({
      providerRequestLocator,
    });
    return {
      kind: "url",
      url: result.url,
      policy: { kind: "dynamic" },
      providerUsage: result.providerUsage,
    };
  }

  if (asset.generation.spec.provider === "higgsfield") {
    const [{ supabaseAdmin }, { resolveHiggsfieldAuthKeyForWorkspace }] =
      await Promise.all([
        import("@/lib/supabase/admin"),
        import("@/lib/higgsfield/higgsfield-source"),
      ]);
    const auth = await resolveHiggsfieldAuthKeyForWorkspace({
      supabase: supabaseAdmin,
      workspaceId: input.workspaceId,
      sourceId: asset.providerSourceId ?? null,
    });
    const result = await loadFinalHiggsfieldVideoResult({
      providerRequestId: input.providerRequestId,
      authKey: auth.authKey,
    });
    return { kind: "url", url: result.url, policy: { kind: "dynamic" } };
  }

  const { resolveGoogleCreativeWorkerApiKey, getGoogleMediaHostAllowlist } =
    await import("@/lib/google/creative-assets");
  const apiKey = await resolveGoogleCreativeWorkerApiKey({
    workspaceId: input.workspaceId,
    providerSourceId: asset.providerSourceId,
    allowLegacyPlatform: true,
  });
  const google = await loadFinalGoogleVideoResult({
    providerRequestLocator,
    workspaceId: input.workspaceId,
    providerSourceId: asset.providerSourceId ?? null,
  });
  if (google.videoBytes) {
    return {
      kind: "base64",
      base64: google.videoBytes,
      mimeType: google.mimeType,
    };
  }
  if (!google.url) throw new Error("Google video result is unavailable");
  if (!apiKey) throw new Error("Google video generation is not configured");
  return {
    kind: "url",
    url: google.url,
    mimeType: google.mimeType,
    policy: {
      kind: "stable",
      hostnames: [...getGoogleMediaHostAllowlist()],
    },
    requestHeaders: { "x-goog-api-key": apiKey },
  };
}

function defaultMaterializerDependencies(
  activityInput: VideoGenerationFinalizeActivityInput,
): VideoGenerationMaterializerDependencies {
  return {
    async getAsset(identity) {
      const expectedIdentity: VideoGenerationFinalizeActivityInput = {
        contractVersion: 1,
        ...identity,
        providerRequestLocator: activityInput.providerRequestLocator,
      };
      const asset = await loadFinalizeAsset(expectedIdentity);
      if (!asset) return null;
      assertProviderIdentity(asset, expectedIdentity);
      return {
        status: asset.status,
        generationResult: normalizeResult(asset.generation.result),
      };
    },
    statObject: (params) => statGcsCreativeAssetObject(params),
    async loadProviderResult(input) {
      try {
        return await loadProviderResult(
          input,
          activityInput.providerRequestLocator,
        );
      } catch (error) {
        if (error instanceof VideoProviderError) {
          throw new VideoGenerationFinalizationError({
            phase: "poll",
            code: error.code,
            providerCode: error.providerCode,
            message: "Provider result did not satisfy the completion contract",
            retryable: error.retryable,
          });
        }
        throw asVideoGenerationFinalizationError(error, {
          phase: "download",
          code: "provider_result_load_failed",
          providerCode: null,
          message: "Provider video result could not be loaded",
          retryable: true,
        });
      }
    },
    uploadFile: (params) => uploadGcsCreativeAssetFile(params),
    copyObject: (params) => copyGcsCreativeAssetObject(params),
    deleteObject: (params) => deleteGcsCreativeAssetObject(params),
    async stageAsset(params) {
      const CreativeAsset = await loadCreativeAssetModel();
      const staged = await CreativeAsset.updateOne(
        buildVideoGenerationFinalizeIdentityFilter({
          contractVersion: 1,
          workspaceId: params.expected.workspaceId,
          assetId: params.expected.assetId,
          attemptToken: params.expected.attemptToken,
          providerRequestId: params.expected.providerRequestId,
          providerRequestLocator: activityInput.providerRequestLocator,
        }),
        {
          $set: {
            storageProvider: params.storage.storageProvider,
            url: params.storage.url,
            bucket: params.storage.bucket,
            path: params.storage.path,
            mimeType: params.storage.mimeType,
            fileName: params.storage.fileName,
            fileSize: params.storage.fileSize,
            updatedAt: new Date(),
          },
        },
      );
      return { matched: staged.matchedCount === 1 };
    },
    async clearStagedAsset(params) {
      const CreativeAsset = await loadCreativeAssetModel();
      const cleared = await CreativeAsset.updateOne(
        {
          ...buildVideoGenerationFinalizeIdentityFilter({
            contractVersion: 1,
            workspaceId: params.expected.workspaceId,
            assetId: params.expected.assetId,
            attemptToken: params.expected.attemptToken,
            providerRequestId: params.expected.providerRequestId,
            providerRequestLocator: activityInput.providerRequestLocator,
          }),
          storageProvider: "gcs",
          bucket: params.storage.bucket,
          path: params.storage.path,
        },
        {
          $set: {
            storageProvider: null,
            url: null,
            bucket: null,
            path: null,
            mimeType: null,
            fileName: null,
            fileSize: null,
            updatedAt: new Date(),
          },
        },
      );
      return { matched: cleared.matchedCount === 1 };
    },
    async completeAsset(params) {
      const CreativeAsset = await loadCreativeAssetModel();
      const completionIdentity = buildVideoGenerationFinalizeIdentityFilter({
        contractVersion: 1,
        workspaceId: params.expected.workspaceId,
        assetId: params.expected.assetId,
        attemptToken: params.expected.attemptToken,
        providerRequestId: params.expected.providerRequestId,
        providerRequestLocator: activityInput.providerRequestLocator,
      });
      const changed = await CreativeAsset.updateOne(
        {
          ...completionIdentity,
          status: { $in: params.expected.allowedStatuses },
        },
        {
          $set: {
            status: "complete",
            storageProvider: params.storage.storageProvider,
            url: params.storage.url,
            bucket: params.storage.bucket,
            path: params.storage.path,
            mimeType: params.storage.mimeType,
            fileName: params.storage.fileName,
            fileSize: params.storage.fileSize,
            "generation.result": params.result,
            "generation.failure": null,
            error: null,
            completedAt: params.result.completedAt,
            updatedAt: new Date(),
          },
        },
      );
      return { matched: changed.modifiedCount === 1 };
    },
  };
}

export const defaultVideoGenerationFinalizeActivityDependencies: VideoGenerationFinalizeActivityDependencies =
  {
    loadContext: defaultLoadContext,
    createMaterializerDependencies: defaultMaterializerDependencies,
    materialize: materializeVideoGenerationResult,
  };

function finalizationApplicationFailure(error: unknown): ApplicationFailure {
  const finalizationError =
    error instanceof VideoProviderError
      ? new VideoGenerationFinalizationError({
          phase: "poll",
          code: error.code,
          providerCode: error.providerCode,
          message: "Provider result did not satisfy the completion contract",
          retryable: error.retryable,
        })
      : asVideoGenerationFinalizationError(error, {
          phase: "store",
          code: "result_materialization_failed",
          providerCode: null,
          message: "Generated video could not be verified and stored",
          retryable: true,
        });
  const failure = finalizationError.failure;
  return ApplicationFailure.create({
    message: failure.message,
    type: VIDEO_GENERATION_FINALIZATION_FAILURE_TYPE,
    nonRetryable: !failure.retryable,
    details: [failure],
  });
}

export async function videoGenerationFinalizeActivity(
  input: VideoGenerationFinalizeActivityInput,
  dependencies: VideoGenerationFinalizeActivityDependencies = defaultVideoGenerationFinalizeActivityDependencies,
): Promise<VideoGenerationActivityResult> {
  try {
    const context = await dependencies.loadContext(input);
    const materialized = await dependencies.materialize(
      context.materializerInput,
      dependencies.createMaterializerDependencies(input),
    );
    return {
      contractVersion: 1,
      assetId: input.assetId,
      attemptToken: input.attemptToken,
      status: materialized.status,
      terminal: true,
      providerRequestId: input.providerRequestId,
      providerRequestLocator: input.providerRequestLocator,
      providerStatus: "completed",
      submissionState: context.asset.generation.submission.state,
    };
  } catch (error) {
    throw finalizationApplicationFailure(error);
  }
}
