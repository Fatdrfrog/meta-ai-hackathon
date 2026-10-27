import {
  buildAiriScenarioGeneratorDraft,
  normalizeAiriScenarioGeneratorDraft,
} from "./scenario-generator-draft";
import type {
  AiriCampaignPackage,
  AiriMarketingToolAccess,
} from "./marketing-package";

const access: AiriMarketingToolAccess = {
  whatsapp: {
    available: true,
    label: "WhatsApp",
    source: "workspace_source",
    sourceId: "wa-1",
  },
  scenarios: { available: true, label: "Scenarios", source: "built_in" },
  bulkCampaigns: {
    available: true,
    label: "Bulk campaigns",
    source: "built_in",
  },
  canva: { available: false, label: "Canva", source: "not_configured" },
  visualGeneration: {
    available: false,
    label: "Visual generation",
    source: "not_configured",
  },
  audioGeneration: {
    available: false,
    label: "Audio generation",
    source: "not_configured",
  },
  metaAds: {
    available: false,
    label: "Meta Ads",
    source: "not_configured",
  },
};

const packageDraft: AiriCampaignPackage = {
  title: "Implementation lead follow-up",
  goal: "Help implementation leads choose their next step.",
  audience: "Warm WhatsApp leads",
  angle: "Helpful setup guidance",
  evidence: [],
  tools: access,
  steps: [
    {
      id: "scenario",
      kind: "scenario",
      title: "Build the scenario",
      description: "Handle the next inbound customer message.",
      status: "approval_required",
      tool: "scenarios",
    },
  ],
  checks: [],
  nextAction: "Review the generated scenario.",
};

describe("Airi scenario generator draft", () => {
  it("strips a retired trigger strategy from a saved v1 draft", () => {
    const draft = normalizeAiriScenarioGeneratorDraft({
      id: "draft-1",
      workspaceId: "workspace-1",
      title: "Support intake",
      summary: "Handle support questions.",
      prompt: "Build an inbound support workflow.",
      workflowKind: "follow_up_workflow",
      sendMode: "trigger",
      channels: ["whatsapp"],
      triggerStrategy: "customer_intent_or_classification",
    });

    expect(draft).not.toBeNull();
    expect(draft).not.toHaveProperty("triggerStrategy");
  });

  it("builds new Airi handoffs without a trigger strategy", () => {
    const draft = buildAiriScenarioGeneratorDraft({
      workspaceId: "workspace-1",
      packageDraft,
      access,
    });

    expect(draft).not.toBeNull();
    expect(draft).not.toHaveProperty("triggerStrategy");
  });
});
