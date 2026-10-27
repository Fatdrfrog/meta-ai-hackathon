/**
 * @jest-environment node
 */

const mockGetMembership = jest.fn();
const mockGetDetail = jest.fn();
const mockPatch = jest.fn();
const mockGetWhatsAppWorkspaceContext = jest.fn();
const mockProviderCall = jest.fn();

jest.mock("@/lib/auth/workspace-membership", () => ({
  getAuthenticatedWorkspaceMembership: (...args: unknown[]) =>
    mockGetMembership(...args),
}));

jest.mock("@/lib/whatsapp/get-workspace-context", () => ({
  getWhatsAppWorkspaceContext: (...args: unknown[]) =>
    mockGetWhatsAppWorkspaceContext(...args),
}));

jest.mock("@/lib/whatsapp/qr-entry-points/manager", () => {
  class WhatsAppQrManagerError extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message);
    }
  }
  return {
    WhatsAppQrManagerError,
    patchManagedWhatsAppQrEntryPoint: (...args: unknown[]) =>
      mockPatch(...args),
  };
});

jest.mock("@/lib/whatsapp/qr-entry-points/queries", () => ({
  getWhatsAppQrEntryPointDetail: (...args: unknown[]) => mockGetDetail(...args),
}));

jest.mock("@/lib/whatsapp/qr-entry-points/provider", () => ({
  listWhatsAppChatQrs: (...args: unknown[]) => mockProviderCall(...args),
}));

import { WhatsAppQrManagerError } from "@/lib/whatsapp/qr-entry-points/manager";
import { GET, PATCH } from "./route";

const ENTRY_ID = "11111111-1111-4111-8111-111111111111";
const DETAIL = {
  entryPoint: {
    entryPointId: ENTRY_ID,
    workspaceId: "workspace-1",
    placementName: "Store front",
    status: "DRAFT",
    version: 0,
  },
  historicalCodes: [],
  historicalCodesHasMore: false,
  canCreateReplacement: true,
};

function context(entryPointId = ENTRY_ID) {
  return { params: Promise.resolve({ entryPointId }) };
}

describe("WhatsApp QR Manager detail route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetMembership.mockResolvedValue({ membership: { role: "member" } });
    mockGetDetail.mockResolvedValue(DETAIL);
  });

  it("returns local detail to a read-only member with no source lookup", async () => {
    const response = await GET(
      new Request(
        `http://localhost/api/whatsapp/qr-entry-points/entries/${ENTRY_ID}?workspaceId=workspace-1`
      ),
      context()
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(DETAIL);
    expect(mockGetMembership).toHaveBeenCalledWith("workspace-1");
    expect(mockGetDetail).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      entryPointId: ENTRY_ID,
    });
    expect(mockGetWhatsAppWorkspaceContext).not.toHaveBeenCalled();
    expect(mockProviderCall).not.toHaveBeenCalled();
  });

  it("returns 404 without tenant metadata when scoped detail is absent", async () => {
    mockGetDetail.mockResolvedValue(null);
    const response = await GET(
      new Request(
        `http://localhost/api/whatsapp/qr-entry-points/entries/${ENTRY_ID}?workspaceId=workspace-1`
      ),
      context()
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });

  it("strictly validates UUID v1-v5 before authentication", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/whatsapp/qr-entry-points/entries/not-a-uuid?workspaceId=workspace-1"
      ),
      context("not-a-uuid")
    );
    expect(response.status).toBe(400);
    expect(mockGetMembership).not.toHaveBeenCalled();
    expect(mockGetDetail).not.toHaveBeenCalled();
  });

  it("requires a Manager role for patch", async () => {
    const response = await PATCH(
      new Request(
        `http://localhost/api/whatsapp/qr-entry-points/entries/${ENTRY_ID}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: "workspace-1",
            expectedVersion: 0,
            placementName: "Changed",
          }),
        }
      ),
      context()
    );
    expect(response.status).toBe(403);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("patches under version CAS and returns fresh recovery detail", async () => {
    mockGetMembership.mockResolvedValue({ membership: { role: "manager" } });
    mockPatch.mockResolvedValue({ entryPointId: ENTRY_ID, version: 1 });
    const changed = {
      ...DETAIL,
      entryPoint: {
        ...DETAIL.entryPoint,
        placementName: "Changed",
        version: 1,
      },
    };
    mockGetDetail.mockResolvedValue(changed);

    const response = await PATCH(
      new Request(
        `http://localhost/api/whatsapp/qr-entry-points/entries/${ENTRY_ID}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: "workspace-1",
            expectedVersion: 0,
            placementName: "Changed",
          }),
        }
      ),
      context()
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(changed);
    expect(mockPatch).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      entryPointId: ENTRY_ID,
      expectedVersion: 0,
      placementName: "Changed",
    });
    expect(mockGetDetail).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      entryPointId: ENTRY_ID,
    });
  });

  it("maps stale versions to 409", async () => {
    mockGetMembership.mockResolvedValue({ membership: { role: "admin" } });
    mockPatch.mockRejectedValue(
      new WhatsAppQrManagerError("VERSION_CONFLICT", "Version conflict")
    );

    const response = await PATCH(
      new Request(
        `http://localhost/api/whatsapp/qr-entry-points/entries/${ENTRY_ID}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: "workspace-1",
            expectedVersion: 3,
            placementName: "Changed",
          }),
        }
      ),
      context()
    );
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("VERSION_CONFLICT");
  });

  it("rejects unknown or empty patch fields", async () => {
    const response = await PATCH(
      new Request(
        `http://localhost/api/whatsapp/qr-entry-points/entries/${ENTRY_ID}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: "workspace-1",
            expectedVersion: 0,
            unknown: true,
          }),
        }
      ),
      context()
    );
    expect(response.status).toBe(400);
    expect(mockGetMembership).not.toHaveBeenCalled();
  });
});
