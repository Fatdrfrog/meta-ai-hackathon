/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import {
  ACTION_BRANCH_DESCRIPTORS,
  TELEGRAM_BRANCH_DESCRIPTOR,
  WHATSAPP_TEMPLATE_BUTTON_BRANCH_DESCRIPTOR,
  type BranchDescriptor,
} from "./graph/branch-sync";
import {
  buildTemplateRouteGraph,
  connectTemplateFormSubmittedRoute,
  formButton,
  formSubmittedNextSteps,
  inlineEditorSaveWithoutButton,
  quickReply,
  TEMPLATE_ACTION_ID,
  templateComponents,
} from "./graph/template-button-route-test-utils";
import { buildActionWhatsAppTemplateSelectionPatch } from "./action/selector-utils";
import {
  resolvePendingConnectionRelease,
  useScenarioGraphController,
} from "./use-scenario-graph-controller";
import { getWhatsAppTemplateOptionValue } from "@/lib/whatsapp/templates/selection";
import {
  MEDAL_FLOW_ID,
  medalTemplateForm,
} from "@/lib/scenarios/__tests__/scenario-form-fixtures";
import type {
  ScenarioFlowEdge,
  ScenarioFlowNode,
  ScenarioWhatsAppTemplate,
} from "../types";
import { SCENARIO_NODE_PALETTE } from "../graph/node-palette";
import {
  buildFlowBranchSourceHandleId,
  ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
  ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID,
  buildWhatsAppSessionChoiceSourceHandleId,
  buildTelegramBranchSourceHandleId,
} from "@icecore/scenario-contracts";
import { createGraphTestNode } from "./graph/test-utils";
import { SCENARIO_UNDO_TOAST_DURATION_MS } from "./graph/undo-context";
import type {
  ScenarioGraphEditor,
  ScenarioGraphSnapshot,
} from "./graph/controller-utils";

jest.mock("sonner", () => ({
  toast: Object.assign(jest.fn(), { error: jest.fn(), success: jest.fn() }),
}));

function createGraphEditor(
  nodes: ScenarioFlowNode[] = [],
  edges: ScenarioFlowEdge[] = []
) {
  let graph: ScenarioGraphSnapshot = { nodes, edges };
  const history: ScenarioGraphSnapshot[] = [];
  const commits: ScenarioGraphSnapshot[] = [];
  const layouts: Array<"auto" | "keep" | undefined> = [];
  const graphEditor: ScenarioGraphEditor = {
    read: () => graph,
    edit: transition => {
      const next = transition(graph);
      if (!next) return false;
      if (next.history === "record") history.push(graph);
      graph = { nodes: next.nodes, edges: next.edges };
      commits.push(graph);
      layouts.push(next.layout);
      return true;
    },
  };
  /** Restores the last recorded graph, as undoGraphChange does. */
  const undo = () => {
    const previous = history.pop();
    if (!previous) return false;
    graph = previous;
    return true;
  };
  return { graphEditor, history, commits, layouts, undo };
}

type ConnectionReleaseState = Parameters<
  typeof resolvePendingConnectionRelease
>[1];

/** xyflow 12.11 `FinalConnectionState` is a discriminated union; test stubs are partial. */
type ConnectionReleaseFixture = {
  isValid?: boolean | null;
  fromNode?: { id: string } | null;
  fromHandle?: { id: string } | null;
  toNode?: { id: string } | null;
  toHandle?: { id: string } | null;
};

function createConnectionState(
  overrides: ConnectionReleaseFixture = {}
): ConnectionReleaseState {
  return {
    isValid: null,
    fromNode: { id: "source-node" },
    fromHandle: { id: "source-handle" },
    toNode: null,
    ...overrides,
  } as unknown as ConnectionReleaseState;
}

function createMouseReleaseEvent(clientX: number, clientY: number): MouseEvent {
  return { clientX, clientY } as MouseEvent;
}

function createMouseReleaseEventOnElement(
  clientX: number,
  clientY: number,
  target: Element
): MouseEvent {
  return { clientX, clientY, target } as unknown as MouseEvent;
}

