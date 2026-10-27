const mockResolveWorkspaceHiggsfieldGenerationAccess = jest.fn();
const mockResolveWorkspaceElevenLabsGenerationAccess = jest.fn();
const mockIsHiggsfieldWebhookConfigured = jest.fn();
const mockIsTemporalConfigured = jest.fn();
const mockGetWorkspaceGoogleCreativeGenerationQuota = jest.fn();
const mockIsAlibabaImageConfigured = jest.fn();
const mockResolveGoogleCredentials = jest.fn();
jest.mock("@/lib/google/creative-credentials", () => ({
  resolveWorkspaceGoogleCreativeCredentials: (...args: unknown[]) =>
    mockResolveGoogleCredentials(...args),
}));

jest.mock("@/lib/alibaba/qwen-image-config", () => ({
  isAlibabaImageConfigured: () => mockIsAlibabaImageConfigured(),
}));

jest.mock("@/lib/higgsfield/higgsfield-source", () => ({
  resolveWorkspaceHiggsfieldGenerationAccess: (...args: unknown[]) =>
    mockResolveWorkspaceHiggsfieldGenerationAccess(...args),
}));

jest.mock("@/lib/elevenlabs/elevenlabs-source", () => ({
  resolveWorkspaceElevenLabsGenerationAccess: (...args: unknown[]) =>
    mockResolveWorkspaceElevenLabsGenerationAccess(...args),
}));

jest.mock("@/lib/higgsfield/higgsfield-webhook", () => ({
  isHiggsfieldWebhookConfigured: () => mockIsHiggsfieldWebhookConfigured(),
}));

jest.mock("@/lib/temporal/higgsfield-assets", () => ({
  isTemporalConfigured: () => mockIsTemporalConfigured(),
}));

import { resolveAiriMarketingToolAccess } from "./marketing-tool-access";

function supabaseWithSources(
  sources: Array<{ id: string; type: string; name?: string | null }>
) {
  return {
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      in: jest.fn().mockResolvedValue({ data: sources, error: null }),
    })),
  };
}

describe("resolveAiriMarketingToolAccess", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAlibabaImageConfigured.mockReturnValue(false);
    mockResolveGoogleCredentials.mockRejectedValue(
      new Error("Source required")
    );
    mockResolveWorkspaceHiggsfieldGenerationAccess.mockResolvedValue({
      available: true,
      credentialSource: "platform",
      sourceId: null,
      reason: null,
    });
    mockResolveWorkspaceElevenLabsGenerationAccess.mockResolvedValue({
      available: true,
      credentialSource: "platform",
      sourceId: null,
      reason: null,
      apiKey: "platform-key",
      defaultVoiceId: null,
    });
    mockIsHiggsfieldWebhookConfigured.mockReturnValue(true);
    mockIsTemporalConfigured.mockReturnValue(true);
    mockGetWorkspaceGoogleCreativeGenerationQuota.mockResolvedValue({
      configured: false,
      limit: 10,
      used: 0,
      remaining: 0,
    });
  });

  it("does not treat platform Higgsfield or ElevenLabs keys as workspace tools", async () => {
    const access = await resolveAiriMarketingToolAccess({
      supabase: supabaseWithSources([]) as never,
      workspaceId: "workspace-1",
    });

    expect(access.canva.available).toBe(false);
    expect(access.visualGeneration.available).toBe(false);
    expect(access.audioGeneration.available).toBe(false);
    expect(access.visualGeneration.actionHref).toContain("/assets");
    expect(access.audioGeneration.actionHref).toContain(
      "integration=elevenlabs"
    );
  });

  it("does not advertise platform-only Alibaba generation", async () => {
    mockIsAlibabaImageConfigured.mockReturnValue(true);

    const access = await resolveAiriMarketingToolAccess({
      supabase: supabaseWithSources([]) as never,
      workspaceId: "workspace-1",
    });

    expect(access.visualGeneration).toEqual(
      expect.objectContaining({
        available: false,
        source: "not_configured",
      })
    );
  });

  it("requires a customer Google source even while platform quota remains", async () => {
    mockGetWorkspaceGoogleCreativeGenerationQuota.mockResolvedValue({
      configured: true,
      limit: 10,
      used: 2,
      remaining: 8,
    });

    const access = await resolveAiriMarketingToolAccess({
      supabase: supabaseWithSources([]) as never,
      workspaceId: "workspace-1",
    });

    expect(access.visualGeneration).toEqual(
      expect.objectContaining({
        available: false,
        source: "not_configured",
      })
    );
    expect(access.audioGeneration.available).toBe(false);
  });

  it("advertises connected Google credentials without returning the key", async () => {
    mockResolveGoogleCredentials.mockResolvedValue({
      sourceId: "google-1",
      apiKey: "customer-secret",
    });
    const access = await resolveAiriMarketingToolAccess({
      supabase: supabaseWithSources([]) as never,
      workspaceId: "workspace-1",
    });
    expect(access.visualGeneration).toMatchObject({
      available: true,
      source: "workspace_source",
      sourceId: "google-1",
      label: "Google visual generation",
    });
    expect(JSON.stringify(access)).not.toContain("customer-secret");
  });

  it("marks connected workspace creative sources as available", async () => {
    mockResolveWorkspaceHiggsfieldGenerationAccess.mockResolvedValue({
      available: true,
      credentialSource: "workspace_source",
      sourceId: "higgsfield-1",
      reason: null,
    });
    mockResolveWorkspaceElevenLabsGenerationAccess.mockResolvedValue({
      available: true,
      credentialSource: "workspace_source",
      sourceId: "elevenlabs-1",
      reason: null,
      apiKey: "workspace-key",
      defaultVoiceId: "voice-1",
    });

    const access = await resolveAiriMarketingToolAccess({
      supabase: supabaseWithSources([
        { id: "wa-1", type: "whatsapp", name: "Main WhatsApp" },
        { id: "canva-1", type: "canva", name: "Canva" },
        { id: "meta-ads-1", type: "meta_ads", name: "Meta Ads" },
      ]) as never,
      workspaceId: "workspace-1",
    });

    expect(access.whatsapp).toEqual(
      expect.objectContaining({
        available: true,
        sourceId: "wa-1",
      })
    );
    expect(access.canva).toEqual(
      expect.objectContaining({
        available: true,
        sourceId: "canva-1",
      })
    );
    expect(access.visualGeneration).toEqual(
      expect.objectContaining({
        available: true,
        source: "workspace_source",
        sourceId: "higgsfield-1",
      })
    );
    expect(access.audioGeneration).toEqual(
      expect.objectContaining({
        available: true,
        source: "workspace_source",
        sourceId: "elevenlabs-1",
      })
    );
    expect(access.metaAds.available).toBe(true);
  });
});
