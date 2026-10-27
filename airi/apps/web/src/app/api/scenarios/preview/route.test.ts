const mockConnectDB = jest.fn();
const mockRequireScenarioWorkspaceAccess = jest.fn();
const mockScenarioFind = jest.fn();
const mockPreviewScenarioEvaluation = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));

jest.mock("@/models/scenario", () => ({
  Scenario: {
    find: (...args: unknown[]) => mockScenarioFind(...args),
  },
}));

jest.mock("@/lib/airi/scenario/scenario-runtime", () => ({
  previewScenarioEvaluation: (...args: unknown[]) =>
    mockPreviewScenarioEvaluation(...args),
}));

import { POST } from "./route";

function createRequest(eventKind?: unknown, draftScenario?: unknown) {
  return new Request("http://localhost/api/scenarios/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "workspace-1",
      channel: "whatsapp",
      ...(eventKind === undefined ? {} : { eventKind }),
      ...(draftScenario === undefined ? {} : { draftScenario }),
      messageText: "Hello",
    }),
  });
}

describe("POST /api/scenarios/preview", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({ ok: true });
    mockScenarioFind.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    });
    mockPreviewScenarioEvaluation.mockImplementation(
      ({ eventKind }: { eventKind: string }) => ({
        eventKind,
        evaluations: [],
        winner: null,
      })
    );
  });

  it.each([
    "payment_detected",
    "no_human_reply_timeout",
    "business_hours_window",
    "unknown_event",
  ])("rejects the retired or unknown %s preview event", async eventKind => {
    const response = await POST(createRequest(eventKind));

    expect(response.status).toBe(400);
    expect(mockPreviewScenarioEvaluation).not.toHaveBeenCalled();
  });

  it.each([null, 42, false, { kind: "inbound_message" }])(
    "rejects the malformed explicit preview event %p",
    async eventKind => {
      const response = await POST(createRequest(eventKind));

      expect(response.status).toBe(400);
      expect(mockPreviewScenarioEvaluation).not.toHaveBeenCalled();
    }
  );

  it("defaults an omitted preview event to an inbound message", async () => {
    const response = await POST(createRequest());

    expect(response.status).toBe(200);
    expect(mockPreviewScenarioEvaluation).toHaveBeenCalledWith(
      expect.objectContaining({ eventKind: "inbound_message" })
    );
  });

  it.each([
    7,
    "invalid",
    false,
    0,
    "",
    { nodes: [null], edges: [] },
    { nodes: [{ id: "action", data: null }], edges: [] },
    { nodes: [], edges: [{ source: "action", target: 42 }] },
    { nodes: null, edges: [] },
    { nodes: [], edges: "invalid" },
  ])(
    "rejects malformed draft graph %j before evaluation",
    async draftScenario => {
      const response = await POST(createRequest(undefined, draftScenario));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Invalid scenario graph payload",
        code: "scenario_graph_invalid",
      });
      expect(mockPreviewScenarioEvaluation).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, null])(
    "accepts optional draft value %p",
    async draftScenario => {
      const response = await POST(createRequest(undefined, draftScenario));

      expect(response.status).toBe(200);
      expect(mockPreviewScenarioEvaluation).toHaveBeenCalledWith(
        expect.objectContaining({ scenarios: [] })
      );
    }
  );

  it("defaults a draft to once per conversation and ignores retired fields", async () => {
    const response = await POST(
      new Request("http://localhost/api/scenarios/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "workspace-1",
          channel: "whatsapp",
          draftScenario: {
            name: "Draft",
            status: "draft",
            priority: 0,
            loopScenario: true,
            journeyPoolKey: "retired",
            nodes: [],
            edges: [],
          },
        }),
      })
    );

    expect(response.status).toBe(200);
    const scenarios = mockPreviewScenarioEvaluation.mock.calls[0]?.[0]
      ?.scenarios as Array<Record<string, unknown>>;
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0]).toEqual(
      expect.objectContaining({
        entryPolicy: "once_per_conversation",
        nodes: [],
        edges: [],
      })
    );
    expect(scenarios[0]).not.toHaveProperty("loopScenario");
    expect(scenarios[0]).not.toHaveProperty("journeyPoolKey");
  });

  it.each(["inbound_message", "whatsapp_button_reply"])(
    "accepts the customer-message %s preview event",
    async eventKind => {
      const response = await POST(createRequest(eventKind));

      expect(response.status).toBe(200);
      expect(mockPreviewScenarioEvaluation).toHaveBeenCalledWith(
        expect.objectContaining({ eventKind })
      );
    }
  );
});
