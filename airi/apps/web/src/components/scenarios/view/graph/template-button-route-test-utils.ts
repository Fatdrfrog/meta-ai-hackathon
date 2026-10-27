/**
 * Test support for the "template reply-button routes are keyed by button, not
 * position" regression tests (fix/template-button-routes).
 *
 * Every step goes through the code the builder itself runs, so the tests keep
 * describing author actions rather than today's handle or payload format:
 * - a route is connected with the connect-time binding (onConnect →
 *   resolveBranchBindingForConnection), on the handle the node offers for
 *   that button;
 * - a "Form submitted" route is connected with onConnect's planner
 *   (resolveScenarioConnectionPlan);
 * - a button is removed and saved with the inline template editor's own form
 *   helpers and patch shape (use-whatsapp-template-editor.ts removeButton →
 *   setButtons → save), then synced through transitionBranchNodes with the
 *   descriptors node-enrichment/action.ts passes (uiOnPatch).
 */
import {
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  type WhatsAppComponent,
} from "@icecore/scenario-contracts";
import { buildWhatsAppTemplateFormAlignmentPatch } from "@/lib/scenarios/whatsapp-template-flow";
import {
  buildWhatsAppTemplateEditorSave,
  buildWhatsAppTemplateEditorSavePatch,
  ensureWhatsAppTemplateBodyComponent,
  getEditableWhatsAppTemplateEditorFormValues,
  type EditableWhatsAppTemplateButton,
} from "../../builders/whatsapp/template-editor-utils";
import { reindexEditableTemplateButtons } from "../../nodes/action-node/action-node-template-editor";
import type {
  ScenarioFlowEdge,
  ScenarioFlowNode,
  ScenarioNodeData,
} from "../../types";
import {
  FLOW_BRANCH_DESCRIPTOR,
  INSTAGRAM_BRANCH_DESCRIPTOR,
  resolveBranchBindingForConnection,
  TELEGRAM_BRANCH_DESCRIPTOR,
  transitionBranchNodes,
  WHATSAPP_SERVICE_MESSAGE_BRANCH_DESCRIPTOR,
  WHATSAPP_TEMPLATE_BUTTON_BRANCH_DESCRIPTOR,
} from "./branch-sync";
import { resolveScenarioConnectionPlan } from "./controller-utils";
import { createGraphTestEdge, createGraphTestNode } from "./test-utils";

export type TemplateRouteGraph = {
  nodes: ScenarioFlowNode[];
  edges: ScenarioFlowEdge[];
};

export type TemplateTestButton =
  | { type: "QUICK_REPLY"; text: string }
  | { type: "URL"; text: string; url: string }
  | { type: "FLOW"; text: string; flow_id: string; flow_action: "navigate" };

export const TEMPLATE_ACTION_ID = "menu";

const TEMPLATE = WHATSAPP_TEMPLATE_BUTTON_BRANCH_DESCRIPTOR;

/** The descriptors uiOnPatch hands to branch sync on a template save. */
const TEMPLATE_SAVE_DESCRIPTORS = [
  FLOW_BRANCH_DESCRIPTOR,
  TELEGRAM_BRANCH_DESCRIPTOR,
  INSTAGRAM_BRANCH_DESCRIPTOR,
  WHATSAPP_SERVICE_MESSAGE_BRANCH_DESCRIPTOR,
  WHATSAPP_TEMPLATE_BUTTON_BRANCH_DESCRIPTOR,
];

export function quickReply(text: string): TemplateTestButton {
  return { type: "QUICK_REPLY", text };
}

export function urlButton(text: string): TemplateTestButton {
  return { type: "URL", text, url: "https://shop.test/plans" };
}

/** A FLOW button opening the DemoShop form. */
export function formButton(
  text: string,
  flowId = "1571793974235171"
): TemplateTestButton {
  return { type: "FLOW", text, flow_id: flowId, flow_action: "navigate" };
}

export function templateComponents(
  buttons: TemplateTestButton[]
): WhatsAppComponent[] {
  return [
    { type: "BODY", text: "Which plan do you want?" },
    { type: "BUTTONS", buttons },
  ] as WhatsAppComponent[];
}

