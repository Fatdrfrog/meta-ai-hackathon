import { z } from "zod";
import {
  draftArray,
  draftEnum,
  draftObject,
  draftString,
  type AiriDraftResponseSchema,
} from "@/lib/airi-chats/draft-output";

const AIRI_MARKETING_TOOL_KEYS = [
  "whatsapp",
  "scenarios",
  "bulkCampaigns",
  "canva",
  "visualGeneration",
  "audioGeneration",
  "metaAds",
] as const;

export const airiMarketingToolAccessItemSchema = z.object({
  available: z.boolean(),
  label: z.string().trim().min(1).max(80),
  source: z
    .enum(["workspace_source", "platform_quota", "built_in", "not_configured"])
    .optional(),
  sourceId: z.string().trim().min(1).max(160).optional(),
  reason: z.string().trim().min(1).max(240).optional(),
  actionHref: z.string().trim().min(1).max(240).optional(),
});

export const airiMarketingToolAccessSchema = z.object({
  whatsapp: airiMarketingToolAccessItemSchema,
  scenarios: airiMarketingToolAccessItemSchema,
  bulkCampaigns: airiMarketingToolAccessItemSchema,
  canva: airiMarketingToolAccessItemSchema,
  visualGeneration: airiMarketingToolAccessItemSchema,
  audioGeneration: airiMarketingToolAccessItemSchema,
  metaAds: airiMarketingToolAccessItemSchema,
});

export const airiMarketingStepSchema = z.object({
  id: z.string().trim().min(1).max(80),
  kind: z.enum([
    "audience",
    "whatsapp_template",
    "whatsapp_flow",
    "scenario",
    "bulk_campaign",
    "canva_design",
    "visual_asset",
    "audio_asset",
    "meta_ad",
    "measurement",
  ]),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(360),
  status: z.enum(["ready", "approval_required", "blocked", "needs_input"]),
  tool: z.enum(AIRI_MARKETING_TOOL_KEYS),
  actionHref: z.string().trim().min(1).max(240).optional(),
  blockers: z.array(z.string().trim().min(1).max(180)).max(5).optional(),
  outputPreview: z.string().trim().max(600).optional(),
});

export const airiMarketingCheckSchema = z.object({
  label: z.string().trim().min(1).max(100),
  status: z.enum(["passed", "warning", "blocked", "pending"]),
  detail: z.string().trim().max(240).optional(),
});

export const airiCampaignPackageSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    goal: z.string().trim().min(1).max(360),
    audience: z.string().trim().min(1).max(240),
    angle: z.string().trim().min(1).max(240),
    evidence: z.array(z.string().trim().min(1).max(240)).max(8).default([]),
    tools: airiMarketingToolAccessSchema,
    steps: z.array(airiMarketingStepSchema).min(1).max(12),
    checks: z.array(airiMarketingCheckSchema).max(12).default([]),
    nextAction: z.string().trim().min(1).max(240),
  })
  .superRefine((value, ctx) => {
    value.steps.forEach((step, index) => {
      const tool = value.tools[step.tool];
      if (
        !tool.available &&
        (step.status === "ready" || step.status === "approval_required")
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "status"],
          message: `${step.tool} is unavailable, so this step cannot be ready`,
        });
      }
    });
  });

export type AiriMarketingToolAccess = z.infer<
  typeof airiMarketingToolAccessSchema
>;
export type AiriCampaignPackage = z.infer<typeof airiCampaignPackageSchema>;

export function normalizeAiriCampaignPackage(
  value: unknown
): AiriCampaignPackage | null {
  const parsed = airiCampaignPackageSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * responseSchema of the campaign package call, built from the validator
 * above. `tools` and each step's actionHref are left out: the server fills
 * them from the workspace's real tool access (enforceMarketingToolAccess).
 */
export const AIRI_CAMPAIGN_PACKAGE_RESPONSE_SCHEMA: AiriDraftResponseSchema =
  draftObject({
    title: draftString("Short package name, up to 160 characters"),
    goal: draftString("Measurable campaign goal, up to 360 characters"),
    audience: draftString(
      "Specific audience segment and exclusions, up to 240 characters"
    ),
    angle: draftString(
      "Creative angle grounded in the workspace context, up to 240 characters"
    ),
    evidence: draftArray(
      draftString("Up to 240 characters"),
      "Up to 8 short evidence items from chats, KB or attached sources"
    ),
    steps: draftArray(
      draftObject(
        {
          id: draftString("Stable slug, up to 80 characters"),
          kind: draftEnum(airiMarketingStepSchema.shape.kind.options),
          title: draftString("Up to 120 characters"),
          description: draftString(
            "What this step creates, up to 360 characters"
          ),
          status: draftEnum(airiMarketingStepSchema.shape.status.options),
          tool: draftEnum(AIRI_MARKETING_TOOL_KEYS),
          blockers: draftArray(
            draftString("Up to 180 characters"),
            "Up to 5 blockers; empty when none"
          ),
          outputPreview: draftString("Optional preview, up to 600 characters"),
        },
        ["outputPreview"]
      ),
      "1 to 12 steps"
    ),
    checks: draftArray(
      draftObject({
        label: draftString("Up to 100 characters"),
        status: draftEnum(airiMarketingCheckSchema.shape.status.options),
        detail: draftString("Up to 240 characters"),
      }),
      "Up to 12 checks"
    ),
    nextAction: draftString("One concrete next action, up to 240 characters"),
  });
