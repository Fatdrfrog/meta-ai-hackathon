/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type {
  ScenarioAudienceOptions,
  ScenarioFlowEdge,
  ScenarioFlowNode,
  ScenarioNodeData,
} from "../types";
import {
  ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  BULK_CAMPAIGN_ACTION_SOURCE_HANDLE_ID,
  BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
} from "@icecore/scenario-contracts";
import { resolveActionNodeFormSubmittedRoute } from "../nodes/action-node/action-node-state";
import { resolveScenarioConnectionPlan } from "./graph/controller-utils";
import {
  ScenarioNodeEnrichmentProvider,
  useScenarioNodeEnrichment,
} from "./scenario-node-enrichment-context";
import type { ScenarioNodeGraphIndex } from "./node-enrichment/scenario-node-graph-index";
import type {
  ScenarioEditorFlowNode,
  ScenarioActionEditorNodeData,
  ScenarioTriggerEditorNodeData,
} from "./node-enrichment/types";
import { useScenarioDisplayNodes } from "./use-scenario-display-nodes";

function createNode(id: string, data: ScenarioNodeData): ScenarioFlowNode {
  return {
    id,
    type:
      data.kind === "action"
        ? "actionNode"
        : data.kind === "trigger"
          ? "triggerNode"
          : data.kind === "scenario_link"
            ? "scenarioLinkNode"
            : data.kind === "bulk"
              ? "bulkNode"
              : "scenarioNode",
    position: { x: 0, y: 0 },
    data,
  };
}

function GraphIndexProbe({ bulkNodeId }: { bulkNodeId: string }) {
  const ctx = useScenarioNodeEnrichment();
  const primaryActionId =
    ctx.graphIndex.bulkActionByRootId.get(bulkNodeId)?.nodeId ?? "none";
  const primaryActionMarked =
    ctx.graphIndex.bulkPrimaryActionIds.has(primaryActionId);
  return (
    <>
      <div data-testid="primary-bulk-action">{primaryActionId}</div>
      <div data-testid="primary-bulk-action-marked">
        {String(primaryActionMarked)}
      </div>
      <div data-testid="action-node-count">
        {String(ctx.graphIndex.actionNodeCount)}
      </div>
      <div data-testid="connected-action-outcomes">
        {(
          ctx.graphIndex.connectedSourceHandleIdsByNodeId.get("action-1") ?? []
        ).join(",")}
      </div>
    </>
  );
}

function GraphIndexIdentityProbe({
  onGraphIndex,
}: {
  onGraphIndex: (graphIndex: ScenarioNodeGraphIndex) => void;
}) {
  const ctx = useScenarioNodeEnrichment();
  onGraphIndex(ctx.graphIndex);
  return null;
}

function DisplayNodesProbe({ nodes }: { nodes: ScenarioFlowNode[] }) {
  const displayNodes = useScenarioDisplayNodes(nodes);
  const nodeData = displayNodes[0]?.data as ScenarioTriggerEditorNodeData;
  return (
    <>
      <div data-testid="display-node-label">{nodeData.uiNodeLabel}</div>
      <div data-testid="display-node-patch">{typeof nodeData.uiOnPatch}</div>
    </>
  );
}

function ActionPreviewProbe({ nodes }: { nodes: ScenarioFlowNode[] }) {
  const displayNodes = useScenarioDisplayNodes(nodes);
  const nodeData = displayNodes[0]?.data as ScenarioActionEditorNodeData;
  return <div data-testid="action-preview">{nodeData.actionPreviewText}</div>;
}

function DisplayNodesIdentityProbe({
  nodes,
  onNodes,
}: {
  nodes: ScenarioFlowNode[];
  onNodes: (nodes: ScenarioEditorFlowNode[]) => void;
}) {
  onNodes(useScenarioDisplayNodes(nodes));
  return null;
}

