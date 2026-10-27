/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import type {
  ScenarioFlowEdge,
  ScenarioFlowNode,
  ScenarioNodeData,
} from "../types";
import {
  ScenarioNodeEnrichmentProvider,
  useScenarioNodeEnrichment,
  type ScenarioNodeEnrichmentContextValue,
} from "./scenario-node-enrichment-context";
import type {
  ScenarioActionEditorNodeData,
  ScenarioEditorFlowNode,
} from "./node-enrichment/types";
import { useScenarioDisplayNodes } from "./use-scenario-display-nodes";

jest.mock("./node-enrichment/action", () => {
  const actual = jest.requireActual("./node-enrichment/action");
  return {
    ...actual,
    enrichActionNodeData: jest.fn(actual.enrichActionNodeData),
  };
});
jest.mock("./node-enrichment/trigger", () => {
  const actual = jest.requireActual("./node-enrichment/trigger");
  return {
    ...actual,
    enrichTriggerNodeData: jest.fn(actual.enrichTriggerNodeData),
  };
});

import { enrichActionNodeData } from "./node-enrichment/action";
import { enrichTriggerNodeData } from "./node-enrichment/trigger";

const enrichedActionIds = () =>
  (enrichActionNodeData as jest.Mock).mock.calls.map(([nodeId]) => nodeId);
const enrichedTriggerIds = () =>
  (enrichTriggerNodeData as jest.Mock).mock.calls.map(([nodeId]) => nodeId);

function createNode(id: string, data: ScenarioNodeData): ScenarioFlowNode {
  return {
    id,
    type: data.kind === "action" ? "actionNode" : "triggerNode",
    position: { x: 0, y: 0 },
    data,
  };
}

const translate = (key: string) => key;

const audienceOptions = {
  channels: [],
  classificationCategories: [],
  customers: [],
  funnelStages: [],
  internalLabels: [],
  metaReferralAds: [],
  metaReferralCampaigns: [],
  metaReferralAdSets: [],
  metaCampaignLabels: [],
};

function createResources(overrides: Record<string, unknown> = {}) {
  return {
    audienceOptions,
    contextOptions: [],
    contextItemsByOptionId: {},
    isCreatingSnippet: false,
    t: translate,
    // Fresh empty lists on every render, as unloaded resources are.
    whatsAppFlows: [],
    whatsAppTemplates: [],
    activeScenarioId: "scenario-1",
    workspaceId: "workspace-1",
    ...overrides,
  };
}

function createBridge(overrides: Record<string, unknown> = {}) {
  return {
    nodeCallbacks: {
      selectNodeById: jest.fn(),
      updateNodeById: jest.fn(),
      removeNodeById: jest.fn(),
    } as never,
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
    reconcileGeneratedJobServerUpdate: jest.fn(),
    selectExistingFlowForNodeRef: { current: jest.fn() } as never,
    handleBranchSyncForNodeRef: { current: jest.fn() } as never,
    openNodePickerFromHandle: jest.fn(),
    ...overrides,
  };
}

function DisplayNodesProbe({
  nodes,
  onNodes,
}: {
  nodes: ScenarioFlowNode[];
  onNodes: (nodes: ScenarioEditorFlowNode[]) => void;
}) {
  onNodes(useScenarioDisplayNodes(nodes));
  return null;
}

type HarnessProps = {
  nodes: ScenarioFlowNode[];
  edges: ScenarioFlowEdge[];
  selectedNodeId?: string | null;
  resources?: ReturnType<typeof createResources>;
  bridge?: ReturnType<typeof createBridge>;
  validationMode?: "draft" | "runnable";
};

function Harness({
  nodes,
  edges,
  selectedNodeId = null,
  resources,
  bridge,
  validationMode,
  onNodes,
}: Required<Pick<HarnessProps, "resources" | "bridge">> &
  HarnessProps & {
    onNodes: (nodes: ScenarioEditorFlowNode[]) => void;
  }): ReactNode {
  return (
    <ScenarioNodeEnrichmentProvider
      graph={{ nodes, edges, selectedNodeId }}
      resources={resources as never}
      nodeBridge={bridge as never}
      scenarioSettings={{ validationMode }}
    >
      <DisplayNodesProbe nodes={nodes} onNodes={onNodes} />
    </ScenarioNodeEnrichmentProvider>
  );
}

