/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockRun = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerInfo = jest.fn();

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
    info: (...args: unknown[]) => mockLoggerInfo(...args),
  },
}));
jest.mock("@/lib/products/ctwa", () => ({
  ...jest.requireActual("@/lib/products/ctwa"),
  runCtwa: (...args: unknown[]) => mockRun(...args),
}));
jest.mock("@/models/product-ad", () => ({ ProductAd: {} }));
jest.mock("@/models/workspace-product", () => ({ WorkspaceProduct: {} }));
jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));
jest.mock("@/lib/products/photo-urls", () => ({ productPhotoUrl: jest.fn() }));
jest.mock("@/lib/google/creative-asset-read-url-media-api-adapter", () => ({
  ensureMediaApiCreativeAssetReadUrlPort: jest.fn(),
}));

import { maxDuration, POST } from "./route";

const workspaceId = "workspace-1";
const adId = "751f1f77bcf86cd799439031";
const post = (body: unknown, id = adId) =>
  POST(
    new Request(
      `https://local.test/api/workspaces/${workspaceId}/products/ads/${id}/ctwa/run`,
      { method: "POST", body: JSON.stringify(body) }
    ),
    { params: Promise.resolve({ workspaceId, adId: id }) }
  );

const running = {
  attempt: 1,
  asset: "video",
  state: "running",
  effectiveStatus: "PENDING_REVIEW",
  adsManagerUrl:
    "https://adsmanager.facebook.com/adsmanager/manage/ads?act=42&selected_ad_ids=a",
  dailyBudgetCents: 100,
  endsAt: "2026-11-07T05:00:00.000Z",
  errorCode: null,
  errorMessage: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockMembership.mockResolvedValue({
    supabase: {},
    user: { id: "user-1" },
    membership: { role: "admin" },
  });
  mockFeatureEnabled.mockResolvedValue(true);
  mockConnect.mockResolvedValue(undefined);
  mockRun.mockResolvedValue({ ctwa: running });
});

describe("Run", () => {
  it("answers 200 with the ad running, Meta reviewing it", async () => {
    const response = await post({ dailyBudgetCents: 100, days: 3 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ctwa: running });
    expect(mockRun).toHaveBeenCalledWith({
      workspaceId,
      adId,
      request: { dailyBudgetCents: 100, days: 3 },
    });
  });

  it.each([
    ["run_disabled", 409],
    ["budget_refused", 409],
    ["ad_not_ready", 409],
    ["price_to_check", 409],
    ["ads_not_connected", 409],
    ["ad_not_found", 404],
  ])("answers the refusal %s with %i", async (code, status) => {
    mockRun.mockResolvedValue({ refused: code, status });
    const response = await post({ dailyBudgetCents: 500, days: 7 });
    expect(response.status).toBe(status);
    expect((await response.json()).code).toBe(code);
  });

  it("is 400 for budgets that aren't whole cents and days", async () => {
    expect((await post({ dailyBudgetCents: 1.5, days: 3 })).status).toBe(400);
    expect((await post({ dailyBudgetCents: 100 })).status).toBe(400);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("is never cut off halfway through switching the ad on", () => {
    expect(maxDuration).toBe(30);
  });

  it("is for admins only", async () => {
    mockMembership.mockResolvedValue({
      supabase: {},
      user: { id: "user-1" },
      membership: { role: "manager" },
    });
    expect((await post({ dailyBudgetCents: 100, days: 3 })).status).toBe(403);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("answers 503 and logs when it fails", async () => {
    mockRun.mockRejectedValue(new Error("Mongo down"));
    const response = await post({ dailyBudgetCents: 100, days: 3 });
    expect(response.status).toBe(503);
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products API] ctwa run failed",
      expect.any(Error),
      expect.objectContaining({ event: "products.ctwa_run_failed" })
    );
  });
});
