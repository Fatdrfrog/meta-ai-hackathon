const mockRequireScenarioWorkspaceAccess = jest.fn();
const mockStorageFrom = jest.fn();
const mockAdminStorageFrom = jest.fn();
const mockGetBucket = jest.fn();
const mockCreateBucket = jest.fn();
const mockUpdateBucket = jest.fn();
const mockReserveStorage = jest.fn();
jest.mock("@icecore/airi-runtime/storage-quota", () => {
  const actual = jest.requireActual("@icecore/airi-runtime/storage-quota");
  return {
    ...actual,
    storeSupabaseWorkspaceBuffer: (params: object) =>
      actual.storeSupabaseWorkspaceBuffer({
        ...params,
        quota: { reserve: mockReserveStorage, settle: async () => {} },
      }),
  };
});

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    storage: {
      getBucket: (...args: unknown[]) => mockGetBucket(...args),
      createBucket: (...args: unknown[]) => mockCreateBucket(...args),
      updateBucket: (...args: unknown[]) => mockUpdateBucket(...args),
      from: (...args: unknown[]) => mockAdminStorageFrom(...args),
    },
  },
}));

function createSupabaseMock() {
  return {
    storage: {
      from: (...args: unknown[]) => mockStorageFrom(...args),
    },
  };
}

import { NextResponse } from "next/server";
import { POST } from "./route";
import { StorageQuotaError } from "@icecore/airi-runtime/storage-quota";

const workspaceId = "workspace-1";

function createUploadRequest(file: File) {
  const formData = new FormData();
  formData.set("file", file);

  return new Request(
    "http://localhost/api/workspaces/workspace-1/email-assets",
    {
      method: "POST",
      body: formData,
    }
  ) as never;
}

describe("POST /api/workspaces/[workspaceId]/email-assets", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReserveStorage.mockResolvedValue({
      _id: "reservation",
      status: "reserved",
    });
    mockGetBucket.mockResolvedValue({
      data: {
        public: true,
        allowed_mime_types: [
          "image/jpeg",
          "image/png",
          "image/webp",
          "image/gif",
        ],
      },
      error: null,
    });
    mockCreateBucket.mockResolvedValue({ error: null });
    mockUpdateBucket.mockResolvedValue({ error: null });
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      supabase: createSupabaseMock(),
      userId: "user-1",
    });
  });

  it("blocks the provider write when company storage is exhausted", async () => {
    const upload = jest.fn();
    mockAdminStorageFrom.mockReturnValue({ upload });
    mockReserveStorage.mockRejectedValueOnce(
      new StorageQuotaError(
        "company_storage_limit_exceeded",
        "Storage limit exceeded"
      )
    );
    const response = await POST(
      createUploadRequest(
        new File(["image"], "image.png", { type: "image/png" })
      ),
      { params: Promise.resolve({ workspaceId }) }
    );
    expect(response.status).toBe(409);
    expect(upload).not.toHaveBeenCalled();
  });

  it("uploads workspace email images to a public email asset bucket", async () => {
    const upload = jest.fn(async () => ({ error: null }));
    const getPublicUrl = jest.fn(() => ({
      data: {
        publicUrl: "https://cdn.example.com/email/hero.png",
      },
    }));
    mockAdminStorageFrom.mockReturnValue({ upload, getPublicUrl });

    const file = new File(["image"], "hero image.png", {
      type: "image/png",
    });

    const response = await POST(createUploadRequest(file), {
      params: Promise.resolve({ workspaceId }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      image: {
        url: "https://cdn.example.com/email/hero.png",
        bucket: "email-campaign-assets",
        mimeType: "image/png",
        fileName: "hero image.png",
      },
    });
    expect(mockAdminStorageFrom).toHaveBeenCalledWith("email-campaign-assets");
    expect(upload).toHaveBeenCalledWith(
      expect.stringMatching(
        /^workspaces\/workspace-1\/email-assets\/\d+-[a-f0-9]+-hero-image\.png$/
      ),
      expect.any(Buffer),
      expect.objectContaining({
        contentType: "image/png",
        cacheControl: "31536000",
        upsert: false,
      })
    );
  });

  it("creates the public email asset bucket before uploading when it is missing", async () => {
    mockGetBucket.mockResolvedValueOnce({
      data: null,
      error: { message: "Bucket not found" },
    });
    const upload = jest.fn(async () => ({ error: null }));
    const getPublicUrl = jest.fn(() => ({
      data: {
        publicUrl: "https://cdn.example.com/email/hero.png",
      },
    }));
    mockAdminStorageFrom.mockReturnValue({ upload, getPublicUrl });

    const response = await POST(
      createUploadRequest(
        new File(["image"], "hero.png", { type: "image/png" })
      ),
      { params: Promise.resolve({ workspaceId }) }
    );

    expect(response.status).toBe(200);
    expect(mockCreateBucket).toHaveBeenCalledWith("email-campaign-assets", {
      public: true,
      fileSizeLimit: 10485760,
      allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
    });
  });

  it("rejects unauthenticated workspace access before reading the upload body", async () => {
    mockRequireScenarioWorkspaceAccess.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const response = await POST(
      createUploadRequest(
        new File(["image"], "hero.png", { type: "image/png" })
      ),
      { params: Promise.resolve({ workspaceId }) }
    );

    expect(response.status).toBe(401);
    expect(mockAdminStorageFrom).not.toHaveBeenCalled();
    expect(mockGetBucket).not.toHaveBeenCalled();
  });

  it("rejects non-image files", async () => {
    const response = await POST(
      createUploadRequest(
        new File(["pdf"], "hero.pdf", { type: "application/pdf" })
      ),
      { params: Promise.resolve({ workspaceId }) }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Unsupported file type"),
    });
    expect(mockAdminStorageFrom).not.toHaveBeenCalled();
    expect(mockGetBucket).not.toHaveBeenCalled();
  });
});
