import "server-only";

import { createHash } from "node:crypto";

import {
  MAX_VIDEO_GENERATION_SAFETY_ANCESTOR_ID_LENGTH,
  MAX_VIDEO_GENERATION_SAFETY_ANCESTORS,
  MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_ID_LENGTH,
  MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_IDS,
  type VideoGenerationSafetyAncestor,
} from "@icecore/temporal";
import {
  buildVideoGenerationNsfwAliasFilter,
  buildVideoGenerationNsfwUpdatePipeline,
} from "@/lib/creative-assets/video-generation-nsfw";
import { CreativeAsset } from "@/models/creative-asset";
import {
  VideoGenerationNsfwVerdict,
  type VideoGenerationNsfwVerdictRecord,
} from "@/models/video-generation-nsfw-verdict";

export type { VideoGenerationSafetyAncestor } from "@icecore/temporal";

export type VideoGenerationNsfwVerdictIdentity = Pick<
  VideoGenerationNsfwVerdictRecord,
  | "_id"
  | "providerRequestId"
  | "sourceAssetId"
  | "sourceAttemptToken"
  | "firstReceivedAt"
>;

function boundedIdentifier(
  value: unknown,
  maxLength: number,
  label: string
): string {
  const identifier = typeof value === "string" ? value.trim() : "";
  if (!identifier || identifier.length > maxLength) {
    throw new Error(`Invalid video generation NSFW ${label}`);
  }
  return identifier;
}

export function buildVideoGenerationNsfwVerdictId(input: {
  workspaceId: string;
  providerRequestId: string;
}): string {
  const workspaceId = boundedIdentifier(input.workspaceId, 128, "workspace");
  const providerRequestId = boundedIdentifier(
    input.providerRequestId,
    MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_ID_LENGTH,
    "provider request"
  );
  return createHash("sha256")
    .update(`v1\u0000${workspaceId}\u0000higgsfield\u0000${providerRequestId}`)
    .digest("hex");
}

export async function recordVideoGenerationNsfwVerdict(input: {
  workspaceId: string;
  providerRequestId: string;
  sourceAssetId: string;
  sourceAttemptToken: string;
  receivedAt: Date;
}): Promise<VideoGenerationNsfwVerdictIdentity> {
  const workspaceId = boundedIdentifier(input.workspaceId, 128, "workspace");
  const providerRequestId = boundedIdentifier(
    input.providerRequestId,
    MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_ID_LENGTH,
    "provider request"
  );
  const sourceAssetId = boundedIdentifier(
    input.sourceAssetId,
    MAX_VIDEO_GENERATION_SAFETY_ANCESTOR_ID_LENGTH,
    "source asset"
  );
  const sourceAttemptToken = boundedIdentifier(
    input.sourceAttemptToken,
    MAX_VIDEO_GENERATION_SAFETY_ANCESTOR_ID_LENGTH,
    "source attempt"
  );
  if (
    !(input.receivedAt instanceof Date) ||
    !Number.isFinite(input.receivedAt.getTime())
  ) {
    throw new Error("Invalid video generation NSFW received time");
  }

  const markerId = buildVideoGenerationNsfwVerdictId({
    workspaceId,
    providerRequestId,
  });
  await VideoGenerationNsfwVerdict.updateOne(
    { _id: markerId },
    {
      $setOnInsert: {
        _id: markerId,
        workspaceId,
        provider: "higgsfield",
        providerRequestId,
        verdict: "nsfw",
        sourceAssetId,
        sourceAttemptToken,
        firstReceivedAt: input.receivedAt,
      },
      $set: {
        lastReceivedAt: input.receivedAt,
        sweepCompletedAt: null,
      },
    },
    {
      upsert: true,
      writeConcern: { w: "majority" },
    }
  );

  const verdict = await VideoGenerationNsfwVerdict.findOne({
    _id: markerId,
    workspaceId,
    provider: "higgsfield",
    providerRequestId,
    verdict: "nsfw",
  })
    .read("primary")
    .lean<VideoGenerationNsfwVerdictRecord | null>();
  if (
    !verdict ||
    verdict.sourceAssetId !== sourceAssetId ||
    verdict.sourceAttemptToken !== sourceAttemptToken
  ) {
    throw new Error("Conflicting video generation NSFW verdict identity");
  }
  return verdict;
}

