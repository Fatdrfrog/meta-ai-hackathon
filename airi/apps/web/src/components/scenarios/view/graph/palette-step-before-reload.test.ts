/**
 * A step made from the palette's Reply keeps its message key, set to
 * undefined, when the builder changes its type, until a save drops the key.
 * Each reader of the step sees it in the open session as it will after a
 * reload. Graphs are built and edited through the builder's own code, as in
 * template-button-writers.test.ts.
 */
import { DEMOSHOP_FLOW_JSON } from "@/components/scenarios/builders/whatsapp/flow-json-fixtures";
import { resolvePendingConditionEventDisposition } from "@/lib/airi/interactive-no-reply";
import {
  buildSentScenarioFormAnswerSourcesByNodeId,
  buildWhatsAppOnlyScenarioFormSourcesByNodeId,
  listUnavailableScenarioFormAnswerTokensByNodeId,
  readScenarioFormAnswerPrompt,
} from "@/lib/scenarios/scenario-form-answer-checks";
import { normalizeScenarioNodesForPersistence } from "@/lib/scenarios/scenario-graph-persistence";
import { applyScenarioWhatsAppInteractiveFlowSelectionToNode } from "@/lib/scenarios/whatsapp-flow-projection";
import { resolveScenarioWhatsAppInteractiveFlowTarget } from "@/lib/scenarios/whatsapp-service-message";
import { buildWhatsAppTemplateFormSnapshotPatch } from "@/lib/scenarios/whatsapp-template-form-snapshot";
import {
  buildTemplateFormAnswerSchema,
  type TemplateFormAnswerSchema,
} from "@/lib/whatsapp/flows/template-form-answer-schema";
import { getWhatsAppTemplateOptionValue } from "@/lib/whatsapp/templates/selection";
import {
  readScenarioActionForm,
  type WhatsAppFlowConfig,
} from "@icecore/scenario-contracts";
import {
  resolveActionPreview,
  resolveCompactActionTitle,
} from "../../scenario-node-labels";
import type {
  ScenarioActionSelectorType,
  ScenarioNodeData,
  ScenarioWhatsAppTemplate,
} from "../../types";
import {
  buildActionPatchForSelector,
  buildActionWhatsAppTemplateSelectionPatch,
  resolveDefaultReplyActionPatch,
} from "../action/selector-utils";
import {
  ACTION_BRANCH_DESCRIPTORS,
  transitionBranchNodes,
} from "./branch-sync";
import {
  connectTemplateFormSubmittedRoute,
  formButton,
  TEMPLATE_ACTION_ID,
  templateComponents,
  type TemplateRouteGraph,
} from "./template-button-route-test-utils";
import { createGraphTestEdge, createGraphTestNode } from "./test-utils";

/** The Flow formButton opens. */
const FLOW_ID = "1571793974235171";
const FORM_TOKEN = "form.demoshop_ai_case.f_68d224";
const t = (key: string) => key;

const FORM_TEMPLATE: ScenarioWhatsAppTemplate = {
  id: "meta-form",
  name: "demoshop_test",
  language: "ru",
  category: "MARKETING",
  components: templateComponents([formButton("Open form")]),
};

/** The form linked from Meta, as "Use an existing form" links it. */
const LINKED_FLOW: WhatsAppFlowConfig = {
  templateId: "linked-flow",
  ctaText: "Open form",
  screens: [],
  providerReference: {
    flowId: FLOW_ID,
    sourceId: "source-1",
    wabaId: "waba-1",
    flowName: "demoshop_ai_case",
    providerStatus: "PUBLISHED",
  },
};

function stepData(graph: TemplateRouteGraph, id = TEMPLATE_ACTION_ID) {
  const step = graph.nodes.find(node => node.id === id);
  if (!step) throw new Error(`the step "${id}" is missing`);
  return step.data as ScenarioNodeData;
}

function applyPatch(
  graph: TemplateRouteGraph,
  actionNodePatch: Partial<ScenarioNodeData>
): TemplateRouteGraph {
  const result = transitionBranchNodes({
    actionNodeId: TEMPLATE_ACTION_ID,
    nodes: graph.nodes,
    edges: graph.edges,
    descriptors: ACTION_BRANCH_DESCRIPTORS,
    actionNodePatch,
  });
  return { nodes: result.nodes, edges: result.edges };
}

