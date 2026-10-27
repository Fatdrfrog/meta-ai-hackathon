/**
 * @jest-environment node
 */

import { createCreativeAssetReadUrl } from "@icecore/airi-runtime/creative-asset-read-url";
import { ensureMediaApiCreativeAssetReadUrlPort } from "@/lib/google/creative-asset-read-url-media-api-adapter";
import type { CreativeAssetVideoGeneration } from "@/models/creative-asset";
import {
  resolveCreativeAssetDisplayUrl,
  serializeCreativeAsset,
  serializeCreativeAssetsForResponse,
} from "./creative-asset-serialization";

jest.mock("@icecore/airi-runtime/creative-asset-read-url", () => ({
  createCreativeAssetReadUrl: jest.fn(),
}));

jest.mock("@/lib/google/creative-asset-read-url-media-api-adapter", () => ({
  ensureMediaApiCreativeAssetReadUrlPort: jest.fn(),
}));

const mockCreateReadUrl = createCreativeAssetReadUrl as jest.MockedFunction<
  typeof createCreativeAssetReadUrl
>;
const mockEnsure =
  ensureMediaApiCreativeAssetReadUrlPort as jest.MockedFunction<
    typeof ensureMediaApiCreativeAssetReadUrlPort
  >;

function contractVideoGeneration(): CreativeAssetVideoGeneration {
  return {
    contractVersion: 1,
    spec: {
      contractVersion: 1,
      provider: "happyhorse",
      mode: "text_to_video",
      skill: "video",
      userPrompt: "Create a video",
      modelId: "happyhorse-v1",
      seed: null,
      durationSeconds: 5,
      aspectRatio: "16:9",
      resolution: "720P",
      sourceAssetId: null,
      referenceAssetIds: [],
    },
    prompt: {
      compilerId: "airi-video-director",
      compilerVersion: 1,
      normalizedUserPrompt: "Create a video",
      providerPrompt: "PRIVATE_PROVIDER_PROMPT",
      providerPromptSha256: "a".repeat(64),
      warnings: [],
    },
    requestIdempotencyKey: "request-1",
    retryOfAssetId: null,
    recipeFingerprint: "recipe-1",
    orchestration: {
      workflowId: "video-generation:asset-1",
      state: "pending",
      startedAt: null,
    },
    submission: {
      state: "pending",
      attemptToken: "attempt-1",
      providerRequestId: "provider-request-1",
      submittedAt: null,
    },
    result: null,
    failure: null,
  };
}

describe("creative-asset-serialization display URLs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("wires the Media API read-URL port before signing GCS assets", async () => {
    mockCreateReadUrl.mockResolvedValue({
      provider: "gcs",
      bucket: "bucket",
      path: "workspaces/ws-1/creative-assets/image/a/file.png",
      url: "https://signed.example/a.png",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    await expect(
      resolveCreativeAssetDisplayUrl({
        workspaceId: "ws-1",
        status: "complete",
        storageProvider: "gcs",
        url: "gcs://bucket/workspaces/ws-1/creative-assets/image/a/file.png",
        bucket: "bucket",
        path: "workspaces/ws-1/creative-assets/image/a/file.png",
      })
    ).resolves.toBe("https://signed.example/a.png");

    expect(mockEnsure).toHaveBeenCalled();
  });

  it("soft-fails GCS signing so asset lists do not 500", async () => {
    mockCreateReadUrl.mockRejectedValue(
      new Error(
        "Creative asset read-URL port is not configured. Wire the Media API adapter (web) or GCS adapter (worker) at composition root."
      )
    );

    const assets = await serializeCreativeAssetsForResponse([
      {
        _id: "asset-1",
        workspaceId: "ws-1",
        kind: "image",
        source: "uploaded",
        status: "complete",
        storageProvider: "gcs",
        url: "gcs://bucket/workspaces/ws-1/creative-assets/image/a/file.png",
        bucket: "bucket",
        path: "workspaces/ws-1/creative-assets/image/a/file.png",
      },
    ]);

    expect(mockEnsure).toHaveBeenCalled();
    expect(assets).toHaveLength(1);
    expect(assets[0]?.id).toBe("asset-1");
    expect(assets[0]?.url).toBeNull();
  });
});

