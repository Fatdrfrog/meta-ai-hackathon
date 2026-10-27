/** @jest-environment jsdom */

import { DEMOSHOP_FLOW_JSON } from "@/components/scenarios/builders/whatsapp/flow-json-fixtures";
import { fetchTemplateFlowFacts } from "@/lib/whatsapp/flows/client";
import type { TemplateFlowFacts } from "@/lib/whatsapp/flows/template-flow-health";
import {
  buildTemplateFormAnswerSchema,
  type TemplateFormAnswerSchema,
} from "@/lib/whatsapp/flows/template-form-answer-schema";
import { act, renderHook } from "@testing-library/react";
import { TextEncoder } from "node:util";
import { BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID } from "@icecore/scenario-contracts";
import type {
  ScenarioFlowEdge,
  ScenarioFlowNode,
  ScenarioNodeData,
} from "../types";
import type {
  ScenarioGraphEdit,
  ScenarioGraphEditor,
  ScenarioGraphSnapshot,
} from "./graph/controller-utils";
import {
  useScenarioTemplateFormLoader,
  type ScenarioTemplateFormLoadOptions,
} from "./use-scenario-template-form-loader";

jest.mock("@/lib/whatsapp/flows/client", () => ({
  fetchTemplateFlowFacts: jest.fn(),
}));

const mockFetchTemplateFlowFacts = jest.mocked(fetchTemplateFlowFacts);

// The answer schema is built on the server, where TextEncoder exists.
Object.defineProperty(globalThis, "TextEncoder", {
  configurable: true,
  value: TextEncoder,
});

const FLOW_ID = "1571793974235171";
const CHECKED_AT = "2026-10-05T10:00:00.000Z";
const SCHEMA = buildTemplateFormAnswerSchema({
  flowJson: DEMOSHOP_FLOW_JSON,
  flowName: "demoshop_ai_case",
}) as TemplateFormAnswerSchema;

function node(id: string, data: Record<string, unknown>): ScenarioFlowNode {
  return {
    id,
    type: "actionNode",
    position: { x: 0, y: 0 },
    data: data as ScenarioNodeData,
  };
}

function formStep(data: Record<string, unknown> = {}): ScenarioFlowNode {
  return node("template", {
    kind: "action",
    actionType: "whatsapp_template",
    actionWhatsAppTemplateName: "demoshop_test",
    actionWhatsAppTemplateComponents: [
      {
        type: "BUTTONS",
        buttons: [{ type: "FLOW", text: "Open form", flow_id: FLOW_ID }],
      },
    ],
    ...data,
  });
}

const trigger = node("trigger", { kind: "trigger" });
const portrait = node("portrait", {
  kind: "action",
  actionType: "generative_ai",
  actionGenerativeAIConfig: {
    version: 1,
    mode: "text_to_video",
    prompt: "A medal for {{form.demoshop_ai_case.f_68d224}}",
  },
});
const edges = [
  { id: "e1", source: "trigger", target: "template" },
  {
    id: "e2",
    source: "template",
    target: "portrait",
    sourceHandle: "right-source-whatsapp-template-form-submitted",
  },
];

function found(
  answerSchema: TemplateFormAnswerSchema | null = SCHEMA
): TemplateFlowFacts {
  return {
    flowId: FLOW_ID,
    state: "found",
    name: "demoshop_ai_case",
    status: "PUBLISHED",
    screenIds: ["QUESTION_ONE", "DETAILS", "OTHER_DETAILS"],
    answerSchema,
    checkedAt: CHECKED_AT,
  };
}

function answerFacts(facts: TemplateFlowFacts) {
  mockFetchTemplateFlowFacts.mockResolvedValue({ [FLOW_ID]: facts });
}

/** Facts answered only when the test says so. */
function answerFactsLater() {
  let answer: (facts: TemplateFlowFacts) => void = () => {};
  mockFetchTemplateFlowFacts.mockReturnValue(
    new Promise(resolve => {
      answer = facts => resolve({ [FLOW_ID]: facts });
    })
  );
  return (facts: TemplateFlowFacts) => answer(facts);
}

/** A graph editor over one graph, keeping each edit it commits. */
function createGraphEditor(
  nodes: ScenarioFlowNode[],
  graphEdges: ScenarioFlowEdge[] = edges
) {
  const committed: ScenarioGraphEdit[] = [];
  let graph: ScenarioGraphSnapshot = { nodes, edges: graphEdges };
  const editor: ScenarioGraphEditor = {
    read: () => graph,
    edit: transition => {
      const next = transition(graph);
      if (!next) return false;
      committed.push(next);
      graph = { nodes: next.nodes, edges: next.edges };
      return true;
    },
  };
  return {
    editor,
    committed,
    replaceNodes: (next: ScenarioFlowNode[]) => {
      graph = { ...graph, nodes: next };
    },
    replaceEdges: (next: ScenarioFlowEdge[]) => {
      graph = { ...graph, edges: next };
    },
    savedForm: () =>
      graph.nodes.find(item => item.id === "template")?.data
        .actionWhatsAppTemplateForm,
  };
}

