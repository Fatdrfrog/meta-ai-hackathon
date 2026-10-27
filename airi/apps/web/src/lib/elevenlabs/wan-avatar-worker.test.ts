const mockFind = jest.fn();
const mockPoll = jest.fn();
const mockSubmit = jest.fn();
const mockTts = jest.fn();
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/models/creative-asset", () => ({
  CreativeAsset: {
    findOne: (...args: unknown[]) => ({ lean: () => mockFind(...args) }),
    findByIdAndUpdate: jest.fn(),
  },
}));
jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));
jest.mock("@/lib/higgsfield/creative-asset-storage", () => ({
  downloadAndStoreCreativeAsset: async () => ({
    url: "https://example.com/video.mp4",
  }),
}));
jest.mock("@/lib/wan/wan-s2v-client", () => ({
  isWanS2VSuccessStatus: () => true,
  isWanS2VTerminalStatus: () => true,
  pollWanS2VTask: (...args: unknown[]) => mockPoll(...args),
  submitWanS2V: (...args: unknown[]) => mockSubmit(...args),
  WanS2VApiError: class extends Error {},
}));
jest.mock("@/lib/wan/wan-config", () => ({ getWanS2VModel: () => "wan" }));
jest.mock("@/lib/elevenlabs/creative-assets", () => ({
  submitElevenLabsTextToSpeech: (...args: unknown[]) => mockTts(...args),
}));
jest.mock("@icecore/airi-runtime/logging", () => ({
  airiWorkerLogger: { info: jest.fn() },
}));
jest.mock("@icecore/temporal", () => ({
  ...jest.requireActual("@icecore/temporal"),
  WAN_AVATAR_ACTIVITY_CONTRACT_VERSION: 1,
  WAN_AVATAR_POLL_INTERVAL_MS: 0,
  WAN_AVATAR_TIMEOUT_MS: 1000,
}));
// @temporalio/activity is a worker dependency only; mock the worker's copy.
jest.mock(
  "../../../../temporal-worker/node_modules/@temporalio/activity",
  () => ({
    ...jest.requireActual(
      "../../../../temporal-worker/node_modules/@temporalio/activity"
    ),
    heartbeat: jest.fn(),
  })
);
jest.mock(
  "../../../../temporal-worker/src/gcs-creative-assets.js",
  () => ({ uploadGcsCreativeAssetBuffer: jest.fn() }),
  { virtual: true }
);
import { wanAvatarProcessActivity } from "../../../../temporal-worker/src/activities/wan-avatar";
const input = {
  contractVersion: 1,
  workspaceId: "workspace-1",
  outputAssetId: "output-1",
  imageAssetId: "deleted-image",
  mode: "image_script" as const,
  script: "Old script",
  resolution: "720P" as const,
};
let asset: Record<string, unknown>;
beforeEach(() => {
  jest.clearAllMocks();
  asset = {
    kind: "video",
    source: "wan",
    provider: "wan",
    status: "in_progress",
  };
  mockFind.mockImplementation(async query =>
    query._id === "output-1" ? asset : null
  );
  mockPoll.mockResolvedValue({
    taskStatus: "SUCCEEDED",
    videoUrl: "https://example.com/output.mp4",
    raw: {},
  });
});
it.each(["requestId", "submitPayload"])(
  "resumes a paid task from %s without preparing missing input assets or generating TTS",
  async source => {
    if (source === "requestId") asset.providerRequestId = "paid-task";
    else asset.providerPayload = { submit: { task_id: "paid-task" } };
    await expect(wanAvatarProcessActivity(input)).resolves.toMatchObject({
      status: "complete",
      providerRequestId: "paid-task",
    });
    expect(mockPoll).toHaveBeenCalledWith("paid-task");
    expect(mockFind).toHaveBeenCalledTimes(1);
    expect(mockTts).not.toHaveBeenCalled();
    expect(mockSubmit).not.toHaveBeenCalled();
  }
);
it("returns a completed asset without issuing requests", async () => {
  asset.status = "complete";
  await expect(wanAvatarProcessActivity(input)).resolves.toMatchObject({
    status: "complete",
  });
  expect(mockPoll).not.toHaveBeenCalled();
  expect(mockTts).not.toHaveBeenCalled();
});
it("rejects new Wan work before any paid request", async () => {
  await expect(wanAvatarProcessActivity(input)).rejects.toMatchObject({
    type: "own_ai_source_required",
    nonRetryable: true,
  });
  expect(mockTts).not.toHaveBeenCalled();
  expect(mockSubmit).not.toHaveBeenCalled();
});
