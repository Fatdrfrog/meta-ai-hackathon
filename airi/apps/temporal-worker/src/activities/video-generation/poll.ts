import {
  selectVideoGenerationWebhookTerminalStatus,
  type VideoGenerationActivityResult,
  type VideoGenerationWorkflowInput,
} from "@icecore/temporal";
import { sanitizeVideoProviderPayload } from "@icecore/shared/lib/video-provider-payload";
import {
  normalizeVideoProviderRequestLocator,
  VideoProviderError,
} from "./providers/happyhorse.js";
import {
  assertFrozenRecipe,
  defaultVideoGenerationActivityDependencies,
  isTerminalVideoGenerationAsset,
  reloadAfterVideoGenerationCasMiss,
  result,
  type NormalizedVideoFailure,
  type VideoGenerationActivityDependencies,
  type VideoGenerationAssetSnapshot,
} from "./submit.js";

export type VideoGenerationPollActivityInput = VideoGenerationWorkflowInput & {
  providerRequestId: string;
  providerRequestLocator: string;
  webhookOnly?: boolean;
};

function pollFailure(error: unknown): NormalizedVideoFailure {
  const provider = error instanceof VideoProviderError ? error : null;
  return {
    phase: "poll",
    code: (provider?.code || "provider_poll_failed").slice(0, 100),
    providerCode: provider?.providerCode ?? null,
    message: (provider?.message || "Video generation status could not be read")
      .replace(/https?:\/\/\S+/gi, "provider resource")
      .slice(0, 1_000),
    retryable: provider?.retryable ?? true,
    submissionUncertain: false,
    failedAt: new Date(),
  };
}

function diagnosticForPollError(error: unknown): unknown {
  if (error instanceof VideoProviderError)
    return {
      code: error.code,
      providerCode: error.providerCode,
      retryable: error.retryable,
      diagnostic: error.diagnostic,
      message: error.message,
    };
  return {
    code: "provider_poll_failed",
    message:
      error instanceof Error
        ? error.message
        : "Video generation status could not be read",
  };
}

function pollResult(
  asset: VideoGenerationAssetSnapshot,
  providerStatus: VideoGenerationActivityResult["providerStatus"],
): VideoGenerationActivityResult {
  return { ...result(asset), providerStatus };
}

class PollTerminalWinner extends Error {
  constructor(readonly asset: VideoGenerationAssetSnapshot) {
    super("A terminal video-generation state won the poll diagnostic race");
    this.name = "PollTerminalWinner";
  }
}

/**
 * Retryable provider failures deliberately escape this activity after their
 * bounded diagnostic is stored. Task 7 must call the fail activity only after
 * Temporal exhausts the poll activity's maximum attempts.
 */
