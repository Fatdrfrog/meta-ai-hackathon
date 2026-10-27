const mockCreateClient = jest.fn();
const mockVerifyWorkspaceAccess = jest.fn();
const mockGetWorkspaceFeatureFlags = jest.fn();
const mockMoveCustomerToCrmStage = jest.fn();

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

jest.mock("@/lib/crm/board", () => ({
  moveCustomerToCrmStage: (...args: unknown[]) =>
    mockMoveCustomerToCrmStage(...args),
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

describe("CRM customer stage API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockGetWorkspaceFeatureFlags.mockResolvedValue({
      customer_identity: true,
    });
    mockMoveCustomerToCrmStage.mockResolvedValue({
      customer: {
        id: "customer-1",
        stageKey: "qualified",
      },
    });
  });

  it("rejects unauthorized requests", async () => {
    mockSupabase(null);

    const response = await PATCH(request({ stageKey: "qualified" }), params);

    expect(response.status).toBe(401);
    expect(mockMoveCustomerToCrmStage).not.toHaveBeenCalled();
  });

  it("returns 409 when the card changed stages since load", async () => {
    mockSupabase();
    mockMoveCustomerToCrmStage.mockRejectedValue(
      Object.assign(new Error("Stage changed"), {
        code: "CRM_STAGE_CONFLICT",
        currentStageKey: "proposal",
      })
    );

    const response = await PATCH(
      request({ stageKey: "won", expectedStageKey: "qualified" }),
      params
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Stage changed",
      currentStageKey: "proposal",
    });
  });

  it("moves a customer to a new stage as the current manager", async () => {
    mockSupabase();

    const response = await PATCH(
      request({ stageKey: "qualified", expectedStageKey: null }),
      params
    );

    expect(response.status).toBe(200);
    expect(mockMoveCustomerToCrmStage).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        customerId: "customer-1",
        stageKey: "qualified",
        expectedStageKey: null,
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
        stageKey: "qualified",
      },
    });
  });
});