/** A palette Reply step, its type then changed in the step's type menu. */
function paletteStepAs(
  selectorType: ScenarioActionSelectorType
): TemplateRouteGraph {
  const reply: TemplateRouteGraph = {
    nodes: [
      createGraphTestNode(TEMPLATE_ACTION_ID, {
        kind: "action",
        ...resolveDefaultReplyActionPatch(["whatsapp"]),
      }),
    ],
    edges: [],
  };
  const switched = applyPatch(
    reply,
    buildActionPatchForSelector({
      nodeData: stepData(reply),
      selectorType,
    })
  );
  // The premise: the key is still on the step, set to undefined.
  expect(
    Object.hasOwn(stepData(switched), "actionWhatsAppServiceMessage")
  ).toBe(true);
  expect(stepData(switched).actionWhatsAppServiceMessage).toBeUndefined();
  return switched;
}

/** Picks the form template, then loads its form's fields as the loader does. */
function pickFormTemplateAndLoadForm(): TemplateRouteGraph {
  const switched = paletteStepAs("whatsapp_template");
  const picked = applyPatch(
    switched,
    buildActionWhatsAppTemplateSelectionPatch({
      nodeData: stepData(switched),
      templateValue: getWhatsAppTemplateOptionValue(FORM_TEMPLATE),
      whatsAppTemplates: [FORM_TEMPLATE],
    })!
  );
  const loaded = buildWhatsAppTemplateFormSnapshotPatch({
    nodes: picked.nodes,
    edges: picked.edges,
    nodeId: TEMPLATE_ACTION_ID,
    flowId: FLOW_ID,
    schema: buildTemplateFormAnswerSchema({
      flowJson: DEMOSHOP_FLOW_JSON,
      flowName: "demoshop_ai_case",
    }) as TemplateFormAnswerSchema,
    readAt: "2026-10-05T10:00:00.000Z",
  });
  if (!loaded || !("patch" in loaded)) {
    throw new Error("the form's fields did not load");
  }
  return {
    nodes: picked.nodes.map(node =>
      node.id === TEMPLATE_ACTION_ID
        ? { ...node, data: { ...node.data, ...loaded.patch } }
        : node
    ),
    edges: picked.edges,
  };
}

/** The step's Form submitted route leads to an AI reply reading the form. */
function withAiReplyAfterForm(graph: TemplateRouteGraph): TemplateRouteGraph {
  const routed = connectTemplateFormSubmittedRoute(graph, "thanks");
  return {
    ...routed,
    nodes: routed.nodes.map(node =>
      node.id === "thanks"
        ? {
            ...node,
            data: {
              ...node.data,
              actionReplyMode: "ai",
              actionReplyInstruction: `Thank {{${FORM_TOKEN}}} for the order`,
            },
          }
        : node
    ),
  };
}

/** The graph as a save sends it and a reload reads it back. */
function reloaded(graph: TemplateRouteGraph): TemplateRouteGraph {
  return JSON.parse(JSON.stringify(graph)) as TemplateRouteGraph;
}

