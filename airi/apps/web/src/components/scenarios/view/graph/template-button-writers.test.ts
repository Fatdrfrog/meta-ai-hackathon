/**
 * The writers of a template step's button ids (fix/template-button-routes):
 * the inline editor's Save, a template re-pick, and branch sync. Graphs are
 * built and edited through the builder's own code, as in
 * template-button-routes.test.ts.
 */
import {
  MEDAL_FLOW_ID,
  medalTemplateForm,
} from "@/lib/scenarios/__tests__/scenario-form-fixtures";
import { normalizeScenarioNodesForPersistence } from "@/lib/scenarios/scenario-graph-persistence";
import { getWhatsAppTemplateOptionValue } from "@/lib/whatsapp/templates/selection";
import {
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  getScenarioActionBranchDelay,
  readScenarioActionForm,
  withScenarioActionBranchDelay,
  type WhatsAppFlowConfig,
} from "@icecore/scenario-contracts";
import type { EditableWhatsAppTemplateButton } from "../../builders/whatsapp/template-editor-utils";
import { resolveAvailableSourceHandleIds } from "../../graph/source-handles";
import {
  applyEditableTemplateButtonPatch,
  createEditableTemplateButton,
} from "../../nodes/action-node/action-node-template-editor";
import type { ScenarioNodeData, ScenarioWhatsAppTemplate } from "../../types";
import {
  buildActionPatchForSelector,
  buildActionWhatsAppTemplateSelectionPatch,
  resolveDefaultReplyActionPatch,
} from "../action/selector-utils";
import {
  ACTION_BRANCH_DESCRIPTORS,
  transitionBranchNodes,
  type BranchTransitionResult,
} from "./branch-sync";
import {
  buildTemplateRouteGraph,
  buttonBoundToFollowUp,
  connectTemplateFormSubmittedRoute,
  followUpsOfButton,
  formButton,
  formSubmittedNextSteps,
  inlineEditorSave,
  inlineEditorSaveWithoutButton,
  quickReply,
  removeTemplateButtonAndSave,
  TEMPLATE_ACTION_ID,
  templateButtonHandle,
  templateComponents,
  type TemplateRouteGraph,
} from "./template-button-route-test-utils";
import { createGraphTestNode } from "./test-utils";

function planMenu(): TemplateRouteGraph {
  return buildTemplateRouteGraph({
    buttons: [quickReply("Basic"), quickReply("Premium")],
    routes: [
      ["Basic", "basic-follow-up"],
      ["Premium", "premium-follow-up"],
    ],
  });
}

function menuData(graph: TemplateRouteGraph): ScenarioNodeData {
  const menu = graph.nodes.find(node => node.id === TEMPLATE_ACTION_ID);
  if (!menu) throw new Error("the template step is missing");
  return menu.data as ScenarioNodeData;
}

function applyPatch(
  graph: TemplateRouteGraph,
  actionNodePatch: Partial<ScenarioNodeData>
): BranchTransitionResult {
  return transitionBranchNodes({
    actionNodeId: TEMPLATE_ACTION_ID,
    nodes: graph.nodes,
    edges: graph.edges,
    descriptors: ACTION_BRANCH_DESCRIPTORS,
    actionNodePatch,
  });
}

/** Picks the template in the step's template picker. */
function pick(graph: TemplateRouteGraph, template: ScenarioWhatsAppTemplate) {
  return applyPatch(
    graph,
    buildActionWhatsAppTemplateSelectionPatch({
      nodeData: menuData(graph),
      templateValue: getWhatsAppTemplateOptionValue(template),
      whatsAppTemplates: [template],
    })!
  );
}

/** Edits the rows in the inline editor, then saves as the editor does. */
function saveInlineEditor(
  graph: TemplateRouteGraph,
  edit: (
    buttons: EditableWhatsAppTemplateButton[]
  ) => EditableWhatsAppTemplateButton[]
): BranchTransitionResult {
  return applyPatch(graph, inlineEditorSave(menuData(graph), edit));
}

