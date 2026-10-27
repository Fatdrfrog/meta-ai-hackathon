import {
  createGcsWhatsAppVoiceReplyStoragePort,
  configureGcsWhatsAppVoiceReplyStorage,
} from "../../../../../../temporal-worker/src/whatsapp-voice-reply-gcs-adapter";
import {
  configureWhatsAppVoiceReplyStorage,
  getWhatsAppVoiceReplyStorage,
} from "@icecore/airi-runtime/whatsapp-voice-reply-storage";
const mockStat = jest.fn();
const mockUpload = jest.fn();
jest.mock(
  "../../../../../../temporal-worker/src/gcs-creative-assets.js",
  () => ({
    getGcsCreativeAssetsBucketName: () => "bucket",
    statGcsCreativeAssetObject: (...args: unknown[]) => mockStat(...args),
    uploadGcsCreativeAssetBuffer: (...args: unknown[]) => mockUpload(...args),
  }),
  { virtual: true }
);

const ref = { workspaceId: "w", assetId: "airi-voice-hash" };
const path = "workspaces/w/creative-assets/audio/airi-voice-hash/reply.ogg";
describe("voice reply GCS storage adapter", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    configureWhatsAppVoiceReplyStorage(null);
    mockStat.mockResolvedValue({
      exists: true,
      mimeType: "audio/ogg",
      fileSize: 100,
      customMetadata: {
        workspaceId: "w",
        assetId: ref.assetId,
        purpose: "airi-whatsapp-voice-reply",
      },
    });
    mockUpload.mockResolvedValue({
      url: `gcs://bucket/${path}`,
      bucket: "bucket",
      path,
      mimeType: "audio/ogg",
      fileName: "reply.ogg",
      fileSize: 100,
    });
  });
  it("reads only the deterministic workspace-owned audio object", async () => {
    const result = await createGcsWhatsAppVoiceReplyStoragePort().find(ref);
    expect(mockStat).toHaveBeenCalledWith({
      bucket: "bucket",
      path,
      workspaceId: "w",
    });
    expect(result).toMatchObject({
      url: `gcs://bucket/${path}`,
      mediaType: "audio",
      mimeType: "audio/ogg",
      fileSize: 100,
    });
  });
  it.each([
    { exists: false },
    { exists: true, fileSize: 0 },
    { exists: true, fileSize: 1, mimeType: "audio/mpeg" },
    {
      exists: true,
      fileSize: 1,
      mimeType: "audio/ogg",
      customMetadata: { workspaceId: "other" },
    },
  ])("rejects absent or mismatched cached objects", async metadata => {
    mockStat.mockResolvedValue(metadata);
    await expect(
      createGcsWhatsAppVoiceReplyStoragePort().find(ref)
    ).resolves.toBeNull();
  });
  it("stores create-only with existing upload and ownership metadata", async () => {
    const buffer = Buffer.from("voice");
    const result = await createGcsWhatsAppVoiceReplyStoragePort().store({
      ...ref,
      buffer,
    });
    expect(mockUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        ...ref,
        buffer,
        kind: "audio",
        mimeType: "audio/ogg",
        fileName: "reply.ogg",
        preconditionOpts: { ifGenerationMatch: 0 },
        customMetadata: { purpose: "airi-whatsapp-voice-reply" },
      })
    );
    expect(result).toMatchObject({
      mediaType: "audio",
      url: `gcs://bucket/${path}`,
    });
  });
  it("recovers the matching winning object when another worker created it", async () => {
    mockUpload.mockRejectedValue({ code: 412 });
    await expect(
      createGcsWhatsAppVoiceReplyStoragePort().store({
        ...ref,
        buffer: Buffer.from("voice"),
      })
    ).resolves.toMatchObject({ mediaType: "audio" });
  });
  it("propagates non-precondition storage errors for text fallback", async () => {
    mockUpload.mockRejectedValue(new Error("storage unavailable"));
    await expect(
      createGcsWhatsAppVoiceReplyStoragePort().store({
        ...ref,
        buffer: Buffer.from("voice"),
      })
    ).rejects.toThrow("storage unavailable");
  });
  it("registers a shared storage port with working media reads at the worker composition root", async () => {
    configureGcsWhatsAppVoiceReplyStorage();
    await expect(
      getWhatsAppVoiceReplyStorage()?.find(ref)
    ).resolves.toMatchObject({
      url: `gcs://bucket/${path}`,
      mediaType: "audio",
    });
  });
});
