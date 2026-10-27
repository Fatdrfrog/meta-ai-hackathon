const mockConnectDB = jest.fn();
const mockFlowEventFindOne = jest.fn();
const mockFlowEventUpdateOne = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/models/scenario-flow-event", () => ({
  ScenarioFlowEvent: {
    findOne: (...args: unknown[]) => mockFlowEventFindOne(...args),
    updateOne: (...args: unknown[]) => mockFlowEventUpdateOne(...args),
  },
}));

import {
  trackScenarioFlowReadByMessageId,
  trackScenarioFlowSent,
  trackScenarioFlowSubmitted,
} from "@/lib/scenarios/scenario-flow-analytics";

function createFindOneQuery<T>(value: T) {
  return {
    sort: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(value),
  };
}

describe("scenario flow analytics", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockFlowEventUpdateOne.mockResolvedValue({ acknowledged: true });
    mockFlowEventFindOne.mockReturnValue(createFindOneQuery(null));
  });

  it("stores evaluationId on sent flow events", async () => {
    await trackScenarioFlowSent({
      workspaceId: "workspace-1",
      conversationId: "conv-1",
      evaluationId: "eval-1",
      flowId: "lead_form",
      outboundMessageId: "msg-1",
    });

    expect(mockFlowEventUpdateOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          evaluationId: "eval-1",
        }),
      }),
      expect.anything()
    );
  });

  it("propagates evaluationId from sent to read events", async () => {
    mockFlowEventFindOne.mockReturnValue(
      createFindOneQuery({
        workspaceId: "workspace-1",
        conversationId: "conv-1",
        evaluationId: "eval-2",
        flowId: "lead_form",
        outboundMessageId: "ws_msg-1",
        eventType: "sent",
      })
    );

    await trackScenarioFlowReadByMessageId({
      workspaceId: "workspace-1",
      outboundMessageId: "msg-1",
    });

    expect(mockFlowEventUpdateOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          evaluationId: "eval-2",
          eventType: "read",
        }),
      }),
      expect.anything()
    );
  });

  it("propagates evaluationId from sent to submitted events", async () => {
    mockFlowEventFindOne.mockReturnValue(
      createFindOneQuery({
        workspaceId: "workspace-1",
        conversationId: "conv-1",
        evaluationId: "eval-3",
        flowId: "lead_form",
        flowToken: "flow-token-1",
        outboundMessageId: "ws_msg-1",
        eventType: "sent",
      })
    );

    await trackScenarioFlowSubmitted({
      workspaceId: "workspace-1",
      conversationId: "conv-1",
      flowToken: "flow-token-1",
      responseJson: '{"field":"value"}',
    });

    expect(mockFlowEventUpdateOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          evaluationId: "eval-3",
          eventType: "submitted",
        }),
      }),
      expect.anything()
    );
  });

  it("keeps separate submissions for repeated sends sharing one conversation and token", async () => {
    for (const outboundMessageId of ["ws_first-send", "ws_second-send"]) {
      mockFlowEventFindOne.mockReturnValue(
        createFindOneQuery({ flowId: "lead_form", outboundMessageId })
      );
      await trackScenarioFlowSubmitted({
        workspaceId: "workspace-1",
        conversationId: "conv-1",
        flowToken: "reused-token",
      });
    }
    expect(mockFlowEventUpdateOne.mock.calls.map(([filter]) => filter)).toEqual(
      [
        {
          workspaceId: "workspace-1",
          conversationId: "conv-1",
          outboundMessageId: "ws_first-send",
          eventType: "submitted",
        },
        {
          workspaceId: "workspace-1",
          conversationId: "conv-1",
          outboundMessageId: "ws_second-send",
          eventType: "submitted",
        },
      ]
    );
  });

  it("bounds token fallback to sends before the provider submission timestamp", async () => {
    const query = createFindOneQuery(null);
    mockFlowEventFindOne.mockReturnValue(query);
    const eventAt = new Date("2026-10-02T00:00:00Z");
    await trackScenarioFlowSubmitted({
      workspaceId: "workspace-1",
      conversationId: "conv-1",
      flowToken: "unbound-token",
      flowIdHint: "lead_form",
      eventAt,
    });
    expect(mockFlowEventFindOne).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      conversationId: "conv-1",
      flowToken: "unbound-token",
      eventType: "sent",
      eventAt: { $lte: eventAt },
    });
    expect(query.sort).toHaveBeenCalledWith({ eventAt: -1, _id: -1 });
    expect(mockFlowEventUpdateOne).toHaveBeenCalledWith(
      {
        workspaceId: "workspace-1",
        conversationId: "conv-1",
        flowId: "lead_form",
        flowToken: "unbound-token",
        outboundMessageId: null,
        eventType: "submitted",
      },
      expect.anything(),
      { upsert: true }
    );
  });

  it("uses provider context binding even when send and submission clocks differ within one second", async () => {
    mockFlowEventFindOne.mockReturnValue(
      createFindOneQuery({
        flowId: "lead_form",
        outboundMessageId: "ws_wamid.first-send",
      })
    );
    await trackScenarioFlowSubmitted({
      workspaceId: "workspace-1",
      conversationId: "conv-1",
      flowToken: "reused-token",
      outboundMessageId: "wamid.first-send",
      eventAt: new Date("2026-10-02T00:00:00Z"),
    });
    expect(mockFlowEventFindOne).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      conversationId: "conv-1",
      outboundMessageId: "ws_wamid.first-send",
      eventType: "sent",
    });
    expect(mockFlowEventUpdateOne.mock.calls[0][0]).toMatchObject({
      outboundMessageId: "ws_wamid.first-send",
    });
  });
});
