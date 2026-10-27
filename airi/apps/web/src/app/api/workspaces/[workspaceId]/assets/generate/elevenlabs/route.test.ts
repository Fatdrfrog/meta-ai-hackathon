const mockRequireScenarioWorkspaceAccess = jest.fn();
const mockConnectDB = jest.fn();
const mockCreate = jest.fn();
const mockFindByIdAndUpdate = jest.fn();
const mockFindOne = jest.fn();
const mockCountDocuments = jest.fn();
const mockResolveWorkspaceElevenLabsGenerationAccess = jest.fn();
const mockStartElevenLabsCreativeTranscriptionWorkflow = jest.fn();
const mockSubmitElevenLabsTextToSpeech = jest.fn();
const mockStoreCreativeAssetBuffer = jest.fn();

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/elevenlabs/elevenlabs-source", () => ({
  isPlatformElevenLabsConfigured: () => true,
  resolveWorkspaceElevenLabsGenerationAccess: (...args: unknown[]) =>
    mockResolveWorkspaceElevenLabsGenerationAccess(...args),
}));

jest.mock("@/lib/elevenlabs/creative-assets", () => ({
  buildWebVttFromElevenLabsWords: () => "WEBVTT\n\n",
  buildWebVttFromPlainText: () => "WEBVTT\n\n",
  startElevenLabsDubbing: jest.fn(),
  submitElevenLabsSoundEffect: jest.fn(),
  submitElevenLabsTextToSpeech: (...args: unknown[]) =>
    mockSubmitElevenLabsTextToSpeech(...args),
}));

jest.mock("@/lib/temporal/elevenlabs-creative-transcription", () => ({
  startElevenLabsCreativeTranscriptionWorkflow: (...args: unknown[]) =>
    mockStartElevenLabsCreativeTranscriptionWorkflow(...args),
}));

jest.mock("@/lib/higgsfield/creative-asset-storage", () => ({
  storeCreativeAssetBuffer: (...args: unknown[]) =>
    mockStoreCreativeAssetBuffer(...args),
}));

jest.mock("@/models/creative-asset", () => ({
  CreativeAsset: {
    create: (...args: unknown[]) => mockCreate(...args),
    findByIdAndUpdate: (...args: unknown[]) => mockFindByIdAndUpdate(...args),
    findOne: (...args: unknown[]) => mockFindOne(...args),
    countDocuments: (...args: unknown[]) => mockCountDocuments(...args),
  },
}));

import { POST } from "./route";

