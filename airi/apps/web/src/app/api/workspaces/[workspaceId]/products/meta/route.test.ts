/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockReadiness = jest.fn();
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
jest.mock("@/lib/products/meta-publish", () => ({
  productsMetaReadiness: (...args: unknown[]) => mockReadiness(...args),
}));

import { GET } from "./route";

const workspaceId = "workspace-1";
const get = (query = "") =>
  GET(
    new Request(
      `https://local.test/api/workspaces/${workspaceId}/products/meta${query}`
    ),
    { params: Promise.resolve({ workspaceId }) }
  );
const meta = {
  instagram: {
    connected: true,
    username: "airi.chat__",
    canPublish: true,
    quotaLeft: 100,
  },
  ads: {
    connected: true,
    adAccountName: "Airi.chat ad account",
    currency: "USD",
    pageName: "Airi.chat",
    pageHasWhatsApp: false,
    instagramPlacements: false,
    runEnabled: false,
    runMaxDailyCents: 100,
    runMaxDays: 3,
  },
  whatsapp: { connected: true },
  ai: { blocked: null },
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
  mockReadiness.mockResolvedValue(meta);
});

describe("what the workspace can do on Meta", () => {
  it("answers the readiness, cached", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ meta });
    expect(mockReadiness).toHaveBeenCalledWith(workspaceId, { fresh: false });
  });

  it("reads again for Check again", async () => {
    await get("?fresh=1");
    expect(mockReadiness).toHaveBeenCalledWith(workspaceId, { fresh: true });
  });

  it("is for admins with the flag only", async () => {
    allowRole("manager");
    expect((await get()).status).toBe(403);
    allowRole("admin");
    mockFeatureEnabled.mockResolvedValue(false);
    expect((await get()).status).toBe(404);
    expect(mockReadiness).not.toHaveBeenCalled();
  });

  it("answers 503 and logs when it can't be read", async () => {
    mockConnect.mockRejectedValue(new Error("Mongo down"));
    const response = await get();
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("load_failed");
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products API] meta readiness failed",
      expect.any(Error),
      expect.objectContaining({ event: "products.meta_readiness_failed" })
    );
  });
});