describe("resolvePendingConnectionRelease", () => {
  it("returns release coordinates and source details for unfinished source drags", () => {
    const release = resolvePendingConnectionRelease(
      createMouseReleaseEvent(320, 240),
      createConnectionState()
    );

    expect(release).toEqual({
      clientX: 320,
      clientY: 240,
      sourceNodeId: "source-node",
      sourceHandleId: "source-handle",
    });
  });

  it("ignores releases that already completed on another node", () => {
    const release = resolvePendingConnectionRelease(
      createMouseReleaseEvent(320, 240),
      createConnectionState({
        isValid: true,
        toNode: { id: "target-node" },
      })
    );

    expect(release).toBeNull();
  });

  it("ignores releases over a target handle even when React Flow omits toNode", () => {
    const targetNode = document.createElement("div");
    targetNode.className = "react-flow__node";
    const targetHandle = document.createElement("div");
    targetHandle.className = "react-flow__handle";
    targetNode.append(targetHandle);

    const release = resolvePendingConnectionRelease(
      createMouseReleaseEventOnElement(320, 240, targetHandle),
      createConnectionState({
        isValid: true,
        toNode: null,
      })
    );

    expect(release).toBeNull();
  });

  it("returns release coordinates when React Flow marks an empty-canvas release as valid", () => {
    const release = resolvePendingConnectionRelease(
      createMouseReleaseEvent(320, 240),
      createConnectionState({ isValid: true })
    );

    expect(release).toEqual({
      clientX: 320,
      clientY: 240,
      sourceNodeId: "source-node",
      sourceHandleId: "source-handle",
    });
  });

  it("ignores releases that already target another node", () => {
    const release = resolvePendingConnectionRelease(
      createMouseReleaseEvent(320, 240),
      createConnectionState({
        toNode: { id: "target-node" },
      })
    );

    expect(release).toBeNull();
  });

  it("supports touch releases from source handles", () => {
    const touchEvent = {
      changedTouches: [{ clientX: 120, clientY: 180 }],
      touches: [],
    } as unknown as TouchEvent;

    const release = resolvePendingConnectionRelease(
      touchEvent,
      createConnectionState({ fromHandle: null })
    );

    expect(release).toEqual({
      clientX: 120,
      clientY: 180,
      sourceNodeId: "source-node",
      sourceHandleId: null,
    });
  });

  it("uses the connect-start source when React Flow drops source details on release", () => {
    const release = resolvePendingConnectionRelease(
      createMouseReleaseEvent(320, 240),
      createConnectionState({
        fromNode: null,
        fromHandle: null,
      }),
      {
        sourceNodeId: "fallback-node",
        sourceHandleId: "fallback-handle",
      }
    );

    expect(release).toEqual({
      clientX: 320,
      clientY: 240,
      sourceNodeId: "fallback-node",
      sourceHandleId: "fallback-handle",
    });
  });

  it("does not use the connect-start source when release completed on a target node", () => {
    const release = resolvePendingConnectionRelease(
      createMouseReleaseEvent(320, 240),
      createConnectionState({
        fromNode: null,
        fromHandle: null,
        toNode: { id: "target-node" },
      }),
      {
        sourceNodeId: "fallback-node",
        sourceHandleId: "fallback-handle",
      }
    );

    expect(release).toBeNull();
  });
});

describe("branch synchronization history", () => {
  it("captures the first transition graph before a second synchronous structural transition", () => {
    const editor = createGraphEditor([
      {
        id: "action-1",
        type: "actionNode",
        position: { x: 0, y: 0 },
        data: {
          kind: "action",
          actionType: "reply",
          actionReplyChannel: "telegram",
          actionTelegramQuickReplies: [{ text: "Yes", payload: "yes" }],
        },
      } as ScenarioFlowNode,
    ]);
    const autoCreatingDescriptor: BranchDescriptor = {
      ...TELEGRAM_BRANCH_DESCRIPTOR,
      autoCreateMissingNodes: true,
    };
    const { result } = renderHook(() =>
      useScenarioGraphController({
        flowWrapperRef: { current: null },
        screenToFlowPosition: position => position,
        graphEditor: editor.graphEditor,
        nodes: editor.graphEditor.read().nodes,
        edges: editor.graphEditor.read().edges,
        setSelectedNodeId: jest.fn(),
        whatsAppTemplates: [],
        t: key => key,
      })
    );

    act(() => {
      result.current.handleBranchSyncForNodeRef.current(
        "action-1",
        autoCreatingDescriptor
      );
      result.current.handleBranchSyncForNodeRef.current(
        "action-1",
        autoCreatingDescriptor,
        {
          actionTelegramQuickReplies: [
            { text: "Yes", payload: "yes" },
            { text: "No", payload: "no" },
          ],
        }
      );
    });

    expect(editor.history).toHaveLength(2);
    expect(editor.history[0]).toMatchObject({
      nodes: [expect.objectContaining({ id: "action-1" })],
      edges: [],
    });
    expect(editor.history[1]).toMatchObject({
      nodes: [
        expect.objectContaining({ id: "action-1" }),
        expect.objectContaining({
          data: expect.objectContaining({ telegramBranchPayload: "yes" }),
        }),
      ],
      edges: [expect.objectContaining({ source: "action-1" })],
    });
    act(() => {
      result.current.handleBranchSyncForNodeRef.current(
        "action-1",
        autoCreatingDescriptor
      );
    });
    expect(editor.commits).toHaveLength(2);
  });
});