/** Turns the reply button with this label into a link button. */
function toLink(label: string) {
  return (buttons: EditableWhatsAppTemplateButton[]) =>
    buttons.map(button =>
      button.label === label
        ? applyEditableTemplateButtonPatch(
            applyEditableTemplateButtonPatch(button, { type: "url" }),
            { value: "https://shop.test/plans" }
          )
        : button
    );
}

function withBranchDelayOn(
  graph: TemplateRouteGraph,
  label: string
): TemplateRouteGraph {
  const handle = templateButtonHandle(graph, label);
  if (!handle) throw new Error(`the template has no button "${label}"`);
  return {
    ...graph,
    nodes: graph.nodes.map(node =>
      node.id === TEMPLATE_ACTION_ID
        ? {
            ...node,
            data: {
              ...node.data,
              actionOutcomes: withScenarioActionBranchDelay(
                node.data.actionOutcomes ?? { version: 1 },
                handle,
                { delayMinutes: 30 }
              ),
            },
          }
        : node
    ),
  };
}

function persistedMenuData(graph: TemplateRouteGraph) {
  const menu = normalizeScenarioNodesForPersistence(graph.nodes).find(
    node => (node as { id?: string }).id === TEMPLATE_ACTION_ID
  ) as { data: ScenarioNodeData };
  return menu.data;
}