const providerResources = {
  audienceOptions: {
    channels: [],
    classificationCategories: [],
    customers: [],
    funnelStages: [],
    internalLabels: [],
    metaReferralAds: [],
    metaReferralCampaigns: [],
    metaReferralAdSets: [],
    metaCampaignLabels: [],
  },
  contextOptions: [],
  contextItemsByOptionId: {},
  isCreatingSnippet: false,
  t: (key: string) => key,
  whatsAppFlows: [],
  whatsAppTemplates: [],
  activeScenarioId: "scenario-1",
  workspaceId: "workspace-1",
};

const providerNodeBridge = {
  nodeCallbacks: {} as never,
  adoptGeneratedBulkServerUpdate: jest.fn(),
  prepareScenarioBulkSend: jest.fn(),
  adoptScenarioActivation: jest.fn(),
  onScenarioActivationBlocked: jest.fn(),
  publishManagedWhatsAppFlow: jest.fn(async () => null),
  scenarioSessionOwnerKey: "session-1",
  publishingManagedFlowNodeId: null,
  prepareGeneratedJobRefresh: jest.fn().mockResolvedValue(true),

  submitGeneratedTemplateForNode: jest.fn(async () => true),

  submittingGeneratedTemplateNodeId: null,
  loadWhatsAppTemplateForm: jest.fn(async () => ({
    status: "skipped" as const,
  })),
  loadingTemplateFormNodeIds: new Set<string>(),
  reconcileGeneratedJobServerUpdate: jest.fn(),
  selectExistingFlowForNodeRef: { current: jest.fn() } as never,
  handleBranchSyncForNodeRef: { current: jest.fn() } as never,
  openNodePickerFromHandle: jest.fn(),
};

const providerScenarioSettings = {};

function ScenarioNodeEnrichmentTestProvider({
  children,
  edges,
  nodes,
  audienceOptions,
  validationMode,
}: {
  children: ReactNode;
  edges: ScenarioFlowEdge[];
  nodes: ScenarioFlowNode[];
  audienceOptions?: ScenarioAudienceOptions;
  validationMode?: "draft" | "runnable";
}) {
  return (
    <ScenarioNodeEnrichmentProvider
      graph={{ nodes, edges }}
      resources={{
        ...providerResources,
        audienceOptions: audienceOptions ?? providerResources.audienceOptions,
      }}
      nodeBridge={providerNodeBridge}
      scenarioSettings={{ ...providerScenarioSettings, validationMode }}
    >
      {children}
    </ScenarioNodeEnrichmentProvider>
  );
}

function renderWithGraph(params: {
  nodes: ScenarioFlowNode[];
  edges: ScenarioFlowEdge[];
}) {
  render(
    <ScenarioNodeEnrichmentTestProvider
      nodes={params.nodes}
      edges={params.edges}
    >
      <GraphIndexProbe bulkNodeId="bulk-1" />
    </ScenarioNodeEnrichmentTestProvider>
  );
}

