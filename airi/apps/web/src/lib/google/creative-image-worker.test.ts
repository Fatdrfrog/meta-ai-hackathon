const mockFindAsset = jest.fn();
const mockUpdateAsset = jest.fn();
const mockResolveApiKey = jest.fn();
const mockSubmitImage = jest.fn();
const mockStoreImage = jest.fn();
const mockReadUrl = jest.fn();
const mockDownload = jest.fn();
let mockAsset: Record<string, unknown> & {
  status: string;
  providerPayload: Record<string, unknown> & { referenceImages: unknown[] };
};

jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/models/creative-asset", () => ({
  CreativeAsset: {
    findOne: () => ({ select: () => ({ lean: () => mockFindAsset() }) }),
    findByIdAndUpdate: (...args: unknown[]) => mockUpdateAsset(...args),
    updateOne: (...args: unknown[]) => mockUpdateAsset(...args),
  },
}));
// Outside an activity, activityInfo() throws and the activity treats the run
// as its last attempt; tests that retry set an attempt number.
const mockActivityInfo = jest.fn<{ attempt: number }, []>();
jest.mock(
  "../../../../temporal-worker/node_modules/@temporalio/activity",
  () => ({
    ...jest.requireActual(
      "../../../../temporal-worker/node_modules/@temporalio/activity"
    ),
    activityInfo: () => mockActivityInfo(),
  })
);
jest.mock("@/lib/google/creative-assets", () => {
  const {
    GoogleCreativeApiError,
    describeGoogleCreativeApiError,
    readGoogleImageRejectionMessage,
  } = jest.requireActual("@/lib/google/creative-assets");
  return {
    GoogleCreativeApiError,
    describeGoogleCreativeApiError,
    readGoogleImageRejectionMessage,
    getGoogleImageGenerationModel: () => "gemini-3.1-flash-image",
    submitGoogleImageGeneration: (...args: unknown[]) =>
      mockSubmitImage(...args),
  };
});
const mockResolveElevenLabsKey = jest.fn();
jest.mock("@/lib/google/creative-credentials", () => ({
  isCreativeAiSourceLookupUnavailable: jest.requireActual(
    "@/lib/google/creative-credentials"
  ).isCreativeAiSourceLookupUnavailable,
  resolveGoogleCreativeWorkerApiKey: (...args: unknown[]) =>
    mockResolveApiKey(...args),
  resolveElevenLabsCreativeWorkerApiKey: (...args: unknown[]) =>
    mockResolveElevenLabsKey(...args),
}));
const mockElevenLabsSubmit = jest.fn();
const mockElevenLabsWait = jest.fn();
jest.mock("@/lib/elevenlabs/image-generation", () => ({
  ...jest.requireActual("@/lib/elevenlabs/image-generation"),
  submitElevenLabsImageGeneration: (...args: unknown[]) =>
    mockElevenLabsSubmit(...args),
  waitForElevenLabsImageGeneration: (...args: unknown[]) =>
    mockElevenLabsWait(...args),
}));
jest.mock("@/lib/higgsfield/creative-asset-storage", () => ({
  assertCreativeAssetAllowed: jest.fn(),
  resolveCreativeAssetMimeType: () => "image/png",
}));
const mockLogWarn = jest.fn();
jest.mock("@icecore/airi-runtime/logging", () => ({
  airiWorkerLogger: {
    info: jest.fn(),
    warn: (...args: unknown[]) => mockLogWarn(...args),
  },
}));
jest.mock("@icecore/airi-runtime/creative-asset-read-url", () => ({
  createCreativeAssetReadUrl: (...args: unknown[]) => mockReadUrl(...args),
}));
jest.mock("@icecore/temporal", () => ({
  ...jest.requireActual("@icecore/scenario-contracts"),
  CREATIVE_IMAGE_GENERATION_WORKFLOW_CONTRACT_VERSION: 1,
  CREATIVE_IMAGE_GENERATION_ACTIVITY_MAX_ATTEMPTS: 3,
}));
jest.mock(
  "../../../../temporal-worker/src/gcs-creative-assets.js",
  () => ({
    uploadGcsCreativeAssetBuffer: (...args: unknown[]) =>
      mockStoreImage(...args),
    getGcsCreativeAssetsBucketName: () => "owned-bucket",
  }),
  { virtual: true }
);
jest.mock(
  "../../../../temporal-worker/src/activities/video-generation/providers/google.js",
  () => ({
    prepareGoogleSourceImage: (...args: unknown[]) => mockDownload(...args),
  }),
  { virtual: true }
);

