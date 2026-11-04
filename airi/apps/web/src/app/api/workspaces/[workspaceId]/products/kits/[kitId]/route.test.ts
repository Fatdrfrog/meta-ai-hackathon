/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockReadKit = jest.fn();
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
// Timing out and reading Meta's verdict again are kits.test.ts's.
jest.mock("@/lib/products/kits", () => ({
  readProductKit: (...args: unknown[]) => mockReadKit(...args),
}));

import { GET } from "./route";

const workspaceId = "workspace-1";
const kitId = "651f1f77bcf86cd799439099";
const context = { params: Promise.resolve({ workspaceId, kitId }) };
const get = () =>
  new Request(
    `https://local.test/api/workspaces/${workspaceId}/products/kits/${kitId}`
  );
const kit = { id: kitId, status: "ready", parts: {} };

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
  mockReadKit.mockResolvedValue(kit);
});

describe("GET a kit", () => {
  it("answers the kit as it now is", async () => {
    const response = await GET(get(), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kit });
    expect(mockReadKit).toHaveBeenCalledWith(workspaceId, kitId);
  });

  it("answers a carousel still being looked for at Meta uncached, for the page to poll again", async () => {
    // Meta's answer to the create was lost: each GET looks for it by name,
    // so no cache may answer a poll with the kit as it was.
    const checking = {
      id: kitId,
      status: "making",
      parts: {
        carousel: {
          state: "checking",
          templateId: null,
          templateName: "products_20261103_055534",
          cardCount: 4,
          metaStatus: null,
          metaReason: null,
          approvedAt: null,
          error: null,
        },
      },
    };
    mockReadKit.mockResolvedValue(checking);

    const response = await GET(get(), context);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ kit: checking });
  });

  it("answers 404 for a kit that isn't this workspace's", async () => {
    mockReadKit.mockResolvedValue(null);

    const response = await GET(get(), context);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "kit_not_found" });
  });

  it("refuses managers and workspaces without the flag", async () => {
    allowRole("manager");
    expect((await GET(get(), context)).status).toBe(403);
    allowRole("admin");
    mockFeatureEnabled.mockResolvedValue(false);
    expect((await GET(get(), context)).status).toBe(404);
    expect(mockReadKit).not.toHaveBeenCalled();
  });

  it("answers 503 when it can't be read", async () => {
    mockReadKit.mockRejectedValue(new Error("down"));

    const response = await GET(get(), context);

    expect(response.status).toBe(503);
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products API] kit GET failed",
      expect.any(Error),
      expect.objectContaining({ event: "products.kit_read_failed", kitId })
    );
  });
});