export function templateActionData(
  buttons: TemplateTestButton[]
): ScenarioNodeData {
  return {
    kind: "action",
    actionType: "whatsapp_template",
    actionWhatsAppTemplateName: "pick_plan",
    actionWhatsAppTemplateLanguage: "en",
    actionWhatsAppTemplateCategory: "MARKETING",
    actionReplyText: "Which plan do you want?",
    actionWhatsAppTemplateComponents: templateComponents(buttons),
  };
}

function templateAction(graph: TemplateRouteGraph): ScenarioFlowNode {
  const action = graph.nodes.find(node => node.id === TEMPLATE_ACTION_ID);
  if (!action) throw new Error("template action is missing from the graph");
  return action;
}

/** The route option the template node currently offers for this button. */
export function templateButtonOption(graph: TemplateRouteGraph, label: string) {
  return (
    TEMPLATE.extractOptions(
      templateAction(graph).data as ScenarioNodeData,
      TEMPLATE_ACTION_ID
    ).find(option => option.label === label) ?? null
  );
}

/** The route handle the template node currently shows for this button. */
export function templateButtonHandle(
  graph: TemplateRouteGraph,
  label: string
): string | null {
  const option = templateButtonOption(graph, label);
  return option ? TEMPLATE.buildSourceHandleForOption(option) : null;
}

/**
 * Drags a route from the reply button with this label to a new follow-up,
 * binding it exactly as onConnect does.
 */
export function connectTemplateButtonRoute(
  graph: TemplateRouteGraph,
  label: string,
  followUpId: string
): TemplateRouteGraph {
  const action = templateAction(graph);
  const requestedSourceHandle = templateButtonHandle(graph, label);
  if (!requestedSourceHandle) {
    throw new Error(`the template has no reply button labelled "${label}"`);
  }
  const followUp = createGraphTestNode(followUpId, {
    kind: "action",
    actionType: "reply",
    actionReplyMode: "fixed",
    actionReplyText: `${label} follow-up`,
  });
  const binding = resolveBranchBindingForConnection({
    sourceNode: action,
    targetNode: followUp,
    nodes: [...graph.nodes, followUp],
    edges: graph.edges,
    requestedSourceHandle,
  });
  if (!binding?.patch || !binding.sourceHandleId) {
    throw new Error(`the builder refused a route from "${label}"`);
  }
  return {
    nodes: [
      ...graph.nodes,
      { ...followUp, data: { ...followUp.data, ...binding.patch } },
    ],
    edges: [
      ...graph.edges,
      createGraphTestEdge(TEMPLATE_ACTION_ID, followUpId, {
        id: `route-${followUpId}`,
        sourceHandle: binding.sourceHandleId,
      }),
    ],
  };
}

/**
 * Drags the template's "Form submitted" route to a new next step, planned
 * exactly as onConnect plans it.
 */
export function connectTemplateFormSubmittedRoute(
  graph: TemplateRouteGraph,
  nextStepId: string
): TemplateRouteGraph {
  const nextStep = createGraphTestNode(nextStepId, {
    kind: "action",
    actionType: "reply",
    actionReplyMode: "fixed",
    actionReplyText: "Thanks for the form",
  });
  const nodes = [...graph.nodes, nextStep];
  const plan = resolveScenarioConnectionPlan({
    connection: {
      sourceHandle: ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
    },
    sourceNode: templateAction(graph),
    targetNode: nextStep,
    nodes,
    edges: graph.edges,
  });
  if (plan?.kind !== "valid") {
    throw new Error("the builder refused the Form submitted route");
  }
  return {
    nodes,
    edges: [
      ...graph.edges,
      createGraphTestEdge(TEMPLATE_ACTION_ID, nextStepId, {
        id: `route-${nextStepId}`,
        sourceHandle: plan.sourceHandleId,
      }),
    ],
  };
}

/** The steps the template's "Form submitted" route leads to. */
export function formSubmittedNextSteps(graph: TemplateRouteGraph): string[] {
  return graph.edges
    .filter(
      edge =>
        edge.source === TEMPLATE_ACTION_ID &&
        edge.sourceHandle === ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID
    )
    .map(edge => edge.target);
}

