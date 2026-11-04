/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockCreate = jest.fn();
const mockLoad = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();

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
  logger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
}));
jest.mock("@/lib/products/ctwa", () => ({
  ...jest.requireActual("@/lib/products/ctwa"),
  createCtwa: (...args: unknown[]) => mockCreate(...args),
  loadCtwa: (...args: unknown[]) => mockLoad(...args),
}));
jest.mock("@/models/product-ad", () => ({ ProductAd: {} }));
jest.mock("@/models/workspace-product", () => ({ WorkspaceProduct: {} }));
jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));
jest.mock("@/lib/products/photo-urls", () => ({ productPhotoUrl: jest.fn() }));
jest.mock("@/lib/google/creative-asset-read-url-media-api-adapter", () => ({
  ensureMediaApiCreativeAssetReadUrlPort: jest.fn(),
}));

import { GET, maxDuration, POST } from "./route";

const workspaceId = "workspace-1";
const adId = "751f1f77bcf86cd799439031";
const url = (id: string) =>
  `https://local.test/api/workspaces/${workspaceId}/products/ads/${id}/ctwa`;
const context = (id = adId) => ({
  params: Promise.resolve({ workspaceId, adId: id }),
});
const post = (body: unknown, id = adId) =>
  POST(
    new Request(url(id), { method: "POST", body: JSON.stringify(body) }),
    context(id)
  );
const get = (id = adId) => GET(new Request(url(id)), context(id));

const ctwa = {
  attempt: 1,
  asset: "video",
  state: "video",
  effectiveStatus: null,
  adsManagerUrl: null,
  dailyBudgetCents: null,
  endsAt: null,
  errorCode: null,
  errorMessage: null,
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
  mockCreate.mockResolvedValue({ ctwa, started: true });
  mockLoad.mockResolvedValue({ ctwa });
});

describe("Create ad", () => {
  it("answers 202 with the WhatsApp ad being made", async () => {
    const response = await post({ requestId: "press-1", asset: "video" });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ctwa });
    expect(mockCreate).toHaveBeenCalledWith({
      workspaceId,
      adId,
      request: { requestId: "press-1", asset: "video" },
    });
  });

  it("answers a repeated press 200 as it is", async () => {
    mockCreate.mockResolvedValue({ ctwa, started: false });
    expect((await post({ requestId: "press-1", asset: "video" })).status).toBe(
      200
    );
  });

  it("is 400 for a body that isn't one, before anything is read", async () => {
    expect((await post({ requestId: "press-1", asset: "reel" })).status).toBe(
      400
    );
    expect((await post(null)).status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["page_whatsapp_missing", 409],
    ["ads_not_connected", 409],
    ["price_to_check", 409],
    ["ad_not_ready", 409],
    ["ad_not_found", 404],
  ])("answers the refusal %s with %i", async (code, status) => {
    mockCreate.mockResolvedValue({ refused: code, status });
    const response = await post({ requestId: "press-1", asset: "picture" });
    expect(response.status).toBe(status);
    expect((await response.json()).code).toBe(code);
  });

  it("passes Meta's words with a refusal, the first 3", async () => {
    mockCreate.mockResolvedValue({
      refused: "ctwa_failed",
      status: 409,
      issues: ["a", "b", "c", "d"],
    });
    const response = await post({ requestId: "press-1", asset: "video" });
    expect(await response.json()).toMatchObject({
      code: "ctwa_failed",
      issues: ["a", "b", "c"],
    });
  });

  it("has room past a short default for Meta's calls", () => {
    expect(maxDuration).toBe(30);
  });

  it("is 404 for an id that isn't one, and for admins with the flag only", async () => {
    expect((await post({ requestId: "p", asset: "video" }, "x")).status).toBe(
      404
    );
    allowRole("manager");
    expect((await post({ requestId: "p", asset: "video" })).status).toBe(403);
    mockFeatureEnabled.mockResolvedValue(false);
    allowRole("admin");
    expect((await post({ requestId: "p", asset: "video" })).status).toBe(404);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("answers 503 and logs when it can't start", async () => {
    mockCreate.mockRejectedValue(new Error("Mongo down"));
    const response = await post({ requestId: "press-1", asset: "video" });
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("ctwa_failed");
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products API] ctwa POST failed",
      expect.any(Error),
      expect.objectContaining({ event: "products.ctwa_create_failed" })
    );
  });
});

describe("the WhatsApp ad, advanced", () => {
  it("answers it after one step", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ctwa });
    expect(mockLoad).toHaveBeenCalledWith({ workspaceId, adId });
  });

  it("answers null when none was asked for", async () => {
    mockLoad.mockResolvedValue({ ctwa: null });
    expect(await (await get()).json()).toEqual({ ctwa: null });
  });

  it("is 404 for no ad, and 503 when it can't be read", async () => {
    mockLoad.mockResolvedValue({ refused: "ad_not_found", status: 404 });
    expect((await get()).status).toBe(404);
    expect((await get("nope")).status).toBe(404);
    mockLoad.mockRejectedValue(new Error("Mongo down"));
    expect((await get()).status).toBe(503);
  });
});
