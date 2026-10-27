import "server-only";

import {
  AIRI_TIMELINE_RENDER_MODEL_ID,
  type CreativeAssetTimeline,
} from "@icecore/temporal";
import type { LeanCreativeAsset } from "@/lib/higgsfield/creative-asset-serialization";
import { startCreativeAssetEditWorkflow } from "@/lib/temporal/creative-asset-edits";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import { CreativeAsset } from "@/models/creative-asset";
import { createHash } from "node:crypto";
import { Types } from "mongoose";
import { timelineRenderSchema } from "./schema";
import { validateTimelineSources } from "./sources";
export function timelineFingerprint(timeline: CreativeAssetTimeline): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        duration: timeline.duration,
        ...(timeline.canvas ? { canvas: timeline.canvas } : {}),
        ...(timeline.audioTrack ? { audioTrack: timeline.audioTrack } : {}),
        clips: timeline.clips.map(({ id: _id, ...clip }) => clip),
      })
    )
    .digest("hex");
}

type QueueInput = {
  workspaceId: string;
  userId?: string | null;
  sourceAssetId: string;
  timeline: CreativeAssetTimeline;
  title: string;
  outputAssetId?: string;
  planId?: string;
};

export async function queueTimelineRender(
  input: QueueInput
): Promise<{ asset: LeanCreativeAsset; duplicate: boolean }> {
  const timeline = timelineRenderSchema.parse(input.timeline);
  await validateTimelineSources(input.workspaceId, timeline);
  const fingerprint = timelineFingerprint(timeline);
  const editFingerprint = input.planId
    ? `reference-plan:${input.planId}`
    : fingerprint;
  const query = input.outputAssetId
    ? { _id: input.outputAssetId, workspaceId: input.workspaceId }
    : {
        workspaceId: input.workspaceId,
        source: "edited",
        provider: "airi",
        sourceAssetId: input.sourceAssetId,
        modelId: AIRI_TIMELINE_RENDER_MODEL_ID,
        editFingerprint,
        status: { $in: ["queued", "in_progress", "complete"] },
      };
  let asset = (await CreativeAsset.findOne(
    query
  ).lean()) as LeanCreativeAsset | null;
  let duplicate = Boolean(asset);
  if (!asset) {
    try {
      const created = await CreativeAsset.create({
        _id: input.outputAssetId
          ? new Types.ObjectId(input.outputAssetId)
          : new Types.ObjectId(),
        workspaceId: input.workspaceId,
        kind: "video",
        source: "edited",
        provider: "airi",
        status: "queued",
        storageProvider: "gcs",
        prompt: input.title,
        fileName: input.planId
          ? `${input.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").slice(0, 100) || "Business video"}.mp4`
          : undefined,
        modelId: AIRI_TIMELINE_RENDER_MODEL_ID,
        sourceAssetId: input.sourceAssetId,
        editFingerprint,
        providerPayload: {
          operation: "timeline_render",
          provider: "airi",
          processor: "ffmpeg-timeline-renderer",
          modelId: AIRI_TIMELINE_RENDER_MODEL_ID,
          sourceAssetId: input.sourceAssetId,
          timelineFingerprint: fingerprint,
          timeline,
          outputContainerAndCodec: "mp4_h264_aac",
          ...(input.planId ? { referenceVideoPlanId: input.planId } : {}),
        },
        createdBy: input.userId || null,
        updatedBy: input.userId || null,
      });
      asset =
        typeof created.toObject === "function"
          ? (created.toObject() as LeanCreativeAsset)
          : (created as LeanCreativeAsset);
    } catch (error) {
      if (!isMongoDuplicateKeyError(error)) throw error;
      asset = (await CreativeAsset.findOne(
        query
      ).lean()) as LeanCreativeAsset | null;
      if (!asset) throw error;
      duplicate = true;
    }
  }
  if (!asset) throw new Error("Unable to create timeline output");
  if (
    input.outputAssetId &&
    (String(asset._id) !== input.outputAssetId ||
      asset.editFingerprint !== editFingerprint ||
      asset.sourceAssetId !== input.sourceAssetId ||
      asset.modelId !== AIRI_TIMELINE_RENDER_MODEL_ID)
  )
    throw new Error("Reserved output does not match the approved plan");
  if (["queued", "in_progress"].includes(asset.status || "")) {
    // An ambiguous start must leave this same output retryable. Temporal rejects a
    // second execution of its deterministic output-ID workflow.
    const started = await startCreativeAssetEditWorkflow({
      workspaceId: input.workspaceId,
      sourceAssetId: input.sourceAssetId,
      outputAssetId: String(asset._id),
      operation: "timeline_render",
      timeline,
    });
    if (started.duplicate) {
      duplicate = true;
      const execution = await started.handle.describe();
      if (execution.status.name !== "RUNNING") {
        // A deleted output can be recreated with its reserved ID, but Temporal
        // will never execute that closed workflow again. Re-read first because
        // the worker may have completed after the original queued-state read.
        const outputQuery = {
          _id: String(asset._id),
          workspaceId: input.workspaceId,
          sourceAssetId: input.sourceAssetId,
          modelId: AIRI_TIMELINE_RENDER_MODEL_ID,
          editFingerprint,
        };
        let current = (await CreativeAsset.findOne(
          outputQuery
        ).lean()) as LeanCreativeAsset | null;
        if (
          current &&
          ["queued", "in_progress"].includes(current.status || "")
        ) {
          const reconciled = (await CreativeAsset.findOneAndUpdate(
            { ...outputQuery, status: { $in: ["queued", "in_progress"] } },
            {
              $set: {
                status: "failed",
                error:
                  "This render has already ended and cannot be resumed. Save and approve a new video plan.",
                updatedAt: new Date(),
                updatedBy: input.userId || null,
              },
            },
            { new: true }
          ).lean()) as LeanCreativeAsset | null;
          // A finishing worker or concurrent deletion can win the conditional
          // update. Return the current terminal state without overwriting it.
          current =
            reconciled ||
            ((await CreativeAsset.findOne(
              outputQuery
            ).lean()) as LeanCreativeAsset | null);
        }
        if (!current)
          throw new Error(
            "The render output is unavailable. Save and approve a new video plan."
          );
        asset = current;
      }
    }
  }
  return { asset, duplicate };
}
