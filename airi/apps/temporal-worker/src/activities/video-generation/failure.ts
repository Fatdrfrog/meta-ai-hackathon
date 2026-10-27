import type {
  VideoGenerationActivityResult,
  VideoGenerationWorkflowInput,
} from "@icecore/temporal";
import {
  assertFrozenRecipe,
  defaultVideoGenerationActivityDependencies,
  reloadAfterVideoGenerationCasMiss,
  result,
  type NormalizedVideoFailure,
  type VideoGenerationActivityDependencies,
} from "./submit.js";

export type VideoGenerationFailActivityInput = VideoGenerationWorkflowInput & {
  providerRequestId: string | null;
  phase: NormalizedVideoFailure["phase"];
  code: string;
  providerCode?: string | null;
  message: string;
  retryable: boolean;
  terminalStatus?: "failed" | "nsfw";
};

export async function videoGenerationFailActivity(
  input: VideoGenerationFailActivityInput,
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
  if (
    asset.generation.submission.providerRequestId !== input.providerRequestId
  ) {
    throw new Error(
      "Failure request does not match persisted provider request",
    );
  }
  if (["complete", "failed", "nsfw"].includes(asset.status))
    return result(asset);

  const terminalStatus = input.terminalStatus ?? "failed";
  const submissionUncertain =
    input.phase === "submit" &&
    ["dispatching", "unknown"].includes(
      asset.generation.submission.state ?? "",
    );

  const failure: NormalizedVideoFailure = {
    phase: input.phase,
    code: input.code.slice(0, 100),
    providerCode: input.providerCode?.slice(0, 100) ?? null,
    message: input.message
      .replace(/https?:\/\/\S+/gi, "provider resource")
      .slice(0, 1_000),
    retryable: input.retryable,
    submissionUncertain,
    failedAt: new Date(),
  };
  const changed = await dependencies.mutateAsset(
    {
      ...scope,
      providerSourceId: asset.providerSourceId,
      providerRequestId: asset.generation.submission.providerRequestId,
      providerRequestLocator:
        asset.generation.submission.providerRequestLocator,
      statuses: ["queued", "in_progress"],
      ...(submissionUncertain
        ? { submissionStates: ["dispatching", "unknown"] as const }
        : {}),
    },
    {
      status: terminalStatus,
      ...(submissionUncertain ? { submissionState: "unknown" as const } : {}),
      failure,
    },
  );
  if (!changed) {
    asset = await reloadAfterVideoGenerationCasMiss(
      dependencies,
      scope,
      "failure transition",
      (current) => current.status === terminalStatus,
    );
    return result(asset);
  }
  return {
    ...result(asset),
    status: terminalStatus,
    terminal: true,
    providerStatus: null,
    ...(submissionUncertain ? { submissionState: "unknown" as const } : {}),
  };
}