describe("ScenarioNodeEnrichmentProvider display composition", () => {
  it("updates trigger and action validation when publishing without changing the graph", () => {
    const nodes = [
      createNode("trigger", { kind: "trigger" }),
      createNode("action", { kind: "action", actionType: "reply" }),
    ];
    const onNodes = jest.fn<void, [ScenarioEditorFlowNode[]]>();
    const view = render(
      <ScenarioNodeEnrichmentTestProvider
        nodes={nodes}
        edges={[]}
        validationMode="draft"
      >
        <DisplayNodesIdentityProbe nodes={nodes} onNodes={onNodes} />
      </ScenarioNodeEnrichmentTestProvider>
    );
    expect(
      onNodes.mock.calls.at(-1)?.[0].map(node => node.data.uiValidationMode)
    ).toEqual(["draft", "draft"]);
    view.rerender(
      <ScenarioNodeEnrichmentTestProvider
        nodes={nodes}
        edges={[]}
        validationMode="runnable"
      >
        <DisplayNodesIdentityProbe nodes={nodes} onNodes={onNodes} />
      </ScenarioNodeEnrichmentTestProvider>
    );
    expect(
      onNodes.mock.calls.at(-1)?.[0].map(node => node.data.uiValidationMode)
    ).toEqual(["runnable", "runnable"]);
    expect(nodes.map(node => node.data)).toEqual([
      { kind: "trigger" },
      { kind: "action", actionType: "reply" },
    ]);
  });
  it.each(["future_kind", "", undefined])(
    "excludes an unsupported runtime kind %s from display without editing persisted nodes",
    kind => {
      const validNode = createNode("valid", { kind: "trigger" });
      const invalidNode = Object.freeze({
        ...createNode("invalid", { kind: "action" }),
        data: Object.freeze({ kind, futureConfig: { draft: true } }),
      }) as unknown as ScenarioFlowNode;
      const nodes = [invalidNode, validNode];
      const original = JSON.stringify(nodes);
      const onNodes = jest.fn<void, [ScenarioEditorFlowNode[]]>();

      render(
        <ScenarioNodeEnrichmentTestProvider nodes={nodes} edges={[]}>
          <DisplayNodesIdentityProbe nodes={nodes} onNodes={onNodes} />
        </ScenarioNodeEnrichmentTestProvider>
      );

      const projected = onNodes.mock.calls.at(-1)?.[0];
      expect(projected).toHaveLength(1);
      expect(projected?.[0]).toMatchObject({
        id: "valid",
        data: { kind: "trigger" },
      });
      expect(nodes).toEqual([invalidNode, validNode]);
      expect(JSON.stringify(nodes)).toBe(original);
    }
  );

  it.each([
    ["trigger", "triggerNode"],
    ["action", "actionNode"],
    ["bulk", "bulkNode"],
    ["context", "scenarioNode"],
    ["logic", "scenarioNode"],
    ["scenario_link", "scenarioLinkNode"],
  ] as const)(
    "projects %s without mutating the document or canvas selection",
    (kind, type) => {
      const persistedNode = Object.freeze({
        ...createNode("node-1", Object.freeze({ kind })),
        type: "stale-saved-renderer",
        selected: true,
        hidden: false,
        position: Object.freeze({ x: 25, y: 60 }),
      });
      const nodes = [persistedNode];
      const onNodes = jest.fn<void, [ScenarioEditorFlowNode[]]>();
      render(
        <ScenarioNodeEnrichmentTestProvider nodes={nodes} edges={[]}>
          <DisplayNodesIdentityProbe nodes={nodes} onNodes={onNodes} />
        </ScenarioNodeEnrichmentTestProvider>
      );
      const projected = onNodes.mock.calls.at(-1)?.[0][0];
      expect(projected).toMatchObject({
        id: "node-1",
        type,
        hidden: false,
        position: { x: 25, y: 60 },
        data: { kind },
      });
      expect(projected).not.toHaveProperty("selected");
      expect(projected?.data).not.toBe(persistedNode.data);
      expect(persistedNode).toMatchObject({
        selected: true,
        type: "stale-saved-renderer",
        data: { kind },
      });
      expect(persistedNode.data).not.toHaveProperty("uiOnPatch");
    }
  );

  it("composes editor-only trigger data inside the provider", () => {
    const nodes = [
      createNode("trigger-1", {
        kind: "trigger",
        triggerConfig: { enabled: true, messageMatchMode: "any" },
      }),
    ];

    render(
      <ScenarioNodeEnrichmentTestProvider nodes={nodes} edges={[]}>
        <DisplayNodesProbe nodes={nodes} />
      </ScenarioNodeEnrichmentTestProvider>
    );

    expect(screen.getByTestId("display-node-label").textContent).toBe(
      "presetTriggerIncoming"
    );
    expect(screen.getByTestId("display-node-patch").textContent).toBe(
      "function"
    );
  });

  it("uses the rerender's audience profile during that render", () => {
    const nodes = [
      createNode("action-1", {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "Hello {{customer.name}}",
      }),
    ];
    const edges: ScenarioFlowEdge[] = [];
    const view = render(
      <ScenarioNodeEnrichmentTestProvider
        nodes={nodes}
        edges={edges}
        audienceOptions={{
          ...providerResources.audienceOptions,
          customers: [{ id: "alpha", label: "Alpha", channel: "whatsapp" }],
        }}
      >
        <ActionPreviewProbe nodes={nodes} />
      </ScenarioNodeEnrichmentTestProvider>
    );

    expect(screen.getByTestId("action-preview").textContent).toBe(
      "Hello Alpha"
    );

    view.rerender(
      <ScenarioNodeEnrichmentTestProvider
        nodes={nodes}
        edges={edges}
        audienceOptions={{
          ...providerResources.audienceOptions,
          customers: [{ id: "beta", label: "Beta", channel: "whatsapp" }],
        }}
      >
        <ActionPreviewProbe nodes={nodes} />
      </ScenarioNodeEnrichmentTestProvider>
    );

    expect(screen.getByTestId("action-preview").textContent).toBe("Hello Beta");
  });
});