describe("template step button id writers", () => {
  it("keeps today's handles and stores no ids when the buttons stay in place", () => {
    const graph = planMenu();
    const saved = saveInlineEditor(graph, buttons =>
      buttons.map(button =>
        button.label === "Basic" ? { ...button, label: "Starter" } : button
      )
    );

    expect(menuData(saved).actionWhatsAppTemplateButtonIds).toBeUndefined();
    expect(templateButtonHandle(saved, "Starter")).toBe(
      templateButtonHandle(graph, "Basic")
    );
    expect(followUpsOfButton(saved, "Starter")).toEqual(["basic-follow-up"]);
    expect(saved.removedRoutes).toEqual([]);
  });

  it("gives a button added after a delete a new handle, not the removed button's", () => {
    const graph = planMenu();
    const basicHandle = templateButtonHandle(graph, "Basic");
    const premiumHandle = templateButtonHandle(graph, "Premium");
    const withoutBasic = removeTemplateButtonAndSave(graph, "Basic");

    const withGold = saveInlineEditor(withoutBasic, buttons => [
      ...buttons,
      { ...createEditableTemplateButton(buttons.length), label: "Gold" },
    ]);

    const goldHandle = templateButtonHandle(withGold, "Gold");
    expect(goldHandle).not.toBeNull();
    expect(goldHandle).not.toBe(basicHandle);
    expect(goldHandle).not.toBe(premiumHandle);
    expect(followUpsOfButton(withGold, "Gold")).toEqual([]);
    expect(followUpsOfButton(withGold, "Premium")).toEqual([
      "premium-follow-up",
    ]);
    expect(buttonBoundToFollowUp(withGold, "basic-follow-up")).toBeNull();
  });

  it("keeps the route of a button switched to a link and back before Save", () => {
    const saved = saveInlineEditor(planMenu(), buttons =>
      buttons.map(button =>
        button.label === "Basic"
          ? applyEditableTemplateButtonPatch(
              applyEditableTemplateButtonPatch(button, { type: "url" }),
              { type: "quick_reply" }
            )
          : button
      )
    );

    expect(followUpsOfButton(saved, "Basic")).toEqual(["basic-follow-up"]);
    expect(followUpsOfButton(saved, "Premium")).toEqual(["premium-follow-up"]);
    expect(saved.removedRoutes).toEqual([]);
  });

  it("names the route Save removes and keeps its next step on the canvas", () => {
    const saved = saveInlineEditor(planMenu(), toLink("Basic"));

    expect(saved.removedRoutes).toEqual([
      {
        descriptorKind: "whatsapp_template_button",
        label: "Basic",
        targetNodeId: "basic-follow-up",
      },
    ]);
    expect(saved.nodes.map(node => node.id)).toContain("basic-follow-up");
    expect(buttonBoundToFollowUp(saved, "basic-follow-up")).toBeNull();
    expect(followUpsOfButton(saved, "Premium")).toEqual(["premium-follow-up"]);
  });

  it("removes a removed button's delay and keeps the remaining button's", () => {
    const graph = withBranchDelayOn(
      withBranchDelayOn(planMenu(), "Basic"),
      "Premium"
    );
    const basicHandle = templateButtonHandle(graph, "Basic")!;
    const premiumHandle = templateButtonHandle(graph, "Premium")!;

    const saved = removeTemplateButtonAndSave(graph, "Basic");
    const outcomes = menuData(saved).actionOutcomes;

    expect(getScenarioActionBranchDelay(outcomes, basicHandle)).toBeNull();
    expect(getScenarioActionBranchDelay(outcomes, premiumHandle)).toMatchObject(
      { delayMinutes: 30 }
    );
    expect(templateButtonHandle(saved, "Premium")).toBe(premiumHandle);
  });

  it("keeps routes on same-text buttons when another template is picked", () => {
    const graph = planMenu();
    const premiumHandle = templateButtonHandle(graph, "Premium");
    const template: ScenarioWhatsAppTemplate = {
      id: "meta-2",
      name: "pick_tier",
      language: "en",
      category: "MARKETING",
      components: templateComponents([
        quickReply("Gold"),
        quickReply("premium"),
      ]),
    };
    const patch = buildActionWhatsAppTemplateSelectionPatch({
      nodeData: menuData(graph),
      templateValue: getWhatsAppTemplateOptionValue(template),
      whatsAppTemplates: [template],
    });
    expect(patch).not.toBeNull();

    const picked = applyPatch(graph, patch!);

    expect(templateButtonHandle(picked, "premium")).toBe(premiumHandle);
    expect(followUpsOfButton(picked, "premium")).toEqual(["premium-follow-up"]);
    expect(buttonBoundToFollowUp(picked, "premium-follow-up")).toBe("premium");
    expect(followUpsOfButton(picked, "Gold")).toEqual([]);
    expect(buttonBoundToFollowUp(picked, "basic-follow-up")).toBeNull();
    expect(picked.removedRoutes).toEqual([
      {
        descriptorKind: "whatsapp_template_button",
        label: "Basic",
        targetNodeId: "basic-follow-up",
      },
    ]);
    expect(picked.structuralHistoryRequired).toBe(true);
  });

  it("keeps routes on the same places when the template is picked in another language", () => {
    const russian: ScenarioWhatsAppTemplate = {
      id: "meta-ru",
      name: "pick_plan",
      language: "ru",
      category: "MARKETING",
      components: templateComponents([
        quickReply("Базовый"),
        quickReply("Премиум"),
      ]),
    };
    const pickRussian = (graph: TemplateRouteGraph) =>
      applyPatch(
        graph,
        buildActionWhatsAppTemplateSelectionPatch({
          nodeData: menuData(graph),
          templateValue: getWhatsAppTemplateOptionValue(russian),
          whatsAppTemplates: [russian],
        })!
      );
    const graph = planMenu();

    const picked = pickRussian(graph);

    expect(menuData(picked).actionWhatsAppTemplateButtonIds).toBeUndefined();
    expect(templateButtonHandle(picked, "Базовый")).toBe(
      templateButtonHandle(graph, "Basic")
    );
    expect(followUpsOfButton(picked, "Базовый")).toEqual(["basic-follow-up"]);
    expect(followUpsOfButton(picked, "Премиум")).toEqual(["premium-follow-up"]);
    expect(picked.removedRoutes).toEqual([]);

    // A step with stored ids keeps them by position too.
    const withoutBasic = removeTemplateButtonAndSave(graph, "Basic");
    const pickedWithIds = pickRussian(withoutBasic);
    expect(templateButtonHandle(pickedWithIds, "Базовый")).toBe(
      templateButtonHandle(withoutBasic, "Premium")
    );
    expect(followUpsOfButton(pickedWithIds, "Базовый")).toEqual([
      "premium-follow-up",
    ]);
    expect(followUpsOfButton(pickedWithIds, "Премиум")).toEqual([]);
    expect(pickedWithIds.removedRoutes).toEqual([]);
  });

  it("takes the approved template into the step as sends pair its buttons", () => {
    const graph = planMenu();
    const approved: ScenarioWhatsAppTemplate = {
      id: "meta-1",
      name: "pick_plan",
      language: "en",
      category: "MARKETING",
      components: templateComponents([
        quickReply("Premium"),
        quickReply("Gold"),
      ]),
    };

    const taken = applyPatch(
      graph,
      buildActionWhatsAppTemplateSelectionPatch({
        nodeData: menuData(graph),
        templateValue: getWhatsAppTemplateOptionValue(approved),
        whatsAppTemplates: [approved],
      })!
    );

    expect(templateButtonHandle(taken, "Premium")).toBe(
      templateButtonHandle(graph, "Premium")
    );
    expect(followUpsOfButton(taken, "Premium")).toEqual(["premium-follow-up"]);
    expect(followUpsOfButton(taken, "Gold")).toEqual([]);
    expect(taken.removedRoutes).toEqual([
      {
        descriptorKind: "whatsapp_template_button",
        label: "Basic",
        targetNodeId: "basic-follow-up",
      },
    ]);
  });

  it("saves the ids and drops them when the step stops sending a template", () => {
    const saved = removeTemplateButtonAndSave(planMenu(), "Basic");
    const buttonIds = persistedMenuData(saved).actionWhatsAppTemplateButtonIds;
    expect(buttonIds).toEqual({
      version: 1,
      nextId: 10,
      buttons: [{ id: 1, index: 0, text: "Premium" }],
    });

    for (const selectorType of ["reply", "whatsapp_service_message"] as const) {
      const switched = applyPatch(
        saved,
        buildActionPatchForSelector({
          nodeData: menuData(saved),
          selectorType,
        })
      );
      expect(
        persistedMenuData(switched).actionWhatsAppTemplateButtonIds
      ).toBeUndefined();
    }
  });
});

