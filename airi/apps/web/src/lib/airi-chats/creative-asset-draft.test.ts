import {
  buildAiriCreativeAssetDrafts,
  getAiriCreativeAssetDraftStorageKey,
  normalizeAiriCreativeAssetDraft,
  normalizeAiriCreativeAssetDrafts,
} from "./creative-asset-draft";
import type {
  AiriCampaignPackage,
  AiriMarketingToolAccess,
} from "./marketing-package";

const toolAccess: AiriMarketingToolAccess = {
  whatsapp: {
    available: true,
    label: "WhatsApp",
    source: "workspace_source",
    sourceId: "wa-1",
  },
  scenarios: {
    available: true,
    label: "Scenarios",
    source: "built_in",
  },
  bulkCampaigns: {
    available: true,
    label: "Bulk campaigns",
    source: "built_in",
  },
  canva: {
    available: true,
    label: "Canva",
    source: "workspace_source",
    sourceId: "canva-1",
  },
  visualGeneration: {
    available: true,
    label: "Higgsfield visual generation",
    source: "workspace_source",
    sourceId: "higgsfield-1",
  },
  audioGeneration: {
    available: true,
    label: "ElevenLabs audio generation",
    source: "workspace_source",
    sourceId: "elevenlabs-1",
  },
  metaAds: {
    available: false,
    label: "Meta Ads",
    source: "not_configured",
  },
};

function packageDraft(
  overrides: Partial<AiriCampaignPackage> = {}
): AiriCampaignPackage {
  return {
    title: "Pricing lead win-back",
    goal: "Recover warm leads who asked about pricing.",
    audience: "Warm WhatsApp leads from recent pricing conversations",
    angle: "Helpful follow-up with one clear reply",
    evidence: ["Recent conversations mention pricing."],
    tools: toolAccess,
    steps: [
      {
        id: "canva",
        kind: "canva_design",
        title: "Prepare story design",
        description: "Use brand templates for a WhatsApp story creative.",
        status: "ready",
        tool: "canva",
      },
      {
        id: "video",
        kind: "visual_asset",
        title: "Generate vertical video",
        description: "Create a mobile-first product reveal video.",
        status: "approval_required",
        tool: "visualGeneration",
      },
      {
        id: "voiceover",
        kind: "audio_asset",
        title: "Generate voiceover",
        description: "Create a short voiceover for the campaign.",
        status: "ready",
        tool: "audioGeneration",
      },
    ],
    checks: [],
    nextAction: "Review the creative drafts.",
    ...overrides,
  };
}

describe("Airi creative asset drafts", () => {
  it("normalizes bounded creative asset drafts", () => {
    expect(
      normalizeAiriCreativeAssetDraft({
        id: "airi-creative:pricing:visual",
        workspaceId: "workspace-1",
        kind: "visual_asset",
        title: "Pricing video",
        summary: "Create a short vertical video.",
        prompt: "Vertical product reveal for warm leads.",
        provider: "higgsfield",
        providerSource: "workspace_source",
        mode: "image_to_video",
        sourceIds: ["higgsfield-1", "conversation-1"],
        nextAction: "Upload or select a source image, then generate video.",
      })
    ).toEqual(
      expect.objectContaining({
        kind: "visual_asset",
        provider: "higgsfield",
        mode: "image_to_video",
      })
    );

    expect(
      normalizeAiriCreativeAssetDraft({
        id: "x",
        workspaceId: "workspace-1",
        kind: "visual_asset",
        title: "Too large",
        summary: "Rejected",
        prompt: "x".repeat(1601),
        provider: "higgsfield",
        providerSource: "workspace_source",
        mode: "text_to_image",
      })
    ).toBeNull();
  });

  it("builds provider-specific drafts from ready campaign steps", () => {
    const drafts = buildAiriCreativeAssetDrafts({
      workspaceId: "workspace-1",
      packageDraft: packageDraft(),
      access: toolAccess,
      sourceIds: ["conversation-1", "conversation-1"],
    });

    expect(drafts).toHaveLength(3);
    expect(drafts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "canva_design",
          provider: "canva",
          mode: "canva_template",
          canvaQuery: expect.stringContaining("Pricing lead win-back"),
          sourceIds: ["canva-1", "conversation-1"],
        }),
        expect.objectContaining({
          kind: "visual_asset",
          provider: "higgsfield",
          mode: "image_to_video",
          sourceIds: ["higgsfield-1", "conversation-1"],
        }),
        expect.objectContaining({
          kind: "audio_asset",
          provider: "elevenlabs",
          mode: "text_to_speech",
          sourceIds: ["elevenlabs-1", "conversation-1"],
        }),
      ])
    );
  });

  it("uses Google as the visual provider when visual generation is platform-backed", () => {
    const drafts = buildAiriCreativeAssetDrafts({
      workspaceId: "workspace-1",
      packageDraft: packageDraft({
        steps: [
          {
            id: "image",
            kind: "visual_asset",
            title: "Generate product image",
            description: "Create a mobile-first campaign image.",
            status: "ready",
            tool: "visualGeneration",
          },
        ],
      }),
      access: {
        ...toolAccess,
        visualGeneration: {
          available: true,
          label: "Google visual generation",
          source: "platform_quota",
        },
      },
    });

    expect(drafts).toEqual([
      expect.objectContaining({
        provider: "google",
        providerSource: "platform_quota",
        mode: "text_to_image",
      }),
    ]);
  });

  it("omits drafts for unavailable tools and non-actionable steps", () => {
    const drafts = buildAiriCreativeAssetDrafts({
      workspaceId: "workspace-1",
      packageDraft: packageDraft({
        steps: [
          {
            id: "canva",
            kind: "canva_design",
            title: "Prepare story design",
            description: "Use brand templates.",
            status: "blocked",
            tool: "canva",
          },
          {
            id: "voiceover",
            kind: "audio_asset",
            title: "Generate voiceover",
            description: "Create a short voiceover.",
            status: "ready",
            tool: "audioGeneration",
          },
        ],
      }),
      access: {
        ...toolAccess,
        audioGeneration: {
          available: false,
          label: "Audio generation",
          source: "not_configured",
        },
      },
    });

    expect(drafts).toEqual([]);
  });

  it("normalizes stored draft arrays and exposes a workspace storage key", () => {
    expect(getAiriCreativeAssetDraftStorageKey("workspace-1")).toBe(
      "airi:creative-asset-drafts:v1:workspace-1"
    );
    expect(
      normalizeAiriCreativeAssetDrafts([
        {
          id: "airi-creative:one",
          workspaceId: "workspace-1",
          kind: "audio_asset",
          title: "Voiceover",
          summary: "Short voiceover",
          prompt: "Read this message warmly.",
          provider: "elevenlabs",
          providerSource: "workspace_source",
          mode: "text_to_speech",
        },
        { id: "" },
      ])
    ).toEqual([
      expect.objectContaining({
        kind: "audio_asset",
        mode: "text_to_speech",
      }),
    ]);
  });
});
