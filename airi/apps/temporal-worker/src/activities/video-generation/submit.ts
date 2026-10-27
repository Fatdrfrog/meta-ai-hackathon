import { createCreativeAssetReadUrl } from "@icecore/airi-runtime/creative-asset-read-url";
import { resolveCreativeAssetGcsObjectRef } from "@icecore/airi-runtime/media-api";
import type {
  CompiledVideoPrompt,
  VideoGenerationActivityResult,
  VideoGenerationSafetyAncestor,
  VideoGenerationSpec,
  VideoGenerationWorkflowInput,
} from "@icecore/temporal";
import { sanitizeVideoProviderPayload } from "@icecore/shared/lib/video-provider-payload";

import {
  submitHappyHorseVideoProvider,
  VideoProviderError,
  type PreparedHappyHorseSubmission,
  type VideoProviderSubmission,
} from "./providers/happyhorse.js";
import {
  prepareHiggsfieldVideoSubmission,
  submitHiggsfieldVideoProvider,
  type PreparedHiggsfieldSubmission,
} from "./providers/higgsfield.js";
import {
  prepareGoogleVideoSubmission,
  submitGoogleVideoProvider,
  type PreparedGoogleSubmission,
} from "./providers/google.js";

export type VideoGenerationAssetStatus =
  | "queued"
  | "in_progress"
  | "complete"
  | "failed"
  | "nsfw";

export type VideoGenerationAssetSnapshot = {
  id: string;
  workspaceId: string;
  status: VideoGenerationAssetStatus;
  providerSourceId: string | null;
  generation: {
    spec: VideoGenerationSpec;
    prompt: CompiledVideoPrompt;
    webhookSignalKeys: string[];
    safetyProviderRequestIds?: string[];
    safetyAncestors?: VideoGenerationSafetyAncestor[];
    submission: {
      state: VideoGenerationActivityResult["submissionState"];
      attemptToken: string;
      providerRequestId: string | null;
      providerRequestLocator: string | null;
    };
  };
};

export type VideoGenerationMutationScope = {
  workspaceId: string;
  assetId: string;
  attemptToken: string;
  providerSourceId?: string | null;
  providerRequestId?: string | null;
  providerRequestLocator?: string | null;
  statuses?: VideoGenerationAssetStatus[];
  submissionStates?: VideoGenerationActivityResult["submissionState"][];
};

export type NormalizedVideoFailure = {
  phase:
    | "validation"
    | "compile"
    | "submit"
    | "poll"
    | "download"
    | "probe"
    | "store";
  code: string;
  providerCode: string | null;
  message: string;
  retryable: boolean;
  submissionUncertain: boolean;
  failedAt: Date;
};

export type VideoGenerationMutation = {
  status?: VideoGenerationAssetStatus;
  submissionState?: VideoGenerationActivityResult["submissionState"];
  providerRequestId?: string | null;
  providerRequestLocator?: string | null;
  providerPayload?: unknown;
  failure?: NormalizedVideoFailure | null;
};

export type PreparedVideoProviderSubmission =
  | PreparedHappyHorseSubmission
  | PreparedHiggsfieldSubmission
  | PreparedGoogleSubmission;

export type VideoGenerationPollProviderInput = {
  workspaceId: string;
  assetId: string;
  attemptToken: string;
  provider: VideoGenerationSpec["provider"];
  providerSourceId: string | null;
  providerRequestId: string;
  providerRequestLocator: string;
};

