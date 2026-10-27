import { z } from "zod";
import {
  draftArray,
  draftEnum,
  draftObject,
  draftString,
  type AiriDraftResponseSchema,
} from "@/lib/airi-chats/draft-output";

const AIRI_OPPORTUNITY_ARTIFACT_KINDS = [
  "whatsapp_template",
  "whatsapp_flow",
  "scenario",
  "bulk_campaign",
  "creative_asset",
  "meta_ad",
  "kb_article",
] as const;

export const airiOpportunitySchema = z.object({
  id: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(120),
  priority: z.enum(["high", "medium", "low"]),
  problem: z.string().trim().min(1).max(360),
  customerSignal: z.string().trim().min(1).max(360),
  recommendedAction: z.string().trim().min(1).max(360),
  evidence: z.array(z.string().trim().min(1).max(220)).min(1).max(5),
  recommendedArtifacts: z
    .array(z.enum(AIRI_OPPORTUNITY_ARTIFACT_KINDS))
    .min(1)
    .max(6),
  missingInputs: z.array(z.string().trim().min(1).max(180)).max(5).default([]),
});

export const airiOpportunityScanSchema = z.object({
  title: z.string().trim().min(1).max(160),
  summary: z.string().trim().min(1).max(500),
  opportunities: z.array(airiOpportunitySchema).min(1).max(8),
  nextAction: z.string().trim().min(1).max(240),
});

export type AiriOpportunityScan = z.infer<typeof airiOpportunityScanSchema>;

export function normalizeAiriOpportunityScan(
  value: unknown
): AiriOpportunityScan | null {
  const parsed = airiOpportunityScanSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * responseSchema of the opportunity scan call, built from the validator
 * above: same keys and enums, every field required.
 */
export const AIRI_OPPORTUNITY_SCAN_RESPONSE_SCHEMA: AiriDraftResponseSchema =
  draftObject({
    title: draftString("Short scan title, up to 160 characters"),
    summary: draftString(
      "What the scan found and why it matters, up to 500 characters"
    ),
    opportunities: draftArray(
      draftObject({
        id: draftString("Stable slug, up to 80 characters"),
        title: draftString("Opportunity name, up to 120 characters"),
        priority: draftEnum(airiOpportunitySchema.shape.priority.options),
        problem: draftString("Up to 360 characters"),
        customerSignal: draftString(
          "Concrete signal from customer channels, chats, sources or setup, up to 360 characters"
        ),
        recommendedAction: draftString(
          "Concrete Airi action to take next, up to 360 characters"
        ),
        evidence: draftArray(
          draftString("Up to 220 characters"),
          "1 to 5 short grounded evidence items"
        ),
        recommendedArtifacts: draftArray(
          draftEnum(AIRI_OPPORTUNITY_ARTIFACT_KINDS),
          "1 to 6 artifact kinds"
        ),
        missingInputs: draftArray(
          draftString("Up to 180 characters"),
          "Up to 5 missing details; empty when none"
        ),
      }),
      "1 to 8 ranked opportunities"
    ),
    nextAction: draftString("One concrete next action, up to 240 characters"),
  });
