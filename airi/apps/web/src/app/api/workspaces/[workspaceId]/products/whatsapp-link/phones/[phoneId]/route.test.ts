/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockUnlink = jest.fn();
const mockLoad = jest.fn();
const mockLoggerError = jest.fn();
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
    info: (...args: unknown[]) => mockLoggerInfo(...args),
  },
}));
jest.mock("@/lib/products/whatsapp-intake", () => ({
  unlinkProductsWhatsAppPhone: (...args: unknown[]) => mockUnlink(...args),
  loadProductsWhatsAppLink: (...args: unknown[]) => mockLoad(...args),
}));

import type { ProductsWhatsAppLinkResponse } from "@/lib/products/types";
import { DELETE } from "./route";

const workspaceId = "workspace-1";
const phoneId = "651f1f77bcf86cd799439091";
const context = (id = phoneId) => ({
  params: Promise.resolve({ workspaceId, phoneId: id }),
});
const request = () =>
  new Request(
    `https://local.test/api/workspaces/${workspaceId}/products/whatsapp-link/phones/${phoneId}`,
    { method: "DELETE" }
  );
const panel: ProductsWhatsAppLinkResponse = {
  pairing: null,
  requests: [],
  linkedPhones: [],
  businessNumbers: ["+7 701 999 8877"],
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
  mockUnlink.mockResolvedValue(true);
  mockLoad.mockResolvedValue(panel);
});

describe("DELETE a linked phone", () => {
  it("unlinks the phone for the admin and answers with the panel", async () => {
    const response = await DELETE(request(), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(panel);
    expect(mockUnlink).toHaveBeenCalledWith(workspaceId, phoneId);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "[Products API] WhatsApp phone unlinked",
      {
        event: "products.whatsapp_phone_unlinked",
        workspaceId,
        phoneId,
        userId: "user-1",
      }
    );
  });

  test.each([401, 403])(
    "passes a denied membership (%s) through",
    async status => {
      mockMembership.mockResolvedValue({
        error: new Response("Denied", { status }),
      });

      expect((await DELETE(request(), context())).status).toBe(status);
      expect(mockUnlink).not.toHaveBeenCalled();
    }
  );

  it("refuses managers and workspaces without the flag", async () => {
    allowRole("manager");
    expect((await DELETE(request(), context())).status).toBe(403);
    allowRole("admin");
    mockFeatureEnabled.mockResolvedValue(false);
    expect((await DELETE(request(), context())).status).toBe(404);
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it("answers 404 for a malformed id, or a phone another workspace linked", async () => {
    expect((await DELETE(request(), context("not-an-id"))).status).toBe(404);
    expect(mockUnlink).not.toHaveBeenCalled();

    mockUnlink.mockResolvedValueOnce(false);
    const missing = await DELETE(request(), context());
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      code: "whatsapp_link_not_found",
    });
    expect(mockUnlink).toHaveBeenCalledWith(workspaceId, phoneId);
  });

  it("answers 503 and logs when the phone can't be unlinked", async () => {
    mockUnlink.mockRejectedValueOnce(new Error("mongo down"));

    const response = await DELETE(request(), context());

    expect(response.status).toBe(503);
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products API] WhatsApp phone DELETE failed",
      expect.any(Error),
      { event: "products.whatsapp_unlink_failed", workspaceId, phoneId }
    );
  });
});
