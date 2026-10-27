const mockCreateClient = jest.fn();
const mockClientFrom = jest.fn();
const mockAdminFrom = jest.fn();
const mockDiscoverWABAs = jest.fn();
const mockValidateWABAAccess = jest.fn();
const mockGetCompanyIdForWorkspace = jest.fn();
const mockFindWhatsAppPhoneOwner = jest.fn();
const mockListWhatsAppPhoneOwnersForCompany = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockAdminFrom(...args),
  },
}));

jest.mock("@/lib/whatsapp/credentials", () => ({
  normalizeWhatsAppCredentials: (value: unknown) => ({
    accessToken:
      value && typeof value === "object" && "access_token" in value
        ? (value as { access_token?: string }).access_token
        : undefined,
  }),
}));

jest.mock("@/lib/supabase/company-users", () => ({
  getCompanyIdForWorkspace: (...args: unknown[]) =>
    mockGetCompanyIdForWorkspace(...args),
}));

jest.mock("@/lib/whatsapp/waba-service", () => ({
  discoverWABAs: (...args: unknown[]) => mockDiscoverWABAs(...args),
  validateWABAAccess: (...args: unknown[]) => mockValidateWABAAccess(...args),
}));

jest.mock("@/lib/whatsapp/account/inventory", () => ({
  buildWhatsAppPhoneOwnership: ({
    owner,
    currentWorkspaceId,
  }: {
    owner?: { sourceId: string; workspaceId: string; workspaceName?: string };
    currentWorkspaceId?: string | null;
  }) =>
    owner
      ? {
          status:
            owner.workspaceId === currentWorkspaceId
              ? "current_workspace"
              : "other_workspace",
          source_id: owner.sourceId,
          workspace_id: owner.workspaceId,
          workspace_name: owner.workspaceName,
        }
      : { status: "available" },
  findWhatsAppPhoneOwner: (...args: unknown[]) =>
    mockFindWhatsAppPhoneOwner(...args),
  listWhatsAppPhoneOwnersForCompany: (...args: unknown[]) =>
    mockListWhatsAppPhoneOwnersForCompany(...args),
}));

jest.mock("@/lib/whatsapp/account/persistence", () => ({
  recordObservedWhatsAppAccountsForCompany: jest.fn(async () => ({
    persisted: true,
  })),
}));

import { recordObservedWhatsAppAccountsForCompany } from "@/lib/whatsapp/account/persistence";
import {
  sealWhatsAppSelectionSession,
  WHATSAPP_SELECTION_SESSION_COOKIE,
} from "@/lib/whatsapp/embedded-signup-selection-session";
import { GET, POST } from "./route";

function selectionCookie(workspaceId = "workspace-1", userId = "user-1") {
  const sealed = sealWhatsAppSelectionSession({
    accessToken: "embedded-token",
    workspaceId,
    userId,
  });
  return `${WHATSAPP_SELECTION_SESSION_COOKIE}=${sealed!.value}`;
}

type ClientQuery = {
  select: jest.Mock<ClientQuery, unknown[]>;
  eq: jest.Mock<ClientQuery, unknown[]>;
  maybeSingle: jest.Mock<
    Promise<{ data: { workspace_id: string }; error: null }>,
    []
  >;
  single: jest.Mock<
    Promise<{ data: { workspace_id: string }; error: null }>,
    []
  >;
};

type AdminQuery = {
  select: jest.Mock<AdminQuery, unknown[]>;
  eq: jest.Mock<AdminQuery, unknown[]>;
  order: jest.Mock<AdminQuery, unknown[]>;
  limit: jest.Mock<Promise<{ data: unknown[]; error: null }>, [number]>;
};

function createClientQuery() {
  const query = {} as ClientQuery;
  query.select = jest.fn(() => query);
  query.eq = jest.fn(() => query);
  query.maybeSingle = jest.fn(async () => ({
    data: { workspace_id: "workspace-1" },
    error: null,
  }));
  query.single = jest.fn(async () => ({
    data: { workspace_id: "workspace-1" },
    error: null,
  }));
  return query;
}

function createAdminQuery(
  credentials: Record<string, unknown> = { access_token: "stored-token" }
) {
  const query = {} as AdminQuery;
  query.select = jest.fn(() => query);
  query.eq = jest.fn(() => query);
  query.order = jest.fn(() => query);
  query.limit = jest.fn(async (_limit: number) => ({
    data: [{ id: "source-1", credentials }],
    error: null,
  }));
  return query;
}

