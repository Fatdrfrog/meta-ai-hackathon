const mockCaptureFunnelEvent = jest.fn();

jest.mock("@/lib/funnel-analytics", () => ({
  captureFunnelEvent: (...args: unknown[]) => mockCaptureFunnelEvent(...args),
}));

import { ScenarioOperationError } from "./scenario-operation-error";
import {
  captureScenarioActivated,
  describeScenarioGraphForFunnel,
  readScenarioActivationBlockedCode,
} from "./scenario-funnel";

describe("scenario funnel", () => {
  beforeEach(() => {
    mockCaptureFunnelEvent.mockReset();
  });

  it("describes the graph without reading node content", () => {
    expect(
      describeScenarioGraphForFunnel([
        { type: "triggerNode" },
        { type: "bulkNode" },
        null,
      ])
    ).toEqual({ has_bulk_root: true, node_count: 3 });
    expect(describeScenarioGraphForFunnel(undefined)).toEqual({
      has_bulk_root: false,
      node_count: 0,
    });
  });

  it("reads the validation code of a refused activation", () => {
    const error = new ScenarioOperationError({
      kind: "graph_invalid",
      code: "whatsappServiceMessageInvalid",
    });
    expect(readScenarioActivationBlockedCode(error, { status: "active" })).toBe(
      "whatsappServiceMessageInvalid"
    );
  });

  it("ignores draft saves, editor races and unexpected errors", () => {
    const invalid = new ScenarioOperationError({
      kind: "graph_invalid",
      code: "whatsappServiceMessageInvalid",
    });
    expect(
      readScenarioActivationBlockedCode(invalid, { status: "draft" })
    ).toBe(null);
    expect(
      readScenarioActivationBlockedCode(
        new ScenarioOperationError({
          kind: "revision_conflict",
          currentUpdatedAt: null,
          operation: "save",
        }),
        { status: "active" }
      )
    ).toBeNull();
    expect(
      readScenarioActivationBlockedCode(new Error("boom"), { status: "active" })
    ).toBeNull();
  });

  it("captures an activation with the graph shape", async () => {
    await captureScenarioActivated({
      userId: "user-1",
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      nodes: [{ type: "bulkNode" }],
    });
    expect(mockCaptureFunnelEvent).toHaveBeenCalledWith({
      event: "scenario_activated",
      userId: "user-1",
      workspaceId: "workspace-1",
      properties: {
        scenario_id: "scenario-1",
        has_bulk_root: true,
        node_count: 1,
      },
    });
  });
});
