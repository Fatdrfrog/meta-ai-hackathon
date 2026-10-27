const mockRequireScenarioWorkspaceAccess = jest.fn();
const mockConnectDB = jest.fn();
const mockCreate = jest.fn();
const mockFindById = jest.fn();
const mockFindByIdAndUpdate = jest.fn();
const mockFindOne = jest.fn();
const mockFind = jest.fn();
const mockIsHappyHorseConfigured = jest.fn();
const mockIsTemporalConfigured = jest.fn();
const mockSerializeCreativeAssetForResponse = jest.fn();
const mockQueueVideoGeneration = jest.fn();

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/happyhorse/happyhorse-config", () => ({
  getHappyHorseDefaultRatio: () => "9:16",
  getHappyHorseDefaultResolution: () => "1080P",
  getHappyHorseI2VModel: () => "happyhorse-1.1-i2v",
  getHappyHorseR2VModel: () => "happyhorse-1.1-r2v",
  getHappyHorseT2VModel: () => "happyhorse-1.1-t2v",
  HAPPYHORSE_REFERENCE_MIN: 1,
  HAPPYHORSE_REFERENCE_MAX: 9,
  getHappyHorseModelForMode: (mode: string) =>
    mode === "text_to_video"
      ? "happyhorse-1.1-t2v"
      : mode === "reference_to_video"
        ? "happyhorse-1.1-r2v"
        : "happyhorse-1.1-i2v",
  isHappyHorseConfigured: (...args: unknown[]) =>
    mockIsHappyHorseConfigured(...args),
  normalizeHappyHorseDuration: (value: unknown) =>
    typeof value === "number" && value >= 3 && value <= 15
      ? Math.round(value)
      : null,
  normalizeHappyHorseRatio: (value: unknown) =>
    value === "9:16" || value === "16:9" ? value : null,
  normalizeHappyHorseResolution: (value: unknown) =>
    value === "720P" || value === "1080P" ? value : null,
}));

jest.mock("@/lib/temporal/client", () => ({
  ...jest.requireActual("@/lib/temporal/client"),
  isTemporalConfigured: (...args: unknown[]) =>
    mockIsTemporalConfigured(...args),
}));

jest.mock("@/lib/higgsfield/creative-asset-serialization", () => ({
  serializeCreativeAssetForResponse: (...args: unknown[]) =>
    mockSerializeCreativeAssetForResponse(...args),
}));

jest.mock("@/models/creative-asset", () => ({
  CreativeAsset: {
    create: (...args: unknown[]) => mockCreate(...args),
    findById: (...args: unknown[]) => mockFindById(...args),
    findByIdAndUpdate: (...args: unknown[]) => mockFindByIdAndUpdate(...args),
    findOne: (...args: unknown[]) => mockFindOne(...args),
    find: (...args: unknown[]) => mockFind(...args),
  },
}));

jest.mock("@/lib/creative-assets/video-generation-queue", () => ({
  queueVideoGeneration: (...args: unknown[]) =>
    mockQueueVideoGeneration(...args),
  VideoGenerationQueueError: class VideoGenerationQueueError extends Error {},
}));

import { GET, POST } from "./route";

const params = Promise.resolve({ workspaceId: "workspace-1" });
const IMAGE_ID = "507f1f77bcf86cd799439011";
const IMAGE_ID_2 = "507f1f77bcf86cd799439012";
const OUTPUT_ID = "507f1f77bcf86cd799439013";

function request(body?: unknown, idempotencyKey?: string) {
  return new Request(
    "http://localhost/api/workspaces/workspace-1/assets/generate/happyhorse",
    body === undefined
      ? { method: "GET" }
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
          },
          body: JSON.stringify(body),
        }
  ) as never;
}

