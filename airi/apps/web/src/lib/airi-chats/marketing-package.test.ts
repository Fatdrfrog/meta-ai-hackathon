import {
  normalizeAiriCampaignPackage,
  type AiriMarketingToolAccess,
} from "./marketing-package";

const baseAccess: AiriMarketingToolAccess = {
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
    reason: "Connect Canva to use brand templates.",
    actionHref: "/panel/w/workspace-1/settings/integrations?integration=canva",
  },
  visualGeneration: {
    available: false,
    label: "Visual generation",
    reason: "Connect Higgsfield or use configured Google creative generation.",
    actionHref:
      "/panel/w/workspace-1/settings/integrations?integration=higgsfield",
  },
  audioGeneration: {
    available: false,
    label: "Audio generation",
    reason: "Connect ElevenLabs to generate voiceovers.",
    actionHref:
      "/panel/w/workspace-1/settings/integrations?integration=elevenlabs",
  },
  metaAds: {
    available: false,
    label: "Meta Ads",
    reason: "Connect Meta Ads for ad planning.",
    actionHref:
      "/panel/w/workspace-1/settings/integrations?integration=meta_ads",
  },
};

describe("Airi campaign package", () => {
  it("normalizes a bounded campaign package with tool-aware steps", () => {
    const packageDraft = normalizeAiriCampaignPackage({
      title: "Dormant lead win-back",
      goal: "Recover leads who asked about pricing but did not book.",
      audience: "Warm WhatsApp leads from the last 30 days",
      angle: "Helpful reminder with one low-friction reply",
      evidence: [
        "Recent conversations mention pricing questions.",
        "No matching booking confirmation was found.",
      ],
      tools: baseAccess,
      steps: [
        {
          id: "template",
          kind: "whatsapp_template",
          title: "Create WhatsApp template",
          description: "Draft a compliant re-engagement template.",
          status: "ready",
          tool: "whatsapp",
          actionHref: "/panel/w/workspace-1/messengers/whatsapp-templates",
        },
        {
          id: "video",
          kind: "visual_asset",
          title: "Generate vertical product visual",
          description: "Use the offer angle for a 9:16 creative.",
          status: "blocked",
          tool: "visualGeneration",
          blockers: ["Connect Higgsfield first."],
        },
      ],
      checks: [
        { label: "WhatsApp category", status: "passed" },
        {
          label: "Visual provider",
          status: "blocked",
          detail: "No connected visual provider.",
        },
      ],
      nextAction: "Review the WhatsApp template first.",
    });

    expect(packageDraft).toEqual(
      expect.objectContaining({
        title: "Dormant lead win-back",
        tools: expect.objectContaining({
          visualGeneration: expect.objectContaining({
            available: false,
          }),
        }),
        steps: expect.arrayContaining([
          expect.objectContaining({
            id: "video",
            status: "blocked",
            blockers: ["Connect Higgsfield first."],
          }),
        ]),
      })
    );
  });

  it("rejects oversized or invalid campaign packages", () => {
    expect(
      normalizeAiriCampaignPackage({
        title: "x".repeat(161),
        goal: "Recover leads.",
        audience: "Warm leads",
        angle: "Helpful reminder",
        tools: baseAccess,
        steps: [],
        checks: [],
        nextAction: "Review.",
      })
    ).toBeNull();

    expect(
      normalizeAiriCampaignPackage({
        title: "Campaign",
        goal: "Recover leads.",
        audience: "Warm leads",
        angle: "Helpful reminder",
        tools: baseAccess,
        steps: [
          {
            id: "bad",
            kind: "visual_asset",
            title: "Visual",
            description: "Generate visual",
            status: "ready",
            tool: "visualGeneration",
          },
        ],
        checks: [],
        nextAction: "Review.",
      })
    ).toBeNull();
  });
});
