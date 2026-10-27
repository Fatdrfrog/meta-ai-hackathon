const mockCookieClient = jest.fn();
const mockBearerClient = jest.fn();
const mockGetUser = jest.fn();
const mockMembershipRead = jest.fn();
const mockAdminFrom = jest.fn();
const mockSavingsRead = jest.fn();
const mockSavingsUpdate = jest.fn();
const mockSavingsInsert = jest.fn();
const mockConnectDB = jest.fn();
const mockTipFind = jest.fn();
const mockTipRead = jest.fn();
const mockTipUpdate = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: () => mockCookieClient(),
}));
jest.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => mockBearerClient(...args),
}));
jest.mock("@/lib/supabase/public-key", () => ({
  getSupabasePublicKey: () => "sb_publishable_test_fixture_1234567890",
}));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: (...args: unknown[]) => mockAdminFrom(...args) },
}));
jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: () => mockConnectDB(),
}));
jest.mock("@/models/coaching-tip", () => ({
  __esModule: true,
  default: {
    findById: (...args: unknown[]) => mockTipFind(...args),
    findByIdAndUpdate: (...args: unknown[]) => mockTipUpdate(...args),
    findOneAndUpdate: (...args: unknown[]) => mockTipUpdate(...args),
  },
}));

import { NextRequest } from "next/server";
import { GET, PATCH } from "./savings/route";
import { POST } from "./adopt/route";

const workspaceId = "00000000-0000-4000-8000-000000000002";
const foreignWorkspaceId = "00000000-0000-4000-8000-000000000003";
const suggestionId = "507f1f77bcf86cd799439011";
const userId = "user-1";
let memberships: string[];
let membershipError: boolean;
let membershipQueries: Array<Map<string, unknown>>;
let adminFilters: Array<Map<string, unknown>>;

function request(
  method: "GET" | "PATCH" | "POST",
  body?: unknown,
  bearer = false
) {
  const url =
    method === "GET"
      ? `http://localhost/api/airi/savings?workspaceId=${workspaceId}`
      : `http://localhost/api/airi/${method === "POST" ? "adopt" : "savings"}`;
  return new NextRequest(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: "Bearer session-token" } : {}),
    },
    ...(method !== "GET" ? { body: JSON.stringify(body) } : {}),
  });
}

function expectNoPrivilegedAccess() {
  expect(mockAdminFrom).not.toHaveBeenCalled();
  expect(mockSavingsUpdate).not.toHaveBeenCalled();
  expect(mockSavingsInsert).not.toHaveBeenCalled();
  expect(mockConnectDB).not.toHaveBeenCalled();
  expect(mockTipFind).not.toHaveBeenCalled();
  expect(mockTipUpdate).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  memberships = ["00000000-0000-4000-8000-000000000001", workspaceId];
  membershipError = false;
  membershipQueries = [];
  adminFilters = [];
  mockGetUser.mockResolvedValue({
    data: { user: { id: userId } },
    error: null,
  });
  mockMembershipRead.mockImplementation((filters: Map<string, unknown>) => ({
    data:
      !membershipError &&
      filters.get("user_id") === userId &&
      memberships.includes(String(filters.get("workspace_id")))
        ? { user_id: userId, role: "manager" }
        : null,
    error: membershipError ? { message: "Membership unavailable" } : null,
  }));
  const supabase = {
    auth: { getUser: mockGetUser },
    from: (table: string) => {
      expect(table).toBe("company_users");
      const filters = new Map<string, unknown>();
      membershipQueries.push(filters);
      const query = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: () => mockMembershipRead(filters),
      };
      query.eq.mockImplementation((field: string, value: unknown) => {
        filters.set(field, value);
        return query;
      });
      return query;
    },
  };
  mockCookieClient.mockResolvedValue(supabase);
  mockBearerClient.mockReturnValue(supabase);
  mockSavingsRead.mockResolvedValue({
    data: { workspace_id: workspaceId, applied_count: 2 },
    error: null,
  });
  mockSavingsInsert.mockResolvedValue({ error: null });
  mockAdminFrom.mockImplementation(() => {
    const filters = new Map<string, unknown>();
    adminFilters.push(filters);
    const query = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: () => mockSavingsRead(),
      update: jest.fn().mockReturnThis(),
      insert: (value: unknown) => mockSavingsInsert(value),
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ error: null }).then(resolve),
    };
    query.eq.mockImplementation((field: string, value: unknown) => {
      filters.set(field, value);
      return query;
    });
    query.update.mockImplementation((value: unknown) => {
      mockSavingsUpdate(value);
      return query;
    });
    return query;
  });
  mockConnectDB.mockResolvedValue(undefined);
  mockTipRead.mockResolvedValue({ workspaceId });
  mockTipFind.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    lean: () => mockTipRead(),
  });
  mockTipUpdate.mockResolvedValue({ _id: suggestionId, workspaceId });
});

