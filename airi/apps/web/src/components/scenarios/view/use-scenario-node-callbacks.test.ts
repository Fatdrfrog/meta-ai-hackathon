/** @jest-environment jsdom */

import { ACTION_NO_REPLY_OUTCOME_HANDLE_ID } from "@icecore/scenario-contracts";
import { act, renderHook, waitFor } from "@testing-library/react";
import { TextEncoder } from "node:util";
import { useState } from "react";
import { toast } from "sonner";
import { CURRENT_SCENARIO_GRAPH_SCHEMA_VERSION } from "@/lib/scenarios/scenario-graph-migrations";
import { getWhatsAppTemplateOptionValue } from "@/lib/whatsapp/templates/selection";
import {
  fetchScenarioById,
  ScenarioRequestError,
  updateScenarioRequest,
  uploadScenarioActionImage,
} from "@/lib/scenarios/client";
import {
  DEFAULT_SCENARIO_VIEWPORT,
  type ScenarioDocument,
  type ScenarioSummary,
  type ScenarioWhatsAppTemplate,
} from "../types";
import { getEditableWhatsAppTemplateEditorFormValues } from "../builders/whatsapp/template-editor-utils";
import { createGraphTestNode, createGraphTestEdge } from "./graph/test-utils";
import { useScenarioFlowController } from "./use-scenario-flow-controller";
import { useScenarioNodeCallbacks } from "./use-scenario-node-callbacks";

Object.defineProperty(globalThis, "TextEncoder", {
  configurable: true,
  value: TextEncoder,
});
jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn(), warning: jest.fn() },
}));
jest.mock("@/lib/scenarios/client", () => ({
  ...jest.requireActual("@/lib/scenarios/client"),
  fetchScenarioById: jest.fn(),
  updateScenarioRequest: jest.fn(),
  uploadScenarioActionImage: jest.fn(),
}));

const translate = (key: string) => key;
const confirmDocument = () => {};
function createDocument(): ScenarioDocument {
  return {
    _id: "scenario-1",
    graphSchemaVersion: CURRENT_SCENARIO_GRAPH_SCHEMA_VERSION,
    name: "Scenario 1",
    description: "",
    status: "draft",
    mode: "conversation",
    timezone: null,
    priority: 0,
    matchingRole: "default",
    entryPolicy: "repeatable",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nodes: [
      createGraphTestNode("trigger-1", {
        kind: "trigger",
        triggerConfig: {
          enabled: true,
          messageMatchMode: "any",
          keywordMatchMode: "regex",
          keywordPattern: "dormant pattern",
        },
      }),
      createGraphTestNode("context-1", {
        kind: "context",
        contextOptionId: "answer_snippets",
        contextItemIds: [],
      }),
      createGraphTestNode("action-1", {
        kind: "action",
        actionType: "reply",
        actionReplyText: "Hello",
      }),
    ],
    edges: [
      createGraphTestEdge("context-1", "action-1", {
        sourceHandle: "right-source",
        targetHandle: "left-target",
      }),
    ],
    viewport: DEFAULT_SCENARIO_VIEWPORT,
  };
}

function useCallbackHarness(
  document: ScenarioDocument,
  whatsAppTemplates: ScenarioWhatsAppTemplate[]
) {
  const [, setScenarios] = useState<ScenarioSummary[]>([]);
  const [, setEntryPriorityInput] = useState("0");
  const flow = useScenarioFlowController({
    workspaceId: "workspace-1",
    activeScenarioId: document._id,
    activeScenario: {
      ...document,
      nodeCount: document.nodes.length,
      edgeCount: document.edges.length,
    },
    activeScenarioName: document.name,
    activeScenarioDescription: document.description,
    activeScenarioStatus: document.status,
    entryPriorityInput: "0",
    setEntryPriorityInput,
    setScenarios,
    onScenarioDocumentConfirmed: confirmDocument,
    t: translate,
  });
  const callbacks = useScenarioNodeCallbacks({
    workspaceId: "workspace-1",
    graphEditor: flow.graphEditor,
    setSelectedNodeId: flow.setSelectedNodeId,
    contextOptions: [],
    whatsAppTemplates,
    loadContextItems: async () => {},
    t: translate,
  });
  return { flow, callbacks };
}