export async function videoGenerationPollActivity(
  input: VideoGenerationPollActivityInput,
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

  const submission = asset.generation.submission;
  const persistedRequestId = normalizeVideoProviderRequestLocator(
    submission.providerRequestId,
    "poll",
  );
  const persistedLocator = normalizeVideoProviderRequestLocator(
    submission.providerRequestLocator,
    "poll",
  );
  if (
    input.providerRequestId !== persistedRequestId ||
    input.providerRequestLocator !== persistedLocator
  ) {
    throw new VideoProviderError({
      code: "provider_request_mismatch",
      message: "Workflow provider request does not match persisted state",
      phase: "poll",
      retryable: false,
      certainty: "not_attempted",
    });
  }
  if (isTerminalVideoGenerationAsset(asset)) return result(asset);
  if (submission.state !== "submitted") {
    throw new VideoProviderError({
      code: "provider_request_mismatch",
      message:
        "Video provider request does not match persisted submission state",
      phase: "poll",
      retryable: false,
      certainty: "not_attempted",
    });
  }

  const durableWebhookStatus = selectVideoGenerationWebhookTerminalStatus({
    providerRequestId: persistedRequestId,
    webhookSignalKeys: asset.generation.webhookSignalKeys,
  });
  if (input.webhookOnly && !durableWebhookStatus) return result(asset);

  const mutationScope = {
    ...scope,
    providerSourceId: asset.providerSourceId,
    providerRequestId: persistedRequestId,
    providerRequestLocator: persistedLocator,
    statuses: ["queued", "in_progress"] as const,
    submissionStates: ["submitted"] as const,
  };
  const persistDiagnostic = async (value: unknown) => {
    const changed = await dependencies.mutateAsset(
      {
        ...mutationScope,
        statuses: [...mutationScope.statuses],
        submissionStates: [...mutationScope.submissionStates],
      },
      { providerPayload: sanitizeVideoProviderPayload(value) },
    );
    if (!changed) {
      const current = await reloadAfterVideoGenerationCasMiss(
        dependencies,
        scope,
        "poll diagnostic",
        () => false,
      );
      if (isTerminalVideoGenerationAsset(current))
        throw new PollTerminalWinner(current);
      throw new Error("Unreachable nonterminal poll diagnostic winner");
    }
  };

  let polled: Awaited<
    ReturnType<VideoGenerationActivityDependencies["pollProvider"]>
  >;
  try {
    polled = durableWebhookStatus
      ? {
          providerRequestId: persistedRequestId,
          status: durableWebhookStatus,
        }
      : await dependencies.pollProvider(
          {
            ...scope,
            provider: asset.generation.spec.provider,
            providerSourceId: asset.providerSourceId,
            providerRequestId: persistedRequestId,
            providerRequestLocator: persistedLocator,
          },
          persistDiagnostic,
        );
    if (polled.providerRequestId !== persistedRequestId) {
      throw new VideoProviderError({
        code: "provider_request_mismatch",
        message: "Provider returned a different request identifier",
        phase: "poll",
        retryable: false,
        certainty: "not_attempted",
        diagnostic: {
          expectedProviderRequestId: persistedRequestId,
          actualProviderRequestId: polled.providerRequestId,
        },
      });
    }
  } catch (error) {
    if (error instanceof PollTerminalWinner) return result(error.asset);
    try {
      await persistDiagnostic(diagnosticForPollError(error));
    } catch (persistError) {
      if (persistError instanceof PollTerminalWinner)
        return result(persistError.asset);
      throw persistError;
    }
    const failure = pollFailure(error);
    if (failure.retryable) throw error;

    const changed = await dependencies.mutateAsset(
      {
        ...mutationScope,
        statuses: [...mutationScope.statuses],
        submissionStates: [...mutationScope.submissionStates],
      },
      { status: "failed", failure },
    );
    if (!changed) {
      asset = await reloadAfterVideoGenerationCasMiss(
        dependencies,
        scope,
        "permanent poll failure",
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

  const mapped =
    polled.status === "queued"
      ? "queued"
      : polled.status === "in_progress"
        ? "in_progress"
        : polled.status === "nsfw"
          ? "nsfw"
          : polled.status === "completed"
            ? "in_progress"
            : "failed";
  const terminal = mapped === "failed" || mapped === "nsfw";
  const changed = await dependencies.mutateAsset(
    {
      ...mutationScope,
      statuses: [...mutationScope.statuses],
      submissionStates: [...mutationScope.submissionStates],
    },
    {
      status: mapped,
      ...(terminal
        ? {
            failure: pollFailure(
              new VideoProviderError({
                code:
                  polled.status === "cancelled"
                    ? "provider_cancelled"
                    : polled.status === "nsfw"
                      ? "provider_nsfw"
                      : "provider_failed",
                message:
                  polled.status === "cancelled"
                    ? "Provider cancelled the video generation"
                    : polled.status === "nsfw"
                      ? "Provider marked the video generation as NSFW"
                      : "Provider failed the video generation",
                phase: "poll",
                retryable: polled.status !== "nsfw",
                certainty: "not_attempted",
              }),
            ),
          }
        : {}),
    },
  );
  if (!changed) {
    asset = await reloadAfterVideoGenerationCasMiss(
      dependencies,
      scope,
      "poll state transition",
      (current) =>
        current.status === mapped &&
        current.generation.submission.state === "submitted" &&
        current.generation.submission.providerRequestId ===
          persistedRequestId &&
        current.generation.submission.providerRequestLocator ===
          persistedLocator,
    );
    if (isTerminalVideoGenerationAsset(asset)) return result(asset);
  }
  return {
    contractVersion: 1,
    assetId: asset.id,
    attemptToken: asset.generation.submission.attemptToken,
    status: mapped,
    terminal,
    providerRequestId: persistedRequestId,
    providerRequestLocator: persistedLocator,
    providerStatus: polled.status,
    submissionState: "submitted",
  };
}