/** Keys with the values that shape them, so toasts can be read in tests. */
function describeTranslation(
  key: string,
  values?: Record<string, string | number | Date>
): string {
  if (key === "whatsappTemplateButtonQuoted") return `“${values?.label}”`;
  if (!values) return key;
  return [key, values.count, values.labels].filter(Boolean).join(":");
}

function pickTemplate(
  graph: { nodes: ScenarioFlowNode[] },
  template: ScenarioWhatsAppTemplate
) {
  return buildActionWhatsAppTemplateSelectionPatch({
    nodeData: graph.nodes.find(node => node.id === TEMPLATE_ACTION_ID)!.data,
    templateValue: getWhatsAppTemplateOptionValue(template),
    whatsAppTemplates: [template],
  })!;
}

describe("template reply-button routes removed by branch sync", () => {
  function renderPlanMenu(
    undo?: () => boolean,
    graph = buildTemplateRouteGraph({
      buttons: [quickReply("Basic"), quickReply("Premium")],
      routes: [
        ["Basic", "basic-follow-up"],
        ["Premium", "premium-follow-up"],
      ],
    })
  ) {
    const editor = createGraphEditor(graph.nodes, graph.edges);
    const undoGraphChange = jest.fn(undo ?? editor.undo);
    const { result } = renderHook(() =>
      useScenarioGraphController({
        flowWrapperRef: { current: null },
        screenToFlowPosition: position => position,
        graphEditor: editor.graphEditor,
        nodes: editor.graphEditor.read().nodes,
        edges: editor.graphEditor.read().edges,
        setSelectedNodeId: jest.fn(),
        whatsAppTemplates: [],
        undoGraphChange,
        t: describeTranslation,
      })
    );
    const removeBasic = () =>
      inlineEditorSaveWithoutButton(
        graph.nodes.find(node => node.id === TEMPLATE_ACTION_ID)!.data,
        "Basic"
      );
    return { editor, result, removeBasic, undoGraphChange };
  }

  beforeEach(() => jest.mocked(toast).mockClear());

  it("names the removed route after a template save, without Undo", () => {
    const { editor, result, removeBasic } = renderPlanMenu();

    act(() => {
      result.current.handleBranchSyncForNodeRef.current(
        TEMPLATE_ACTION_ID,
        [WHATSAPP_TEMPLATE_BUTTON_BRANCH_DESCRIPTOR],
        removeBasic()
      );
    });

    expect(editor.history).toHaveLength(1);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      "whatsappTemplateRoutesRemoved:1:“Basic”",
      {
        id: `whatsapp-template-routes-removed:${TEMPLATE_ACTION_ID}`,
        description: "whatsappTemplateRoutesRemovedNextSteps:1",
      }
    );
  });

  it("offers Undo when picking another template removed a route", () => {
    const { result, removeBasic, undoGraphChange } = renderPlanMenu();

    act(() => {
      result.current.handleBranchSyncForNodeRef.current(
        TEMPLATE_ACTION_ID,
        [WHATSAPP_TEMPLATE_BUTTON_BRANCH_DESCRIPTOR],
        removeBasic(),
        { templatePick: true }
      );
    });

    expect(toast).toHaveBeenCalledWith(
      "whatsappTemplateRoutesRemoved:1:“Basic”",
      expect.objectContaining({
        description: "whatsappTemplateRoutesRemovedNextSteps:1",
        duration: SCENARIO_UNDO_TOAST_DURATION_MS,
        action: expect.objectContaining({ label: "whatsappServiceUndo" }),
      })
    );
    const [, options] = jest.mocked(toast).mock.calls[0] as unknown as [
      string,
      { action: { onClick: () => void } },
    ];
    options.action.onClick();
    expect(undoGraphChange).toHaveBeenCalledTimes(1);
  });

  it("offers Undo when picking another template only moved routes", () => {
    const { editor, result } = renderPlanMenu();
    const template: ScenarioWhatsAppTemplate = {
      id: "meta-2",
      name: "pick_tier",
      language: "en",
      category: "MARKETING",
      components: templateComponents([
        quickReply("Premium"),
        quickReply("Basic"),
      ]),
    };
    const pick = pickTemplate(editor.graphEditor.read(), template);

    act(() => {
      result.current.handleBranchSyncForNodeRef.current(
        TEMPLATE_ACTION_ID,
        [WHATSAPP_TEMPLATE_BUTTON_BRANCH_DESCRIPTOR],
        pick,
        { templatePick: true }
      );
    });

    expect(editor.graphEditor.read().edges).toHaveLength(2);
    // No edge changed, yet Undo must revert this pick, not an older change.
    expect(editor.history).toHaveLength(1);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      "whatsappTemplatePickRoutesMoved:2:“Basic”, “Premium”",
      expect.objectContaining({
        duration: SCENARIO_UNDO_TOAST_DURATION_MS,
        action: expect.objectContaining({ label: "whatsappServiceUndo" }),
      })
    );
  });

  it("stays quiet when the template is picked in another language and keeps every route", () => {
    const { editor, result } = renderPlanMenu();
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

    act(() => {
      result.current.handleBranchSyncForNodeRef.current(
        TEMPLATE_ACTION_ID,
        ACTION_BRANCH_DESCRIPTORS,
        pickTemplate(editor.graphEditor.read(), russian),
        { templatePick: true }
      );
    });

    expect(editor.graphEditor.read().edges).toHaveLength(2);
    expect(editor.history).toHaveLength(1);
    expect(toast).not.toHaveBeenCalled();
  });

  it("names a form route a pick removed and offers Undo", () => {
    const formMenu = {
      nodes: [
        createGraphTestNode(TEMPLATE_ACTION_ID, {
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateName: "order_form",
          actionWhatsAppTemplateLanguage: "en",
          actionWhatsAppTemplateComponents: [
            { type: "BODY", text: "Pick a size" },
            {
              type: "BUTTONS",
              buttons: [
                {
                  type: "FLOW",
                  text: "Open form",
                  flow_id: "flow-1",
                  flow_action: "navigate",
                },
              ],
            },
          ],
          actionFlowConfig: {
            templateId: "flow-template",
            metaFlowId: "flow-1",
            ctaText: "Open",
            screens: [
              {
                id: "s1",
                title: "T",
                fields: [
                  {
                    id: "field-1",
                    label: "Pick",
                    fieldType: "RadioButtonsGroup",
                    options: [
                      { id: "one", title: "One" },
                      { id: "two", title: "Two" },
                    ],
                  },
                ],
              },
            ],
          },
        } as ScenarioFlowNode["data"]),
        createGraphTestNode("one-follow-up", {
          kind: "action",
          actionType: "reply",
          flowBranchSourceFieldId: "field-1",
          flowBranchOptionId: "one",
          flowBranchOptionLabel: "One",
        } as ScenarioFlowNode["data"]),
      ],
      edges: [
        {
          id: "menu-one",
          source: TEMPLATE_ACTION_ID,
          sourceHandle: buildFlowBranchSourceHandleId("field-1", "one"),
          target: "one-follow-up",
          targetHandle: "left-target",
        },
      ],
    };
    const { editor, result, undoGraphChange } = renderPlanMenu(
      jest.fn(() => true),
      formMenu
    );
    const repliesOnly: ScenarioWhatsAppTemplate = {
      id: "meta-2",
      name: "menu_b",
      language: "en",
      category: "MARKETING",
      components: templateComponents([quickReply("Basic")]),
    };

    act(() => {
      result.current.handleBranchSyncForNodeRef.current(
        TEMPLATE_ACTION_ID,
        ACTION_BRANCH_DESCRIPTORS,
        pickTemplate(editor.graphEditor.read(), repliesOnly),
        { templatePick: true }
      );
    });

    expect(editor.graphEditor.read().edges).toEqual([]);
    expect(toast).toHaveBeenCalledWith(
      "whatsappTemplateRoutesRemoved:1:“One”",
      expect.objectContaining({
        description: "whatsappTemplateRoutesRemovedNextSteps:1",
        action: expect.objectContaining({ label: "whatsappServiceUndo" }),
      })
    );
    const [, options] = jest.mocked(toast).mock.calls[0] as unknown as [
      string,
      { action: { onClick: () => void } },
    ];
    options.action.onClick();
    expect(undoGraphChange).toHaveBeenCalledTimes(1);
  });

  it("names the Form submitted route a pick removed, and Undo brings it back", () => {
    const formMenu = connectTemplateFormSubmittedRoute(
      buildTemplateRouteGraph({
        buttons: [formButton("Open form")],
        routes: [],
      }),
      "carousel"
    );
    const { editor, result } = renderPlanMenu(undefined, formMenu);
    const callMe: ScenarioWhatsAppTemplate = {
      id: "meta-2",
      name: "call_me",
      language: "en",
      category: "MARKETING",
      components: templateComponents([quickReply("Call me")]),
    };

    act(() => {
      result.current.handleBranchSyncForNodeRef.current(
        TEMPLATE_ACTION_ID,
        ACTION_BRANCH_DESCRIPTORS,
        pickTemplate(editor.graphEditor.read(), callMe),
        { templatePick: true }
      );
    });

    expect(formSubmittedNextSteps(editor.graphEditor.read())).toEqual([]);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      "whatsappTemplateRoutesRemoved:1:“serviceRouteFlowSubmitted”",
      expect.objectContaining({
        description: "whatsappTemplateRoutesRemovedNextSteps:1",
        duration: SCENARIO_UNDO_TOAST_DURATION_MS,
        action: expect.objectContaining({ label: "whatsappServiceUndo" }),
      })
    );
    const [, options] = jest.mocked(toast).mock.calls[0] as unknown as [
      string,
      { action: { onClick: () => void } },
    ];
    options.action.onClick();
    expect(formSubmittedNextSteps(editor.graphEditor.read())).toEqual([
      "carousel",
    ]);
  });

  it("drops another Flow's form data on a pick, and the pick's Undo brings it back", () => {
    const formMenu = connectTemplateFormSubmittedRoute(
      buildTemplateRouteGraph({
        buttons: [formButton("Choose", MEDAL_FLOW_ID)],
        routes: [],
      }),
      "carousel"
    );
    const loadedForm = medalTemplateForm();
    const { editor, result } = renderPlanMenu(undefined, {
      ...formMenu,
      nodes: formMenu.nodes.map(node =>
        node.id === TEMPLATE_ACTION_ID
          ? {
              ...node,
              data: { ...node.data, actionWhatsAppTemplateForm: loadedForm },
            }
          : node
      ),
    });
    const templateForm = () =>
      editor.graphEditor
        .read()
        .nodes.find(node => node.id === TEMPLATE_ACTION_ID)!.data
        .actionWhatsAppTemplateForm;

    act(() => {
      result.current.handleBranchSyncForNodeRef.current(
        TEMPLATE_ACTION_ID,
        ACTION_BRANCH_DESCRIPTORS,
        pickTemplate(editor.graphEditor.read(), {
          id: "meta-2",
          name: "call_me",
          language: "en",
          category: "MARKETING",
          components: templateComponents([quickReply("Call me")]),
        }),
        { templatePick: true }
      );
    });

    expect(templateForm()).toBeUndefined();
    const [, options] = jest.mocked(toast).mock.calls[0] as unknown as [
      string,
      { action: { onClick: () => void } },
    ];
    options.action.onClick();
    expect(templateForm()).toEqual(loadedForm);
  });

  it("names the Form submitted route an editor save removed, without Undo", () => {
    const formMenu = connectTemplateFormSubmittedRoute(
      buildTemplateRouteGraph({
        buttons: [quickReply("Basic"), formButton("Open form")],
        routes: [["Basic", "basic-follow-up"]],
      }),
      "carousel"
    );
    const { editor, result } = renderPlanMenu(undefined, formMenu);

    act(() => {
      result.current.handleBranchSyncForNodeRef.current(
        TEMPLATE_ACTION_ID,
        ACTION_BRANCH_DESCRIPTORS,
        inlineEditorSaveWithoutButton(
          formMenu.nodes.find(node => node.id === TEMPLATE_ACTION_ID)!.data,
          "Open form"
        )
      );
    });

    expect(formSubmittedNextSteps(editor.graphEditor.read())).toEqual([]);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      "whatsappTemplateRoutesRemoved:1:“serviceRouteFlowSubmitted”",
      {
        id: `whatsapp-template-routes-removed:${TEMPLATE_ACTION_ID}`,
        description: "whatsappTemplateRoutesRemovedNextSteps:1",
      }
    );
  });

  it("stays quiet when no route was removed or the step stops sending a template", () => {
    const { editor, result } = renderPlanMenu();

    act(() => {
      result.current.handleBranchSyncForNodeRef.current(
        TEMPLATE_ACTION_ID,
        [WHATSAPP_TEMPLATE_BUTTON_BRANCH_DESCRIPTOR],
        { actionReplyText: "Which plan suits you?" }
      );
    });
    act(() => {
      result.current.handleBranchSyncForNodeRef.current(
        TEMPLATE_ACTION_ID,
        [WHATSAPP_TEMPLATE_BUTTON_BRANCH_DESCRIPTOR],
        { actionType: "reply", actionReplyMode: "fixed" }
      );
    });

    expect(editor.commits).toHaveLength(2);
    expect(toast).not.toHaveBeenCalled();
  });
});

