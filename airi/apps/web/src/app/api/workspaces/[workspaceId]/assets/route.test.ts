const mockConnectDB = jest.fn();
const mockRequireScenarioWorkspaceAccess = jest.fn();
const mockFind = jest.fn();
const mockGetWorkspaceCreativeGenerationQuotas = jest.fn();
const mockResolveGoogleCredentials = jest.fn();
jest.mock("@/lib/google/creative-credentials", () => ({
  resolveWorkspaceGoogleCreativeCredentials: (...args: unknown[]) =>
    mockResolveGoogleCredentials(...args),
}));
const mockIsHiggsfieldWebhookConfigured = jest.fn(() => true);
type WorkspaceGenerationAccess = {
  available: boolean;
  reason: string | null;
  sourceId: string | null;
  credentialSource: string | null;
  apiKey?: string;
  defaultVoiceId?: string | null;
};
const mockResolveWorkspaceHiggsfieldGenerationAccess = jest.fn<
  Promise<WorkspaceGenerationAccess>,
  [unknown]
>(() =>
  Promise.resolve({
    available: true,
    reason: null,
    sourceId: null,
    credentialSource: "platform",
  })
);
const mockSyncWorkspaceGoogleCreativeAssets = jest.fn();
const mockSyncWorkspaceElevenLabsCreativeAssets = jest.fn();
const mockResolveWorkspaceElevenLabsGenerationAccess = jest.fn<
  Promise<WorkspaceGenerationAccess>,
  [unknown]
>(() =>
  Promise.resolve({
    available: true,
    reason: null,
    sourceId: null,
    credentialSource: "platform",
    apiKey: "elevenlabs-platform-key",
    defaultVoiceId: null,
  })
);
const mockSupabase = { storage: { from: jest.fn() } };
const originalGeminiApiKey = process.env.GEMINI_API_KEY;

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));

jest.mock("@/lib/higgsfield/higgsfield-client", () => ({}));

jest.mock("@/lib/google/creative-asset-sync", () => ({
  syncWorkspaceGoogleCreativeAssets: (...args: unknown[]) =>
    mockSyncWorkspaceGoogleCreativeAssets(...args),
}));

jest.mock("@/lib/elevenlabs/creative-asset-sync", () => ({
  syncWorkspaceElevenLabsCreativeAssets: (...args: unknown[]) =>
    mockSyncWorkspaceElevenLabsCreativeAssets(...args),
}));

jest.mock("@/lib/elevenlabs/elevenlabs-source", () => ({
  isPlatformElevenLabsConfigured: () => true,
  resolveWorkspaceElevenLabsGenerationAccess: (input: unknown) =>
    mockResolveWorkspaceElevenLabsGenerationAccess(input),
}));

jest.mock("@/lib/higgsfield/higgsfield-webhook", () => ({
  isHiggsfieldWebhookConfigured: () => mockIsHiggsfieldWebhookConfigured(),
}));

jest.mock("@/lib/higgsfield/higgsfield-source", () => ({
  resolveWorkspaceHiggsfieldGenerationAccess: (input: unknown) =>
    mockResolveWorkspaceHiggsfieldGenerationAccess(input),
}));

jest.mock("@/lib/google/creative-asset-quota", () => ({
  getWorkspaceCreativeGenerationQuotas: (...args: unknown[]) =>
    mockGetWorkspaceCreativeGenerationQuotas(...args),
  canUsePlatformFreeCreativeGeneration: (quota: {
    configured: boolean;
    remaining: number;
  }) => quota.configured && quota.remaining > 0,
}));

jest.mock("@/lib/temporal/higgsfield-assets", () => ({
  isTemporalConfigured: () => true,
}));

jest.mock("@/models/creative-asset", () => ({
  CreativeAsset: {
    find: (...args: unknown[]) => mockFind(...args),
  },
}));

import { GET } from "./route";
import { contractV1VideoAsset } from "@/lib/creative-assets/creative-asset-test-fixtures";

function sortedLimitedLeanResult<T>(value: T) {
  return {
    sort: jest.fn().mockReturnValue({
      limit: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(value),
      }),
    }),
  };
}

function listAssets(query = "") {
  return GET(
    new Request(
      `http://localhost/api/workspaces/workspace-1/assets${query}`
    ) as never,
    { params: Promise.resolve({ workspaceId: "workspace-1" }) }
  );
}

function imageAsset(source: string) {
  return {
    _id: "asset-1",
    workspaceId: "workspace-1",
    kind: "image",
    source,
    provider: source,
    status: "complete",
    url: "https://cdn.example.com/image.jpg",
    createdAt: new Date("2026-05-26T00:00:00.000Z"),
  };
}

