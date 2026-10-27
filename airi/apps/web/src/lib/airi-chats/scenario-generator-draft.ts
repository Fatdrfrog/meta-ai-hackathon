import { z } from "zod";
import { readUniqueStringArray } from "@icecore/shared/lib/value-utils";
import type {
  AiriCampaignPackage,
  AiriMarketingToolAccess,
} from "./marketing-package";

const scenarioGeneratorChannelSchema = z.enum([
  "whatsapp",
  "telegram",
  "email",
]);
const scenarioGeneratorWorkflowKindSchema = z.enum([
  "bulk_campaign",
  "follow_up_workflow",
]);
const scenarioGeneratorSendModeSchema = z.enum(["immediate", "trigger"]);

export const airiScenarioGeneratorDraftSchema = z.object({
  id: z.string().min(1).max(160),
  workspaceId: z.string().min(1).max(160),
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(1_000),
  prompt: z.string().min(1).max(8_000),
  workflowKind: scenarioGeneratorWorkflowKindSchema,
  sendMode: scenarioGeneratorSendModeSchema,
  channels: z.array(scenarioGeneratorChannelSchema).max(3),
  recipientSourceSummary: z.string().min(1).max(600).optional(),
  sourceIds: z.array(z.string().min(1).max(160)).max(30).optional(),
  nextAction: z.string().min(1).max(400).optional(),
});

export type AiriScenarioGeneratorDraft = z.infer<
  typeof airiScenarioGeneratorDraftSchema
>;

export function getAiriScenarioGeneratorDraftStorageKey(workspaceId: string) {
  return `airi:scenario-generator-draft:v1:${workspaceId}`;
}

export function normalizeAiriScenarioGeneratorDraft(
  value: unknown
): AiriScenarioGeneratorDraft | null {
  const parsed = airiScenarioGeneratorDraftSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function hasReadyScenarioStep(packageDraft: AiriCampaignPackage) {
  return packageDraft.steps.some(
    step =>
      step.kind === "scenario" &&
      step.tool === "scenarios" &&
      (step.status === "ready" || step.status === "approval_required")
  );
}

function buildScenarioHandoffStepSummary(
  packageDraft: AiriCampaignPackage
): string {
  return packageDraft.steps
    .filter(step =>
      [
        "whatsapp_template",
        "whatsapp_flow",
        "scenario",
        "measurement",
      ].includes(step.kind)
    )
    .map(step => `- ${step.title}: ${step.description}`)
    .join("\n");
}

export function buildAiriScenarioGeneratorDraft(params: {
  workspaceId: string;
  packageDraft: AiriCampaignPackage;
  access: AiriMarketingToolAccess;
  sourceIds?: string[];
}): AiriScenarioGeneratorDraft | null {
  if (!hasReadyScenarioStep(params.packageDraft)) return null;
  if (!params.access.scenarios.available || !params.access.whatsapp.available) {
    return null;
  }

  const sourceIds = readUniqueStringArray([params.access.whatsapp.sourceId]);
  const scenarioStepSummary = buildScenarioHandoffStepSummary(
    params.packageDraft
  );
  const prompt = [
    `@WhatsApp Build the right scenario for ${params.packageDraft.audience}.`,
    `Goal: ${params.packageDraft.goal}`,
    `Creative angle: ${params.packageDraft.angle}`,
    params.packageDraft.evidence.length > 0
      ? `Evidence: ${params.packageDraft.evidence.join("; ")}`
      : "",
    scenarioStepSummary
      ? `Package steps to preserve:\n${scenarioStepSummary}`
      : "",
    "Choose a bulk campaign structure for launches, announcements, promotions, or broadcast-style audience work. Choose an inbound-message workflow for customer-initiated support, qualification, or lifecycle conversations.",
    "Create reply and post-action follow-up paths only where they are needed. Keep publishing and sending behind review/approval.",
    params.packageDraft.nextAction
      ? `Next action: ${params.packageDraft.nextAction}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return normalizeAiriScenarioGeneratorDraft({
    id: `airi-campaign:${params.packageDraft.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96)}`,
    workspaceId: params.workspaceId,
    title: params.packageDraft.title,
    summary: `${params.packageDraft.goal} ${params.packageDraft.angle}`.trim(),
    prompt,
    workflowKind: "follow_up_workflow",
    sendMode: "trigger",
    channels: ["whatsapp"],
    recipientSourceSummary: params.packageDraft.audience,
    ...(sourceIds.length > 0 ? { sourceIds } : {}),
    nextAction: "Open Airi Create and review the scenario draft.",
  });
}