async function renderEditor(
  document = createDocument(),
  whatsAppTemplates: ScenarioWhatsAppTemplate[] = []
) {
  jest.mocked(fetchScenarioById).mockResolvedValue({
    scenario: document,
    metadata: { linkedConditionParentCountByNodeId: {} },
  });
  jest.mocked(updateScenarioRequest).mockImplementation(async input => ({
    ...document,
    ...input,
    updatedAt: "2026-01-01T00:00:01.000Z",
  }));
  const rendered = renderHook(() =>
    useCallbackHarness(document, whatsAppTemplates)
  );
  await waitFor(() =>
    expect(rendered.result.current.flow.loadingFlow).toBe(false)
  );
  return rendered;
}

beforeEach(() => jest.clearAllMocks());

describe("scenario node editing commands", () => {
  it.each([false, true])(
    "keeps strict template bindings enabled when template identity changes: %s",
    async differentTemplate => {
      const templateA: ScenarioWhatsAppTemplate = {
        id: "template-a",
        name: "status_a",
        language: "en",
        components: [{ type: "BODY", text: "Status {{1}}" }],
      };
      const templateB: ScenarioWhatsAppTemplate = {
        ...templateA,
        id: "template-b",
        name: "status_b",
      };
      const bindings = {
        version: 1 as const,
        parameters: {
          "body:1": { source: "literal" as const, value: "Shipped" },
        },
      };
      const document = createDocument();
      document.nodes = document.nodes.map(node =>
        node.id === "action-1"
          ? {
              ...node,
              data: {
                kind: "action",
                actionType: "whatsapp_template",
                actionWhatsAppTemplateId: templateA.id,
                actionWhatsAppTemplateName: templateA.name,
                actionWhatsAppTemplateLanguage: templateA.language,
                actionWhatsAppTemplateComponents: templateA.components,
                actionWhatsAppTemplateBindings: bindings,
              },
            }
          : node
      );
      const { result } = await renderEditor(document, [templateA, templateB]);
      act(() =>
        result.current.callbacks.updateActionWhatsAppTemplateById(
          "action-1",
          getWhatsAppTemplateOptionValue(
            differentTemplate ? templateB : templateA
          )
        )
      );
      expect(
        result.current.flow.nodes.find(node => node.id === "action-1")!.data
          .actionWhatsAppTemplateBindings
      ).toEqual(differentTemplate ? { version: 1, parameters: {} } : bindings);
    }
  );

  it("selects the new template body before saving the graph", async () => {
    const templateA: ScenarioWhatsAppTemplate = {
      id: "template-a",
      name: "welcome_a",
      language: "en_US",
      components: [{ type: "BODY", text: "Updated template A" }],
    };
    const templateB: ScenarioWhatsAppTemplate = {
      id: "template-b",
      name: "welcome_b",
      language: "en_US",
      components: [{ type: "BODY", text: "Template B" }],
    };
    const document = createDocument();
    document.nodes = document.nodes.map(node =>
      node.id === "action-1"
        ? {
            ...node,
            data: {
              kind: "action",
              actionType: "whatsapp_template",
              actionReplyText: "Updated template A",
              generatedTemplateDraft: {
                id: "draft-a",
                name: "welcome_a",
                language: "en_US",
                status: "draft",
              },
              actionWhatsAppTemplateId: templateA.id,
              actionWhatsAppTemplateName: templateA.name,
              actionWhatsAppTemplateLanguage: templateA.language,
              actionWhatsAppTemplateComponents: templateA.components,
            },
          }
        : node
    );
    const { result } = await renderEditor(document, [templateA, templateB]);
    act(() => {
      result.current.callbacks.updateActionWhatsAppTemplateById(
        "action-1",
        getWhatsAppTemplateOptionValue(templateB)
      );
    });
    const selected = result.current.flow.nodes.find(
      node => node.id === "action-1"
    )!.data;
    expect(
      getEditableWhatsAppTemplateEditorFormValues({
        replyText: selected.actionReplyText,
        components: selected.actionWhatsAppTemplateComponents,
      }).bodyText
    ).toBe("Template B");
    expect(selected.actionWhatsAppTemplateId).toBe(templateB.id);
    expect(selected.generatedTemplateDraft).toBeUndefined();

    await act(async () => {
      expect(await result.current.flow.flushScenario()).toBe(true);
    });
    const saved = jest
      .mocked(updateScenarioRequest)
      .mock.calls[0][0].nodes.find(node => node.id === "action-1")!.data;
    expect(saved.actionWhatsAppTemplateId).toBe(templateB.id);
    expect(saved.actionWhatsAppTemplateComponents).toEqual(
      templateB.components
    );
  });

  it("composes two same-tick trigger deltas against the latest node state", async () => {
    const { result } = await renderEditor();
    act(() => {
      result.current.callbacks.updateTriggerConfigById("trigger-1", {
        channelFilter: ["whatsapp"],
      });
      result.current.callbacks.updateTriggerConfigById("trigger-1", {
        onlyNewCustomers: true,
      });
    });
    expect(result.current.flow.nodes[0]?.data.triggerConfig).toMatchObject({
      channelFilter: ["whatsapp"],
      onlyNewCustomers: true,
      messageMatchMode: "any",
      keywordMatchMode: "regex",
      keywordPattern: "dormant pattern",
    });
    expect(result.current.flow.nodes[0]?.data).not.toHaveProperty(
      "triggerType"
    );
  });

  it("persists composed context selections when saving before React renders", async () => {
    const { result } = await renderEditor();
    await act(async () => {
      result.current.callbacks.toggleContextItemSelectionById(
        "context-1",
        "first"
      );
      result.current.callbacks.toggleContextItemSelectionById(
        "context-1",
        "second"
      );
      expect(await result.current.flow.flushScenario()).toBe(true);
    });
    expect(updateScenarioRequest).toHaveBeenCalledTimes(1);
    expect(jest.mocked(updateScenarioRequest).mock.calls[0]?.[0].nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "context-1",
          data: expect.objectContaining({
            contextItemIds: ["first", "second"],
          }),
        }),
      ])
    );
  });

  it("removes a node and its edges as one undoable edit without recording repeated deletion", async () => {
    const { result } = await renderEditor();
    act(() => {
      result.current.callbacks.removeNodeById("action-1");
      result.current.callbacks.removeNodeById("action-1");
    });
    expect(result.current.flow.nodes.map(node => node.id)).not.toContain(
      "action-1"
    );
    expect(result.current.flow.edges).toHaveLength(0);
    act(() => {
      expect(result.current.flow.undoGraphChange()).toBe(true);
    });
    expect(result.current.flow.nodes.map(node => node.id)).toContain(
      "action-1"
    );
    expect(result.current.flow.edges).toHaveLength(1);
    act(() => {
      expect(result.current.flow.undoGraphChange()).toBe(false);
    });
  });

  it("keeps missing-node and unchanged trigger edits clean", async () => {
    const { result } = await renderEditor();
    await act(async () => {
      result.current.callbacks.updateTriggerConfigById("missing", {
        enabled: false,
      });
      result.current.callbacks.updateTriggerConfigById("trigger-1", {
        enabled: true,
      });
      result.current.callbacks.updateNodeById("action-1", {
        actionReplyText: "Hello",
      });
      result.current.callbacks.removeNodeById("missing");
      await result.current.flow.flushScenario();
    });
    expect(updateScenarioRequest).not.toHaveBeenCalled();
    expect(result.current.flow.saveStatus).toBe("saved");
  });

  it("persists node-kind and edge changes together and restores both with undo", async () => {
    const { result } = await renderEditor();
    await act(async () => {
      result.current.callbacks.updateNodeById("action-1", { kind: "trigger" });
      expect(await result.current.flow.flushScenario()).toBe(true);
    });
    const savedChange = jest.mocked(updateScenarioRequest).mock.calls[0][0];
    expect(
      savedChange.nodes.find(node => node.id === "action-1")?.data.kind
    ).toBe("trigger");
    expect(savedChange.edges).toHaveLength(0);

    await act(async () => {
      expect(result.current.flow.undoGraphChange()).toBe(true);
      expect(await result.current.flow.flushScenario()).toBe(true);
    });
    const savedUndo = jest.mocked(updateScenarioRequest).mock.calls[1][0];
    expect(
      savedUndo.nodes.find(node => node.id === "action-1")?.data.kind
    ).toBe("action");
    expect(savedUndo.edges).toHaveLength(1);
  });

  it("keeps the no-reply timer route when the reply mode changes", async () => {
    const document = createDocument();
    document.nodes = [
      ...document.nodes.map(node =>
        node.id === "action-1"
          ? {
              ...node,
              data: {
                ...node.data,
                actionReplyMode: "fixed" as const,
                actionOutcomes: {
                  version: 1 as const,
                  noReply: { enabled: true, timeoutMinutes: 30 },
                },
              },
            }
          : node
      ),
      createGraphTestNode("follow-up", {
        kind: "action",
        actionType: "reply",
        actionReplyText: "Still there?",
      }),
    ];
    document.edges = [
      ...document.edges,
      createGraphTestEdge("action-1", "follow-up", {
        sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
        targetHandle: "left-target",
      }),
    ];
    const timerRoute = expect.objectContaining({
      source: "action-1",
      sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
      target: "follow-up",
    });
    const { result } = await renderEditor(document);

    await act(async () => {
      result.current.callbacks.updateNodeById("action-1", {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "ai",
      });
      expect(await result.current.flow.flushScenario()).toBe(true);
    });

    const saved = jest.mocked(updateScenarioRequest).mock.calls[0][0];
    expect(
      saved.nodes.find(node => node.id === "action-1")?.data.actionReplyMode
    ).toBe("ai");
    expect(saved.edges).toContainEqual(timerRoute);
    act(() => {
      expect(result.current.flow.undoGraphChange()).toBe(true);
    });
    expect(
      result.current.flow.nodes.find(node => node.id === "action-1")?.data
        .actionReplyMode
    ).toBe("fixed");
    expect(result.current.flow.edges).toContainEqual(timerRoute);
  });
});

