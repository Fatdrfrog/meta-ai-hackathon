import { z } from "zod";
import { readUniqueStringArray } from "@icecore/shared/lib/value-utils";
import type {
  AiriCampaignPackage,
  AiriMarketingToolAccess,
} from "./marketing-package";

const airiCreativeAssetProviderSchema = z.enum([
  "canva",
  "higgsfield",
  "google",
  "elevenlabs",
  "wan",
  "alibaba",
]);

const airiCreativeAssetProviderSourceSchema = z.enum([
  "workspace_source",
  "platform_quota",
  "built_in",
]);

const airiCreativeAssetModeSchema = z.enum([
  "canva_template",
  "text_to_image",
  "image_to_video",
  "text_to_speech",
  "sound_effect",
  "talking_avatar",
]);

export const airiCreativeAssetDraftSchema = z
  .object({
    id: z.string().trim().min(1).max(160),
    workspaceId: z.string().trim().min(1).max(160),
    kind: z.enum(["canva_design", "visual_asset", "audio_asset"]),
    title: z.string().trim().min(1).max(160),
    summary: z.string().trim().min(1).max(360),
    prompt: z.string().trim().min(3).max(1600),
    provider: airiCreativeAssetProviderSchema,
    providerSource: airiCreativeAssetProviderSourceSchema,
    mode: airiCreativeAssetModeSchema,
    canvaQuery: z.string().trim().min(3).max(240).optional(),
    sourceIds: z.array(z.string().trim().min(1).max(160)).max(30).optional(),
    nextAction: z.string().trim().min(1).max(400).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.kind === "canva_design" &&
      (value.provider !== "canva" || value.mode !== "canva_template")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provider"],
        message: "Canva drafts must use the Canva provider and template mode",
      });
    }

    if (
      value.kind === "visual_asset" &&
      (!["higgsfield", "google", "alibaba"].includes(value.provider) ||
        !["text_to_image", "image_to_video"].includes(value.mode))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mode"],
        message: "Visual drafts must use image or video generation",
      });
    }

    if (
      value.kind === "visual_asset" &&
      value.provider === "alibaba" &&
      value.mode !== "text_to_image"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mode"],
        message: "Alibaba visual drafts currently support text_to_image only",
      });
    }

    if (
      value.kind === "audio_asset" &&
      (value.provider !== "elevenlabs" ||
        !["text_to_speech", "sound_effect"].includes(value.mode))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mode"],
        message: "Audio drafts must use an ElevenLabs text generation mode",
      });
    }
  });

export const airiCreativeAssetDraftsSchema = z
  .array(airiCreativeAssetDraftSchema)
  .max(6);

export type AiriCreativeAssetDraft = z.infer<
  typeof airiCreativeAssetDraftSchema
>;

export function getAiriCreativeAssetDraftStorageKey(workspaceId: string) {
  return `airi:creative-asset-drafts:v1:${workspaceId}`;
}

export function normalizeAiriCreativeAssetDraft(
  value: unknown
): AiriCreativeAssetDraft | null {
  const parsed = airiCreativeAssetDraftSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function normalizeAiriCreativeAssetDrafts(
  value: unknown
): AiriCreativeAssetDraft[] {
  if (!Array.isArray(value)) {
    const draft = normalizeAiriCreativeAssetDraft(value);
    return draft ? [draft] : [];
  }

  return value
    .map(item => normalizeAiriCreativeAssetDraft(item))
    .filter((item): item is AiriCreativeAssetDraft => Boolean(item))
    .slice(0, 6);
}

function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "creative";
}

function isActionableCreativeStep(step: AiriCampaignPackage["steps"][number]) {
  return step.status === "ready" || step.status === "approval_required";
}

function containsVideoIntent(value: string) {
  return /\b(video|reel|motion|animate|animation|short|vertical)\b/i.test(
    value
  );
}

function containsSoundEffectIntent(value: string) {
  return /\b(sound effect|sfx|ambience|ambient|chime|jingle|music)\b/i.test(
    value
  );
}

function trimTo(value: string, maxLength: number) {
  const trimmed = value.trim().replace(/\n{3,}/g, "\n\n");
  return trimmed.length > maxLength
    ? trimmed.slice(0, maxLength).trim()
    : trimmed;
}

