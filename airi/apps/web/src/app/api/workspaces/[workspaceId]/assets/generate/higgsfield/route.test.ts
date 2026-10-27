const mockResolveGoogleCredentials = jest.fn();
const mockRequireScenarioWorkspaceAccess = jest.fn();
const mockConnectDB = jest.fn();
const mockCreate = jest.fn();
const mockFindOne = jest.fn();
const mockFindByIdAndUpdate = jest.fn();
const mockCountDocuments = jest.fn();
const mockStartHiggsfieldAssetGenerationWorkflow = jest.fn();
const mockIsHiggsfieldWebhookConfigured = jest.fn(() => true);
const mockIsTemporalConfigured = jest.fn(() => true);
type WorkspaceHiggsfieldGenerationAccess = {
  available: boolean;
  reason: string | null;
  sourceId: string | null;
  credentialSource: string | null;
};
const mockResolveWorkspaceHiggsfieldGenerationAccess = jest.fn<
  Promise<WorkspaceHiggsfieldGenerationAccess>,
  [unknown]
>(() =>
  Promise.resolve({
    available: true,
    reason: null,
    sourceId: "source-higgsfield",
    credentialSource: "workspace_source",
  })
);
const mockSubmitGoogleImageGeneration = jest.fn();
const mockStartGoogleVideoGeneration = jest.fn();
const mockStoreCreativeAssetBuffer = jest.fn();
const mockQueueVideoGeneration = jest.fn();
const mockWithWorkspaceCreativeGenerationAdmission = jest.fn(
  async (_workspaceId: string, run: () => Promise<unknown>) => run()
);
const mockWithWorkspacePlatformCreativeGenerationAdmission = jest.fn();
const mockLoggerWarn = jest.fn();
const originalGeminiApiKey = process.env.GEMINI_API_KEY;
const originalFetch = global.fetch;

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/logger", () => ({
  logger: {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
}));

jest.mock("@/lib/higgsfield/higgsfield-client", () => ({
  buildHiggsfieldGenerationRequest: (input: {
    mode: string;
    prompt: string;
    imageUrl?: string;
  }) => ({
    modelId:
      input.mode === "text_to_image"
        ? "higgsfield-ai/soul/standard"
        : "higgsfield-ai/dop/standard",
    body:
      input.mode === "text_to_image"
        ? { prompt: input.prompt, aspect_ratio: "9:16", resolution: "720p" }
        : {
            image_url: input.imageUrl,
            prompt: input.prompt,
            duration: 5,
          },
  }),
}));

jest.mock("@/lib/higgsfield/higgsfield-webhook", () => ({
  isHiggsfieldWebhookConfigured: () => mockIsHiggsfieldWebhookConfigured(),
}));

jest.mock("@/lib/google/creative-assets", () => ({
  getGoogleImageGenerationModel: () => "gemini-3.1-flash-image",
  getGoogleVideoGenerationModel: () => "veo-3.1-generate-preview",
  getGoogleFreeGenerationLimit: () => 10,
  isGoogleCreativeGenerationConfigured: () =>
    Boolean(process.env.GEMINI_API_KEY),
  submitGoogleImageGeneration: (...args: unknown[]) =>
    mockSubmitGoogleImageGeneration(...args),
}));

jest.mock("@/lib/higgsfield/creative-asset-storage", () => ({
  storeCreativeAssetBuffer: (...args: unknown[]) =>
    mockStoreCreativeAssetBuffer(...args),
}));

jest.mock("@/lib/higgsfield/higgsfield-source", () => ({
  resolveWorkspaceHiggsfieldGenerationAccess: (input: unknown) =>
    mockResolveWorkspaceHiggsfieldGenerationAccess(input),
}));

jest.mock("@/lib/elevenlabs/elevenlabs-source", () => ({
  isPlatformElevenLabsConfigured: () => false,
}));

