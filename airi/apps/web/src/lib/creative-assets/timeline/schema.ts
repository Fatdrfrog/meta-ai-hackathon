import {
  CREATIVE_ASSET_TIMELINE_MAX_CAPTION_LENGTH,
  CREATIVE_ASSET_TIMELINE_MAX_CLIPS,
  CREATIVE_ASSET_TIMELINE_MAX_DURATION_SECONDS,
  CREATIVE_ASSET_TIMELINE_MIN_CLIP_SECONDS,
  validateCreativeAssetTimeline,
  hasUnsupportedCreativeAssetTextCharacters,
  normalizeCreativeAssetTimeline,
  type CreativeAssetTimeline,
} from "@icecore/temporal";
import { z } from "zod";

function validateTimelineSemantics(
  timeline: CreativeAssetTimeline,
  context: z.RefinementCtx
) {
  for (const issue of validateCreativeAssetTimeline(timeline)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: issue.path,
      message: issue.message,
    });
  }
}

// Preserve HTTP parsing/stripping, field insertion order, and existing Zod
// boundary messages. Cross-clip rules and text policy use the shared contract.
export const timelineSchema = z
  .object({
    duration: z
      .number()
      .finite()
      .min(CREATIVE_ASSET_TIMELINE_MIN_CLIP_SECONDS)
      .max(CREATIVE_ASSET_TIMELINE_MAX_DURATION_SECONDS),
    canvas: z.literal("9:16").optional(),
    audioTrack: z.enum(["V1", "V2"]).optional(),
    clips: z
      .array(
        z.object({
          id: z.string().trim().min(1).max(160),
          assetId: z
            .string()
            .regex(/^[a-f\d]{24}$/i, "Timeline contains an invalid asset id"),
          trackId: z.enum(["V1", "V2"]),
          timelineStart: z.number().finite().min(0),
          sourceStart: z.number().finite().min(0),
          effect: z.literal("chroma_key").optional(),
          caption: z
            .string()
            .max(CREATIVE_ASSET_TIMELINE_MAX_CAPTION_LENGTH)
            .refine(
              value => !hasUnsupportedCreativeAssetTextCharacters(value),
              "Unsupported caption characters"
            )
            .optional(),
          duration: z
            .number()
            .finite()
            .min(CREATIVE_ASSET_TIMELINE_MIN_CLIP_SECONDS)
            .max(CREATIVE_ASSET_TIMELINE_MAX_DURATION_SECONDS),
        })
      )
      .min(1)
      .max(CREATIVE_ASSET_TIMELINE_MAX_CLIPS),
  })
  .superRefine(validateTimelineSemantics);

// Rounding can move a clip past the render boundary or overflow a finite offset.
// Recheck the normalized values without repeating the transport parse.
export const timelineRenderSchema = timelineSchema
  .transform(normalizeCreativeAssetTimeline)
  .superRefine(validateTimelineSemantics);