describe("creative-asset-serialization video generation privacy", () => {
  it("returns a bounded public generation projection without private fields", () => {
    const serialized = serializeCreativeAsset({
      _id: "asset-1",
      workspaceId: "workspace-1",
      kind: "video",
      source: "happyhorse",
      provider: "happyhorse",
      status: "in_progress",
      prompt: "PRIVATE_TOP_LEVEL_PROMPT",
      url: "https://provider.example/result.mp4?signature=PRIVATE_PROVIDER_URL",
      error: "PRIVATE_PROVIDER_DIAGNOSTIC",
      providerRequestId: "provider-request-1",
      providerSourceId: "provider-source-1",
      providerStatusUrl: "https://provider.example/status",
      providerCancelUrl: "https://provider.example/cancel",
      generation: contractVideoGeneration(),
    });

    expect(serialized.generation).toMatchObject({
      contractVersion: 1,
      provider: "happyhorse",
      mode: "text_to_video",
      prompt: { compilerId: "airi-video-director", compilerVersion: 1 },
    });
    expect(serialized.generation?.prompt).not.toHaveProperty("providerPrompt");
    expect(serialized.generation).not.toHaveProperty("attemptToken");
    expect(serialized.prompt).toBe("Create a video");
    expect(serialized.error).toBeNull();
    expect(serialized.url).toBeNull();
    expect(serialized).not.toHaveProperty("providerRequestId");
    expect(serialized).not.toHaveProperty("providerSourceId");
    expect(serialized).not.toHaveProperty("providerStatusUrl");
    expect(serialized).not.toHaveProperty("providerCancelUrl");
    expect(JSON.stringify(serialized)).not.toContain(
      "PRIVATE_TOP_LEVEL_PROMPT"
    );
    expect(JSON.stringify(serialized)).not.toContain("PRIVATE_PROVIDER_PROMPT");
    expect(JSON.stringify(serialized)).not.toContain(
      "PRIVATE_PROVIDER_DIAGNOSTIC"
    );
    expect(JSON.stringify(serialized)).not.toContain("PRIVATE_PROVIDER_URL");
  });

  it("exposes safe retry availability for provider-result recovery without provider identity", () => {
    const generation = contractVideoGeneration();
    generation.submission = {
      ...generation.submission,
      state: "submitted",
      submittedAt: new Date("2026-07-22T00:00:00.000Z"),
    };
    generation.failure = {
      phase: "store",
      code: "provider_result_not_ready",
      providerCode: null,
      message: "Provider result is not ready",
      retryable: false,
      submissionUncertain: false,
      failedAt: new Date("2026-07-22T00:30:00.000Z"),
    };

    const serialized = serializeCreativeAsset({
      _id: "asset-1",
      workspaceId: "workspace-1",
      kind: "video",
      source: "happyhorse",
      provider: "happyhorse",
      status: "failed",
      providerRequestId: "provider-request-1",
      providerStatusUrl: "jobs/provider-request-1",
      generation,
    });

    expect(serialized.generation).toMatchObject({
      canRetry: true,
      requiresDuplicateChargeAcknowledgement: false,
      failure: {
        code: "provider_result_not_ready",
        retryable: false,
      },
    });
    expect(serialized).not.toHaveProperty("providerRequestId");
    expect(serialized).not.toHaveProperty("providerStatusUrl");
  });

  it("keeps the legacy asset response shape", () => {
    const serialized = serializeCreativeAsset({
      _id: "legacy-asset-1",
      workspaceId: "workspace-1",
      kind: "video",
      source: "higgsfield",
      provider: "higgsfield",
      status: "in_progress",
      prompt: "Legacy prompt",
      url: "https://provider.example/legacy.mp4",
      error: "Legacy provider diagnostic",
      providerRequestId: "legacy-request-1",
      providerStatusUrl: "https://provider.example/status",
      providerCancelUrl: "https://provider.example/cancel",
    });

    expect(serialized).toMatchObject({
      prompt: "Legacy prompt",
      url: "https://provider.example/legacy.mp4",
      error: "Legacy provider diagnostic",
      providerRequestId: "legacy-request-1",
      providerStatusUrl: "https://provider.example/status",
      providerCancelUrl: "https://provider.example/cancel",
      generation: null,
    });
  });
});
