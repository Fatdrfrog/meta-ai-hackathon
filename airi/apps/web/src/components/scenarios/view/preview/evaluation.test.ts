import {
  buildScenarioPreviewEvaluationPayload,
  buildScenarioPreviewLogicSignature,
  normalizeScenarioPreviewInternalLabels,
  normalizeScenarioPreviewLogicDraft,
  resolveScenarioPreviewChannel,
  resolveScenarioPreviewChannelOptions,
  resolveScenarioPreviewEventKinds,
} from "./evaluation";

describe("scenario preview evaluation helpers", () => {
  it("keeps default preview channels while deduplicating configured ones", () => {
    expect(
      resolveScenarioPreviewChannelOptions(["telegram", "email", "telegram"])
    ).toEqual(["telegram", "email", "whatsapp"]);
  });

  it("offers only inbound and interactive customer-message events", () => {
    expect(resolveScenarioPreviewEventKinds()).toEqual([
      "inbound_message",
      "telegram_quick_reply",
      "instagram_quick_reply",
      "whatsapp_button_reply",
      "whatsapp_flow_reply",
    ]);
  });

  it("keeps the current channel when it is still valid", () => {
    expect(
      resolveScenarioPreviewChannel("telegram", ["whatsapp", "telegram"])
    ).toBe("telegram");
  });

  it("falls back to the first valid preview channel when current is invalid", () => {
    expect(resolveScenarioPreviewChannel("instagram", ["email"])).toBe("email");
    expect(resolveScenarioPreviewChannel("", [])).toBe("whatsapp");
  });

  it("normalizes comma and newline separated labels", () => {
    expect(
      normalizeScenarioPreviewInternalLabels(" vip, hot \n vip \ntrial ")
    ).toEqual(["vip", "hot", "trial"]);
  });

  it("builds a normalized preview request payload", () => {
    expect(
      buildScenarioPreviewEvaluationPayload({
        workspaceId: "workspace-1",
        channel: "whatsapp",
        eventKind: "inbound_message",
        messageText: "",
        classificationCategory: "",
        internalLabels: "vip,\ntrial",
        funnelStage: "",
        isNewCustomer: true,
        hasPurchaseHistory: false,
        quickReplyPayload: "",
        whatsAppFlowResponseJson: "",
        draftScenario: null,
      })
    ).toEqual({
      workspaceId: "workspace-1",
      channel: "whatsapp",
      eventKind: "inbound_message",
      messageText: undefined,
      classificationCategory: null,
      internalLabels: ["vip", "trial"],
      funnelStage: null,
      isNewCustomer: true,
      hasPurchaseHistory: false,
      quickReplyPayload: null,
      whatsAppFlowResponseJson: null,
      draftScenario: null,
    });
  });

  it("builds a logic-only preview draft that ignores visual editor noise", () => {
    const normalizedDraft = normalizeScenarioPreviewLogicDraft({
      scenarioId: "scenario-1",
      name: "Example",
      status: "draft",
      priority: 1,
      matchingRole: "default",
      entryPolicy: "repeatable",
      nodes: [
        {
          id: "node-1",
          type: "default",
          position: { x: 120, y: 40 },
          selected: true,
          dragging: true,
          data: {
            kind: "trigger",
            uiNodeLabel: "Visual only",
            uiOnRemove: () => undefined,
            actionPreviewText: "Rendered preview",
            compiledNodes: [],
            triggerConfig: { enabled: true },
          },
        } as never,
      ],
      edges: [
        {
          id: "edge-1",
          source: "node-1",
          target: "node-2",
          selected: true,
          sourceHandle: "a",
          targetHandle: "b",
        } as never,
      ],
    });

    expect(normalizedDraft).toEqual({
      scenarioId: "scenario-1",
      name: "Example",
      status: "draft",
      priority: 1,
      matchingRole: "default",
      entryPolicy: "repeatable",
      nodes: [
        {
          id: "node-1",
          type: "default",
          data: {
            kind: "trigger",
            triggerConfig: { enabled: true },
          },
        },
      ],
      edges: [
        {
          id: "edge-1",
          source: "node-1",
          target: "node-2",
          sourceHandle: "a",
          targetHandle: "b",
        },
      ],
    });
  });

  it("keeps the same logic signature across position-only changes", () => {
    const baseDraft = {
      scenarioId: "scenario-1",
      name: "Example",
      status: "draft" as const,
      priority: 1,
      matchingRole: "default" as const,
      entryPolicy: "repeatable" as const,
      nodes: [
        {
          id: "node-1",
          type: "default",
          position: { x: 120, y: 40 },
          data: { kind: "trigger", triggerConfig: { enabled: true } },
        } as never,
      ],
      edges: [],
    };

    expect(buildScenarioPreviewLogicSignature(baseDraft)).toBe(
      buildScenarioPreviewLogicSignature({
        ...baseDraft,
        nodes: [
          {
            ...(baseDraft.nodes[0] as Record<string, unknown>),
            position: { x: 420, y: 220 },
            selected: true,
          } as never,
        ],
      })
    );
  });
});