export async function findVideoGenerationNsfwVerdict(input: {
  workspaceId: string;
  providerRequestIds: string[];
  ancestors: VideoGenerationSafetyAncestor[];
}): Promise<VideoGenerationNsfwVerdictIdentity | null> {
  const workspaceId = boundedIdentifier(input.workspaceId, 128, "workspace");
  if (
    input.providerRequestIds.length >
      MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_IDS ||
    input.ancestors.length > MAX_VIDEO_GENERATION_SAFETY_ANCESTORS
  ) {
    throw new Error("Video generation NSFW lookup lineage is too large");
  }

  const markerIds = input.providerRequestIds.map(providerRequestId =>
    buildVideoGenerationNsfwVerdictId({ workspaceId, providerRequestId })
  );
  const ancestors = input.ancestors.map(ancestor => ({
    sourceAssetId: boundedIdentifier(
      ancestor.assetId,
      MAX_VIDEO_GENERATION_SAFETY_ANCESTOR_ID_LENGTH,
      "ancestor asset"
    ),
    sourceAttemptToken: boundedIdentifier(
      ancestor.attemptToken,
      MAX_VIDEO_GENERATION_SAFETY_ANCESTOR_ID_LENGTH,
      "ancestor attempt"
    ),
  }));
  if (markerIds.length === 0 && ancestors.length === 0) return null;

  const aliases: Record<string, unknown>[] = [];
  if (markerIds.length) aliases.push({ _id: { $in: markerIds } });
  aliases.push(...ancestors);

  return VideoGenerationNsfwVerdict.findOne({
    workspaceId,
    provider: "higgsfield",
    verdict: "nsfw",
    $or: aliases,
  })
    .read("primary")
    .lean<VideoGenerationNsfwVerdictIdentity | null>();
}

export async function markVideoGenerationNsfwVerdictSweepCompleted(input: {
  markerId: string;
  workspaceId: string;
  providerRequestId: string;
  completedAt: Date;
}): Promise<void> {
  const markerId = boundedIdentifier(input.markerId, 64, "marker");
  const workspaceId = boundedIdentifier(input.workspaceId, 128, "workspace");
  const providerRequestId = boundedIdentifier(
    input.providerRequestId,
    MAX_VIDEO_GENERATION_SAFETY_PROVIDER_REQUEST_ID_LENGTH,
    "provider request"
  );
  if (
    !(input.completedAt instanceof Date) ||
    !Number.isFinite(input.completedAt.getTime())
  ) {
    throw new Error("Invalid video generation NSFW sweep completion time");
  }

  const result = await VideoGenerationNsfwVerdict.updateOne(
    {
      _id: markerId,
      workspaceId,
      provider: "higgsfield",
      providerRequestId,
      verdict: "nsfw",
    },
    {
      $set: {
        sweepCompletedAt: input.completedAt,
      },
    },
    {
      writeConcern: { w: "majority" },
    }
  );
  if (result.matchedCount !== 1) {
    throw new Error("Video generation NSFW verdict disappeared before sweep");
  }
}

export type VideoGenerationNsfwSweepReplayResult = {
  scanned: number;
  completed: number;
  failed: number;
};

export async function replayPendingVideoGenerationNsfwVerdictSweeps(input: {
  now: Date;
  limit: number;
}): Promise<VideoGenerationNsfwSweepReplayResult> {
  if (
    !(input.now instanceof Date) ||
    !Number.isFinite(input.now.getTime()) ||
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  ) {
    throw new Error("Invalid video generation NSFW sweep replay request");
  }

  const verdicts = await VideoGenerationNsfwVerdict.find({
    provider: "higgsfield",
    verdict: "nsfw",
    sweepCompletedAt: null,
  })
    .read("primary")
    .sort({ firstReceivedAt: 1, _id: 1 })
    .limit(input.limit)
    .lean<VideoGenerationNsfwVerdictRecord[]>();
  const result: VideoGenerationNsfwSweepReplayResult = {
    scanned: verdicts.length,
    completed: 0,
    failed: 0,
  };

  const replay = async (
    verdict: VideoGenerationNsfwVerdictRecord
  ): Promise<void> => {
    try {
      const receivedAt =
        verdict.lastReceivedAt instanceof Date &&
        Number.isFinite(verdict.lastReceivedAt.getTime())
          ? verdict.lastReceivedAt
          : input.now;
      await CreativeAsset.updateMany(
        {
          ...buildVideoGenerationNsfwAliasFilter({
            workspaceId: verdict.workspaceId,
            providerRequestId: verdict.providerRequestId,
            sourceAssetId: verdict.sourceAssetId,
            sourceAttemptToken: verdict.sourceAttemptToken,
          }),
          status: {
            $in: ["queued", "in_progress", "complete", "failed"],
          },
        },
        buildVideoGenerationNsfwUpdatePipeline({
          providerRequestId: verdict.providerRequestId,
          receivedAt,
        })
      );
      await markVideoGenerationNsfwVerdictSweepCompleted({
        markerId: verdict._id,
        workspaceId: verdict.workspaceId,
        providerRequestId: verdict.providerRequestId,
        completedAt: input.now,
      });
      result.completed += 1;
    } catch {
      result.failed += 1;
    }
  };

  const concurrency = 10;
  for (let offset = 0; offset < verdicts.length; offset += concurrency) {
    await Promise.all(verdicts.slice(offset, offset + concurrency).map(replay));
  }

  return result;
}
