import {
  syncBranchNodes,
  TELEGRAM_BRANCH_DESCRIPTOR,
  transitionBranchNodes,
  WHATSAPP_TEMPLATE_BUTTON_BRANCH_DESCRIPTOR,
} from "./branch-sync";
import {
  ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  GENERATIVE_AI_FAILURE_HANDLE,
  GENERATIVE_AI_SUCCESS_HANDLE,
} from "@icecore/scenario-contracts";
import type { ScenarioNodeData } from "../../types";
import { buildEmptyFlow, buildStarterFlow } from "./starter";
import {
  createGraphTestEdge as createEdge,
  createGraphTestNode as createNode,
} from "./test-utils";
import { findInstagramReplyActionIdsAttachedToBulkRoot } from "./utils";

describe("buildEmptyFlow", () => {
  it("returns an empty graph for blank scenario create", () => {
    expect(buildEmptyFlow()).toEqual({
      nodes: [],
      edges: [],
    });
  });
});

describe("buildStarterFlow", () => {
  it("starts conversation starter flows from the incoming-message trigger", () => {
    const flow = buildStarterFlow();

    expect(flow.nodes[0]?.data).toMatchObject({
      kind: "trigger",
      triggerConfig: {
        enabled: true,
        keywordMatchMode: "contains",
        messageMatchMode: "any",
      },
    });
    expect(flow.nodes[0]?.data).not.toHaveProperty("triggerType");
    expect(flow.nodes[0]?.type).toBe("triggerNode");
  });
});

describe("findInstagramReplyActionIdsAttachedToBulkRoot", () => {
  it("marks Instagram replies directly attached to a bulk root", () => {
    const nodes = [
      createNode("bulk-1", {
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          sendMode: "immediate",
          channels: ["whatsapp"],
          campaignName: "Campaign",
          recipientSourceSummary: "No recipients",
          generationStatus: "idle",
        },
      }),
      createNode("instagram-action", {
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "instagram",
      }),
    ];

    expect(
      findInstagramReplyActionIdsAttachedToBulkRoot(nodes, [
        createEdge("bulk-1", "instagram-action"),
      ])
    ).toEqual(new Set(["instagram-action"]));
  });

  it("walks recursively in either direction and ignores disconnected Instagram replies", () => {
    const nodes = [
      createNode("instagram-action", {
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "instagram",
      }),
      createNode("logic-1", {
        kind: "logic",
        logicType: "post_action_condition",
      }),
      createNode("bulk-1", {
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          sendMode: "immediate",
          channels: ["whatsapp"],
          campaignName: "Blocked campaign",
          recipientSourceSummary: "No recipients",
          generationStatus: "idle",
        },
      }),
      createNode("bulk-2", {
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          sendMode: "immediate",
          channels: ["whatsapp"],
          campaignName: "Allowed campaign",
          recipientSourceSummary: "No recipients",
          generationStatus: "idle",
        },
      }),
      createNode("downstream-instagram-action", {
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "instagram",
      }),
      createNode("disconnected-instagram-action", {
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "instagram",
      }),
    ];

    expect(
      findInstagramReplyActionIdsAttachedToBulkRoot(nodes, [
        createEdge("instagram-action", "logic-1"),
        createEdge("logic-1", "bulk-1"),
        createEdge("bulk-2", "downstream-instagram-action"),
      ])
    ).toEqual(new Set(["instagram-action", "downstream-instagram-action"]));
  });
});

