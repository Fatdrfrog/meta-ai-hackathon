const mockRequireScenarioWorkspaceAccess = jest.fn();
const mockRetryTimerReplanIngressForScenario = jest.fn();

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));

jest.mock("@/lib/airi/scenario/timer-recovery/ingress", () => ({
  retryTimerReplanIngressForScenario: (...args: unknown[]) =>
    mockRetryTimerReplanIngressForScenario(...args),
}));

import { POST } from "./route";

const scenarioId = "65f000000000000000000001";

describe("POST /api/scenarios/[scenarioId]/timer-replan-recovery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      userId: "user-1",
    });
    mockRetryTimerReplanIngressForScenario.mockResolvedValue({
      reopened: 1,
      processed: {
        claimed: 1,
        signaled: 1,
        superseded: 0,
        retryScheduled: 0,
        failed: 0,
        leaseLost: 0,
      },
      outstanding: {
        status: null,
        affectedConversationIds: [],
        hasMore: false,
      },
    });
  });

  it("requires workspace access before retrying recovery", async () => {
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "Forbidden" }, { status: 403 }),
    });

    const response = await POST(
      new Request(
        `http://localhost/api/scenarios/${scenarioId}/timer-replan-recovery`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId: "workspace-1" }),
        }
      ),
      { params: Promise.resolve({ scenarioId }) }
    );

    expect(response.status).toBe(403);
    expect(mockRetryTimerReplanIngressForScenario).not.toHaveBeenCalled();
  });

  it("runs only the bounded scenario recovery processor", async () => {
    const response = await POST(
      new Request(
        `http://localhost/api/scenarios/${scenarioId}/timer-replan-recovery`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId: "workspace-1" }),
        }
      ),
      { params: Promise.resolve({ scenarioId }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      reopened: 1,
      processed: { claimed: 1, signaled: 1 },
      outstanding: { status: null },
    });
    expect(mockRetryTimerReplanIngressForScenario).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      scenarioId,
      limit: 25,
    });
  });
});