const trigger = createNode("trigger-1", { kind: "trigger" });
const greeting = createNode("action-a", {
  kind: "action",
  actionType: "reply",
  actionReplyMode: "fixed",
  actionReplyText: "Hello",
});
const followUp = createNode("action-b", {
  kind: "action",
  actionType: "reply",
  actionReplyMode: "fixed",
  actionReplyText: "Bye",
});
const graphNodes = [trigger, greeting, followUp];
const graphEdges: ScenarioFlowEdge[] = [
  {
    id: "e1",
    source: "trigger-1",
    target: "action-a",
    sourceHandle: "right-source",
  },
  {
    id: "e2",
    source: "trigger-1",
    target: "action-b",
    sourceHandle: "right-source",
  },
];

/** Resources and bridge refs stay the same unless a render passes new ones. */
function renderHarness(props: HarnessProps) {
  const results: ScenarioEditorFlowNode[][] = [];
  const onNodes = (nodes: ScenarioEditorFlowNode[]) => results.push(nodes);
  const resources = props.resources ?? createResources();
  const bridge = props.bridge ?? createBridge();
  const view = render(
    <Harness
      resources={resources}
      bridge={bridge}
      {...props}
      onNodes={onNodes}
    />
  );
  return {
    results,
    rerender: (next: HarnessProps) =>
      view.rerender(
        <Harness
          resources={resources}
          bridge={bridge}
          {...next}
          onNodes={onNodes}
        />
      ),
  };
}

beforeEach(() => {
  (enrichActionNodeData as jest.Mock).mockClear();
  (enrichTriggerNodeData as jest.Mock).mockClear();
});

