/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockCreateLink = jest.fn();
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
jest.mock("@/lib/products/whatsapp-intake", () => ({
  createProductsWhatsAppLink: (...args: unknown[]) => mockCreateLink(...args),
}));

import { POST } from "./route";

const workspaceId = "workspace-1";
const context = { params: Promise.resolve({ workspaceId }) };
const post = () =>
  new Request(
    `https://local.test/api/workspaces/${workspaceId}/products/whatsapp-link`,
    { method: "POST" }
  );
const link = {
  url: "https://wa.me/77082609346?text=Link%20my%20shop",
  expiresAt: "2026-10-28T12:30:00.000Z",
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
  mockCreateLink.mockResolvedValue(link);
});

describe("POST a WhatsApp link", () => {
  it("makes a one-time link for the admin", async () => {
    const response = await POST(post(), context);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(link);
    expect(mockCreateLink).toHaveBeenCalledWith(workspaceId, "user-1");
  });

  it("refuses managers and workspaces without the flag", async () => {
    allowRole("manager");
    expect((await POST(post(), context)).status).toBe(403);
    allowRole("admin");
    mockFeatureEnabled.mockResolvedValue(false);
    expect((await POST(post(), context)).status).toBe(404);
    expect(mockCreateLink).not.toHaveBeenCalled();
  });

  it("answers 404 until airi's number is set up, and 503 when the code can't be saved", async () => {
    mockCreateLink.mockResolvedValueOnce(null);
    const off = await POST(post(), context);
    expect(off.status).toBe(404);
    expect(await off.json()).toMatchObject({
      code: "whatsapp_intake_unavailable",
    });

    mockCreateLink.mockRejectedValueOnce(new Error("mongo down"));
    const failed = await POST(post(), context);
    expect(failed.status).toBe(503);
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products API] WhatsApp link POST failed",
      expect.any(Error),
      expect.objectContaining({ event: "products.whatsapp_link_failed" })
    );
  });
});