describe("syncBranchNodes", () => {
  it("preserves persistent orphaned nodes and clears their branch binding data", () => {
    const parentNode = createNode("action-1", {
      kind: "action",
      actionType: "reply",
      actionTelegramQuickReplies: [], // No options anymore, so any existing connected node is orphaned!
    });
    const orphanedTargetNode = {
      ...createNode("target-reply", {
        kind: "action",
        actionType: "reply",
        telegramBranchPayload: "old-payload",
        telegramBranchLabel: "Old Label",
      }),
      type: "actionNode",
    };

    const currentNodes = [parentNode, orphanedTargetNode];
    const currentEdges = [
      {
        id: "edge-1",
        source: "action-1",
        target: "target-reply",
        sourceHandle: "right-source-telegram-branch::old-payload",
      },
    ];

    const result = syncBranchNodes({
      actionNodeId: parentNode.id,
      nodes: currentNodes,
      edges: currentEdges,
      descriptor: TELEGRAM_BRANCH_DESCRIPTOR,
    });

    // Assert target node is preserved on the canvas
    const resultTarget = result.nodes.find(n => n.id === "target-reply");
    expect(resultTarget).toBeDefined();

    // Assert branch binding is cleared
    expect(resultTarget?.data?.telegramBranchPayload).toBeUndefined();
    expect(resultTarget?.data?.telegramBranchLabel).toBeUndefined();

    // Assert branch edge is deleted
    const resultEdge = result.edges.find(e => e.id === "edge-1");
    expect(resultEdge).toBeUndefined();

    // Assert removedNodeIds is empty (since the node is preserved)
    expect(result.removedNodeIds).toEqual([]);
  });

  it("keeps non-branch edges to orphaned targets when removing orphaned branch edges", () => {
    const parentNode = createNode("action-1", {
      kind: "action",
      actionType: "reply",
      actionTelegramQuickReplies: [],
    });
    const orphanedTargetNode = {
      ...createNode("target-reply", {
        kind: "action",
        actionType: "reply",
        telegramBranchPayload: "old-payload",
        telegramBranchLabel: "Old Label",
      }),
      type: "actionNode",
    };

    const result = syncBranchNodes({
      actionNodeId: parentNode.id,
      nodes: [parentNode, orphanedTargetNode],
      edges: [
        {
          id: "branch-edge",
          source: "action-1",
          target: "target-reply",
          sourceHandle: "right-source-telegram-branch::old-payload",
        },
        {
          id: "default-edge",
          source: "action-1",
          target: "target-reply",
          sourceHandle: "right-source",
        },
      ],
      descriptor: TELEGRAM_BRANCH_DESCRIPTOR,
    });

    // The stale telegram branch edge goes away, but the plain next-step
    // connection from the action node must survive.
    expect(result.edges.find(e => e.id === "branch-edge")).toBeUndefined();
    expect(result.edges.find(e => e.id === "default-edge")).toBeDefined();
  });
});