function renderGraphControllerForPicker(
  nodes: ScenarioFlowNode[] = [],
  edges: ScenarioFlowEdge[] = []
) {
  const editor = createGraphEditor(nodes, edges);
  const setSelectedNodeId = jest.fn();
  const hook = renderHook(
    ({
      graphEditor,
      graph,
    }: {
      graphEditor: ScenarioGraphEditor;
      graph: { nodes: ScenarioFlowNode[]; edges: ScenarioFlowEdge[] };
    }) =>
      useScenarioGraphController({
        flowWrapperRef: {
          current: {
            getBoundingClientRect: () => ({
              left: 0,
              top: 0,
              width: 800,
              height: 600,
            }),
          } as HTMLDivElement,
        },
        screenToFlowPosition: position => position,
        graphEditor,
        nodes: graph.nodes,
        edges: graph.edges,
        setSelectedNodeId,
        whatsAppTemplates: [],
        t: key => key,
      }),
    {
      initialProps: {
        graphEditor: editor.graphEditor,
        graph: { nodes, edges },
      },
    }
  );

  return {
    ...hook,
    ...editor,
    setSelectedNodeId,
  };
}

function getPaletteItem(id: string) {
  const item = SCENARIO_NODE_PALETTE.find(candidate => candidate.id === id);
  expect(item).toBeDefined();
  return item!;
}

