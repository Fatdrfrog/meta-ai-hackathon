const mockCreateClient = jest.fn();
const mockVerifyWorkspaceAccess = jest.fn();
const mockConnectDB = jest.fn();
const mockGetWorkspaceAiriReadiness = jest.fn();
const mockCountSuccessfulAiriChatAnswers = jest.fn();
jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/supabase/queries", () => ({
  checkUserWorkspaceAccess: (...args: unknown[]) =>
    mockVerifyWorkspaceAccess(...args),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/airi/readiness-score", () => ({
  getWorkspaceAiriReadiness: (...args: unknown[]) =>
    mockGetWorkspaceAiriReadiness(...args),
}));

jest.mock("@/lib/airi-chats/service", () => ({
  countSuccessfulAiriChatAnswers: (...args: unknown[]) =>
    mockCountSuccessfulAiriChatAnswers(...args),
}));

import { GET, POST } from "./route";

const params = Promise.resolve({ workspaceId: "workspace-1" });

function createSupabaseClient() {
  const authGetUser = jest.fn<
    Promise<{ data: { user: { id: string } | null } }>,
    []
  >(async () => ({
    data: { user: { id: "user-1" } },
  }));
  const sourcesEq = jest.fn(async () => ({
    data: [{ type: "telegram" }],
    error: null,
  }));
  const progressMaybeSingle = jest.fn(async () => ({
    data: {
      current_step_id: "connect_integration",
      completed_steps: ["company_profile"],
      status: "active",
      completed_at: null,
    },
    error: null,
  }));
  const progressEq = jest.fn(() => ({ maybeSingle: progressMaybeSingle }));
  const progressUpsert = jest.fn(async () => ({ error: null }));

  const from = jest.fn((table: string) => {
    if (table === "sources") {
      return {
        select: jest.fn(() => ({ eq: sourcesEq })),
      };
    }

    if (table === "workspace_onboarding_progress") {
      return {
        select: jest.fn(() => ({ eq: progressEq })),
        upsert: progressUpsert,
      };
    }

    throw new Error(`Unexpected table ${table}`);
  });

  return {
    auth: {
      getSession: async () => ({ data: { session: null } }),
      getUser: authGetUser,
    },
    from,
    progressUpsert,
  };
}

describe("/api/workspaces/[workspaceId]/onboarding", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockGetWorkspaceAiriReadiness.mockResolvedValue({
      metrics: {
        activeScenariosCount: 0,
        publishedKbArticlesCount: 0,
        verifiedSnippetsCount: 0,
      },
    });
    mockCountSuccessfulAiriChatAnswers.mockResolvedValue(1);
  });

  it("returns workspace onboarding state for authorized users without persisting (GET)", async () => {
    const supabase = createSupabaseClient();
    mockCreateClient.mockResolvedValue(supabase);

    const response = await GET(
      new Request("http://localhost/api/workspaces/workspace-1/onboarding"),
      { params }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      onboarding: {
        workspaceId: "workspace-1",
        currentStepId: "create_scenario",
        completedStepIds: [
          "company_profile",
          "test_airi",
          "connect_integration",
        ],
        metrics: {
          successfulTestAnswersCount: 1,
          activeScenariosCount: 0,
          publishedKbArticlesCount: 0,
          verifiedSnippetsCount: 0,
          connectedSourcesCount: 1,
        },
      },
    });
    expect(mockVerifyWorkspaceAccess).toHaveBeenCalledWith(
      supabase,
      "user-1",
      "workspace-1"
    );
    expect(mockConnectDB).toHaveBeenCalled();
    expect(mockCountSuccessfulAiriChatAnswers).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      userId: "user-1",
    });
    expect(supabase.progressUpsert).not.toHaveBeenCalled();
  });

  it("calculates and persists workspace onboarding state for authorized users (POST)", async () => {
    const supabase = createSupabaseClient();
    mockCreateClient.mockResolvedValue(supabase);

    const response = await POST(
      new Request("http://localhost/api/workspaces/workspace-1/onboarding", {
        method: "POST",
      }),
      { params }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      onboarding: {
        workspaceId: "workspace-1",
        currentStepId: "create_scenario",
        completedStepIds: [
          "company_profile",
          "test_airi",
          "connect_integration",
        ],
        metrics: {
          successfulTestAnswersCount: 1,
          activeScenariosCount: 0,
          publishedKbArticlesCount: 0,
          verifiedSnippetsCount: 0,
          connectedSourcesCount: 1,
        },
      },
    });
    expect(mockVerifyWorkspaceAccess).toHaveBeenCalledWith(
      supabase,
      "user-1",
      "workspace-1"
    );
    expect(mockConnectDB).toHaveBeenCalled();
    expect(supabase.progressUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: "workspace-1",
        current_step_id: "create_scenario",
        completed_steps: [
          "company_profile",
          "test_airi",
          "connect_integration",
        ],
        status: "active",
        completed_at: null,
      }),
      { onConflict: "workspace_id" }
    );
  });

  it("returns unauthorized before querying workspace data", async () => {
    const supabase = createSupabaseClient();
    supabase.auth.getUser.mockResolvedValueOnce({ data: { user: null } });
    mockCreateClient.mockResolvedValue(supabase);

    const response = await GET(
      new Request("http://localhost/api/workspaces/workspace-1/onboarding"),
      { params }
    );

    expect(response.status).toBe(401);
    expect(mockVerifyWorkspaceAccess).not.toHaveBeenCalled();
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockCountSuccessfulAiriChatAnswers).not.toHaveBeenCalled();
  });
});
