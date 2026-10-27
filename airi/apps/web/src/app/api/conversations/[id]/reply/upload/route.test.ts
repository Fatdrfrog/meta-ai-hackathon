const mockConversationFindById = jest.fn();
const mockCreateBucket = jest.fn();
const mockGetBucket = jest.fn();
const mockGetHiddenConversationPlanGateResponse = jest.fn();
const mockGetPublicUrl = jest.fn();
const mockResolveWhatsAppSendContext = jest.fn();
const mockStorageFrom = jest.fn();
const mockUpload = jest.fn();
const mockUploadWhatsAppMediaFile = jest.fn();
const mockVerifyWorkspaceAccess = jest.fn();
const mockReserveStorage = jest.fn();
const mockCreateSignedUploadUrl = jest.fn();
jest.mock("@icecore/airi-runtime/storage-quota", () => {
  const actual = jest.requireActual("@icecore/airi-runtime/storage-quota");
  const quota = {
    reserve: (...args: unknown[]) => mockReserveStorage(...args),
    settle: async () => {},
  };
  return {
    ...actual,
    storeSupabaseWorkspaceBuffer: (params: object) =>
      actual.storeSupabaseWorkspaceBuffer({ ...params, quota }),
    createReservedSupabaseUpload: (params: object) =>
      actual.createReservedSupabaseUpload({ ...params, quota }),
  };
});

jest.mock("@/lib/limits/company-limits", () => ({
  getHiddenConversationPlanGateResponse: (...args: unknown[]) =>
    mockGetHiddenConversationPlanGateResponse(...args),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/sources/utils", () => ({
  verifyWorkspaceAccess: (...args: unknown[]) =>
    mockVerifyWorkspaceAccess(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    storage: {
      getBucket: (...args: unknown[]) => mockGetBucket(...args),
      createBucket: (...args: unknown[]) => mockCreateBucket(...args),
      from: (...args: unknown[]) => mockStorageFrom(...args),
    },
  },
}));

jest.mock("@/lib/supabase/route-auth", () => ({
  getSupabaseRouteAuth: jest.fn().mockResolvedValue({
    supabase: { from: jest.fn() },
    user: { id: "manager_1" },
  }),
  isSupabaseRouteAuthError: () => false,
}));

jest.mock("@/lib/whatsapp/media-upload", () => ({
  uploadWhatsAppMediaFile: (...args: unknown[]) =>
    mockUploadWhatsAppMediaFile(...args),
}));

jest.mock("@/lib/whatsapp/send-context", () => ({
  resolveWhatsAppSendContext: (...args: unknown[]) =>
    mockResolveWhatsAppSendContext(...args),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => mockConversationFindById(...args),
  },
}));

import { POST } from "@/app/api/conversations/[id]/reply/upload/route";

function buildConversation(channel = "whatsapp") {
  return {
    _id: "conv_1",
    workspaceId: "workspace_1",
    channel,
    sourceId: "source_1",
  };
}

function mockConversationQuery(
  conversation: ReturnType<typeof buildConversation>
) {
  return {
    select: () => ({ lean: jest.fn().mockResolvedValue(conversation) }),
  };
}

function createUploadRequest(file: File) {
  const formData = new FormData();
  formData.set("file", file);
  return new Request(
    "https://app.airi.chat/api/conversations/conv_1/reply/upload",
    {
      method: "POST",
      body: formData,
    }
  ) as never;
}

function createDirectUploadRequest(payload: Record<string, unknown>) {
  return new Request(
    "https://app.airi.chat/api/conversations/conv_1/reply/upload",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }
  ) as never;
}