let loadedSession = "session-1";

function renderLoader(editor: ScenarioGraphEditor) {
  return renderHook(
    ({ sessionOwnerKey }) =>
      useScenarioTemplateFormLoader({
        workspaceId: "workspace-1",
        graphEditor: editor,
        sessionOwnerKey,
        ownsLoadedSession: ownerKey => ownerKey === loadedSession,
      }),
    { initialProps: { sessionOwnerKey: "session-1" } }
  );
}

async function load(
  hook: ReturnType<typeof renderLoader>,
  options: ScenarioTemplateFormLoadOptions,
  nodeId = "template"
) {
  let result: unknown;
  await act(async () => {
    result = await hook.result.current.loadWhatsAppTemplateForm(
      nodeId,
      options
    );
  });
  return result;
}

describe("useScenarioTemplateFormLoader", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    loadedSession = "session-1";
  });

  it("saves the fields read fresh from WhatsApp, leaving a pick's Undo to the pick", async () => {
    answerFacts(found());
    const graph = createGraphEditor([trigger, formStep()]);
    const hook = renderLoader(graph.editor);

    await expect(load(hook, { reason: "pick" })).resolves.toEqual({
      status: "saved",
      fieldCount: 5,
      coverage: "complete",
      newlyUnavailable: [],
    });

    expect(mockFetchTemplateFlowFacts).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      flowIds: [FLOW_ID],
      force: true,
    });
    expect(graph.committed.map(edit => edit.history)).toEqual(["skip"]);
    expect(graph.savedForm()).toMatchObject({
      flowId: FLOW_ID,
      answersKey: "demoshop_ai_case",
      digest: SCHEMA.digest,
      readAt: CHECKED_AT,
    });

    // The same fields again save nothing.
    await expect(load(hook, { reason: "load" })).resolves.toEqual({
      status: "unchanged",
    });
    expect(graph.committed).toHaveLength(1);
  });

  it("records a Load the user asked for, so Undo reverts it", async () => {
    answerFacts(found());
    const graph = createGraphEditor([trigger, formStep()]);

    await load(renderLoader(graph.editor), { reason: "load" });

    expect(graph.committed.map(edit => edit.history)).toEqual(["record"]);
  });

  it("reads nothing for a step whose buttons open no form or whose form is built here", async () => {
    const graph = createGraphEditor([
      trigger,
      formStep({
        actionWhatsAppTemplateComponents: [
          { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Yes" }] },
        ],
      }),
      node("built", {
        ...formStep().data,
        actionFlowConfig: {
          templateId: "",
          ctaText: "Open",
          screens: [
            {
              id: "FORM",
              title: "Form",
              fields: [{ id: "size", label: "Size", fieldType: "TextInput" }],
            },
          ],
        },
      }),
    ]);
    const hook = renderLoader(graph.editor);

    await expect(load(hook, { reason: "pick" })).resolves.toEqual({
      status: "skipped",
    });
    await expect(load(hook, { reason: "load" }, "built")).resolves.toEqual({
      status: "skipped",
    });
    expect(mockFetchTemplateFlowFacts).not.toHaveBeenCalled();
  });

  describe("a bulk send's template, which has no Form submitted route", () => {
    const bulk = node("bulk", { kind: "bulk" });
    const filter = node("filter", {
      kind: "logic",
      logicType: "audience_filter",
    });
    const fromBulk = (target: string): ScenarioFlowEdge => ({
      id: `bulk-${target}`,
      source: "bulk",
      target,
      sourceHandle: BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
    });
    const sentStraight = [fromBulk("template")];
    // The flow check counts it too: no action runs before it.
    const behindLogic = [
      fromBulk("filter"),
      { id: "filter-template", source: "filter", target: "template" },
    ];

    it.each([
      ["sent straight from the bulk node", sentStraight],
      ["behind logic", behindLogic],
    ])("reads nothing when %s, on a pick or a Load", async (_, bulkEdges) => {
      answerFacts(found());
      const graph = createGraphEditor([bulk, filter, formStep()], bulkEdges);
      const hook = renderLoader(graph.editor);

      await expect(load(hook, { reason: "pick" })).resolves.toEqual({
        status: "skipped",
      });
      await expect(load(hook, { reason: "load" })).resolves.toEqual({
        status: "skipped",
      });
      expect(mockFetchTemplateFlowFacts).not.toHaveBeenCalled();
      expect(graph.committed).toEqual([]);
    });

    it("drops a read that returns after the step joined a bulk send", async () => {
      const answer = answerFactsLater();
      const graph = createGraphEditor([trigger, bulk, filter, formStep()]);
      const hook = renderLoader(graph.editor);

      let pending: Promise<unknown> = Promise.resolve();
      act(() => {
        pending = hook.result.current.loadWhatsAppTemplateForm("template", {
          reason: "pick",
        });
      });
      graph.replaceEdges(behindLogic);
      await act(async () => {
        answer(found());
        await expect(pending).resolves.toEqual({ status: "skipped" });
      });

      expect(graph.committed).toEqual([]);
      expect(graph.savedForm()).toBeUndefined();
    });
  });

  it("drops a read that returns after the step moved to another Flow", async () => {
    const answer = answerFactsLater();
    const graph = createGraphEditor([trigger, formStep()]);
    const hook = renderLoader(graph.editor);

    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = hook.result.current.loadWhatsAppTemplateForm("template", {
        reason: "pick",
      });
    });
    graph.replaceNodes([
      trigger,
      formStep({
        actionWhatsAppTemplateComponents: [
          {
            type: "BUTTONS",
            buttons: [
              { type: "FLOW", text: "Open", flow_id: "2244981489363579" },
            ],
          },
        ],
      }),
    ]);
    await act(async () => {
      answer(found());
      await expect(pending).resolves.toEqual({ status: "skipped" });
    });

    expect(graph.committed).toEqual([]);
    expect(graph.savedForm()).toBeUndefined();
  });

  it("drops a read that returns after another scenario was loaded", async () => {
    const answer = answerFactsLater();
    const graph = createGraphEditor([trigger, formStep()]);
    const hook = renderLoader(graph.editor);

    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = hook.result.current.loadWhatsAppTemplateForm("template", {
        reason: "pick",
      });
    });
    expect(hook.result.current.loadingTemplateFormNodeIds).toEqual(
      new Set(["template"])
    );
    loadedSession = "session-2";
    hook.rerender({ sessionOwnerKey: "session-2" });
    // The other visit has its own steps, so this one isn't loading there.
    expect(hook.result.current.loadingTemplateFormNodeIds.size).toBe(0);
    await act(async () => {
      answer(found());
      await expect(pending).resolves.toEqual({ status: "skipped" });
    });

    expect(graph.committed).toEqual([]);
  });

  it("asks before an update removes answers a prompt reads, and saves once confirmed", async () => {
    const withoutName = {
      ...SCHEMA,
      digest: "without-name",
      fields: SCHEMA.fields.filter(field => field.responseKey !== "_68d224"),
    };
    answerFacts(found(withoutName));
    const graph = createGraphEditor([
      trigger,
      formStep({
        actionWhatsAppTemplateForm: {
          version: 1,
          flowId: FLOW_ID,
          answersKey: "demoshop_ai_case",
          readAt: "2026-10-01T00:00:00.000Z",
          ...SCHEMA,
        },
      }),
      portrait,
    ]);
    const hook = renderLoader(graph.editor);

    await expect(load(hook, { reason: "update" })).resolves.toEqual({
      status: "needs_confirmation",
      newlyUnavailable: [
        { token: "form.demoshop_ai_case.f_68d224", label: "Athlete's name" },
      ],
    });
    expect(graph.committed).toEqual([]);

    await expect(
      load(hook, { reason: "update", confirmRemovals: true })
    ).resolves.toMatchObject({
      status: "saved",
      fieldCount: 4,
      newlyUnavailable: [
        { token: "form.demoshop_ai_case.f_68d224", label: "Athlete's name" },
      ],
    });
    expect(graph.committed.map(edit => edit.history)).toEqual(["record"]);
    expect(graph.savedForm()).toMatchObject({ digest: "without-name" });
  });

  it("says when WhatsApp has no such Flow or it can't be read, and saves nothing", async () => {
    const graph = createGraphEditor([trigger, formStep()]);
    const hook = renderLoader(graph.editor);

    answerFacts({ flowId: FLOW_ID, state: "missing", checkedAt: CHECKED_AT });
    await expect(load(hook, { reason: "load" })).resolves.toEqual({
      status: "missing",
    });
    answerFacts({
      flowId: FLOW_ID,
      state: "unavailable",
      checkedAt: CHECKED_AT,
    });
    await expect(load(hook, { reason: "load" })).resolves.toEqual({
      status: "unavailable",
    });
    // The Flow was found, but its JSON couldn't be read.
    answerFacts(found(null));
    await expect(load(hook, { reason: "load" })).resolves.toEqual({
      status: "unavailable",
    });
    expect(graph.committed).toEqual([]);
  });

  it("shows the step as loading only while its Flow is read", async () => {
    const answer = answerFactsLater();
    const graph = createGraphEditor([trigger, formStep()]);
    const hook = renderLoader(graph.editor);
    expect(hook.result.current.loadingTemplateFormNodeIds.size).toBe(0);

    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = hook.result.current.loadWhatsAppTemplateForm("template", {
        reason: "load",
      });
    });
    expect(hook.result.current.loadingTemplateFormNodeIds).toEqual(
      new Set(["template"])
    );

    await act(async () => {
      answer(found());
      await pending;
    });
    expect(hook.result.current.loadingTemplateFormNodeIds.size).toBe(0);
  });
});