describe("GET /api/workspaces/[workspaceId]/assets", () => {
  afterAll(() => {
    process.env.GEMINI_API_KEY = originalGeminiApiKey;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveGoogleCredentials.mockResolvedValue({
      sourceId: "google-1",
      apiKey: "customer-secret",
    });
    process.env.GEMINI_API_KEY = "test-google-key";
    mockConnectDB.mockResolvedValue(undefined);
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      supabase: mockSupabase,
      userId: "user-1",
      accessToken: "user-token",
    });
    mockIsHiggsfieldWebhookConfigured.mockReturnValue(true);
    mockResolveWorkspaceHiggsfieldGenerationAccess.mockResolvedValue({
      available: true,
      reason: null,
      sourceId: null,
      credentialSource: "platform",
    });
    mockSyncWorkspaceGoogleCreativeAssets.mockResolvedValue(undefined);
    mockSyncWorkspaceElevenLabsCreativeAssets.mockResolvedValue(undefined);
    mockResolveWorkspaceElevenLabsGenerationAccess.mockResolvedValue({
      available: true,
      reason: null,
      sourceId: null,
      credentialSource: "platform",
      apiKey: "elevenlabs-platform-key",
      defaultVoiceId: null,
    });
    const availableQuota = {
      configured: true,
      limit: 10,
      used: 0,
      remaining: 10,
    };
    mockGetWorkspaceCreativeGenerationQuotas.mockResolvedValue({
      google: availableQuota,
      platform: availableQuota,
    });
  });

  it("lists workspace assets scoped by workspace and optional kind", async () => {
    mockFind.mockReturnValue(
      sortedLimitedLeanResult([imageAsset("higgsfield")])
    );

    const response = await listAssets("?kind=image");
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockFind).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      kind: "image",
    });
    expect(payload.assets).toEqual([
      expect.objectContaining({
        id: "asset-1",
        workspaceId: "workspace-1",
        kind: "image",
        source: "higgsfield",
        provider: "higgsfield",
        status: "complete",
        url: "https://cdn.example.com/image.jpg",
      }),
    ]);
    expect(payload.higgsfieldConfigured).toBe(true);
    expect(payload.generationProvider).toBe("google");
    expect(payload.freeGenerations).toEqual({
      configured: true,
      limit: 10,
      used: 0,
      remaining: 10,
    });
    expect(mockGetWorkspaceCreativeGenerationQuotas).toHaveBeenCalledTimes(1);
    expect(mockGetWorkspaceCreativeGenerationQuotas).toHaveBeenCalledWith(
      "workspace-1"
    );
  });

  it("never exposes private contract-v1 provider fields in list responses", async () => {
    mockFind.mockReturnValue(
      sortedLimitedLeanResult([contractV1VideoAsset("asset-1")])
    );

    const response = await listAssets();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(JSON.stringify(payload.assets[0])).not.toContain(
      "PRIVATE_TOP_LEVEL_PROMPT"
    );
    expect(JSON.stringify(payload.assets[0])).not.toContain(
      "PRIVATE_PROVIDER_PROMPT"
    );
    expect(JSON.stringify(payload.assets[0])).not.toContain(
      "PRIVATE_PROVIDER_DIAGNOSTIC"
    );
    expect(JSON.stringify(payload.assets[0])).not.toContain(
      "PRIVATE_PROVIDER_URL"
    );
    expect(payload.assets[0]).not.toHaveProperty("providerRequestId");
    expect(payload.assets[0]).not.toHaveProperty("providerSourceId");
    expect(payload.assets[0]).not.toHaveProperty("providerStatusUrl");
    expect(payload.assets[0]).not.toHaveProperty("providerCancelUrl");
  });

  it("skips expensive sync and provider checks for picker asset lists", async () => {
    mockFind.mockReturnValue(sortedLimitedLeanResult([imageAsset("upload")]));

    const response = await listAssets(
      "?kind=image&status=complete&surface=picker"
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.assets).toHaveLength(1);
    expect(mockSyncWorkspaceGoogleCreativeAssets).not.toHaveBeenCalled();
    expect(mockSyncWorkspaceElevenLabsCreativeAssets).not.toHaveBeenCalled();
    expect(
      mockResolveWorkspaceHiggsfieldGenerationAccess
    ).not.toHaveBeenCalled();
    expect(
      mockResolveWorkspaceElevenLabsGenerationAccess
    ).not.toHaveBeenCalled();
  });

  it("returns a tenant-scoped lightweight batch for status polling", async () => {
    const assetIds = ["64b000000000000000000001", "64b000000000000000000002"];
    mockFind.mockReturnValue(
      sortedLimitedLeanResult(
        assetIds.map((_id, index) => ({
          _id,
          workspaceId: "workspace-1",
          kind: "video",
          source: "google",
          provider: "google",
          status: index === 0 ? "in_progress" : "complete",
        }))
      )
    );

    const response = await GET(
      new Request(
        `http://localhost/api/workspaces/workspace-1/assets?surface=status&ids=${assetIds.join(",")}`
      ) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockFind).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      _id: { $in: assetIds },
    });
    expect(payload.assets).toHaveLength(2);
    expect(mockSyncWorkspaceGoogleCreativeAssets).not.toHaveBeenCalled();
    expect(
      mockResolveWorkspaceHiggsfieldGenerationAccess
    ).not.toHaveBeenCalled();
  });

  it("rejects malformed status batch ids before Mongo", async () => {
    const response = await listAssets("?surface=status&ids=not-an-object-id");

    expect(response.status).toBe(400);
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockFind).not.toHaveBeenCalled();
  });

  it("uses connected Google generation when signed Higgsfield callback config is missing", async () => {
    mockIsHiggsfieldWebhookConfigured.mockReturnValue(false);
    mockFind.mockReturnValue(sortedLimitedLeanResult([]));

    const response = await listAssets();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.higgsfieldConfigured).toBe(true);
    expect(payload.generationProvider).toBe("google");
  });

  it("advertises a connected Google source without a connected Higgsfield source", async () => {
    mockResolveWorkspaceHiggsfieldGenerationAccess.mockResolvedValue({
      available: false,
      reason: "source_required",
      sourceId: null,
      credentialSource: null,
    });
    mockFind.mockReturnValue(sortedLimitedLeanResult([]));

    const response = await listAssets();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockResolveWorkspaceHiggsfieldGenerationAccess).toHaveBeenCalledWith(
      {
        supabase: mockSupabase,
        workspaceId: "workspace-1",
      }
    );
    expect(payload.higgsfieldConfigured).toBe(true);
    expect(payload.generationProvider).toBe("google");
    expect(payload.higgsfieldDisabledReason).toBeNull();
  });

  it("keeps customer Google generation available when the platform audio allowance is used", async () => {
    mockResolveWorkspaceHiggsfieldGenerationAccess.mockResolvedValue({
      available: false,
      reason: "source_required",
      sourceId: null,
      credentialSource: null,
    });
    const exhaustedQuota = {
      configured: true,
      limit: 10,
      used: 10,
      remaining: 0,
    };
    mockGetWorkspaceCreativeGenerationQuotas.mockResolvedValue({
      google: exhaustedQuota,
      platform: exhaustedQuota,
    });
    mockFind.mockReturnValue(sortedLimitedLeanResult([]));

    const response = await listAssets();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.higgsfieldConfigured).toBe(true);
    expect(payload.freeGenerations.remaining).toBe(0);
    expect(payload.higgsfieldDisabledReason).toBeNull();
    expect(JSON.stringify(payload)).not.toContain("customer-secret");
  });

  it("still lists assets when optional generation quota metadata is busy", async () => {
    mockGetWorkspaceCreativeGenerationQuotas.mockRejectedValue(
      new Error("Creative generation admission is busy; retry the request")
    );
    mockFind.mockReturnValue(sortedLimitedLeanResult([imageAsset("upload")]));

    const response = await listAssets();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.assets).toEqual([
      expect.objectContaining({
        id: "asset-1",
        workspaceId: "workspace-1",
        kind: "image",
        status: "complete",
      }),
    ]);
    expect(payload.freeGenerations).toBeNull();
    expect(payload.generationProvider).toBe("google");
    expect(payload.higgsfieldConfigured).toBe(true);
    expect(payload.elevenLabsConfigured).toBe(false);
  });

  it("does not advertise platform-funded visuals or audio when no workspace source is connected", async () => {
    mockResolveGoogleCredentials.mockRejectedValue(
      new Error("Source required")
    );
    mockFind.mockReturnValue(sortedLimitedLeanResult([]));
    const response = await listAssets();
    const payload = await response.json();
    expect(payload.higgsfieldConfigured).toBe(false);
    expect(payload.generationProvider).toBeNull();
    expect(payload.higgsfieldDisabledReason).toBe("source_required");
    expect(payload.elevenLabsConfigured).toBe(false);
    expect(payload.elevenLabsDisabledReason).toBe("source_required");
  });

  it("returns a structured error response when listing fails", async () => {
    mockFind.mockImplementation(() => {
      throw new Error("database unavailable");
    });

    const response = await listAssets();
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload).toEqual({ error: "database unavailable" });
  });
});
