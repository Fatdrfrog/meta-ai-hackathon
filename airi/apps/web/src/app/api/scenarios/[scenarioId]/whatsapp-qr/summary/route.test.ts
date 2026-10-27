const mockRequireScenarioWorkspaceAccess = jest.fn();
const mockListWhatsAppQrScenarioSummaries = jest.fn();

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));

jest.mock("@/lib/whatsapp/qr-entry-points/http", () => ({
  listWhatsAppQrScenarioSummaries: (...args: unknown[]) =>
    mockListWhatsAppQrScenarioSummaries(...args),
}));

import { GET } from "./route";

describe("GET /api/scenarios/[scenarioId]/whatsapp-qr/summary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      userId: "user-1",
    });
    mockListWhatsAppQrScenarioSummaries.mockResolvedValue({
      "node-1": {
        entryPointId: "entry-1",
        placementName: "Door",
        status: "ACTIVE",
        sourceId: "source-1",
        hasCurrentCode: true,
        version: 2,
      },
    });
  });

  it("returns the scenario summary map for authorized membership", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/scenarios/scenario-1/whatsapp-qr/summary?workspaceId=workspace-1"
      ),
      { params: Promise.resolve({ scenarioId: "scenario-1" }) }
    );

    expect(response.status).toBe(200);
    expect(mockRequireScenarioWorkspaceAccess).toHaveBeenCalledWith(
      "workspace-1"
    );
    expect(mockListWhatsAppQrScenarioSummaries).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
    });
    await expect(response.json()).resolves.toEqual({
      summaries: {
        "node-1": {
          entryPointId: "entry-1",
          placementName: "Door",
          status: "ACTIVE",
          sourceId: "source-1",
          hasCurrentCode: true,
          version: 2,
        },
      },
    });
  });

  it("rejects missing workspaceId before auth", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/scenarios/scenario-1/whatsapp-qr/summary"
      ),
      { params: Promise.resolve({ scenarioId: "scenario-1" }) }
    );

    expect(response.status).toBe(400);
    expect(mockRequireScenarioWorkspaceAccess).not.toHaveBeenCalled();
  });
});
