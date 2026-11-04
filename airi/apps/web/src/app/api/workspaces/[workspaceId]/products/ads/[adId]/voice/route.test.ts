/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockLoggerError = jest.fn();
const mockChange = jest.fn();

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
jest.mock("@/lib/products/voices", () => ({
  changeProductAdVoice: (...args: unknown[]) => mockChange(...args),
}));

import { PRODUCT_AD_STOCK_VOICES } from "@/lib/products/types";
import { POST } from "./route";

const workspaceId = "workspace-1";
const adId = "751f1f77bcf86cd799439031";
const STOCK = PRODUCT_AD_STOCK_VOICES[0]!.id;
const making = { id: adId, status: "making", runKind: "voice" };
const post = (body: unknown, id = adId) =>
  POST(
    new Request(
      `https://local.test/api/workspaces/${workspaceId}/products/ads/${id}/voice`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    ),
    { params: Promise.resolve({ workspaceId, adId: id }) }
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockMembership.mockResolvedValue({
    supabase: {},
    user: { id: "user-1" },
    membership: { role: "admin" },
  });
  mockFeatureEnabled.mockResolvedValue(true);
  mockConnect.mockResolvedValue(undefined);
  mockChange.mockResolvedValue({ ad: making, started: true });
});

it("answers 202 with the ad, its voice run started", async () => {
  const response = await post({
    requestId: "r1",
    voice: "stock",
    stockVoiceId: STOCK,
  });
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ ad: making });
  expect(mockChange).toHaveBeenCalledWith({
    workspaceId,
    adId,
    request: { requestId: "r1", voice: "stock", stockVoiceId: STOCK },
  });
});

it("answers 200 as it is when nothing changes", async () => {
  mockChange.mockResolvedValue({ ad: making, started: false });
  expect((await post({ requestId: "r1", voice: "own" })).status).toBe(200);
});

it.each([
  ["ad_not_ready", 409],
  ["voice_not_found", 409],
  ["spend_limit", 409],
  ["trial_ended", 409],
  ["ai_actions_used", 409],
  ["ai_disabled", 409],
  ["ad_not_found", 404],
])("refuses %s with %i", async (code, status) => {
  mockChange.mockResolvedValue({ refused: code });
  const response = await post({ requestId: "r1", voice: "clone" });
  expect(response.status).toBe(status);
  expect((await response.json()).code).toBe(code);
});

it("refuses a body that isn't one, an id that isn't one, and non-admins", async () => {
  expect((await post({ requestId: "r1", voice: "stock" })).status).toBe(400);
  expect((await post({ requestId: "r1", voice: "own" }, "x")).status).toBe(404);
  mockMembership.mockResolvedValue({
    supabase: {},
    user: { id: "user-1" },
    membership: { role: "member" },
  });
  expect((await post({ requestId: "r1", voice: "own" })).status).toBe(403);
  expect(mockChange).not.toHaveBeenCalled();
});

it("answers 503 and logs when the run can't start", async () => {
  mockChange.mockRejectedValue(new Error("Temporal down"));
  const response = await post({ requestId: "r1", voice: "none" });
  expect(response.status).toBe(503);
  expect((await response.json()).code).toBe("ad_unavailable");
  expect(mockLoggerError).toHaveBeenCalledWith(
    "[Products API] ad voice change failed",
    expect.any(Error),
    expect.objectContaining({ event: "products.ad_voice_failed" })
  );
});