describe("ScenarioNodeEnrichmentProvider bulk action graph index", () => {
  const bulkNode = createNode("bulk-1", {
    kind: "bulk",
    bulkRootConfig: {
      workflowKind: "bulk_campaign",
      sendMode: "immediate",
      channels: ["whatsapp"],
      campaignName: "VIP reactivation",
      recipientSourceSummary: "Upload recipients",
      generationStatus: "idle",
    },
  });
  const templateActionNode = createNode("action-template", {
    kind: "action",
    actionType: "whatsapp_template",
  });
  const followUpActionNode = createNode("action-follow-up", {
    kind: "action",
    actionType: "reply",
  });

  it("uses the first right-side WhatsApp template as the primary campaign action", () => {
    renderWithGraph({
      nodes: [bulkNode, followUpActionNode, templateActionNode],
      edges: [
        {
          id: "edge-follow-up",
          source: "bulk-1",
          sourceHandle: BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
          target: "action-follow-up",
          targetHandle: "left-target",
        },
        {
          id: "edge-primary",
          source: "bulk-1",
          sourceHandle: BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
          target: "action-template",
          targetHandle: "left-target",
        },
      ],
    });

    expect(screen.getByTestId("primary-bulk-action").textContent).toBe(
      "action-template"
    );
    expect(screen.getByTestId("primary-bulk-action-marked").textContent).toBe(
      "true"
    );
    expect(screen.getByTestId("action-node-count").textContent).toBe("2");
  });

  it("does not treat right-side non-template bulk follow-ups as the send action", () => {
    renderWithGraph({
      nodes: [bulkNode, followUpActionNode],
      edges: [
        {
          id: "edge-follow-up",
          source: "bulk-1",
          sourceHandle: BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
          target: "action-follow-up",
          targetHandle: "left-target",
        },
      ],
    });

    expect(screen.getByTestId("primary-bulk-action").textContent).toBe("none");
    expect(screen.getByTestId("primary-bulk-action-marked").textContent).toBe(
      "false"
    );
  });

  it("does not treat legacy top-connected bulk actions as the send action", () => {
    renderWithGraph({
      nodes: [bulkNode, templateActionNode],
      edges: [
        {
          id: "edge-legacy-primary",
          source: "bulk-1",
          sourceHandle: BULK_CAMPAIGN_ACTION_SOURCE_HANDLE_ID,
          target: "action-template",
          targetHandle: "left-target",
        },
      ],
    });

    expect(screen.getByTestId("primary-bulk-action").textContent).toBe("none");
    expect(screen.getByTestId("primary-bulk-action-marked").textContent).toBe(
      "false"
    );
  });

  // The route shows only where connecting it is allowed, so no toast refuses
  // a route the step offered.
  describe("a template's Form submitted route", () => {
    const formTemplateNode = createNode("form-template", {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateComponents: [
        {
          type: "BUTTONS",
          buttons: [
            { type: "FLOW", text: "Open form", flow_id: "1571793974235171" },
          ],
        },
      ],
    });
    const filterNode = createNode("filter", {
      kind: "logic",
      logicType: "audience_filter",
    });
    const thanksNode = createNode("thanks", {
      kind: "action",
      actionType: "reply",
    });
    const nodes = [
      bulkNode,
      filterNode,
      templateActionNode,
      formTemplateNode,
      thanksNode,
    ];
    const edge = (source: string, target: string): ScenarioFlowEdge => ({
      id: `${source}-${target}`,
      source,
      sourceHandle: BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
      target,
      targetHandle: "left-target",
    });

    it.each<[string, ScenarioFlowEdge[], boolean]>([
      ["a bulk send's template", [edge("bulk-1", "form-template")], true],
      [
        "a bulk send's template behind logic",
        [edge("bulk-1", "filter"), edge("filter", "form-template")],
        true,
      ],
      [
        "a template after the bulk send",
        [
          edge("bulk-1", "action-template"),
          edge("action-template", "form-template"),
        ],
        false,
      ],
    ])(
      "is hidden on %s exactly when connecting it is refused",
      (_label, edges, refused) => {
        const onNodes = jest.fn<void, [ScenarioEditorFlowNode[]]>();
        render(
          <ScenarioNodeEnrichmentTestProvider nodes={nodes} edges={edges}>
            <DisplayNodesIdentityProbe nodes={nodes} onNodes={onNodes} />
          </ScenarioNodeEnrichmentTestProvider>
        );
        const displayed = onNodes.mock.calls
          .at(-1)?.[0]
          .find(node => node.id === "form-template");

        expect(
          resolveActionNodeFormSubmittedRoute(
            displayed?.data as ScenarioActionEditorNodeData
          ).placement
        ).toBe(refused ? "anchor" : "row");
        expect(
          resolveScenarioConnectionPlan({
            connection: {
              sourceHandle: ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
            },
            sourceNode: formTemplateNode,
            targetNode: thanksNode,
            nodes,
            edges,
          })
        ).toMatchObject(
          refused
            ? { kind: "invalid", errorKey: "whatsappTemplateFormRouteInBulk" }
            : { kind: "valid" }
        );
      }
    );
  });

  it("keeps the index while only node placement changes and rebuilds it for data and edge changes", () => {
    const graphIndexes: ScenarioNodeGraphIndex[] = [];
    const actionData: ScenarioNodeData = {
      kind: "action",
      actionType: "reply",
    };
    const triggerNode = createNode("trigger-1", { kind: "trigger" });
    const actionNode = createNode("action-1", actionData);
    const edge: ScenarioFlowEdge = {
      id: "edge-1",
      source: "trigger-1",
      target: "action-1",
      sourceHandle: "right-source",
    };
    const renderGraph = (
      nodes: ScenarioFlowNode[],
      edges: ScenarioFlowEdge[]
    ) => (
      <ScenarioNodeEnrichmentTestProvider nodes={nodes} edges={edges}>
        <GraphIndexIdentityProbe
          onGraphIndex={graphIndex => graphIndexes.push(graphIndex)}
        />
      </ScenarioNodeEnrichmentTestProvider>
    );
    const nodes = [triggerNode, actionNode];
    const edges = [edge];

    const view = render(renderGraph(nodes, edges));
    view.rerender(renderGraph(nodes, edges));
    // React Flow's first measurement and a drag: new node objects and
    // arrays, same data.
    const measuredNodes = [
      triggerNode,
      { ...actionNode, measured: { width: 300, height: 120 } },
    ];
    view.rerender(renderGraph(measuredNodes, [...edges]));
    view.rerender(
      renderGraph(
        [triggerNode, { ...measuredNodes[1], position: { x: 40, y: 80 } }],
        [{ ...edge }]
      )
    );
    const afterPlacement = graphIndexes.length;
    view.rerender(
      renderGraph(
        [
          triggerNode,
          { ...actionNode, data: { ...actionData, actionReplyMode: "ai" } },
        ],
        edges
      )
    );
    const afterData = graphIndexes.length;
    view.rerender(renderGraph(nodes, [{ ...edge, sourceHandle: "other" }]));

    expect(new Set(graphIndexes.slice(0, afterPlacement)).size).toBe(1);
    expect(graphIndexes[afterData - 1]).not.toBe(graphIndexes[0]);
    expect(graphIndexes.at(-1)).not.toBe(graphIndexes[afterData - 1]);
    expect(graphIndexes.at(-1)).not.toBe(graphIndexes[0]);
  });

  it("indexes connected action outcome handles by their owning action", () => {
    const actionNode = createNode("action-1", {
      kind: "action",
      actionType: "reply",
      actionOutcomes: {
        version: 1,
        anyReply: { enabled: true },
      },
    });
    const targetNode = createNode("action-2", {
      kind: "action",
      actionType: "reply",
    });

    renderWithGraph({
      nodes: [actionNode, targetNode],
      edges: [
        {
          id: "edge-outcome",
          source: actionNode.id,
          sourceHandle: ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
          target: targetNode.id,
          targetHandle: "left-target",
        },
      ],
    });

    expect(screen.getByTestId("connected-action-outcomes").textContent).toBe(
      ACTION_ANY_REPLY_OUTCOME_HANDLE_ID
    );
  });
});

