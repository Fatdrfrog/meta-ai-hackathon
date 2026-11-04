/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockSendTest = jest.fn();
const mockGetUser = jest.fn();
const mockRateLimit = jest.fn();
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
jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: () => mockGetUser() } }),
}));
jest.mock("@icecore/shared/lib/rate-limiter", () => ({
  createRateLimiter: () => ({ limiter: "products:form-test" }),
  checkRateLimit: (...args: unknown[]) => mockRateLimit(...args),
}));
// The saved test phone, as the campaigns' Test send reads it.
jest.mock("@/lib/whatsapp/test-send", () => ({
  WHATSAPP_TEST_SEND_HOURLY_LIMIT: 10,
  readWhatsAppTestPhone: (metadata: { testPhone?: string } | undefined) =>
    metadata?.testPhone ?? null,
}));
// What goes to the phone is kit-form-test.test.ts's.
jest.mock("@/lib/products/kit-form-test", () => ({
  sendProductKitFormTest: (...args: unknown[]) => mockSendTest(...args),
}));

import { POST } from "./route";

const workspaceId = "workspace-1";
const kitId = "651f1f77bcf86cd799439099";
const context = { params: Promise.resolve({ workspaceId, kitId }) };
const post = (body: unknown) =>
  new Request(
    `https://local.test/api/workspaces/${workspaceId}/products/kits/${kitId}/send-test`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
const TEST_PHONE = "owner-test-phone";

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
  mockGetUser.mockResolvedValue({
    data: {
      user: {
        id: "user-1",
        user_metadata: { testPhone: TEST_PHONE },
      },
    },
  });
  mockRateLimit.mockResolvedValue({ success: true, reset: Date.now() });
  mockSendTest.mockResolvedValue({ sent: true });
});

describe("POST Send me the order form", () => {
  it("sends the kit's form to the owner's saved test phone", async () => {
    const response = await POST(post({ part: "orderForm" }), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sent: true });
    expect(mockSendTest).toHaveBeenCalledWith({
      workspaceId,
      kitId,
      to: TEST_PHONE,
    });
    expect(mockRateLimit).toHaveBeenCalledWith(
      { limiter: "products:form-test" },
      "user-1",
      10
    );
  });

  it("refuses another part, non-admins and workspaces without the flag", async () => {
    expect((await POST(post({ part: "carousel" }), context)).status).toBe(400);
    allowRole("manager");
    expect((await POST(post({ part: "orderForm" }), context)).status).toBe(403);
    allowRole("admin");
    mockFeatureEnabled.mockResolvedValue(false);
    expect((await POST(post({ part: "orderForm" }), context)).status).toBe(404);
    expect(mockSendTest).not.toHaveBeenCalled();
  });

  it("asks for a test number first, and caps the sends per hour", async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: "user-1", user_metadata: {} } },
    });
    const missing = await POST(post({ part: "orderForm" }), context);
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ code: "test_phone_missing" });

    mockRateLimit.mockResolvedValueOnce({ success: false, reset: Date.now() });
    const limited = await POST(post({ part: "orderForm" }), context);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "rate_limited" });
    expect(mockSendTest).not.toHaveBeenCalled();

    // A limiter outage doesn't block the owner's own test.
    mockRateLimit.mockRejectedValueOnce(new Error("Redis is down"));
    expect((await POST(post({ part: "orderForm" }), context)).status).toBe(200);
  });

  it("answers each refusal with its code", async () => {
    const cases: Array<[unknown, number, string]> = [
      [null, 404, "kit_not_found"],
      [{ refused: "kit_part_busy" }, 409, "kit_part_busy"],
      [{ refused: "invalid_request" }, 409, "invalid_request"],
      [{ refused: "whatsapp_not_connected" }, 409, "whatsapp_not_connected"],
      [{ refused: "test_phone_is_shop" }, 409, "test_phone_is_shop"],
      [{ refused: "test_phone_unreachable" }, 409, "test_phone_unreachable"],
      [{ refused: "test_phone_not_allowed" }, 409, "test_phone_not_allowed"],
    ];
    for (const [outcome, status, code] of cases) {
      mockSendTest.mockResolvedValueOnce(outcome);
      const response = await POST(post({ part: "orderForm" }), context);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
    }
  });

  it("answers 503 when the form can't be sent", async () => {
    mockSendTest.mockRejectedValue(new Error("Meta is down"));
    const response = await POST(post({ part: "orderForm" }), context);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "draft_failed" });
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products API] kit form test send failed",
      expect.any(Error),
      expect.objectContaining({ event: "products.kit_form_test_failed" })
    );
  });
});
