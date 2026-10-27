const mockRequireScenarioWorkspaceAccess = jest.fn();
const mockConnectDB = jest.fn();
const mockCreate = jest.fn();
const mockFindOne = jest.fn();
const mockAggregate = jest.fn();
const mockGetCompanyIdForWorkspace = jest.fn();
const mockGetWorkspaceIdsForCompany = jest.fn();
const mockStorageFrom = jest.fn();
const mockCreateSignedUploadUrl = jest.fn();
const mockGetPublicUrl = jest.fn();
const mockList = jest.fn();
const mockRemove = jest.fn();
const mockCreateRemoteCreativeAssetUpload = jest.fn();
const mockStatRemoteCreativeAssetObject = jest.fn();
const mockDeleteRemoteCreativeAssetObject = jest.fn();
const mockCreateRemoteCreativeAssetReadUrl = jest.fn();
const mockReadStorageObject = jest.fn();
const mockSettleStorageObject = jest.fn();
const mockStorageUsage = jest.fn();
jest.mock("@icecore/airi-runtime/storage-quota", () => ({
  ...jest.requireActual("@icecore/airi-runtime/storage-quota"),
  readStorageObject: (...args: unknown[]) => mockReadStorageObject(...args),
  settleStorageObject: (...args: unknown[]) => mockSettleStorageObject(...args),
  getStorageQuotaStore: async () => ({ usage: mockStorageUsage }),
}));

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/higgsfield/creative-asset-storage", () => ({
  CreativeAssetValidationError: class CreativeAssetValidationError extends Error {},
  assertCreativeAssetMimeTypeAllowed: jest.fn(),
  CREATIVE_ASSET_COMPANY_STORAGE_LIMIT_BYTES: 10 * 1024 * 1024 * 1024,
  CREATIVE_ASSET_COMPANY_STORAGE_LIMIT_LABEL: "10 GB",
  resolveCreativeAssetMimeType: ({ mimeType }: { mimeType?: string }) =>
    mimeType || "image/png",
}));

jest.mock("@/lib/supabase/company-users", () => ({
  getCompanyIdForWorkspace: (...args: unknown[]) =>
    mockGetCompanyIdForWorkspace(...args),
  getWorkspaceIdsForCompany: (...args: unknown[]) =>
    mockGetWorkspaceIdsForCompany(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    storage: {
      from: (...args: unknown[]) => mockStorageFrom(...args),
    },
  },
}));

jest.mock("@/lib/google/gcp-media-api", () => ({
  canCallGcpMediaApi: () => true,
  createRemoteCreativeAssetUpload: (...args: unknown[]) =>
    mockCreateRemoteCreativeAssetUpload(...args),
  statRemoteCreativeAssetObject: (...args: unknown[]) =>
    mockStatRemoteCreativeAssetObject(...args),
  deleteRemoteCreativeAssetObject: (...args: unknown[]) =>
    mockDeleteRemoteCreativeAssetObject(...args),
  createRemoteCreativeAssetReadUrl: (...args: unknown[]) =>
    mockCreateRemoteCreativeAssetReadUrl(...args),
}));

jest.mock("@/models/creative-asset", () => ({
  CreativeAsset: {
    create: (...args: unknown[]) => mockCreate(...args),
    findOne: (...args: unknown[]) => mockFindOne(...args),
    aggregate: (...args: unknown[]) => mockAggregate(...args),
  },
}));

import { GET, POST } from "./route";
import { StorageQuotaError } from "@icecore/airi-runtime/storage-quota";

