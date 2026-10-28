/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockFindVideo = jest.fn();
const mockCreateImport = jest.fn();
const mockListImports = jest.fn();
const mockLoggerError = jest.fn();

jest.mock("@/lib/auth/workspace-membership", () => ({
  getAuthenticatedWorkspaceMembership: (...args: unknown[]) =>
    mockMembership(...args),
}));
jest.mock("@/lib/workspace-feature-flags", () => ({
  isWorkspaceFeatureEnabled: (...args: unknown[]) =>
    mockFeatureEnabled(...args),
}));
jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: () => mockConnect(),
}));
jest.mock("@/lib/logger", () => ({
  logger: { error: (...args: unknown[]) => mockLoggerError(...args) },
}));
jest.mock("@/lib/products/imports", () => ({
  findUploadedVideo: (...args: unknown[]) => mockFindVideo(...args),
  createProductVideoImport: (...args: unknown[]) => mockCreateImport(...args),
  listShownProductVideoImports: (...args: unknown[]) =>
    mockListImports(...args),
}));

import { GET, POST } from "./route";

const workspaceId = "workspace-1";
const assetId = "651f1f77bcf86cd799439051";
const context = { params: Promise.resolve({ workspaceId }) };
const post = (body: unknown) =>
  new Request(
    `https://local.test/api/workspaces/${workspaceId}/products/imports`,
    { method: "POST", body: JSON.stringify(body) }
  );
const video = {
  bucket: "media",
  path: `workspaces/${workspaceId}/creative-assets/video/${assetId}/shelf.mov`,
  mimeType: "video/quicktime",
  fileName: "shelf.mov",
};

function allowRole(role: string) {
  mockMembership.mockResolvedValue({
    supabase: {},
    user: { id: "user-1" },
    membership: { role },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  allowRole("admin");
  mockFeatureEnabled.mockResolvedValue(true);
  mockConnect.mockResolvedValue(undefined);
  mockFindVideo.mockResolvedValue(video);
  mockCreateImport.mockResolvedValue({ importId: "import-1" });
});

describe("product imports API", () => {
  it("starts an import of an uploaded video for an admin", async () => {
    const response = await POST(post({ assetId }), context);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ importId: "import-1" });
    expect(mockFindVideo).toHaveBeenCalledWith(workspaceId, assetId);
    expect(mockCreateImport).toHaveBeenCalledWith({
      workspaceId,
      source: "upload",
      video,
      createdBy: "user-1",
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("refuses managers and workspaces without the flag before reading anything", async () => {
    allowRole("manager");
    expect((await POST(post({ assetId }), context)).status).toBe(403);

    allowRole("admin");
    mockFeatureEnabled.mockResolvedValue(false);
    expect((await POST(post({ assetId }), context)).status).toBe(404);

    expect(mockFindVideo).not.toHaveBeenCalled();
    expect(mockCreateImport).not.toHaveBeenCalled();
  });

  it("asks for a real asset id, and one that is this workspace's video", async () => {
    const bad = await POST(post({ assetId: "../../etc" }), context);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({
      error: "The request is invalid",
      code: "invalid_request",
    });

    mockFindVideo.mockResolvedValue(null);
    const missing = await POST(post({ assetId }), context);
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe("video_not_found");
    expect(mockCreateImport).not.toHaveBeenCalled();
  });

  it("answers 503 and logs when the import can't start", async () => {
    mockCreateImport.mockRejectedValue(new Error("Temporal down"));

    const response = await POST(post({ assetId }), context);

    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("import_unavailable");
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products API] import POST failed",
      expect.any(Error),
      expect.objectContaining({ event: "products.import_create_failed" })
    );
  });
});

describe("listing product imports", () => {
  const get = () =>
    GET(
      new Request(
        `https://local.test/api/workspaces/${workspaceId}/products/imports`
      ),
      context
    );
  const running = {
    id: "import-1",
    status: "processing",
    stage: "watching",
    productTotal: 0,
    photoTotal: 0,
    photoDone: 0,
    errorCode: null,
    presenter: null,
    createdAt: "2026-10-28T09:00:00.000Z",
    finishedAt: null,
  };

  it("lists the imports the Products page shows, for an admin", async () => {
    mockListImports.mockResolvedValue([running]);

    const response = await get();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ imports: [running] });
    expect(mockListImports).toHaveBeenCalledWith(workspaceId);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("refuses managers before reading anything", async () => {
    allowRole("manager");
    expect((await get()).status).toBe(403);
    expect(mockListImports).not.toHaveBeenCalled();
  });

  it("answers 503 and logs when the list can't be read", async () => {
    mockListImports.mockRejectedValue(new Error("Mongo down"));

    const response = await get();

    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("load_failed");
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products API] imports GET failed",
      expect.any(Error),
      expect.objectContaining({ event: "products.imports_list_failed" })
    );
  });
});