describe("transitionBranchNodes", () => {
  it("applies a content-only action patch without requiring structural history", () => {
    const actionNode = createNode("action-1", {
      kind: "action",
      actionType: "reply",
      actionReplyText: "Before",
    });
    const edges = [createEdge("action-1", "next-1")];

    const result = transitionBranchNodes({
      actionNodeId: "action-1",
      nodes: [
        actionNode,
        createNode("next-1", {
          kind: "action",
          actionType: "reply",
        }),
      ],
      edges,
      descriptors: [TELEGRAM_BRANCH_DESCRIPTOR],
      actionNodePatch: { actionReplyText: "After" },
    });

    expect(
      result.nodes.find(node => node.id === "action-1")?.data
    ).toMatchObject({ actionReplyText: "After" });
    expect(result.edges).toBe(edges);
    expect(result.changed).toBe(true);
    expect(result.dirty).toBe(true);
    expect(result.structuralHistoryRequired).toBe(false);
  });

  it("updates branch labels as content without requiring structural history", () => {
    const targetNode = createNode("target-1", {
      kind: "action",
      actionType: "reply",
      telegramBranchPayload: "yes",
      telegramBranchLabel: "Old label",
    });
    const edge = createEdge("action-1", "target-1", {
      sourceHandle: "right-source-telegram-branch::yes",
    });

    const result = transitionBranchNodes({
      actionNodeId: "action-1",
      nodes: [
        createNode("action-1", {
          kind: "action",
          actionType: "reply",
          actionReplyChannel: "telegram",
          actionTelegramQuickReplies: [{ text: "Old label", payload: "yes" }],
        }),
        targetNode,
      ],
      edges: [edge],
      descriptors: [TELEGRAM_BRANCH_DESCRIPTOR],
      actionNodePatch: {
        actionTelegramQuickReplies: [{ text: "New label", payload: "yes" }],
      },
    });

    expect(
      result.nodes.find(node => node.id === "target-1")?.data
    ).toMatchObject({
      telegramBranchPayload: "yes",
      telegramBranchLabel: "New label",
    });
    expect(result.structuralHistoryRequired).toBe(false);
  });

  it("removes default and configured outcome edges when an action becomes Generative AI", () => {
    const result = transitionBranchNodes({
      actionNodeId: "action-1",
      nodes: [
        createNode("action-1", {
          kind: "action",
          actionType: "reply",
          actionReplyMode: "fixed",
          actionReplyText: "Before",
          actionOutcomes: {
            version: 1,
            anyReply: { enabled: true },
          },
        }),
        createNode("default-target", {
          kind: "action",
          actionType: "reply",
        }),
        createNode("outcome-target", {
          kind: "action",
          actionType: "reply",
        }),
      ],
      edges: [
        createEdge("action-1", "default-target", {
          sourceHandle: "right-source",
        }),
        createEdge("action-1", "outcome-target", {
          sourceHandle: ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
        }),
      ],
      descriptors: [TELEGRAM_BRANCH_DESCRIPTOR],
      actionNodePatch: {
        actionType: "generative_ai",
        actionGenerativeAIConfig: {
          version: 1,
          mode: "text_to_video",
          prompt: "Create a video",
        },
      },
    });

    expect(result.edges).toEqual([]);
    expect(result.structuralHistoryRequired).toBe(true);
  });

  it("removes Generative AI result edges when an action becomes an ordinary reply", () => {
    const result = transitionBranchNodes({
      actionNodeId: "action-1",
      nodes: [
        createNode("action-1", {
          kind: "action",
          actionType: "generative_ai",
          actionGenerativeAIConfig: {
            version: 1,
            mode: "text_to_video",
            prompt: "Create a video",
          },
        }),
        createNode("success-target", {
          kind: "action",
          actionType: "reply",
        }),
        createNode("failure-target", {
          kind: "action",
          actionType: "reply",
        }),
      ],
      edges: [
        createEdge("action-1", "success-target", {
          sourceHandle: GENERATIVE_AI_SUCCESS_HANDLE,
        }),
        createEdge("action-1", "failure-target", {
          sourceHandle: GENERATIVE_AI_FAILURE_HANDLE,
        }),
      ],
      descriptors: [TELEGRAM_BRANCH_DESCRIPTOR],
      actionNodePatch: {
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "After",
        actionGenerativeAIConfig: undefined,
      },
    });

    expect(result.edges).toEqual([]);
    expect(result.structuralHistoryRequired).toBe(true);
  });

  it("keeps a Form submitted route while the template opens one form", () => {
    const formButton = {
      type: "FLOW" as const,
      text: "Open form",
      flow_id: "1571793974235171",
    };
    const quickReply = { type: "QUICK_REPLY" as const, text: "Call me" };
    const buttons = (
      ...items: Array<typeof formButton | typeof quickReply>
    ): Partial<ScenarioNodeData> => ({
      actionWhatsAppTemplateComponents: [{ type: "BUTTONS", buttons: items }],
    });
    const edges = [
      createEdge("action-1", "next-1", {
        sourceHandle: ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
      }),
    ];
    const transition = (actionNodePatch: Partial<ScenarioNodeData>) =>
      transitionBranchNodes({
        actionNodeId: "action-1",
        nodes: [
          createNode("action-1", {
            kind: "action",
            actionType: "whatsapp_template",
            ...buttons(formButton),
          }),
          createNode("next-1", { kind: "action", actionType: "reply" }),
        ],
        edges,
        descriptors: [WHATSAPP_TEMPLATE_BUTTON_BRANCH_DESCRIPTOR],
        actionNodePatch,
      });

    // A quick reply beside the form button adds routes and keeps this one.
    expect(transition(buttons(quickReply, formButton)).edges).toEqual(edges);
    const withoutForm = transition(buttons(quickReply));
    expect(withoutForm.edges).toEqual([]);
    expect(withoutForm.structuralHistoryRequired).toBe(true);
  });

  it("requires structural history when branch nodes and edges are added or branch edges are removed", () => {
    const autoCreatingDescriptor = {
      ...TELEGRAM_BRANCH_DESCRIPTOR,
      autoCreateMissingNodes: true,
    };
    const actionNode = createNode("action-1", {
      kind: "action",
      actionType: "reply",
      actionReplyChannel: "telegram",
      actionTelegramQuickReplies: [{ text: "Yes", payload: "yes" }],
    });

    const added = transitionBranchNodes({
      actionNodeId: "action-1",
      nodes: [actionNode],
      edges: [],
      descriptors: [autoCreatingDescriptor],
    });

    expect(added.nodes).toHaveLength(2);
    expect(added.edges).toHaveLength(1);
    expect(added.structuralHistoryRequired).toBe(true);

    const removed = transitionBranchNodes({
      actionNodeId: "action-1",
      nodes: added.nodes,
      edges: added.edges,
      descriptors: [autoCreatingDescriptor],
      actionNodePatch: { actionTelegramQuickReplies: [] },
    });

    expect(removed.nodes).toHaveLength(2);
    expect(removed.edges).toHaveLength(0);
    expect(removed.structuralHistoryRequired).toBe(true);
  });

  it("returns the original graph for an identity transition", () => {
    const nodes = [
      createNode("action-1", {
        kind: "action",
        actionType: "reply",
        actionReplyText: "Same",
      }),
    ];
    const edges = [createEdge("action-1", "next-1")];

    const result = transitionBranchNodes({
      actionNodeId: "action-1",
      nodes,
      edges,
      descriptors: [TELEGRAM_BRANCH_DESCRIPTOR],
      actionNodePatch: {
        actionType: "reply",
        actionReplyText: "Same",
      },
    });

    expect(result.nodes).toBe(nodes);
    expect(result.edges).toBe(edges);
    expect(result.changed).toBe(false);
    expect(result.dirty).toBe(false);
    expect(result.structuralHistoryRequired).toBe(false);
  });

  it("returns the original graph when the action node is missing", () => {
    const nodes = [
      createNode("other-action", {
        kind: "action",
        actionType: "reply",
      }),
    ];
    const edges = [createEdge("other-action", "next-1")];

    const result = transitionBranchNodes({
      actionNodeId: "missing-action",
      nodes,
      edges,
      descriptors: [TELEGRAM_BRANCH_DESCRIPTOR],
      actionNodePatch: { actionReplyText: "Ignored" },
    });

    expect(result).toEqual({
      nodes,
      edges,
      changed: false,
      dirty: false,
      structuralHistoryRequired: false,
      removedRoutes: [],
    });
    expect(result.nodes).toBe(nodes);
    expect(result.edges).toBe(edges);
  });

  it("returns the original graph when the target node is not an action", () => {
    const nodes = [
      createNode("trigger-1", {
        kind: "trigger",
      }),
    ];
    const edges = [createEdge("trigger-1", "next-1")];

    const result = transitionBranchNodes({
      actionNodeId: "trigger-1",
      nodes,
      edges,
      descriptors: [TELEGRAM_BRANCH_DESCRIPTOR],
      actionNodePatch: { actionReplyText: "Ignored" },
    });

    expect(result).toEqual({
      nodes,
      edges,
      changed: false,
      dirty: false,
      structuralHistoryRequired: false,
      removedRoutes: [],
    });
    expect(result.nodes).toBe(nodes);
    expect(result.edges).toBe(edges);
  });
});
