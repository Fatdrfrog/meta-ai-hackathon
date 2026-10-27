/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react";
import {
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  readSingleWhatsAppTemplateFlowButtonFlowId,
  type WhatsAppComponent,
} from "@icecore/scenario-contracts";
import { resolveScenarioGraphBlockingNodeIds } from "@/lib/scenarios/graph-validation";
import { resolveActionNodeFormSubmittedRoute } from "../nodes/action-node/action-node-state";
import type {
  ScenarioFlowEdge,
  ScenarioFlowNode,
  ScenarioNodeData,
  ScenarioWhatsAppTemplate,
} from "../types";
import type {
  ScenarioGraphEditor,
  ScenarioGraphSnapshot,
} from "./graph/controller-utils";
import { createGraphTestEdge, createGraphTestNode } from "./graph/test-utils";
import { enrichActionNodeData } from "./node-enrichment/action";
import { useScenarioGraphController } from "./use-scenario-graph-controller";

jest.mock("sonner", () => ({
  toast: Object.assign(jest.fn(), { error: jest.fn(), success: jest.fn() }),
}));

const FORM_SUBMITTED = ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID;
const FLOW_ID = "1571793974235171";
const components: WhatsAppComponent[] = [
  { type: "BODY", text: "Tell us about the athlete" },
  {
    type: "BUTTONS",
    buttons: [{ type: "FLOW", text: "Open form", flow_id: FLOW_ID }],
  },
];
/** The approved template, whose one FLOW button opens a form. */
const approvedTemplate: ScenarioWhatsAppTemplate = {
  id: "meta-1",
  name: "demoshop_test",
  language: "kk",
  category: "MARKETING",
  components,
};
/** An older step saved only the template's name and language. */
const olderStep: ScenarioNodeData = {
  kind: "action",
  actionType: "whatsapp_template",
  actionWhatsAppTemplateName: "demoshop_test",
  actionWhatsAppTemplateLanguage: "kk",
};
const savedStep: ScenarioNodeData = {
  ...olderStep,
  actionWhatsAppTemplateComponents: components,
};

const trigger = createGraphTestNode("trigger", { kind: "trigger" });
const thanks = createGraphTestNode("thanks", {
  kind: "action",
  actionType: "reply",
  actionReplyMode: "fixed",
  actionReplyText: "Thanks",
});
const sendTemplate = createGraphTestEdge("trigger", "template");
const formRoute = createGraphTestEdge("template", "thanks", {
  sourceHandle: FORM_SUBMITTED,
});
const formConnection = {
  source: "template",
  target: "thanks",
  sourceHandle: FORM_SUBMITTED,
  targetHandle: null,
};

function createActionContext(linkedSourceHandleIds: string[]) {
  return {
    graphIndex: {
      connectedSourceHandleIdsByNodeId: new Map([
        ["template", linkedSourceHandleIds],
      ]),
      connectedTelegramBranchPayloadsByActionId: new Map(),
      connectedInstagramBranchPayloadsByActionId: new Map(),
      connectedWhatsAppSessionChoicePayloadsByActionId: new Map(),
      connectedFlowBranchIdsByActionId: new Map(),
      connectedWhatsAppTemplateButtonPayloadsByActionId: new Map(),
      previewProfileByActionId: new Map(),
      bulkPrimaryActionIds: new Set<string>(),
      bulkRouteRecipientsByActionId: new Map(),
      instagramReplyActionIdsBlockedByBulkRoot: new Set<string>(),
      postActionConditionScopeByNodeId: new Map(),
      scenarioPromptInputsByNodeId: new Map(),
    },
    callbacksRef: { current: { updateNodeById: jest.fn() } },
    handleBranchSyncForNodeRef: { current: jest.fn() },
    openNodePickerFromHandle: jest.fn(),
    connectedActionSources: [],
    whatsAppTemplates: [approvedTemplate],
    whatsAppFlows: [],
    audienceOptions: { channels: [] },
    t: (key: string) => key,
    workspaceId: "workspace-1",
    legacyRoutingByActionId: new Map(),
  } as never;
}

