const mockCreateClient = jest.fn();
const mockVerifyWorkspaceAccess = jest.fn();
const mockGetWorkspaceFeatureFlags = jest.fn();
const mockAssignCustomerOwner = jest.fn();
const mockGetMembership = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/supabase/queries", () => ({
  checkUserWorkspaceAccess: (...args: unknown[]) =>
    mockVerifyWorkspaceAccess(...args),
}));

jest.mock("@/lib/workspace-feature-flags", () => ({
  getWorkspaceFeatureFlags: (...args: unknown[]) =>
    mockGetWorkspaceFeatureFlags(...args),
}));

jest.mock("@/lib/supabase/company-users", () => ({
  getCompanyUserMembershipByUserWorkspace: (...args: unknown[]) =>
    mockGetMembership(...args),
}));

jest.mock("@/lib/crm/board", () => ({
  assignCustomerOwner: (...args: unknown[]) =>
    mockAssignCustomerOwner(...args),
}));

import { PATCH } from "./route";
import type { NextRequest } from "next/server";
import { mockSupabaseUser } from "@/test-support/supabase-auth-test-utils";

const params = {
  params: Promise.resolve({
    workspaceId: "workspace-1",
    customerId: "customer-1",
  }),
};

function mockSupabase(user?: { id: string } | null) {
  return mockSupabaseUser(mockCreateClient, user, { withSession: true });
}

function request(body: unknown) {
  return new Request("http://localhost/api", {
    method: "PATCH",
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe("CRM customer owner API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockGetWorkspaceFeatureFlags.mockResolvedValue({
      customer_identity: true,
    });
    mockAssignCustomerOwner.mockResolvedValue({
      customer: {
        id: "customer-1",
        ownerUserId: "user-1",
      },
    });
    mockGetMembership.mockResolvedValue({
      data: { id: "membership-1" },
      error: null,
    });
  });

  it("rejects unauthorized requests", async () => {
    mockSupabase(null);

    const response = await PATCH(request({ ownerUserId: "user-1" }), params);

    expect(response.status).toBe(401);
    expect(mockAssignCustomerOwner).not.toHaveBeenCalled();
  });

  it("assigns the current manager as owner", async () => {
    mockSupabase();

    const response = await PATCH(request({ ownerUserId: "user-1" }), params);

    expect(response.status).toBe(200);
    expect(mockAssignCustomerOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        customerId: "customer-1",
        ownerUserId: "user-1",
        actor: {
          type: "manager",
          userId: "user-1",
          label: "crm_board",
        },
      })
    );
    expect(await response.json()).toEqual({
      customer: {
        id: "customer-1",
        ownerUserId: "user-1",
      },
    });
  });

  it("rejects owners who are not workspace members", async () => {
    mockSupabase();
    mockGetMembership.mockResolvedValue({ data: null, error: null });

    const response = await PATCH(request({ ownerUserId: "user-2" }), params);

    expect(response.status).toBe(400);
    expect(mockAssignCustomerOwner).not.toHaveBeenCalled();
  });

  it("returns 500 when membership lookup fails", async () => {
    mockSupabase();
    mockGetMembership.mockResolvedValue({
      data: null,
      error: { message: "rls failed" },
    });

    const response = await PATCH(request({ ownerUserId: "user-2" }), params);

    expect(response.status).toBe(500);
    expect(mockAssignCustomerOwner).not.toHaveBeenCalled();
  });

  it("unassigns owner when ownerUserId is null", async () => {
    mockSupabase();
    mockAssignCustomerOwner.mockResolvedValue({
      customer: {
        id: "customer-1",
        ownerUserId: null,
      },
    });

    const response = await PATCH(request({ ownerUserId: null }), params);

    expect(response.status).toBe(200);
    expect(mockAssignCustomerOwner).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: null })
    );
  });
});