describe("useScenarioDisplayNodes pass cache", () => {
  it("re-enriches no node and keeps unchanged nodes when React Flow measures one", () => {
    const { results, rerender } = renderHarness({
      nodes: graphNodes,
      edges: graphEdges,
    });
    const first = results.at(-1)!;
    (enrichActionNodeData as jest.Mock).mockClear();
    (enrichTriggerNodeData as jest.Mock).mockClear();

    const measured = { ...greeting, measured: { width: 300, height: 140 } };
    rerender({ nodes: [trigger, measured, followUp], edges: [...graphEdges] });
    const next = results.at(-1)!;

    expect(enrichedActionIds()).toEqual([]);
    expect(enrichedTriggerIds()).toEqual([]);
    expect(next[0]).toBe(first[0]);
    expect(next[2]).toBe(first[2]);
    expect(next[1]).not.toBe(first[1]);
    expect(next[1].data).toBe(first[1].data);
    expect(next[1]).toMatchObject({ measured: { width: 300, height: 140 } });
  });

  it("re-enriches only the node whose data changed", () => {
    const { results, rerender } = renderHarness({
      nodes: graphNodes,
      edges: graphEdges,
    });
    const first = results.at(-1)!;
    (enrichActionNodeData as jest.Mock).mockClear();
    (enrichTriggerNodeData as jest.Mock).mockClear();

    const edited = {
      ...followUp,
      data: { ...followUp.data, actionLinkUrls: ["https://example.com/a"] },
    };
    rerender({ nodes: [trigger, greeting, edited], edges: graphEdges });
    const next = results.at(-1)!;

    expect(enrichedActionIds()).toEqual(["action-b"]);
    expect(enrichedTriggerIds()).toEqual([]);
    expect(next[0]).toBe(first[0]);
    expect(next[1]).toBe(first[1]);
    expect(next[2].data).toMatchObject({
      actionLinkUrls: ["https://example.com/a"],
    });
  });

  it("re-enriches the nodes an edit changes the inputs of", () => {
    const chainEdges: ScenarioFlowEdge[] = [
      graphEdges[0],
      {
        id: "e3",
        source: "action-a",
        target: "action-b",
        sourceHandle: "right-source",
      },
    ];
    const { results, rerender } = renderHarness({
      nodes: graphNodes,
      edges: chainEdges,
    });
    const first = results.at(-1)!;
    (enrichActionNodeData as jest.Mock).mockClear();
    (enrichTriggerNodeData as jest.Mock).mockClear();

    // A step names the step its route leads to, so renaming that one
    // reaches it too; the trigger reads neither.
    const renamed = {
      ...followUp,
      data: { ...followUp.data, actionReplyText: "See you" },
    };
    rerender({ nodes: [trigger, greeting, renamed], edges: chainEdges });
    const next = results.at(-1)!;

    expect(enrichedActionIds().sort()).toEqual(["action-a", "action-b"]);
    expect(enrichedTriggerIds()).toEqual([]);
    expect(next[0]).toBe(first[0]);
    const route = (
      next[1].data as ScenarioActionEditorNodeData
    ).uiConnections.destinationsBySourceHandle?.get("right-source");
    expect(route).toEqual({ nodeId: "action-b", label: expect.any(String) });
    expect(route).not.toEqual(
      (
        first[1].data as ScenarioActionEditorNodeData
      ).uiConnections.destinationsBySourceHandle?.get("right-source")
    );
  });

  it("re-enriches only the steps whose selection changed", () => {
    const { results, rerender } = renderHarness({
      nodes: graphNodes,
      edges: graphEdges,
      selectedNodeId: "action-a",
    });
    const first = results.at(-1)!;
    expect(
      (first[1].data as ScenarioActionEditorNodeData).uiIsEditorExpanded
    ).toBe(true);
    (enrichActionNodeData as jest.Mock).mockClear();
    (enrichTriggerNodeData as jest.Mock).mockClear();

    rerender({
      nodes: graphNodes,
      edges: graphEdges,
      selectedNodeId: "action-b",
    });
    const next = results.at(-1)!;

    expect(enrichedActionIds().sort()).toEqual(["action-a", "action-b"]);
    expect(enrichedTriggerIds()).toEqual([]);
    expect(next[0]).toBe(first[0]);
    expect(
      (next[1].data as ScenarioActionEditorNodeData).uiIsEditorExpanded
    ).toBe(false);
    expect(
      (next[2].data as ScenarioActionEditorNodeData).uiIsEditorExpanded
    ).toBe(true);
  });

  it("re-enriches every node when a value every node reads changes", () => {
    const { results, rerender } = renderHarness({
      nodes: graphNodes,
      edges: graphEdges,
      validationMode: "draft",
    });
    (enrichActionNodeData as jest.Mock).mockClear();
    (enrichTriggerNodeData as jest.Mock).mockClear();

    rerender({
      nodes: graphNodes,
      edges: graphEdges,
      validationMode: "runnable",
    });

    expect(enrichedActionIds().sort()).toEqual(["action-a", "action-b"]);
    expect(enrichedTriggerIds()).toEqual(["trigger-1"]);
    expect(results.at(-1)!.map(node => node.data.uiValidationMode)).toEqual([
      "runnable",
      "runnable",
      "runnable",
    ]);
  });

  it("keeps nodes across renders that only bring new empty resource lists and commands", () => {
    const bridge = createBridge();
    const { results, rerender } = renderHarness({
      nodes: graphNodes,
      edges: graphEdges,
      bridge,
    });
    const first = results.at(-1)!;
    (enrichActionNodeData as jest.Mock).mockClear();

    const openNodePickerFromHandle = jest.fn();
    rerender({
      nodes: graphNodes,
      edges: graphEdges,
      resources: createResources(),
      bridge: {
        ...bridge,
        nodeCallbacks: { ...(bridge.nodeCallbacks as object) } as never,
        openNodePickerFromHandle,
      },
    });
    const next = results.at(-1)!;

    expect(enrichedActionIds()).toEqual([]);
    expect(next[1]).toBe(first[1]);
    // A kept node's commands run the canvas's current command.
    void next[1].data.uiOnCreateNodeFromSourceHandle?.("right-source", 1, 2);
    expect(openNodePickerFromHandle).toHaveBeenCalledWith(
      "action-a",
      "right-source",
      1,
      2
    );
  });

  it("keeps a step's commands in its own scenario session after another scenario loads", () => {
    const openPickerA = jest.fn();
    const openPickerB = jest.fn();
    const { results, rerender } = renderHarness({
      nodes: graphNodes,
      edges: graphEdges,
      bridge: createBridge({
        scenarioSessionOwnerKey: "session-A",
        openNodePickerFromHandle: openPickerA,
      }),
    });
    const sessionA = results.at(-1)!;

    rerender({
      nodes: graphNodes,
      edges: graphEdges,
      bridge: createBridge({
        scenarioSessionOwnerKey: "session-B",
        openNodePickerFromHandle: openPickerB,
      }),
    });
    const sessionB = results.at(-1)!;

    // The open scenario's steps get the new session's commands.
    expect(sessionB[1]).not.toBe(sessionA[1]);
    void sessionB[1].data.uiOnCreateNodeFromSourceHandle?.(
      "right-source",
      1,
      2
    );
    expect(openPickerB).toHaveBeenCalledTimes(1);
    // A handler of the earlier session that runs late still reaches that
    // session's command, never the one of the scenario open now.
    void sessionA[1].data.uiOnCreateNodeFromSourceHandle?.(
      "right-source",
      3,
      4
    );
    expect(openPickerA).toHaveBeenCalledWith("action-a", "right-source", 3, 4);
    expect(openPickerB).toHaveBeenCalledTimes(1);
  });

  it("re-enriches a WhatsApp QR trigger on every pass, as its picker reads live save state", () => {
    const qrTrigger = createNode("qr-trigger", {
      kind: "trigger",
      triggerConfig: { entryPointType: "whatsapp_qr" },
    } as ScenarioNodeData);
    let saveState = "saving";
    const getWhatsAppQrPickerProps = jest.fn(() => ({ saveState }) as never);
    const resources = createResources({ getWhatsAppQrPickerProps });
    const { results, rerender } = renderHarness({
      nodes: [qrTrigger],
      edges: [],
      resources,
    });
    saveState = "saved";
    rerender({ nodes: [{ ...qrTrigger }], edges: [], resources });

    expect(results.at(-1)![0].data).toMatchObject({
      uiWhatsAppQrPicker: { saveState: "saved" },
    });
  });
});

