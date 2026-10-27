import {
  buildAiriBulkCampaignDraft,
  normalizeAiriBulkCampaignDraft,
} from "./bulk-campaign-draft";
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
    actionHref: "/panel/w/workspace-1/messengers/whatsapp-templates",
  },
  scenarios: {
    available: true,
    label: "Scenarios",
    source: "built_in",
    actionHref: "/panel/w/workspace-1/scenarios",
  },
  bulkCampaigns: {
    available: true,
    label: "Bulk campaigns",
    source: "built_in",
    actionHref: "/panel/w/workspace-1/bulk-campaigns",
  },
  canva: {
    available: false,
    label: "Canva",
    source: "not_configured",
  },
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
  goal: "Convert implementation leads into onboarding calls.",
  audience: "Warm WhatsApp leads asking for implementation help",
  angle: "Helpful setup guidance with one easy reply",
  evidence: ["Recent conversations mention implementation help."],
  tools: access,
  steps: [
    {
      id: "bulk",
      kind: "bulk_campaign",
      title: "Prepare bulk campaign",
      description: "Review recipients before dispatch.",
      status: "approval_required",
      tool: "bulkCampaigns",
    },
  ],
  checks: [{ label: "Human approval", status: "pending" }],
  nextAction: "Review the campaign before sending.",
};

describe("Airi bulk campaign draft", () => {
  it("builds a WhatsApp bulk campaign handoff for an approval-ready package", () => {
    const draft = buildAiriBulkCampaignDraft({
      workspaceId: "workspace-1",
      packageDraft,
      access,
      sourceIds: ["conversation:1"],
      templateDraft: {
        kind: "whatsapp_template",
        name: "implementation_lead_follow_up",
        language: "en",
        category: "MARKETING",
        components: [
          {
            type: "BODY",
            text: "Hi {{1}}, want help with implementation?",
          },
        ],
      },
    });

    expect(draft).toEqual(
      expect.objectContaining({
        workspaceId: "workspace-1",
        title: "Implementation lead follow-up",
        channel: "whatsapp",
        campaignName: "Implementation lead follow-up",
        recipientSourceSummary:
          "Warm WhatsApp leads asking for implementation help",
        templateSelection: {
          name: "implementation_lead_follow_up",
          language: "en",
          category: "MARKETING",
        },
        templateReadiness: "needs_template_approval",
        sourceIds: ["wa-1", "conversation:1"],
      })
    );
  });

  it("does not build a draft when WhatsApp is unavailable", () => {
    expect(
      buildAiriBulkCampaignDraft({
        workspaceId: "workspace-1",
        packageDraft,
        access: {
          ...access,
          whatsapp: {
            available: false,
            label: "WhatsApp",
            source: "not_configured",
          },
        },
      })
    ).toBeNull();
  });

  it("rejects oversized untrusted metadata", () => {
    expect(
      normalizeAiriBulkCampaignDraft({
        ...buildAiriBulkCampaignDraft({
          workspaceId: "workspace-1",
          packageDraft,
          access,
        }),
        recipientSourceSummary: "x".repeat(2_000),
      })
    ).toBeNull();
  });
});