import { creativeImageGenerationActivity } from "../../../../temporal-worker/src/activities/creative-image-generation";
import { GoogleCreativeApiError } from "@/lib/google/creative-assets";
import {
  ElevenLabsImageApiError,
  ElevenLabsImageGenerationFailedError,
  ElevenLabsImageStillRunningError,
} from "@/lib/elevenlabs/image-generation";

const baseInput = {
  contractVersion: 1,
  workspaceId: "workspace-1",
  assetId: "asset-1",
  workflowId: "workflow-1",
  provider: "google" as const,
  providerSourceId: "source-1",
  prompt: "Generate a product image",
  aspectRatio: "16:9",
  modelId: "gemini-3-pro-image",
};
const reference = {
  url: "gcs://owned-bucket/workspaces/workspace-1/creative-assets/image/scenario-one/template.png",
  bucket: "owned-bucket",
  path: "workspaces/workspace-1/creative-assets/image/scenario-one/template.png",
  mediaType: "image" as const,
  mimeType: "image/png",
  fileName: "template.png",
  fileSize: 8,
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
function readPath(object: Record<string, unknown>, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>((value, field) => asRecord(value)[field], object);
}
function assignPath(
  object: Record<string, unknown>,
  key: string,
  value: unknown
) {
  const fields = key.split(".");
  const field = fields.pop()!;
  let target = object;
  for (const name of fields) target = asRecord((target[name] ??= {}));
  target[field] = value;
}

describe("creative image worker", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockActivityInfo.mockImplementation(() => {
      throw new Error("Activity context not initialized");
    });
    mockAsset = {
      _id: "asset-1",
      workspaceId: "workspace-1",
      kind: "image",
      source: "google",
      provider: "google",
      status: "queued",
      providerSourceId: "source-1",
      prompt: baseInput.prompt,
      modelId: baseInput.modelId,
      providerPayload: {
        aspectRatio: "16:9",
        referenceImages: [],
        scenario: { executionId: "exec-1" },
      },
    };
    mockFindAsset.mockImplementation(async () => structuredClone(mockAsset));
    mockUpdateAsset.mockImplementation(async (query, update) => {
      if (typeof query === "string") {
        Object.assign(mockAsset, update);
        return mockAsset;
      }
      const matches = Object.entries(query).every(
        ([key, expected]: [string, unknown]) => {
          const actual = readPath(mockAsset, key);
          if (expected && typeof expected === "object" && "$exists" in expected)
            return (actual !== undefined) === expected.$exists;
          if (expected && typeof expected === "object" && "$in" in expected)
            return Array.isArray(expected.$in) && expected.$in.includes(actual);
          return actual === expected;
        }
      );
      if (!matches) return { matchedCount: 0 };
      for (const [key, value] of Object.entries(update.$set ?? update))
        assignPath(mockAsset, key, value);
      return { matchedCount: 1 };
    });
    mockResolveApiKey.mockResolvedValue("customer-key");
    mockSubmitImage.mockResolvedValue({
      buffer: Buffer.from("image"),
      mimeType: "image/png",
      fileName: "image.png",
      raw: { id: "interaction-1" },
    });
    mockStoreImage.mockResolvedValue({
      url: "gcs://owned-bucket/output",
      storageProvider: "gcs",
      bucket: "owned-bucket",
      path: "output",
      mimeType: "image/png",
      fileName: "image.png",
      fileSize: 5,
    });
    mockReadUrl.mockResolvedValue({
      url: "https://storage.googleapis.com/signed-reference",
    });
    mockDownload.mockResolvedValue({
      data: "iVBORw0KGgo=",
      mimeType: "image/png",
    });
  });

  it.each(["missing", "mismatched", "deleted"])(
    "persists a safe terminal failure for %s credentials",
    async reason => {
      mockResolveApiKey.mockRejectedValue(
        Object.assign(new Error("private credential diagnostic"), {
          code: "own_ai_source_required",
        })
      );
      await expect(
        creativeImageGenerationActivity({
          ...baseInput,
          providerSourceId:
            reason === "missing"
              ? null
              : reason === "mismatched"
                ? "source-2"
                : "source-1",
        })
      ).rejects.toMatchObject({
        type: "own_ai_source_required",
        nonRetryable: true,
      });
      expect(mockAsset).toMatchObject({
        status: "failed",
        providerPayload: {
          errorCode: "own_ai_source_required",
          scenario: { executionId: "exec-1" },
        },
      });
      expect(mockAsset.error).not.toContain("private");
      expect(mockSubmitImage).not.toHaveBeenCalled();
    }
  );

  it("uses the frozen model, prompt and ordered owned references", async () => {
    mockAsset.providerPayload.referenceImages = [reference];
    const result = await creativeImageGenerationActivity({
      ...baseInput,
      referenceImages: [reference],
    });
    expect(result.status).toBe("complete");
    expect(mockSubmitImage).toHaveBeenCalledWith({
      apiKey: "customer-key",
      prompt: baseInput.prompt,
      modelId: "gemini-3-pro-image",
      aspectRatio: "16:9",
      images: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }],
    });
    expect(mockDownload).toHaveBeenCalledWith(
      "https://storage.googleapis.com/signed-reference",
      expect.anything(),
      expect.objectContaining({ maxBytes: 5 * 1024 * 1024 })
    );
    expect(mockAsset.providerPayload.scenario).toEqual({
      executionId: "exec-1",
    });
  });

  it.each(["foreign-path", "foreign-bucket", "remote-url", "oversized"])(
    "rejects %s reference before submitting",
    async reason => {
      const invalid = {
        ...reference,
        ...(reason === "foreign-path"
          ? { path: reference.path.replace("workspace-1", "workspace-2") }
          : {}),
        ...(reason === "foreign-bucket" ? { bucket: "other-bucket" } : {}),
        ...(reason === "remote-url"
          ? {
              bucket: undefined,
              path: undefined,
              url: "https://127.0.0.1/private",
            }
          : {}),
        ...(reason === "oversized" ? { fileSize: 6 * 1024 * 1024 } : {}),
      };
      mockAsset.providerPayload.referenceImages = [invalid];
      await expect(
        creativeImageGenerationActivity({
          ...baseInput,
          referenceImages: [invalid],
        })
      ).rejects.toMatchObject({ nonRetryable: true });
      expect(mockSubmitImage).not.toHaveBeenCalled();
      expect(mockReadUrl).not.toHaveBeenCalled();
    }
  );

  it("does not submit an asset with a mismatched frozen model", async () => {
    await expect(
      creativeImageGenerationActivity({
        ...baseInput,
        modelId: "gemini-2.5-flash-image",
      })
    ).rejects.toMatchObject({ nonRetryable: true });
    expect(mockSubmitImage).not.toHaveBeenCalled();
  });

  it("preserves legacy Airi multiline prompts even when the asset stores compact text", async () => {
    delete mockAsset.providerPayload.scenario;
    mockAsset.providerPayload.airi = { threadId: "chat-1" };
    mockAsset.prompt = "Product shot White background";
    const prompt = "Product shot\n  White background";
    await expect(
      creativeImageGenerationActivity({
        ...baseInput,
        prompt,
        modelId: undefined,
      })
    ).resolves.toMatchObject({ status: "complete" });
    expect(mockSubmitImage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt })
    );
  });

  it("rejects changes to the exact frozen scenario prompt", async () => {
    mockAsset.prompt = "Product shot White background";
    await expect(
      creativeImageGenerationActivity({
        ...baseInput,
        prompt: "Product shot\nWhite background",
      })
    ).rejects.toMatchObject({ nonRetryable: true });
    expect(mockSubmitImage).not.toHaveBeenCalled();
  });

  it("does not charge again when the provider result is unknown", async () => {
    mockSubmitImage.mockRejectedValue(
      new Error("network error with secret-token")
    );
    await expect(
      creativeImageGenerationActivity(baseInput)
    ).rejects.toMatchObject({
      type: "CreativeImageGenerationOutcomeUnknown",
      nonRetryable: true,
    });
    await expect(
      creativeImageGenerationActivity(baseInput)
    ).resolves.toMatchObject({ status: "failed", terminal: true });
    expect(mockSubmitImage).toHaveBeenCalledTimes(1);
    expect(mockAsset.error).not.toContain("secret-token");
  });

  it("records Google's rejection as certain, for operators without the key", async () => {
    mockSubmitImage.mockRejectedValue(
      new GoogleCreativeApiError({
        message: "Google image generation failed: HTTP 429",
        statusCode: 429,
        payload: {
          error: {
            code: 429,
            message: "Quota exceeded for customer-key's project",
            status: "RESOURCE_EXHAUSTED",
          },
        },
      })
    );
    await expect(
      creativeImageGenerationActivity(baseInput)
    ).rejects.toMatchObject({
      type: "CreativeImageGenerationProviderRejected",
      nonRetryable: true,
    });

    const providerError = {
      httpStatus: 429,
      status: "RESOURCE_EXHAUSTED",
      reason: null,
      message: "Quota exceeded for [redacted]'s project",
    };
    expect(mockAsset).toMatchObject({
      status: "failed",
      error: expect.stringContaining("out of credits or quota"),
      providerPayload: {
        errorCode: "provider_rejected",
        imageSubmission: { state: "rejected" },
        providerError,
      },
    });
    expect(mockLogWarn).toHaveBeenCalledWith(
      "airi.worker.creative_image_generation",
      expect.objectContaining({
        note: "failed_after_submission_fence",
        assetId: "asset-1",
        providerRejected: true,
        providerHttpStatus: 429,
        providerStatus: "RESOURCE_EXHAUSTED",
        providerMessage: providerError.message,
      })
    );
    // A rejection is still never resubmitted.
    await expect(
      creativeImageGenerationActivity(baseInput)
    ).resolves.toMatchObject({ status: "failed", terminal: true });
    expect(mockSubmitImage).toHaveBeenCalledTimes(1);
    // Even when Google quotes it, the key never reaches a log or the asset.
    expect(JSON.stringify(mockLogWarn.mock.calls)).not.toContain(
      "customer-key"
    );
    expect(JSON.stringify(mockAsset)).not.toContain("customer-key");
  });

  it("keeps a Google server error as an uncertain outcome", async () => {
    mockSubmitImage.mockRejectedValue(
      new GoogleCreativeApiError({
        message: "Google image generation failed: HTTP 503",
        statusCode: 503,
        payload: { error: { code: 503, status: "UNAVAILABLE" } },
      })
    );
    await expect(
      creativeImageGenerationActivity(baseInput)
    ).rejects.toMatchObject({
      type: "CreativeImageGenerationOutcomeUnknown",
      nonRetryable: true,
    });
    expect(mockAsset.providerPayload).toMatchObject({
      errorCode: "submission_outcome_unknown",
      imageSubmission: { state: "unknown" },
      providerError: { httpStatus: 503, status: "UNAVAILABLE" },
    });
  });

  it.each([
    [
      "a reference download outage",
      () =>
        mockDownload.mockRejectedValue(
          Object.assign(new Error("Source image could not be downloaded"), {
            retryable: true,
          })
        ),
    ],
    [
      "a source that could not be read",
      () =>
        mockResolveApiKey.mockRejectedValue(
          Object.assign(new Error("Connect your own Google AI credentials"), {
            code: "own_ai_source_required",
            cause: Object.assign(new Error("Google AI is unavailable"), {
              code: "GOOGLE_AI_UNAVAILABLE",
            }),
          })
        ),
    ],
  ])(
    "retries %s before submitting and fails it on the last attempt",
    async (_name, fail) => {
      fail();
      mockAsset.providerPayload.referenceImages = [reference];
      const input = { ...baseInput, referenceImages: [reference] };

      mockActivityInfo.mockReturnValue({ attempt: 1 });
      await expect(
        creativeImageGenerationActivity(input)
      ).rejects.toMatchObject({
        type: "CreativeImageGenerationUnavailable",
        nonRetryable: false,
      });
      expect(mockAsset.status).toBe("queued");

      mockActivityInfo.mockReturnValue({ attempt: 3 });
      await expect(
        creativeImageGenerationActivity(input)
      ).rejects.toMatchObject({
        type: "CreativeImageGenerationUnavailable",
        nonRetryable: true,
      });
      expect(mockAsset).toMatchObject({
        status: "failed",
        providerPayload: { errorCode: "image_generation_unavailable" },
      });
      expect(mockSubmitImage).not.toHaveBeenCalled();
    }
  );

  it("does not retry a reference the download rules reject", async () => {
    mockDownload.mockRejectedValue(
      Object.assign(new Error("Source image is too large"), {
        retryable: false,
      })
    );
    mockAsset.providerPayload.referenceImages = [reference];
    mockActivityInfo.mockReturnValue({ attempt: 1 });
    await expect(
      creativeImageGenerationActivity({
        ...baseInput,
        referenceImages: [reference],
      })
    ).rejects.toMatchObject({
      type: "CreativeImageGenerationInvalidInput",
      nonRetryable: true,
    });
    expect(mockAsset.providerPayload.errorCode).toBe(
      "image_generation_invalid_input"
    );
  });

  it("logs only the error type for failures other than Google's answer", async () => {
    mockSubmitImage.mockRejectedValue(
      new Error("network error with secret-token")
    );
    await expect(
      creativeImageGenerationActivity(baseInput)
    ).rejects.toMatchObject({ nonRetryable: true });

    expect(mockAsset.providerPayload).not.toHaveProperty("providerError");
    expect(mockLogWarn).toHaveBeenCalledWith(
      "airi.worker.creative_image_generation",
      expect.objectContaining({ errorName: "Error", providerMessage: null })
    );
    expect(JSON.stringify(mockLogWarn.mock.calls)).not.toContain(
      "secret-token"
    );
  });

  it("does not submit after a crash left the durable dispatch marker", async () => {
    mockAsset.status = "in_progress";
    mockAsset.providerPayload.imageSubmission = {
      state: "dispatching",
      token: "prior-attempt",
    };
    await expect(
      creativeImageGenerationActivity(baseInput)
    ).rejects.toMatchObject({
      type: "CreativeImageGenerationOutcomeUnknown",
      nonRetryable: true,
    });
    expect(mockAsset.status).toBe("failed");
    expect(mockSubmitImage).not.toHaveBeenCalled();
  });

  it("does not charge again when storing the generated image fails", async () => {
    mockStoreImage.mockRejectedValue(new Error("storage outage"));
    await expect(
      creativeImageGenerationActivity(baseInput)
    ).rejects.toMatchObject({ nonRetryable: true });
    await expect(
      creativeImageGenerationActivity(baseInput)
    ).resolves.toMatchObject({ status: "failed" });
    expect(mockSubmitImage).toHaveBeenCalledTimes(1);
  });

  it("rejects reference bytes with a different format or size than the uploaded metadata", async () => {
    mockAsset.providerPayload.referenceImages = [reference];
    mockDownload.mockResolvedValue({ data: "b25l", mimeType: "image/png" });
    await expect(
      creativeImageGenerationActivity({
        ...baseInput,
        referenceImages: [reference],
      })
    ).rejects.toMatchObject({ nonRetryable: true });
    expect(mockSubmitImage).not.toHaveBeenCalled();
  });

  it("allows only one provider POST when two activities race", async () => {
    const outcomes = await Promise.allSettled([
      creativeImageGenerationActivity(baseInput),
      creativeImageGenerationActivity(baseInput),
    ]);
    expect(mockSubmitImage).toHaveBeenCalledTimes(1);
    expect(
      outcomes.filter(outcome => outcome.status === "fulfilled")
    ).toHaveLength(1);
    expect(mockAsset.status).toBe("complete");
  });

  it("does not submit if the durable dispatch write fails", async () => {
    mockUpdateAsset.mockRejectedValue(new Error("Mongo unavailable"));
    await expect(creativeImageGenerationActivity(baseInput)).rejects.toThrow(
      "Mongo unavailable"
    );
    expect(mockSubmitImage).not.toHaveBeenCalled();
  });

  it("recovers an uncertain completion commit without another provider POST", async () => {
    const update = mockUpdateAsset.getMockImplementation()!;
    let simulateCommitFailure = true;
    mockUpdateAsset.mockImplementation(async (query, mutation) => {
      if (simulateCommitFailure && mutation.$set?.status === "complete") {
        simulateCommitFailure = false;
        await update(query, mutation);
        throw new Error("Commit acknowledgement lost");
      }
      return update(query, mutation);
    });
    await expect(
      creativeImageGenerationActivity(baseInput)
    ).rejects.toMatchObject({ nonRetryable: true });
    await expect(
      creativeImageGenerationActivity(baseInput)
    ).resolves.toMatchObject({ status: "complete" });
    expect(mockSubmitImage).toHaveBeenCalledTimes(1);
  });

  it("preserves the completed shortcut without credentials or a provider request", async () => {
    mockAsset.status = "complete";
    await expect(
      creativeImageGenerationActivity(baseInput)
    ).resolves.toMatchObject({ status: "complete" });
    expect(mockSubmitImage).not.toHaveBeenCalled();
    expect(mockResolveApiKey).not.toHaveBeenCalled();
  });

  describe("with ElevenLabs", () => {
    const elevenLabsInput = {
      ...baseInput,
      provider: "elevenlabs" as const,
      modelId: "gemini-3.1-flash-image",
    };
    const finishedUrl =
      "https://storage.googleapis.com/elevenlabs/result.png?signature=1";

    beforeEach(() => {
      mockAsset.source = "elevenlabs";
      mockAsset.provider = "elevenlabs";
      mockAsset.modelId = elevenLabsInput.modelId;
      mockResolveElevenLabsKey.mockResolvedValue("elevenlabs-key");
      mockElevenLabsSubmit.mockResolvedValue({ generationId: "generation-1" });
      mockElevenLabsWait.mockResolvedValue({
        contentUrl: finishedUrl,
        mimeType: "image/png",
      });
      mockDownload.mockResolvedValue({
        data: Buffer.from("finished").toString("base64"),
        mimeType: "image/png",
      });
    });

    it("submits once with the workspace key, records the job and stores its image", async () => {
      await expect(
        creativeImageGenerationActivity(elevenLabsInput)
      ).resolves.toMatchObject({
        status: "complete",
        providerRequestId: "generation-1",
      });
      expect(mockResolveElevenLabsKey).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        providerSourceId: "source-1",
      });
      expect(mockResolveApiKey).not.toHaveBeenCalled();
      expect(mockSubmitImage).not.toHaveBeenCalled();
      expect(mockElevenLabsSubmit).toHaveBeenCalledWith({
        apiKey: "elevenlabs-key",
        modelId: "gemini-3.1-flash-image",
        prompt: baseInput.prompt,
        aspectRatio: "16:9",
        images: [],
      });
      expect(mockElevenLabsWait).toHaveBeenCalledWith({
        apiKey: "elevenlabs-key",
        generationId: "generation-1",
      });
      expect(mockDownload).toHaveBeenCalledWith(
        finishedUrl,
        expect.anything(),
        expect.objectContaining({ maxBytes: 20 * 1024 * 1024 })
      );
      expect(mockStoreImage).toHaveBeenCalledWith(
        expect.objectContaining({
          fileName: "elevenlabs-generated-image.png",
          buffer: Buffer.from("finished"),
        })
      );
      expect(mockAsset).toMatchObject({
        status: "complete",
        providerRequestId: "generation-1",
        providerPayload: {
          elevenlabs: { generationId: "generation-1" },
          imageSubmission: { state: "complete" },
        },
      });
    });

    it("names a refused submission and never resubmits it", async () => {
      mockElevenLabsSubmit.mockRejectedValue(
        new ElevenLabsImageApiError(402, {
          detail: { status: "paid_plan_required", message: "Upgrade" },
        })
      );
      await expect(
        creativeImageGenerationActivity(elevenLabsInput)
      ).rejects.toMatchObject({
        type: "CreativeImageGenerationProviderRejected",
        nonRetryable: true,
      });
      expect(mockAsset).toMatchObject({
        status: "failed",
        error: expect.stringContaining("Pro plan"),
        providerPayload: {
          errorCode: "provider_rejected",
          providerError: { httpStatus: 402, status: "paid_plan_required" },
        },
      });
      expect(mockAsset.providerRequestId).toBeUndefined();
      await creativeImageGenerationActivity(elevenLabsInput);
      expect(mockElevenLabsSubmit).toHaveBeenCalledTimes(1);
    });

    it("records a failed job with its reason", async () => {
      mockElevenLabsWait.mockRejectedValue(
        new ElevenLabsImageGenerationFailedError("moderated")
      );
      mockActivityInfo.mockReturnValue({ attempt: 1 });
      await expect(
        creativeImageGenerationActivity(elevenLabsInput)
      ).rejects.toMatchObject({
        type: "CreativeImageGenerationProviderFailed",
        nonRetryable: true,
      });
      expect(mockAsset).toMatchObject({
        status: "failed",
        error: expect.stringContaining("content policy"),
        providerPayload: {
          errorCode: "provider_failed",
          providerFailureReason: "moderated",
          imageSubmission: { state: "failed" },
        },
      });
    });

    it("reads a job still running again on the next attempt instead of paying twice", async () => {
      mockElevenLabsWait.mockRejectedValueOnce(
        new ElevenLabsImageStillRunningError("generation-1")
      );
      mockActivityInfo.mockReturnValue({ attempt: 1 });
      await expect(
        creativeImageGenerationActivity(elevenLabsInput)
      ).rejects.toMatchObject({
        type: "CreativeImageGenerationPending",
        nonRetryable: false,
      });
      expect(mockAsset).toMatchObject({
        status: "in_progress",
        providerRequestId: "generation-1",
        providerPayload: { imageSubmission: { state: "submitted" } },
      });

      mockActivityInfo.mockReturnValue({ attempt: 2 });
      await expect(
        creativeImageGenerationActivity(elevenLabsInput)
      ).resolves.toMatchObject({
        status: "complete",
        providerRequestId: "generation-1",
      });
      expect(mockElevenLabsSubmit).toHaveBeenCalledTimes(1);
      expect(mockElevenLabsWait).toHaveBeenLastCalledWith({
        apiKey: "elevenlabs-key",
        generationId: "generation-1",
      });
    });

    it("gives up on a job still running at the last attempt as an unknown outcome", async () => {
      mockElevenLabsWait.mockRejectedValue(
        new ElevenLabsImageStillRunningError("generation-1")
      );
      mockActivityInfo.mockReturnValue({ attempt: 3 });
      await expect(
        creativeImageGenerationActivity(elevenLabsInput)
      ).rejects.toMatchObject({
        type: "CreativeImageGenerationOutcomeUnknown",
        nonRetryable: true,
      });
      expect(mockAsset).toMatchObject({
        status: "failed",
        providerPayload: { errorCode: "submission_outcome_unknown" },
      });
    });

    it("does not run an ElevenLabs asset on a model only Google offers", async () => {
      mockAsset.modelId = "gemini-2.5-flash-image";
      await expect(
        creativeImageGenerationActivity({
          ...elevenLabsInput,
          modelId: "gemini-2.5-flash-image",
        })
      ).rejects.toMatchObject({ nonRetryable: true });
      expect(mockElevenLabsSubmit).not.toHaveBeenCalled();
    });
  });
});