describe("source route editing", () => {
  it("disconnects an exact legacy choice without removing another aggregate-handle choice", () => {
    const source = createGraphTestNode("source", {
      kind: "action",
      actionType: "reply",
      actionReplyChannel: "whatsapp",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Choose" },
          options: [
            { id: "yes", label: "Yes" },
            { id: "no", label: "No" },
          ],
        },
      },
    });
    const yes = createGraphTestNode("yes", {
      kind: "action",
      actionType: "reply",
      whatsAppSessionChoicePayload: "yes",
    });
    const no = createGraphTestNode("no", {
      kind: "action",
      actionType: "reply",
      whatsAppSessionChoicePayload: "no",
    });
    const controller = renderGraphControllerForPicker(
      [source, yes, no],
      [
        {
          id: "yes-edge",
          source: "source",
          target: "yes",
          sourceHandle: ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID,
        },
        {
          id: "no-edge",
          source: "source",
          target: "no",
          sourceHandle: ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID,
        },
      ]
    );
    act(() =>
      controller.result.current.openNodePickerFromHandle(
        "source",
        buildWhatsAppSessionChoiceSourceHandleId("yes"),
        300,
        200
      )
    );
    expect(
      controller.result.current.contextMenuRoute?.currentDestinationId
    ).toBe("yes");
    act(() => controller.result.current.disconnectContextMenuRoute());
    expect(controller.graphEditor.read().edges.map(edge => edge.id)).toEqual([
      "no-edge",
    ]);
    expect(
      controller.graphEditor.read().nodes.find(node => node.id === "no")?.data
        .whatsAppSessionChoicePayload
    ).toBe("no");
  });
  function routeFixture() {
    const source = createGraphTestNode("source", {
      kind: "action",
      actionType: "reply",
      actionReplyChannel: "whatsapp",
      actionOutcomes: { version: 1, anyReply: { enabled: true } },
    });
    const other = createGraphTestNode("other", {
      kind: "action",
      actionType: "reply",
    });
    const old = createGraphTestNode("old", {
      kind: "action",
      actionType: "reply",
    });
    const next = createGraphTestNode("next", {
      kind: "action",
      actionType: "reply",
    });
    const controller = renderGraphControllerForPicker(
      [source, other, old, next],
      [
        {
          id: "route",
          source: "source",
          sourceHandle: ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
          target: "old",
        },
        {
          id: "shared",
          source: "other",
          sourceHandle: "right-source",
          target: "old",
        },
      ]
    );
    act(() =>
      controller.result.current.openNodePickerFromHandle(
        "source",
        ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
        300,
        200
      )
    );
    return controller;
  }

  it("replaces one route atomically without deleting a shared destination", () => {
    const controller = routeFixture();
    act(() => controller.result.current.connectContextMenuToNode("next"));
    const graph = controller.graphEditor.read();
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "source",
          target: "next",
          sourceHandle: ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
        }),
        expect.objectContaining({ id: "shared", target: "old" }),
      ])
    );
    expect(graph.edges).toHaveLength(2);
    expect(graph.nodes.map(node => node.id)).toContain("old");
    expect(controller.history).toHaveLength(1);
  });

  it("disconnects only the chosen source route and preserves downstream nodes", () => {
    const controller = routeFixture();
    act(() => controller.result.current.disconnectContextMenuRoute());
    expect(controller.graphEditor.read().edges.map(edge => edge.id)).toEqual([
      "shared",
    ]);
    expect(controller.graphEditor.read().nodes).toHaveLength(4);
    expect(controller.history).toHaveLength(1);
  });

  it("creates a new destination in place of the connected route in one undo step", async () => {
    const controller = routeFixture();
    await act(async () =>
      controller.result.current.addNodeFromPaletteItem(
        getPaletteItem("action-reply")
      )
    );
    const graph = controller.graphEditor.read();
    expect(graph.edges.filter(edge => edge.source === "source")).toHaveLength(
      1
    );
    expect(graph.edges.find(edge => edge.source === "source")?.target).not.toBe(
      "old"
    );
    expect(graph.nodes).toHaveLength(5);
    expect(controller.history).toHaveLength(1);
  });
});