function postUpload(body: unknown) {
  return POST(
    new Request("http://localhost/api/workspaces/workspace-1/assets/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ workspaceId: "workspace-1" }) }
  );
}

describe("POST /api/workspaces/[workspaceId]/assets/upload", () => {
  const originalRolloutMode = process.env.STORAGE_QUOTA_ROLLOUT_MODE;
  afterEach(() => {
    if (originalRolloutMode === undefined)
      delete process.env.STORAGE_QUOTA_ROLLOUT_MODE;
    else process.env.STORAGE_QUOTA_ROLLOUT_MODE = originalRolloutMode;
  });
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      userId: "user-1",
      supabase: { storage: { from: jest.fn() } },
    });
    mockGetCompanyIdForWorkspace.mockResolvedValue("company-1");
    mockGetWorkspaceIdsForCompany.mockResolvedValue([
      "workspace-1",
      "workspace-2",
    ]);
    mockAggregate.mockResolvedValue([{ totalBytes: 1024 }]);
    mockReadStorageObject.mockResolvedValue({
      _id: "reservation",
      companyId: "company-1",
      workspaceId: "workspace-1",
      bytes: 4,
      status: "reserved",
    });
    mockFindOne.mockResolvedValue(null);
    mockSettleStorageObject.mockImplementation(async (_id, _bytes, persist) => {
      await persist?.("mongo-session");
    });
    mockStorageFrom.mockReturnValue({
      createSignedUploadUrl: (...args: unknown[]) =>
        mockCreateSignedUploadUrl(...args),
      getPublicUrl: (...args: unknown[]) => mockGetPublicUrl(...args),
      list: (...args: unknown[]) => mockList(...args),
      remove: (...args: unknown[]) => mockRemove(...args),
    });
    mockCreateRemoteCreativeAssetUpload.mockImplementation(
      (input: {
        workspaceId: string;
        assetId: string;
        kind: string;
        fileName: string;
      }) => ({
        provider: "gcs",
        method: "PUT",
        uploadUrl: "https://storage.googleapis.com/resumable-upload-session",
        bucket: "icecore-ai-creative-assets-prod",
        path: `workspaces/${input.workspaceId}/creative-assets/${input.kind}/${input.assetId}/${input.fileName}`,
        expiresInSeconds: 7200,
        cacheControl: "public, max-age=3600",
      })
    );
    mockStatRemoteCreativeAssetObject.mockResolvedValue({
      provider: "gcs",
      bucket: "icecore-ai-creative-assets-prod",
      path: "workspaces/workspace-1/creative-assets/image/000000000000000000000001/menu.png",
      exists: true,
      fileSize: 4,
      mimeType: "image/png",
      updatedAt: "2026-05-26T00:00:00.000Z",
    });
    mockDeleteRemoteCreativeAssetObject.mockResolvedValue({
      provider: "gcs",
      bucket: "icecore-ai-creative-assets-prod",
      path: "workspaces/workspace-1/creative-assets/image/000000000000000000000001/menu.png",
      deleted: true,
    });
    mockCreateRemoteCreativeAssetReadUrl.mockResolvedValue({
      provider: "gcs",
      bucket: "icecore-ai-creative-assets-prod",
      path: "workspaces/workspace-1/creative-assets/image/asset-1/menu.png",
      url: "https://storage.googleapis.com/signed-read-url",
      expiresAt: "2026-05-26T01:00:00.000Z",
    });
    mockGetPublicUrl.mockReturnValue({
      data: { publicUrl: "https://cdn.example.com/assets/menu.png" },
    });
    mockList.mockResolvedValue({
      data: [
        {
          name: "1700000000000-random-menu.png",
          metadata: { size: 4, mimetype: "image/png" },
        },
      ],
      error: null,
    });
    mockRemove.mockResolvedValue({ error: null });
    mockConnectDB.mockResolvedValue(undefined);
    mockCreate.mockResolvedValue([
      {
        _id: "asset-1",
        workspaceId: "workspace-1",
        kind: "image",
        source: "uploaded",
        status: "complete",
        storageProvider: "gcs",
        url: "gcs://icecore-ai-creative-assets-prod/workspaces/workspace-1/creative-assets/image/asset-1/menu.png",
        bucket: "icecore-ai-creative-assets-prod",
        path: "workspaces/workspace-1/creative-assets/image/asset-1/menu.png",
        mimeType: "image/png",
        fileName: "menu.png",
        fileSize: 4,
        createdAt: new Date("2026-05-26T00:00:00.000Z"),
      },
    ]);
  });

  it.each([
    { mode: "record", ready: false, recording: true, code: null },
    {
      mode: "strict",
      ready: false,
      recording: false,
      code: "storage_inventory_required",
    },
    { mode: "record", ready: true, recording: false, code: null },
  ])(
    "reports upload readiness honestly in $mode mode with ready=$ready",
    async state => {
      process.env.STORAGE_QUOTA_ROLLOUT_MODE = state.mode;
      mockStorageUsage.mockResolvedValueOnce({
        ready: state.ready,
        limitBytes: 100,
        storedBytes: 4,
        chargedBytes: 10,
      });
      const response = await GET(new Request("http://localhost") as never, {
        params: Promise.resolve({ workspaceId: "workspace-1" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        storage: {
          ready: state.ready,
          recording: state.recording,
          limitBytes: 100,
          storedBytes: 4,
          reservedBytes: 6,
          remainingBytes: 90,
        },
        code: state.code,
      });
    }
  );

  it("reports record mode before the first upload creates a ledger", async () => {
    process.env.STORAGE_QUOTA_ROLLOUT_MODE = "record";
    mockStorageUsage.mockResolvedValueOnce(null);
    const response = await GET(new Request("http://localhost") as never, {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });
    expect(await response.json()).toMatchObject({
      storage: { ready: false, recording: true },
      code: null,
    });
  });

  it("creates a GCS resumable upload target without accepting file bytes in the API route", async () => {
    const response = await postUpload({
      action: "initiate",
      fileName: "menu.png",
      mimeType: "image/png",
      fileSize: 4,
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockCreateRemoteCreativeAssetUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        kind: "image",
        fileName: "menu.png",
        mimeType: "image/png",
        fileSize: 4,
        origin: null,
      })
    );
    expect(mockCreate).not.toHaveBeenCalled();
    expect(payload.upload).toMatchObject({
      provider: "gcs",
      method: "PUT",
      uploadUrl: "https://storage.googleapis.com/resumable-upload-session",
      bucket: "icecore-ai-creative-assets-prod",
      kind: "image",
      mimeType: "image/png",
      fileName: "menu.png",
      fileSize: 4,
    });
  });

  it("completes a GCS upload as a completed workspace asset", async () => {
    const path =
      "workspaces/workspace-1/creative-assets/image/000000000000000000000001/menu.png";

    const response = await postUpload({
      action: "complete",
      provider: "gcs",
      assetId: "000000000000000000000001",
      bucket: "icecore-ai-creative-assets-prod",
      path,
      kind: "image",
      fileName: "menu.png",
      mimeType: "image/png",
      fileSize: 4,
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockStatRemoteCreativeAssetObject).toHaveBeenCalledWith({
      provider: "gcs",
      bucket: "icecore-ai-creative-assets-prod",
      path,
      workspaceId: "workspace-1",
    });
    expect(mockCreate).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          _id: expect.any(Object),
          workspaceId: "workspace-1",
          kind: "image",
          source: "uploaded",
          status: "complete",
          url: `gcs://icecore-ai-creative-assets-prod/${path}`,
          storageProvider: "gcs",
          bucket: "icecore-ai-creative-assets-prod",
          path,
          fileName: "menu.png",
          fileSize: 4,
          createdBy: "user-1",
        }),
      ],
      { session: "mongo-session" }
    );
    expect(payload.asset).toMatchObject({
      id: "asset-1",
      status: "complete",
      source: "uploaded",
      url: "https://storage.googleapis.com/signed-read-url",
      storageProvider: "gcs",
    });
    expect(mockCreateRemoteCreativeAssetReadUrl).toHaveBeenCalledWith({
      provider: "gcs",
      bucket: "icecore-ai-creative-assets-prod",
      path: "workspaces/workspace-1/creative-assets/image/asset-1/menu.png",
      workspaceId: "workspace-1",
      expiresInSeconds: undefined,
    });
  });

  it("does not recreate an asset for a deleted storage identity", async () => {
    mockReadStorageObject.mockResolvedValue({
      _id: "reservation",
      companyId: "company-1",
      workspaceId: "workspace-1",
      bytes: 4,
      status: "tombstoned",
    });
    const response = await postUpload({
      action: "complete",
      provider: "gcs",
      assetId: "000000000000000000000001",
      bucket: "bucket",
      path: "workspaces/workspace-1/creative-assets/image/000000000000000000000001/menu.png",
      kind: "image",
      fileName: "menu.png",
      mimeType: "image/png",
      fileSize: 4,
    });
    expect(response.status).toBe(409);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSettleStorageObject).not.toHaveBeenCalled();
  });

  it("rejects uploads that would exceed the company 10 GB asset total", async () => {
    mockCreateRemoteCreativeAssetUpload.mockRejectedValueOnce(
      new StorageQuotaError(
        "company_storage_limit_exceeded",
        "Company storage limit exceeded. The allowance is 10 GiB."
      )
    );

    const response = await postUpload({
      action: "initiate",
      fileName: "menu.png",
      mimeType: "image/png",
      fileSize: 2,
    });

    const payload = await response.json();
    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      code: "company_storage_limit_exceeded",
    });
    expect(payload.error).toContain("10 GiB");
  });

  it("returns an existing completed asset when the completion request is retried", async () => {
    mockFindOne.mockResolvedValueOnce({
      _id: "asset-1",
      workspaceId: "workspace-1",
      kind: "image",
      source: "uploaded",
      status: "complete",
      storageProvider: "gcs",
      url: "gcs://icecore-ai-creative-assets-prod/workspaces/workspace-1/creative-assets/image/000000000000000000000001/menu.png",
      bucket: "icecore-ai-creative-assets-prod",
      path: "workspaces/workspace-1/creative-assets/image/000000000000000000000001/1700000000000-random-menu.png",
      mimeType: "image/png",
      fileName: "menu.png",
      fileSize: 4,
      createdAt: new Date("2026-05-26T00:00:00.000Z"),
    });

    const response = await postUpload({
      action: "complete",
      provider: "gcs",
      assetId: "000000000000000000000001",
      bucket: "icecore-ai-creative-assets-prod",
      path: "workspaces/workspace-1/creative-assets/image/000000000000000000000001/1700000000000-random-menu.png",
      kind: "image",
      fileName: "menu.png",
      mimeType: "image/png",
      fileSize: 4,
    });

    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(payload.asset).toMatchObject({
      id: "asset-1",
      status: "complete",
      source: "uploaded",
    });
  });

  it("rejects completion when the object path is outside the workspace asset folder", async () => {
    const response = await postUpload({
      action: "complete",
      provider: "gcs",
      assetId: "000000000000000000000001",
      bucket: "icecore-ai-creative-assets-prod",
      path: "workspaces/other-workspace/creative-assets/image/000000000000000000000001/menu.png",
      kind: "image",
      fileName: "menu.png",
      mimeType: "image/png",
      fileSize: 4,
    });

    expect(response.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects legacy multipart uploads instead of reading file bytes in the function", async () => {
    const formData = new FormData();
    formData.set("file", new File(["menu"], "menu.png", { type: "image/png" }));

    const response = await POST(
      new Request("http://localhost/api/workspaces/workspace-1/assets/upload", {
        method: "POST",
        body: formData,
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(415);
    expect(mockCreateRemoteCreativeAssetUpload).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("scopes company quota checks through the source workspace company", async () => {
    await postUpload({
      action: "initiate",
      fileName: "menu.png",
      mimeType: "image/png",
      fileSize: 4,
    });

    expect(mockGetCompanyIdForWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-1"
    );
    expect(mockAggregate).not.toHaveBeenCalled();
  });

  it("returns 404 when the workspace has no company", async () => {
    mockGetCompanyIdForWorkspace.mockResolvedValueOnce(null);

    const response = await postUpload({
      action: "initiate",
      fileName: "menu.png",
      mimeType: "image/png",
      fileSize: 4,
    });

    expect(response.status).toBe(404);
    expect(mockCreateRemoteCreativeAssetUpload).not.toHaveBeenCalled();
  });

  it.each([null, 9])(
    "rejects unknown or mismatched stored byte count %s without deleting the object",
    async fileSize => {
      mockStatRemoteCreativeAssetObject.mockResolvedValueOnce({
        exists: true,
        fileSize,
        mimeType: "image/png",
      });
      const response = await postUpload({
        action: "complete",
        provider: "gcs",
        assetId: "000000000000000000000001",
        bucket: "icecore-ai-creative-assets-prod",
        path: "workspaces/workspace-1/creative-assets/image/000000000000000000000001/menu.png",
        kind: "image",
        fileName: "menu.png",
        mimeType: "image/png",
        fileSize: 4,
      });
      expect(response.status).toBe(409);
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockDeleteRemoteCreativeAssetObject).not.toHaveBeenCalled();
    }
  );
});
