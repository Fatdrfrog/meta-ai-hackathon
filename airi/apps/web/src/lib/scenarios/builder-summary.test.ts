import type { ScenarioNodeData } from "@icecore/scenario-contracts";
import { resolveScenarioBuilderSummaryFromNodes } from "./builder-summary";

function node(id: string, data: ScenarioNodeData) {
  return { id, data };
}

describe("resolveScenarioBuilderSummaryFromNodes", () => {
  it("normalizes legacy trigger types in ordered trigger summaries", () => {
    const summary = resolveScenarioBuilderSummaryFromNodes([
      node("trigger-any", {
        kind: "trigger",
        triggerConfig: { enabled: true },
      } as ScenarioNodeData),
      node("trigger-exact", {
        kind: "trigger",
        triggerType: "exact_incoming_message",
        triggerConfig: {
          enabled: true,
          keywordPattern: "buy product",
        },
      } as unknown as ScenarioNodeData),
      node("action-1", {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "Thanks",
      } as ScenarioNodeData),
    ]);

    expect(summary).not.toHaveProperty("triggerType");
    expect(summary).not.toHaveProperty("triggerConfig");
    expect(summary.triggers).toHaveLength(2);
    expect(summary.triggers?.[0]).toEqual({
      triggerNodeId: "trigger-any",
      triggerConfig: expect.objectContaining({ enabled: true }),
      label: null,
    });
    expect(summary.triggers?.[1]).toEqual({
      triggerNodeId: "trigger-exact",
      triggerConfig: expect.objectContaining({
        enabled: true,
        messageMatchMode: "exact",
        keywordPattern: "buy product",
      }),
      label: null,
    });
    expect(summary.primaryActionType).toBe("reply");
  });

  it("summarizes bulk roots apart from triggers", () => {
    const summary = resolveScenarioBuilderSummaryFromNodes([
      node(" bulk-campaign ", {
        kind: "bulk",
        bulkRootConfig: { workflowKind: "bulk_campaign" },
      } as ScenarioNodeData),
      node("bulk-follow-up", {
        kind: "bulk",
        bulkRootConfig: { workflowKind: "follow_up_workflow" },
      } as ScenarioNodeData),
      node("bulk-bare", { kind: "bulk" } as ScenarioNodeData),
      node("trigger-1", {
        kind: "trigger",
        triggerConfig: { enabled: true },
      } as ScenarioNodeData),
      node("action-1", {
        kind: "action",
        actionType: "whatsapp_template",
      } as ScenarioNodeData),
    ]);

    expect(summary.bulkRoots).toEqual([
      { bulkNodeId: "bulk-campaign", workflowKind: "bulk_campaign" },
      { bulkNodeId: "bulk-follow-up", workflowKind: "follow_up_workflow" },
      { bulkNodeId: "bulk-bare", workflowKind: null },
    ]);
    expect(summary.triggers?.map(trigger => trigger.triggerNodeId)).toEqual([
      "trigger-1",
    ]);
  });

  it("reports no bulk roots for a trigger-only graph", () => {
    const summary = resolveScenarioBuilderSummaryFromNodes([
      node("trigger-1", { kind: "trigger" } as ScenarioNodeData),
    ]);
    expect(summary.bulkRoots).toEqual([]);
  });

  it("keeps canonical service ownership when stale Flow data is present", () => {
    const summary = resolveScenarioBuilderSummaryFromNodes([
      node("trigger-1", {
        kind: "trigger",
      } as ScenarioNodeData),
      node("action-1", {
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "text",
            body: { mode: "fixed", text: "Canonical" },
          },
        },
        actionFlowConfig: {
          templateId: "stale-flow",
          screens: [{ id: "screen-1", title: "Stale", fields: [] }],
          ctaText: "Open",
        },
      } as ScenarioNodeData),
    ]);

    expect(summary.primaryActionType).toBe("reply");
  });
});