describe("a template step made from the palette Reply, before a reload", () => {
  it("offers its loaded form's answers to the AI step after it", () => {
    const graph = withAiReplyAfterForm(pickFormTemplateAndLoadForm());

    expect(readScenarioActionForm(stepData(graph))).toEqual(
      readScenarioActionForm(stepData(reloaded(graph)))
    );
    expect(readScenarioActionForm(stepData(graph))?.sender).toBe("template");
    expect(readScenarioFormAnswerPrompt(stepData(graph, "thanks"))).toContain(
      `{{${FORM_TOKEN}}}`
    );
    expect(listUnavailableScenarioFormAnswerTokensByNodeId(graph)).toEqual(
      new Map()
    );
    const sources =
      buildSentScenarioFormAnswerSourcesByNodeId(graph).get("thanks");
    expect(sources?.map(source => [source.nodeId, source.formKey])).toEqual([
      [TEMPLATE_ACTION_ID, "demoshop_ai_case"],
    ]);
    expect(sources?.[0]?.fields.map(field => field.key)).toContain("f_68d224");
    expect(sources).toEqual(
      buildSentScenarioFormAnswerSourcesByNodeId(reloaded(graph)).get("thanks")
    );
  });

  it("takes a linked form, owns its Flow and its Flow's replies", () => {
    const graph = pickFormTemplateAndLoadForm();
    const step = graph.nodes.find(node => node.id === TEMPLATE_ACTION_ID)!;
    const linked = applyScenarioWhatsAppInteractiveFlowSelectionToNode(
      step,
      LINKED_FLOW
    );

    expect(linked?.data.actionFlowConfig).toEqual(LINKED_FLOW);
    expect(resolveScenarioWhatsAppInteractiveFlowTarget(linked!.data)).toEqual({
      config: LINKED_FLOW,
      owner: "template",
    });
    expect(
      resolvePendingConditionEventDisposition({
        triggerEventKind: "whatsapp_flow_reply",
        conditionNodeData: {
          kind: "logic",
          logicType: "post_action_condition",
        },
        pendingSourceActionData: linked!.data,
      })
    ).toBe("interactive_reply");
  });

  it("is titled by its template and saved as a template", () => {
    const graph = pickFormTemplateAndLoadForm();

    expect(
      resolveCompactActionTitle({
        actionLabel: "WhatsApp template",
        actionType: "whatsapp_template",
        nodeData: stepData(graph),
      })
    ).toBe("demoshop_test");
    const persisted = (nodes: TemplateRouteGraph["nodes"]) =>
      normalizeScenarioNodesForPersistence(
        nodes
      ) as TemplateRouteGraph["nodes"];
    const saved = stepData({ nodes: persisted(graph.nodes), edges: [] });
    expect(saved.actionType).toBe("whatsapp_template");
    expect(saved.actionWhatsAppTemplateName).toBe("demoshop_test");
    expect(saved).not.toHaveProperty("actionWhatsAppServiceMessage");
    expect(saved).toEqual(
      stepData({ nodes: persisted(reloaded(graph).nodes), edges: [] })
    );
  });
});

describe("a plain reply made from the palette Reply, before a reload", () => {
  /** The reply, then a step after it. */
  function replyThen(patch: Partial<ScenarioNodeData>): TemplateRouteGraph {
    const reply = applyPatch(paletteStepAs("reply"), patch);
    return {
      nodes: [
        ...reply.nodes,
        createGraphTestNode("next", {
          kind: "action",
          actionType: "reply",
          actionReplyMode: "fixed",
          actionReplyText: "Next",
        }),
      ],
      edges: [createGraphTestEdge(TEMPLATE_ACTION_ID, "next")],
    };
  }

  it("shows its text", () => {
    const graph = replyThen({ actionReplyText: "See you soon" });

    expect(resolveActionPreview({ nodeData: stepData(graph), t })).toEqual({
      text: "See you soon",
      state: "content",
    });
  });

  it("names the form answers its AI instructions read that no form gives", () => {
    const graph = replyThen({
      actionReplyMode: "ai",
      actionReplyInstruction: `Thank {{${FORM_TOKEN}}}`,
    });

    expect(listUnavailableScenarioFormAnswerTokensByNodeId(graph)).toEqual(
      new Map([[TEMPLATE_ACTION_ID, [FORM_TOKEN]]])
    );
    expect(listUnavailableScenarioFormAnswerTokensByNodeId(graph)).toEqual(
      listUnavailableScenarioFormAnswerTokensByNodeId(reloaded(graph))
    );
  });

  it("counts its Flow button as a form built only in WhatsApp", () => {
    const graph = replyThen({
      actionReplyCtaType: "flow",
      actionReplyCtaLabel: "Open form",
      actionReplyCtaFlowId: FLOW_ID,
    });

    const sources = buildWhatsAppOnlyScenarioFormSourcesByNodeId(graph);
    expect(sources.get("next")?.map(source => source.nodeId)).toEqual([
      TEMPLATE_ACTION_ID,
    ]);
    expect(sources).toEqual(
      buildWhatsAppOnlyScenarioFormSourcesByNodeId(reloaded(graph))
    );
  });
});
