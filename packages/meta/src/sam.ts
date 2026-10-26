import {
  frameIndexOf,
  parseImageStream,
  parseVideoStream,
  recordsOfKind,
  type ImageSegmentationResult,
  type SegmentationMaskRecord,
  type SegmentationRecord,
  type VideoSegmentationResult,
} from "@meta-sam/parser";
import { samImageCostUsd, samVideoCostUsd } from "./budget.ts";
import type { MetaClient } from "./client.ts";

function samRequest(client: MetaClient, concept: string, media: Record<string, string>) {
  return {
    model: client.config.models.sam,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: concept }, media] }],
    metadata: { include_confidence: "true" },
  };
}

export interface SegmentImageOptions {
  /** A public URL or a data URL such as `data:image/jpeg;base64,...`. */
  readonly imageUrl: string;
  /** One short noun phrase; SAM 3.1 handles lists and negation poorly. */
  readonly concept: string;
}

export async function segmentImage(client: MetaClient, options: SegmentImageOptions): Promise<ImageSegmentationResult> {
  const events = client.streamResponse(
    samRequest(client, options.concept, { type: "input_image", image_url: options.imageUrl }),
    samImageCostUsd(1),
  );
  const parsed = parseImageStream(events);
  for await (const _snapshot of parsed) {
    // Drain the stream; the final result holds every record.
  }
  return parsed.finalResult;
}

export interface SegmentVideoOptions {
  readonly fileId: string;
  /** One short noun phrase per call; SAM 3.1 handles lists and negation poorly. */
  readonly concept: string;
  /** Frames in the clip, for the per-frame price; SAM bills at least 50. */
  readonly frameCount: number;
}

export async function segmentVideo(client: MetaClient, options: SegmentVideoOptions): Promise<VideoSegmentationResult> {
  const events = client.streamResponse(
    samRequest(client, options.concept, { type: "input_video", file_id: options.fileId }),
    samVideoCostUsd(options.frameCount),
  );
  const parsed = parseVideoStream(events);
  for await (const _snapshot of parsed) {
    // Drain the stream; the final result holds every record.
  }
  return parsed.finalResult;
}

/** The mask SAM is most confident about; on a tie, the larger one. */
export function bestMask(records: readonly SegmentationRecord[]): SegmentationMaskRecord | undefined {
  const area = (m: SegmentationMaskRecord) => (m.bounds.right - m.bounds.left) * (m.bounds.bottom - m.bounds.top);
  let best: SegmentationMaskRecord | undefined;
  for (const mask of recordsOfKind(records, "mask")) {
    if (!best) {
      best = mask;
      continue;
    }
    const diff = (mask.confidence ?? 0) - (best.confidence ?? 0);
    if (diff > 0 || (diff === 0 && area(mask) > area(best))) best = mask;
  }
  return best;
}

export interface Track {
  readonly objectId: string;
  readonly frames: number;
  readonly firstFrame: number;
  readonly lastFrame: number;
  /** The frame where the object's box is largest: the best candidate for a product cut-out. */
  readonly bestFrame: number;
  readonly bestBox: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
  readonly maxConfidence?: number;
}

// SAM keeps an object's id while it stays in view, so one track is one physical item.
export function summarizeTracks(records: readonly SegmentationRecord[]): Track[] {
  const tracks = new Map<string, { frames: Set<number>; best: { frame: number; area: number; box: Track["bestBox"] }; confidence?: number }>();
  for (const box of recordsOfKind(records, "box")) {
    const frame = frameIndexOf(box) ?? 0;
    const area = (box.right - box.left) * (box.bottom - box.top);
    const bounds = { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
    const track = tracks.get(box.objectId);
    if (!track) {
      tracks.set(box.objectId, { frames: new Set([frame]), best: { frame, area, box: bounds }, confidence: box.confidence });
      continue;
    }
    track.frames.add(frame);
    if (area > track.best.area) track.best = { frame, area, box: bounds };
    if (box.confidence !== undefined) track.confidence = Math.max(track.confidence ?? 0, box.confidence);
  }
  return [...tracks.entries()]
    .map(([objectId, track]) => ({
      objectId,
      frames: track.frames.size,
      firstFrame: Math.min(...track.frames),
      lastFrame: Math.max(...track.frames),
      bestFrame: track.best.frame,
      bestBox: track.best.box,
      maxConfidence: track.confidence,
    }))
    .sort((a, b) => a.firstFrame - b.firstFrame);
}
