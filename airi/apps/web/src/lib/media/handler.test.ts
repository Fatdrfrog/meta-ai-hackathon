const mockGetWhatsAppMediaInfoFromMeta = jest.fn();
const mockDownloadWhatsAppMediaUrl = jest.fn();
const mockStorageUpload = jest.fn();
const mockGetPublicUrl = jest.fn();
const mockStoreWorkspaceBuffer = jest.fn();
jest.mock("@icecore/airi-runtime/storage-quota", () => ({
  storeSupabaseWorkspaceBuffer: (...args: unknown[]) =>
    mockStoreWorkspaceBuffer(...args),
}));

jest.mock("@/lib/media/whatsapp-media-graph", () => ({
  getWhatsAppMediaInfoFromMeta: (...args: unknown[]) =>
    mockGetWhatsAppMediaInfoFromMeta(...args),
  downloadWhatsAppMediaUrl: (...args: unknown[]) =>
    mockDownloadWhatsAppMediaUrl(...args),
}));

const mockSafeCrawlFetch = jest.fn();
jest.mock("@/lib/crawler/url-safety", () => ({
  safeCrawlFetch: (...args: unknown[]) => mockSafeCrawlFetch(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    storage: {
      from: jest.fn(() => ({
        upload: (...args: unknown[]) => mockStorageUpload(...args),
        getPublicUrl: (...args: unknown[]) => mockGetPublicUrl(...args),
      })),
    },
  },
}));

import {
  handleInstagramMedia,
  handleWhatsAppMedia,
  uploadMedia,
} from "@/lib/media/handler";

describe("handleWhatsAppMedia", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStoreWorkspaceBuffer.mockResolvedValue(undefined);
    mockGetPublicUrl.mockReturnValue({
      data: { publicUrl: "https://storage.test/media" },
    });
  });

  // The conversation buckets refuse objects over 20 MiB (HTTP 413), so media
  // between 20 and 50 MiB used to be dropped as "upload failed".
  it("keeps WhatsApp media over the bucket ceiling proxied from Meta instead of storing it", async () => {
    mockGetWhatsAppMediaInfoFromMeta.mockResolvedValueOnce({
      id: "media_1",
      url: "https://lookaside.whatsapp.test/media",
      mime_type: "video/mp4",
      sha256: "sha",
      file_size: 20 * 1024 * 1024 + 1,
    });

    const result = await handleWhatsAppMedia(
      "media_1",
      "access_token",
      "ws_1",
      "conv_1",
      "wamid_1",
      "video",
      {
        mimeType: "video/mp4",
        filename: "large.mp4",
      }
    );

    expect(result).toEqual({
      publicUrl:
        "/api/conversations/conv_1/whatsapp-media/media_1?filename=large.mp4",
      storagePath: "",
      size: 20 * 1024 * 1024 + 1,
      contentType: "video/mp4",
      filename: "large.mp4",
      mediaType: "video",
    });
    expect(mockDownloadWhatsAppMediaUrl).not.toHaveBeenCalled();
    expect(mockStorageUpload).not.toHaveBeenCalled();
  });

  it("proxies media over the bucket ceiling when Meta reports no size", async () => {
    const size = 20 * 1024 * 1024 + 1;
    mockGetWhatsAppMediaInfoFromMeta.mockResolvedValueOnce({
      id: "media_3",
      url: "https://lookaside.whatsapp.test/document",
      mime_type: "application/pdf",
      sha256: "sha",
    });
    mockDownloadWhatsAppMediaUrl.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => "application/pdf" },
      arrayBuffer: async () => new ArrayBuffer(size),
    });

    const result = await handleWhatsAppMedia(
      "media_3",
      "access_token",
      "ws_1",
      "conv_1",
      "wamid_3",
      "document",
      { mimeType: "application/pdf", filename: "price list.pdf" }
    );

    expect(result).toMatchObject({
      publicUrl:
        "/api/conversations/conv_1/whatsapp-media/media_3?filename=price+list.pdf",
      storagePath: "",
      size,
      mediaType: "document",
    });
    expect(mockStoreWorkspaceBuffer).not.toHaveBeenCalled();
  });

  it("normalizes parameterized WhatsApp audio mime types before storage upload", async () => {
    mockGetWhatsAppMediaInfoFromMeta.mockResolvedValueOnce({
      id: "media_2",
      url: "https://lookaside.whatsapp.test/audio",
      mime_type: "audio/ogg; codecs=opus",
      sha256: "sha",
      file_size: 12,
    });
    mockDownloadWhatsAppMediaUrl.mockResolvedValueOnce({
      ok: true,
      headers: {
        get: () => "audio/ogg; codecs=opus",
      },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    mockStorageUpload.mockResolvedValueOnce({ error: null });

    const result = await handleWhatsAppMedia(
      "media_2",
      "access_token",
      "ws_1",
      "conv_1",
      "wamid_2",
      "audio"
    );

    expect(mockStoreWorkspaceBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_1",
        bucket: "conversation-images",
        path: "whatsapp/ws_1/conv_1/wamid_2.ogg",
        mimeType: "audio/ogg",
        buffer: Buffer.from([1, 2, 3]),
      })
    );
    expect(result).toMatchObject({
      contentType: "audio/ogg",
      mediaType: "audio",
    });
  });

  it("stops public attachment creation when company storage admission rejects", async () => {
    mockStoreWorkspaceBuffer.mockRejectedValueOnce(
      new Error("storage_limit_exceeded")
    );
    await expect(
      uploadMedia({
        channel: "telegram",
        workspaceId: "ws_1",
        conversationId: "conv_1",
        messageId: "42",
        buffer: Buffer.from("photo"),
        contentType: "image/jpeg",
      })
    ).rejects.toThrow("storage_limit_exceeded");
    expect(mockGetPublicUrl).not.toHaveBeenCalled();
    expect(mockStorageUpload).not.toHaveBeenCalled();
  });
});