describe("Airi savings and adoption workspace access", () => {
  it.each(["GET", "PATCH", "POST"] as const)(
    "%s rejects an anonymous caller before privileged reads or writes",
    async method => {
      mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
      const handler =
        method === "GET" ? GET : method === "PATCH" ? PATCH : POST;
      const response = await handler(
        request(method, { workspaceId, suggestionId })
      );
      expect(response.status).toBe(401);
      expectNoPrivilegedAccess();
      expect(mockMembershipRead).not.toHaveBeenCalled();
    }
  );

  it.each(["GET", "PATCH", "POST"] as const)(
    "%s rejects an invalid bearer token without falling back to cookies",
    async method => {
      mockGetUser.mockResolvedValue({
        data: { user: null },
        error: { message: "Invalid token" },
      });
      const handler =
        method === "GET" ? GET : method === "PATCH" ? PATCH : POST;
      const response = await handler(
        request(method, { workspaceId, suggestionId }, true)
      );
      expect(response.status).toBe(401);
      expect(mockGetUser).toHaveBeenCalledWith("session-token");
      expect(mockCookieClient).not.toHaveBeenCalled();
      expectNoPrivilegedAccess();
    }
  );

  it.each(["GET", "PATCH", "POST"] as const)(
    "%s rejects a foreign workspace even for a platform admin",
    async method => {
      mockGetUser.mockResolvedValue({
        data: {
          user: { id: userId, app_metadata: { platform_role: "admin" } },
        },
        error: null,
      });
      const handler =
        method === "GET" ? GET : method === "PATCH" ? PATCH : POST;
      const req =
        method === "GET"
          ? new NextRequest(
              `http://localhost/api/airi/savings?workspaceId=${foreignWorkspaceId}`
            )
          : request(method, { workspaceId: foreignWorkspaceId, suggestionId });
      const response = await handler(req);
      expect(response.status).toBe(403);
      expect(membershipQueries[0]).toEqual(
        new Map([
          ["user_id", userId],
          ["workspace_id", foreignWorkspaceId],
        ])
      );
      expectNoPrivilegedAccess();
    }
  );

  it.each(["GET", "PATCH", "POST"] as const)(
    "%s fails closed when the exact membership query fails",
    async method => {
      membershipError = true;
      const handler =
        method === "GET" ? GET : method === "PATCH" ? PATCH : POST;
      const response = await handler(
        request(method, { workspaceId, suggestionId })
      );
      expect(response.status).toBe(403);
      expectNoPrivilegedAccess();
    }
  );

  it.each([false, true])(
    "GET allows an explicit second membership (bearer=%s)",
    async bearer => {
      const response = await GET(request("GET", undefined, bearer));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        workspace_id: workspaceId,
        applied_count: 2,
      });
      expect(membershipQueries[0]).toEqual(
        new Map([
          ["user_id", userId],
          ["workspace_id", workspaceId],
        ])
      );
      expect(adminFilters[0].get("workspace_id")).toBe(workspaceId);
      expect(mockAdminFrom.mock.invocationCallOrder[0]).toBeGreaterThan(
        mockMembershipRead.mock.invocationCallOrder[0]
      );
    }
  );

  it("GET preserves the empty savings payload for an authorized workspace", async () => {
    mockSavingsRead.mockResolvedValue({ data: null, error: null });
    const response = await GET(request("GET"));
    expect(await response.json()).toEqual({
      workspace_id: workspaceId,
      applied_count: 0,
      refund_avoid_count: 0,
      avg_refund_value: 0,
      minutes_saved_per_case: 0,
    });
  });

  it.each(["", "?workspaceId=", "?workspaceId=%20%20"])(
    "GET rejects a missing or blank workspace before privileged access: %s",
    async query => {
      const response = await GET(
        new NextRequest(`http://localhost/api/airi/savings${query}`)
      );
      expect(response.status).toBe(400);
      expectNoPrivilegedAccess();
    }
  );

  it.each(["PATCH", "POST"] as const)(
    "%s rejects malformed JSON",
    async method => {
      const handler = method === "PATCH" ? PATCH : POST;
      const response = await handler(
        new NextRequest("http://localhost/api/airi/test", {
          method,
          headers: { "content-type": "application/json" },
          body: "{",
        })
      );
      expect(response.status).toBe(400);
      expectNoPrivilegedAccess();
    }
  );

  it.each([
    ["PATCH", null],
    ["PATCH", []],
    ["PATCH", 42],
    ["PATCH", "invalid"],
    ["POST", null],
    ["POST", []],
    ["POST", 42],
    ["POST", "invalid"],
  ] as const)("%s rejects a non-object JSON body: %j", async (method, body) => {
    const handler = method === "PATCH" ? PATCH : POST;
    const response = await handler(request(method, body));
    expect(response.status).toBe(400);
    expectNoPrivilegedAccess();
  });

  it.each([undefined, null, 42, [], {}, "", "  "])(
    "PATCH rejects a malformed workspace: %j",
    async value => {
      const response = await PATCH(request("PATCH", { workspaceId: value }));
      expect(response.status).toBe(400);
      expectNoPrivilegedAccess();
    }
  );

  it("PATCH preserves member updates in the exact selected workspace", async () => {
    const values = {
      refund_avoid_count: 3,
      avg_refund_value: 50,
      minutes_saved_per_case: 5,
    };
    const response = await PATCH(
      request("PATCH", { workspaceId, ...values, applied_count: 999 })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mockSavingsUpdate).toHaveBeenCalledWith(values);
    expect(mockSavingsInsert).not.toHaveBeenCalled();
    expect(
      adminFilters.every(filters => filters.get("workspace_id") === workspaceId)
    ).toBe(true);
    expect(mockAdminFrom.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockMembershipRead.mock.invocationCallOrder[0]
    );
  });

  it("PATCH allows a verified bearer member to initialize savings", async () => {
    mockSavingsRead.mockResolvedValue({ data: null, error: null });
    const values = {
      refund_avoid_count: 1,
      avg_refund_value: 25,
      minutes_saved_per_case: 4,
    };
    const response = await PATCH(
      request("PATCH", { workspaceId, ...values }, true)
    );
    expect(response.status).toBe(200);
    expect(mockSavingsInsert).toHaveBeenCalledWith({
      workspace_id: workspaceId,
      ...values,
      applied_count: 0,
    });
    expect(mockSavingsUpdate).not.toHaveBeenCalled();
    expect(mockCookieClient).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "POST adopts a tip in the exact selected workspace (bearer=%s)",
    async bearer => {
      const response = await POST(
        request("POST", { workspaceId, suggestionId }, bearer)
      );
      expect(response.status).toBe(200);
      expect(mockTipUpdate).toHaveBeenCalledWith(
        { _id: suggestionId, workspaceId },
        { adopted: true, adoptedAt: expect.any(Date) }
      );
      expect(mockTipUpdate.mock.invocationCallOrder[0]).toBeGreaterThan(
        mockTipRead.mock.invocationCallOrder[0]
      );
      expect(mockSavingsUpdate).toHaveBeenCalledWith({ applied_count: 3 });
      expect(
        adminFilters.every(
          filters => filters.get("workspace_id") === workspaceId
        )
      ).toBe(true);
    }
  );

  it("POST initializes savings only after a tip in that workspace is adopted", async () => {
    mockSavingsRead.mockResolvedValue({ data: null, error: null });
    const response = await POST(request("POST", { workspaceId, suggestionId }));
    expect(response.status).toBe(200);
    expect(mockSavingsInsert).toHaveBeenCalledWith({
      workspace_id: workspaceId,
      applied_count: 1,
    });
    expect(mockAdminFrom.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockTipUpdate.mock.invocationCallOrder[0]
    );
  });

  it("POST rejects a foreign tip even when the selected workspace is authorized", async () => {
    mockTipRead.mockResolvedValue({ workspaceId: foreignWorkspaceId });
    const response = await POST(request("POST", { workspaceId, suggestionId }));
    expect(response.status).toBe(403);
    expect(mockTipUpdate).not.toHaveBeenCalled();
    expect(mockAdminFrom).not.toHaveBeenCalled();
  });

  it.each([null, {}, { workspaceId: "" }])(
    "POST rejects a missing or unscoped tip: %j",
    async tip => {
      mockTipRead.mockResolvedValue(tip);
      const response = await POST(
        request("POST", { workspaceId, suggestionId })
      );
      expect(response.status).toBe(404);
      expect(mockTipUpdate).not.toHaveBeenCalled();
      expect(mockAdminFrom).not.toHaveBeenCalled();
    }
  );

  it("POST does not increment savings if the workspace-scoped tip mutation no longer matches", async () => {
    mockTipUpdate.mockResolvedValue(null);
    const response = await POST(request("POST", { workspaceId, suggestionId }));
    expect(response.status).toBe(404);
    expect(mockAdminFrom).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 42, [], {}, "", "  "])(
    "POST rejects a malformed workspace: %j",
    async value => {
      const response = await POST(
        request("POST", { workspaceId: value, suggestionId })
      );
      expect(response.status).toBe(400);
      expectNoPrivilegedAccess();
    }
  );

  it.each(["not-an-id", "coach-123", 42, {}])(
    "POST rejects a malformed tip ID: %j",
    async id => {
      const response = await POST(
        request("POST", { workspaceId, suggestionId: id })
      );
      expect(response.status).toBe(404);
      expectNoPrivilegedAccess();
    }
  );
});
