import {
  roundCreativeAssetTimelineSeconds,
  type CreativeAssetTimeline,
} from "@icecore/temporal";
import {
  REFERENCE_VIDEO_PLAN_VERSION,
  referenceVideoPlanInputSchema,
  type ReferenceVideoPlanContent,
} from "./contracts";
import { REFERENCE_VIDEO_RECIPES } from "./recipes";

export type ReferenceVideoPlanSnapshot = ReferenceVideoPlanContent & {
  timeline: CreativeAssetTimeline;
};

export function buildReferenceVideoPlanSnapshot(
  raw: unknown
): ReferenceVideoPlanSnapshot {
  const input = referenceVideoPlanInputSchema.parse(raw);
  const recipe = REFERENCE_VIDEO_RECIPES.find(
    item => item.id === input.recipeId
  )!;
  let duration = 0;
  const scenes = input.scenes.map((selection, index) => {
    const slot = recipe.scenes[index];
    const result = {
      ...selection,
      sourceStart: roundCreativeAssetTimelineSeconds(selection.sourceStart),
      id: slot.id,
      duration: slot.duration,
      timelineStart: duration,
    };
    duration += slot.duration;
    return result;
  });
  return {
    recipeId: recipe.id,
    recipeVersion: REFERENCE_VIDEO_PLAN_VERSION,
    title: input.title,
    ...(input.reference ? { reference: input.reference } : {}),
    scenes,
    duration,
    cost: { amount: 0, currency: "USD", generatedSeconds: 0 },
    timeline: {
      canvas: "9:16",
      duration,
      clips: scenes.map(item => ({ ...item, trackId: "V1" })),
    },
  };
}