/** The step as the canvas shows it, and its Form submitted route. */
function showStep(
  data: ScenarioNodeData,
  linkedSourceHandleIds: string[] = []
) {
  const shown = enrichActionNodeData(
    "template",
    data as never,
    createActionContext(linkedSourceHandleIds)
  );
  return { shown, route: resolveActionNodeFormSubmittedRoute(shown) };
}

/** The canvas's graph controller, connecting with the approved templates. */
function renderController(
  nodes: ScenarioFlowNode[],
  edges: ScenarioFlowEdge[]
) {
  let graph: ScenarioGraphSnapshot = { nodes, edges };
  const commits: ScenarioGraphSnapshot[] = [];
  const graphEditor: ScenarioGraphEditor = {
    read: () => graph,
    edit: transition => {
      const next = transition(graph);
      if (!next) return false;
      graph = { nodes: next.nodes, edges: next.edges };
      commits.push(graph);
      return true;
    },
  };
  const { result } = renderHook(() =>
    useScenarioGraphController({
      flowWrapperRef: { current: null },
      screenToFlowPosition: position => position,
      graphEditor,
      nodes,
      edges,
      setSelectedNodeId: jest.fn(),
      whatsAppTemplates: [approvedTemplate],
      t: key => key,
    })
  );
  return { result, commits, read: () => graph };
}

// Graph validation and the runtime read the saved step's FLOW button, so the
// canvas offers and connects the route only as the saved step allows.
describe("a template's Form submitted route follows the saved step", () => {
  it("is not offered on a step saved without buttons, and connecting it is refused as activation refuses it", () => {
    const { shown, route } = showStep(olderStep);
    // The step shows the approved template's form button...
    expect(
      readSingleWhatsAppTemplateFlowButtonFlowId(
        shown.actionWhatsAppTemplateComponents
      )
    ).toBe(FLOW_ID);
    // ...but its saved data opens no form, so it gets no route row.
    expect(route).toEqual({ placement: "none", connected: false });

    const nodes = [trigger, createGraphTestNode("template", olderStep), thanks];
    const controller = renderController(nodes, [sendTemplate]);
    expect(controller.result.current.isValidConnection(formConnection)).toBe(
      false
    );
    act(() => {
      controller.result.current.onConnect(formConnection);
    });
    expect(controller.commits).toHaveLength(0);
    expect(controller.read().edges).toEqual([sendTemplate]);
    // The edge connecting would have drawn is one activation refuses.
    expect(
      resolveScenarioGraphBlockingNodeIds(
        nodes,
        [sendTemplate, formRoute],
        "whatsappTemplateFormRouteUnavailable"
      )
    ).toEqual(["template"]);
  });

  it("keeps only a flagged anchor for an edge such a step already has", () => {
    expect(showStep(olderStep, [FORM_SUBMITTED]).route).toEqual({
      placement: "anchor",
      connected: true,
      error: "whatsappTemplateFormRouteUnavailable",
    });
  });

  it("is offered and connects once the step saved the form button", () => {
    expect(showStep(savedStep).route).toEqual({
      placement: "row",
      connected: false,
    });

    const nodes = [trigger, createGraphTestNode("template", savedStep), thanks];
    const controller = renderController(nodes, [sendTemplate]);
    expect(controller.result.current.isValidConnection(formConnection)).toBe(
      true
    );
    act(() => {
      controller.result.current.onConnect(formConnection);
    });
    const graph = controller.read();
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        source: "template",
        sourceHandle: FORM_SUBMITTED,
        target: "thanks",
      })
    );
    expect(
      resolveScenarioGraphBlockingNodeIds(
        graph.nodes,
        graph.edges,
        "whatsappTemplateFormRouteUnavailable"
      )
    ).toEqual([]);
  });
});
