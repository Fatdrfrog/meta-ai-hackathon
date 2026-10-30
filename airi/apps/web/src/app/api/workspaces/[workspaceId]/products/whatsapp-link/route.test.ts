/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockOpen = jest.fn();
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
  openProductsWhatsAppPairing: (...args: unknown[]) => mockOpen(...args),
  loadProductsWhatsAppLink: (...args: unknown[]) => mockLoad(...args),
}));

import type { ProductsWhatsAppLinkResponse } from "@/lib/products/types";
import { GET, POST } from "./route";

const workspaceId = "workspace-1";
const context = { params: Promise.resolve({ workspaceId }) };
const request = (method: string) =>
  new Request(
    `https://local.test/api/workspaces/${workspaceId}/products/whatsapp-link`,
    { method }
  );
const panel: ProductsWhatsAppLinkResponse = {
  pairing: {
    url: "https://wa.me/77082609346?text=Hi%20Airi!",
    expiresAt: "2026-10-28T12:15:00.000Z",
  },
  requests: [
    {
      id: "651f1f77bcf86cd799439081",
      phone: "+7 ••• ••• 45 67",
      profileName: "Samat",
      createdAt: "2026-10-28T12:01:00.000Z",
    },
  ],
  linkedPhones: [],
  businessNumbers: [],
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
  mockOpen.mockResolvedValue(panel);
  mockLoad.mockResolvedValue(panel);
});

describe.each([
  ["GET", GET, mockLoad],
  ["POST", POST, mockOpen],
] as const)("%s the WhatsApp link panel", (method, handler, lib) => {
  test.each([401, 403])(
    "passes a denied membership (%s) through",
    async status => {
      mockMembership.mockResolvedValue({
        error: new Response("Denied", { status }),
      });

      expect((await handler(request(method), context)).status).toBe(status);
      expect(lib).not.toHaveBeenCalled();
    }
  );

  it("refuses managers and workspaces without the flag", async () => {
    allowRole("manager");
    const manager = await handler(request(method), context);
    expect(manager.status).toBe(403);
    expect(await manager.json()).toMatchObject({ code: "admin_required" });

    allowRole("admin");
    mockFeatureEnabled.mockResolvedValue(false);
    const off = await handler(request(method), context);
    expect(off.status).toBe(404);
    expect(await off.json()).toMatchObject({ code: "feature_disabled" });
    expect(lib).not.toHaveBeenCalled();
  });

  it("answers 404 until airi's number is set up", async () => {
    lib.mockResolvedValueOnce(null);

    const response = await handler(request(method), context);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: "whatsapp_intake_unavailable",
    });
  });
});

describe("GET the WhatsApp link panel", () => {
  it("shows the panel to an admin, uncached", async () => {
    const response = await GET(request("GET"), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(panel);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mockLoad).toHaveBeenCalledWith(workspaceId);
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it("answers 503 and logs when the panel can't be loaded", async () => {
    mockLoad.mockRejectedValue(new Error("mongo down"));

    const response = await GET(request("GET"), context);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "load_failed" });
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products API] WhatsApp link GET failed",
      expect.any(Error),
      { event: "products.whatsapp_link_load_failed", workspaceId }
    );
  });
});

describe("POST the WhatsApp link panel", () => {
  it("opens the shop to phones for the admin and answers with the panel", async () => {
    const response = await POST(request("POST"), context);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(panel);
    expect(mockOpen).toHaveBeenCalledWith(workspaceId, "user-1");
  });

  it("answers 409 while another workspace with Products has the same name", async () => {
    mockOpen.mockResolvedValueOnce("shop_name_taken");

    const response = await POST(request("POST"), context);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "whatsapp_link_shop_name_taken",
    });
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "[Products API] WhatsApp shop name taken",
      {
        event: "products.whatsapp_shop_name_taken",
        workspaceId,
        userId: "user-1",
      }
    );
  });

  it("answers 503 and logs when the shop can't be opened", async () => {
    mockOpen.mockRejectedValue(new Error("mongo down"));

    const response = await POST(request("POST"), context);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "save_failed" });
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products API] WhatsApp link POST failed",
      expect.any(Error),
      { event: "products.whatsapp_link_failed", workspaceId }
    );
  });
});
