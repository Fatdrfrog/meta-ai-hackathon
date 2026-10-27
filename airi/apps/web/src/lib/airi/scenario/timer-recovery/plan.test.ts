import {
  compileScenarioGraph,
  type ScenarioRuntimeNode,
} from "@icecore/airi-runtime/scenario-graph";
import type { ConversationScenarioState } from "@icecore/airi-runtime/scenario-state";
import { buildWhatsAppTemplateButtonSourceHandleId } from "@icecore/scenario-contracts";

import { planPostActionTimerRecovery } from "./plan";

function createNode(
  id: string,
  data: Record<string, unknown>
): ScenarioRuntimeNode {
  return { id, data: data as ScenarioRuntimeNode["data"] };
}

function createRecoveryInput(overrides: Record<string, unknown> = {}) {
  const nodes: ScenarioRuntimeNode[] = [
    createNode("pick-language", {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "pick_language",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Choose language" },
        {
          type: "BUTTONS",
          buttons: [{ type: "QUICK_REPLY", text: "Kazakh" }],
        },
      ],
    }),
    createNode("wait-for-choice", {
      kind: "logic",
      logicType: "post_action_condition",
      conditionBranches: [
        { id: "user_replied", type: "user_replied" },
        {
          id: "no_reply_timeout",
          type: "no_reply_timeout",
          timeoutMinutes: 1220,
          linkedConditionId: "pick-language-timeout",
        },
      ],
    }),
    createNode("pick-product", {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "pick_product",
    }),
  ];
  const graph = compileScenarioGraph(nodes, [
    {
      source: "pick-language",
      sourceHandle: "right-source",
      target: "wait-for-choice",
    },
    {
      source: "pick-language",
      sourceHandle: buildWhatsAppTemplateButtonSourceHandleId(0),
      target: "wait-for-choice",
    },
    {
      source: "wait-for-choice",
      sourceHandle: "right-source-condition-no_reply_timeout",
      target: "pick-product",
    },
  ]);
  const state: ConversationScenarioState = {
    lockedScenarioId: "scenario-1",
    lockedScenarioName: "Follow-ups",
    currentActionNodeId: "pick-language",
    currentPathNodeIds: ["trigger-1", "pick-language"],
    currentBranchNodeIds: [],
    pendingConditionNodeId: null,
    lastMatchedAt: "2026-07-09T19:52:19.735Z",
    lastMessageId: "inbound-message-1",
  };

  return {
    graph,
    state,
    scenarioId: "scenario-1",
    conversation: { _id: "conversation-1" },
    channel: "whatsapp" as const,
    handoffActive: false,
    outbound: {
      id: "outbound-message-1",
      date: new Date("2026-07-09T19:52:22.708Z"),
      scenarioId: "scenario-1",
      actionNodeId: "pick-language",
      deliveryStatus: null,
    },
    latestMessageAt: new Date("2026-07-09T19:52:22.708Z"),
    now: new Date("2026-07-10T02:00:00.000Z"),
    ...overrides,
  };
}

describe("post-action timer recovery plan", () => {
  it("repairs one condition reached through multiple action handles", () => {
    const result = planPostActionTimerRecovery(createRecoveryInput());

    expect(result).toEqual({
      status: "recover",
      dueAt: "2026-07-10T16:12:22.708Z",
      patch: {
        pendingConditionNodeId: "wait-for-choice",
        pendingSourceActionNodeId: "pick-language",
        pendingStartedAt: new Date("2026-07-09T19:52:22.708Z"),
        pendingLastOutboundMessageId: "outbound-message-1",
        pendingLinkedConditionId: "pick-language-timeout",
        pendingLegacyRouting: null,
      },
    });
  });

  it("does not recover an expired wait", () => {
    const result = planPostActionTimerRecovery(
      createRecoveryInput({ now: new Date("2026-07-10T17:00:00.000Z") })
    );

    expect(result).toEqual({ status: "skip", reason: "deadline_expired" });
  });

  it("does not recover after any newer conversation message", () => {
    const result = planPostActionTimerRecovery(
      createRecoveryInput({
        latestMessageAt: new Date("2026-07-09T20:00:00.000Z"),
      })
    );

    expect(result).toEqual({ status: "skip", reason: "newer_activity" });
  });

  it("does not recover after a failed initial outbound", () => {
    const input = createRecoveryInput();
    const result = planPostActionTimerRecovery({
      ...input,
      outbound: { ...input.outbound, deliveryStatus: "failed" },
    });

    expect(result).toEqual({ status: "skip", reason: "outbound_failed" });
  });

  it("still recovers a follow-up wait while conversation handoff is active", () => {
    const result = planPostActionTimerRecovery(
      createRecoveryInput({ handoffActive: true })
    );

    expect(result.status).toBe("recover");
  });

  it("does not arm a delayed CTA follow-up that was never tapped", () => {
    const kazakh = buildWhatsAppTemplateButtonSourceHandleId(0);
    const graph = compileScenarioGraph(
      [
        createNode("pick-language", {
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateName: "pick_language",
          actionWhatsAppTemplateComponents: [
            {
              type: "BUTTONS",
              buttons: [{ type: "QUICK_REPLY", text: "Kazakh" }],
            },
          ],
          actionOutcomes: {
            version: 1,
            branchDelays: [{ sourceHandle: kazakh, delayMinutes: 60 }],
          },
        }),
        createNode("pick-product", {
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateName: "pick_product",
        }),
      ],
      [
        {
          source: "pick-language",
          sourceHandle: kazakh,
          target: "pick-product",
        },
      ]
    );

    expect(graph.diagnostics).toEqual([]);
    expect(planPostActionTimerRecovery(createRecoveryInput({ graph }))).toEqual(
      { status: "skip", reason: "no_recoverable_condition" }
    );
  });
});
