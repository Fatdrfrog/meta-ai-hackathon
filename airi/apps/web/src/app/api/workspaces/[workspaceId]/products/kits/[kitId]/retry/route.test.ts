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
// Which parts are made again, and how, is kits.test.ts's.
jest.mock("@/lib/products/kits", () => ({
  retryProductKitPart: (...args: unknown[]) => mockRetry(...args),
}));

import { POST } from "./route";

const workspaceId = "workspace-1";
const kitId = "651f1f77bcf86cd799439099";
const context = { params: Promise.resolve({ workspaceId, kitId }) };
const post = (body: unknown) =>
  new Request(
    `https://local.test/api/workspaces/${workspaceId}/products/kits/${kitId}/retry`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
const kit = { id: kitId, status: "waiting_for_meta", parts: {} };

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
  mockRetry.mockResolvedValue({ kit });
});

describe("POST a kit part again", () => {
  it("makes the one part again and answers with the kit", async () => {
    const response = await POST(post({ part: "carousel" }), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kit });
    expect(mockRetry).toHaveBeenCalledWith({
      workspaceId,
      userId: "user-1",
      kitId,
      part: "carousel",
    });
  });

  it("refuses a part that isn't one", async () => {
    for (const body of [{ part: "wiring" }, {}, null]) {
      const response = await POST(post(body), context);
      expect(response.status).toBe(400);
    }
    expect(mockRetry).not.toHaveBeenCalled();
  });

  it("answers 404 for another workspace's kit and 409 for what stops it", async () => {
    mockRetry.mockResolvedValueOnce(null);
    expect((await POST(post({ part: "orderForm" }), context)).status).toBe(404);

    mockRetry.mockResolvedValueOnce({ refused: "whatsapp_not_connected" });
    const offline = await POST(post({ part: "orderForm" }), context);
    expect(offline.status).toBe(409);
    expect(await offline.json()).toMatchObject({
      code: "whatsapp_not_connected",
    });
  });

  it("refuses non-admins, and answers 503 when it breaks", async () => {
    allowRole("manager");
    expect((await POST(post({ part: "carousel" }), context)).status).toBe(403);
    allowRole("admin");
    mockRetry.mockRejectedValue(new Error("down"));
    expect((await POST(post({ part: "carousel" }), context)).status).toBe(503);
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products API] kit retry failed",
      expect.any(Error),
      expect.objectContaining({ event: "products.kit_retry_failed" })
    );
  });
});
