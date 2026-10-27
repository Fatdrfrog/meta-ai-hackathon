const mockConnectDB = jest.fn();
const mockFindOne = jest.fn();
const mockFindByIdAndUpdate = jest.fn();
const mockStoreCreativeAssetBuffer = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/models/creative-asset", () => ({
  CreativeAsset: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
    findByIdAndUpdate: (...args: unknown[]) => mockFindByIdAndUpdate(...args),
  },
}));

jest.mock("@/lib/higgsfield/creative-asset-storage", () => ({
  storeCreativeAssetBuffer: (...args: unknown[]) =>
    mockStoreCreativeAssetBuffer(...args),
}));

import { completeElevenLabsCreativeTranscriptionAsset } from "./creative-transcription-webhook";

describe("completeElevenLabsCreativeTranscriptionAsset", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockFindOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: "asset-1",
        workspaceId: "workspace-1",
        provider: "elevenlabs",
        status: "queued",
        providerRequestId: "stt_req_1",
        providerPayload: { mode: "subtitles" },
      }),
    });
    mockStoreCreativeAssetBuffer.mockResolvedValue({
      url: "gs://bucket/path/elevenlabs-subtitles.vtt",
      storageProvider: "gcs",
      bucket: "bucket",
      path: "path/elevenlabs-subtitles.vtt",
      mimeType: "text/vtt",
      fileName: "elevenlabs-subtitles.vtt",
      fileSize: 42,
    });
  });

  it("stores a completed subtitle callback as the final text asset", async () => {
    await completeElevenLabsCreativeTranscriptionAsset({
      workspaceId: "workspace-1",
      assetId: "asset-1",
      requestId: "stt_req_1",
      mode: "subtitles",
      status: "completed",
      webhookType: "speech_to_text_transcription",
      data: {
        request_id: "stt_req_1",
        status: "completed",
        transcription: {
          text: "Hello world",
          words: [
            { text: "Hello", start: 0, end: 0.3 },
            { text: "world", start: 0.3, end: 0.7 },
          ],
        },
      },
    });

    expect(mockStoreCreativeAssetBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        assetId: "asset-1",
        kind: "text",
        mimeType: "text/vtt",
        fileName: "elevenlabs-subtitles.vtt",
      })
    );
    const buffer = mockStoreCreativeAssetBuffer.mock.calls[0][0]
      .buffer as Buffer;
    expect(buffer.toString("utf8")).toContain("WEBVTT");
    expect(mockFindByIdAndUpdate).toHaveBeenCalledWith(
      "asset-1",
      expect.objectContaining({
        status: "complete",
        providerRequestId: "stt_req_1",
        storageProvider: "gcs",
        error: null,
      })
    );
  });

  it("does not rewrite an already complete asset on webhook retry", async () => {
    mockFindOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: "asset-1",
        workspaceId: "workspace-1",
        provider: "elevenlabs",
        status: "complete",
        providerRequestId: "stt_req_1",
      }),
    });

    await completeElevenLabsCreativeTranscriptionAsset({
      workspaceId: "workspace-1",
      assetId: "asset-1",
      requestId: "stt_req_1",
      mode: "transcript",
      status: "completed",
      webhookType: "speech_to_text_transcription",
      data: {
        request_id: "stt_req_1",
        status: "completed",
        transcription: { text: "Already done" },
      },
    });

    expect(mockStoreCreativeAssetBuffer).not.toHaveBeenCalled();
    expect(mockFindByIdAndUpdate).not.toHaveBeenCalled();
  });
});
