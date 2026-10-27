const mockRequireScenarioWorkspaceAccess = jest.fn();
const mockConnectDB = jest.fn();
const mockFindOne = jest.fn();
const mockDeleteOne = jest.fn();
const mockStorageFrom = jest.fn();
const mockRemove = jest.fn();

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    storage: { from: (...args: unknown[]) => mockStorageFrom(...args) },
  },
}));

jest.mock("@/models/creative-asset", () => ({
  CreativeAsset: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
    deleteOne: (...args: unknown[]) => mockDeleteOne(...args),
  },
}));

import { DELETE, GET } from "./route";
import { contractV1VideoAsset } from "@/lib/creative-assets/creative-asset-test-fixtures";

function assetRequest(assetId: string) {
  return new Request(
    `http://localhost/api/workspaces/workspace-1/assets/${assetId}`
  );
}

function assetContext(assetId: string) {
  return { params: Promise.resolve({ workspaceId: "workspace-1", assetId }) };
}

function leanResult<T>(value: T) {
  return {
    lean: jest.fn().mockResolvedValue(value),
  };
}

describe("GET /api/workspaces/[workspaceId]/assets/[assetId]", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      accessToken: "user-token",
      userId: "user-1",
    });
    mockConnectDB.mockResolvedValue(undefined);
    mockDeleteOne.mockResolvedValue({ deletedCount: 1 });
    mockRemove.mockResolvedValue({ error: null });
    mockStorageFrom.mockReturnValue({ remove: mockRemove });
  });

  it("returns 400 for malformed asset ids before querying Mongo", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/workspaces/workspace-1/assets/not-an-object-id"
      ),
      {
        params: Promise.resolve({
          workspaceId: "workspace-1",
          assetId: "not-an-object-id",
        }),
      }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid asset id" });
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockFindOne).not.toHaveBeenCalled();
  });

  it("loads a workspace-scoped asset by id", async () => {
    const assetId = "64c13ab08edf48a008793cab";
    mockFindOne.mockReturnValue(
      leanResult({
        _id: assetId,
        workspaceId: "workspace-1",
        kind: "image",
        source: "uploaded",
        status: "complete",
        url: "https://storage.example.com/asset.png",
      })
    );

    const response = await GET(assetRequest(assetId), assetContext(assetId));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockFindOne).toHaveBeenCalledWith({
      _id: assetId,
      workspaceId: "workspace-1",
    });
    expect(payload.asset).toMatchObject({
      id: assetId,
      workspaceId: "workspace-1",
      kind: "image",
      status: "complete",
      url: "https://storage.example.com/asset.png",
    });
  });

  it("never exposes private contract-v1 provider fields in item responses", async () => {
    const assetId = "64c13ab08edf48a008793cab";
    mockFindOne.mockReturnValue(leanResult(contractV1VideoAsset(assetId)));

    const response = await GET(assetRequest(assetId), assetContext(assetId));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(JSON.stringify(payload.asset)).not.toContain(
      "PRIVATE_TOP_LEVEL_PROMPT"
    );
    expect(JSON.stringify(payload.asset)).not.toContain(
      "PRIVATE_PROVIDER_PROMPT"
    );
    expect(JSON.stringify(payload.asset)).not.toContain(
      "PRIVATE_PROVIDER_DIAGNOSTIC"
    );
    expect(JSON.stringify(payload.asset)).not.toContain("PRIVATE_PROVIDER_URL");
    expect(payload.asset).not.toHaveProperty("providerRequestId");
    expect(payload.asset).not.toHaveProperty("providerSourceId");
    expect(payload.asset).not.toHaveProperty("providerStatusUrl");
    expect(payload.asset).not.toHaveProperty("providerCancelUrl");
  });

  it("deletes a complete asset and removes its stored object", async () => {
    const assetId = "64c13ab08edf48a008793cab";
    mockFindOne.mockReturnValue(
      leanResult({
        _id: assetId,
        workspaceId: "workspace-1",
        kind: "image",
        source: "uploaded",
        status: "complete",
        bucket: "creative-assets",
        path: "workspaces/workspace-1/creative-assets/image/asset-1/menu.png",
      })
    );

    const response = await DELETE(assetRequest(assetId), assetContext(assetId));

    expect(response.status).toBe(200);
    expect(mockStorageFrom).toHaveBeenCalledWith("creative-assets");
    expect(mockRemove).toHaveBeenCalledWith([
      "workspaces/workspace-1/creative-assets/image/asset-1/menu.png",
    ]);
    expect(mockDeleteOne).toHaveBeenCalledWith({
      _id: assetId,
      workspaceId: "workspace-1",
    });
    expect(await response.json()).toEqual({ success: true, assetId });
  });

  it("deletes a failed asset without requiring a stored object", async () => {
    const assetId = "64c13ab08edf48a008793cab";
    mockFindOne.mockReturnValue(
      leanResult({
        _id: assetId,
        workspaceId: "workspace-1",
        kind: "video",
        source: "higgsfield",
        status: "failed",
        bucket: null,
        path: null,
      })
    );

    const response = await DELETE(assetRequest(assetId), assetContext(assetId));

    expect(response.status).toBe(200);
    expect(mockRemove).not.toHaveBeenCalled();
    expect(mockDeleteOne).toHaveBeenCalledWith({
      _id: assetId,
      workspaceId: "workspace-1",
    });
  });

  it("does not delete assets while generation is active", async () => {
    const assetId = "64c13ab08edf48a008793cab";
    mockFindOne.mockReturnValue(
      leanResult({
        _id: assetId,
        workspaceId: "workspace-1",
        kind: "video",
        source: "higgsfield",
        status: "in_progress",
      })
    );

    const response = await DELETE(assetRequest(assetId), assetContext(assetId));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Generating assets cannot be deleted yet",
    });
    expect(mockDeleteOne).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
  });
});
