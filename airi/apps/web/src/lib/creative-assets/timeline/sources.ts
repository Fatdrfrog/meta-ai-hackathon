import "server-only";

import {
  CREATIVE_ASSET_TIMELINE_CLIP_END_TOLERANCE_SECONDS,
  creativeAssetTimelineSourceKey,
  type CreativeAssetTimeline,
} from "@icecore/temporal";
import type { LeanCreativeAsset } from "@/lib/higgsfield/creative-asset-serialization";
import { CreativeAsset } from "@/models/creative-asset";

export class TimelineRenderValidationError extends Error {}
/** The command or persistence boundary must parse the timeline before loading sources. */
export async function validateTimelineSources(
  workspaceId: string,
  timeline: CreativeAssetTimeline
): Promise<LeanCreativeAsset[]> {
  // Mongo serializes ObjectIds in lowercase; preserve the original timeline
  // bytes while deduplicating case variants of the same physical source.
  const sourceIds = [
    ...new Set(
      timeline.clips.map(clip => creativeAssetTimelineSourceKey(clip.assetId))
    ),
  ];
  const found = (await CreativeAsset.find({
    _id: { $in: sourceIds },
    workspaceId,
  })
    .select({
      _id: 1,
      workspaceId: 1,
      kind: 1,
      status: 1,
      url: 1,
      "generation.result.durationSeconds": 1,
    })
    .lean()) as LeanCreativeAsset[];
  const assetsById = new Map(
    found.map(asset => [
      creativeAssetTimelineSourceKey(String(asset._id)),
      asset,
    ])
  );
  const sources = sourceIds.map(assetId => {
    const asset = assetsById.get(assetId);
    if (
      !asset ||
      asset.workspaceId !== workspaceId ||
      !["video", "image"].includes(asset.kind || "") ||
      asset.status !== "complete" ||
      !asset.url?.trim()
    ) {
      throw new TimelineRenderValidationError(
        "Timeline clips require completed image or video assets in this workspace"
      );
    }
    return asset;
  });
  for (const clip of timeline.clips) {
    const asset = assetsById.get(creativeAssetTimelineSourceKey(clip.assetId))!;
    if (asset.kind === "image" && clip.sourceStart !== 0) {
      throw new TimelineRenderValidationError("Image clips must start at zero");
    }
    const knownDuration = asset.generation?.result?.durationSeconds;
    if (
      asset.kind === "video" &&
      typeof knownDuration === "number" &&
      clip.sourceStart + clip.duration >
        knownDuration + CREATIVE_ASSET_TIMELINE_CLIP_END_TOLERANCE_SECONDS
    ) {
      throw new TimelineRenderValidationError(
        "A selected video is too short for its scene"
      );
    }
  }
  return sources;
}