describe("a template's Form submitted route under branch sync", () => {
  /** How branch sync reports it; the toast names it "Form submitted". */
  const REMOVED_FORM_ROUTE = {
    descriptorKind: "whatsapp_template_form_submitted",
    label: "",
    targetNodeId: "carousel",
  };

  function formTemplate(
    buttons = [formButton("Open form")],
    routes: Array<[label: string, followUpId: string]> = []
  ): TemplateRouteGraph {
    return connectTemplateFormSubmittedRoute(
      buildTemplateRouteGraph({ buttons, routes }),
      "carousel"
    );
  }

  it("removes and names the route when a template without a form is picked", () => {
    const picked = pick(formTemplate(), {
      id: "meta-2",
      name: "call_me",
      language: "en",
      category: "MARKETING",
      components: templateComponents([quickReply("Call me")]),
    });

    expect(formSubmittedNextSteps(picked)).toEqual([]);
    expect(picked.nodes.map(node => node.id)).toContain("carousel");
    expect(picked.removedRoutes).toEqual([REMOVED_FORM_ROUTE]);
    expect(picked.structuralHistoryRequired).toBe(true);
  });

  it("keeps the route when the template is picked in another language", () => {
    const picked = pick(formTemplate(), {
      id: "meta-ru",
      name: "pick_plan",
      language: "ru",
      category: "MARKETING",
      components: templateComponents([formButton("Открыть форму")]),
    });

    expect(formSubmittedNextSteps(picked)).toEqual(["carousel"]);
    expect(picked.removedRoutes).toEqual([]);
  });

  it("removes and names the route when a Flow edit adds choice routes", () => {
    const edited = applyPatch(formTemplate(), {
      actionFlowConfig: {
        templateId: "flow-template",
        metaFlowId: "1571793974235171",
        ctaText: "Open form",
        screens: [
          {
            id: "QUESTION_ONE",
            title: "Choose a sport",
            fields: [
              {
                id: "sport",
                label: "Choose a sport",
                fieldType: "RadioButtonsGroup",
                options: [
                  { id: "football", title: "Football" },
                  { id: "boxing", title: "Boxing" },
                ],
              },
            ],
          },
        ],
      },
    });

    expect(formSubmittedNextSteps(edited)).toEqual([]);
    expect(edited.removedRoutes).toEqual([REMOVED_FORM_ROUTE]);
  });

  it("removes and names the route when Save drops the form button, keeping reply routes", () => {
    const graph = formTemplate(
      [quickReply("Call me"), formButton("Open form")],
      [["Call me", "call-follow-up"]]
    );

    const saved = applyPatch(
      graph,
      inlineEditorSaveWithoutButton(menuData(graph), "Open form")
    );

    expect(formSubmittedNextSteps(saved)).toEqual([]);
    expect(followUpsOfButton(saved, "Call me")).toEqual(["call-follow-up"]);
    expect(saved.removedRoutes).toEqual([REMOVED_FORM_ROUTE]);
  });

  it("offers the route on a step made from the palette Reply before a reload", () => {
    // The palette's Reply sends a service message. Switching it to a
    // template keeps the message key on the step, set to undefined.
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
        nodeData: menuData(reply),
        selectorType: "whatsapp_template",
      })
    );
    const picked = pick(switched, {
      id: "meta-form",
      name: "pick_plan",
      language: "en",
      category: "MARKETING",
      components: templateComponents([formButton("Open form")]),
    });

    const step = picked.nodes.find(node => node.id === TEMPLATE_ACTION_ID)!;
    expect(resolveAvailableSourceHandleIds(step)).toContain(
      ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID
    );
    expect(
      formSubmittedNextSteps(
        connectTemplateFormSubmittedRoute(picked, "carousel")
      )
    ).toEqual(["carousel"]);
  });
});