const pickerSourceNode: ScenarioFlowNode = {
  id: "action-1",
  type: "actionNode",
  position: { x: 0, y: 0 },
  data: { kind: "action", actionType: "reply" },
};

describe("handle-originated palette insertion", () => {
  it("places the new node where the picker was opened and keeps it there", async () => {
    const controller = renderGraphControllerForPicker([pickerSourceNode]);

    act(() => {
      controller.result.current.openNodePickerFromHandle(
        pickerSourceNode.id,
        "right-source",
        200,
        120
      );
    });
    await act(async () => {
      await controller.result.current.addNodeFromPaletteItem(
        getPaletteItem("action-reply")
      );
    });

    const inserted = controller.graphEditor
      .read()
      .nodes.find(node => node.id !== pickerSourceNode.id);
    expect(inserted?.position).toEqual({ x: 200, y: 120 });
    expect(controller.layouts).toEqual(["keep"]);
  });

  it("keeps the originating action selected while its picker is open", () => {
    const controller = renderGraphControllerForPicker([pickerSourceNode]);

    act(() => {
      controller.result.current.openNodePickerFromHandle(
        pickerSourceNode.id,
        "right-source",
        200,
        120
      );
    });

    expect(controller.setSelectedNodeId).not.toHaveBeenCalled();
    expect(controller.result.current.contextMenu).toMatchObject({
      connectFromNodeId: pickerSourceNode.id,
      connectFromSourceHandle: "right-source",
    });
  });

  it("keeps the originating action selected after dragging its handle to empty canvas", () => {
    const controller = renderGraphControllerForPicker([pickerSourceNode]);

    act(() => {
      controller.result.current.onConnectStart({} as MouseEvent, {
        nodeId: pickerSourceNode.id,
        handleId: "right-source",
        handleType: "source",
      });
      controller.result.current.onConnectEnd(
        createMouseReleaseEvent(200, 120),
        createConnectionState({
          fromNode: null,
          fromHandle: null,
        })
      );
    });

    expect(controller.setSelectedNodeId).not.toHaveBeenCalled();
    expect(controller.result.current.contextMenu).toMatchObject({
      connectFromNodeId: pickerSourceNode.id,
      connectFromSourceHandle: "right-source",
    });
  });

  it("closes the handle picker without clearing the originating selection", () => {
    const controller = renderGraphControllerForPicker([pickerSourceNode]);

    act(() => {
      controller.result.current.openNodePickerFromHandle(
        pickerSourceNode.id,
        "right-source",
        200,
        120
      );
    });
    expect(controller.result.current.contextMenu).not.toBeNull();

    act(() => {
      controller.result.current.closeContextMenu();
    });

    expect(controller.result.current.contextMenu).toBeNull();
    expect(controller.setSelectedNodeId).not.toHaveBeenCalled();
  });

  it("closes a handle picker across editor visits, including returning to the same graph", () => {
    const controller = renderGraphControllerForPicker([pickerSourceNode]);

    act(() => {
      controller.result.current.openNodePickerFromHandle(
        pickerSourceNode.id,
        "right-source",
        200,
        120
      );
    });
    expect(controller.result.current.contextMenu).not.toBeNull();

    controller.rerender({
      graphEditor: createGraphEditor().graphEditor,
      graph: { nodes: [], edges: [] },
    });

    expect(controller.result.current.contextMenu).toBeNull();
    controller.rerender({
      graphEditor: createGraphEditor([pickerSourceNode]).graphEditor,
      graph: { nodes: [pickerSourceNode], edges: [] },
    });
    expect(controller.result.current.contextMenu).toBeNull();
  });

  it("does not insert when the originating source node no longer exists", async () => {
    const controller = renderGraphControllerForPicker();

    act(() => {
      controller.result.current.openNodePickerFromHandle(
        "removed-action",
        "right-source",
        200,
        120
      );
    });
    await act(async () => {
      await controller.result.current.addNodeFromPaletteItem(
        getPaletteItem("action-reply")
      );
    });

    expect(controller.history).toHaveLength(0);
    expect(controller.commits).toHaveLength(0);
  });

  it("does not insert when the canonical connection planner returns no plan", async () => {
    const controller = renderGraphControllerForPicker([pickerSourceNode]);

    act(() => {
      controller.result.current.openNodePickerFromHandle(
        pickerSourceNode.id,
        "right-source",
        200,
        120
      );
    });
    await act(async () => {
      await controller.result.current.addNodeFromPaletteItem(
        getPaletteItem("trigger-incoming-message")
      );
    });

    expect(controller.history).toHaveLength(0);
    expect(controller.commits).toHaveLength(0);
  });
});

