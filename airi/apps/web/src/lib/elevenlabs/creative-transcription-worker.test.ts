const mockFind = jest.fn();
const mockResolve = jest.fn();
const mockSubmit = jest.fn();
const mockPlatform = jest.fn();
const mockClaim = jest.fn();
const mockUpdate = jest.fn();
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/models/creative-asset", () => ({
  CreativeAsset: {
    findOne: (...args: unknown[]) => ({ lean: () => mockFind(...args) }),
    updateOne: (...args: unknown[]) => mockClaim(...args),
  },
}));
jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));
jest.mock("@/lib/elevenlabs/elevenlabs-source", () => ({
  resolveElevenLabsCredentialsForWorkspace: (...args: unknown[]) =>
    mockResolve(...args),
  getPlatformElevenLabsApiKey: () => mockPlatform(),
}));
jest.mock("@/lib/higgsfield/creative-asset-serialization", () => ({
  resolveCreativeAssetDisplayUrl: async () => "https://example.com/audio.mp3",
}));
jest.mock("@icecore/airi-runtime/elevenlabs-stt", () => ({
  ElevenLabsSttError: class extends Error {},
  submitElevenLabsAudioTranscriptionFromUrl: (...args: unknown[]) =>
    mockSubmit(...args),
  submitElevenLabsVideoTranscriptionFromUrl: (...args: unknown[]) =>
    mockSubmit(...args),
}));
jest.mock("@icecore/airi-runtime/logging", () => ({
  airiWorkerLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("@icecore/temporal", () => ({
  ...jest.requireActual("@icecore/temporal"),
  ELEVENLABS_CREATIVE_TRANSCRIPTION_WORKFLOW_CONTRACT_VERSION: 1,
}));
import {
  elevenLabsCreativeTranscriptionSubmitActivity,
  elevenLabsCreativeTranscriptionFailActivity,
} from "../../../../temporal-worker/src/activities/elevenlabs-creative-transcription";
const input = {
  contractVersion: 1,
  workspaceId: "workspace-1",
  assetId: "asset-1",
  sourceAssetId: "audio-1",
  workflowId: "workflow-1",
  mode: "transcript" as const,
  mediaType: "audio" as const,
};
let asset: Record<string, unknown>;
beforeEach(() => {
  jest.clearAllMocks();
  asset = {
    kind: "text",
    source: "elevenlabs",
    provider: "elevenlabs",
    status: "queued",
    providerSourceId: "saved-source",
  };
  mockFind.mockImplementation(async query =>
    query._id === "asset-1"
      ? structuredClone(asset)
      : { kind: "audio", status: "complete", mimeType: "audio/mpeg" }
  );
  mockResolve.mockResolvedValue({
    apiKey: "customer-key",
    sourceId: "saved-source",
    credentialSource: "workspace_source",
  });
  mockClaim.mockImplementation(async (query, update) => {
    const payload = asset.providerPayload as
      | Record<string, unknown>
      | undefined;
    if (typeof query["providerPayload.submitStartedAt"] === "string") {
      if (
        !["queued", "in_progress"].includes(String(asset.status)) ||
        payload?.submitStartedAt !== query["providerPayload.submitStartedAt"]
      )
        return { matchedCount: 0 };
      await mockUpdate(query._id, update.$set);
      return { matchedCount: 1 };
    }
    if (
      payload?.submitStartedAt ||
      asset.providerRequestId ||
      asset.status === "failed"
    )
      return { matchedCount: 0 };
    Object.assign(asset, update.$set);
    return { matchedCount: 1 };
  });
  mockUpdate.mockImplementation(async (_id, update) => {
    Object.assign(asset, update);
    return asset;
  });
  mockPlatform.mockReturnValue("platform-key");
  mockSubmit.mockResolvedValue({
    requestId: "request-1",
    model: "scribe_v2",
    deliveryMode: "webhook",
  });
});
it.each(["complete", "submitted"])(
  "preserves %s legacy work without resolving credentials",
  async state => {
    delete asset.providerSourceId;
    if (state === "complete") asset.status = "complete";
    else asset.providerRequestId = "existing-request";
    await expect(
      elevenLabsCreativeTranscriptionSubmitActivity(input)
    ).resolves.toMatchObject({
      requestId: state === "complete" ? "already-complete" : "existing-request",
    });
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockSubmit).not.toHaveBeenCalled();
  }
);
it.each([undefined, "input-only-source"])(
  "rejects new work without a saved source even with input source %s",
  async providerSourceId => {
    delete asset.providerSourceId;
    await expect(
      elevenLabsCreativeTranscriptionSubmitActivity({
        ...input,
        providerSourceId,
      })
    ).rejects.toMatchObject({
      type: "own_ai_source_required",
      nonRetryable: true,
    });
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockPlatform).not.toHaveBeenCalled();
  }
);
it("uses the persisted customer source when workflow input omitted it", async () => {
  await elevenLabsCreativeTranscriptionSubmitActivity(input);
  expect(mockResolve).toHaveBeenCalledWith({
    supabase: {},
    workspaceId: "workspace-1",
    sourceId: "saved-source",
  });
  expect(mockSubmit).toHaveBeenCalledWith(
    expect.any(String),
    "audio/mpeg",
    expect.any(Object),
    { apiKey: "customer-key", timestampsGranularity: "word" }
  );
  expect(mockPlatform).not.toHaveBeenCalled();
});
it("rejects a different input source before submission", async () => {
  await expect(
    elevenLabsCreativeTranscriptionSubmitActivity({
      ...input,
      providerSourceId: "different-source",
    })
  ).rejects.toMatchObject({
    type: "own_ai_source_required",
    nonRetryable: true,
  });
  expect(mockSubmit).not.toHaveBeenCalled();
});

it("admits only one provider submission when activity retries race", async () => {
  const results = await Promise.allSettled([
    elevenLabsCreativeTranscriptionSubmitActivity(input),
    elevenLabsCreativeTranscriptionSubmitActivity(input),
  ]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(
    1
  );
  expect(mockSubmit).toHaveBeenCalledTimes(1);
  expect(mockClaim).toHaveBeenCalledWith(
    expect.objectContaining({
      _id: "asset-1",
      workspaceId: "workspace-1",
      "providerPayload.submitStartedAt": { $exists: false },
    }),
    expect.any(Object)
  );
});
it("holds an ambiguous submission and never repeats it", async () => {
  mockSubmit.mockRejectedValue(new Error("connection lost"));
  await expect(
    elevenLabsCreativeTranscriptionSubmitActivity(input)
  ).rejects.toMatchObject({
    type: "ElevenLabsCreativeTranscriptionOutcomeUnknown",
    nonRetryable: true,
  });
  await expect(
    elevenLabsCreativeTranscriptionSubmitActivity(input)
  ).rejects.toMatchObject({
    type: "ElevenLabsCreativeTranscriptionOutcomeUnknown",
    nonRetryable: true,
  });
  expect(mockSubmit).toHaveBeenCalledTimes(1);
  expect(asset.providerPayload).toHaveProperty("submitStartedAt");
});
it("does not submit when the durable dispatch write fails", async () => {
  mockClaim.mockRejectedValue(new Error("Mongo unavailable"));
  await expect(
    elevenLabsCreativeTranscriptionSubmitActivity(input)
  ).rejects.toThrow("Mongo unavailable");
  expect(mockSubmit).not.toHaveBeenCalled();
});
it("preserves an uncertain result after its request ID could not be saved", async () => {
  mockUpdate.mockRejectedValue(new Error("acknowledgement lost"));
  await expect(
    elevenLabsCreativeTranscriptionSubmitActivity(input)
  ).resolves.toMatchObject({ requestId: "request-1" });
  await expect(
    elevenLabsCreativeTranscriptionSubmitActivity(input)
  ).rejects.toMatchObject({
    type: "ElevenLabsCreativeTranscriptionOutcomeUnknown",
    nonRetryable: true,
  });
  expect(mockSubmit).toHaveBeenCalledTimes(1);
});

it("does not overwrite a completed transcript when a failure write races completion", async () => {
  mockClaim.mockImplementation(async () => {
    asset.status = "complete";
    asset.providerRequestId = "completed-request";
    return { matchedCount: 0 };
  });
  await expect(
    elevenLabsCreativeTranscriptionFailActivity({
      ...input,
      error: "deadline reached",
    })
  ).resolves.toMatchObject({
    status: "complete",
    providerRequestId: "completed-request",
  });
  expect(mockClaim).toHaveBeenCalledWith(
    expect.objectContaining({
      _id: "asset-1",
      workspaceId: "workspace-1",
      status: { $ne: "complete" },
    }),
    expect.any(Object)
  );
  expect(asset.status).toBe("complete");
});

it("preserves a webhook completion when a timed-out provider call returns late", async () => {
  const webhook = {
    type: "speech_to_text",
    payload: { text: "Paid transcript" },
  };
  mockSubmit.mockImplementation(async () => {
    asset.status = "complete";
    asset.providerRequestId = "request-1";
    asset.providerPayload = {
      ...(asset.providerPayload as Record<string, unknown>),
      webhook,
    };
    return {
      requestId: "request-1",
      model: "scribe_v2",
      deliveryMode: "webhook",
    };
  });
  await elevenLabsCreativeTranscriptionSubmitActivity(input);
  expect(asset.status).toBe("complete");
  expect(asset.providerPayload).toHaveProperty("webhook", webhook);
  expect(mockUpdate).not.toHaveBeenCalled();
  expect(mockSubmit).toHaveBeenCalledTimes(1);
});