jest.mock("@/lib/temporal/higgsfield-assets", () => ({
  isTemporalConfigured: () => mockIsTemporalConfigured(),
  startHiggsfieldAssetGenerationWorkflow: (...args: unknown[]) =>
    mockStartHiggsfieldAssetGenerationWorkflow(...args),
}));

jest.mock("@/models/creative-asset", () => ({
  CreativeAsset: {
    create: (...args: unknown[]) => mockCreate(...args),
    findOne: (...args: unknown[]) => mockFindOne(...args),
    findByIdAndUpdate: (...args: unknown[]) => mockFindByIdAndUpdate(...args),
    countDocuments: (...args: unknown[]) => mockCountDocuments(...args),
  },
}));

jest.mock("@/lib/creative-assets/video-generation-queue", () => ({
  queueVideoGeneration: (...args: unknown[]) =>
    mockQueueVideoGeneration(...args),
  VideoGenerationQueueError: class VideoGenerationQueueError extends Error {},
}));

jest.mock("@/lib/creative-assets/creative-generation-admission", () => ({
  withWorkspaceCreativeGenerationAdmission: (
    workspaceId: string,
    run: () => Promise<unknown>
  ) => mockWithWorkspaceCreativeGenerationAdmission(workspaceId, run),
  CreativeGenerationAdmissionBusyError: class CreativeGenerationAdmissionBusyError extends Error {},
}));

jest.mock("@/lib/google/creative-credentials", () => ({
  ...jest.requireActual("@/lib/google/creative-credentials"),
  resolveWorkspaceGoogleCreativeCredentials: (...args: unknown[]) =>
    mockResolveGoogleCredentials(...args),
}));
import { OwnCreativeAiSourceRequiredError } from "@/lib/google/creative-credentials";
import { POST } from "./route";

function leanResult<T>(value: T) {
  return {
    lean: jest.fn().mockResolvedValue(value),
  };
}

function postGenerate(body: unknown, idempotencyKey?: string) {
  return POST(
    new Request(
      "http://localhost/api/workspaces/workspace-1/assets/generate/higgsfield",
      {
        method: "POST",
        ...(idempotencyKey
          ? { headers: { "Idempotency-Key": idempotencyKey } }
          : {}),
        body: JSON.stringify(body),
      }
    ) as never,
    { params: Promise.resolve({ workspaceId: "workspace-1" }) }
  );
}

/** The stored result of a completed Google text-to-image generation. */
function googleImageAsset() {
  return {
    _id: "asset-1",
    workspaceId: "workspace-1",
    kind: "image",
    source: "google",
    provider: "google",
    status: "complete",
    prompt: "Premium soup visual",
    url: "https://storage.example.com/google.png",
  };
}

