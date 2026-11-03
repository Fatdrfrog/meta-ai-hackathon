/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockBrief = jest.fn();
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
jest.mock("@/lib/products/ads", () => ({
  loadProductAdBrief: (...args: unknown[]) => mockBrief(...args),
}));

import { GET } from "./route";

const workspaceId = "workspace-1";
const DOLL = "651f1f77bcf86cd799439011";
const MUG = "651f1f77bcf86cd799439012";
const context = { params: Promise.resolve({ workspaceId }) };
const get = (products: string) =>
  GET(
    new Request(
      `https://local.test/api/workspaces/${workspaceId}/products/ads/brief?products=${products}`
    ),
    context
  );
const brief = { products: [], missing: 0, blocked: null };

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
  mockBrief.mockResolvedValue(brief);
});

describe("the brief for a new ad", () => {
  it("starts from the picked products, before anything is spent", async () => {
    const response = await get(`${DOLL.toUpperCase()}, ${MUG}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ brief });
    expect(mockBrief).toHaveBeenCalledWith(workspaceId, [DOLL, MUG]);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("takes 1 to 3 distinct product ids", async () => {
    for (const products of [
      "",
      `${DOLL},${DOLL}`,
      `${DOLL},${MUG},651f1f77bcf86cd799439013,651f1f77bcf86cd799439014`,
      "not-an-id",
    ])
      expect((await get(products)).status).toBe(400);
    expect(mockBrief).not.toHaveBeenCalled();
  });

  it("is for admins with the flag only", async () => {
    allowRole("member");
    expect((await get(DOLL)).status).toBe(403);
    allowRole("admin");
    mockFeatureEnabled.mockResolvedValue(false);
    expect((await get(DOLL)).status).toBe(404);
    expect(mockBrief).not.toHaveBeenCalled();
  });

  it("answers 503 and logs when it can't be read", async () => {
    mockBrief.mockRejectedValue(new Error("Mongo down"));

    const response = await get(DOLL);

    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("load_failed");
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products API] ad brief GET failed",
      expect.any(Error),
      expect.objectContaining({ event: "products.ad_brief_failed" })
    );
  });
});