describe("ScenarioNodeEnrichmentProvider form answers AI prompts read", () => {
  const FLOW_ID = "1571793974235171";
  const NAME_TOKEN = "form.demoshop_ai_case.f_68d224";
  const templateNode = createNode("template", {
    kind: "action",
    actionType: "whatsapp_template",
    actionWhatsAppTemplateComponents: [
      {
        type: "BUTTONS",
        buttons: [{ type: "FLOW", text: "Open form", flow_id: FLOW_ID }],
      },
    ],
    actionWhatsAppTemplateForm: {
      version: 1,
      flowId: FLOW_ID,
      flowName: "demoshop_ai_case",
      answersKey: "demoshop_ai_case",
      digest: "fields",
      coverage: "complete",
      endpoint: false,
      readAt: "2026-10-01T00:00:00.000Z",
      fields: [
        {
          responseKey: "_68d224",
          label: "Athlete's name",
          description: "",
          fieldType: "TextInput",
          required: true,
          screenIndex: 0,
          options: [],
        },
      ],
    },
  });
  const edges: ScenarioFlowEdge[] = [
    {
      id: "template-ai",
      source: "template",
      sourceHandle: "right-source",
      target: "ai",
      targetHandle: "left-target",
    },
  ];

  it("tells a template step which answers of its form AI prompts read", () => {
    const onNodes = jest.fn<void, [ScenarioEditorFlowNode[]]>();
    const writes = (id: string, instruction: string) =>
      createNode(id, {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "ai",
        actionReplyInstruction: instruction,
      });
    const renderGraph = (instruction: string, otherInstruction: string) => {
      const nodes = [
        templateNode,
        writes("ai", instruction),
        writes("other", otherInstruction),
      ];
      return (
        <ScenarioNodeEnrichmentTestProvider nodes={nodes} edges={edges}>
          <DisplayNodesIdentityProbe nodes={nodes} onNodes={onNodes} />
        </ScenarioNodeEnrichmentTestProvider>
      );
    };
    const templateData = () =>
      onNodes.mock.calls.at(-1)?.[0].find(node => node.id === "template")
        ?.data as ScenarioActionEditorNodeData;

    const view = render(
      renderGraph(`Draw {{${NAME_TOKEN}}}`, "Confirm {{form.order.size}}")
    );
    const reading = templateData();
    expect(reading.uiScenarioFormAnswerTokensRead).toEqual([NAME_TOKEN]);

    // Another form's answers leave the step as it was.
    view.rerender(
      renderGraph(`Draw {{${NAME_TOKEN}}}`, "Confirm {{form.order.colour}}")
    );
    expect(templateData()).toBe(reading);

    // The user takes the answer out of the AI step, so the step's form
    // notice stops naming it.
    view.rerender(
      renderGraph("Draw a gold medal", "Confirm {{form.order.colour}}")
    );
    expect(templateData().uiScenarioFormAnswerTokensRead).toEqual([]);
  });
});