function buildCreativePrompt(params: {
  packageDraft: AiriCampaignPackage;
  step: AiriCampaignPackage["steps"][number];
}) {
  const evidence = params.packageDraft.evidence.slice(0, 3).join(" ");
  return trimTo(
    [
      `Campaign: ${params.packageDraft.title}`,
      `Goal: ${params.packageDraft.goal}`,
      `Audience: ${params.packageDraft.audience}`,
      `Angle: ${params.packageDraft.angle}`,
      `Creative brief: ${params.step.description}`,
      evidence ? `Evidence: ${evidence}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    1600
  );
}

function sourceIdsFor(
  tool: AiriMarketingToolAccess[keyof AiriMarketingToolAccess],
  sourceIds?: string[]
) {
  return readUniqueStringArray([tool.sourceId, ...(sourceIds || [])]);
}

function visualProvider(
  access: AiriMarketingToolAccess["visualGeneration"],
  mode: AiriCreativeAssetDraft["mode"]
): Pick<AiriCreativeAssetDraft, "provider" | "providerSource"> {
  if (access.source === "built_in" || access.label.startsWith("Alibaba")) {
    if (mode === "text_to_image") {
      return { provider: "alibaba", providerSource: "built_in" };
    }
    // Video still uses Higgsfield / Google until HappyHorse draft wiring lands.
  }
  if (access.source === "platform_quota") {
    return { provider: "google", providerSource: "platform_quota" };
  }
  return { provider: "higgsfield", providerSource: "workspace_source" };
}

function buildCanvaDraft(params: {
  workspaceId: string;
  packageDraft: AiriCampaignPackage;
  step: AiriCampaignPackage["steps"][number];
  access: AiriMarketingToolAccess;
  sourceIds?: string[];
}): AiriCreativeAssetDraft | null {
  if (!params.access.canva.available) return null;

  return normalizeAiriCreativeAssetDraft({
    id: `airi-creative:${slugify(params.packageDraft.title)}:${slugify(params.step.id)}:canva`,
    workspaceId: params.workspaceId,
    kind: "canva_design",
    title: params.step.title,
    summary: trimTo(params.step.description, 360),
    prompt: buildCreativePrompt(params),
    provider: "canva",
    providerSource: "workspace_source",
    mode: "canva_template",
    canvaQuery: trimTo(
      `${params.packageDraft.title} ${params.packageDraft.audience} WhatsApp campaign brand template`,
      240
    ),
    sourceIds: sourceIdsFor(params.access.canva, params.sourceIds),
    nextAction:
      "Open Canva templates, pick a brand-safe layout, then adapt the copy and visual angle.",
  });
}

function buildVisualDraft(params: {
  workspaceId: string;
  packageDraft: AiriCampaignPackage;
  step: AiriCampaignPackage["steps"][number];
  access: AiriMarketingToolAccess;
  sourceIds?: string[];
}): AiriCreativeAssetDraft | null {
  if (!params.access.visualGeneration.available) return null;

  const intentText = `${params.step.title} ${params.step.description}`;
  const mode = containsVideoIntent(intentText)
    ? "image_to_video"
    : "text_to_image";
  const provider = visualProvider(params.access.visualGeneration, mode);
  return normalizeAiriCreativeAssetDraft({
    id: `airi-creative:${slugify(params.packageDraft.title)}:${slugify(params.step.id)}:visual`,
    workspaceId: params.workspaceId,
    kind: "visual_asset",
    title: params.step.title,
    summary: trimTo(params.step.description, 360),
    prompt: buildCreativePrompt(params),
    ...provider,
    mode,
    sourceIds: sourceIdsFor(params.access.visualGeneration, params.sourceIds),
    nextAction:
      mode === "image_to_video"
        ? "Upload or select a source image, review the motion prompt, then generate video."
        : "Review the prompt, then generate the campaign image.",
  });
}

function buildAudioDraft(params: {
  workspaceId: string;
  packageDraft: AiriCampaignPackage;
  step: AiriCampaignPackage["steps"][number];
  access: AiriMarketingToolAccess;
  sourceIds?: string[];
}): AiriCreativeAssetDraft | null {
  if (!params.access.audioGeneration.available) return null;

  const intentText = `${params.step.title} ${params.step.description}`;
  const mode = containsSoundEffectIntent(intentText)
    ? "sound_effect"
    : "text_to_speech";

  return normalizeAiriCreativeAssetDraft({
    id: `airi-creative:${slugify(params.packageDraft.title)}:${slugify(params.step.id)}:audio`,
    workspaceId: params.workspaceId,
    kind: "audio_asset",
    title: params.step.title,
    summary: trimTo(params.step.description, 360),
    prompt: buildCreativePrompt(params),
    provider: "elevenlabs",
    providerSource: "workspace_source",
    mode,
    sourceIds: sourceIdsFor(params.access.audioGeneration, params.sourceIds),
    nextAction:
      mode === "sound_effect"
        ? "Review the sound prompt, then generate the effect."
        : "Review the script, then generate the voiceover.",
  });
}

export function buildAiriCreativeAssetDrafts(params: {
  workspaceId: string;
  packageDraft: AiriCampaignPackage;
  access: AiriMarketingToolAccess;
  sourceIds?: string[];
}): AiriCreativeAssetDraft[] {
  const drafts = params.packageDraft.steps
    .filter(isActionableCreativeStep)
    .map(step => {
      if (step.kind === "canva_design") {
        return buildCanvaDraft({ ...params, step });
      }
      if (step.kind === "visual_asset") {
        return buildVisualDraft({ ...params, step });
      }
      if (step.kind === "audio_asset") {
        return buildAudioDraft({ ...params, step });
      }
      return null;
    })
    .filter((draft): draft is AiriCreativeAssetDraft => Boolean(draft));

  return normalizeAiriCreativeAssetDrafts(drafts);
}