describe("POST /api/workspaces/[workspaceId]/assets/generate/higgsfield", () => {
  afterAll(() => {
    process.env.GEMINI_API_KEY = originalGeminiApiKey;
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveGoogleCredentials.mockResolvedValue({
      sourceId: "source-google",
      apiKey: "customer-key",
    });
    mockCountDocuments.mockReset();
    mockWithWorkspaceCreativeGenerationAdmission.mockImplementation(
      async (_workspaceId: string, run: () => Promise<unknown>) => run()
    );
    mockWithWorkspacePlatformCreativeGenerationAdmission.mockImplementation(
      async (
        input: { assetId: string },
        run: (reservation: {
          assetId: string;
          replay: boolean;
        }) => Promise<unknown>
      ) => ({
        accepted: true,
        replay: false,
        value: await run({ assetId: input.assetId, replay: false }),
        quota: { limit: 10, used: 1, remaining: 9 },
      })
    );
    process.env.GEMINI_API_KEY = "test-google-key";
    global.fetch = originalFetch;
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      supabase: {},
      userId: "user-1",
    });
    mockConnectDB.mockResolvedValue(undefined);
    mockFindOne.mockReturnValue(leanResult(null));
    mockCreate.mockResolvedValue({
      _id: "asset-1",
      workspaceId: "workspace-1",
      kind: "image",
      source: "higgsfield",
      provider: "higgsfield",
      status: "queued",
      prompt: "Premium soup visual",
      createdAt: new Date("2026-05-26T00:00:00.000Z"),
    });
    mockStartHiggsfieldAssetGenerationWorkflow.mockResolvedValue({
      workflowId: "higgsfield-asset:asset-1",
      taskQueue: "airi-conversation",
      duplicate: false,
    });
    mockIsHiggsfieldWebhookConfigured.mockReturnValue(true);
    mockIsTemporalConfigured.mockReturnValue(true);
    mockResolveWorkspaceHiggsfieldGenerationAccess.mockResolvedValue({
      available: true,
      reason: null,
      sourceId: "source-higgsfield",
      credentialSource: "workspace_source",
    });
    mockCountDocuments.mockResolvedValue(0);
    mockSubmitGoogleImageGeneration.mockResolvedValue({
      buffer: Buffer.from("image"),
      mimeType: "image/png",
      fileName: "google-generated-image.png",
      raw: { output_image: { data: "aW1hZ2U=" } },
    });
    mockStartGoogleVideoGeneration.mockResolvedValue({
      name: "operations/google-video-1",
      done: false,
      raw: { name: "operations/google-video-1" },
    });
    mockStoreCreativeAssetBuffer.mockResolvedValue({
      url: "https://storage.example.com/google.png",
      bucket: "creative-assets",
      path: "workspaces/workspace-1/creative-assets/image/asset-1/google.png",
      mimeType: "image/png",
      fileName: "google-generated-image.png",
      fileSize: 5,
    });
    mockQueueVideoGeneration.mockResolvedValue({
      asset: { _id: "asset-2", id: "asset-2", status: "queued" },
    });
  });

  it("creates a queued text-to-image asset and starts the Temporal workflow", async () => {
    const response = await postGenerate({
      mode: "text_to_image",
      prompt: "Premium soup visual",
    });

    expect(response.status).toBe(202);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        kind: "image",
        source: "higgsfield",
        provider: "higgsfield",
        status: "queued",
        prompt: "Premium soup visual",
        modelId: "higgsfield-ai/soul/standard",
      })
    );
    expect(mockStartHiggsfieldAssetGenerationWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        assetId: "asset-1",
        mode: "text_to_image",
        prompt: expect.stringContaining("Premium soup visual"),
        aspectRatio: "9:16",
        resolution: "720p",
      })
    );
    expect(mockFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("uses the connected Google source when signed Higgsfield callback config is missing", async () => {
    mockIsHiggsfieldWebhookConfigured.mockReturnValue(false);
    mockFindByIdAndUpdate.mockResolvedValue(googleImageAsset());

    const response = await postGenerate({
      mode: "text_to_image",
      prompt: "Premium soup visual",
    });
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload.asset.source).toBe("google");
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "google",
        provider: "google",
        modelId: "gemini-3.1-flash-image",
      })
    );
    expect(mockStartHiggsfieldAssetGenerationWorkflow).not.toHaveBeenCalled();
  });

  it("starts Google generation using only the workspace credentials", async () => {
    mockResolveWorkspaceHiggsfieldGenerationAccess.mockResolvedValue({
      available: false,
      reason: "source_required",
      sourceId: null,
      credentialSource: null,
    });
    mockFindByIdAndUpdate.mockResolvedValue(googleImageAsset());

    const response = await postGenerate({
      mode: "text_to_image",
      prompt: "Premium soup visual",
    });
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload.generationProvider).toBe("google");
    expect(payload.freeGenerations).toBeUndefined();
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        source: "google",
        provider: "google",
      })
    );
    expect(mockSubmitGoogleImageGeneration).toHaveBeenCalledWith({
      apiKey: "customer-key",
      prompt: expect.stringContaining("Premium soup visual"),
      aspectRatio: "9:16",
    });
    expect(mockStartHiggsfieldAssetGenerationWorkflow).not.toHaveBeenCalled();
  });

  it("blocks generation when no compatible customer source is connected", async () => {
    mockResolveGoogleCredentials.mockRejectedValueOnce(
      new OwnCreativeAiSourceRequiredError("google")
    );
    mockResolveWorkspaceHiggsfieldGenerationAccess.mockResolvedValue({
      available: false,
      reason: "source_required",
      sourceId: null,
      credentialSource: null,
    });
    mockCountDocuments.mockResolvedValue(10);

    const response = await postGenerate({
      mode: "text_to_image",
      prompt: "Premium soup visual",
    });
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error).toMatch(/Connect your own Google AI/i);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockStartHiggsfieldAssetGenerationWorkflow).not.toHaveBeenCalled();
  });

  it("uses a completed source image asset for image-to-video", async () => {
    const sourceAssetId = "64c13ab08edf48a008793cac";
    mockCreate.mockResolvedValueOnce({
      _id: "asset-2",
      workspaceId: "workspace-1",
      kind: "video",
      source: "higgsfield",
      provider: "higgsfield",
      status: "queued",
      prompt: "Animate steam",
    });
    mockFindOne.mockReturnValue(
      leanResult({
        _id: sourceAssetId,
        workspaceId: "workspace-1",
        kind: "image",
        status: "complete",
        url: "https://cdn.example.com/source.png",
      })
    );

    const response = await postGenerate(
      {
        mode: "image_to_video",
        prompt: "Animate steam",
        sourceAssetId,
      },
      "11111111-1111-4111-8111-111111111111"
    );

    expect(response.status).toBe(202);
    expect(mockQueueVideoGeneration).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      createdBy: "user-1",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      providerPolicy: {
        provider: "higgsfield",
        providerSourceId: "source-higgsfield",
      },
      request: {
        mode: "image_to_video",
        prompt: "Animate steam",
        skill: "video",
        durationSeconds: 5,
        aspectRatio: null,
        resolution: "provider_default",
        sourceAssetId,
        referenceAssetIds: [],
      },
    });
    expect(mockStartHiggsfieldAssetGenerationWorkflow).not.toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        assetId: "asset-2",
        mode: "image_to_video",
        prompt: "Animate steam",
        sourceAssetId,
        imageUrl: "https://cdn.example.com/source.png",
      })
    );
    expect(mockCountDocuments).not.toHaveBeenCalled();
  });

  it("queues Google image-to-video without downloading the source in the route", async () => {
    const sourceAssetId = "64c13ab08edf48a008793cac";
    mockResolveWorkspaceHiggsfieldGenerationAccess.mockResolvedValue({
      available: false,
      reason: "source_required",
      sourceId: null,
      credentialSource: null,
    });
    mockCountDocuments.mockResolvedValueOnce(9).mockResolvedValueOnce(10);
    global.fetch = jest.fn() as never;

    const response = await postGenerate(
      {
        mode: "image_to_video",
        prompt: "  Animate steam  ",
        sourceAssetId,
        duration: 6,
        aspectRatio: "16:9",
      },
      "22222222-2222-4222-8222-222222222222"
    );

    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(mockQueueVideoGeneration).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      createdBy: "user-1",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
      providerPolicy: { provider: "google", providerSourceId: "source-google" },
      request: {
        mode: "image_to_video",
        prompt: "  Animate steam  ",
        skill: "video",
        durationSeconds: 6,
        aspectRatio: "16:9",
        resolution: "720p",
        sourceAssetId,
        referenceAssetIds: [],
      },
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockStartGoogleVideoGeneration).not.toHaveBeenCalled();
    expect(mockCountDocuments).not.toHaveBeenCalled();
    expect(payload.freeGenerations).toBeUndefined();
  });

  it("does not normalize unsupported Google video settings before validation", async () => {
    mockResolveWorkspaceHiggsfieldGenerationAccess.mockResolvedValue({
      available: false,
      reason: "source_required",
      sourceId: null,
      credentialSource: null,
    });
    mockCountDocuments.mockResolvedValue(9);

    const response = await postGenerate(
      {
        mode: "image_to_video",
        prompt: "Animate steam",
        sourceAssetId: "64c13ab08edf48a008793cac",
        duration: 5,
        aspectRatio: "1:1",
        resolution: "1080p",
      },
      "22222222-2222-4222-8222-222222222227"
    );

    expect(response.status).toBe(202);
    expect(mockQueueVideoGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        providerPolicy: {
          provider: "google",
          providerSourceId: "source-google",
        },
        request: expect.objectContaining({
          durationSeconds: 5,
          aspectRatio: "1:1",
          resolution: "1080p",
        }),
      })
    );
  });

  it("does not discard unsupported Higgsfield video settings", async () => {
    const response = await postGenerate(
      {
        mode: "image_to_video",
        prompt: "Animate steam",
        sourceAssetId: "64c13ab08edf48a008793cac",
        duration: 5.5,
        aspectRatio: "16:9",
        resolution: "720p",
      },
      "22222222-2222-4222-8222-222222222228"
    );

    expect(response.status).toBe(202);
    expect(mockQueueVideoGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        providerPolicy: expect.objectContaining({ provider: "higgsfield" }),
        request: expect.objectContaining({
          durationSeconds: 5.5,
          aspectRatio: "16:9",
          resolution: "720p",
        }),
      })
    );
  });

  it("replays an accepted Google video with its pinned customer source", async () => {
    const sourceAssetId = "64c13ab08edf48a008793cac";
    mockFindOne.mockReturnValue(
      leanResult({
        _id: "asset-existing",
        workspaceId: "workspace-1",
        provider: "google",
        providerSourceId: "source-google",
        generation: {
          contractVersion: 1,
          spec: { provider: "google" },
        },
      })
    );
    mockCountDocuments.mockResolvedValue(10);
    mockQueueVideoGeneration.mockResolvedValue({
      asset: {
        _id: "asset-existing",
        id: "asset-existing",
        provider: "google",
        status: "queued",
      },
    });

    const response = await postGenerate(
      {
        mode: "image_to_video",
        prompt: "Animate steam",
        sourceAssetId,
      },
      "22222222-2222-4222-8222-222222222224"
    );

    expect(response.status).toBe(202);
    expect(mockQueueVideoGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "22222222-2222-4222-8222-222222222224",
        providerPolicy: {
          provider: "google",
          providerSourceId: "source-google",
        },
      })
    );
    expect(mockWithWorkspaceCreativeGenerationAdmission).not.toHaveBeenCalled();
  });

  it("replays accepted Higgsfield video without provider, Temporal, or Google quota gates", async () => {
    mockFindOne.mockReturnValue(
      leanResult({
        _id: "asset-existing",
        workspaceId: "workspace-1",
        provider: "higgsfield",
        providerSourceId: "source-higgsfield",
        generation: {
          contractVersion: 1,
          spec: { provider: "higgsfield" },
        },
      })
    );
    mockIsTemporalConfigured.mockReturnValue(false);
    mockResolveWorkspaceHiggsfieldGenerationAccess.mockRejectedValue(
      new Error("provider source unavailable")
    );
    mockCountDocuments.mockRejectedValue(new Error("quota ledger unavailable"));
    mockQueueVideoGeneration.mockResolvedValue({
      asset: {
        _id: "asset-existing",
        id: "asset-existing",
        provider: "higgsfield",
        status: "queued",
      },
    });

    const response = await postGenerate(
      {
        mode: "image_to_video",
        prompt: "Animate steam",
        sourceAssetId: "64c13ab08edf48a008793cac",
      },
      "22222222-2222-4222-8222-222222222225"
    );

    expect(response.status).toBe(202);
    expect(mockQueueVideoGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        providerPolicy: {
          provider: "higgsfield",
          providerSourceId: "source-higgsfield",
        },
      })
    );
    expect(mockIsTemporalConfigured).not.toHaveBeenCalled();
    expect(
      mockResolveWorkspaceHiggsfieldGenerationAccess
    ).not.toHaveBeenCalled();
    expect(mockCountDocuments).not.toHaveBeenCalled();
  });

  it("delegates Google video admission to the durable queue owner", async () => {
    const sourceAssetId = "64c13ab08edf48a008793cac";
    mockResolveWorkspaceHiggsfieldGenerationAccess.mockResolvedValue({
      available: false,
      reason: "source_required",
      sourceId: null,
      credentialSource: null,
    });
    mockFindOne.mockReturnValue(leanResult(null));
    mockCountDocuments.mockResolvedValueOnce(9).mockResolvedValueOnce(10);

    const response = await postGenerate(
      {
        mode: "image_to_video",
        prompt: "Animate steam",
        sourceAssetId,
        duration: 6,
      },
      "22222222-2222-4222-8222-222222222229"
    );

    expect(response.status).toBe(202);
    expect(mockWithWorkspaceCreativeGenerationAdmission).not.toHaveBeenCalled();
    expect(mockQueueVideoGeneration).toHaveBeenCalledTimes(1);
    expect(mockCountDocuments).not.toHaveBeenCalled();
  });

  it("rejects Google video fallback before queue persistence when Temporal is unavailable", async () => {
    mockResolveWorkspaceHiggsfieldGenerationAccess.mockResolvedValue({
      available: false,
      reason: "source_required",
      sourceId: null,
      credentialSource: null,
    });
    mockIsTemporalConfigured.mockReturnValue(false);

    const response = await postGenerate(
      {
        mode: "image_to_video",
        prompt: "Animate steam",
        sourceAssetId: "64c13ab08edf48a008793cac",
      },
      "33333333-3333-4333-8333-333333333333"
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Temporal is not configured for video generation",
    });
    expect(mockQueueVideoGeneration).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("keeps legacy Google text-to-image available when Temporal is unavailable", async () => {
    mockResolveWorkspaceHiggsfieldGenerationAccess.mockResolvedValue({
      available: false,
      reason: "source_required",
      sourceId: null,
      credentialSource: null,
    });
    mockIsTemporalConfigured.mockReturnValue(false);
    mockFindByIdAndUpdate.mockResolvedValue(googleImageAsset());

    const response = await postGenerate({
      mode: "text_to_image",
      prompt: "Premium soup visual",
    });

    expect(response.status).toBe(201);
    expect(mockSubmitGoogleImageGeneration).toHaveBeenCalledTimes(1);
    expect(mockQueueVideoGeneration).not.toHaveBeenCalled();
  });

  it.each([undefined, "not-a-uuid"])(
    "rejects missing or invalid video idempotency keys (%s)",
    async idempotencyKey => {
      const response = await postGenerate(
        {
          mode: "image_to_video",
          prompt: "Animate steam",
          sourceAssetId: "64c13ab08edf48a008793cac",
        },
        idempotencyKey
      );

      expect(response.status).toBe(400);
      expect(mockQueueVideoGeneration).not.toHaveBeenCalled();
    }
  );

  it("returns 400 for invalid JSON without creating an asset", async () => {
    const response = await POST(
      new Request(
        "http://localhost/api/workspaces/workspace-1/assets/generate/higgsfield",
        {
          method: "POST",
          body: "{",
        }
      ) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON body" });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("delegates source validation to the durable queue", async () => {
    const response = await postGenerate(
      {
        mode: "image_to_video",
        prompt: "Animate steam",
        sourceAssetId: "source-image-1",
      },
      "11111111-1111-4111-8111-111111111111"
    );

    expect(response.status).toBe(202);
    expect(mockFindOne).toHaveBeenCalledTimes(1);
    expect(mockFindOne).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      "generation.requestIdempotencyKey":
        "11111111-1111-4111-8111-111111111111",
    });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockQueueVideoGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          sourceAssetId: "source-image-1",
        }),
      })
    );
  });
});