describe("action file uploads", () => {
  const file = () => new File(["image"], "menu.png", { type: "image/png" });

  it("attaches the file without a success toast", async () => {
    jest.mocked(uploadScenarioActionImage).mockResolvedValue({
      url: "https://cdn.example.com/menu.png",
      bucket: "scenario-media",
      path: "workspace-1/menu.png",
      mediaType: "image",
    });
    const { result } = await renderEditor();

    let attachment: unknown;
    await act(async () => {
      attachment = await result.current.callbacks.uploadActionImageForNodeId(
        "action-1",
        file()
      );
    });

    expect(attachment).toEqual(
      expect.objectContaining({ url: "https://cdn.example.com/menu.png" })
    );
    expect(
      result.current.flow.nodes.find(node => node.id === "action-1")!.data
        .actionImageUrls
    ).toEqual(["https://cdn.example.com/menu.png"]);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("shows the localized failure without the server message", async () => {
    jest
      .mocked(uploadScenarioActionImage)
      .mockRejectedValue(new Error("Storage bucket quota exceeded"));
    const { result } = await renderEditor();

    let attachment: unknown = "unset";
    await act(async () => {
      attachment = await result.current.callbacks.uploadActionImageForNodeId(
        "action-1",
        file()
      );
    });

    expect(attachment).toBeUndefined();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith("actionImageUploadFailed");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("propagates a non-persisting upload failure to its media field without a toast", async () => {
    const error = new ScenarioRequestError({
      message: "Provider private bucket rejected this video",
      status: 413,
      code: "scenario_asset_upload_too_large",
    });
    jest.mocked(uploadScenarioActionImage).mockRejectedValue(error);
    const { result } = await renderEditor();

    let failure: unknown;
    await act(async () => {
      failure = await result.current.callbacks
        .uploadActionImageForNodeId("action-1", file(), { persist: false })
        .catch(reason => reason);
    });

    expect(failure).toBe(error);
    expect(
      result.current.flow.nodes.find(node => node.id === "action-1")!.data
        .actionImageUrls
    ).toBeUndefined();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("keeps a persisting upload failure handled with an actionable localized toast", async () => {
    jest.mocked(uploadScenarioActionImage).mockRejectedValue(
      new ScenarioRequestError({
        message: "Provider private bucket rejected this video",
        status: 413,
        code: "scenario_asset_upload_too_large",
      })
    );
    const { result } = await renderEditor();

    let attachment: unknown = "unset";
    await act(async () => {
      attachment = await result.current.callbacks.uploadActionImageForNodeId(
        "action-1",
        file()
      );
    });

    expect(attachment).toBeUndefined();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith("scenario_asset_upload_too_large");
  });
});
