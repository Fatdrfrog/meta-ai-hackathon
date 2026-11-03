/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockListKits = jest.fn();
const mockListAds = jest.fn();
const mockConnection = jest.fn();
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
jest.mock("@/lib/products/kits", () => ({
  listProductKitRecords: (...args: unknown[]) => mockListKits(...args),
  productsWhatsAppConnection: (...args: unknown[]) => mockConnection(...args),
}));
jest.mock("@/lib/products/ads", () => ({
  listProductAdRecords: (...args: unknown[]) => mockListAds(...args),
}));

import { GET } from "./route";

const workspaceId = "workspace-1";
const context = { params: Promise.resolve({ workspaceId }) };
const get = () =>
  new Request(`https://local.test/api/workspaces/${workspaceId}/products/made`);
const kits = [{ id: "kit-2" }, { id: "kit-1" }];
const ads = [{ id: "ad-1" }];
const whatsapp = { connected: true, displayPhone: "shop-number" };

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
  mockListKits.mockResolvedValue(kits);
  mockListAds.mockResolvedValue(ads);
  mockConnection.mockResolvedValue(whatsapp);
});

describe("GET what was made from the shelf", () => {
  it("answers the newest 20 kits and ads, and the WhatsApp number", async () => {
    const response = await GET(get(), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kits, ads, whatsapp });
    expect(mockListKits).toHaveBeenCalledWith(workspaceId, 20);
    expect(mockListAds).toHaveBeenCalledWith(workspaceId, 20);
  });

  it("still shows the kits when the ads or the number can't be read", async () => {
    mockListAds.mockRejectedValue(new Error("ads down"));
    mockConnection.mockRejectedValue(new Error("Supabase down"));

    const response = await GET(get(), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kits,
      ads: [],
      whatsapp: { connected: false, displayPhone: null },
    });
    expect(mockLoggerError).toHaveBeenCalledTimes(2);
  });

  it("refuses managers and workspaces without the flag", async () => {
    allowRole("manager");
    expect((await GET(get(), context)).status).toBe(403);
    allowRole("admin");
    mockFeatureEnabled.mockResolvedValue(false);
    expect((await GET(get(), context)).status).toBe(404);
    expect(mockListKits).not.toHaveBeenCalled();
  });

  it("answers 503 when the kits can't be read", async () => {
    mockListKits.mockRejectedValue(new Error("down"));

    const response = await GET(get(), context);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "load_failed" });
  });
});
