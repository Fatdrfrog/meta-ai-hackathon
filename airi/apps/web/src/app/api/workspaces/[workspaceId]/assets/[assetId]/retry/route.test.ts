const mockRequireScenarioWorkspaceAccess = jest.fn();
const mockConnectDB = jest.fn();
const mockRetryVideoGeneration = jest.fn();

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));
jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));
jest.mock("@/lib/creative-assets/video-generation-queue", () => {
  class VideoGenerationQueueError extends Error {
    constructor(
      readonly status: 400 | 403 | 404 | 409 | 503,
      readonly code: string,
      message: string,
      readonly maxLength?: number
    ) {
      super(message);
      this.name = "VideoGenerationQueueError";
    }
  }
  return {
    VideoGenerationQueueError,
    retryVideoGeneration: (...args: unknown[]) =>
      mockRetryVideoGeneration(...args),
  };
});

import { VideoGenerationQueueError } from "@/lib/creative-assets/video-generation-queue";
import { NextRequest } from "next/server";
import { POST } from "./route";

const WORKSPACE_ID = "workspace-1";
const ASSET_ID = "507f1f77bcf86cd799439021";
const IDEMPOTENCY_KEY = "123e4567-e89b-42d3-a456-426614174000";

function request(
  body: unknown = {},
  idempotencyKey: string | null = IDEMPOTENCY_KEY
) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (idempotencyKey !== null) headers.set("Idempotency-Key", idempotencyKey);
  return new NextRequest("http://localhost/retry", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function privateChild() {
  return {
    _id: "507f1f77bcf86cd799439022",
    workspaceId: WORKSPACE_ID,
    kind: "video",
    source: "higgsfield",
    provider: "higgsfield",
    status: "queued",
    prompt: "Private legacy prompt",
    modelId: "higgsfield-model",
    sourceAssetId: "507f1f77bcf86cd799439011",
    providerSourceId: "private-source-credential",
    providerRequestId: "private-provider-request",
    providerPayload: { authorization: "private" },
    generation: {
      contractVersion: 1,
      spec: {
        contractVersion: 1,
        provider: "higgsfield",
        mode: "image_to_video",
        skill: "video",
        userPrompt: "Frozen prompt",
        modelId: "higgsfield-model",
        seed: null,
        durationSeconds: 5,
        aspectRatio: null,
        resolution: "provider_default",
        sourceAssetId: "507f1f77bcf86cd799439011",
        referenceAssetIds: [],
      },
      prompt: {
        compilerId: "airi-video-director",
        compilerVersion: 1,
        normalizedUserPrompt: "Frozen prompt",
        providerPrompt: "SECRET PROVIDER PROMPT",
        providerPromptSha256: "a".repeat(64),
        warnings: [],
      },
      requestIdempotencyKey: IDEMPOTENCY_KEY,
      retryOfAssetId: ASSET_ID,
      recipeFingerprint: "private-fingerprint",
      orchestration: {
        workflowId: "private-workflow-id",
        state: "pending",
        startedAt: null,
      },
      submission: {
        state: "pending",
        attemptToken: "private-attempt-token",
        providerRequestId: "private-generation-request",
        submittedAt: null,
      },
      result: null,
      failure: null,
    },
    createdAt: new Date("2026-07-23T00:00:00.000Z"),
    updatedAt: new Date("2026-07-23T00:00:00.000Z"),
  };
}

describe("POST video generation retry", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      userId: "user-1",
      accessToken: "token",
      supabase: {},
    });
    mockConnectDB.mockResolvedValue(undefined);
    mockRetryVideoGeneration.mockResolvedValue({ asset: privateChild() });
  });

  it("requires workspace authentication before queueing", async () => {
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const response = await POST(request(), {
      params: Promise.resolve({ workspaceId: WORKSPACE_ID, assetId: ASSET_ID }),
    });

    expect(response.status).toBe(401);
    expect(mockRetryVideoGeneration).not.toHaveBeenCalled();
  });

  it.each([null, "not-a-uuid", "00000000-0000-0000-0000-000000000000"])(
    "rejects missing or non-RFC-4122 Idempotency-Key %p",
    async key => {
      const response = await POST(request({}, key), {
        params: Promise.resolve({
          workspaceId: WORKSPACE_ID,
          assetId: ASSET_ID,
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "invalid_idempotency_key",
      });
      expect(mockRetryVideoGeneration).not.toHaveBeenCalled();
    }
  );

  it("rejects invalid JSON and unknown body fields", async () => {
    const invalidJson = new NextRequest("http://localhost/retry", {
      method: "POST",
      headers: { "Idempotency-Key": IDEMPOTENCY_KEY },
      body: "{",
    });
    const invalidResponse = await POST(invalidJson, {
      params: Promise.resolve({ workspaceId: WORKSPACE_ID, assetId: ASSET_ID }),
    });
    expect(invalidResponse.status).toBe(400);

    const extraResponse = await POST(request({ extra: true }), {
      params: Promise.resolve({ workspaceId: WORKSPACE_ID, assetId: ASSET_ID }),
    });
    expect(extraResponse.status).toBe(400);
    expect(mockRetryVideoGeneration).not.toHaveBeenCalled();
  });

  it("queues a frozen linked child and returns a deeply private public DTO at 202", async () => {
    const response = await POST(
      request({ acknowledgePossibleDuplicateCharge: true }),
      {
        params: Promise.resolve({
          workspaceId: WORKSPACE_ID,
          assetId: ASSET_ID,
        }),
      }
    );
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(mockConnectDB).toHaveBeenCalledTimes(1);
    expect(mockRetryVideoGeneration).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      assetId: ASSET_ID,
      createdBy: "user-1",
      idempotencyKey: IDEMPOTENCY_KEY,
      acknowledgePossibleDuplicateCharge: true,
    });
    expect(payload.asset.generation.retryOfAssetId).toBe(ASSET_ID);
    const serialized = JSON.stringify(payload);
    for (const privateValue of [
      "private-source-credential",
      "private-provider-request",
      "private-generation-request",
      "SECRET PROVIDER PROMPT",
      "private-attempt-token",
      "private-workflow-id",
      "private-fingerprint",
      "authorization",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it.each([400, 403, 404, 409, 503] as const)(
    "maps typed queue errors with status %s",
    async status => {
      mockRetryVideoGeneration.mockRejectedValue(
        new VideoGenerationQueueError(status, "queue_error", "Queue error", 99)
      );

      const response = await POST(request(), {
        params: Promise.resolve({
          workspaceId: WORKSPACE_ID,
          assetId: ASSET_ID,
        }),
      });

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        error: "Queue error",
        code: "queue_error",
        maxLength: 99,
      });
    }
  );

  it("makes admission contention explicitly retryable", async () => {
    mockRetryVideoGeneration.mockRejectedValue(
      new VideoGenerationQueueError(
        503,
        "generation_admission_busy",
        "Creative generation is busy"
      )
    );

    const response = await POST(request(), {
      params: Promise.resolve({
        workspaceId: WORKSPACE_ID,
        assetId: ASSET_ID,
      }),
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
  });

  it("maps unexpected errors to 500 without leaking details", async () => {
    mockRetryVideoGeneration.mockRejectedValue(new Error("database secret"));

    const response = await POST(request(), {
      params: Promise.resolve({ workspaceId: WORKSPACE_ID, assetId: ASSET_ID }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Failed to retry video generation",
    });
  });
});
