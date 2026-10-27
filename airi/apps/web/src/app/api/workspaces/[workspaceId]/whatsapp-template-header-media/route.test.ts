const mockCreateClient = jest.fn();
const mockVerifyWorkspaceAccess = jest.fn();
const mockStorageFrom = jest.fn();
const mockReserveStorage = jest.fn();
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

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/sources/utils", () => ({
  verifyWorkspaceAccess: (...args: unknown[]) =>
    mockVerifyWorkspaceAccess(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    storage: {
      getBucket: async () => ({
        data: { file_size_limit: 100 * 1024 * 1024 },
        error: null,
      }),
      from: (...args: unknown[]) => mockStorageFrom(...args),
    },
  },
}));

import { POST } from "./route";

const workspaceId = "workspace-1";
const TEMPLATE_VIDEO_LIMIT_BYTES = 16 * 1024 * 1024;

function createSupabaseClient(user: { id: string } | null = { id: "user-1" }) {
  return {
    auth: {
      getUser: jest.fn(async () => ({ data: { user } })),
    },
  };
}

function createUploadRequest(file: File, format = "IMAGE") {
  const formData = new FormData();
  formData.set("file", file);
  formData.set("format", format);

  return new Request(
    "http://localhost/api/workspaces/workspace-1/whatsapp-template-header-media",
    {
      method: "POST",
      body: formData,
    }
  ) as never;
}

function createDirectUploadRequest(payload: Record<string, unknown>) {
  return new Request(
    "http://localhost/api/workspaces/workspace-1/whatsapp-template-header-media",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  ) as never;
}

describe("POST /api/workspaces/[workspaceId]/whatsapp-template-header-media", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReserveStorage.mockResolvedValue({
      _id: "reservation",
      status: "reserved",
    });
    mockCreateClient.mockResolvedValue(createSupabaseClient());
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
  });

  it("uploads valid template header media to public workspace storage", async () => {
    const upload = jest.fn(async () => ({ error: null }));
    const getPublicUrl = jest.fn(() => ({
      data: {
        publicUrl: "https://cdn.example.com/template-header.png",
      },
    }));
    mockStorageFrom.mockReturnValue({ upload, getPublicUrl });

    const file = new File(["image"], "template header.png", {
      type: "image/png",
    });

    const response = await POST(createUploadRequest(file), {
      params: Promise.resolve({ workspaceId }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      media: {
        url: "https://cdn.example.com/template-header.png",
        bucket: "business-media",
        mimeType: "image/png",
        fileName: "template header.png",
        fileSize: file.size,
      },
    });
    expect(mockVerifyWorkspaceAccess).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      workspaceId
    );
    expect(mockStorageFrom).toHaveBeenCalledWith("business-media");
    expect(upload).toHaveBeenCalledWith(
      expect.stringMatching(
        /^whatsapp-template-headers\/workspace-1\/\d+-[a-f0-9]+-template-header\.png$/
      ),
      expect.any(Buffer),
      expect.objectContaining({
        contentType: "image/png",
        cacheControl: "31536000",
        upsert: false,
      })
    );
  });

  it("creates a signed direct upload target for valid template header media", async () => {
    const createSignedUploadUrl = jest.fn(async () => ({
      data: { token: "signed-token" },
      error: null,
    }));
    const upload = jest.fn();
    const getPublicUrl = jest.fn(() => ({
      data: {
        publicUrl: "https://cdn.example.com/template-header.png",
      },
    }));
    mockStorageFrom.mockReturnValue({
      createSignedUploadUrl,
      upload,
      getPublicUrl,
    });

    const response = await POST(
      createDirectUploadRequest({
        mode: "direct",
        fileName: "template header.png",
        fileSize: 7,
        format: "IMAGE",
        mimeType: "image/png",
      }),
      {
        params: Promise.resolve({ workspaceId }),
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      upload: {
        bucket: "business-media",
        token: "signed-token",
      },
      media: {
        url: "https://cdn.example.com/template-header.png",
        bucket: "business-media",
        mimeType: "image/png",
        fileName: "template header.png",
        fileSize: 7,
        format: "IMAGE",
      },
    });
    expect(createSignedUploadUrl).toHaveBeenCalledWith(
      expect.stringMatching(
        /^whatsapp-template-headers\/workspace-1\/\d+-[a-f0-9]+-template-header\.png$/
      ),
      { upsert: false }
    );
    expect(upload).not.toHaveBeenCalled();
    expect(mockReserveStorage).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, bytes: 100 * 1024 * 1024 })
    );
  });

  it("rejects media that does not match the selected header format", async () => {
    const upload = jest.fn();
    mockStorageFrom.mockReturnValue({
      upload,
      getPublicUrl: jest.fn(),
    });

    const file = new File(["video"], "clip.mp4", { type: "video/mp4" });

    const response = await POST(createUploadRequest(file, "IMAGE"), {
      params: Promise.resolve({ workspaceId }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Image headers require an image file.",
    });
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects MOV files for WhatsApp template video headers", async () => {
    const upload = jest.fn();
    mockStorageFrom.mockReturnValue({
      upload,
      getPublicUrl: jest.fn(),
    });

    const file = new File(["video"], "clip.mov", {
      type: "video/quicktime",
    });

    const response = await POST(createUploadRequest(file, "VIDEO"), {
      params: Promise.resolve({ workspaceId }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        "Video template headers support MP4 or 3GP files only. MOV is not supported.",
    });
    expect(upload).not.toHaveBeenCalled();
  });

  it("accepts WhatsApp template video headers at exactly 16MB", async () => {
    const upload = jest.fn(async () => ({ error: null }));
    const getPublicUrl = jest.fn(() => ({
      data: {
        publicUrl: "https://cdn.example.com/template-header.mp4",
      },
    }));
    mockStorageFrom.mockReturnValue({ upload, getPublicUrl });

    const file = new File(
      [new Uint8Array(TEMPLATE_VIDEO_LIMIT_BYTES)],
      "clip.mp4",
      {
        type: "video/mp4",
      }
    );

    const response = await POST(createUploadRequest(file, "VIDEO"), {
      params: Promise.resolve({ workspaceId }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      media: {
        url: "https://cdn.example.com/template-header.mp4",
        mimeType: "video/mp4",
        fileSize: TEMPLATE_VIDEO_LIMIT_BYTES,
        format: "VIDEO",
      },
    });
    expect(upload).toHaveBeenCalledWith(
      expect.stringMatching(/clip\.mp4$/),
      expect.any(Buffer),
      expect.objectContaining({ contentType: "video/mp4" })
    );
  });

  it("rejects WhatsApp template video headers larger than 16MB", async () => {
    const upload = jest.fn();
    mockStorageFrom.mockReturnValue({
      upload,
      getPublicUrl: jest.fn(),
    });

    const file = new File(
      [new Uint8Array(TEMPLATE_VIDEO_LIMIT_BYTES + 1)],
      "clip.mp4",
      {
        type: "video/mp4",
      }
    );

    const response = await POST(createUploadRequest(file, "VIDEO"), {
      params: Promise.resolve({ workspaceId }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Video header media is too large. Maximum size is 16MB.",
    });
    expect(upload).not.toHaveBeenCalled();
  });
});