/** A trigger → template graph with each labelled reply button routed. */
export function buildTemplateRouteGraph(params: {
  buttons: TemplateTestButton[];
  routes: Array<[label: string, followUpId: string]>;
  triggerNode?: ScenarioFlowNode;
}): TemplateRouteGraph {
  let graph: TemplateRouteGraph = {
    nodes: [
      ...(params.triggerNode ? [params.triggerNode] : []),
      createGraphTestNode(
        TEMPLATE_ACTION_ID,
        templateActionData(params.buttons)
      ),
    ],
    edges: params.triggerNode
      ? [
          createGraphTestEdge(params.triggerNode.id, TEMPLATE_ACTION_ID, {
            id: "trigger-to-menu",
          }),
        ]
      : [],
  };
  for (const [label, followUpId] of params.routes) {
    graph = connectTemplateButtonRoute(graph, label, followUpId);
  }
  return graph;
}

/**
 * The patch the inline template editor sends after the author edits the
 * button rows and clicks Save (applySavedTemplate).
 */
export function inlineEditorSave(
  actionData: ScenarioNodeData,
  edit: (
    buttons: EditableWhatsAppTemplateButton[]
  ) => EditableWhatsAppTemplateButton[]
): Partial<ScenarioNodeData> {
  const components = ensureWhatsAppTemplateBodyComponent(
    actionData.actionWhatsAppTemplateComponents
  );
  const values = getEditableWhatsAppTemplateEditorFormValues({
    replyText: actionData.actionReplyText,
    components,
    buttonIds: actionData.actionWhatsAppTemplateButtonIds,
  });
  const saved = buildWhatsAppTemplateEditorSave({
    components,
    buttonIds: actionData.actionWhatsAppTemplateButtonIds,
    values: {
      ...values,
      buttons: reindexEditableTemplateButtons(edit(values.buttons)),
    },
  });
  return {
    ...buildWhatsAppTemplateEditorSavePatch(
      saved,
      actionData.actionWhatsAppTemplateCategory
    ),
    ...buildWhatsAppTemplateFormAlignmentPatch(actionData, saved.components),
  };
}

/**
 * The patch the inline template editor sends after the author removes the
 * button with this label and clicks Save.
 */
export function inlineEditorSaveWithoutButton(
  actionData: ScenarioNodeData,
  label: string
): Partial<ScenarioNodeData> {
  return inlineEditorSave(actionData, buttons => {
    const removed = buttons.find(button => button.label === label);
    if (!removed) {
      throw new Error(`the editor shows no button labelled "${label}"`);
    }
    return buttons.filter(button => button.index !== removed.index);
  });
}

/** Removes one button in the inline editor, saves, and returns the synced graph. */
export function removeTemplateButtonAndSave(
  graph: TemplateRouteGraph,
  label: string
): TemplateRouteGraph {
  const result = transitionBranchNodes({
    actionNodeId: TEMPLATE_ACTION_ID,
    nodes: graph.nodes,
    edges: graph.edges,
    descriptors: TEMPLATE_SAVE_DESCRIPTORS,
    actionNodePatch: inlineEditorSaveWithoutButton(
      templateAction(graph).data as ScenarioNodeData,
      label
    ),
  });
  return { nodes: result.nodes, edges: result.edges };
}

/** Follow-ups wired to this reply button's route, as the builder now shows it. */
export function followUpsOfButton(
  graph: TemplateRouteGraph,
  label: string
): string[] {
  const handle = templateButtonHandle(graph, label);
  if (!handle) return [];
  return graph.edges
    .filter(
      edge => edge.source === TEMPLATE_ACTION_ID && edge.sourceHandle === handle
    )
    .map(edge => edge.target)
    .sort();
}

/** The reply button a follow-up node says it belongs to, if any. */
export function buttonBoundToFollowUp(
  graph: TemplateRouteGraph,
  followUpId: string
): string | null {
  const followUp = graph.nodes.find(node => node.id === followUpId);
  if (!followUp) return null;
  const branchId = TEMPLATE.getBranchId(followUp.data as ScenarioNodeData);
  if (!branchId) return null;
  return (
    TEMPLATE.extractOptions(
      templateAction(graph).data as ScenarioNodeData,
      TEMPLATE_ACTION_ID
    ).find(option => option.id === branchId)?.label ?? null
  );
}