describe("handleInstagramMedia", () => {
  const cdnUrl = "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1";
  const mediaResponse = (
    headers: Record<string, string>,
    body: BodyInit = new Uint8Array([0, 0, 0, 32]).buffer
  ) => new Response(body, { status: 200, headers });

  beforeEach(() => {
    jest.clearAllMocks();
    mockStoreWorkspaceBuffer.mockResolvedValue(undefined);
    mockGetPublicUrl.mockReturnValue({
      data: { publicUrl: "https://storage.test/media" },
    });
  });

  it("stores an unsupported_type clip as the video its bytes are", async () => {
    mockSafeCrawlFetch.mockResolvedValueOnce(
      mediaResponse({ "content-type": "video/mp4" })
    );

    const result = await handleInstagramMedia(
      cdnUrl,
      "ws_1",
      "conv_1",
      "mid_1"
    );

    expect(mockSafeCrawlFetch).toHaveBeenCalledWith(
      cdnUrl,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(mockStoreWorkspaceBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: "conversation-images",
        path: "instagram/ws_1/conv_1/mid_1.mp4",
        mimeType: "video/mp4",
        buffer: Buffer.from([0, 0, 0, 32]),
      })
    );
    expect(result).toMatchObject({
      publicUrl: "https://storage.test/media",
      contentType: "video/mp4",
      size: 4,
      mediaType: "video",
    });
  });

  it("reads the type from the file name when the CDN sends a generic one", async () => {
    mockSafeCrawlFetch.mockResolvedValueOnce(
      mediaResponse({
        "content-type": "application/octet-stream",
        "content-disposition": "inline;filename=AQOU.jpg",
      })
    );

    await expect(
      handleInstagramMedia(cdnUrl, "ws_1", "conv_1", "mid_2")
    ).resolves.toMatchObject({ contentType: "image/jpeg", mediaType: "image" });
  });

  it("downloads nothing from a link that is not Meta's media CDN", async () => {
    await expect(
      handleInstagramMedia(
        "https://www.instagram.com/reel/abc/",
        "ws_1",
        "conv_1",
        "mid_3"
      )
    ).rejects.toThrow("not on Meta's CDN");
    expect(mockSafeCrawlFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["a web page", { "content-type": "text/html; charset=utf-8" }],
    [
      "media over the 20 MB bucket limit",
      {
        "content-type": "video/mp4",
        "content-length": String(21 * 1024 * 1024),
      },
    ],
  ])("stores nothing when the CDN returns %s", async (_label, headers) => {
    mockSafeCrawlFetch.mockResolvedValueOnce(mediaResponse(headers));

    await expect(
      handleInstagramMedia(cdnUrl, "ws_1", "conv_1", "mid_4")
    ).rejects.toThrow();
    expect(mockStoreWorkspaceBuffer).not.toHaveBeenCalled();
  });
});
