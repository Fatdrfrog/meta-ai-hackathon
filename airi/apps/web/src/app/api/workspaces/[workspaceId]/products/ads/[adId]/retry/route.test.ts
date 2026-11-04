/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockRetry = jest.fn();
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
  retryProductAd: (...args: unknown[]) => mockRetry(...args),
}));

import { POST } from "./route";

const workspaceId = "workspace-1";
const adId = "751f1f77bcf86cd799439031";
const post = (id = adId) =>
  POST(
    new Request(
      `https://local.test/api/workspaces/${workspaceId}/products/ads/${id}/retry`,
      { method: "POST" }
    ),
    { params: Promise.resolve({ workspaceId, adId: id }) }
  );
const making = { id: adId, status: "making", renderNo: 2 };

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
  mockRetry.mockResolvedValue({ ad: making, started: true });
});

describe("trying a failed ad again", () => {
  it("answers 202 with the ad, a new run resuming it", async () => {
    const response = await post();

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ad: making });
    expect(mockRetry).toHaveBeenCalledWith({ workspaceId, adId });
  });

  it("answers an ad that isn't failed as it is", async () => {
    mockRetry.mockResolvedValue({ ad: making, started: false });
    expect((await post()).status).toBe(200);
  });

  it.each(["trial_ended", "spend_limit", "ai_actions_used", "ai_disabled"])(
    "refuses with 409 %s when the workspace can't pay for AI",
    async code => {
      mockRetry.mockResolvedValue({ refused: code });
      const response = await post();
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe(code);
    }
  );

  it("is 404 for an ad that isn't there or an id that isn't one", async () => {
    mockRetry.mockResolvedValue({ refused: "ad_not_found" });
    expect((await post()).status).toBe(404);
    expect((await post("x")).status).toBe(404);
    expect(mockRetry).toHaveBeenCalledTimes(1);
  });

  it("is for admins with the flag only", async () => {
    allowRole("manager");
    expect((await post()).status).toBe(403);
    expect(mockRetry).not.toHaveBeenCalled();
  });

  it("answers 503 and logs when the run can't start", async () => {
    mockRetry.mockRejectedValue(new Error("Temporal down"));

    const response = await post();

    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("ad_unavailable");
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products API] ad retry failed",
      expect.any(Error),
      expect.objectContaining({ event: "products.ad_retry_failed" })
    );
  });
});