describe("POST /api/conversations/[id]/reply/upload", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReserveStorage.mockResolvedValue({
      _id: "reservation",
      status: "reserved",
    });
    mockConversationFindById.mockReturnValue(
      mockConversationQuery(buildConversation())
    );
    mockCreateBucket.mockResolvedValue({ error: null });
    mockGetBucket.mockResolvedValue({
      data: {
        name: "conversation-attachments",
        public: true,
        file_size_limit: 20 * 1024 * 1024,
      },
      error: null,
    });
    mockGetHiddenConversationPlanGateResponse.mockResolvedValue(null);
    mockGetPublicUrl.mockReturnValue({
      data: { publicUrl: "https://cdn.example.com/outbound/contract.pdf" },
    });
    mockResolveWhatsAppSendContext.mockResolvedValue({
      phoneNumberId: "phone_1",
      accessToken: "token_1",
    });
    mockStorageFrom.mockReturnValue({
      upload: mockUpload,
      getPublicUrl: mockGetPublicUrl,
      createSignedUploadUrl: mockCreateSignedUploadUrl,
    });
    mockCreateSignedUploadUrl.mockResolvedValue({
      data: { token: "upload_token_1" },
      error: null,
    });
    mockUpload.mockResolvedValue({ error: null });
    mockUploadWhatsAppMediaFile.mockResolvedValue({
      id: "media_pdf_1",
      mimeType: "application/pdf",
      sizeBytes: 3,
    });
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
  });

  it("uploads WhatsApp PDFs to Meta and stores document metadata", async () => {
    const file = new File(["pdf"], "contract.pdf", {
      type: "application/pdf",
    });

    const response = await POST(createUploadRequest(file), {
      params: Promise.resolve({ id: "conv_1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      attachment: {
        url: "https://cdn.example.com/outbound/contract.pdf",
        whatsappMediaId: "media_pdf_1",
        mediaType: "document",
        mimeType: "application/pdf",
        fileName: "contract.pdf",
        fileSize: 3,
      },
    });
    expect(mockResolveWhatsAppSendContext).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      sourceId: "source_1",
    });
    expect(mockUploadWhatsAppMediaFile).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: "phone_1",
        accessToken: "token_1",
        file: expect.any(File),
        fallbackMimeType: "application/pdf",
        filename: "contract.pdf",
      })
    );
    expect(mockStorageFrom).toHaveBeenCalledWith("conversation-attachments");
    expect(mockUpload).toHaveBeenCalledWith(
      expect.stringMatching(
        /^outbound\/whatsapp\/workspace_1\/conv_1\/\d+-[a-f0-9]+-contract\.pdf$/
      ),
      expect.any(Buffer),
      expect.objectContaining({
        contentType: "application/pdf",
      })
    );
  });

  it("rejects unsupported WhatsApp files before Meta or storage upload", async () => {
    const file = new File(["zip"], "archive.zip", {
      type: "application/octet-stream",
    });

    const response = await POST(createUploadRequest(file), {
      params: Promise.resolve({ id: "conv_1" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("not supported"),
    });
    expect(mockUploadWhatsAppMediaFile).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("rejects oversized WhatsApp stickers before Meta or storage upload", async () => {
    const file = new File([new Uint8Array(100 * 1024 + 1)], "sticker.webp", {
      type: "image/webp",
    });

    const response = await POST(createUploadRequest(file), {
      params: Promise.resolve({ id: "conv_1" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("100 KB"),
    });
    expect(mockUploadWhatsAppMediaFile).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("rejects direct uploads for channels that do not deliver attachments", async () => {
    mockConversationFindById.mockReturnValueOnce(
      mockConversationQuery(buildConversation("web_widget"))
    );

    const response = await POST(
      createDirectUploadRequest({
        mode: "direct",
        fileName: "terms.pdf",
        mimeType: "application/pdf",
        fileSize: 3,
      }),
      { params: Promise.resolve({ id: "conv_1" }) }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("not supported"),
    });
    expect(mockStorageFrom).not.toHaveBeenCalled();
  });

  it("reserves a direct storage upload for Telegram attachments", async () => {
    mockConversationFindById.mockReturnValueOnce(
      mockConversationQuery(buildConversation("telegram"))
    );

    const response = await POST(
      createDirectUploadRequest({
        mode: "direct",
        fileName: "terms.pdf",
        mimeType: "application/pdf",
        fileSize: 3,
      }),
      { params: Promise.resolve({ id: "conv_1" }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      upload: {
        bucket: "conversation-attachments",
        token: "upload_token_1",
      },
      attachment: {
        url: "https://cdn.example.com/outbound/contract.pdf",
        mediaType: "document",
        fileName: "terms.pdf",
        fileSize: 3,
      },
    });
    expect(payload.upload.path).toMatch(
      /^outbound\/telegram\/workspace_1\/conv_1\/\d+-[a-f0-9]+-terms\.pdf$/
    );
    expect(mockUploadWhatsAppMediaFile).not.toHaveBeenCalled();
  });

  it("rejects multipart uploads for channels that upload directly", async () => {
    mockConversationFindById.mockReturnValueOnce(
      mockConversationQuery(buildConversation("telegram"))
    );

    const response = await POST(
      createUploadRequest(
        new File(["pdf"], "contract.pdf", { type: "application/pdf" })
      ),
      { params: Promise.resolve({ id: "conv_1" }) }
    );

    expect(response.status).toBe(400);
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockUploadWhatsAppMediaFile).not.toHaveBeenCalled();
  });

  it("rejects empty direct uploads", async () => {
    mockConversationFindById.mockReturnValueOnce(
      mockConversationQuery(buildConversation("telegram"))
    );

    const response = await POST(
      createDirectUploadRequest({
        mode: "direct",
        fileName: "empty.pdf",
        mimeType: "application/pdf",
        fileSize: 0,
      }),
      { params: Promise.resolve({ id: "conv_1" }) }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Empty file" });
    expect(mockCreateSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("rejects WhatsApp uploads when send credentials are missing", async () => {
    mockResolveWhatsAppSendContext.mockResolvedValueOnce(null);

    const response = await POST(
      createUploadRequest(
        new File(["pdf"], "contract.pdf", { type: "application/pdf" })
      ),
      { params: Promise.resolve({ id: "conv_1" }) }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("credentials"),
    });
    expect(mockUploadWhatsAppMediaFile).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("rejects upload when workspace access is denied", async () => {
    mockVerifyWorkspaceAccess.mockResolvedValueOnce(false);

    const response = await POST(
      createUploadRequest(
        new File(["pdf"], "contract.pdf", { type: "application/pdf" })
      ),
      { params: Promise.resolve({ id: "conv_1" }) }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Access denied"),
    });
    expect(mockResolveWhatsAppSendContext).not.toHaveBeenCalled();
    expect(mockUploadWhatsAppMediaFile).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("returns the plan gate response before upload work", async () => {
    const gateResponse = Response.json(
      { error: "plan blocked" },
      { status: 402 }
    );
    mockGetHiddenConversationPlanGateResponse.mockResolvedValueOnce(
      gateResponse
    );

    const response = await POST(
      createUploadRequest(
        new File(["pdf"], "contract.pdf", { type: "application/pdf" })
      ),
      { params: Promise.resolve({ id: "conv_1" }) }
    );

    expect(response.status).toBe(402);
    expect(mockUploadWhatsAppMediaFile).not.toHaveBeenCalled();
    expect(mockStorageFrom).not.toHaveBeenCalled();
  });
});