describe("a template step's form data when its form button opens another Flow", () => {
  /** The medal form linked from Meta, as "Use an existing form" links it. */
  const LINKED_FLOW: WhatsAppFlowConfig = {
    templateId: "linked-flow",
    ctaText: "Choose",
    screens: [],
    providerReference: {
      flowId: MEDAL_FLOW_ID,
      sourceId: "source-1",
      wabaId: "waba-1",
      flowName: "demoshop_ai_case",
      providerStatus: "PUBLISHED",
    },
  };
  /** The medal form's loaded fields, its linked Flow and the link's CTA. */
  const LINKED_FORM: Partial<ScenarioNodeData> = {
    actionWhatsAppTemplateForm: medalTemplateForm(),
    actionFlowConfig: LINKED_FLOW,
    actionReplyCtaType: "flow",
    actionReplyCtaFlowId: MEDAL_FLOW_ID,
    actionReplyCtaFlowName: "demoshop_ai_case",
  };
  const DROPPED = {
    form: undefined,
    flowConfig: undefined,
    ctaType: undefined,
    ctaFlowId: undefined,
    ctaFlowName: undefined,
  };

  /** The medal template step with this form data and its form route linked. */
  function medalStep(
    formData: Partial<ScenarioNodeData> = LINKED_FORM,
    buttons = [formButton("Choose", MEDAL_FLOW_ID)]
  ): TemplateRouteGraph {
    const graph = buildTemplateRouteGraph({ buttons, routes: [] });
    return connectTemplateFormSubmittedRoute(
      {
        ...graph,
        nodes: graph.nodes.map(node =>
          node.id === TEMPLATE_ACTION_ID
            ? { ...node, data: { ...node.data, ...formData } }
            : node
        ),
      },
      "carousel"
    );
  }

  function formDataOf(graph: TemplateRouteGraph) {
    const data = menuData(graph);
    return {
      form: data.actionWhatsAppTemplateForm,
      flowConfig: data.actionFlowConfig,
      ctaType: data.actionReplyCtaType,
      ctaFlowId: data.actionReplyCtaFlowId,
      ctaFlowName: data.actionReplyCtaFlowName,
    };
  }

  const bookVisit: ScenarioWhatsAppTemplate = {
    id: "meta-3",
    name: "book_visit",
    language: "en",
    category: "MARKETING",
    components: templateComponents([formButton("Book a visit")]),
  };

  it("drops the linked Flow, and keeps the loaded fields unread, when a template opening another form is picked", () => {
    const picked = pick(medalStep(), bookVisit);

    expect(formDataOf(picked)).toEqual({
      ...DROPPED,
      form: medalTemplateForm(),
    });
    // The readers skip another Flow's fields; the new form's keep their key.
    expect(readScenarioActionForm(menuData(picked))).toBeNull();
    expect(persistedMenuData(picked).actionWhatsAppTemplateForm).toMatchObject({
      flowId: MEDAL_FLOW_ID,
      answersKey: "demoshop_ai_case",
    });
    expect(persistedMenuData(picked).actionFlowConfig).toBeUndefined();
    // The new template still opens one form, so its route stays.
    expect(formSubmittedNextSteps(picked)).toEqual(["carousel"]);
  });

  it("keeps both when the template is picked in another language", () => {
    const graph = medalStep();

    const picked = pick(graph, {
      id: "meta-ru",
      name: "pick_plan",
      language: "ru",
      category: "MARKETING",
      components: templateComponents([formButton("Выбрать", MEDAL_FLOW_ID)]),
    });

    expect(formDataOf(picked)).toEqual(formDataOf(graph));
    expect(formDataOf(picked).form).toEqual(medalTemplateForm());
  });

  it("drops both when a template without a form button is picked", () => {
    const picked = pick(medalStep(), {
      id: "meta-2",
      name: "call_me",
      language: "en",
      category: "MARKETING",
      components: templateComponents([quickReply("Call me")]),
    });

    expect(formDataOf(picked)).toEqual(DROPPED);
  });

  it("keeps a Flow config not linked to a Flow yet, and the other form's fields", () => {
    const draftFlow: WhatsAppFlowConfig = {
      templateId: "custom",
      ctaText: "Choose",
      screens: [
        {
          id: "DETAILS",
          title: "Details",
          fields: [{ id: "name", label: "Name", fieldType: "TextInput" }],
        },
      ],
    };

    const picked = pick(
      medalStep({
        actionWhatsAppTemplateForm: medalTemplateForm(),
        actionFlowConfig: draftFlow,
      }),
      bookVisit
    );

    expect(menuData(picked).actionFlowConfig).toEqual(draftFlow);
    expect(menuData(picked).actionWhatsAppTemplateForm).toEqual(
      medalTemplateForm()
    );
  });

  it("drops both when Save removes the form button", () => {
    const graph = medalStep(LINKED_FORM, [
      quickReply("Call me"),
      formButton("Choose", MEDAL_FLOW_ID),
    ]);

    const saved = applyPatch(
      graph,
      inlineEditorSaveWithoutButton(menuData(graph), "Choose")
    );

    expect(formDataOf(saved)).toEqual(DROPPED);
  });

  it("keeps both when Save keeps the form button", () => {
    const graph = medalStep(LINKED_FORM, [
      quickReply("Call me"),
      formButton("Choose", MEDAL_FLOW_ID),
    ]);

    const saved = saveInlineEditor(graph, buttons =>
      buttons.map(button =>
        button.label === "Call me" ? { ...button, label: "Call us" } : button
      )
    );

    expect(formDataOf(saved)).toEqual(formDataOf(graph));
  });
});
