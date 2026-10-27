/**
 * @jest-environment node
 */

const mockGetMembership = jest.fn();
const mockList = jest.fn();
const mockCreate = jest.fn();
const mockGetDetail = jest.fn();
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
    listWhatsAppQrEntryPoints: (...args: unknown[]) => mockList(...args),
    createUnassignedWhatsAppQrDraftEntryPoint: (...args: unknown[]) =>
      mockCreate(...args),
  };
});

jest.mock("@/lib/whatsapp/qr-entry-points/queries", () => ({
  getWhatsAppQrEntryPointDetail: (...args: unknown[]) => mockGetDetail(...args),
}));

jest.mock("@/lib/whatsapp/qr-entry-points/provider", () => ({
  listWhatsAppChatQrs: (...args: unknown[]) => mockProviderCall(...args),
}));

import { WhatsAppQrManagerError } from "@/lib/whatsapp/qr-entry-points/manager";
import { GET, POST } from "./route";

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

describe("WhatsApp QR Manager root route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetMembership.mockResolvedValue({ membership: { role: "member" } });
    mockList.mockResolvedValue({ items: [], nextCursor: null });
    mockGetDetail.mockResolvedValue(DETAIL);
  });

  it("authenticates a read directly and maps one source facet", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/whatsapp/qr-entry-points?workspaceId=workspace-1&query=store&facet=source&value=source-1&limit=25&cursor=opaque"
      )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], nextCursor: null });
    expect(mockGetMembership).toHaveBeenCalledWith("workspace-1");
    expect(mockList).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      query: "store",
      sourceId: "source-1",
      limit: 25,
      cursor: "opaque",
    });
    expect(mockGetWhatsAppWorkspaceContext).not.toHaveBeenCalled();
    expect(mockProviderCall).not.toHaveBeenCalled();
  });

  it.each([
    "workspaceId=workspace-1&facet=source",
    "workspaceId=workspace-1&value=source-1",
    "workspaceId=workspace-1&facet=unknown&value=x",
    "workspaceId=workspace-1&facet=status&value=UNKNOWN",
    "workspaceId=workspace-1&limit=51",
  ])("rejects invalid paired query input: %s", async query => {
    const response = await GET(
      new Request(`http://localhost/api/whatsapp/qr-entry-points?${query}`)
    );

    expect(response.status).toBe(400);
    expect(mockGetMembership).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });

  it("requires an existing Manager role for create", async () => {
    const response = await POST(
      new Request("http://localhost/api/whatsapp/qr-entry-points", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "workspace-1",
          entryPointId: ENTRY_ID,
          placementName: "Store front",
        }),
      })
    );

    expect(response.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("creates a local draft and returns detail without provider access", async () => {
    mockGetMembership.mockResolvedValue({ membership: { role: "manager" } });
    mockCreate.mockResolvedValue({ entryPointId: ENTRY_ID, version: 0 });

    const response = await POST(
      new Request("http://localhost/api/whatsapp/qr-entry-points", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "workspace-1",
          entryPointId: ENTRY_ID,
          placementName: "Store front",
          desiredMessage: "Hello",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(DETAIL);
    expect(mockCreate).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      entryPointId: ENTRY_ID,
      placementName: "Store front",
      desiredMessage: "Hello",
    });
    expect(mockGetDetail).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      entryPointId: ENTRY_ID,
    });
    expect(mockGetWhatsAppWorkspaceContext).not.toHaveBeenCalled();
    expect(mockProviderCall).not.toHaveBeenCalled();
  });

  it("returns the migration gate as 503 before a local draft write", async () => {
    mockGetMembership.mockResolvedValue({ membership: { role: "admin" } });
    mockCreate.mockRejectedValue(
      new Error("WHATSAPP_QR_ENTRY_POINT_INDEX_MIGRATION_REQUIRED")
    );

    const response = await POST(
      new Request("http://localhost/api/whatsapp/qr-entry-points", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "workspace-1",
          entryPointId: ENTRY_ID,
          placementName: "Store front",
        }),
      })
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "WhatsApp QR index migration is required",
      code: "WHATSAPP_QR_INDEX_MIGRATION_REQUIRED",
    });
    expect(mockGetDetail).not.toHaveBeenCalled();
  });

  it("maps mismatched stable-UUID replays to 409", async () => {
    mockGetMembership.mockResolvedValue({ membership: { role: "admin" } });
    mockCreate.mockRejectedValue(
      new WhatsAppQrManagerError("CONFLICT", "Entry point replay conflicts")
    );

    const response = await POST(
      new Request("http://localhost/api/whatsapp/qr-entry-points", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "workspace-1",
          entryPointId: ENTRY_ID,
          placementName: "Changed",
        }),
      })
    );

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("CONFLICT");
  });
});
