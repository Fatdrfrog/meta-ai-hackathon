import { z } from "zod";
import { readUniqueStringArray } from "@icecore/shared/lib/value-utils";
import type { AiriWhatsAppTemplateDraft } from "./whatsapp-template-drafts";
import type {
  AiriCampaignPackage,
  AiriMarketingToolAccess,
} from "./marketing-package";

const airiBulkCampaignChannelSchema = z.enum(["whatsapp"]);

const airiBulkCampaignTemplateSelectionSchema = z.object({
  name: z.string().trim().min(1).max(512),
  language: z.string().trim().min(1).max(32).default("en"),
  category: z.enum(["MARKETING", "UTILITY", "AUTHENTICATION"]).optional(),
});

export const airiBulkCampaignDraftSchema = z.object({
  id: z.string().trim().min(1).max(160),
  workspaceId: z.string().trim().min(1).max(160),
  title: z.string().trim().min(1).max(160),
  channel: airiBulkCampaignChannelSchema,
  campaignName: z.string().trim().min(1).max(160),
  goal: z.string().trim().min(1).max(360),
  angle: z.string().trim().min(1).max(240),
  recipientSourceSummary: z.string().trim().min(1).max(600),
  templateSelection: airiBulkCampaignTemplateSelectionSchema.optional(),
  templateReadiness: z.enum([
    "select_approved_template",
    "needs_template_approval",
  ]),
  sourceIds: z.array(z.string().trim().min(1).max(160)).max(30).optional(),
  nextAction: z.string().trim().min(1).max(400).optional(),
});

export type AiriBulkCampaignDraft = z.infer<typeof airiBulkCampaignDraftSchema>;

export function getAiriBulkCampaignDraftStorageKey(workspaceId: string) {
  return `airi:bulk-campaign-draft:v1:${workspaceId}`;
}

export function normalizeAiriBulkCampaignDraft(
  value: unknown
): AiriBulkCampaignDraft | null {
  const parsed = airiBulkCampaignDraftSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function hasReadyBulkCampaignStep(packageDraft: AiriCampaignPackage) {
  return packageDraft.steps.some(
    step =>
      step.kind === "bulk_campaign" &&
      step.tool === "bulkCampaigns" &&
      (step.status === "ready" || step.status === "approval_required")
  );
}

function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return slug || "campaign";
}

function templateSelectionFromDraft(
  templateDraft?: AiriWhatsAppTemplateDraft | null
): AiriBulkCampaignDraft["templateSelection"] {
  if (!templateDraft) return undefined;
  return {
    name: templateDraft.name,
    language: templateDraft.language || "en",
    category: templateDraft.category,
  };
}

export function buildAiriBulkCampaignDraft(params: {
  workspaceId: string;
  packageDraft: AiriCampaignPackage;
  access: AiriMarketingToolAccess;
  templateDraft?: AiriWhatsAppTemplateDraft | null;
  sourceIds?: string[];
}): AiriBulkCampaignDraft | null {
  if (!hasReadyBulkCampaignStep(params.packageDraft)) return null;
  if (
    !params.access.bulkCampaigns.available ||
    !params.access.whatsapp.available
  ) {
    return null;
  }

  const templateSelection = templateSelectionFromDraft(params.templateDraft);
  const sourceIds = readUniqueStringArray([
    params.access.whatsapp.sourceId,
    ...(params.sourceIds || []),
  ]);

  return normalizeAiriBulkCampaignDraft({
    id: `airi-bulk:${slugify(params.packageDraft.title)}`,
    workspaceId: params.workspaceId,
    title: params.packageDraft.title,
    channel: "whatsapp",
    campaignName: params.packageDraft.title,
    goal: params.packageDraft.goal,
    angle: params.packageDraft.angle,
    recipientSourceSummary: params.packageDraft.audience,
    ...(templateSelection ? { templateSelection } : {}),
    templateReadiness: templateSelection
      ? "needs_template_approval"
      : "select_approved_template",
    ...(sourceIds.length > 0 ? { sourceIds } : {}),
    nextAction: templateSelection?.name
      ? "Open bulk campaigns after the WhatsApp template is approved, then review recipients and send limits."
      : "Open bulk campaigns, select an approved WhatsApp template, then review recipients and send limits.",
  });
}