export type VideoGenerationActivityDependencies = {
  loadAsset(
    scope: Pick<
      VideoGenerationMutationScope,
      "workspaceId" | "assetId" | "attemptToken"
    >,
  ): Promise<VideoGenerationAssetSnapshot | null>;
  mutateAsset(
    scope: VideoGenerationMutationScope,
    update: VideoGenerationMutation,
  ): Promise<boolean>;
  prepareSubmission(
    input: VideoGenerationWorkflowInput,
  ): Promise<PreparedVideoProviderSubmission>;
  submitProvider(
    input: PreparedVideoProviderSubmission,
  ): Promise<VideoProviderSubmission>;
  pollProvider(
    input: VideoGenerationPollProviderInput,
    persistDiagnostic: (value: unknown) => Promise<void>,
  ): Promise<{
    providerRequestId: string;
    status:
      | "queued"
      | "in_progress"
      | "completed"
      | "failed"
      | "nsfw"
      | "cancelled";
  }>;
  findNsfwSafetyVerdict?: (input: {
    workspaceId: string;
    providerRequestIds: string[];
    ancestors: VideoGenerationSafetyAncestor[];
  }) => Promise<{ providerRequestId: string } | null>;
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function assertFrozenRecipe(
  asset: VideoGenerationAssetSnapshot,
  input: VideoGenerationWorkflowInput,
): void {
  if (
    stable(asset.generation.spec) !== stable(input.spec) ||
    stable(asset.generation.prompt) !== stable(input.prompt) ||
    asset.providerSourceId !== input.providerSourceId
  ) {
    throw new VideoProviderError({
      code: "frozen_recipe_mismatch",
      message: "Stored video recipe does not match the workflow input",
      phase: "submit",
      retryable: false,
      certainty: "not_attempted",
    });
  }
}

export class VideoGenerationStateConflictError extends Error {
  constructor(action: string) {
    super(`Video generation state changed during ${action}`);
    this.name = "VideoGenerationStateConflictError";
  }
}

export function isTerminalVideoGenerationAsset(
  asset: VideoGenerationAssetSnapshot,
): boolean {
  return ["complete", "failed", "nsfw"].includes(asset.status);
}

function hasDurableSubmittedProviderRequest(
  asset: VideoGenerationAssetSnapshot,
  expected?: {
    providerRequestId: string;
    providerRequestLocator: string;
  },
): boolean {
  const submission = asset.generation.submission;
  const providerRequestId = submission.providerRequestId;
  const providerRequestLocator = submission.providerRequestLocator;
  return (
    submission.state === "submitted" &&
    typeof providerRequestId === "string" &&
    providerRequestId.length > 0 &&
    providerRequestId.length <= 500 &&
    typeof providerRequestLocator === "string" &&
    providerRequestLocator.length > 0 &&
    providerRequestLocator.length <= 500 &&
    (!expected ||
      (providerRequestId === expected.providerRequestId &&
        providerRequestLocator === expected.providerRequestLocator))
  );
}

export async function reloadAfterVideoGenerationCasMiss(
  dependencies: VideoGenerationActivityDependencies,
  scope: Pick<
    VideoGenerationMutationScope,
    "workspaceId" | "assetId" | "attemptToken"
  >,
  action: string,
  matchesExpected: (asset: VideoGenerationAssetSnapshot) => boolean,
): Promise<VideoGenerationAssetSnapshot> {
  const current = await dependencies.loadAsset(scope);
  if (!current) throw new VideoGenerationStateConflictError(action);
  if (isTerminalVideoGenerationAsset(current) || matchesExpected(current))
    return current;
  throw new VideoGenerationStateConflictError(action);
}

function failureFrom(
  error: unknown,
  uncertainOverride?: boolean,
): NormalizedVideoFailure {
  const provider = error instanceof VideoProviderError ? error : null;
  const candidate =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {};
  const phaseValue = provider?.phase || candidate.phase;
  const phase = phaseValue === "poll" ? "poll" : "submit";
  const code = (
    provider?.code ||
    (typeof candidate.code === "string" && candidate.code) ||
    "video_generation_failed"
  ).slice(0, 100);
  const unsafeMessage =
    provider?.message ||
    (error instanceof Error ? error.message : "Video generation failed");
  const message = unsafeMessage
    .replace(/https?:\/\/\S+/gi, "provider resource")
    .slice(0, 1_000);
  const certainty = provider?.certainty || candidate.certainty;
  return {
    phase,
    code,
    providerCode: provider?.providerCode ?? null,
    message,
    retryable: provider?.retryable ?? candidate.retryable === true,
    submissionUncertain: uncertainOverride ?? certainty === "unknown",
    failedAt: new Date(),
  };
}

async function quarantineHiggsfieldNsfwBeforeSubmit(
  input: VideoGenerationWorkflowInput,
  asset: VideoGenerationAssetSnapshot,
  dependencies: VideoGenerationActivityDependencies,
  submissionStates: VideoGenerationActivityResult["submissionState"][],
): Promise<VideoGenerationActivityResult | null> {
  if (
    input.spec.provider !== "higgsfield" ||
    !dependencies.findNsfwSafetyVerdict
  ) {
    return null;
  }
  const verdict = await dependencies.findNsfwSafetyVerdict({
    workspaceId: input.workspaceId,
    providerRequestIds: asset.generation.safetyProviderRequestIds ?? [],
    ancestors: asset.generation.safetyAncestors ?? [],
  });
  if (!verdict) return null;

  const failure: NormalizedVideoFailure = {
    phase: "poll",
    code: "provider_nsfw",
    providerCode: "nsfw",
    message: "Provider rejected the video because of its safety policy",
    retryable: false,
    submissionUncertain: false,
    failedAt: new Date(),
  };
  const changed = await dependencies.mutateAsset(
    {
      workspaceId: input.workspaceId,
      assetId: input.assetId,
      attemptToken: input.attemptToken,
      providerSourceId: asset.providerSourceId,
      statuses: ["queued", "in_progress"],
      submissionStates,
    },
    {
      status: "nsfw",
      failure,
    },
  );
  if (!changed) {
    const current = await reloadAfterVideoGenerationCasMiss(
      dependencies,
      {
        workspaceId: input.workspaceId,
        assetId: input.assetId,
        attemptToken: input.attemptToken,
      },
      "NSFW safety verdict",
      (winner) => winner.status === "nsfw",
    );
    return result(current);
  }
  return {
    ...result(asset),
    status: "nsfw",
    terminal: true,
    providerStatus: "nsfw",
  };
}

export function result(
  asset: VideoGenerationAssetSnapshot,
): VideoGenerationActivityResult {
  const providerRequestId = asset.generation.submission.providerRequestId;
  return {
    contractVersion: 1,
    assetId: asset.id,
    attemptToken: asset.generation.submission.attemptToken,
    status: asset.status,
    terminal:
      asset.status === "complete" ||
      asset.status === "failed" ||
      asset.status === "nsfw",
    providerRequestId,
    providerRequestLocator: providerRequestId
      ? asset.generation.submission.providerRequestLocator
      : null,
    providerStatus: null,
    submissionState: asset.generation.submission.state,
  };
}

async function resolveAssetUrl(
  asset: Record<string, unknown>,
  workspaceId: string,
): Promise<string> {
  const direct = typeof asset.url === "string" ? asset.url.trim() : "";
  const ref = resolveCreativeAssetGcsObjectRef({
    url: direct || null,
    bucket: typeof asset.bucket === "string" ? asset.bucket : null,
    path: typeof asset.path === "string" ? asset.path : null,
  });
  if (ref) {
    const read = await createCreativeAssetReadUrl({
      provider: "gcs",
      bucket: ref.bucket,
      path: ref.path,
      workspaceId,
    });
    if (/^https:\/\//i.test(read.url)) return read.url;
  }
  if (/^https:\/\//i.test(direct)) return direct;
  throw new VideoProviderError({
    code: "source_unavailable",
    message: "A source image is unavailable",
    phase: "submit",
    retryable: true,
    certainty: "not_attempted",
  });
}

export async function prepareVideoProviderSubmission(
  input: VideoGenerationWorkflowInput,
): Promise<PreparedVideoProviderSubmission> {
  const ids = input.spec.sourceAssetId
    ? [input.spec.sourceAssetId]
    : input.spec.referenceAssetIds;
  let sourceUrls: string[] = [];
  if (ids.length > 0) {
    const [{ default: connectDB }, { CreativeAsset }] = await Promise.all([
      import("@/lib/mongoose"),
      import("@/models/creative-asset"),
    ]);
    await connectDB();
    const assets = await CreativeAsset.find({
      _id: { $in: ids },
      workspaceId: input.workspaceId,
      kind: "image",
      status: "complete",
    }).lean<Record<string, unknown>[]>();
    const byId = new Map(assets.map((asset) => [String(asset._id), asset]));
    if (byId.size !== ids.length)
      throw new VideoProviderError({
        code: "source_unavailable",
        message: "A source image is unavailable",
        phase: "submit",
        retryable: true,
        certainty: "not_attempted",
      });
    sourceUrls = await Promise.all(
      ids.map((id) => resolveAssetUrl(byId.get(id)!, input.workspaceId)),
    );
  }

  if (input.spec.provider === "happyhorse") {
    throw new VideoProviderError({
      code: "own_ai_source_required",
      message:
        "Customer-funded HappyHorse generation is not available. Use Google AI or Higgsfield.",
      phase: "submit",
      retryable: false,
      certainty: "not_attempted",
    });
  }
  if (input.spec.provider === "higgsfield") {
    return prepareHiggsfieldVideoSubmission({
      provider: "higgsfield",
      assetId: input.assetId,
      workspaceId: input.workspaceId,
      providerSourceId: input.providerSourceId,
      spec: input.spec,
      prompt: input.prompt,
      sourceUrls: sourceUrls as [string],
    });
  }
  return prepareGoogleVideoSubmission({
    workspaceId: input.workspaceId,
    providerSourceId: input.providerSourceId,
    spec: input.spec,
    prompt: input.prompt,
    sourceUrl: sourceUrls[0] || "",
  });
}

export async function submitVideoProvider(
  input: PreparedVideoProviderSubmission,
): Promise<VideoProviderSubmission> {
  if (input.provider === "happyhorse")
    return submitHappyHorseVideoProvider(input);
  if (input.provider === "higgsfield")
    return submitHiggsfieldVideoProvider(input);
  return submitGoogleVideoProvider(input);
}

export const defaultVideoGenerationActivityDependencies: VideoGenerationActivityDependencies =
  {
    async loadAsset(scope) {
      const [{ default: connectDB }, { CreativeAsset }] = await Promise.all([
        import("@/lib/mongoose"),
        import("@/models/creative-asset"),
      ]);
      await connectDB();
      const asset = await CreativeAsset.findOne({
        _id: scope.assetId,
        workspaceId: scope.workspaceId,
        "generation.submission.attemptToken": scope.attemptToken,
      }).lean<Record<string, unknown> | null>();
      if (!asset) return null;
      const generation =
        asset.generation as VideoGenerationAssetSnapshot["generation"];
      generation.submission.providerRequestLocator =
        typeof asset.providerStatusUrl === "string"
          ? asset.providerStatusUrl
          : null;
      generation.webhookSignalKeys = Array.isArray(generation.webhookSignalKeys)
        ? generation.webhookSignalKeys
            .filter((value): value is string => typeof value === "string")
            .slice(0, 6)
        : [];
      return {
        id: String(asset._id),
        workspaceId: String(asset.workspaceId),
        status: asset.status as VideoGenerationAssetStatus,
        providerSourceId:
          typeof asset.providerSourceId === "string"
            ? asset.providerSourceId
            : null,
        generation,
      };
    },
    async mutateAsset(scope, update) {
      const [{ default: connectDB }, { CreativeAsset }] = await Promise.all([
        import("@/lib/mongoose"),
        import("@/models/creative-asset"),
      ]);
      await connectDB();
      const query: Record<string, unknown> = {
        _id: scope.assetId,
        workspaceId: scope.workspaceId,
        "generation.submission.attemptToken": scope.attemptToken,
      };
      if (scope.providerRequestId !== undefined)
        query["generation.submission.providerRequestId"] =
          scope.providerRequestId;
      if (scope.providerSourceId !== undefined)
        query.providerSourceId = scope.providerSourceId;
      if (scope.providerRequestLocator !== undefined)
        query.providerStatusUrl = scope.providerRequestLocator;
      if (scope.statuses) query.status = { $in: scope.statuses };
      if (scope.submissionStates)
        query["generation.submission.state"] = { $in: scope.submissionStates };
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (update.status) set.status = update.status;
      if (update.submissionState)
        set["generation.submission.state"] = update.submissionState;
      if (update.providerRequestId !== undefined) {
        set["generation.submission.providerRequestId"] =
          update.providerRequestId;
        set.providerRequestId = update.providerRequestId;
      }
      if (update.providerRequestLocator !== undefined)
        set.providerStatusUrl = update.providerRequestLocator;
      if (update.providerPayload !== undefined)
        set.providerPayload = update.providerPayload;
      if (update.failure !== undefined) {
        set["generation.failure"] = update.failure;
        set.error = update.failure?.message ?? null;
      }
      const changed = await CreativeAsset.updateOne(query, { $set: set });
      return changed.matchedCount === 1;
    },
    prepareSubmission: prepareVideoProviderSubmission,
    submitProvider: submitVideoProvider,
    async pollProvider(input, persistDiagnostic) {
      const { pollHappyHorseVideoProvider } = await import(
        "./providers/happyhorse.js"
      );
      const { pollHiggsfieldVideoProvider } = await import(
        "./providers/higgsfield.js"
      );
      const { pollGoogleVideoProvider } = await import("./providers/google.js");
      if (input.provider === "happyhorse")
        return pollHappyHorseVideoProvider(input, persistDiagnostic);
      if (input.provider === "google")
        return pollGoogleVideoProvider(input, persistDiagnostic);
      const [{ supabaseAdmin }, { resolveHiggsfieldAuthKeyForWorkspace }] =
        await Promise.all([
          import("@/lib/supabase/admin"),
          import("@/lib/higgsfield/higgsfield-source"),
        ]);
      const auth = await resolveHiggsfieldAuthKeyForWorkspace({
        supabase: supabaseAdmin,
        workspaceId: input.workspaceId,
        sourceId: input.providerSourceId,
      });
      return pollHiggsfieldVideoProvider(
        { ...input, authKey: auth.authKey },
        persistDiagnostic,
      );
    },
    async findNsfwSafetyVerdict(input) {
      const { findVideoGenerationNsfwVerdict } = await import(
        "@/lib/creative-assets/video-generation-nsfw-verdict-store"
      );
      return findVideoGenerationNsfwVerdict(input);
    },
  };

export async function videoGenerationSubmitActivity(
  input: VideoGenerationWorkflowInput,
  dependencies: VideoGenerationActivityDependencies = defaultVideoGenerationActivityDependencies,
): Promise<VideoGenerationActivityResult> {
  const scope = {
    workspaceId: input.workspaceId,
    assetId: input.assetId,
    attemptToken: input.attemptToken,
  };
  let asset = await dependencies.loadAsset(scope);
  if (!asset) throw new Error("Video generation asset was not found");
  assertFrozenRecipe(asset, input);
  const mutationScope = {
    ...scope,
    providerSourceId: asset.providerSourceId,
    providerRequestLocator: asset.generation.submission.providerRequestLocator,
  };

  if (["complete", "failed", "nsfw"].includes(asset.status))
    return result(asset);
  const submission = asset.generation.submission;
  if (submission.state === "pending") {
    const quarantined = await quarantineHiggsfieldNsfwBeforeSubmit(
      input,
      asset,
      dependencies,
      ["pending"],
    );
    if (quarantined) return quarantined;
  }
  if (submission.state === "submitted" && submission.providerRequestId) {
    if (submission.providerRequestLocator) return result(asset);
    const failure = failureFrom(
      new VideoProviderError({
        code: "provider_protocol_error",
        message: "The persisted provider request locator is missing",
        phase: "submit",
        retryable: false,
        certainty: "not_attempted",
      }),
      false,
    );
    const changed = await dependencies.mutateAsset(
      {
        ...mutationScope,
        statuses: ["queued", "in_progress"],
        submissionStates: ["submitted"],
        providerRequestId: submission.providerRequestId,
      },
      { status: "failed", failure },
    );
    if (!changed) {
      asset = await reloadAfterVideoGenerationCasMiss(
        dependencies,
        scope,
        "missing-locator failure",
        (current) => current.status === "failed",
      );
      return result(asset);
    }
    return {
      ...result(asset),
      status: "failed",
      terminal: true,
      providerStatus: null,
    };
  }
  if (submission.state === "dispatching") {
    const failure = failureFrom(
      new VideoProviderError({
        code: "submission_outcome_unknown",
        message: "The provider submission outcome could not be confirmed",
        phase: "submit",
        retryable: true,
        certainty: "unknown",
      }),
      true,
    );
    const changed = await dependencies.mutateAsset(
      {
        ...mutationScope,
        statuses: ["queued"],
        submissionStates: ["dispatching"],
        providerRequestId: null,
      },
      { status: "failed", submissionState: "unknown", failure },
    );
    if (!changed) {
      asset = await reloadAfterVideoGenerationCasMiss(
        dependencies,
        scope,
        "dispatching recovery",
        (current) =>
          (current.status === "failed" &&
            current.generation.submission.state === "unknown") ||
          hasDurableSubmittedProviderRequest(current),
      );
      return result(asset);
    }
    return {
      ...result(asset),
      status: "failed",
      terminal: true,
      submissionState: "unknown",
      providerStatus: null,
    };
  }
  if (submission.state === "unknown" || submission.state === "not_attempted")
    return { ...result(asset), status: "failed", terminal: true };

  let prepared: PreparedVideoProviderSubmission;
  try {
    prepared = await dependencies.prepareSubmission({
      ...input,
      providerSourceId: asset.providerSourceId,
      spec: asset.generation.spec,
      prompt: asset.generation.prompt,
    });
  } catch (error) {
    const failure = failureFrom(error, false);
    const changed = await dependencies.mutateAsset(
      {
        ...mutationScope,
        statuses: ["queued"],
        submissionStates: ["pending"],
        providerRequestId: null,
      },
      {
        status: "failed",
        submissionState: "not_attempted",
        providerPayload: sanitizeVideoProviderPayload(
          error instanceof VideoProviderError ? error.diagnostic : null,
        ),
        failure,
      },
    );
    if (!changed) {
      asset = await reloadAfterVideoGenerationCasMiss(
        dependencies,
        scope,
        "preparation failure",
        (current) =>
          current.status === "failed" &&
          current.generation.submission.state === "not_attempted",
      );
      return result(asset);
    }
    return {
      ...result(asset),
      status: "failed",
      terminal: true,
      submissionState: "not_attempted",
      providerStatus: null,
    };
  }

  const claimed = await dependencies.mutateAsset(
    {
      ...scope,
      providerSourceId: asset.providerSourceId,
      statuses: ["queued"],
      submissionStates: ["pending"],
      providerRequestId: null,
    },
    { submissionState: "dispatching", failure: null },
  );
  if (!claimed) {
    asset = await reloadAfterVideoGenerationCasMiss(
      dependencies,
      scope,
      "submission claim",
      (current) =>
        current.generation.submission.state === "submitted" &&
        Boolean(current.generation.submission.providerRequestId) &&
        Boolean(current.generation.submission.providerRequestLocator),
    );
    return result(asset);
  }

  const quarantined = await quarantineHiggsfieldNsfwBeforeSubmit(
    input,
    asset,
    dependencies,
    ["dispatching"],
  );
  if (quarantined) return quarantined;

  try {
    const submitted = await dependencies.submitProvider(prepared);
    const status: VideoGenerationAssetStatus =
      submitted.status === "nsfw"
        ? "nsfw"
        : submitted.status === "failed" || submitted.status === "cancelled"
          ? "failed"
          : submitted.status === "in_progress" ||
              submitted.status === "completed"
            ? "in_progress"
            : "queued";
    const terminal = status === "failed" || status === "nsfw";
    const immediateFailure = terminal
      ? failureFrom(
          new VideoProviderError({
            code:
              submitted.status === "nsfw"
                ? "provider_nsfw"
                : submitted.status === "cancelled"
                  ? "provider_cancelled"
                  : "provider_failed",
            message:
              submitted.status === "nsfw"
                ? "Provider marked the video generation as NSFW"
                : submitted.status === "cancelled"
                  ? "Provider cancelled the video generation"
                  : "Provider failed the video generation",
            phase: "submit",
            retryable: submitted.status !== "nsfw",
            certainty: "not_attempted",
          }),
          false,
        )
      : null;
    const changed = await dependencies.mutateAsset(
      {
        ...mutationScope,
        statuses: ["queued", "in_progress"],
        submissionStates: ["dispatching"],
        providerRequestId: null,
      },
      {
        status,
        submissionState: "submitted",
        providerRequestId: submitted.providerRequestId,
        providerRequestLocator: submitted.providerRequestLocator,
        failure: immediateFailure,
      },
    );
    if (!changed) {
      asset = await reloadAfterVideoGenerationCasMiss(
        dependencies,
        scope,
        "submission success",
        (current) =>
          hasDurableSubmittedProviderRequest(current, {
            providerRequestId: submitted.providerRequestId,
            providerRequestLocator: submitted.providerRequestLocator,
          }),
      );
      return result(asset);
    }
    return {
      contractVersion: 1,
      assetId: input.assetId,
      attemptToken: input.attemptToken,
      status,
      terminal,
      providerRequestId: submitted.providerRequestId,
      providerRequestLocator: submitted.providerRequestLocator,
      providerStatus: submitted.status,
      submissionState: "submitted",
    };
  } catch (error) {
    if (error instanceof VideoGenerationStateConflictError) throw error;
    const provider =
      error instanceof VideoProviderError
        ? error
        : new VideoProviderError({
            code: "provider_submission_uncertain",
            message: "Provider submission outcome is unknown",
            phase: "submit",
            retryable: true,
            certainty: "unknown",
          });
    const uncertain = provider.certainty === "unknown";
    const nextState = uncertain ? "unknown" : "not_attempted";
    const failure = failureFrom(provider, uncertain);
    const changed = await dependencies.mutateAsset(
      {
        ...mutationScope,
        statuses: ["queued"],
        submissionStates: ["dispatching"],
        providerRequestId: null,
      },
      {
        status: "failed",
        submissionState: nextState,
        providerPayload: sanitizeVideoProviderPayload(provider.diagnostic),
        failure,
      },
    );
    if (!changed) {
      asset = await reloadAfterVideoGenerationCasMiss(
        dependencies,
        scope,
        "submission failure",
        (current) =>
          (current.status === "failed" &&
            current.generation.submission.state === nextState) ||
          hasDurableSubmittedProviderRequest(current),
      );
      return result(asset);
    }
    return {
      contractVersion: 1,
      assetId: input.assetId,
      attemptToken: input.attemptToken,
      status: "failed",
      terminal: true,
      providerRequestId: null,
      providerRequestLocator: null,
      providerStatus: null,
      submissionState: nextState,
    };
  }
}
