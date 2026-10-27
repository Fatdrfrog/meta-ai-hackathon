import { POST } from "./route";
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
const mockAccess = jest.fn();
jest.mock("@/lib/supabase/workspace-api-access", () => ({
  requireWorkspaceApiAccess: (...args: unknown[]) => mockAccess(...args),
}));
const mockSimulate = jest.fn();
jest.mock("@/lib/scenarios/scenario-simulation-service", () => ({
  simulateScenarioStep: (...args: unknown[]) => mockSimulate(...args),
}));
const request = (body: unknown) =>
  new Request("http://localhost/api/scenarios/simulate", {
    method: "POST",
    body: JSON.stringify(body),
  });
const payload = {
  workspaceId: "workspace",
  event: { kind: "start" },
  draftScenario: {
    nodes: [{ id: "entry", data: { kind: "trigger" } }],
    edges: [],
  },
};
beforeEach(() => {
  jest.clearAllMocks();
  mockAccess.mockResolvedValue({ ok: true });
  mockSimulate.mockResolvedValue({ state: { status: "waiting" } });
});
it("checks workspace access before evaluating a submitted graph", async () => {
  mockAccess.mockResolvedValue({
    ok: false,
    response: new Response("Denied", { status: 403 }),
  });
  expect((await POST(request(payload))).status).toBe(403);
  expect(mockSimulate).not.toHaveBeenCalled();
});
it("rejects malformed events and graph payloads without running them", async () => {
  expect(
    (
      await POST(
        request({ ...payload, event: { kind: "advance", minutes: -2 } })
      )
    ).status
  ).toBe(400);
  expect(
    (
      await POST(
        request({ ...payload, draftScenario: { nodes: "bad", edges: [] } })
      )
    ).status
  ).toBe(400);
  expect(
    (
      await POST(
        request({
          ...payload,
          draftScenario: {
            nodes: [
              { id: "entry", data: { kind: "trigger" } },
              { id: "entry", data: { kind: "action" } },
            ],
            edges: [],
          },
        })
      )
    ).status
  ).toBe(400);
  expect(mockSimulate).not.toHaveBeenCalled();
});
it("requires continuation state for events after starting", async () => {
  expect(
    (
      await POST(
        request({ ...payload, event: { kind: "message", text: "Hi" } })
      )
    ).status
  ).toBe(400);
  expect(mockSimulate).not.toHaveBeenCalled();
});
it("evaluates an authorized draft using synthetic state", async () => {
  const response = await POST(request(payload));
  expect(response.status).toBe(200);
  expect(mockSimulate).toHaveBeenCalledWith(
    expect.objectContaining({
      event: { kind: "start" },
      graph: expect.objectContaining({ edges: [] }),
    })
  );
});
