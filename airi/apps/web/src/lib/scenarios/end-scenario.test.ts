import {
  buildScenarioActionOutcomeHandleId,
  buildWhatsAppSessionChoiceSourceHandleId,
  getScenarioActionOutcomeVirtualNodeId,
  lowerScenarioRoutingGraph,
} from "@icecore/scenario-contracts";
import { compileScenarioGraph } from "@icecore/airi-runtime/scenario-graph";
import { resolveScenarioActionTypeFromNodeData } from "@icecore/airi-runtime/scenario-action-semantics";
import {
  resolveScenarioDispatchTransition,
  resolvePostActionConditionBranchTarget,
} from "@/lib/airi/scenario/scenario-post-action-routing";
import { evaluateScenarioFlow } from "@/lib/airi/scenario/scenario-interactive-replies";
import { normalizeScenarioNodesForPersistence } from "./scenario-graph-persistence";
import { validateScenarioGraphActionPayloads } from "./graph-validation";
import { validateScenarioFlowStructure } from "./flow-structure-validation";

const end = {
  id: "end",
  data: { kind: "action", actionType: "end_scenario" },
} as const;

describe("explicit scenario ending", () => {
  it("rejects an ending as the primary bulk action, including through a filter", () => {
    expect(
      validateScenarioFlowStructure({
        nodes: [
          { id: "bulk", data: { kind: "bulk" } },
          {
            id: "filter",
            data: { kind: "logic", logicType: "audience_filter" },
          },
          end,
        ],
        edges: [
          { source: "bulk", target: "filter" },
          { source: "filter", target: "end" },
        ],
      })
    ).toBe("bulkPrimaryActionRequiresAction");
  });
  it("allows ending a conversation branch after the bulk message", () => {
    expect(
      validateScenarioFlowStructure({
        nodes: [
          { id: "bulk", data: { kind: "bulk" } },
          { id: "send", data: { kind: "action", actionType: "reply" } },
          end,
        ],
        edges: [
          { source: "bulk", target: "send" },
          { source: "send", target: "end" },
        ],
      })
    ).toBeNull();
  });
  it("round-trips a runnable terminal action without message configuration", () => {
    expect(resolveScenarioActionTypeFromNodeData(end.data)).toBe(
      "end_scenario"
    );
    expect(normalizeScenarioNodesForPersistence([end])).toEqual([end]);
    expect(validateScenarioGraphActionPayloads([end])).toBeNull();
    expect(compileScenarioGraph([end], []).runtimeActionNodes).toEqual([end]);
  });

  it("rejects and excludes outgoing terminal edges", () => {
    const result = lowerScenarioRoutingGraph({
      nodes: [
        end,
        { id: "next", data: { kind: "action", actionType: "reply" } },
      ],
      edges: [{ id: "invalid", source: "end", target: "next" }],
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "terminal_action_has_outgoing_edges",
        nodeId: "end",
        edgeId: "invalid",
      })
    );
    expect(result.edges).toEqual([]);
  });

  it("rejects terminal waits rather than creating a hidden timer", () => {
    const result = lowerScenarioRoutingGraph({
      nodes: [
        {
          ...end,
          data: {
            ...end.data,
            actionOutcomes: {
              version: 1,
              noReply: { enabled: true, timeoutMinutes: 10 },
            },
          },
        },
      ],
      edges: [],
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "terminal_action_has_outcomes",
        nodeId: "end",
      })
    );
    expect(result.nodes).toHaveLength(1);
  });

  it("ends even when its incoming path contains a previous wait or loop", () => {
    const wait = {
      id: "wait",
      data: {
        kind: "logic",
        logicType: "post_action_condition",
        conditionBranches: [
          {
            id: "no_reply_timeout",
            type: "no_reply_timeout",
            timeoutMinutes: 10,
          },
        ],
      },
    } as const;
    const graph = compileScenarioGraph(
      [end, wait as never],
      [{ source: "wait", target: "end" }]
    );
    expect(
      resolveScenarioDispatchTransition({
        graph,
        selectedAction: end,
        selectedActionType: "end_scenario",
        selectedPathNodeIds: ["menu", "wait", "menu", "wait", "end"],
        conversation: { _id: "conversation" } as never,
        channel: "whatsapp",
      })
    ).toEqual({ nextActionNodeId: null, completesScenario: true });
  });

  it.each(["user_replied", "no_reply_timeout"] as const)(
    "routes the %s outcome to its explicit ending",
    branchType => {
      const graph = compileScenarioGraph(
        [
          {
            id: "source",
            data: {
              kind: "action",
              actionType: "reply",
              actionOutcomes: {
                version: 1,
                anyReply: { enabled: true },
                noReply: { enabled: true, timeoutMinutes: 10 },
              },
            },
          },
          end,
        ],
        [
          {
            source: "source",
            target: "end",
            sourceHandle: buildScenarioActionOutcomeHandleId(
              branchType === "user_replied" ? "any_reply" : "no_reply"
            ),
          },
        ]
      );
      expect(
        resolvePostActionConditionBranchTarget({
          graph,
          conditionNodeId: getScenarioActionOutcomeVirtualNodeId("source"),
          branchType,
          conversation: {} as never,
          channel: "whatsapp",
        })
      ).toEqual(end);
    }
  );

  it("keeps service-message routes when actionType is a stale end_scenario", () => {
    const result = lowerScenarioRoutingGraph({
      nodes: [
        {
          id: "send",
          data: {
            kind: "action",
            actionType: "end_scenario",
            actionWhatsAppServiceMessage: {
              version: 1,
              message: {
                kind: "text",
                body: { mode: "fixed", text: "Hi" },
              },
            },
          },
        },
        { id: "next", data: { kind: "action", actionType: "reply" } },
      ],
      edges: [{ id: "keep", source: "send", target: "next" }],
    });
    expect(result.edges).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "keep" })])
    );
    expect(result.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "terminal_action_has_outgoing_edges" })
    );
  });

  it("follows a WhatsApp reply-button branch to the terminal action", () => {
    const payload = "wsc:menu:finish";
    const graph = compileScenarioGraph(
      [
        {
          id: "trigger",
          data: { kind: "trigger", triggerConfig: { enabled: true } },
        },
        {
          id: "menu",
          data: {
            kind: "action",
            actionType: "reply",
            actionWhatsAppServiceMessage: {
              version: 1,
              message: {
                kind: "reply_buttons",
                body: { mode: "fixed", text: "Finished?" },
                options: [{ id: payload, label: "Finish" }],
              },
            },
          },
        },
        end,
      ],
      [
        { source: "trigger", target: "menu" },
        {
          source: "menu",
          target: "end",
          sourceHandle: buildWhatsAppSessionChoiceSourceHandleId(payload),
        },
      ]
    );
    const match = evaluateScenarioFlow({
      graph,
      conversation: {} as never,
      channel: "whatsapp",
      preferredActionNodeId: "menu",
      triggerEventKind: "whatsapp_button_reply",
      quickReplyPayload: payload,
    });
    expect(match?.selectedAction.id).toBe("end");
    expect(match?.selectedActionType).toBe("end_scenario");
  });
});