function ContextProbe({
  onContext,
}: {
  onContext: (ctx: ScenarioNodeEnrichmentContextValue) => void;
}) {
  onContext(useScenarioNodeEnrichment());
  return null;
}

describe("ScenarioNodeEnrichmentProvider bridge commands", () => {
  function sessionCommands(session: string, owns: boolean) {
    return {
      scenarioSessionOwnerKey: session,
      adoptGeneratedBulkServerUpdate: jest.fn(() => owns),
      prepareScenarioBulkSend: jest.fn(async () => (owns ? () => {} : null)),
      adoptScenarioActivation: jest.fn(() => owns),
      onScenarioActivationBlocked: jest.fn(),
      reconcileGeneratedJobServerUpdate: jest.fn(async () => ({
        status: owns ? "applied" : "failed",
      })),
      prepareGeneratedJobRefresh: jest.fn(async () => owns),
      submitGeneratedTemplateForNode: jest.fn(async () => owns),
      loadWhatsAppTemplateForm: jest.fn(async () => ({
        status: owns ? "unchanged" : "skipped",
      })),
      publishManagedWhatsAppFlow: jest.fn(async () => null),
      openNodePickerFromHandle: jest.fn(),
    };
  }

  function renderProvider(bridge: ReturnType<typeof createBridge>) {
    const contexts: ScenarioNodeEnrichmentContextValue[] = [];
    const tree = (next: ReturnType<typeof createBridge>) => (
      <ScenarioNodeEnrichmentProvider
        graph={{ nodes: graphNodes, edges: graphEdges }}
        resources={createResources() as never}
        nodeBridge={next as never}
        scenarioSettings={{}}
      >
        <ContextProbe onContext={ctx => contexts.push(ctx)} />
      </ScenarioNodeEnrichmentProvider>
    );
    const view = render(tree(bridge));
    return {
      contexts,
      rerender: (next: ReturnType<typeof createBridge>) =>
        view.rerender(tree(next)),
    };
  }

  it("runs a session's latest commands and never another session's", async () => {
    // Session A's commands refuse once B is loaded, as their owner-key
    // guards do in the flow controller.
    const firstA = sessionCommands("session-A", false);
    const latestA = sessionCommands("session-A", false);
    const sessionB = sessionCommands("session-B", true);
    const { contexts, rerender } = renderProvider(createBridge(firstA));
    const keptFromA = contexts.at(-1)!;

    rerender(createBridge(latestA));
    expect(contexts.at(-1)!.reconcileGeneratedJobServerUpdate).toBe(
      keptFromA.reconcileGeneratedJobServerUpdate
    );
    await keptFromA.prepareGeneratedJobRefresh();
    expect(latestA.prepareGeneratedJobRefresh).toHaveBeenCalledTimes(1);
    expect(firstA.prepareGeneratedJobRefresh).not.toHaveBeenCalled();

    rerender(createBridge(sessionB));
    const update = { generationJobId: "job-1", nodeUpdates: [] } as never;
    // A generation-job refresh that started in A and resolves after B loaded.
    await expect(
      keptFromA.reconcileGeneratedJobServerUpdate(update)
    ).resolves.toEqual({ status: "failed" });
    expect(keptFromA.adoptGeneratedBulkServerUpdate(update)).toBe(false);
    // A bulk send that started in A and resolves after B loaded.
    await expect(keptFromA.prepareScenarioBulkSend()).resolves.toBeNull();
    expect(
      keptFromA.adoptScenarioActivation({
        scenarioId: "scenario-a",
        scenarioUpdatedAt: "2026-09-30T12:00:00.000Z",
        previousScenarioUpdatedAt: null,
      })
    ).toBe(false);
    keptFromA.onScenarioActivationBlocked(["action-a"]);
    await expect(keptFromA.prepareGeneratedJobRefresh()).resolves.toBe(false);
    await expect(
      keptFromA.submitGeneratedTemplateForNode("action-a")
    ).resolves.toBe(false);
    // A template pick's form load that resolves after B loaded.
    await expect(
      keptFromA.loadWhatsAppTemplateForm("action-a", { reason: "pick" })
    ).resolves.toEqual({ status: "skipped" });
    await keptFromA.publishManagedWhatsAppFlow({ nodeId: "action-a" } as never);
    keptFromA.openNodePickerFromHandle("action-a", null, 1, 2);
    for (const command of [
      "adoptGeneratedBulkServerUpdate",
      "prepareScenarioBulkSend",
      "adoptScenarioActivation",
      "onScenarioActivationBlocked",
      "reconcileGeneratedJobServerUpdate",
      "prepareGeneratedJobRefresh",
      "submitGeneratedTemplateForNode",
      "loadWhatsAppTemplateForm",
      "publishManagedWhatsAppFlow",
      "openNodePickerFromHandle",
    ] as const) {
      expect(sessionB[command]).not.toHaveBeenCalled();
    }

    const inB = contexts.at(-1)!;
    expect(inB.reconcileGeneratedJobServerUpdate).not.toBe(
      keptFromA.reconcileGeneratedJobServerUpdate
    );
    await expect(
      inB.reconcileGeneratedJobServerUpdate(update)
    ).resolves.toEqual({ status: "applied" });
    expect(sessionB.reconcileGeneratedJobServerUpdate).toHaveBeenCalledTimes(1);
  });
});
