import AiriTurnContext, {
  AIRI_CONVERSATION_INGRESS_QUEUE_INDEX,
} from "./airi-turn-context";

describe("AiriTurnContext timer-replan indexes", () => {
  it("retains pending ingress without TTL expiry and declares its due-work index", () => {
    const pending = new AiriTurnContext({
      ingressKind: "conversation_turn",
      ingressStatus: "pending",
      expiresAt: null,
      enqueuedAt: new Date(),
    }).toObject();
    expect(pending.expiresAt).toBeNull();
    expect(pending.ingressKind).toBe("conversation_turn");
    expect(pending.enqueuedAt).toBeInstanceOf(Date);
    expect(AiriTurnContext.schema.indexes()).toContainEqual([
      AIRI_CONVERSATION_INGRESS_QUEUE_INDEX.keys,
      expect.objectContaining(AIRI_CONVERSATION_INGRESS_QUEUE_INDEX.options),
    ]);
  });
  it("does not materialize timer-replan metadata on ordinary turn contexts", () => {
    const ordinaryTurn = new AiriTurnContext({
      turnContextId: "turn-1",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
    }).toObject();

    expect(ordinaryTurn).not.toHaveProperty("timerReplanIngress");
  });

  it("keeps retry claims and scenario status lookups on bounded partial indexes", () => {
    const indexes = AiriTurnContext.schema.indexes();

    expect(indexes).toContainEqual([
      { ingressKey: 1 },
      expect.objectContaining({
        name: "airi_timer_replan_ingress_unique",
        unique: true,
        partialFilterExpression: {
          ingressKey: { $type: "string" },
        },
      }),
    ]);
    expect(indexes).toContainEqual([
      {
        ingressStatus: 1,
        ingressNextRetryAt: 1,
        ingressLeaseExpiresAt: 1,
        _id: 1,
      },
      expect.objectContaining({
        name: "airi_timer_replan_ingress_queue",
        partialFilterExpression: {
          triggerEventKind: "timer_replan",
          ingressStatus: "pending",
        },
      }),
    ]);
    expect(indexes).toContainEqual([
      {
        workspaceId: 1,
        "timerReplanIngress.expectedScenarioId": 1,
        ingressStatus: 1,
        updatedAt: -1,
        _id: 1,
      },
      expect.objectContaining({
        name: "airi_timer_replan_ingress_scenario_status",
        partialFilterExpression: {
          triggerEventKind: "timer_replan",
          "timerReplanIngress.expectedScenarioId": { $type: "string" },
        },
      }),
    ]);
  });
});