describe("/api/workspaces/[workspaceId]/assets/generate/happyhorse", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      supabase: {},
      userId: "user-1",
    });
    mockConnectDB.mockResolvedValue(undefined);
    mockIsHappyHorseConfigured.mockReturnValue(true);
    mockIsTemporalConfigured.mockReturnValue(true);
    mockFindOne.mockReturnValue({
      lean: async () => null,
    });
    mockFind.mockReturnValue({
      select: () => ({
        lean: async () => [{ _id: IMAGE_ID }, { _id: IMAGE_ID_2 }],
      }),
    });
    mockCreate.mockResolvedValue({
      _id: OUTPUT_ID,
      workspaceId: "workspace-1",
      kind: "video",
      source: "happyhorse",
      provider: "happyhorse",
      status: "queued",
      toObject() {
        return this;
      },
    });
    mockFindById.mockReturnValue({
      lean: async () => ({
        _id: OUTPUT_ID,
        workspaceId: "workspace-1",
        kind: "video",
        source: "happyhorse",
        provider: "happyhorse",
        status: "queued",
      }),
    });
    mockSerializeCreativeAssetForResponse.mockResolvedValue({
      id: OUTPUT_ID,
      status: "queued",
      source: "happyhorse",
    });
    mockQueueVideoGeneration.mockResolvedValue({
      asset: { _id: OUTPUT_ID, id: OUTPUT_ID, status: "queued" },
    });
  });

  it("GET reports capability without secrets", async () => {
    const response = await GET(request(), { params });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      configured: false,
      code: "own_ai_source_required",
      temporalConfigured: true,
      t2vModel: "happyhorse-1.1-t2v",
      i2vModel: "happyhorse-1.1-i2v",
      r2vModel: "happyhorse-1.1-r2v",
      defaultResolution: "1080P",
      defaultRatio: "9:16",
      durationMin: 3,
      durationMax: 15,
      referenceMin: 1,
      referenceMax: 9,
    });
  });

  it("POST queues text_to_video", async () => {
    const response = await POST(
      request(
        {
          mode: "text_to_video",
          prompt: "Vertical TikTok product orbit for a SaaS dashboard",
          duration: 6,
          ratio: "9:16",
        },
        "11111111-1111-4111-8111-111111111111"
      ),
      { params }
    );
    expect(response.status).toBe(202);
    expect(mockQueueVideoGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        providerPolicy: { provider: "happyhorse" },
        request: expect.objectContaining({
          mode: "text_to_video",
          aspectRatio: "9:16",
          durationSeconds: 6,
          sourceAssetId: null,
        }),
      })
    );
  });

  it("replays an accepted request without current provider or Temporal gates", async () => {
    mockFindOne.mockReturnValueOnce({
      lean: async () => ({
        _id: OUTPUT_ID,
        workspaceId: "workspace-1",
        status: "queued",
        generation: {
          contractVersion: 1,
          requestIdempotencyKey: "11111111-1111-4111-8111-111111111111",
        },
      }),
    });
    mockIsHappyHorseConfigured.mockReturnValue(false);
    mockIsTemporalConfigured.mockReturnValue(false);

    const response = await POST(
      request(
        {
          mode: "text_to_video",
          prompt: "Vertical TikTok product orbit for a SaaS dashboard",
          duration: 6,
          ratio: "9:16",
        },
        "11111111-1111-4111-8111-111111111111"
      ),
      { params }
    );

    expect(response.status).toBe(202);
    expect(mockQueueVideoGeneration).toHaveBeenCalledTimes(1);
    expect(mockIsHappyHorseConfigured).not.toHaveBeenCalled();
    expect(mockIsTemporalConfigured).not.toHaveBeenCalled();
  });

  it("queues the exact contract-v1 HappyHorse recipe", async () => {
    const response = await POST(
      request(
        {
          mode: "reference_to_video",
          prompt: "  Keep the accepted prompt whitespace  ",
          referenceAssetIds: [IMAGE_ID, IMAGE_ID_2],
          duration: 8,
          ratio: "9:16",
          resolution: "1080P",
          skill: "character",
        },
        "11111111-1111-4111-8111-111111111111"
      ),
      { params }
    );

    expect(response.status).toBe(202);
    expect(mockQueueVideoGeneration).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      createdBy: "user-1",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      providerPolicy: { provider: "happyhorse" },
      request: {
        mode: "reference_to_video",
        prompt: "  Keep the accepted prompt whitespace  ",
        skill: "character",
        durationSeconds: 8,
        aspectRatio: "9:16",
        resolution: "1080P",
        sourceAssetId: null,
        referenceAssetIds: [IMAGE_ID, IMAGE_ID_2],
      },
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each([undefined, "not-a-uuid"])(
    "rejects a missing or invalid idempotency key (%s)",
    async idempotencyKey => {
      const response = await POST(
        request(
          { mode: "text_to_video", prompt: "Product reveal" },
          idempotencyKey
        ),
        { params }
      );

      expect(response.status).toBe(400);
      expect(mockQueueVideoGeneration).not.toHaveBeenCalled();
    }
  );

  it("POST queues image_to_video with source", async () => {
    const response = await POST(
      request(
        {
          mode: "image_to_video",
          prompt: "Handheld unboxing energy",
          sourceAssetId: IMAGE_ID,
          duration: 5,
        },
        "11111111-1111-4111-8111-111111111111"
      ),
      { params }
    );
    expect(response.status).toBe(202);
    expect(mockQueueVideoGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          mode: "image_to_video",
          sourceAssetId: IMAGE_ID,
          aspectRatio: null,
        }),
      })
    );
  });

  it("POST queues reference_to_video with refs", async () => {
    const response = await POST(
      request(
        {
          mode: "reference_to_video",
          prompt: "The person from [Image 1] holds the product from [Image 2]",
          referenceAssetIds: [IMAGE_ID, IMAGE_ID_2],
          duration: 8,
          ratio: "9:16",
        },
        "11111111-1111-4111-8111-111111111111"
      ),
      { params }
    );
    expect(response.status).toBe(202);
    expect(mockQueueVideoGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          mode: "reference_to_video",
          sourceAssetId: null,
          referenceAssetIds: [IMAGE_ID, IMAGE_ID_2],
          aspectRatio: "9:16",
          durationSeconds: 8,
        }),
      })
    );
  });
});