describe("POST /api/workspaces/[workspaceId]/assets/generate/elevenlabs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      supabase: {},
      userId: "user-1",
    });
    mockConnectDB.mockResolvedValue(undefined);
    mockResolveWorkspaceElevenLabsGenerationAccess.mockResolvedValue({
      available: true,
      reason: null,
      sourceId: "source-elevenlabs",
      credentialSource: "workspace_source",
      apiKey: "elevenlabs-key",
      defaultVoiceId: "voice-1",
    });
    mockCountDocuments.mockResolvedValue(0);
    mockCreate.mockResolvedValue({
      _id: "asset-1",
      workspaceId: "workspace-1",
      kind: "audio",
      source: "elevenlabs",
      provider: "elevenlabs",
      status: "queued",
      prompt: "A short voiceover",
    });
    mockSubmitElevenLabsTextToSpeech.mockResolvedValue({
      buffer: Buffer.from("audio"),
      mimeType: "audio/mpeg",
      fileName: "elevenlabs-voiceover.mp3",
      modelId: "eleven_multilingual_v2",
      raw: { voiceId: "voice-1" },
    });
    mockStoreCreativeAssetBuffer.mockResolvedValue({
      url: "https://storage.example.com/voiceover.mp3",
      bucket: "creative-assets",
      path: "workspaces/workspace-1/creative-assets/audio/asset-1/voiceover.mp3",
      mimeType: "audio/mpeg",
      fileName: "elevenlabs-voiceover.mp3",
      fileSize: 5,
    });
    mockFindByIdAndUpdate.mockResolvedValue({
      _id: "asset-1",
      workspaceId: "workspace-1",
      kind: "audio",
      source: "elevenlabs",
      provider: "elevenlabs",
      status: "complete",
      prompt: "A short voiceover",
      url: "https://storage.example.com/voiceover.mp3",
    });
    mockStartElevenLabsCreativeTranscriptionWorkflow.mockResolvedValue({
      workflowId: "elevenlabs-creative-transcription:asset-transcript-1",
      taskQueue: "airi-media",
      duplicate: false,
    });
  });

  it("pins the customer source for ElevenLabs voiceover", async () => {
    const response = await POST(
      new Request(
        "http://localhost/api/workspaces/workspace-1/assets/generate/elevenlabs",
        {
          method: "POST",
          body: JSON.stringify({
            mode: "text_to_speech",
            text: "A short voiceover",
          }),
        }
      ) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        kind: "audio",
        source: "elevenlabs",
        provider: "elevenlabs",
        status: "queued",
      })
    );
    expect(mockSubmitElevenLabsTextToSpeech).toHaveBeenCalledWith({
      apiKey: "elevenlabs-key",
      text: "A short voiceover",
      voiceId: "voice-1",
      language: undefined,
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ providerSourceId: "source-elevenlabs" })
    );
    expect(payload.asset.source).toBe("elevenlabs");
    expect(payload.elevenLabsConfigured).toBe(true);
  });

  it.each([0, 10])(
    "requires customer credentials even when the preview pool has used %s slots",
    async used => {
      mockCountDocuments.mockResolvedValue(used);
      mockResolveWorkspaceElevenLabsGenerationAccess.mockResolvedValue({
        available: true,
        reason: null,
        sourceId: null,
        credentialSource: "platform",
        apiKey: "platform-key",
        defaultVoiceId: "voice-1",
      });
      const response = await POST(
        new Request(
          "http://localhost/api/workspaces/workspace-1/assets/generate/elevenlabs",
          {
            method: "POST",
            body: JSON.stringify({
              mode: "text_to_speech",
              text: "A short voiceover",
            }),
          }
        ) as never,
        { params: Promise.resolve({ workspaceId: "workspace-1" }) }
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "own_ai_source_required",
        elevenLabsDisabledReason: "source_required",
      });
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockSubmitElevenLabsTextToSpeech).not.toHaveBeenCalled();
    }
  );

  it("keeps workspace-source ElevenLabs creation outside platform admission", async () => {
    mockResolveWorkspaceElevenLabsGenerationAccess.mockResolvedValue({
      available: true,
      reason: null,
      sourceId: "source-elevenlabs",
      credentialSource: "workspace_source",
      apiKey: "workspace-elevenlabs-key",
      defaultVoiceId: "voice-1",
    });
    mockCountDocuments.mockResolvedValue(10);

    const response = await POST(
      new Request(
        "http://localhost/api/workspaces/workspace-1/assets/generate/elevenlabs",
        {
          method: "POST",
          body: JSON.stringify({
            mode: "text_to_speech",
            text: "A workspace-funded voiceover",
          }),
        }
      ) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ providerSourceId: "source-elevenlabs" })
    );
  });

  it("submits transcript generation asynchronously and leaves the text asset queued", async () => {
    mockFindOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: "source-asset-1",
        workspaceId: "workspace-1",
        kind: "video",
        source: "uploaded",
        status: "complete",
        url: "https://cdn.example.com/source.mp4",
        mimeType: "video/mp4",
        fileName: "source.mp4",
      }),
    });
    mockCreate.mockResolvedValue({
      _id: "asset-transcript-1",
      workspaceId: "workspace-1",
      kind: "text",
      source: "elevenlabs",
      provider: "elevenlabs",
      status: "queued",
      prompt: "Transcript for source.mp4",
      sourceAssetId: "source-asset-1",
    });
    mockFindByIdAndUpdate.mockResolvedValue({
      _id: "asset-transcript-1",
      workspaceId: "workspace-1",
      kind: "text",
      source: "elevenlabs",
      provider: "elevenlabs",
      status: "queued",
      prompt: "Transcript for source.mp4",
      sourceAssetId: "source-asset-1",
    });

    const response = await POST(
      new Request(
        "http://localhost/api/workspaces/workspace-1/assets/generate/elevenlabs",
        {
          method: "POST",
          body: JSON.stringify({
            mode: "transcript",
            sourceAssetId: "507f1f77bcf86cd799439011",
          }),
        }
      ) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(
      mockStartElevenLabsCreativeTranscriptionWorkflow
    ).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      assetId: "asset-transcript-1",
      sourceAssetId: "507f1f77bcf86cd799439011",
      mode: "transcript",
      mediaType: "video",
      providerSourceId: "source-elevenlabs",
    });
    expect(mockStoreCreativeAssetBuffer).not.toHaveBeenCalled();
    expect(mockFindByIdAndUpdate).toHaveBeenCalledWith(
      "asset-transcript-1",
      expect.objectContaining({
        status: "queued",
        providerPayload: {
          mode: "transcript",
          workflowId: "elevenlabs-creative-transcription:asset-transcript-1",
          taskQueue: "airi-media",
          duplicate: false,
        },
      }),
      { new: true }
    );
    expect(payload.asset.status).toBe("queued");
  });
});