describe("atomic graph edits", () => {
  it("repairs an existing branch binding without duplicating its edge", () => {
    const source = createGraphTestNode("source", {
      kind: "action",
      actionType: "reply",
      actionReplyChannel: "telegram",
      actionTelegramQuickReplies: [{ text: "Yes", payload: "yes" }],
    });
    const target = createGraphTestNode("target", {
      kind: "action",
      actionType: "reply",
    });
    const edge = {
      id: "existing",
      source: source.id,
      target: target.id,
      sourceHandle: buildTelegramBranchSourceHandleId("yes"),
      targetHandle: "left-target",
    };
    const controller = renderGraphControllerForPicker([source, target], [edge]);
    act(() => {
      controller.result.current.onConnect(edge);
      controller.result.current.onConnect(edge);
    });
    expect(controller.graphEditor.read().nodes[1]?.data).toMatchObject({
      telegramBranchPayload: "yes",
    });
    expect(controller.graphEditor.read().edges).toEqual([edge]);
    expect(controller.commits).toHaveLength(1);
  });
  it("uses the preceding connection when validating another connection in the same turn", () => {
    const source = createGraphTestNode("source", {
      kind: "action",
      actionType: "reply",
      actionOutcomes: { version: 1, anyReply: { enabled: true } },
    });
    const first = createGraphTestNode("first", {
      kind: "action",
      actionType: "reply",
    });
    const second = createGraphTestNode("second", {
      kind: "action",
      actionType: "reply",
    });
    const controller = renderGraphControllerForPicker([source, first, second]);
    const connection = {
      source: "source",
      target: "first",
      sourceHandle: ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
      targetHandle: null,
    };
    act(() => {
      controller.result.current.onConnect(connection);
      controller.result.current.onConnect({ ...connection, target: "second" });
      controller.result.current.onConnect(connection);
    });
    expect(controller.commits).toHaveLength(1);
    expect(controller.history).toHaveLength(1);
    expect(controller.graphEditor.read().edges).toEqual([
      expect.objectContaining({ source: "source", target: "first" }),
    ]);
  });

  it("commits branch binding and its edge together", () => {
    const source = createGraphTestNode("source", {
      kind: "action",
      actionType: "reply",
      actionReplyChannel: "telegram",
      actionTelegramQuickReplies: [{ text: "Yes", payload: "yes" }],
    });
    const target = createGraphTestNode("target", {
      kind: "action",
      actionType: "reply",
    });
    const controller = renderGraphControllerForPicker([source, target]);
    act(() => {
      controller.result.current.onConnect({
        source: source.id,
        target: target.id,
        sourceHandle: buildTelegramBranchSourceHandleId("yes"),
        targetHandle: null,
      });
    });
    expect(controller.commits).toHaveLength(1);
    expect(controller.commits[0]).toMatchObject({
      nodes: [
        source,
        expect.objectContaining({
          id: "target",
          data: expect.objectContaining({ telegramBranchPayload: "yes" }),
        }),
      ],
      edges: [expect.objectContaining({ source: "source", target: "target" })],
    });
    expect(controller.history[0]).toEqual({
      nodes: [source, target],
      edges: [],
    });
  });

  it("inserts a palette node and its originating edge in one commit", async () => {
    const source = createGraphTestNode("source", {
      kind: "action",
      actionType: "reply",
      actionOutcomes: { version: 1, anyReply: { enabled: true } },
    });
    const controller = renderGraphControllerForPicker([source]);
    act(() => {
      controller.result.current.openNodePickerFromHandle(
        source.id,
        ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
        200,
        120
      );
    });
    await act(async () => {
      await controller.result.current.addNodeFromPaletteItem(
        getPaletteItem("action-reply")
      );
    });
    expect(controller.commits).toHaveLength(1);
    const graph = controller.graphEditor.read();
    const inserted = graph.nodes.find(node => node.id !== source.id);
    expect(inserted).toMatchObject({ position: { x: 200, y: 120 } });
    expect(graph.edges).toEqual([
      expect.objectContaining({ source: source.id, target: inserted?.id }),
    ]);
    expect(controller.history).toEqual([{ nodes: [source], edges: [] }]);
    expect(controller.setSelectedNodeId).toHaveBeenCalledWith(inserted?.id);
  });
});
