const mockRequireScenarioWorkspaceAccess = jest.fn();
const mockStoreScenarioAssetBuffer = jest.fn();
const mockInitiateScenarioAssetUpload = jest.fn();
const mockCompleteScenarioAssetUpload = jest.fn();

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));

jest.mock("@/lib/scenarios/scenario-asset-storage", () => ({
  storeScenarioAssetBuffer: (...args: unknown[]) =>
    mockStoreScenarioAssetBuffer(...args),
  initiateScenarioAssetUpload: (...args: unknown[]) =>
    mockInitiateScenarioAssetUpload(...args),
  completeScenarioAssetUpload: (...args: unknown[]) =>
    mockCompleteScenarioAssetUpload(...args),
}));

import { POST } from "./route";

const workspaceId = "workspace-1";

function createUploadRequest(file: File, channel?: "whatsapp") {
  const formData = new FormData();
  formData.set("file", file);
  if (channel) {
    formData.set("channel", channel);
  }

  return new Request(
    "http://localhost/api/workspaces/workspace-1/scenarios/action-image-upload",
    {
      method: "POST",
      body: formData,
    }
  ) as never;
}

describe("POST /api/workspaces/[workspaceId]/scenarios/action-image-upload", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({ ok: true });
    mockStoreScenarioAssetBuffer.mockResolvedValue({
      url: "gcs://icecore-ai-creative-assets-prod/workspaces/workspace-1/creative-assets/text/scenario-abc/action-doc.pdf",
      displayUrl: "https://storage.googleapis.com/signed/action-doc.pdf",
      bucket: "icecore-ai-creative-assets-prod",
      path: "workspaces/workspace-1/creative-assets/text/scenario-abc/action-doc.pdf",
      mimeType: "application/pdf",
      fileName: "action doc.pdf",
      fileSize: 3,
    });
  });

  it("creates a browser upload target from metadata without reading file bytes", async () => {
    mockInitiateScenarioAssetUpload.mockResolvedValueOnce({
      provider: "gcs",
      method: "PUT",
      bucket: "bucket",
      path: "path/fashion.mp4",
      uploadUrl: "https://storage.googleapis.com/upload-session",
      uploadToken: "ticket",
      fileName: "fashion.mp4",
      mimeType: "video/mp4",
      fileSize: 16_339_444,
    });
    const request = new Request("http://localhost/upload", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://airi.chat",
      },
      body: JSON.stringify({
        action: "initiate",
        channel: "whatsapp",
        fileName: "fashion.mp4",
        mimeType: "video/mp4",
        fileSize: 16_339_444,
      }),
    });
    const response = await POST(request as never, {
      params: Promise.resolve({ workspaceId }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      upload: { uploadToken: "ticket" },
    });
    expect(mockInitiateScenarioAssetUpload).toHaveBeenCalledWith({
      workspaceId,
      channel: "whatsapp",
      fileName: "fashion.mp4",
      mimeType: "video/mp4",
      fileSize: 16_339_444,
      origin: "https://airi.chat",
    });
    expect(mockStoreScenarioAssetBuffer).not.toHaveBeenCalled();
  });

  it("completes an upload using only the server-issued ticket and preserves the display/durable response", async () => {
    mockCompleteScenarioAssetUpload.mockResolvedValueOnce({
      url: "gcs://bucket/path/fashion.mp4",
      displayUrl: "https://storage.googleapis.com/signed/fashion.mp4",
      bucket: "bucket",
      path: "path/fashion.mp4",
      mediaType: "video",
      mimeType: "video/mp4",
      fileName: "fashion.mp4",
      fileSize: 16_339_444,
    });
    const response = await POST(
      new Request("http://localhost/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "complete", uploadToken: "ticket" }),
      }) as never,
      { params: Promise.resolve({ workspaceId }) }
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      image: {
        url: "https://storage.googleapis.com/signed/fashion.mp4",
        durableUrl: "gcs://bucket/path/fashion.mp4",
        mediaType: "video",
        fileSize: 16_339_444,
      },
    });
    expect(mockCompleteScenarioAssetUpload).toHaveBeenCalledWith({
      workspaceId,
      uploadToken: "ticket",
    });
    expect(mockStoreScenarioAssetBuffer).not.toHaveBeenCalled();
  });

  it("rejects client-supplied completion targets before querying storage", async () => {
    const response = await POST(
      new Request("http://localhost/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "complete",
          uploadToken: "ticket",
          bucket: "other-bucket",
          path: "other-workspace/file.mp4",
        }),
      }) as never,
      { params: Promise.resolve({ workspaceId }) }
    );
    expect(response.status).toBe(400);
    expect(mockCompleteScenarioAssetUpload).not.toHaveBeenCalled();
  });

  it("uploads files to GCS via the media API", async () => {
    const file = new File(["pdf"], "action doc.pdf", {
      type: "application/pdf",
    });

    const response = await POST(createUploadRequest(file), {
      params: Promise.resolve({ workspaceId }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      image: {
        url: "https://storage.googleapis.com/signed/action-doc.pdf",
        durableUrl:
          "gcs://icecore-ai-creative-assets-prod/workspaces/workspace-1/creative-assets/text/scenario-abc/action-doc.pdf",
        bucket: "icecore-ai-creative-assets-prod",
        mimeType: "application/pdf",
        fileName: "action doc.pdf",
        fileSize: file.size,
      },
    });
    expect(mockStoreScenarioAssetBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        mimeType: "application/pdf",
        fileName: "action doc.pdf",
        buffer: expect.any(Buffer),
      })
    );
  });

  it("infers PDF type from filename", async () => {
    mockStoreScenarioAssetBuffer.mockResolvedValueOnce({
      url: "gcs://bucket/path/terms.pdf",
      displayUrl: "https://cdn.example.com/terms.pdf",
      bucket: "bucket",
      path: "path/terms.pdf",
      mimeType: "application/pdf",
      fileName: "terms.pdf",
      fileSize: 3,
    });

    const file = new File(["pdf"], "terms.pdf", {
      type: "application/octet-stream",
    });

    const response = await POST(createUploadRequest(file), {
      params: Promise.resolve({ workspaceId }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      image: {
        mimeType: "application/pdf",
      },
    });
    expect(mockStoreScenarioAssetBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        mimeType: "application/pdf",
      })
    );
  });

  it("infers PDFs from filename when the browser reports an alternate MIME type", async () => {
    mockStoreScenarioAssetBuffer.mockResolvedValueOnce({
      url: "gcs://bucket/path/boutique-menu.pdf",
      displayUrl: "https://cdn.example.com/boutique-menu.pdf",
      bucket: "bucket",
      path: "path/boutique-menu.pdf",
      mimeType: "application/pdf",
      fileName: "boutique-menu.pdf",
      fileSize: 3,
    });

    const file = new File(["pdf"], "boutique-menu.pdf", {
      type: "application/x-pdf",
    });

    const response = await POST(createUploadRequest(file), {
      params: Promise.resolve({ workspaceId }),
    });

    expect(response.status).toBe(200);
    expect(mockStoreScenarioAssetBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        mimeType: "application/pdf",
      })
    );
  });

  it("classifies WhatsApp scenario uploads as image, video, or document media", async () => {
    mockStoreScenarioAssetBuffer.mockResolvedValueOnce({
      url: "gcs://bucket/path/catalog.pdf",
      displayUrl: "https://cdn.example.com/catalog.pdf",
      bucket: "bucket",
      path: "path/catalog.pdf",
      mimeType: "application/pdf",
      fileName: "catalog.pdf",
      fileSize: 3,
    });

    const file = new File(["pdf"], "catalog.pdf", {
      type: "application/pdf",
    });

    const response = await POST(createUploadRequest(file, "whatsapp"), {
      params: Promise.resolve({ workspaceId }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      image: {
        url: "https://cdn.example.com/catalog.pdf",
        mediaType: "document",
        mimeType: "application/pdf",
        fileName: "catalog.pdf",
      },
    });
  });

  it.each([
    ["sticker.webp", "image/webp", "sticker"],
    ["voice-note.ogg", "audio/ogg", "audio"],
  ])(
    "accepts official WhatsApp service media %s",
    async (fileName, mimeType, mediaType) => {
      mockStoreScenarioAssetBuffer.mockResolvedValueOnce({
        url: `gcs://bucket/path/${fileName}`,
        displayUrl: `https://cdn.example.com/${fileName}`,
        bucket: "bucket",
        path: `path/${fileName}`,
        mimeType,
        fileName,
        fileSize: 5,
      });
      const file = new File(["media"], fileName, { type: mimeType });

      const response = await POST(createUploadRequest(file, "whatsapp"), {
        params: Promise.resolve({ workspaceId }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        image: { mediaType, mimeType, fileName },
      });
    }
  );
});