describe("/api/sources/whatsapp/select-waba", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClientFrom.mockImplementation(() => createClientQuery());
    mockAdminFrom.mockImplementation(() => createAdminQuery());
    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: jest.fn(async () => ({ data: { user: { id: "user-1" } } })),
      },
      from: (...args: unknown[]) => mockClientFrom(...args),
    });
    mockGetCompanyIdForWorkspace.mockResolvedValue("company-1");
    mockDiscoverWABAs.mockResolvedValue([
      {
        waba: { id: "waba-1", name: "Main WABA" },
        phoneNumbers: [
          {
            id: "phone-1",
            display_phone_number: "+7 701 000 00 01",
          },
        ],
        accountType: "owned",
        businessId: "business-1",
        businessName: "Airi",
      },
    ]);
    mockValidateWABAAccess.mockResolvedValue({
      valid: true,
      phoneNumbers: [
        {
          id: "phone-1",
          display_phone_number: "+7 701 000 00 01",
          verified_name: "Airi",
        },
      ],
    });
    mockFindWhatsAppPhoneOwner.mockResolvedValue(null);
    mockListWhatsAppPhoneOwnersForCompany.mockResolvedValue(new Map());
  });

  it("discovers company inventory with an existing company source token", async () => {
    mockListWhatsAppPhoneOwnersForCompany.mockResolvedValue(
      new Map([
        [
          "phone-1",
          [
            {
              phoneNumberId: "phone-1",
              sourceId: "source-2",
              workspaceId: "workspace-2",
              workspaceName: "Sales",
            },
          ],
        ],
      ])
    );

    const response = await GET(
      new Request(
        "https://app.test/api/sources/whatsapp/select-waba?workspace_id=workspace-1"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockDiscoverWABAs).toHaveBeenCalledWith("stored-token");
    expect(recordObservedWhatsAppAccountsForCompany).toHaveBeenCalledWith({
      companyId: "company-1",
      accounts: expect.any(Array),
    });
    expect(payload.wabas[0].phoneNumbers[0].ownership).toEqual({
      status: "other_workspace",
      source_id: "source-2",
      workspace_id: "workspace-2",
      workspace_name: "Sales",
    });
  });

  it("rejects selecting a phone already linked to another workspace", async () => {
    mockFindWhatsAppPhoneOwner.mockResolvedValue({
      phoneNumberId: "phone-1",
      sourceId: "source-2",
      workspaceId: "workspace-2",
      workspaceName: "Sales",
    });

    const response = await POST(
      new Request("https://app.test/api/sources/whatsapp/select-waba", {
        method: "POST",
        body: JSON.stringify({
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          workspace_id: "workspace-1",
        }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      error: "phone_already_connected",
      conflict: {
        phone_number_id: "phone-1",
        source_id: "source-2",
        workspace_id: "workspace-2",
        workspace_name: "Sales",
      },
    });
  });

  it("does not expose the resolved company token for unlinked phone selection", async () => {
    const response = await POST(
      new Request("https://app.test/api/sources/whatsapp/select-waba", {
        method: "POST",
        body: JSON.stringify({
          waba_id: "waba-1",
          phone_number_id: "phone-1",
          workspace_id: "workspace-1",
        }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockValidateWABAAccess).toHaveBeenCalledWith(
      "waba-1",
      "stored-token"
    );
    expect(payload.data).toMatchObject({
      waba_id: "waba-1",
      phone_number_id: "phone-1",
      display_phone_number: "+7 701 000 00 01",
    });
    expect(payload.data).not.toHaveProperty("access_token");
  });

  describe("when the company's only stored token belongs to a removed source", () => {
    beforeEach(() => {
      mockAdminFrom.mockImplementation(() =>
        createAdminQuery({
          access_token: "stored-token",
          coexistence_reonboarding_status: "removed",
          cloud_api_messaging_suspended: true,
        })
      );
    });

    it("asks for a Meta reconnect instead of listing inventory", async () => {
      const response = await GET(
        new Request(
          "https://app.test/api/sources/whatsapp/select-waba?workspace_id=workspace-1"
        )
      );

      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe("reauthorization_required");
      expect(mockDiscoverWABAs).not.toHaveBeenCalled();
    });

    it("refuses to validate a selection with that token", async () => {
      const response = await POST(
        new Request("https://app.test/api/sources/whatsapp/select-waba", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspace_id: "workspace-1",
            waba_id: "waba-1",
            phone_number_id: "phone-1",
          }),
        })
      );

      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe("reauthorization_required");
      expect(mockValidateWABAAccess).not.toHaveBeenCalled();
    });
  });

  describe("Embedded Signup selection session", () => {
    const originalSecret = process.env.ENCRYPTION_SECRET;

    beforeAll(() => {
      process.env.ENCRYPTION_SECRET = "test-selection-session-secret";
    });

    afterAll(() => {
      process.env.ENCRYPTION_SECRET = originalSecret;
    });

    it("lists WABAs with the token from the session cookie, not the URL", async () => {
      const response = await GET(
        new Request(
          "https://app.test/api/sources/whatsapp/select-waba?workspace_id=workspace-1&selection_session=1",
          { headers: { cookie: selectionCookie() } }
        )
      );

      expect(response.status).toBe(200);
      expect(mockDiscoverWABAs).toHaveBeenCalledWith("embedded-token");
    });

    it("reports an expired selection when the session cookie is missing", async () => {
      const response = await GET(
        new Request(
          "https://app.test/api/sources/whatsapp/select-waba?workspace_id=workspace-1&selection_session=1"
        )
      );

      expect(response.status).toBe(410);
      await expect(response.json()).resolves.toMatchObject({
        error: "selection_session_expired",
      });
      expect(mockDiscoverWABAs).not.toHaveBeenCalled();
    });

    it("ignores a session cookie issued for another workspace", async () => {
      const response = await GET(
        new Request(
          "https://app.test/api/sources/whatsapp/select-waba?workspace_id=workspace-1&selection_session=1",
          { headers: { cookie: selectionCookie("workspace-2") } }
        )
      );

      expect(response.status).toBe(410);
      expect(mockDiscoverWABAs).not.toHaveBeenCalled();
    });

    it("validates the chosen number with the session token", async () => {
      const response = await POST(
        new Request("https://app.test/api/sources/whatsapp/select-waba", {
          method: "POST",
          headers: { cookie: selectionCookie() },
          body: JSON.stringify({
            waba_id: "waba-1",
            phone_number_id: "phone-1",
            workspace_id: "workspace-1",
          }),
        })
      );

      expect(response.status).toBe(200);
      expect(mockValidateWABAAccess).toHaveBeenCalledWith(
        "waba-1",
        "embedded-token"
      );
    });
  });
});
