export {
  MAX_VIDEO_GENERATION_SAFETY_ANCESTOR_ID_LENGTH,
  MAX_VIDEO_GENERATION_SAFETY_ANCESTORS,
  MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_ID_LENGTH,
  MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_IDS,
} from "@icecore/temporal";

export const VIDEO_GENERATION_PROVIDER_NSFW_MESSAGE =
  "Provider rejected the video because of its safety policy";

const MAX_WEBHOOK_SIGNAL_KEYS = 6;

type VideoGenerationNsfwAliasIdentity = {
  workspaceId: string;
  providerRequestId: string;
  sourceAssetId?: string;
  sourceAttemptToken?: string;
};

export function buildVideoGenerationNsfwAliasFilter(
  input: VideoGenerationNsfwAliasIdentity
): Record<string, unknown> {
  const aliases: Record<string, unknown>[] = [
    {
      providerRequestId: input.providerRequestId,
      "generation.submission.providerRequestId": input.providerRequestId,
    },
    {
      "generation.safetyProviderRequestIds": input.providerRequestId,
    },
  ];
  if (input.sourceAssetId && input.sourceAttemptToken) {
    aliases.push({
      "generation.safetyAncestors": {
        $elemMatch: {
          assetId: input.sourceAssetId,
          attemptToken: input.sourceAttemptToken,
        },
      },
    });
  }
  return {
    workspaceId: input.workspaceId,
    "generation.contractVersion": 1,
    "generation.spec.provider": "higgsfield",
    $or: aliases,
  };
}

export function buildVideoGenerationNsfwUpdatePipeline(input: {
  providerRequestId: string;
  receivedAt: Date;
  providerPayload?: unknown;
}): Array<{ $set: Record<string, unknown> }> {
  const signalKey = `${input.providerRequestId}:nsfw`;
  const set: Record<string, unknown> = {
    status: "nsfw",
    "generation.webhookSignalKeys": {
      $let: {
        vars: {
          keys: {
            $ifNull: ["$generation.webhookSignalKeys", []],
          },
        },
        in: {
          $slice: [
            {
              $cond: [
                {
                  $in: [{ $literal: signalKey }, "$$keys"],
                },
                "$$keys",
                {
                  $concatArrays: ["$$keys", { $literal: [signalKey] }],
                },
              ],
            },
            -MAX_WEBHOOK_SIGNAL_KEYS,
          ],
        },
      },
    },
    "generation.result": null,
    "generation.failure": {
      phase: "poll",
      code: "provider_nsfw",
      providerCode: "nsfw",
      message: VIDEO_GENERATION_PROVIDER_NSFW_MESSAGE,
      retryable: false,
      submissionUncertain: false,
      failedAt: input.receivedAt,
    },
    error: VIDEO_GENERATION_PROVIDER_NSFW_MESSAGE,
    url: null,
    mimeType: null,
    fileName: null,
    fileSize: null,
    completedAt: null,
    updatedAt: input.receivedAt,
  };
  if (input.providerPayload !== undefined) {
    set.providerPayload = { $literal: input.providerPayload };
  }
  return [{ $set: set }];
}
