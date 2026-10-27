import {
  CREATIVE_ASSET_TIMELINE_MAX_CAPTION_LENGTH,
  CREATIVE_ASSET_TIMELINE_MAX_DURATION_SECONDS,
  hasUnsupportedCreativeAssetTextCharacters,
} from "@icecore/temporal";
import { z } from "zod";
import { isTikTokDiscoveryIdentifier } from "../tiktok-marketing-templates";
import { REFERENCE_VIDEO_RECIPES } from "./recipes";

export const REFERENCE_VIDEO_PLAN_VERSION = 1;
export const MAX_REFERENCE_VIDEO_TITLE_LENGTH = 120;

export const referenceVideoPlanIdSchema = z.string().regex(/^[a-f\d]{24}$/i);
export const referenceVideoPlanApprovalSchema = z
  .object({ hash: z.string().regex(/^[a-f\d]{64}$/) })
  .strict();

const safeText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine(
      value => !hasUnsupportedCreativeAssetTextCharacters(value),
      "Text contains unsupported control characters"
    );

const referenceSchema = z
  .object({
    providerVideoId: z.string().refine(isTikTokDiscoveryIdentifier),
    shareUrl: z.string().url().max(2048),
    title: safeText(300),
  })
  .strict()
  .refine(value => {
    try {
      const url = new URL(value.shareUrl);
      const path = url.pathname.match(/^\/@[^/]+\/video\/([^/]+)$/);
      // Discovery IDs are opaque provider identities, separate from public URL IDs.
      return (
        url.protocol === "https:" &&
        ["www.tiktok.com", "tiktok.com", "m.tiktok.com"].includes(
          url.hostname
        ) &&
        !url.username &&
        !url.password &&
        !url.port &&
        isTikTokDiscoveryIdentifier(path?.[1])
      );
    } catch {
      return false;
    }
  }, "Use a canonical TikTok video reference");

export const referenceVideoPlanInputSchema = z
  .object({
    recipeId: z.string(),
    title: safeText(MAX_REFERENCE_VIDEO_TITLE_LENGTH).refine(
      value => value.length > 0,
      "Enter a video title"
    ),
    reference: referenceSchema.optional(),
    scenes: z
      .array(
        z
          .object({
            assetId: z.string().regex(/^[a-f\d]{24}$/i, "Choose a valid asset"),
            caption: safeText(CREATIVE_ASSET_TIMELINE_MAX_CAPTION_LENGTH),
            sourceStart: z
              .number()
              .finite()
              .min(0)
              .max(CREATIVE_ASSET_TIMELINE_MAX_DURATION_SECONDS),
          })
          .strict()
      )
      .min(1)
      .max(6),
  })
  .strict()
  .superRefine((value, context) => {
    const recipe = REFERENCE_VIDEO_RECIPES.find(
      item => item.id === value.recipeId
    );
    if (!recipe)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recipeId"],
        message: "Choose a supported editing format",
      });
    else if (recipe.scenes.length !== value.scenes.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scenes"],
        message: "Assign an asset to every scene in this format",
      });
  });

export type ReferenceVideoPlanInput = z.infer<
  typeof referenceVideoPlanInputSchema
>;
export type ReferenceVideoReference = NonNullable<
  ReferenceVideoPlanInput["reference"]
>;
export type ReferenceVideoPlanScene =
  ReferenceVideoPlanInput["scenes"][number] & {
    id: string;
    duration: number;
    timelineStart: number;
  };
export type ReferenceVideoPlanContent = {
  recipeId: string;
  recipeVersion: typeof REFERENCE_VIDEO_PLAN_VERSION;
  title: string;
  reference?: ReferenceVideoReference;
  scenes: ReferenceVideoPlanScene[];
  duration: number;
  cost: { amount: 0; currency: "USD"; generatedSeconds: 0 };
};
export type ReferenceVideoPlan = ReferenceVideoPlanContent & {
  id: string;
  hash: string;
  expiresAt: string;
  outputAssetId: string;
  status: "draft" | "approved";
};
