/**
 * @jest-environment jsdom
 */

import { DEFAULT_SCENARIO_VIEWPORT } from "@/components/scenarios/types";
import { act, renderHook, waitFor } from "@testing-library/react";
import { TextEncoder } from "node:util";
import {
  readScenarioDetailOrThrow,
  readScenarioDocumentOrThrow,
} from "@/lib/scenarios/client/http";
import type { GeneratedTemplateScenarioUpdate } from "@/lib/scenarios/generated-template-submission";
import { GeneratedTemplateSubmissionError } from "@/lib/scenarios/client/generator";
import { createWhatsAppFlowEditableContentDigest } from "@/lib/scenarios/whatsapp-flow-projection";
import { replaceScenarioSummary } from "./scenario-summary-utils";
import { enrichBulkRootNodeData } from "./node-enrichment/bulk";
import { buildScenarioNodeGraphIndex } from "./node-enrichment/scenario-node-graph-index";
import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";
import {
  convertLegacyActionRoutingRequest,
  fetchScenarioById,
  retryScenarioTimerReplanRecoveryRequest,
  submitGeneratedScenarioTemplateRequest,
  ScenarioRequestError,
  updateScenarioRequest,
} from "@/lib/scenarios/client";
import {
  attachWhatsAppFlowProviderReference,
  fetchTemplateFlowFacts,
  provisionWhatsAppFlow,
} from "@/lib/whatsapp/flows/client";
import type {
  ScenarioDocument,
  ScenarioFlowEdge,
  ScenarioFlowNode,
} from "../types";
import {
  normalizeScenarioDocumentToFlow,
  resolveCanvasDeleteSelection,
  useScenarioFlowController,
} from "./use-scenario-flow-controller";

const mockToastWarning = jest.fn();

Object.defineProperty(globalThis, "TextEncoder", {
  configurable: true,
  value: TextEncoder,
});

jest.mock("sonner", () => ({
  toast: {
    error: jest.fn(),
    warning: (...args: unknown[]) => mockToastWarning(...args),
  },
}));

jest.mock("@/lib/scenarios/client", () => {
  const { ScenarioRequestError } = jest.requireActual(
    "@/lib/scenarios/client/http"
  );
  return {
    ScenarioRequestError,
    fetchScenarioGeneratorJobRequest: jest.requireActual(
      "@/lib/scenarios/client/generator"
    ).fetchScenarioGeneratorJobRequest,
    convertLegacyActionRoutingRequest: jest.fn(),
    fetchScenarioById: jest.fn(),
    retryScenarioTimerReplanRecoveryRequest: jest.fn(),
    updateScenarioRequest: jest.fn(),
    submitGeneratedScenarioTemplateRequest: jest.fn(),
  };
});

jest.mock("@/lib/whatsapp/flows/client", () => ({
  attachWhatsAppFlowProviderReference: jest.fn(),
  fetchTemplateFlowFacts: jest.fn(),
  provisionWhatsAppFlow: jest.fn(),
}));

const mockFetchScenarioById = fetchScenarioById as jest.MockedFunction<
  typeof fetchScenarioById
>;
const mockConvertLegacyActionRoutingRequest =
  convertLegacyActionRoutingRequest as jest.MockedFunction<
    typeof convertLegacyActionRoutingRequest
  >;
const mockUpdateScenarioRequest = updateScenarioRequest as jest.MockedFunction<
  typeof updateScenarioRequest
>;
const mockRetryScenarioTimerReplanRecoveryRequest =
  retryScenarioTimerReplanRecoveryRequest as jest.MockedFunction<
    typeof retryScenarioTimerReplanRecoveryRequest
  >;
const mockAttachWhatsAppFlowProviderReference =
  attachWhatsAppFlowProviderReference as jest.MockedFunction<
    typeof attachWhatsAppFlowProviderReference
  >;

function createScenarioDocument(
  overrides: Partial<ScenarioDocument> = {}
): ScenarioDocument {
  return {
    _id: "scenario-1",
    name: "Scenario 1",
    description: "",
    status: "draft",
    mode: "conversation",
    timezone: null,
    priority: 0,
    presetId: null,
    presetVersion: null,
    segmentKey: null,
    matchingRole: "default",
    entryPolicy: "repeatable",
    linkedParentScenarioIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nodes: [],
    edges: [],
    viewport: DEFAULT_SCENARIO_VIEWPORT,
    ...overrides,
  } as ScenarioDocument;
}

function createScenarioDetailResponse(
  scenario: ScenarioDocument,
  linkedConditionParentCountByNodeId: Record<string, number> = {}
) {
  return {
    scenario,
    metadata: { linkedConditionParentCountByNodeId },
  };
}

function createActionNode(
  id: string,
  position: { x: number; y: number }
): ScenarioFlowNode {
  return {
    id,
    type: "actionNode",
    position,
    data: {
      kind: "action",
      actionType: "reply",
    },
  } as ScenarioFlowNode;
}

function createGeneratedBulkNode(
  configPatch: Record<string, unknown> = {}
): ScenarioFlowNode {
  return {
    id: "bulk-root-1",
    type: "bulkNode",
    position: { x: 0, y: 0 },
    data: {
      kind: "bulk",
      bulkRootConfig: {
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        campaignName: "Generated campaign",
        recipientSourceSummary: "1 recipient",
        generationStatus: "generating_media",
        generationJobId: "generation-job-1",
        generatedRecipientCount: 1,
        ...configPatch,
      },
    },
  } as ScenarioFlowNode;
}

function completedGeneratedBulkNode(generationJobId = "generation-job-1") {
  return createGeneratedBulkNode({
    recipientSourceSummary: "25 logical recipients",
    generationStatus: "complete",
    generationJobId,
    generatedRecipientCount: 50,
  });
}

function createReplyActionNode(
  id: string,
  replyText: string
): ScenarioFlowNode {
  return {
    ...createActionNode(id, { x: 240, y: 0 }),
    data: {
      kind: "action",
      actionType: "reply",
      actionReplyText: replyText,
    },
  } as ScenarioFlowNode;
}

function createWhatsAppFlowActionNode(
  config: WhatsAppFlowConfig,
  templateFlowId?: string
): ScenarioFlowNode {
  return {
    id: "flow-action-1",
    type: "actionNode",
    position: { x: 0, y: 0 },
    data: {
      kind: "action",
      actionType: "whatsapp_template",
      actionFlowConfig: config,
      ...(templateFlowId
        ? {
            actionWhatsAppTemplateComponents: [
              {
                type: "BUTTONS",
                buttons: [
                  { type: "FLOW", text: "Open", flow_id: templateFlowId },
                ],
              },
            ],
          }
        : {}),
    },
  } as ScenarioFlowNode;
}

function createProviderReferenceConfig(): WhatsAppFlowConfig {
  return {
    templateId: "provider_reference",
    ctaText: "Open",
    flowNavigationMode: "data_endpoint",
    screens: [{ id: "APPOINTMENT", title: "Appointment", fields: [] }],
    providerReference: {
      flowId: "flow-1",
      sourceId: "source-1",
      wabaId: "waba-1",
      flowName: "Provider Flow",
      providerStatus: "PUBLISHED",
      jsonVersion: "7.3",
      dataApiVersion: "3.0",
    },
  };
}

type FlowControllerRenderProps = {
  activeScenarioId: string;
  activeScenarioName: string;
  activeScenarioUpdatedAt: string;
  activeScenarioStatus?: ScenarioDocument["status"];
  keepSelectionThroughHistory?: boolean;
};

async function renderScenarioFlowController(
  initialProps: Partial<FlowControllerRenderProps> = {},
  initialGraph?: { nodes?: ScenarioFlowNode[]; edges?: ScenarioFlowEdge[] }
) {
  const setEntryPriorityInput = jest.fn();
  const setScenarios = jest.fn();
  const onScenarioDocumentConfirmed = (scenario: ScenarioDocument) =>
    setScenarios((current: Parameters<typeof replaceScenarioSummary>[0]) =>
      replaceScenarioSummary(current, scenario)
    );
  const t = (key: string) => key;
  const defaultProps: FlowControllerRenderProps = {
    activeScenarioId: "scenario-1",
    activeScenarioName: "Scenario 1",
    activeScenarioUpdatedAt: "2026-01-01T00:00:00.000Z",
    ...initialProps,
  };

  if (initialProps.activeScenarioUpdatedAt || initialGraph) {
    mockFetchScenarioById.mockResolvedValueOnce(
      createScenarioDetailResponse(
        createScenarioDocument({
          _id: defaultProps.activeScenarioId,
          updatedAt: defaultProps.activeScenarioUpdatedAt,
          status: defaultProps.activeScenarioStatus ?? "draft",
          ...initialGraph,
        })
      )
    );
  }

  const hook = renderHook(
    (props: FlowControllerRenderProps) =>
      useScenarioFlowController({
        workspaceId: "workspace-1",
        activeScenarioId: props.activeScenarioId,
        activeScenario: {
          _id: props.activeScenarioId,
          name: props.activeScenarioName,
          description: "",
          status: props.activeScenarioStatus ?? "draft",
          mode: "conversation",
          timezone: null,
          priority: 0,
          presetId: null,
          presetVersion: null,
          segmentKey: null,
          matchingRole: "default",
          entryPolicy: "repeatable",
          linkedParentScenarioIds: [],
          nodeCount: 0,
          edgeCount: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: props.activeScenarioUpdatedAt,
        },
        activeScenarioName: props.activeScenarioName,
        activeScenarioDescription: "",
        activeScenarioStatus: props.activeScenarioStatus ?? "draft",
        entryPriorityInput: "0",
        setEntryPriorityInput,
        setScenarios,
        onScenarioDocumentConfirmed,
        t,
        keepSelectionThroughHistory: props.keepSelectionThroughHistory,
      }),
    { initialProps: defaultProps }
  );

  await act(async () => {
    await Promise.resolve();
  });
  setScenarios.mockClear();
  return { ...hook, setScenarios };
}

type FlowController = Awaited<ReturnType<typeof renderScenarioFlowController>>;

// Moves every node one pixel right without recording history.
function nudgeNodes(result: FlowController["result"]) {
  return result.current.graphEditor.edit(graph => ({
    ...graph,
    nodes: graph.nodes.map(node => ({
      ...node,
      position: { ...node.position, x: node.position.x + 1 },
    })),
    history: "skip",
  }));
}

function switchScenario(
  rerender: FlowController["rerender"],
  activeScenarioId: string,
  activeScenarioName: string,
  activeScenarioUpdatedAt = "2026-01-01T00:00:00.000Z"
) {
  rerender({ activeScenarioId, activeScenarioName, activeScenarioUpdatedAt });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

// Runs the 3 s autosave timer and one microtask inside a single act().
async function flushAutosave() {
  await act(async () => {
    jest.advanceTimersByTime(3000);
    await Promise.resolve();
  });
}

// Starts an empty-patch legacy conversion of action-1 in one act() and lets
// one microtask run in a second act(); the pending promise is returned inside
// an object so awaiting this helper does not wait for the conversion.
async function startLegacyConversion(result: FlowController["result"]) {
  let conversionPromise!: Promise<boolean>;
  act(() => {
    conversionPromise = result.current.convertLegacyActionRouting({
      sourceActionNodeId: "action-1",
      sourceNodeId: "condition-1",
      sourceKind: "post_action_condition",
      patch: {},
    });
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { conversionPromise };
}

function sonnerMock() {
  return jest.requireMock("sonner") as { toast: { error: jest.Mock } };
}

describe("resolveCanvasDeleteSelection", () => {
  it("prefers edge deletion when an arrow is selected even if the panel node stays selected", () => {
    const selection = resolveCanvasDeleteSelection({
      reactFlowInstance: {
        getEdges: () => [
          {
            id: "edge-1",
            source: "action-1",
            target: "action-2",
            selected: true,
          },
        ],
        getNodes: () => [
          {
            id: "action-1",
            type: "actionNode",
            position: { x: 0, y: 0 },
            data: { kind: "action" },
            selected: true,
          },
        ],
      } as never,
      trackedNodeIds: new Set(),
      trackedEdgeIds: new Set(["edge-1"]),
    });

    expect(Array.from(selection.edgeIds)).toEqual(["edge-1"]);
    expect(Array.from(selection.nodeIds)).toEqual([]);
  });
});

describe("normalizeScenarioDocumentToFlow", () => {
  it("projects legacy canvas omissions while retaining incomplete authored configuration", () => {
    const scenario = createScenarioDocument({
      nodes: [
        {
          id: "legacy",
          data: { kind: "trigger", triggerType: "exact_incoming_message" },
        },
        {
          id: "draft",
          data: {
            kind: "action",
            actionGenerativeAIConfig: {
              version: 1,
              mode: "text_to_image",
              prompt: "",
            },
          },
        },
      ],
      edges: [{ source: "legacy", target: "draft" }],
    });
    const original = JSON.parse(JSON.stringify(scenario));
    const normalized = normalizeScenarioDocumentToFlow(scenario);
    expect(normalized.nodes[0]).toMatchObject({
      position: { x: 0, y: 0 },
      data: { triggerConfig: { messageMatchMode: "exact" } },
    });
    expect(normalized.nodes[0]?.data).not.toHaveProperty("triggerType");
    expect(normalized.nodes[1]?.data).toEqual(scenario.nodes[1]?.data);
    expect(normalized.edges[0]).toMatchObject({
      id: "edge-legacy-draft-0",
      source: "legacy",
      target: "draft",
    });
    expect(scenario).toEqual(original);
  });

  it("normalizes node types and falls back to the default viewport", () => {
    const scenario = {
      _id: "scenario-1",
      workspaceId: "workspace-1",
      name: "Scenario 1",
      description: "",
      status: "draft",
      mode: "conversation",
      timezone: null,
      priority: 0,
      presetId: null,
      presetVersion: null,
      segmentKey: null,
      matchingRole: "default",
      entryPolicy: "once_per_conversation",
      linkedParentScenarioIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nodes: [
        {
          id: "trigger-1",
          type: "scenarioNode",
          position: { x: 0, y: 0 },
          data: {
            kind: "trigger",
            triggerConfig: {
              enabled: true,
              messageMatchMode: "any",
              keywordMatchMode: "contains",
            },
          },
        },
        {
          id: "action-1",
          type: "scenarioNode",
          position: { x: 100, y: 0 },
          data: {
            kind: "action",
            actionType: "reply",
          },
        },
        {
          id: "bulk-1",
          type: "scenarioNode",
          position: { x: 200, y: 0 },
          data: {
            kind: "bulk",
          },
        },
      ],
      edges: [
        {
          id: "edge-1",
          source: "trigger-1",
          target: "action-1",
        },
      ],
    } as never;

    const normalized = normalizeScenarioDocumentToFlow(scenario);

    expect(normalized.nodes[0]?.type).toBe("triggerNode");
    expect(normalized.nodes[1]?.type).toBe("actionNode");
    expect(normalized.nodes[2]?.type).toBe("bulkNode");
    expect(normalized.edges).toHaveLength(1);
    expect(normalized.viewport).toEqual(DEFAULT_SCENARIO_VIEWPORT);
  });
});

describe("useScenarioFlowController viewport adoption", () => {
  beforeEach(() => {
    mockUpdateScenarioRequest.mockResolvedValue(createScenarioDocument());
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("fits a scenario on its first load instead of reusing a shared persisted viewport", async () => {
    mockFetchScenarioById.mockResolvedValueOnce(
      createScenarioDetailResponse(
        createScenarioDocument({
          nodes: [
            createActionNode("action-1", { x: -300, y: 1500 }),
            createActionNode("action-2", { x: 4180, y: 4008 }),
          ],
          viewport: {
            x: -400,
            y: -5000,
            zoom: 1.2,
          },
        })
      )
    );
    const fitView = jest.fn().mockResolvedValue(true);
    const setViewport = jest.fn().mockResolvedValue(true);
    const { result } = await renderScenarioFlowController();

    await waitFor(() => expect(result.current.loadingFlow).toBe(false));

    // The canvas mounts fitted (React Flow's fitView prop), not at the
    // persisted viewport, and init does not fit a second time with a jump.
    expect(result.current.readInitialViewport()).toEqual({
      viewport: null,
      fitView: true,
    });
    act(() => {
      result.current.setReactFlowInstance({
        fitView,
        setViewport,
      } as never);
    });

    expect(fitView).not.toHaveBeenCalled();
    expect(setViewport).not.toHaveBeenCalled();
    expect(result.current.readInitialViewport()).toEqual({
      viewport: {
        x: -400,
        y: -5000,
        zoom: 1.2,
      },
      fitView: false,
    });
  });

  it("reopens a scenario at its session viewport from the first frame, without animating", async () => {
    mockFetchScenarioById.mockImplementation(async ({ scenarioId }) =>
      createScenarioDetailResponse(
        createScenarioDocument({
          _id: scenarioId,
          nodes: [createActionNode("action-1", { x: 0, y: 0 })],
        })
      )
    );
    const setViewport = jest.fn().mockResolvedValue(true);
    const { result, rerender } = await renderScenarioFlowController();
    await waitFor(() => expect(result.current.loadingFlow).toBe(false));
    act(() => {
      result.current.setReactFlowInstance({
        fitView: jest.fn().mockResolvedValue(true),
        setViewport,
      } as never);
      result.current.onViewportChange({ x: 12, y: 34, zoom: 0.8 });
    });

    await act(async () => {
      switchScenario(rerender, "scenario-2", "Scenario 2");
    });
    await waitFor(() => expect(result.current.loadingFlow).toBe(false));
    await act(async () => {
      switchScenario(rerender, "scenario-1", "Scenario 1");
    });
    await waitFor(() => expect(result.current.loadingFlow).toBe(false));

    expect(result.current.readInitialViewport()).toEqual({
      viewport: { x: 12, y: 34, zoom: 0.8 },
      fitView: false,
    });
    setViewport.mockClear();
    act(() => {
      result.current.setReactFlowInstance({
        fitView: jest.fn().mockResolvedValue(true),
        setViewport,
      } as never);
    });
    expect(setViewport).toHaveBeenCalledWith({ x: 12, y: 34, zoom: 0.8 });
  });
});

describe("useScenarioFlowController autosave", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockFetchScenarioById.mockImplementation(async ({ scenarioId }) =>
      createScenarioDetailResponse(createScenarioDocument({ _id: scenarioId }))
    );
    mockUpdateScenarioRequest.mockImplementation(async request =>
      createScenarioDocument({ ...request, _id: request.scenarioId })
    );
    mockRetryScenarioTimerReplanRecoveryRequest.mockResolvedValue({
      ok: true,
      outstanding: {
        status: null,
        affectedConversationIds: [],
        hasMore: false,
      },
    });
  });

  function generatedNode(): ScenarioFlowNode {
    return {
      ...createActionNode("generated-1", { x: 0, y: 0 }),
      data: {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "welcome",
        actionWhatsAppTemplateLanguage: "en_US",
        generatedTemplateDraft: {
          id: "draft-1",
          name: "welcome",
          language: "en_US",
          status: "draft",
        },
      },
    };
  }

  function generatedResponse() {
    return {
      templateId: "meta-1",
      status: "pending" as const,
      scenarioUpdate: {
        nodeId: "generated-1",
        previousScenarioUpdatedAt: "2026-01-01T00:00:00.000Z",
        scenarioUpdatedAt: "2026-01-01T00:01:00.000Z",
        patch: {
          actionWhatsAppTemplateId: "meta-1",
          actionWhatsAppTemplateName: "welcome",
          actionWhatsAppTemplateLanguage: "en_US",
          generatedTemplateDraft: {
            ...generatedNode().data.generatedTemplateDraft!,
            status: "pending" as const,
            metaTemplateId: "meta-1",
          },
        },
      },
    };
  }

  it("adopts the generated template server revision before the next save", async () => {
    jest
      .mocked(submitGeneratedScenarioTemplateRequest)
      .mockResolvedValueOnce(generatedResponse());
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [generatedNode()] }
    );
    await act(async () => {
      expect(
        await result.current.submitGeneratedTemplateForNode("generated-1")
      ).toBe(true);
    });
    expect(result.current.nodes[0].data.generatedTemplateDraft?.status).toBe(
      "pending"
    );
    expect(result.current.saveStatus).toBe("saved");
    act(() =>
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: graph.nodes.map(node => ({
          ...node,
          position: { x: 100, y: 100 },
        })),
        history: "record",
      }))
    );
    await act(async () => {
      await result.current.flushScenario();
    });
    expect(mockUpdateScenarioRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedUpdatedAt: "2026-01-01T00:01:00.000Z" })
    );
  });

  it("blocks duplicate submissions and saves while preserving a newer template selection", async () => {
    const { promise: submissionPromise, resolve: resolveSubmission } =
      deferred<ReturnType<typeof generatedResponse>>();
    jest
      .mocked(submitGeneratedScenarioTemplateRequest)
      .mockReturnValueOnce(submissionPromise);
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [generatedNode()] }
    );
    let submission!: Promise<boolean>;
    act(() => {
      submission = result.current.submitGeneratedTemplateForNode("generated-1");
    });
    expect(result.current.submittingGeneratedTemplateNodeId).toBe(
      "generated-1"
    );
    await act(async () => {
      expect(
        await result.current.submitGeneratedTemplateForNode("generated-1")
      ).toBe(false);
    });
    act(() =>
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: graph.nodes.map(node => ({
          ...node,
          data: {
            ...node.data,
            actionWhatsAppTemplateId: "template-b",
            actionWhatsAppTemplateName: "newer",
            generatedTemplateDraft: undefined,
          },
        })),
        history: "record",
      }))
    );
    await act(async () => {
      expect(await result.current.flushScenario()).toBe(false);
    });
    expect(mockUpdateScenarioRequest).not.toHaveBeenCalled();
    await act(async () => {
      resolveSubmission(generatedResponse());
      expect(await submission).toBe(false);
    });
    expect(result.current.nodes[0].data.actionWhatsAppTemplateId).toBe(
      "template-b"
    );
    expect(result.current.submittingGeneratedTemplateNodeId).toBeNull();
    await act(async () => {
      await result.current.flushScenario();
    });
    expect(mockUpdateScenarioRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedUpdatedAt: "2026-01-01T00:01:00.000Z",
        nodes: [
          expect.objectContaining({
            data: expect.objectContaining({
              actionWhatsAppTemplateId: "template-b",
            }),
          }),
        ],
      })
    );
    expect(
      jest.mocked(submitGeneratedScenarioTemplateRequest)
    ).toHaveBeenCalledTimes(1);
  });

  it("adopts a persisted rejection and retries with its committed revision", async () => {
    const rejected: GeneratedTemplateScenarioUpdate = {
      ...generatedResponse().scenarioUpdate,
      patch: {
        generatedTemplateDraft: {
          ...generatedNode().data.generatedTemplateDraft!,
          status: "rejected",
          error: "Provider rejected",
        },
      },
    };
    jest
      .mocked(submitGeneratedScenarioTemplateRequest)
      .mockRejectedValueOnce(
        new GeneratedTemplateSubmissionError("Provider rejected", 400, rejected)
      )
      .mockResolvedValueOnce({
        ...generatedResponse(),
        scenarioUpdate: {
          ...generatedResponse().scenarioUpdate,
          previousScenarioUpdatedAt: rejected.scenarioUpdatedAt,
          scenarioUpdatedAt: "2026-01-01T00:02:00.000Z",
        },
      });
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [generatedNode()] }
    );
    await act(async () => {
      await expect(
        result.current.submitGeneratedTemplateForNode("generated-1")
      ).rejects.toThrow("Provider rejected");
    });
    expect(result.current.nodes[0].data.generatedTemplateDraft?.status).toBe(
      "rejected"
    );
    expect(result.current.submittingGeneratedTemplateNodeId).toBeNull();
    await act(async () => {
      expect(
        await result.current.submitGeneratedTemplateForNode("generated-1")
      ).toBe(true);
    });
    expect(
      jest.mocked(submitGeneratedScenarioTemplateRequest)
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedUpdatedAt: rejected.scenarioUpdatedAt })
    );
  });

  it("merges submission into its unchanged node while preserving unrelated edits", async () => {
    const { promise: submissionPromise, resolve: resolveSubmission } =
      deferred<ReturnType<typeof generatedResponse>>();
    jest
      .mocked(submitGeneratedScenarioTemplateRequest)
      .mockReturnValueOnce(submissionPromise);
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [generatedNode(), createReplyActionNode("other", "Before")] }
    );
    let submission!: Promise<boolean>;
    act(() => {
      submission = result.current.submitGeneratedTemplateForNode("generated-1");
    });
    act(() =>
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: graph.nodes.map(node =>
          node.id === "other"
            ? { ...node, data: { ...node.data, actionReplyText: "Keep edit" } }
            : node
        ),
        history: "record",
      }))
    );
    await act(async () => {
      resolveSubmission(generatedResponse());
      expect(await submission).toBe(true);
    });
    expect(result.current.nodes[0].data.actionWhatsAppTemplateId).toBe(
      "meta-1"
    );
    expect(result.current.nodes[1].data.actionReplyText).toBe("Keep edit");
    expect(result.current.saveStatus).toBe("unsaved");
    await act(async () => {
      expect(await result.current.flushScenario()).toBe(true);
    });
    expect(mockUpdateScenarioRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedUpdatedAt: "2026-01-01T00:01:00.000Z" })
    );
  });

  it("saves dirty drafts before submitting and never calls the provider after a failed save", async () => {
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [generatedNode()] }
    );
    act(() =>
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: graph.nodes.map(node => ({
          ...node,
          position: { x: 20, y: 30 },
        })),
        history: "record",
      }))
    );
    mockUpdateScenarioRequest.mockRejectedValueOnce(new Error("Offline"));
    await act(async () => {
      await expect(
        result.current.submitGeneratedTemplateForNode("generated-1")
      ).rejects.toThrow("Save the scenario");
    });
    expect(
      jest.mocked(submitGeneratedScenarioTemplateRequest)
    ).not.toHaveBeenCalled();
    expect(result.current.submittingGeneratedTemplateNodeId).toBeNull();
    mockUpdateScenarioRequest.mockResolvedValueOnce(
      createScenarioDocument({
        nodes: [generatedNode()],
        updatedAt: "2026-01-01T00:00:30.000Z",
      })
    );
    jest.mocked(submitGeneratedScenarioTemplateRequest).mockResolvedValueOnce({
      ...generatedResponse(),
      scenarioUpdate: {
        ...generatedResponse().scenarioUpdate,
        previousScenarioUpdatedAt: "2026-01-01T00:00:30.000Z",
      },
    });
    await act(async () => {
      expect(
        await result.current.submitGeneratedTemplateForNode("generated-1")
      ).toBe(true);
    });
    expect(
      jest.mocked(submitGeneratedScenarioTemplateRequest)
    ).toHaveBeenCalledWith(
      expect.objectContaining({ expectedUpdatedAt: "2026-01-01T00:00:30.000Z" })
    );
  });

  it("keeps the submission lock across scenario visits and refreshes a returned clean editor", async () => {
    const { promise: submissionPromise, resolve: resolveSubmission } =
      deferred<ReturnType<typeof generatedResponse>>();
    jest
      .mocked(submitGeneratedScenarioTemplateRequest)
      .mockReturnValueOnce(submissionPromise);
    const { result, rerender } = await renderScenarioFlowController(
      {},
      { nodes: [generatedNode()] }
    );
    const originalCommand = result.current.submitGeneratedTemplateForNode;
    let submission!: Promise<boolean>;
    act(() => {
      submission = originalCommand("generated-1");
    });

    await expect(
      result.current.publishManagedWhatsAppFlow({
        nodeId: "flow-action-1",
        sourceId: "source-1",
        editableConfig: managedConfig(),
      })
    ).resolves.toBeNull();
    expect(provisionWhatsAppFlow).not.toHaveBeenCalled();
    await act(async () => {
      switchScenario(rerender, "scenario-b", "B");
    });
    await act(async () => {
      expect(await originalCommand("generated-1")).toBe(false);
    });
    mockFetchScenarioById.mockResolvedValueOnce(
      createScenarioDetailResponse(
        createScenarioDocument({ nodes: [generatedNode()] })
      )
    );
    await act(async () => {
      switchScenario(rerender, "scenario-1", "Scenario 1");
    });
    expect(result.current.submittingGeneratedTemplateNodeId).toBe(
      "generated-1"
    );
    await act(async () => {
      expect(
        await result.current.submitGeneratedTemplateForNode("generated-1")
      ).toBe(false);
    });
    const updatedNode = {
      ...generatedNode(),
      data: {
        ...generatedNode().data,
        ...generatedResponse().scenarioUpdate.patch,
      },
    };
    mockFetchScenarioById.mockResolvedValueOnce(
      createScenarioDetailResponse(
        createScenarioDocument({
          nodes: [updatedNode],
          updatedAt: "2026-01-01T00:01:00.000Z",
        })
      )
    );
    await act(async () => {
      resolveSubmission(generatedResponse());
      expect(await submission).toBe(false);
    });
    expect(result.current.nodes[0].data.actionWhatsAppTemplateId).toBe(
      "meta-1"
    );
    expect(result.current.submittingGeneratedTemplateNodeId).toBeNull();
    expect(
      jest.mocked(submitGeneratedScenarioTemplateRequest)
    ).toHaveBeenCalledTimes(1);
  });

  it("blocks saving after a malformed success with an unknown committed revision", async () => {
    jest
      .mocked(submitGeneratedScenarioTemplateRequest)
      .mockRejectedValueOnce(
        new GeneratedTemplateSubmissionError(
          "Invalid template submission response",
          200
        )
      );
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [generatedNode()] }
    );
    await act(async () => {
      await expect(
        result.current.submitGeneratedTemplateForNode("generated-1")
      ).rejects.toThrow("Invalid template submission");
    });
    expect(result.current.saveStatus).toBe("unsaved");
    await act(async () => {
      expect(await result.current.flushScenario()).toBe(false);
    });
    expect(mockUpdateScenarioRequest).not.toHaveBeenCalled();
  });

  it("refuses an unrelated revision response without replacing local graph state", async () => {
    jest.mocked(submitGeneratedScenarioTemplateRequest).mockResolvedValueOnce({
      ...generatedResponse(),
      scenarioUpdate: {
        ...generatedResponse().scenarioUpdate,
        previousScenarioUpdatedAt: "2026-01-01T00:00:30.000Z",
      },
    });
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [generatedNode()] }
    );
    await act(async () => {
      await expect(
        result.current.submitGeneratedTemplateForNode("generated-1")
      ).rejects.toThrow("refresh before saving");
    });
    expect(result.current.nodes[0].data.generatedTemplateDraft?.status).toBe(
      "draft"
    );
    expect(result.current.saveStatus).toBe("unsaved");
    await act(async () => {
      expect(await result.current.flushScenario()).toBe(false);
    });
  });

  it("retains the confirmed revision and edits when a malformed successful save is rejected", async () => {
    const node = createActionNode("action-1", { x: 0, y: 0 });
    const { result, setScenarios } = await renderScenarioFlowController(
      {},
      { nodes: [node], edges: [] }
    );
    act(() => {
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: graph.nodes.map(current => ({
          ...current,
          data: { ...current.data, actionReplyText: "Keep my edit" },
        })),
        history: "record",
      }));
    });
    mockUpdateScenarioRequest.mockImplementationOnce(() =>
      readScenarioDocumentOrThrow(
        {
          ok: true,
          json: async () => ({
            scenario: {
              ...createScenarioDocument(),
              updatedAt: "2026-01-01T00:01:00.000Z",
              nodes: {},
            },
          }),
        } as Response,
        "Failed to save scenario"
      )
    );
    await act(async () => {
      expect(await result.current.flushScenario()).toBe(false);
    });
    expect(result.current.nodes).toHaveLength(1);
    expect(result.current.nodes[0]?.data.actionReplyText).toBe("Keep my edit");
    expect(result.current.saveStatus).toBe("unsaved");
    expect(setScenarios).not.toHaveBeenCalled();
    await act(async () => {
      expect(await result.current.flushScenario()).toBe(true);
    });
    expect(mockUpdateScenarioRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
        nodes: [
          expect.objectContaining({
            id: "action-1",
            data: expect.objectContaining({ actionReplyText: "Keep my edit" }),
          }),
        ],
      })
    );
  });

  it("retains a loaded graph when an authoritative reload returns a malformed document", async () => {
    const node = createActionNode("action-1", { x: 0, y: 0 });
    const { result, setScenarios } = await renderScenarioFlowController(
      {},
      { nodes: [node], edges: [] }
    );
    mockFetchScenarioById.mockImplementationOnce(() =>
      readScenarioDetailOrThrow(
        {
          ok: true,
          json: async () => ({
            scenario: { ...createScenarioDocument(), nodes: {} },
          }),
        } as Response,
        "Failed to load scenario"
      )
    );
    await act(async () => {
      expect(
        await result.current.reconcileGeneratedJobServerUpdate({
          generationJobId: "generation-job-1",
          previousScenarioUpdatedAt: "2026-01-01T00:01:00.000Z",
          scenarioUpdatedAt: "2026-01-01T00:02:00.000Z",
          scenarioRevisionConflict: true,
          nodeUpdates: [],
        })
      ).toEqual({ status: "failed" });
    });
    expect(result.current.nodes).toHaveLength(1);
    expect(result.current.nodes[0]?.id).toBe("action-1");
    expect(setScenarios).not.toHaveBeenCalled();
  });

  it("shows persistent timer recovery after reload and retries the exact scenario", async () => {
    const warning = {
      code: "legacy_action_routing_timer_replan_failed" as const,
      message: "Timer recovery still needs attention for 1 conversation.",
      affectedConversationIds: ["conversation-1"],
      recoveryStatus: "failed" as const,
      retryable: true,
    };
    mockFetchScenarioById
      .mockResolvedValueOnce({
        scenario: createScenarioDocument(),
        metadata: {
          linkedConditionParentCountByNodeId: {},
          warnings: [warning],
        },
      })
      .mockResolvedValueOnce(
        createScenarioDetailResponse(createScenarioDocument())
      );

    await renderScenarioFlowController();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockToastWarning).toHaveBeenCalledWith(
      warning.message,
      expect.objectContaining({
        action: expect.objectContaining({ label: "retryTimerRecoveryAction" }),
      })
    );
    const action = mockToastWarning.mock.calls[0]?.[1]?.action;
    await act(async () => {
      await action.onClick();
    });

    expect(mockRetryScenarioTimerReplanRecoveryRequest).toHaveBeenCalledWith({
      scenarioId: "scenario-1",
      workspaceId: "workspace-1",
    });
    expect(mockFetchScenarioById).toHaveBeenCalledTimes(2);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it("saves a template step's loaded form fields with the next autosave, and Undo removes them", async () => {
    jest.mocked(fetchTemplateFlowFacts).mockResolvedValue({
      "1571793974235171": {
        flowId: "1571793974235171",
        state: "found",
        name: "demoshop_ai_case",
        status: "PUBLISHED",
        screenIds: ["DETAILS"],
        answerSchema: {
          flowName: "demoshop_ai_case",
          digest: "digest-1",
          coverage: "complete",
          endpoint: false,
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
        checkedAt: "2026-10-05T10:00:00.000Z",
      },
    });
    const { result } = await renderScenarioFlowController(
      {},
      {
        nodes: [
          {
            ...createActionNode("template-1", { x: 0, y: 0 }),
            data: {
              kind: "action",
              actionType: "whatsapp_template",
              actionWhatsAppTemplateName: "demoshop_test",
              actionWhatsAppTemplateComponents: [
                {
                  type: "BUTTONS",
                  buttons: [
                    {
                      type: "FLOW",
                      text: "Open form",
                      flow_id: "1571793974235171",
                    },
                  ],
                },
              ],
            },
          },
        ],
        edges: [],
      }
    );

    let loaded: unknown;
    await act(async () => {
      loaded = await result.current.loadWhatsAppTemplateForm("template-1", {
        reason: "load",
      });
    });
    expect(loaded).toMatchObject({ status: "saved", fieldCount: 1 });
    await act(async () => jest.advanceTimersByTime(3000));

    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(1);
    expect(mockUpdateScenarioRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        nodes: [
          expect.objectContaining({
            data: expect.objectContaining({
              actionWhatsAppTemplateForm: expect.objectContaining({
                flowId: "1571793974235171",
                answersKey: "demoshop_ai_case",
                readAt: "2026-10-05T10:00:00.000Z",
              }),
            }),
          }),
        ],
      })
    );
    act(() => {
      result.current.undoGraphChange();
    });
    expect(
      result.current.nodes[0]?.data.actionWhatsAppTemplateForm
    ).toBeUndefined();
  });

  it("debounces autosave until typing stops and saves the latest text", async () => {
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [createActionNode("action-1", { x: 0, y: 0 })], edges: [] }
    );
    const typeText = (text: string) =>
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: graph.nodes.map(node => ({
          ...node,
          data: { ...node.data, actionReplyText: text },
        })),
        history: "record",
      }));
    act(() => typeText("Still typing"));
    act(() => jest.advanceTimersByTime(2500));
    act(() => typeText("Finished typing"));
    await act(async () => jest.advanceTimersByTime(500));
    expect(mockUpdateScenarioRequest).not.toHaveBeenCalled();
    await act(async () => jest.advanceTimersByTime(2500));
    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(1);
    expect(mockUpdateScenarioRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        nodes: [
          expect.objectContaining({
            data: expect.objectContaining({
              actionReplyText: "Finished typing",
            }),
          }),
        ],
      })
    );
  });

  it("retries autosave after correcting an edit that failed validation", async () => {
    const { result } = await renderScenarioFlowController(
      { activeScenarioStatus: "active" },
      { nodes: [createActionNode("action-1", { x: 0, y: 0 })], edges: [] }
    );
    mockUpdateScenarioRequest.mockRejectedValueOnce(
      new ScenarioRequestError({
        status: 400,
        code: "whatsappServiceMessageInvalid",
        message: "Finish the message",
      })
    );
    act(() =>
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: graph.nodes.map(node => ({
          ...node,
          data: { ...node.data, actionReplyText: "" },
        })),
        history: "record",
      }))
    );
    await act(async () => jest.advanceTimersByTime(3000));
    expect(result.current.saveStatus).toBe("unsaved");
    await act(async () => jest.advanceTimersByTime(12000));
    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(1);
    act(() =>
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: graph.nodes.map(node => ({
          ...node,
          data: { ...node.data, actionReplyText: "Complete message" },
        })),
        history: "record",
      }))
    );
    await act(async () => jest.advanceTimersByTime(3000));
    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(2);
    expect(result.current.saveStatus).toBe("saved");
  });

  it("does not redirect selection when an autosave reports blocking nodes", async () => {
    const blockingNode = createActionNode("action-1", { x: 0, y: 0 });
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [blockingNode], edges: [] }
    );
    const fitView = jest.fn().mockResolvedValue(true);
    act(() => {
      result.current.setReactFlowInstance({
        fitView,
        getViewport: jest.fn(() => DEFAULT_SCENARIO_VIEWPORT),
      } as never);
      result.current.graphEditor.edit(() => ({
        nodes: [blockingNode],
        edges: [],
        history: "record",
      }));
    });
    fitView.mockClear();
    mockUpdateScenarioRequest.mockRejectedValueOnce(
      new ScenarioRequestError({
        status: 400,
        code: "singleFlowRequired",
        message: "Invalid graph",
        nodeIds: [blockingNode.id],
      })
    );

    act(() => {
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: graph.nodes.map(node => ({
          ...node,
          data: { ...node.data, actionReplyText: "edited" },
        })),
        history: "record",
      }));
    });
    await act(async () => jest.advanceTimersByTime(3000));

    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(1);
    expect(result.current.selectedNodeId).toBeNull();
    expect(fitView).not.toHaveBeenCalled();
  });

  it("drops deferred blocker focus after the scenario session changes", async () => {
    const blockingNode = createActionNode("action-1", { x: 0, y: 0 });
    const fitView = jest.fn().mockResolvedValue(true);
    let deferredFrame: FrameRequestCallback | null = null;
    const frameSpy = jest
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation(callback => {
        deferredFrame = callback;
        return 1;
      });
    const { result, rerender } = await renderScenarioFlowController(
      {},
      { nodes: [blockingNode], edges: [] }
    );
    await waitFor(() => expect(result.current.loadingFlow).toBe(false));
    act(() => {
      result.current.setReactFlowInstance({
        fitView,
        getViewport: jest.fn(() => DEFAULT_SCENARIO_VIEWPORT),
      } as never);
      result.current.graphEditor.edit(() => ({
        nodes: [blockingNode],
        edges: [],
        history: "record",
      }));
    });
    fitView.mockClear();
    mockUpdateScenarioRequest.mockRejectedValueOnce(
      new ScenarioRequestError({
        status: 400,
        code: "singleFlowRequired",
        message: "Invalid graph",
        nodeIds: [blockingNode.id],
      })
    );

    await act(async () => {
      expect(
        await result.current.coordinateActiveScenarioPatch({ status: "active" })
      ).toBe(false);
    });
    expect(deferredFrame).not.toBeNull();
    expect(result.current.selectedNodeId).toBe(blockingNode.id);
    await act(async () => {
      switchScenario(rerender, "scenario-2", "Scenario 2");
    });
    act(() => {
      deferredFrame?.(performance.now());
    });

    expect(fitView).not.toHaveBeenCalled();
    frameSpy.mockRestore();
  });

  it("waits for a drag to finish before autosaving its final position", async () => {
    const initialNode = createActionNode("action-1", { x: 0, y: 0 });
    const movedNode = createActionNode("action-1", { x: 40, y: 0 });
    const { result } = await renderScenarioFlowController();

    await act(async () => {
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [initialNode],
        history: "skip",
      }));
      result.current.graphEditor.edit(graph => ({
        ...graph,
        edges: [],
        history: "skip",
      }));
    });

    act(() => {
      jest.advanceTimersByTime(2500);
    });

    await act(async () => {
      result.current.onNodesChange([
        {
          id: initialNode.id,
          type: "position",
          position: movedNode.position,
          dragging: true,
        },
      ]);
    });

    expect(mockUpdateScenarioRequest).not.toHaveBeenCalled();

    await flushAutosave();

    expect(mockUpdateScenarioRequest).not.toHaveBeenCalled();
    act(() =>
      result.current.onNodesChange([
        {
          id: initialNode.id,
          type: "position",
          position: movedNode.position,
          dragging: false,
        },
      ])
    );
    await act(async () => jest.advanceTimersByTime(3000));

    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(1);
    expect(mockUpdateScenarioRequest.mock.calls[0]?.[0].nodes).toEqual([
      expect.objectContaining(movedNode),
    ]);
  });

  function managedConfig(): WhatsAppFlowConfig {
    return {
      templateId: "lead_generation",
      ctaText: "Continue",
      flowNavigationMode: "linear",
      screens: [{ id: "LEAD_FORM", title: "Lead", fields: [] }],
    };
  }
  function managedResponse(config = managedConfig()) {
    return {
      ok: true,
      status: 200,
      data: {
        ok: true as const,
        operationId: "op-1",
        status: "COMPLETED" as const,
        stage: "COMPLETED" as const,
        projection: {
          operationId: "op-1",
          sourceId: "source-1",
          wabaId: "waba-1",
          contentRevision: 1,
          contentDigest: createWhatsAppFlowEditableContentDigest(config),
          flowId: "published-1",
          providerStatus: "PUBLISHED" as const,
        },
        scenarioRevision: { finalUpdatedAt: "2026-01-01T00:01:00.000Z" },
        phones: [],
        validationErrors: [] as [],
      },
    };
  }

  it("serializes managed publishing with every document provider operation", async () => {
    const { promise: publicationPromise, resolve: finish } =
      deferred<ReturnType<typeof managedResponse>>();
    jest.mocked(provisionWhatsAppFlow).mockReturnValueOnce(publicationPromise);
    const first = createWhatsAppFlowActionNode(managedConfig());
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [first, { ...first, id: "flow-2" }, generatedNode()] }
    );
    let publishing!: ReturnType<
      typeof result.current.publishManagedWhatsAppFlow
    >;
    act(() => {
      publishing = result.current.publishManagedWhatsAppFlow({
        nodeId: first.id,
        sourceId: "source-1",
        editableConfig: managedConfig(),
      });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.publishingManagedFlowNodeId).toBe(first.id);
    await act(async () => {
      expect(
        await result.current.publishManagedWhatsAppFlow({
          nodeId: "flow-2",
          sourceId: "source-1",
          editableConfig: managedConfig(),
        })
      ).toBeNull();
      expect(
        await result.current.submitGeneratedTemplateForNode("generated-1")
      ).toBe(false);
      expect(await result.current.flushScenario()).toBe(false);
      await expect(
        result.current.attachWhatsAppFlowProviderReferenceToNode({
          nodeId: first.id,
          sourceId: "source-1",
          flowId: "another",
        })
      ).rejects.toThrow("already running");
    });
    expect(jest.mocked(provisionWhatsAppFlow)).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish(managedResponse());
      expect((await publishing)?.adopted).toBe(true);
    });
    expect(result.current.publishingManagedFlowNodeId).toBeNull();
    expect(
      result.current.nodes[0].data.actionFlowConfig?.managedProvisioning?.flowId
    ).toBe("published-1");
  });

  it("keeps unrelated edits during managed publication and saves its final revision", async () => {
    const { promise: publicationPromise, resolve: finish } =
      deferred<ReturnType<typeof managedResponse>>();
    jest.mocked(provisionWhatsAppFlow).mockReturnValueOnce(publicationPromise);
    const { result } = await renderScenarioFlowController(
      {},
      {
        nodes: [
          createWhatsAppFlowActionNode(managedConfig()),
          createReplyActionNode("other", "before"),
        ],
      }
    );
    let publishing!: ReturnType<
      typeof result.current.publishManagedWhatsAppFlow
    >;
    await act(async () => {
      publishing = result.current.publishManagedWhatsAppFlow({
        nodeId: "flow-action-1",
        sourceId: "source-1",
        editableConfig: managedConfig(),
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() =>
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: graph.nodes.map(node =>
          node.id === "other"
            ? { ...node, data: { ...node.data, actionReplyText: "keep" } }
            : node
        ),
        history: "record",
      }))
    );
    await act(async () => {
      finish(managedResponse());
      await publishing;
    });
    expect(result.current.nodes[1].data.actionReplyText).toBe("keep");
    expect(result.current.saveStatus).toBe("unsaved");
    await act(async () => {
      expect(await result.current.flushScenario()).toBe(true);
    });
    expect(mockUpdateScenarioRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedUpdatedAt: "2026-01-01T00:01:00.000Z" })
    );
  });

  it("releases managed publication after a failure so the user can retry", async () => {
    jest
      .mocked(provisionWhatsAppFlow)
      .mockRejectedValueOnce(new Error("Provider unavailable"))
      .mockResolvedValueOnce(managedResponse());
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [createWhatsAppFlowActionNode(managedConfig())] }
    );
    const params = {
      nodeId: "flow-action-1",
      sourceId: "source-1",
      editableConfig: managedConfig(),
    };
    await act(async () => {
      await expect(
        result.current.publishManagedWhatsAppFlow(params)
      ).rejects.toThrow("Provider unavailable");
    });
    expect(result.current.publishingManagedFlowNodeId).toBeNull();
    await act(async () => {
      expect(
        (await result.current.publishManagedWhatsAppFlow(params))?.adopted
      ).toBe(true);
    });
    expect(provisionWhatsAppFlow).toHaveBeenCalledTimes(2);
    expect(result.current.saveStatus).toBe("saved");
  });

  it("protects changed Flow content when an older publication commits", async () => {
    const { promise: publicationPromise, resolve: finish } =
      deferred<ReturnType<typeof managedResponse>>();
    jest.mocked(provisionWhatsAppFlow).mockReturnValueOnce(publicationPromise);
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [createWhatsAppFlowActionNode(managedConfig())] }
    );
    let publishing!: ReturnType<
      typeof result.current.publishManagedWhatsAppFlow
    >;
    await act(async () => {
      publishing = result.current.publishManagedWhatsAppFlow({
        nodeId: "flow-action-1",
        sourceId: "source-1",
        editableConfig: managedConfig(),
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    const changed = { ...managedConfig(), ctaText: "New unsaved CTA" };
    act(() =>
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [createWhatsAppFlowActionNode(changed)],
        history: "record",
      }))
    );
    await act(async () => {
      finish(managedResponse());
      expect((await publishing)?.adopted).toBe(false);
    });
    expect(result.current.nodes[0].data.actionFlowConfig).toEqual(changed);
    expect(result.current.saveStatus).toBe("unsaved");
    await expect(result.current.flushScenario()).resolves.toBe(false);
    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(1);
    expect(result.current.publishingManagedFlowNodeId).toBeNull();
  });

  it("adopts a committed Flow projection even when a later provider stage reports failure", async () => {
    const response = managedResponse();
    jest.mocked(provisionWhatsAppFlow).mockResolvedValueOnce({
      ...response,
      ok: false,
      status: 502,
      data: {
        ...response.data,
        ok: false,
        status: "FAILED",
        stage: "ENSURING_PHONE_KEYS",
        error: {
          code: "WHATSAPP_FLOW_PROVISIONING_PHONE_KEYS_NOT_READY",
          message: "Phone unavailable",
          retryable: true,
        },
      },
    });
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [createWhatsAppFlowActionNode(managedConfig())] }
    );
    await act(async () => {
      const publication = await result.current.publishManagedWhatsAppFlow({
        nodeId: "flow-action-1",
        sourceId: "source-1",
        editableConfig: managedConfig(),
      });
      expect(publication?.response.ok).toBe(false);
      expect(publication?.adopted).toBe(true);
    });
    expect(
      result.current.nodes[0].data.actionFlowConfig?.managedProvisioning?.flowId
    ).toBe("published-1");
    expect(result.current.publishingManagedFlowNodeId).toBeNull();
  });

  it.each([false, true])(
    "retains the publication lock across A to B to A and preserves new edits=%s",
    async dirty => {
      const { promise: publicationPromise, resolve: finish } =
        deferred<ReturnType<typeof managedResponse>>();
      jest
        .mocked(provisionWhatsAppFlow)
        .mockReturnValueOnce(publicationPromise);
      const initial = createWhatsAppFlowActionNode(managedConfig());
      const { result, rerender } = await renderScenarioFlowController(
        {},
        { nodes: [initial] }
      );
      const retainedPublish = result.current.publishManagedWhatsAppFlow;
      let publishing!: ReturnType<typeof retainedPublish>;
      await act(async () => {
        publishing = retainedPublish({
          nodeId: initial.id,
          sourceId: "source-1",
          editableConfig: managedConfig(),
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        switchScenario(rerender, "scenario-2", "Scenario 2");
      });
      expect(result.current.publishingManagedFlowNodeId).toBeNull();
      mockFetchScenarioById.mockResolvedValueOnce(
        createScenarioDetailResponse(
          createScenarioDocument({ nodes: [initial] })
        )
      );
      await act(async () => {
        switchScenario(rerender, "scenario-1", "Scenario 1");
      });
      expect(result.current.publishingManagedFlowNodeId).toBe(initial.id);
      const params = {
        nodeId: initial.id,
        sourceId: "source-1",
        editableConfig: managedConfig(),
      };
      await expect(
        result.current.publishManagedWhatsAppFlow(params)
      ).resolves.toBeNull();
      await expect(retainedPublish(params)).resolves.toBeNull();
      const changed = { ...managedConfig(), ctaText: "Keep returning edit" };
      if (dirty)
        act(() =>
          result.current.graphEditor.edit(graph => ({
            ...graph,
            nodes: [createWhatsAppFlowActionNode(changed)],
            history: "record",
          }))
        );
      else
        mockFetchScenarioById.mockResolvedValueOnce(
          createScenarioDetailResponse(
            createScenarioDocument({
              updatedAt: "2026-01-01T00:01:00.000Z",
              nodes: [
                createWhatsAppFlowActionNode({
                  ...managedConfig(),
                  managedProvisioning: managedResponse().data.projection,
                }),
              ],
            })
          )
        );
      await act(async () => {
        finish(managedResponse());
        expect(await publishing).toBeNull();
      });
      expect(provisionWhatsAppFlow).toHaveBeenCalledTimes(1);
      expect(result.current.publishingManagedFlowNodeId).toBeNull();
      if (dirty) {
        expect(result.current.nodes[0].data.actionFlowConfig).toEqual(changed);
        expect(result.current.saveStatus).toBe("unsaved");
        await expect(result.current.flushScenario()).resolves.toBe(false);
      } else {
        expect(
          result.current.nodes[0].data.actionFlowConfig?.managedProvisioning
            ?.flowId
        ).toBe("published-1");
        expect(result.current.saveStatus).toBe("saved");
      }
      const { toast } = jest.requireMock("sonner");
      expect(toast.error).not.toHaveBeenCalled();
    }
  );

  it("persists exact Flow content before release and adopts only the matching server projection", async () => {
    const editableConfig: WhatsAppFlowConfig = {
      templateId: "lead_generation",
      ctaText: "Continue",
      flowNavigationMode: "linear",
      screens: [{ id: "LEAD_FORM", title: "Lead form", fields: [] }],
    };
    const persistedUpdatedAt = "2026-01-01T00:01:00.000Z";
    mockUpdateScenarioRequest.mockImplementationOnce(async request =>
      createScenarioDocument({
        updatedAt: persistedUpdatedAt,
        nodes: request.nodes,
        edges: request.edges,
      })
    );
    const { result } = await renderScenarioFlowController(
      {},
      {
        nodes: [
          createWhatsAppFlowActionNode({
            ...editableConfig,
            metaFlowId: "browser-owned-id",
            metaFlowStatus: "PUBLISHED",
          }),
        ],
        edges: [],
      }
    );

    const projection = {
      operationId: "operation-1",
      sourceId: "source-1",
      wabaId: "waba-1",
      contentRevision: 7,
      contentDigest: createWhatsAppFlowEditableContentDigest(editableConfig),
      flowId: "provider-flow-1",
      flowName: "Lead form",
      providerStatus: "PUBLISHED" as const,
    };
    jest.mocked(provisionWhatsAppFlow).mockResolvedValueOnce({
      ...managedResponse(editableConfig),
      data: {
        ...managedResponse(editableConfig).data,
        operationId: projection.operationId,
        projection,
        scenarioRevision: { finalUpdatedAt: "2026-01-01T00:01:01.000Z" },
      },
    });
    let adopted = false;
    await act(async () => {
      adopted = !!(
        await result.current.publishManagedWhatsAppFlow({
          nodeId: "flow-action-1",
          sourceId: "source-1",
          editableConfig,
        })
      )?.adopted;
    });
    expect(provisionWhatsAppFlow).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      nodeId: "flow-action-1",
      sourceId: "source-1",
      editableConfig,
    });
    const persistedConfig = (
      mockUpdateScenarioRequest.mock.calls[0]?.[0].nodes?.[0]?.data as {
        actionFlowConfig?: WhatsAppFlowConfig;
      }
    ).actionFlowConfig;
    expect(persistedConfig).toEqual(editableConfig);

    expect(adopted).toBe(true);
    expect(
      (
        result.current.nodes[0]?.data as {
          actionFlowConfig?: WhatsAppFlowConfig;
        }
      ).actionFlowConfig
    ).toMatchObject({ managedProvisioning: projection });
    expect(result.current.saveStatus).toBe("saved");
  });

  it("persists pending graph edits before atomically adopting a provider Flow reference", async () => {
    const placeholderConfig: WhatsAppFlowConfig = {
      templateId: "",
      ctaText: "Open",
      screens: [],
    };
    const persistedUpdatedAt = "2026-01-01T00:01:00.000Z";
    const attachedUpdatedAt = "2026-01-01T00:01:01.000Z";
    const referencedConfig = {
      templateId: "provider_reference",
      ctaText: "Open",
      flowNavigationMode: "data_endpoint",
      screens: [{ id: "APPOINTMENT", title: "Appointment", fields: [] }],
      providerReference: {
        flowId: "flow-1",
        sourceId: "source-1",
        wabaId: "waba-1",
        flowName: "Provider Flow",
        providerStatus: "PUBLISHED",
        jsonVersion: "7.3",
        dataApiVersion: "3.0",
      },
    } as WhatsAppFlowConfig;
    mockUpdateScenarioRequest.mockImplementationOnce(async request =>
      createScenarioDocument({
        updatedAt: persistedUpdatedAt,
        nodes: request.nodes,
        edges: request.edges,
      })
    );
    mockAttachWhatsAppFlowProviderReference.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        ok: true,
        flowConfig: referencedConfig,
        previousScenarioUpdatedAt: persistedUpdatedAt,
        scenarioUpdatedAt: attachedUpdatedAt,
      },
    });
    const { result } = await renderScenarioFlowController();

    await act(async () => {
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [createWhatsAppFlowActionNode(placeholderConfig, "flow-1")],
        history: "skip",
      }));
      result.current.graphEditor.edit(graph => ({
        ...graph,
        edges: [],
        history: "skip",
      }));
    });

    await act(async () => {
      await result.current.attachWhatsAppFlowProviderReferenceToNode({
        nodeId: "flow-action-1",
        sourceId: "source-1",
        flowId: "flow-1",
      });
    });

    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(1);
    expect(mockAttachWhatsAppFlowProviderReference).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      nodeId: "flow-action-1",
      sourceId: "source-1",
      flowId: "flow-1",
      expectedUpdatedAt: persistedUpdatedAt,
    });
    expect(
      (
        result.current.nodes[0]?.data as {
          actionFlowConfig?: WhatsAppFlowConfig;
        }
      ).actionFlowConfig
    ).toEqual(referencedConfig);
    expect(result.current.saveStatus).toBe("saved");
  });

  it("restores the durable save state when provider Flow attachment transport fails", async () => {
    const placeholderConfig: WhatsAppFlowConfig = {
      templateId: "",
      ctaText: "Open",
      screens: [],
    };
    mockAttachWhatsAppFlowProviderReference.mockRejectedValueOnce(
      new Error("network unavailable")
    );
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [createWhatsAppFlowActionNode(placeholderConfig, "flow-1")] }
    );

    await expect(
      act(async () => {
        await result.current.attachWhatsAppFlowProviderReferenceToNode({
          nodeId: "flow-action-1",
          sourceId: "source-1",
          flowId: "flow-1",
        });
      })
    ).rejects.toThrow("network unavailable");

    expect(result.current.saveStatus).toBe("saved");
  });

  it("preserves in-flight local edits while adopting a provider Flow reference", async () => {
    const placeholderConfig: WhatsAppFlowConfig = {
      templateId: "",
      ctaText: "Open",
      screens: [],
    };
    const referencedConfig = {
      templateId: "provider_reference",
      ctaText: "Open",
      flowNavigationMode: "data_endpoint",
      screens: [{ id: "APPOINTMENT", title: "Appointment", fields: [] }],
      providerReference: {
        flowId: "flow-1",
        sourceId: "source-1",
        wabaId: "waba-1",
        flowName: "Provider Flow",
        providerStatus: "PUBLISHED",
        jsonVersion: "7.3",
        dataApiVersion: "3.0",
      },
    } as WhatsAppFlowConfig;
    let resolveAttachment!: (
      response: Awaited<ReturnType<typeof attachWhatsAppFlowProviderReference>>
    ) => void;
    mockAttachWhatsAppFlowProviderReference.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveAttachment = resolve;
        })
    );
    const flowNode = createWhatsAppFlowActionNode(placeholderConfig, "flow-1");
    const replyNode = createReplyActionNode("reply-1", "Before request");
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [flowNode, replyNode] }
    );

    let attachmentPromise!: Promise<WhatsAppFlowConfig>;
    act(() => {
      attachmentPromise =
        result.current.attachWhatsAppFlowProviderReferenceToNode({
          nodeId: "flow-action-1",
          sourceId: "source-1",
          flowId: "flow-1",
        });
    });
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [
          flowNode,
          createReplyActionNode("reply-1", "Edited during request"),
        ],
        history: "skip",
      }));
    });
    await act(async () => {
      resolveAttachment({
        ok: true,
        status: 200,
        data: {
          ok: true,
          flowConfig: referencedConfig,
          previousScenarioUpdatedAt: "2026-01-01T00:00:00.000Z",
          scenarioUpdatedAt: "2026-01-01T00:01:00.000Z",
        },
      });
      await attachmentPromise;
    });

    expect(result.current.nodes).toHaveLength(2);
    expect(result.current.nodes[0]?.data).toMatchObject({
      actionFlowConfig: referencedConfig,
    });
    expect(result.current.nodes[1]?.data).toMatchObject({
      actionReplyText: "Edited during request",
    });
    expect(result.current.saveStatus).toBe("unsaved");
  });

  it("suspends autosave during provider attachment and saves merged edits afterward", async () => {
    const placeholderConfig: WhatsAppFlowConfig = {
      templateId: "",
      ctaText: "Open",
      screens: [],
    };
    const referencedConfig = createProviderReferenceConfig();
    let resolveAttachment!: (
      response: Awaited<ReturnType<typeof attachWhatsAppFlowProviderReference>>
    ) => void;
    mockAttachWhatsAppFlowProviderReference.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveAttachment = resolve;
        })
    );
    mockUpdateScenarioRequest.mockImplementation(async request =>
      createScenarioDocument({
        updatedAt: "2026-01-01T00:02:00.000Z",
        nodes: request.nodes,
        edges: request.edges,
      })
    );
    const flowNode = createWhatsAppFlowActionNode(placeholderConfig, "flow-1");
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [flowNode, createReplyActionNode("reply-1", "Before request")] }
    );

    let attachmentPromise!: Promise<WhatsAppFlowConfig>;
    act(() => {
      attachmentPromise =
        result.current.attachWhatsAppFlowProviderReferenceToNode({
          nodeId: "flow-action-1",
          sourceId: "source-1",
          flowId: "flow-1",
        });
    });

    await expect(
      result.current.publishManagedWhatsAppFlow({
        nodeId: "flow-action-1",
        sourceId: "source-1",
        editableConfig: managedConfig(),
      })
    ).resolves.toBeNull();
    expect(provisionWhatsAppFlow).not.toHaveBeenCalled();
    await act(async () => {
      await Promise.resolve();
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [
          flowNode,
          createReplyActionNode("reply-1", "Edited during request"),
        ],
        history: "skip",
      }));
    });

    await flushAutosave();
    expect(mockUpdateScenarioRequest).not.toHaveBeenCalled();

    await act(async () => {
      resolveAttachment({
        ok: true,
        status: 200,
        data: {
          ok: true,
          flowConfig: referencedConfig,
          previousScenarioUpdatedAt: "2026-01-01T00:00:00.000Z",
          scenarioUpdatedAt: "2026-01-01T00:01:00.000Z",
        },
      });
      await attachmentPromise;
    });

    expect(result.current.saveStatus).toBe("unsaved");
    await flushAutosave();

    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(1);
    expect(mockUpdateScenarioRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioId: "scenario-1",
        expectedUpdatedAt: "2026-01-01T00:01:00.000Z",
        nodes: [
          expect.objectContaining({
            id: "flow-action-1",
            data: expect.objectContaining({
              actionFlowConfig: referencedConfig,
            }),
          }),
          expect.objectContaining({
            id: "reply-1",
            data: expect.objectContaining({
              actionReplyText: "Edited during request",
            }),
          }),
        ],
      })
    );
  });

  it("suspends manual saves while provider attachment is in flight", async () => {
    const placeholderConfig: WhatsAppFlowConfig = {
      templateId: "",
      ctaText: "Open",
      screens: [],
    };
    let resolveAttachment!: (
      response: Awaited<ReturnType<typeof attachWhatsAppFlowProviderReference>>
    ) => void;
    mockAttachWhatsAppFlowProviderReference.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveAttachment = resolve;
        })
    );
    const flowNode = createWhatsAppFlowActionNode(placeholderConfig, "flow-1");
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [flowNode] }
    );

    let attachmentPromise!: Promise<WhatsAppFlowConfig>;
    act(() => {
      attachmentPromise =
        result.current.attachWhatsAppFlowProviderReferenceToNode({
          nodeId: "flow-action-1",
          sourceId: "source-1",
          flowId: "flow-1",
        });
    });
    await act(async () => {
      await Promise.resolve();
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [
          {
            ...flowNode,
            data: {
              ...flowNode.data,
              actionFlowConfig: { ...placeholderConfig, ctaText: "Edited" },
            },
          } as ScenarioFlowNode,
        ],
        history: "skip",
      }));

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "s",
          code: "KeyS",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
      await Promise.resolve();
    });

    expect(mockUpdateScenarioRequest).not.toHaveBeenCalled();

    await act(async () => {
      resolveAttachment({
        ok: true,
        status: 200,
        data: {
          ok: true,
          flowConfig: createProviderReferenceConfig(),
          previousScenarioUpdatedAt: "2026-01-01T00:00:00.000Z",
          scenarioUpdatedAt: "2026-01-01T00:01:00.000Z",
        },
      });
      await attachmentPromise;
    });
  });

  it("waits for an in-flight autosave before attaching a provider Flow", async () => {
    const placeholderConfig: WhatsAppFlowConfig = {
      templateId: "",
      ctaText: "Open",
      screens: [],
    };
    const referencedConfig = createProviderReferenceConfig();
    let resolveSave!: (scenario: ScenarioDocument) => void;
    mockUpdateScenarioRequest.mockImplementationOnce(
      request =>
        new Promise(resolve => {
          resolveSave = scenario =>
            resolve(
              createScenarioDocument({
                ...scenario,
                nodes: request.nodes,
                edges: request.edges,
              })
            );
        })
    );
    mockAttachWhatsAppFlowProviderReference.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        ok: true,
        flowConfig: referencedConfig,
        previousScenarioUpdatedAt: "2026-01-01T00:01:00.000Z",
        scenarioUpdatedAt: "2026-01-01T00:02:00.000Z",
      },
    });
    const { result } = await renderScenarioFlowController();

    await act(async () => {
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [createWhatsAppFlowActionNode(placeholderConfig, "flow-1")],
        history: "skip",
      }));
    });
    await flushAutosave();
    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(1);

    let attachmentPromise!: Promise<WhatsAppFlowConfig>;
    act(() => {
      attachmentPromise =
        result.current.attachWhatsAppFlowProviderReferenceToNode({
          nodeId: "flow-action-1",
          sourceId: "source-1",
          flowId: "flow-1",
        });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(1);
    expect(mockAttachWhatsAppFlowProviderReference).not.toHaveBeenCalled();

    await act(async () => {
      resolveSave(
        createScenarioDocument({
          updatedAt: "2026-01-01T00:01:00.000Z",
        })
      );
      await attachmentPromise;
    });

    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(1);
    expect(mockAttachWhatsAppFlowProviderReference).toHaveBeenCalledTimes(1);
  });

  it("stops attachment when the scenario changes during its prerequisite save", async () => {
    const placeholderConfig: WhatsAppFlowConfig = {
      templateId: "",
      ctaText: "Open",
      screens: [],
    };
    let resolveSave!: (scenario: ScenarioDocument) => void;
    mockUpdateScenarioRequest.mockImplementationOnce(
      request =>
        new Promise(resolve => {
          resolveSave = scenario =>
            resolve(
              createScenarioDocument({
                ...scenario,
                nodes: request.nodes,
                edges: request.edges,
              })
            );
        })
    );
    const { result, rerender, setScenarios } =
      await renderScenarioFlowController();

    await act(async () => {
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [createWhatsAppFlowActionNode(placeholderConfig, "flow-1")],
        history: "skip",
      }));
    });
    let attachmentPromise!: Promise<WhatsAppFlowConfig>;
    act(() => {
      attachmentPromise =
        result.current.attachWhatsAppFlowProviderReferenceToNode({
          nodeId: "flow-action-1",
          sourceId: "source-1",
          flowId: "flow-1",
        });
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      switchScenario(
        rerender,
        "scenario-2",
        "Scenario 2",
        "2026-01-01T00:10:00.000Z"
      );
    });
    const summaryUpdatesBeforeSave = setScenarios.mock.calls.length;
    await act(async () => {
      resolveSave(
        createScenarioDocument({
          _id: "scenario-1",
          updatedAt: "2026-01-01T00:01:00.000Z",
        })
      );
      await expect(attachmentPromise).rejects.toThrow(
        "Scenario changed while attaching this WhatsApp Flow"
      );
    });

    expect(mockAttachWhatsAppFlowProviderReference).not.toHaveBeenCalled();
    expect(setScenarios).toHaveBeenCalledTimes(summaryUpdatesBeforeSave);
  });

  it("keeps a revision-conflicted provider attachment unsaved", async () => {
    const placeholderConfig: WhatsAppFlowConfig = {
      templateId: "",
      ctaText: "Open",
      screens: [],
    };
    mockAttachWhatsAppFlowProviderReference.mockResolvedValueOnce({
      ok: false,
      status: 409,
      data: {
        ok: false,
        error: {
          code: "SCENARIO_REVISION_CONFLICT",
          message: "Scenario changed; refresh before attaching this Flow",
          retryable: false,
        },
      },
    });
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [createWhatsAppFlowActionNode(placeholderConfig, "flow-1")] }
    );

    let attachmentError: unknown;
    await act(async () => {
      try {
        await result.current.attachWhatsAppFlowProviderReferenceToNode({
          nodeId: "flow-action-1",
          sourceId: "source-1",
          flowId: "flow-1",
        });
      } catch (error) {
        attachmentError = error;
      }
    });

    expect(attachmentError).toEqual(
      new Error("Scenario changed; refresh before attaching this Flow")
    );
    expect(result.current.saveStatus).toBe("unsaved");
  });

  it("does not attach a provider Flow over edits made during the prerequisite save", async () => {
    const placeholderConfig: WhatsAppFlowConfig = {
      templateId: "",
      ctaText: "Open",
      screens: [],
    };
    let resolveSave!: (scenario: ScenarioDocument) => void;
    mockUpdateScenarioRequest.mockImplementationOnce(
      request =>
        new Promise(resolve => {
          resolveSave = scenario =>
            resolve(
              createScenarioDocument({
                ...scenario,
                nodes: request.nodes,
                edges: request.edges,
              })
            );
        })
    );
    const flowNode = createWhatsAppFlowActionNode(placeholderConfig, "flow-1");
    const { result } = await renderScenarioFlowController();

    await act(async () => {
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [flowNode],
        history: "skip",
      }));
    });

    let attachmentPromise!: Promise<WhatsAppFlowConfig>;
    act(() => {
      attachmentPromise =
        result.current.attachWhatsAppFlowProviderReferenceToNode({
          nodeId: "flow-action-1",
          sourceId: "source-1",
          flowId: "flow-1",
        });
    });
    await act(async () => {
      await Promise.resolve();
    });

    const editedFlowNode = {
      ...flowNode,
      data: {
        ...flowNode.data,
        actionFlowConfig: { ...placeholderConfig, ctaText: "Edited locally" },
      },
    } as ScenarioFlowNode;
    await act(async () => {
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [editedFlowNode],
        history: "skip",
      }));

      resolveSave(
        createScenarioDocument({
          updatedAt: "2026-01-01T00:01:00.000Z",
        })
      );
      await expect(attachmentPromise).rejects.toThrow(
        "Save the scenario before attaching this WhatsApp Flow"
      );
    });

    expect(mockAttachWhatsAppFlowProviderReference).not.toHaveBeenCalled();
    expect(result.current.nodes[0]?.data).toMatchObject({
      actionFlowConfig: { ctaText: "Edited locally" },
    });
    expect(result.current.saveStatus).toBe("unsaved");
  });

  it("adopts linked-condition parent counts from detail metadata", async () => {
    const scenario = createScenarioDocument({
      linkedParentScenarioIds: ["unrelated-parent-1", "unrelated-parent-2"],
      nodes: [
        {
          id: "trigger-1",
          type: "triggerNode",
          position: { x: 0, y: 0 },
          data: {
            kind: "trigger",
            linkedConditionId: "condition-1",
          },
        } as ScenarioFlowNode,
      ],
    });
    mockFetchScenarioById.mockResolvedValueOnce({
      scenario,
      metadata: {
        linkedConditionParentCountByNodeId: {
          "trigger-1": 1,
        },
      },
    });
    const { result } = await renderScenarioFlowController();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      result.current.linkedConditionParentCountByNodeId.get("trigger-1")
    ).toBe(1);
  });

  it("does not replace the confirmed graph revision with a newer sidebar summary", async () => {
    const initialNode = createActionNode("action-1", { x: 0, y: 0 });
    const { rerender } = await renderScenarioFlowController(
      {},
      { nodes: [initialNode], edges: [] }
    );

    await act(async () => {
      switchScenario(
        rerender,
        "scenario-1",
        "Renamed scenario",
        "2026-01-01T00:05:00.000Z"
      );
    });

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "s",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockUpdateScenarioRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Renamed scenario",
        expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
      })
    );
  });

  it("handles Ctrl+S by physical key code for non-English keyboard layouts", async () => {
    await renderScenarioFlowController(
      {},
      { nodes: [createActionNode("action-1", { x: 0, y: 0 })], edges: [] }
    );

    const event = new KeyboardEvent("keydown", {
      key: "ы",
      code: "KeyS",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    act(() => {
      window.dispatchEvent(event);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(event.defaultPrevented).toBe(true);
    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps transient React Flow selection out of graph state", async () => {
    const initialNode = createActionNode("action-1", { x: 0, y: 0 });
    const initialEdge = {
      id: "edge-1",
      source: "action-1",
      target: "action-2",
    } as ScenarioFlowEdge;
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [initialNode], edges: [initialEdge] }
    );

    act(() => {
      result.current.onNodesChange([
        { id: "action-1", type: "select", selected: true },
      ]);
      result.current.onEdgesChange([
        { id: "edge-1", type: "select", selected: true },
      ]);
    });

    expect(result.current.nodes[0]?.selected).toBeUndefined();
    expect(result.current.edges[0]?.selected).toBeUndefined();

    act(() => {
      result.current.onNodesChange([
        { id: "action-1", type: "select", selected: true },
        {
          id: "action-1",
          type: "position",
          position: { x: 40, y: 60 },
        },
      ]);
    });

    expect(result.current.nodes[0]?.position).toEqual({ x: 40, y: 60 });
    expect(result.current.nodes[0]?.selected).toBeUndefined();
  });

  it("clears transient canvas selection without marking the graph dirty", async () => {
    const firstNode = {
      ...createActionNode("action-1", { x: 0, y: 0 }),
      selected: true,
    } as ScenarioFlowNode;
    const secondNode = createActionNode("action-2", { x: 120, y: 0 });
    const selectedEdge = {
      id: "edge-1",
      source: "action-1",
      target: "action-2",
      selected: true,
    } as ScenarioFlowEdge;
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [firstNode, secondNode], edges: [selectedEdge] }
    );

    act(() => {
      result.current.clearCanvasSelection();
    });

    expect(result.current.nodes.map(node => node.id)).toEqual([
      "action-1",
      "action-2",
    ]);
    expect(result.current.nodes.some(node => node.selected)).toBe(false);
    expect(result.current.edges.some(edge => edge.selected)).toBe(false);
    expect(mockUpdateScenarioRequest).not.toHaveBeenCalled();
  });

  it("atomically adopts a converted legacy graph on the first routing edit", async () => {
    const legacyAction = createActionNode("action-1", { x: 0, y: 0 });
    const legacyCondition = {
      id: "condition-1",
      type: "scenarioNode",
      position: { x: 240, y: 0 },
      data: {
        kind: "logic",
        logicType: "post_action_condition",
        conditionBranches: [{ id: "reply", type: "user_replied" }],
      },
    } as ScenarioFlowNode;
    const target = createActionNode("target-1", { x: 480, y: 0 });
    const actionOutcomes = {
      version: 1 as const,
      anyReply: { enabled: true },
    };
    const convertedScenario = createScenarioDocument({
      updatedAt: "2026-01-01T00:01:00.000Z",
      nodes: [
        {
          ...legacyAction,
          data: { ...legacyAction.data, actionOutcomes },
        },
        target,
      ],
      edges: [
        {
          id: "reply",
          source: "action-1",
          sourceHandle: "right-source-action-outcome::any-reply",
          target: "target-1",
        },
      ],
    });
    const timerWarning = {
      code: "legacy_action_routing_timer_replan_failed" as const,
      message: "Legacy routing committed, but a pending timer needs retry.",
      affectedConversationIds: ["conversation-1"],
    };
    mockConvertLegacyActionRoutingRequest.mockResolvedValue({
      scenario: convertedScenario,
      metadata: {
        linkedConditionParentCountByNodeId: {},
        warnings: [timerWarning],
      },
    });
    const { result } = await renderScenarioFlowController(
      {},
      {
        nodes: [legacyAction, legacyCondition, target],
        edges: [
          { id: "input", source: "action-1", target: "condition-1" },
          {
            id: "reply",
            source: "condition-1",
            target: "target-1",
          },
        ],
      }
    );

    await act(async () => {
      await result.current.convertLegacyActionRouting({
        sourceActionNodeId: "action-1",
        sourceNodeId: "condition-1",
        sourceKind: "post_action_condition",
        patch: { actionOutcomes },
      });
    });

    expect(mockConvertLegacyActionRoutingRequest).toHaveBeenCalledWith({
      scenarioId: "scenario-1",
      workspaceId: "workspace-1",
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
      sourceActionNodeId: "action-1",
      sourceNodeId: "condition-1",
      sourceKind: "post_action_condition",
      actionOutcomes,
      actionRunConditions: undefined,
    });
    expect(result.current.nodes.map(node => node.id)).toEqual([
      "action-1",
      "target-1",
    ]);
    expect(result.current.edges).toEqual([
      expect.objectContaining(convertedScenario.edges[0] as ScenarioFlowEdge),
    ]);
    expect(result.current.saveStatus).toBe("saved");
    expect(mockToastWarning).toHaveBeenCalledWith(timerWarning.message);
  });

  it("ignores a deferred legacy conversion after switching scenarios", async () => {
    const staleWarning = {
      code: "legacy_action_routing_timer_replan_failed" as const,
      message: "Pending timer needs retry.",
      affectedConversationIds: ["conversation-1"],
    };
    const staleScenario = createScenarioDocument({
      _id: "scenario-1",
      updatedAt: "2026-01-01T00:01:00.000Z",
      nodes: [createActionNode("stale-action", { x: 0, y: 0 })],
    });
    let resolveConversion!: (value: {
      scenario: ScenarioDocument;
      metadata: {
        linkedConditionParentCountByNodeId: Record<string, number>;
        warnings: (typeof staleWarning)[];
      };
    }) => void;
    mockConvertLegacyActionRoutingRequest.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveConversion = resolve;
        })
    );
    const { result, rerender } = await renderScenarioFlowController();

    const { conversionPromise } = await startLegacyConversion(result);
    expect(result.current.saveStatus).toBe("saving");

    const scenarioTwoNode = createActionNode("scenario-2-action", {
      x: 20,
      y: 20,
    });
    mockFetchScenarioById.mockResolvedValueOnce(
      createScenarioDetailResponse(
        createScenarioDocument({ _id: "scenario-2", nodes: [scenarioTwoNode] })
      )
    );
    await act(async () => {
      switchScenario(
        rerender,
        "scenario-2",
        "Scenario 2",
        "2026-01-01T00:10:00.000Z"
      );
    });

    await act(async () => {
      resolveConversion({
        scenario: staleScenario,
        metadata: {
          linkedConditionParentCountByNodeId: {},
          warnings: [staleWarning],
        },
      });
      await expect(conversionPromise).resolves.toBe(false);
    });

    expect(result.current.nodes.map(node => node.id)).toEqual([
      "scenario-2-action",
    ]);
    expect(result.current.saveStatus).toBe("saved");
    expect(mockToastWarning).not.toHaveBeenCalled();
  });

  it("rejects a deferred legacy conversion after an ABA reselection with local edits", async () => {
    const staleWarning = {
      code: "legacy_action_routing_timer_replan_failed" as const,
      message: "Pending timer needs retry.",
      affectedConversationIds: ["conversation-1"],
    };
    const staleScenario = createScenarioDocument({
      _id: "scenario-1",
      updatedAt: "2026-01-01T00:01:00.000Z",
      nodes: [createActionNode("stale-action", { x: 0, y: 0 })],
    });
    let resolveConversion!: (value: {
      scenario: ScenarioDocument;
      metadata: {
        linkedConditionParentCountByNodeId: Record<string, number>;
        warnings: (typeof staleWarning)[];
      };
    }) => void;
    mockConvertLegacyActionRoutingRequest.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveConversion = resolve;
        })
    );
    const { result, rerender } = await renderScenarioFlowController();

    const { conversionPromise } = await startLegacyConversion(result);
    expect(result.current.saveStatus).toBe("saving");

    await act(async () => {
      switchScenario(
        rerender,
        "scenario-2",
        "Scenario 2",
        "2026-01-01T00:10:00.000Z"
      );
    });
    expect(result.current.saveStatus).toBe("saved");

    await act(async () => {
      switchScenario(
        rerender,
        "scenario-1",
        "Scenario 1",
        "2026-01-01T00:20:00.000Z"
      );
    });
    const reselectedNode = createActionNode("reselected-action", {
      x: 40,
      y: 40,
    });
    await act(async () => {
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [reselectedNode],
        history: "skip",
      }));
      result.current.graphEditor.edit(graph => ({
        ...graph,
        edges: [],
        history: "skip",
      }));
    });
    expect(result.current.saveStatus).toBe("unsaved");

    await act(async () => {
      resolveConversion({
        scenario: staleScenario,
        metadata: {
          linkedConditionParentCountByNodeId: {},
          warnings: [staleWarning],
        },
      });
      await expect(conversionPromise).resolves.toBe(false);
    });

    expect(result.current.nodes.map(node => node.id)).toEqual([
      "reselected-action",
    ]);
    expect(result.current.saveStatus).toBe("unsaved");
    expect(mockToastWarning).not.toHaveBeenCalled();

    await flushAutosave();
    expect(mockUpdateScenarioRequest).toHaveBeenCalledWith(
      expect.objectContaining({ nodes: [reselectedNode] })
    );
  });

  it("ignores a rejected legacy conversion after switching scenarios", async () => {
    let rejectConversion!: (reason: unknown) => void;
    mockConvertLegacyActionRoutingRequest.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectConversion = reject;
        })
    );
    const { toast } = sonnerMock();
    const { result, rerender } = await renderScenarioFlowController();

    const { conversionPromise } = await startLegacyConversion(result);
    expect(result.current.saveStatus).toBe("saving");

    const scenarioTwoNode = createActionNode("scenario-2-action", {
      x: 20,
      y: 20,
    });
    mockFetchScenarioById.mockResolvedValueOnce(
      createScenarioDetailResponse(
        createScenarioDocument({ _id: "scenario-2", nodes: [scenarioTwoNode] })
      )
    );
    await act(async () => {
      switchScenario(
        rerender,
        "scenario-2",
        "Scenario 2",
        "2026-01-01T00:10:00.000Z"
      );
    });

    expect(result.current.saveStatus).toBe("saved");

    await act(async () => {
      rejectConversion(
        new ScenarioRequestError({
          message: "Conflict",
          status: 409,
          code: "scenario_updated_conflict",
        })
      );
      await expect(conversionPromise).resolves.toBe(false);
    });

    expect(result.current.nodes.map(node => node.id)).toEqual([
      "scenario-2-action",
    ]);
    expect(result.current.saveStatus).toBe("saved");
    expect(toast.error).not.toHaveBeenCalled();

    await act(async () => {
      nudgeNodes(result);
    });
    await flushAutosave();
    expect(mockUpdateScenarioRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        nodes: [{ ...scenarioTwoNode, position: { x: 21, y: 20 } }],
      })
    );
  });

  it("ignores a rejected legacy conversion after ABA local edits are saved", async () => {
    let rejectConversion!: (reason: unknown) => void;
    mockConvertLegacyActionRoutingRequest.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectConversion = reject;
        })
    );
    const { toast } = sonnerMock();
    const { result, rerender } = await renderScenarioFlowController();

    const { conversionPromise } = await startLegacyConversion(result);

    await act(async () => {
      switchScenario(
        rerender,
        "scenario-2",
        "Scenario 2",
        "2026-01-01T00:10:00.000Z"
      );
    });
    await act(async () => {
      switchScenario(
        rerender,
        "scenario-1",
        "Scenario 1",
        "2026-01-01T00:20:00.000Z"
      );
    });
    const reselectedNode = createActionNode("reselected-action", {
      x: 40,
      y: 40,
    });
    await act(async () => {
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [reselectedNode],
        history: "skip",
      }));
      result.current.graphEditor.edit(graph => ({
        ...graph,
        edges: [],
        history: "skip",
      }));
    });
    await flushAutosave();
    expect(result.current.saveStatus).toBe("saved");
    expect(mockUpdateScenarioRequest).toHaveBeenCalledWith(
      expect.objectContaining({ nodes: [reselectedNode] })
    );

    await act(async () => {
      rejectConversion(new Error("Request failed"));
      await expect(conversionPromise).resolves.toBe(false);
    });

    expect(result.current.nodes.map(node => node.id)).toEqual([
      "reselected-action",
    ]);
    expect(result.current.saveStatus).toBe("saved");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)(
    "autosaves a local edit made while a legacy conversion was pending (%s)",
    async outcome => {
      let resolveConversion!: (
        value: ReturnType<typeof createScenarioDetailResponse>
      ) => void;
      let rejectConversion!: (reason: unknown) => void;
      mockConvertLegacyActionRoutingRequest.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            resolveConversion = resolve;
            rejectConversion = reject;
          })
      );
      const { toast } = sonnerMock();
      const legacyAction = createActionNode("action-1", { x: 0, y: 0 });
      const { result } = await renderScenarioFlowController(
        {},
        { nodes: [legacyAction] }
      );

      const { conversionPromise } = await startLegacyConversion(result);
      expect(result.current.saveStatus).toBe("saving");

      await act(async () => {
        nudgeNodes(result);
      });
      expect(result.current.saveStatus).toBe("saving");

      await act(async () => {
        if (outcome === "resolve")
          resolveConversion(
            createScenarioDetailResponse(
              createScenarioDocument({ updatedAt: "2026-01-01T00:01:00.000Z" })
            )
          );
        else rejectConversion(new Error("Request failed"));
        await expect(conversionPromise).resolves.toBe(false);
      });

      expect(result.current.nodes).toEqual([
        expect.objectContaining({ id: "action-1", position: { x: 1, y: 0 } }),
      ]);
      expect(result.current.saveStatus).toBe("unsaved");
      expect(toast.error).toHaveBeenCalledTimes(outcome === "reject" ? 1 : 0);

      await flushAutosave();
      expect(mockUpdateScenarioRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
          nodes: [{ ...legacyAction, position: { x: 1, y: 0 } }],
        })
      );
    }
  );

  it("keeps autosaving after a manual save commits before a pending legacy conversion conflicts", async () => {
    let rejectConversion!: (reason: unknown) => void;
    mockConvertLegacyActionRoutingRequest.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectConversion = reject;
        })
    );
    const { toast } = sonnerMock();
    const legacyAction = createActionNode("action-1", { x: 0, y: 0 });
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [legacyAction] }
    );
    const moveAction = () => nudgeNodes(result);

    const { conversionPromise } = await startLegacyConversion(result);
    await act(async () => {
      moveAction();
    });
    mockUpdateScenarioRequest.mockResolvedValueOnce(
      createScenarioDocument({
        updatedAt: "2026-01-01T00:05:00.000Z",
        nodes: [{ ...legacyAction, position: { x: 1, y: 0 } }],
      })
    );
    await act(async () => {
      await expect(result.current.flushScenario()).resolves.toBe(true);
    });

    await act(async () => {
      rejectConversion(
        new ScenarioRequestError({
          message: "Conflict",
          status: 409,
          code: "scenario_updated_conflict",
        })
      );
      await expect(conversionPromise).resolves.toBe(false);
    });

    expect(toast.error).not.toHaveBeenCalled();
    expect(result.current.saveStatus).toBe("saved");
    await act(async () => {
      moveAction();
    });
    await flushAutosave();
    expect(mockUpdateScenarioRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedUpdatedAt: "2026-01-01T00:05:00.000Z",
        nodes: [{ ...legacyAction, position: { x: 2, y: 0 } }],
      })
    );
  });

  it("keeps one toast explaining a legacy conversion that fails again", async () => {
    mockConvertLegacyActionRoutingRequest.mockRejectedValueOnce(
      new ScenarioRequestError({
        message: "A pending conversation is missing its timer identity.",
        status: 409,
        code: "legacy_action_routing_pending_timer_identity_invalid",
      })
    );
    const { toast } = sonnerMock();
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [createActionNode("action-1", { x: 0, y: 0 })] }
    );

    for (const timeoutMinutes of [1440, 2880]) {
      await act(async () => {
        await expect(
          result.current.convertLegacyActionRouting({
            sourceActionNodeId: "action-1",
            sourceNodeId: "condition-1",
            sourceKind: "post_action_condition",
            patch: {
              actionOutcomes: {
                version: 1,
                noReply: { enabled: true, timeoutMinutes },
              },
            },
          })
        ).resolves.toBe(false);
      });
    }

    expect(mockConvertLegacyActionRoutingRequest).toHaveBeenCalledTimes(1);
    const reported = [
      "legacy_action_routing_pending_timer_identity_invalid",
      { id: "scenario-legacy-routing-conversion:scenario-1" },
    ];
    expect(toast.error.mock.calls).toEqual([reported, reported]);
  });

  it("settles an abandoned legacy conversion while an earlier visit's save is pending", async () => {
    mockUpdateScenarioRequest.mockImplementationOnce(
      () => new Promise(() => undefined)
    );
    let resolveConversion!: (
      value: ReturnType<typeof createScenarioDetailResponse>
    ) => void;
    mockConvertLegacyActionRoutingRequest.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveConversion = resolve;
        })
    );
    const { result, rerender } = await renderScenarioFlowController();
    await act(async () => {
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [createReplyActionNode("action-1", "old A")],
        history: "skip",
      }));
    });
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(1);
    await act(async () => {
      switchScenario(rerender, "scenario-2", "Scenario 2");
    });
    await act(async () => {
      switchScenario(rerender, "scenario-1", "Scenario 1");
    });

    const { conversionPromise } = await startLegacyConversion(result);
    expect(result.current.saveStatus).toBe("saving");
    await act(async () => {
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [createReplyActionNode("action-1", "new A")],
        history: "skip",
      }));
    });
    await act(async () => {
      resolveConversion(
        createScenarioDetailResponse(
          createScenarioDocument({ updatedAt: "2026-01-01T00:01:00.000Z" })
        )
      );
      await expect(conversionPromise).resolves.toBe(false);
    });

    // The earlier visit's save never settles this visit's status.
    expect(result.current.saveStatus).toBe("unsaved");
    await flushAutosave();
    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(2);
    expect(result.current.nodes[0].data.actionReplyText).toBe("new A");
  });

  it("adopts the exact generated-send server revision without dirtying or autosaving the graph", async () => {
    const bulkNode = completedGeneratedBulkNode();
    const { result, setScenarios } = await renderScenarioFlowController(
      {},
      { nodes: [bulkNode], edges: [] }
    );

    act(() => {
      result.current.adoptGeneratedBulkServerUpdate(
        {
          nodeId: "bulk-root-1",
          bulkRootConfigPatch: {
            generatedRecipientCount: 50,
            sendStatus: {
              total: 50,
              queued: 47,
              sent: 0,
              skipped: 3,
              failed: 0,
              lastSendAttemptAt: "2026-07-27T10:00:00.000Z",
            },
            generatedSendState: {
              revision: "generation-job-1",
              operationId: "operation-1",
              state: "completed",
              requestedAt: "2026-07-27T10:00:00.000Z",
              completedAt: "2026-07-27T10:02:00.000Z",
            },
          },
          scenarioUpdatedAt: "2026-07-27T10:02:00.000Z",
        },
        "active"
      );
    });

    expect(result.current.nodes[0]?.data).toMatchObject({
      bulkRootConfig: {
        campaignName: "Generated campaign",
        sendStatus: {
          total: 50,
          queued: 47,
          sent: 0,
          skipped: 3,
          failed: 0,
          lastSendAttemptAt: "2026-07-27T10:00:00.000Z",
        },
        generatedSendState: {
          revision: "generation-job-1",
          operationId: "operation-1",
          state: "completed",
        },
      },
    });
    expect(result.current.saveStatus).toBe("saved");
    expect(setScenarios).toHaveBeenCalledTimes(1);
    const updateScenarioSummary = setScenarios.mock.calls[0]?.[0];
    expect(typeof updateScenarioSummary).toBe("function");
    expect(
      typeof updateScenarioSummary === "function"
        ? updateScenarioSummary([
            {
              _id: "scenario-1",
              name: "Scenario 1",
              description: "",
              status: "draft",
              nodeCount: 1,
              edgeCount: 0,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ])
        : []
    ).toEqual([
      expect.objectContaining({
        _id: "scenario-1",
        status: "active",
        updatedAt: "2026-07-27T10:02:00.000Z",
      }),
    ]);

    await flushAutosave();
    expect(mockUpdateScenarioRequest).not.toHaveBeenCalled();

    act(() => {
      nudgeNodes(result);
    });
    await flushAutosave();
    expect(mockUpdateScenarioRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedUpdatedAt: "2026-07-27T10:02:00.000Z",
        status: "active",
      })
    );
  });

  it("rejects a delayed generated-send response before it can overwrite a newer graph revision", async () => {
    const bulkNode = completedGeneratedBulkNode();
    const { result, setScenarios } = await renderScenarioFlowController(
      {
        activeScenarioUpdatedAt: "2026-07-27T10:05:00.000Z",
      },
      { nodes: [bulkNode] }
    );

    let adopted = true;
    act(() => {
      adopted = result.current.adoptGeneratedBulkServerUpdate(
        {
          nodeId: "bulk-root-1",
          bulkRootConfigPatch: {
            generatedRecipientCount: 50,
            sendStatus: {
              total: 50,
              queued: 50,
              sent: 0,
              skipped: 0,
              failed: 0,
            },
            generatedSendState: {
              revision: "generation-job-1",
              operationId: "operation-1",
              state: "completed",
              requestedAt: "2026-07-27T10:00:00.000Z",
              completedAt: "2026-07-27T10:02:00.000Z",
            },
          },
          scenarioUpdatedAt: "2026-07-27T10:02:00.000Z",
        },
        "active"
      );
      nudgeNodes(result);
    });

    expect(adopted).toBe(false);
    expect(result.current.nodes[0]?.data).not.toHaveProperty(
      "bulkRootConfig.generatedSendState"
    );
    expect(setScenarios).not.toHaveBeenCalled();

    await flushAutosave();

    expect(mockUpdateScenarioRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedUpdatedAt: "2026-07-27T10:05:00.000Z",
      })
    );
  });

  it.each([
    {
      caseName: "an invalid incoming revision",
      currentUpdatedAt: "2026-07-27T10:05:00.000Z",
      incomingUpdatedAt: "invalid-incoming-revision",
    },
    {
      caseName: "an invalid current revision",
      currentUpdatedAt: "invalid-current-revision",
      incomingUpdatedAt: "2026-07-27T10:05:00.000Z",
    },
  ])(
    "rejects $caseName at the generated-send CAS boundary",
    async ({ currentUpdatedAt, incomingUpdatedAt }) => {
      const bulkNode = completedGeneratedBulkNode();
      const { result, setScenarios } = await renderScenarioFlowController(
        {
          activeScenarioUpdatedAt: currentUpdatedAt,
        },
        { nodes: [bulkNode] }
      );

      let adopted = true;
      act(() => {
        adopted = result.current.adoptGeneratedBulkServerUpdate({
          nodeId: "bulk-root-1",
          bulkRootConfigPatch: {
            generatedRecipientCount: 50,
            sendStatus: {
              total: 50,
              queued: 50,
              sent: 0,
              skipped: 0,
              failed: 0,
            },
            generatedSendState: {
              revision: "generation-job-1",
              operationId: "operation-1",
              state: "completed",
              requestedAt: "2026-07-27T10:00:00.000Z",
              completedAt: "2026-07-27T10:02:00.000Z",
            },
          },
          scenarioUpdatedAt: incomingUpdatedAt,
        });
      });

      expect(adopted).toBe(false);
      expect(result.current.nodes[0]?.data).not.toHaveProperty(
        "bulkRootConfig.generatedSendState"
      );
      expect(setScenarios).not.toHaveBeenCalled();
    }
  );

  it("rejects generated-send state for a different generated revision", async () => {
    const bulkNode = completedGeneratedBulkNode("generation-job-new");
    const { result, setScenarios } = await renderScenarioFlowController(
      {},
      { nodes: [bulkNode] }
    );

    let adopted = true;
    act(() => {
      adopted = result.current.adoptGeneratedBulkServerUpdate({
        nodeId: "bulk-root-1",
        bulkRootConfigPatch: {
          generatedRecipientCount: 50,
          sendStatus: {
            total: 50,
            queued: 50,
            sent: 0,
            skipped: 0,
            failed: 0,
          },
          generatedSendState: {
            revision: "generation-job-old",
            operationId: "operation-old",
            state: "completed",
            requestedAt: "2026-07-27T10:00:00.000Z",
            completedAt: "2026-07-27T10:02:00.000Z",
          },
        },
        scenarioUpdatedAt: "2026-07-27T10:02:00.000Z",
      });
    });

    expect(adopted).toBe(false);
    expect(result.current.nodes[0]?.data).not.toHaveProperty(
      "bulkRootConfig.generatedSendState"
    );
    expect(setScenarios).not.toHaveBeenCalled();
  });

  it("adopts a send's scenario activation so the next autosave keeps it active", async () => {
    const { result, setScenarios } = await renderScenarioFlowController(
      {},
      { nodes: [createActionNode("action-1", { x: 0, y: 0 })] }
    );

    let adopted = false;
    act(() => {
      adopted = result.current.adoptScenarioActivation({
        scenarioId: "scenario-1",
        scenarioUpdatedAt: "2026-09-30T12:00:00.000Z",
        previousScenarioUpdatedAt: "2026-01-01T00:00:00.000Z",
      });
    });

    expect(adopted).toBe(true);
    expect(result.current.saveStatus).toBe("saved");
    expect(setScenarios).toHaveBeenCalledTimes(1);
    const updateScenarioSummary = setScenarios.mock.calls[0]?.[0];
    expect(
      typeof updateScenarioSummary === "function"
        ? updateScenarioSummary([
            {
              _id: "scenario-1",
              status: "draft",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
            {
              _id: "scenario-2",
              status: "draft",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ])
        : []
    ).toEqual([
      expect.objectContaining({
        _id: "scenario-1",
        status: "active",
        updatedAt: "2026-09-30T12:00:00.000Z",
      }),
      expect.objectContaining({ _id: "scenario-2", status: "draft" }),
    ]);

    act(() => {
      nudgeNodes(result);
    });
    await flushAutosave();
    expect(mockUpdateScenarioRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedUpdatedAt: "2026-09-30T12:00:00.000Z",
        status: "active",
      })
    );
  });

  it("takes the active status when it already holds the activation's revision", async () => {
    const { result, setScenarios } = await renderScenarioFlowController(
      { activeScenarioUpdatedAt: "2026-09-30T12:00:00.000Z" },
      { nodes: [createActionNode("action-1", { x: 0, y: 0 })] }
    );

    let adopted = false;
    act(() => {
      adopted = result.current.adoptScenarioActivation({
        scenarioId: "scenario-1",
        scenarioUpdatedAt: "2026-09-30T12:00:00.000Z",
        previousScenarioUpdatedAt: null,
      });
    });

    expect(adopted).toBe(true);
    expect(setScenarios).toHaveBeenCalledTimes(1);

    act(() => {
      nudgeNodes(result);
    });
    await flushAutosave();
    expect(mockUpdateScenarioRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedUpdatedAt: "2026-09-30T12:00:00.000Z",
        status: "active",
      })
    );
  });

  it("keeps its revision when a send's activation was not built on it", async () => {
    const { result, setScenarios } = await renderScenarioFlowController(
      { activeScenarioUpdatedAt: "2026-09-30T12:05:00.000Z" },
      { nodes: [createActionNode("action-1", { x: 0, y: 0 })] }
    );

    let adoptedOverOtherSave = true;
    let adoptedOlderRevision = true;
    let adoptedUnknownBase = true;
    act(() => {
      // Another session saved 12:03 after this editor loaded 12:05's base.
      adoptedOverOtherSave = result.current.adoptScenarioActivation({
        scenarioId: "scenario-1",
        scenarioUpdatedAt: "2026-09-30T12:10:00.000Z",
        previousScenarioUpdatedAt: "2026-09-30T12:03:00.000Z",
      });
      adoptedOlderRevision = result.current.adoptScenarioActivation({
        scenarioId: "scenario-1",
        scenarioUpdatedAt: "2026-09-30T12:00:00.000Z",
        previousScenarioUpdatedAt: "2026-09-30T11:00:00.000Z",
      });
      adoptedUnknownBase = result.current.adoptScenarioActivation({
        scenarioId: "scenario-1",
        scenarioUpdatedAt: "2026-09-30T12:10:00.000Z",
        previousScenarioUpdatedAt: null,
      });
    });

    expect(adoptedOverOtherSave).toBe(false);
    expect(adoptedOlderRevision).toBe(false);
    expect(adoptedUnknownBase).toBe(false);
    expect(setScenarios).not.toHaveBeenCalled();

    act(() => {
      nudgeNodes(result);
    });
    await flushAutosave();
    expect(mockUpdateScenarioRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedUpdatedAt: "2026-09-30T12:05:00.000Z",
        status: "draft",
      })
    );
  });

  it("marks only the sidebar row active when the sending scenario is no longer open", async () => {
    const { result, setScenarios } = await renderScenarioFlowController(
      {},
      { nodes: [createActionNode("action-1", { x: 0, y: 0 })] }
    );

    let adopted = true;
    act(() => {
      adopted = result.current.adoptScenarioActivation({
        scenarioId: "scenario-2",
        scenarioUpdatedAt: "2026-09-30T12:00:00.000Z",
        previousScenarioUpdatedAt: "2026-09-30T10:00:00.000Z",
      });
    });

    expect(adopted).toBe(false);
    expect(setScenarios).toHaveBeenCalledTimes(1);
    const updateScenarioSummary = setScenarios.mock.calls[0]?.[0];
    const summaries = [
      {
        _id: "scenario-1",
        status: "draft",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        _id: "scenario-2",
        status: "draft",
        updatedAt: "2026-09-30T10:00:00.000Z",
      },
    ];
    expect(
      typeof updateScenarioSummary === "function"
        ? updateScenarioSummary(summaries)
        : []
    ).toEqual([
      summaries[0],
      expect.objectContaining({
        _id: "scenario-2",
        status: "active",
        updatedAt: "2026-09-30T12:00:00.000Z",
      }),
    ]);
    // A row that moved on keeps its own revision and only learns the status.
    expect(
      typeof updateScenarioSummary === "function"
        ? updateScenarioSummary([
            { ...summaries[1], updatedAt: "2026-09-30T11:00:00.000Z" },
          ])
        : []
    ).toEqual([
      expect.objectContaining({
        status: "active",
        updatedAt: "2026-09-30T11:00:00.000Z",
      }),
    ]);

    act(() => {
      nudgeNodes(result);
    });
    await flushAutosave();
    expect(mockUpdateScenarioRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
        status: "draft",
      })
    );
  });

  it("saves pending edits before a send and holds later saves until its activation is adopted", async () => {
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [createActionNode("action-1", { x: 0, y: 0 })] }
    );
    const nudge = () =>
      act(() => {
        nudgeNodes(result);
      });
    mockUpdateScenarioRequest.mockImplementationOnce(async request =>
      createScenarioDocument({
        ...request,
        _id: request.scenarioId,
        updatedAt: "2026-09-30T10:00:00.000Z",
      })
    );

    // An autosave is armed before the send starts.
    nudge();
    let release: (() => void) | null = null;
    await act(async () => {
      release = await result.current.prepareScenarioBulkSend();
    });
    expect(release).toEqual(expect.any(Function));
    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(1);
    expect(mockUpdateScenarioRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedUpdatedAt: "2026-01-01T00:00:00.000Z" })
    );

    // Edits, autosave timers and scenario switches wait while it is in flight.
    nudge();
    let selected: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      jest.advanceTimersByTime(3000);
      selected = result.current.prepareScenarioSelection();
      await Promise.resolve();
    });
    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.adoptScenarioActivation({
        scenarioId: "scenario-1",
        scenarioUpdatedAt: "2026-09-30T12:00:00.000Z",
        previousScenarioUpdatedAt: "2026-09-30T10:00:00.000Z",
      });
      release?.();
    });
    await act(async () => {
      await expect(selected).resolves.toBe(true);
    });

    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(2);
    expect(mockUpdateScenarioRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedUpdatedAt: "2026-09-30T12:00:00.000Z",
        status: "active",
      })
    );
  });

  it("does not start a send while the editor holds a save conflict", async () => {
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [createActionNode("action-1", { x: 0, y: 0 })] }
    );
    mockUpdateScenarioRequest.mockRejectedValueOnce(
      new ScenarioRequestError({
        status: 409,
        code: "scenario_updated_conflict",
        message: "Scenario changed",
      })
    );
    act(() => {
      nudgeNodes(result);
    });

    let release: (() => void) | null = () => undefined;
    await act(async () => {
      release = await result.current.prepareScenarioBulkSend();
    });

    expect(release).toBeNull();
    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(1);
  });

  it("shows validation and selects the blocking step when a send could not activate", async () => {
    const blockingNode = createActionNode("action-1", { x: 0, y: 0 });
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [blockingNode] }
    );
    expect(result.current.validationRequested).toBe(false);

    act(() => {
      result.current.onScenarioActivationBlocked([blockingNode.id]);
    });

    expect(result.current.validationRequested).toBe(true);
    expect(result.current.selectedNodeId).toBe(blockingNode.id);
  });

  it("rejects malformed refresh data before replacing the owned editable graph", async () => {
    const bulkNode = createGeneratedBulkNode();
    const actionNode = createReplyActionNode("action-1", "Existing draft");
    const { result, setScenarios } = await renderScenarioFlowController(
      {},
      { nodes: [bulkNode, actionNode] }
    );
    const originalNodes = result.current.nodes;
    const originalEditor = result.current.graphEditor;
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        generationJobId: "generation-job-1",
        previousScenarioUpdatedAt: "2026-01-01T00:00:00.000Z",
        scenarioUpdatedAt: "2026-01-01T00:01:00.000Z",
        scenarioRevisionConflict: false,
        nodeUpdates: [{ id: "action-1", data: { kind: "unknown" } }],
      }),
    });
    try {
      const enriched = enrichBulkRootNodeData(
        bulkNode.id,
        { ...bulkNode.data, kind: "bulk" },
        {
          activeScenarioId: "scenario-1",
          workspaceId: "workspace-1",
          nodes: result.current.nodes,
          edges: [],
          graphIndex: buildScenarioNodeGraphIndex({
            nodes: result.current.nodes,
            edges: [],
          }),
          callbacksRef: {
            current: { updateNodeById: jest.fn(), removeNodeById: jest.fn() },
          },
          prepareGeneratedJobRefresh: result.current.prepareGeneratedJobRefresh,
          reconcileGeneratedJobServerUpdate:
            result.current.reconcileGeneratedJobServerUpdate,
          openNodePickerFromHandle: jest.fn(),
          t: (key: string) => key,
        } as never
      );
      let refreshError: unknown;
      await act(async () => {
        try {
          await enriched.uiOnRefreshGenerationJob?.();
        } catch (error) {
          refreshError = error;
        }
      });

      expect(result.current.nodes).toBe(originalNodes);
      expect(result.current.graphEditor).toBe(originalEditor);
      expect(result.current.saveStatus).toBe("saved");
      expect(setScenarios).not.toHaveBeenCalled();
      expect(refreshError).toEqual(
        new Error("Invalid scenario generation update")
      );

      await act(async () => {
        result.current.graphEditor.edit(graph => ({
          ...graph,
          nodes: graph.nodes.map(node =>
            node.id === actionNode.id
              ? {
                  ...node,
                  data: { ...node.data, actionReplyText: "Next local edit" },
                }
              : node
          ),
          history: "skip",
        }));
        expect(await result.current.flushScenario()).toBe(true);
      });
      expect(mockUpdateScenarioRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
          nodes: expect.arrayContaining([
            expect.objectContaining({
              id: actionNode.id,
              data: expect.objectContaining({
                kind: "action",
                actionReplyText: "Next local edit",
              }),
            }),
          ]),
        })
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("adopts an exact generated-job server revision without marking the graph dirty", async () => {
    const bulkNode = createGeneratedBulkNode();
    const actionNode = createActionNode("action-1", { x: 240, y: 0 });
    const actionData = {
      ...actionNode.data,
      actionReplyText: "Server generated media",
    };
    const { result, setScenarios } = await renderScenarioFlowController(
      {},
      { nodes: [bulkNode, actionNode] }
    );

    await act(async () => {
      await result.current.reconcileGeneratedJobServerUpdate({
        generationJobId: "generation-job-1",
        previousScenarioUpdatedAt: "2026-01-01T00:00:00.000Z",
        scenarioUpdatedAt: "2026-01-01T00:01:00.000Z",
        scenarioRevisionConflict: false,
        nodeUpdates: [{ id: "action-1", data: actionData }],
      });
    });

    expect(result.current.nodes[1]?.data).toEqual(actionData);
    expect(result.current.saveStatus).toBe("saved");
    expect(setScenarios).toHaveBeenCalled();

    await flushAutosave();
    expect(mockUpdateScenarioRequest).not.toHaveBeenCalled();
  });

  it("preserves a dirty same-node edit instead of adopting generated media over it", async () => {
    const bulkNode = createGeneratedBulkNode();
    const localAction = createReplyActionNode("action-1", "Unsaved local edit");
    const serverActionData = {
      ...localAction.data,
      actionReplyText: "Server generated media",
    };
    const { toast } = sonnerMock();
    const { result } = await renderScenarioFlowController();
    await act(async () => {
      await Promise.resolve();
    });
    mockFetchScenarioById.mockClear();

    await act(async () => {
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [bulkNode, localAction],
        history: "skip",
      }));
    });
    await act(async () => {
      await result.current.reconcileGeneratedJobServerUpdate({
        generationJobId: "generation-job-1",
        previousScenarioUpdatedAt: "2026-01-01T00:00:00.000Z",
        scenarioUpdatedAt: "2026-01-01T00:01:00.000Z",
        scenarioRevisionConflict: false,
        nodeUpdates: [{ id: "action-1", data: serverActionData }],
      });
    });

    expect(result.current.nodes[1]?.data).toMatchObject({
      actionReplyText: "Unsaved local edit",
    });
    expect(result.current.saveStatus).toBe("unsaved");
    expect(mockFetchScenarioById).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "scenario_updated_conflict",
      expect.objectContaining({
        action: expect.objectContaining({ label: "reloadScenarioAction" }),
      })
    );
  });

  it("saves dirty flow state before allowing a generated-job refresh", async () => {
    const { result } = await renderScenarioFlowController();

    await act(async () => {
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [createReplyActionNode("action-1", "Unsaved local edit")],
        history: "skip",
      }));
    });
    expect(result.current.saveStatus).toBe("unsaved");

    const prepareRefresh = result.current.prepareGeneratedJobRefresh;
    expect(prepareRefresh).toBeDefined();

    let canRefresh = false;
    if (prepareRefresh) {
      await act(async () => {
        canRefresh = await prepareRefresh();
      });
    }

    expect(canRefresh).toBe(true);
    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(1);
    expect(mockUpdateScenarioRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        nodes: [
          expect.objectContaining({
            id: "action-1",
            data: expect.objectContaining({
              actionReplyText: "Unsaved local edit",
            }),
          }),
        ],
      })
    );
  });

  it("keeps dirty flow saveable when a generated-job refresh made no scenario change", async () => {
    const { toast } = sonnerMock();
    const { result } = await renderScenarioFlowController();

    await act(async () => {
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [createReplyActionNode("action-1", "Unsaved local edit")],
        history: "skip",
      }));
    });

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.reconcileGeneratedJobServerUpdate({
        generationJobId: "generation-job-1",
        previousScenarioUpdatedAt: "2026-01-01T00:00:00.000Z",
        scenarioUpdatedAt: "2026-01-01T00:00:00.000Z",
        scenarioRevisionConflict: false,
        nodeUpdates: [],
      });
    });

    expect(outcome).toEqual({ status: "no_op" });
    expect(result.current.nodes[0]?.data).toMatchObject({
      actionReplyText: "Unsaved local edit",
    });
    expect(result.current.saveStatus).toBe("unsaved");
    expect(toast.error).not.toHaveBeenCalledWith(
      "scenario_updated_conflict",
      expect.anything()
    );
  });

  it("reloads a stale clean flow when a generated-job request made no new write", async () => {
    const bulkNode = createGeneratedBulkNode();
    const authoritativeAction = createReplyActionNode(
      "action-1",
      "Authoritative server graph"
    );
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [bulkNode] }
    );
    await act(async () => {
      await Promise.resolve();
    });
    mockFetchScenarioById.mockClear();
    mockFetchScenarioById.mockResolvedValueOnce(
      createScenarioDetailResponse(
        createScenarioDocument({
          updatedAt: "2026-01-01T00:02:00.000Z",
          nodes: [bulkNode, authoritativeAction],
        })
      )
    );

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.reconcileGeneratedJobServerUpdate({
        scenarioId: "scenario-1",
        generationJobId: "generation-job-1",
        previousScenarioUpdatedAt: "2026-01-01T00:01:00.000Z",
        scenarioUpdatedAt: "2026-01-01T00:01:00.000Z",
        scenarioRevisionConflict: false,
        nodeUpdates: [],
      } as never);
    });

    expect(outcome).toEqual({ status: "applied" });
    expect(mockFetchScenarioById).toHaveBeenCalledTimes(1);
    expect(result.current.nodes[1]?.data).toMatchObject({
      actionReplyText: "Authoritative server graph",
    });
  });

  it("preserves dirty local edits when generated media reports a CAS conflict", async () => {
    const bulkNode = createGeneratedBulkNode();
    const localAction = createReplyActionNode("action-1", "Unsaved local edit");
    const { toast } = sonnerMock();
    const { result } = await renderScenarioFlowController();
    await act(async () => {
      await Promise.resolve();
    });
    mockFetchScenarioById.mockClear();

    await act(async () => {
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [bulkNode, localAction],
        history: "skip",
      }));
    });
    await act(async () => {
      await result.current.reconcileGeneratedJobServerUpdate({
        generationJobId: "generation-job-1",
        previousScenarioUpdatedAt: "2026-01-01T00:01:00.000Z",
        scenarioUpdatedAt: "2026-01-01T00:02:00.000Z",
        scenarioRevisionConflict: true,
        nodeUpdates: [],
      });
    });

    expect(result.current.nodes[1]?.data).toMatchObject({
      actionReplyText: "Unsaved local edit",
    });
    expect(result.current.saveStatus).toBe("unsaved");
    expect(mockFetchScenarioById).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "scenario_updated_conflict",
      expect.objectContaining({
        action: expect.objectContaining({ label: "reloadScenarioAction" }),
      })
    );
  });

  it("reports a failed outcome when authoritative generated-job reload fails", async () => {
    const { result } = await renderScenarioFlowController();
    await act(async () => {
      await Promise.resolve();
    });
    mockFetchScenarioById.mockClear();
    mockFetchScenarioById.mockRejectedValueOnce(new Error("Reload failed"));

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.reconcileGeneratedJobServerUpdate({
        generationJobId: "generation-job-1",
        previousScenarioUpdatedAt: "2026-01-01T00:01:00.000Z",
        scenarioUpdatedAt: "2026-01-01T00:02:00.000Z",
        scenarioRevisionConflict: true,
        nodeUpdates: [],
      });
    });

    expect(outcome).toEqual({ status: "failed" });
  });

  it("reloads the authoritative scenario when a generated-job base revision conflicts", async () => {
    const bulkNode = createGeneratedBulkNode();
    const authoritativeAction = {
      ...createActionNode("action-1", { x: 240, y: 0 }),
      data: {
        kind: "action" as const,
        actionType: "reply" as const,
        actionReplyText: "Authoritative server graph",
      },
    };
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [bulkNode, createActionNode("action-1", { x: 240, y: 0 })] }
    );
    mockFetchScenarioById.mockResolvedValueOnce(
      createScenarioDetailResponse(
        createScenarioDocument({
          updatedAt: "2026-01-01T00:02:00.000Z",
          nodes: [bulkNode, authoritativeAction],
        })
      )
    );

    await act(async () => {
      await result.current.reconcileGeneratedJobServerUpdate({
        generationJobId: "generation-job-1",
        previousScenarioUpdatedAt: "2026-01-01T00:01:00.000Z",
        scenarioUpdatedAt: "2026-01-01T00:02:00.000Z",
        scenarioRevisionConflict: true,
        nodeUpdates: [],
      });
    });

    expect(mockFetchScenarioById).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioId: "scenario-1",
        workspaceId: "workspace-1",
      })
    );
    expect(result.current.nodes[1]?.data).toMatchObject({
      actionReplyText: "Authoritative server graph",
    });
    expect(result.current.saveStatus).toBe("saved");
  });

  it("serializes fast legacy edits into one conversion followed by a local patch", async () => {
    const legacyAction = createActionNode("action-1", { x: 0, y: 0 });
    const convertedScenario = createScenarioDocument({
      updatedAt: "2026-01-01T00:01:00.000Z",
      nodes: [
        {
          ...legacyAction,
          data: {
            ...legacyAction.data,
            actionOutcomes: {
              version: 1,
              anyReply: { enabled: true },
            },
          },
        },
      ],
    });
    mockConvertLegacyActionRoutingRequest.mockResolvedValue(
      createScenarioDetailResponse(convertedScenario)
    );
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [legacyAction] }
    );

    await act(async () => {
      const first = result.current.convertLegacyActionRouting({
        sourceActionNodeId: "action-1",
        sourceNodeId: "condition-1",
        sourceKind: "post_action_condition",
        patch: {
          actionOutcomes: {
            version: 1,
            anyReply: { enabled: true },
          },
        },
      });
      const second = result.current.convertLegacyActionRouting({
        sourceActionNodeId: "action-1",
        sourceNodeId: "condition-1",
        sourceKind: "post_action_condition",
        patch: {
          actionOutcomes: {
            version: 1,
            noReply: { enabled: true, timeoutMinutes: 45 },
          },
        },
      });
      await Promise.all([first, second]);
    });

    expect(mockConvertLegacyActionRoutingRequest).toHaveBeenCalledTimes(1);
    expect(result.current.nodes[0]?.data).toMatchObject({
      actionOutcomes: {
        version: 1,
        noReply: { enabled: true, timeoutMinutes: 45 },
      },
    });
    expect(result.current.saveStatus).toBe("unsaved");
  });

  it("deletes an eligible hidden condition with its projected action", async () => {
    const action = createActionNode("action-1", { x: 0, y: 0 });
    const condition = {
      id: "condition-1",
      type: "scenarioNode",
      position: { x: 240, y: 0 },
      data: {
        kind: "logic",
        logicType: "post_action_condition",
        conditionBranches: [{ id: "reply", type: "user_replied" }],
      },
    } as ScenarioFlowNode;
    const { result } = await renderScenarioFlowController(
      {},
      {
        nodes: [action, condition],
        edges: [{ id: "input", source: "action-1", target: "condition-1" }],
      }
    );

    act(() => {
      result.current.onCanvasNodeClick({} as never, action);
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Delete",
          bubbles: true,
          cancelable: true,
        })
      );
    });

    expect(result.current.nodes).toEqual([]);
    expect(result.current.edges).toEqual([]);
  });

  it("materializes a projected audience gate before deleting its visible edge", async () => {
    const trigger = {
      id: "trigger-1",
      type: "triggerNode",
      position: { x: 0, y: 0 },
      data: { kind: "trigger" },
    } as ScenarioFlowNode;
    const gate = {
      id: "gate-1",
      type: "scenarioNode",
      position: { x: 240, y: 0 },
      data: {
        kind: "logic",
        logicType: "audience_filter",
        audienceMode: "internalLabel",
        internalLabel: "vip",
      },
    } as ScenarioFlowNode;
    const action = createActionNode("action-1", { x: 480, y: 0 });
    const { result } = await renderScenarioFlowController(
      {},
      {
        nodes: [trigger, gate, action],
        edges: [
          { id: "edge-in", source: "trigger-1", target: "gate-1" },
          { id: "edge-out", source: "gate-1", target: "action-1" },
        ],
      }
    );

    act(() => {
      result.current.onCanvasEdgeClick({} as never, {
        id: "edge-in",
        source: "trigger-1",
        target: "action-1",
      });
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Delete",
          bubbles: true,
          cancelable: true,
        })
      );
    });

    expect(result.current.nodes.map(node => node.id)).toEqual([
      "trigger-1",
      "action-1",
    ]);
    expect(
      result.current.nodes.find(node => node.id === "action-1")?.data
    ).toMatchObject({
      actionRunConditions: {
        conditions: [expect.objectContaining({ type: "internal_label" })],
      },
    });
    expect(result.current.edges).toEqual([]);
  });

  it("onBeforeCanvasDelete keeps nodes when only an edge is selected", async () => {
    const firstNode = createActionNode("action-1", { x: 0, y: 0 });
    const secondNode = createActionNode("action-2", { x: 120, y: 0 });
    const edge = {
      id: "edge-1",
      source: firstNode.id,
      target: secondNode.id,
    } as ScenarioFlowEdge;
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [firstNode, secondNode], edges: [edge] }
    );

    act(() => {
      result.current.onCanvasSelectionChange({
        nodes: [],
        edges: [edge],
      });
    });

    await expect(
      result.current.onBeforeCanvasDelete({
        nodes: [firstNode, secondNode],
        edges: [edge],
      })
    ).resolves.toEqual({
      nodes: [],
      edges: [edge],
    });
  });

  it("onBeforeCanvasDelete keeps nodes when edge and node are both selected", async () => {
    const firstNode = createActionNode("action-1", { x: 0, y: 0 });
    const secondNode = createActionNode("action-2", { x: 120, y: 0 });
    const edge = {
      id: "edge-1",
      source: firstNode.id,
      target: secondNode.id,
    } as ScenarioFlowEdge;
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [firstNode, secondNode], edges: [edge] }
    );

    act(() => {
      result.current.onCanvasSelectionChange({
        nodes: [firstNode],
        edges: [edge],
      });
    });

    await expect(
      result.current.onBeforeCanvasDelete({
        nodes: [firstNode, secondNode],
        edges: [edge],
      })
    ).resolves.toEqual({
      nodes: [],
      edges: [edge],
    });
  });

  it.each(["Delete", "Backspace"])(
    "removes only a clicked edge when the source node stays expanded in the panel",
    async key => {
      const firstNode = createActionNode("action-1", { x: 0, y: 0 });
      const secondNode = createActionNode("action-2", { x: 120, y: 0 });
      const edge = {
        id: "edge-1",
        source: firstNode.id,
        target: secondNode.id,
      } as ScenarioFlowEdge;
      const { result } = await renderScenarioFlowController();

      await act(async () => {
        result.current.graphEditor.edit(graph => ({
          ...graph,
          nodes: [firstNode, secondNode],
          history: "skip",
        }));
        result.current.graphEditor.edit(graph => ({
          ...graph,
          edges: [edge],
          history: "skip",
        }));
        result.current.setSelectedNodeId(firstNode.id);
      });

      act(() => {
        result.current.onCanvasEdgeClick(
          new MouseEvent("click") as never,
          edge
        );
      });

      const event = new KeyboardEvent("keydown", {
        key,
        code: key,
        bubbles: true,
        cancelable: true,
      });

      act(() => {
        window.dispatchEvent(event);
      });

      expect(event.defaultPrevented).toBe(true);
      expect(result.current.nodes.map(node => node.id)).toEqual([
        firstNode.id,
        secondNode.id,
      ]);
      expect(result.current.edges).toEqual([]);
      expect(result.current.selectedNodeId).toBe(firstNode.id);
    }
  );

  it.each(["Delete", "Backspace"])(
    "removes a selected edge with the %s key",
    async key => {
      const firstNode = createActionNode("action-1", { x: 0, y: 0 });
      const secondNode = createActionNode("action-2", { x: 120, y: 0 });
      const edge = {
        id: "edge-1",
        source: firstNode.id,
        target: secondNode.id,
      } as ScenarioFlowEdge;
      const { result } = await renderScenarioFlowController(
        {},
        { nodes: [firstNode, secondNode], edges: [edge] }
      );

      act(() => {
        result.current.onCanvasSelectionChange({
          nodes: [],
          edges: [edge],
        });
      });

      const event = new KeyboardEvent("keydown", {
        key,
        code: key,
        bubbles: true,
        cancelable: true,
      });

      act(() => {
        window.dispatchEvent(event);
      });

      expect(event.defaultPrevented).toBe(true);
      expect(result.current.nodes.map(node => node.id)).toEqual([
        firstNode.id,
        secondNode.id,
      ]);
      expect(result.current.edges).toEqual([]);
    }
  );

  it("undoes completed node drags through unsaved graph history", async () => {
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [createActionNode("action-1", { x: 0, y: 0 })], edges: [] }
    );

    act(() => {
      result.current.onNodesChange([
        {
          id: "action-1",
          type: "position",
          position: { x: 40, y: 0 },
          dragging: true,
        },
      ]);
      result.current.onNodesChange([
        {
          id: "action-1",
          type: "position",
          position: { x: 40, y: 0 },
          dragging: false,
        },
      ]);
    });

    expect(result.current.nodes[0]?.position).toEqual({ x: 40, y: 0 });

    act(() => {
      expect(result.current.undoGraphChange()).toBe(true);
    });

    expect(result.current.nodes[0]?.position).toEqual({ x: 0, y: 0 });
    expect(result.current.nodes[0]?.selected).toBeUndefined();
  });

  it("redoes an undone graph edit and clears redo after a new edit", async () => {
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [createActionNode("a", { x: 0, y: 0 })], edges: [] }
    );
    act(() =>
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [...graph.nodes, createActionNode("b", { x: 400, y: 0 })],
        history: "record",
      }))
    );
    act(() => {
      expect(result.current.undoGraphChange()).toBe(true);
    });
    expect(result.current.nodes.map(node => node.id)).toEqual(["a"]);
    act(() => {
      expect(result.current.redoGraphChange()).toBe(true);
    });
    expect(result.current.nodes.map(node => node.id)).toEqual(["a", "b"]);
    act(() => {
      result.current.undoGraphChange();
    });
    act(() =>
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [...graph.nodes, createActionNode("c", { x: 500, y: 0 })],
        history: "record",
      }))
    );
    act(() => {
      expect(result.current.redoGraphChange()).toBe(false);
    });
    expect(result.current.nodes.map(node => node.id)).toEqual(["a", "c"]);
  });

  async function renderWithRecordedNode(keepSelectionThroughHistory?: boolean) {
    const view = await renderScenarioFlowController(
      { keepSelectionThroughHistory },
      { nodes: [createActionNode("a", { x: 0, y: 0 })], edges: [] }
    );
    act(() =>
      view.result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [...graph.nodes, createActionNode("b", { x: 400, y: 0 })],
        history: "record",
      }))
    );
    return view;
  }

  it("keeps the selected node through undo and redo while node settings are enabled", async () => {
    const { result } = await renderWithRecordedNode(true);
    act(() => result.current.setSelectedNodeId("a"));
    act(() => {
      expect(result.current.undoGraphChange()).toBe(true);
    });
    expect(result.current.nodes.map(node => node.id)).toEqual(["a"]);
    expect(result.current.selectedNodeId).toBe("a");
    act(() => {
      expect(result.current.redoGraphChange()).toBe(true);
    });
    expect(result.current.selectedNodeId).toBe("a");
    // Canvas highlight is still history-neutral.
    expect(result.current.canvasSelection.nodeIds.size).toBe(0);

    // Undo that removes the selected node closes its settings.
    act(() => result.current.setSelectedNodeId("b"));
    act(() => {
      expect(result.current.undoGraphChange()).toBe(true);
    });
    expect(result.current.selectedNodeId).toBeNull();
  });

  it("clears the selected node on undo and redo while node settings are disabled", async () => {
    const { result } = await renderWithRecordedNode();
    act(() => result.current.setSelectedNodeId("a"));
    act(() => {
      expect(result.current.undoGraphChange()).toBe(true);
    });
    expect(result.current.selectedNodeId).toBeNull();
    act(() => result.current.setSelectedNodeId("a"));
    act(() => {
      expect(result.current.redoGraphChange()).toBe(true);
    });
    expect(result.current.selectedNodeId).toBeNull();
  });

  it("auto-arranges structural service-message edits and permits manual placement when disabled", async () => {
    const source = createActionNode("a", { x: 0, y: 0 });
    source.data = {
      ...source.data,
      actionReplyChannel: "whatsapp",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: { kind: "text", body: { mode: "fixed", text: "Hello" } },
      },
    };
    const root: ScenarioFlowNode = {
      id: "root",
      position: { x: 0, y: 0 },
      data: { kind: "trigger" },
    };
    const { result } = await renderScenarioFlowController(
      {},
      {
        nodes: [root, source],
        edges: [{ id: "root-a", source: "root", target: "a" }],
      }
    );
    act(() =>
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [...graph.nodes, createActionNode("b", { x: 0, y: 0 })],
        edges: [...graph.edges, { id: "a-b", source: "a", target: "b" }],
        history: "record",
      }))
    );
    expect(
      result.current.nodes.find(node => node.id === "b")!.position.x
    ).toBeGreaterThan(
      result.current.nodes.find(node => node.id === "a")!.position.x
    );
    act(() => result.current.setAutoLayoutEnabled(false));
    act(() =>
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [...graph.nodes, createActionNode("c", { x: 23, y: 45 })],
        history: "record",
      }))
    );
    expect(
      result.current.nodes.find(node => node.id === "c")!.position
    ).toEqual({ x: 23, y: 45 });
  });

  it("finishes structural auto-layout with new node measurements in the same undo step", async () => {
    const source = createActionNode("source", { x: 430, y: 200 });
    source.data.actionWhatsAppServiceMessage = {
      version: 1,
      message: { kind: "text", body: { mode: "fixed", text: "Choose" } },
    };
    const root: ScenarioFlowNode = {
      id: "root",
      position: { x: 0, y: 0 },
      measured: { width: 300, height: 110 },
      data: { kind: "trigger" },
    };
    source.measured = { width: 300, height: 280 };
    const lower = {
      ...createActionNode("lower", { x: 800, y: 500 }),
      measured: { width: 300, height: 280 },
    };
    const { result } = await renderScenarioFlowController(
      {},
      {
        nodes: [root, source, lower],
        edges: [
          { id: "entry", source: "root", target: "source" },
          { id: "lower", source: "source", target: "lower" },
        ],
      }
    );
    act(() =>
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [...graph.nodes, createActionNode("tall", { x: 800, y: 0 })],
        edges: [
          ...graph.edges,
          { id: "tall", source: "source", target: "tall" },
        ],
        history: "record",
      }))
    );
    act(() =>
      result.current.onNodesChange([
        {
          id: "tall",
          type: "dimensions",
          dimensions: { width: 380, height: 800 },
        },
      ])
    );
    const finalNodes = result.current.nodes;
    expect(
      finalNodes.find(node => node.id === "lower")!.position.y -
        finalNodes.find(node => node.id === "tall")!.position.y -
        800
    ).toBeGreaterThanOrEqual(80);
    act(() => {
      expect(result.current.undoGraphChange()).toBe(true);
    });
    expect(result.current.nodes.map(node => node.id)).toEqual([
      "root",
      "source",
      "lower",
    ]);
    expect(
      result.current.nodes.find(node => node.id === "source")!.position
    ).toEqual({ x: 430, y: 200 });
    act(() => {
      expect(result.current.redoGraphChange()).toBe(true);
    });
    expect(result.current.nodes.map(node => node.position)).toEqual(
      finalNodes.map(node => node.position)
    );
    act(() =>
      result.current.onNodesChange([
        {
          id: "tall",
          type: "dimensions",
          dimensions: { width: 380, height: 900 },
        },
      ])
    );
    expect(result.current.nodes.map(node => node.position)).toEqual(
      finalNodes.map(node => node.position)
    );
  });

  it("keeps a node placed at a chosen point instead of re-laying out the graph", async () => {
    const source = createActionNode("source", { x: 430, y: 200 });
    source.data.actionWhatsAppServiceMessage = {
      version: 1,
      message: { kind: "text", body: { mode: "fixed", text: "Choose" } },
    };
    source.measured = { width: 300, height: 280 };
    const root: ScenarioFlowNode = {
      id: "root",
      position: { x: 0, y: 0 },
      measured: { width: 300, height: 110 },
      data: { kind: "trigger" },
    };
    const { result } = await renderScenarioFlowController(
      {},
      {
        nodes: [root, source],
        edges: [{ id: "entry", source: "root", target: "source" }],
      }
    );
    const placed = { x: 1234, y: 567 };
    act(() =>
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [...graph.nodes, createActionNode("placed", placed)],
        edges: [
          ...graph.edges,
          { id: "placed", source: "source", target: "placed" },
        ],
        history: "record",
        layout: "keep",
      }))
    );
    act(() =>
      result.current.onNodesChange([
        {
          id: "placed",
          type: "dimensions",
          dimensions: { width: 380, height: 300 },
        },
      ])
    );

    expect(result.current.nodes.map(node => [node.id, node.position])).toEqual([
      ["root", { x: 0, y: 0 }],
      ["source", { x: 430, y: 200 }],
      ["placed", placed],
    ]);
  });

  it.each(["move", "remove"] as const)(
    "cancels pending measured layout after a manual %s",
    async operation => {
      const source = createActionNode("source", { x: 300, y: 50 });
      source.measured = { width: 300, height: 280 };
      source.data.actionWhatsAppServiceMessage = {
        version: 1,
        message: { kind: "text", body: { mode: "fixed", text: "Hello" } },
      };
      const root: ScenarioFlowNode = {
        id: "root",
        position: { x: 0, y: 0 },
        measured: { width: 300, height: 110 },
        data: { kind: "trigger" },
      };
      const { result } = await renderScenarioFlowController(
        {},
        {
          nodes: [root, source],
          edges: [{ id: "entry", source: "root", target: "source" }],
        }
      );
      act(() =>
        result.current.graphEditor.edit(graph => ({
          ...graph,
          nodes: [...graph.nodes, createActionNode("new", { x: 600, y: 0 })],
          edges: [
            ...graph.edges,
            { id: "new", source: "source", target: "new" },
          ],
          history: "record",
        }))
      );
      act(() =>
        result.current.onNodesChange(
          operation === "move"
            ? [
                {
                  id: "source",
                  type: "position",
                  position: { x: 333, y: 777 },
                  dragging: false,
                },
              ]
            : [{ id: "new", type: "remove" }]
        )
      );
      const manualPositions = result.current.nodes.map(node => node.position);
      act(() =>
        result.current.onNodesChange([
          {
            id: operation === "move" ? "new" : "source",
            type: "dimensions",
            dimensions: { width: 420, height: 800 },
          },
        ])
      );
      expect(result.current.nodes.map(node => node.position)).toEqual(
        manualPositions
      );
    }
  );

  it("undoes graph history one completed drag at a time", async () => {
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [createActionNode("action-1", { x: 0, y: 0 })], edges: [] }
    );

    act(() => {
      result.current.onNodesChange([
        {
          id: "action-1",
          type: "position",
          position: { x: 40, y: 0 },
          dragging: true,
        },
      ]);
      result.current.onNodesChange([
        {
          id: "action-1",
          type: "position",
          position: { x: 40, y: 0 },
          dragging: false,
        },
      ]);
      result.current.onNodesChange([
        {
          id: "action-1",
          type: "position",
          position: { x: 80, y: 0 },
          dragging: true,
        },
      ]);
      result.current.onNodesChange([
        {
          id: "action-1",
          type: "position",
          position: { x: 80, y: 0 },
          dragging: false,
        },
      ]);
    });

    expect(result.current.nodes[0]?.position).toEqual({ x: 80, y: 0 });

    act(() => {
      expect(result.current.undoGraphChange()).toBe(true);
    });
    expect(result.current.nodes[0]?.position).toEqual({ x: 40, y: 0 });

    act(() => {
      expect(result.current.undoGraphChange()).toBe(true);
    });
    expect(result.current.nodes[0]?.position).toEqual({ x: 0, y: 0 });

    act(() => {
      expect(result.current.undoGraphChange()).toBe(false);
    });
  });

  it("clones and clears selection when recording a graph command for undo", async () => {
    const snapshotNode = {
      ...createActionNode("action-1", { x: 40, y: 0 }),
      selected: true,
    };
    const snapshotEdge = {
      id: "edge-1",
      source: "action-1",
      target: "next-1",
      selected: true,
    } as ScenarioFlowEdge;
    const { result } = await renderScenarioFlowController(
      {},
      {
        nodes: [snapshotNode, createActionNode("next-1", { x: 100, y: 0 })],
        edges: [snapshotEdge],
      }
    );
    const capturedGraph = result.current.graphEditor.read();
    act(() => {
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [createActionNode("action-1", { x: 80, y: 0 })],
        edges: [],
        history: "record",
      }));
    });
    capturedGraph.nodes[0].position = { x: 999, y: 0 };
    capturedGraph.edges[0].source = "mutated-source";

    act(() => {
      expect(result.current.undoGraphChange()).toBe(true);
    });

    expect(result.current.nodes[0]?.position).toEqual({ x: 40, y: 0 });
    expect(result.current.nodes[0]?.selected).toBeUndefined();
    expect(result.current.edges[0]).toMatchObject({
      id: "edge-1",
      source: "action-1",
      target: "next-1",
    });
    expect(result.current.edges[0]?.selected).toBeUndefined();
  });

  it("does not add selection-only changes to graph history", async () => {
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [createActionNode("action-1", { x: 0, y: 0 })], edges: [] }
    );

    act(() => {
      result.current.onNodesChange([
        { id: "action-1", type: "select", selected: true },
      ]);
    });

    act(() => {
      expect(result.current.undoGraphChange()).toBe(false);
    });
    expect(result.current.nodes[0]?.position).toEqual({ x: 0, y: 0 });
    expect(result.current.nodes[0]?.selected).toBeUndefined();
  });

  it("handles Ctrl+Z as graph undo when focus is on the canvas", async () => {
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [createActionNode("action-1", { x: 0, y: 0 })], edges: [] }
    );

    act(() => {
      result.current.onNodesChange([
        {
          id: "action-1",
          type: "position",
          position: { x: 40, y: 0 },
          dragging: true,
        },
      ]);
      result.current.onNodesChange([
        {
          id: "action-1",
          type: "position",
          position: { x: 40, y: 0 },
          dragging: false,
        },
      ]);
    });

    expect(result.current.nodes[0]?.position).toEqual({ x: 40, y: 0 });

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "z",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });

    expect(result.current.nodes[0]?.position).toEqual({ x: 0, y: 0 });
  });

  it.each([
    ["Delete", '<button role="combobox">Message type</button>'],
    ["Backspace", '<button role="combobox">Message type</button>'],
    ["Delete", "<button>Remove reply button</button>"],
    ["Backspace", "<button>Remove reply button</button>"],
    ["Delete", '<div role="dialog" tabindex="0">Editor</div>'],
    ["Backspace", '<div role="dialog" tabindex="0">Editor</div>'],
    ["Delete", '<div contenteditable="plaintext-only">Message</div>'],
    ["Backspace", '<div contenteditable="true"><span>Message</span></div>'],
  ])("keeps the action node when %s is pressed in %s", async (key, html) => {
    const node = createActionNode("action-1", { x: 0, y: 0 });
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [node], edges: [] }
    );
    act(() =>
      result.current.onCanvasSelectionChange({ nodes: [node], edges: [] })
    );
    const portal = document.createElement("div");
    portal.innerHTML = html;
    document.body.append(portal);
    const control = portal.firstElementChild!;
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    });
    try {
      act(() => control.dispatchEvent(event));
      expect(result.current.nodes.map(current => current.id)).toEqual([
        node.id,
      ]);
      expect(event.defaultPrevented).toBe(false);
    } finally {
      portal.remove();
    }
  });

  it("leaves Ctrl+Z inside editable fields to the native input undo stack", async () => {
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [createActionNode("action-1", { x: 0, y: 0 })], edges: [] }
    );
    const input = document.createElement("input");
    document.body.append(input);

    act(() => {
      result.current.onNodesChange([
        {
          id: "action-1",
          type: "position",
          position: { x: 40, y: 0 },
          dragging: true,
        },
      ]);
      result.current.onNodesChange([
        {
          id: "action-1",
          type: "position",
          position: { x: 40, y: 0 },
          dragging: false,
        },
      ]);
    });

    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "z",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });

    expect(result.current.nodes[0]?.position).toEqual({ x: 40, y: 0 });
    input.remove();
  });

  it("debounces edits made during autosave using the confirmed response revision", async () => {
    let finishSave!: (value: ScenarioDocument) => void;
    mockUpdateScenarioRequest.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishSave = resolve;
        })
    );
    const { result } = await renderScenarioFlowController();
    await act(async () => {
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [createReplyActionNode("action-1", "first edit")],
        history: "skip",
      }));

      jest.advanceTimersByTime(3000);
    });
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(1);
    await act(async () => {
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [createReplyActionNode("action-1", "second edit")],
        history: "skip",
      }));
    });
    await act(async () => {
      finishSave(
        createScenarioDocument({ updatedAt: "2026-01-01T00:01:00.000Z" })
      );
    });
    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(1);
    expect(result.current.saveStatus).toBe("unsaved");
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(2);
    expect(mockUpdateScenarioRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scenarioId: "scenario-1",
        expectedUpdatedAt: "2026-01-01T00:01:00.000Z",
        nodes: [createReplyActionNode("action-1", "second edit")],
      })
    );
    expect(result.current.nodes[0].data.actionReplyText).toBe("second edit");
    expect(result.current.saveStatus).toBe("saved");
  });

  it("retries a newer correction after a slow autosave fails", async () => {
    let rejectSave!: (error: Error) => void;
    mockUpdateScenarioRequest.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectSave = reject;
        })
    );
    const { result } = await renderScenarioFlowController();
    act(() =>
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [createReplyActionNode("action-1", "unfinished")],
        history: "record",
      }))
    );
    await act(async () => jest.advanceTimersByTime(3000));
    act(() =>
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [createReplyActionNode("action-1", "corrected")],
        history: "record",
      }))
    );
    await act(async () => jest.advanceTimersByTime(6000));
    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(1);
    expect(result.current.saveStatus).toBe("saving");
    await act(async () => rejectSave(new Error("Save failed")));
    await act(async () => jest.advanceTimersByTime(3000));
    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(2);
    expect(mockUpdateScenarioRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nodes: [createReplyActionNode("action-1", "corrected")],
      })
    );
    expect(result.current.saveStatus).toBe("saved");
  });

  it("Ctrl+S flushes newer text immediately after an in-flight autosave", async () => {
    let finishSave!: (value: ScenarioDocument) => void;
    mockUpdateScenarioRequest.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishSave = resolve;
        })
    );
    const { result } = await renderScenarioFlowController();
    act(() =>
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [createReplyActionNode("action-1", "first edit")],
        history: "record",
      }))
    );
    await act(async () => jest.advanceTimersByTime(3000));
    act(() =>
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [createReplyActionNode("action-1", "second edit")],
        history: "record",
      }))
    );
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "s",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        })
      )
    );
    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(1);
    await act(async () =>
      finishSave(
        createScenarioDocument({ updatedAt: "2026-01-01T00:01:00.000Z" })
      )
    );
    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(2);
    expect(mockUpdateScenarioRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedUpdatedAt: "2026-01-01T00:01:00.000Z",
        nodes: [createReplyActionNode("action-1", "second edit")],
      })
    );
    expect(result.current.saveStatus).toBe("saved");
    await act(async () => jest.advanceTimersByTime(6000));
    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(2);
  });

  it("applies a requested draft status after an in-flight active autosave fails", async () => {
    let rejectSave!: (error: Error) => void;
    mockUpdateScenarioRequest.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectSave = reject;
        })
    );
    const { result } = await renderScenarioFlowController(
      { activeScenarioStatus: "active" },
      { nodes: [], edges: [] }
    );
    act(() =>
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [createReplyActionNode("action-1", "unfinished")],
        history: "record",
      }))
    );
    await act(async () => jest.advanceTimersByTime(3000));
    expect(mockUpdateScenarioRequest).toHaveBeenCalledWith(
      expect.objectContaining({ status: "active" })
    );
    let pause!: Promise<boolean>;
    act(() => {
      pause = result.current.coordinateActiveScenarioPatch({ status: "draft" });
    });
    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(1);
    await act(async () => {
      rejectSave(
        new ScenarioRequestError({
          status: 400,
          code: "whatsappServiceMessageInvalid",
          message: "Finish message",
        })
      );
      expect(await pause).toBe(true);
    });
    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(2);
    expect(mockUpdateScenarioRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "draft" })
    );
    expect(result.current.saveStatus).toBe("saved");
  });

  it("shows validation after attempted activation and clears it for a new draft session", async () => {
    const { result, rerender } = await renderScenarioFlowController();
    expect(result.current.validationRequested).toBe(false);
    mockUpdateScenarioRequest.mockRejectedValueOnce(
      new ScenarioRequestError({
        status: 400,
        code: "whatsappServiceMessageInvalid",
        message: "Finish the message",
      })
    );
    await act(async () => {
      expect(
        await result.current.coordinateActiveScenarioPatch({ status: "active" })
      ).toBe(false);
    });
    expect(result.current.validationRequested).toBe(true);
    await act(async () => {
      switchScenario(rerender, "scenario-2", "Scenario 2");
    });
    expect(result.current.validationRequested).toBe(false);
  });

  it("never saves the departing graph under a scenario whose load is pending", async () => {
    const { result, rerender } = await renderScenarioFlowController();
    await act(async () => {
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [createReplyActionNode("action-1", "A draft")],
        history: "skip",
      }));
    });
    mockFetchScenarioById.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => {
      switchScenario(
        rerender,
        "scenario-2",
        "Scenario 2",
        "2026-01-01T00:02:00.000Z"
      );
    });
    await act(async () => {
      jest.advanceTimersByTime(10000);
    });
    expect(mockUpdateScenarioRequest).not.toHaveBeenCalled();
    await expect(result.current.flushScenario()).resolves.toBe(false);
  });

  it.each(["resolve", "reject"] as const)(
    "ignores an old save %s after A to B to A",
    async outcome => {
      let finishSave!: (value: ScenarioDocument) => void;
      let rejectSave!: (reason: unknown) => void;
      mockUpdateScenarioRequest.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finishSave = resolve;
            rejectSave = reject;
          })
      );
      const { result, rerender, setScenarios } =
        await renderScenarioFlowController();
      await act(async () => {
        result.current.graphEditor.edit(graph => ({
          ...graph,
          nodes: [createReplyActionNode("action-1", "old A")],
          history: "skip",
        }));
      });
      await act(async () => {
        jest.advanceTimersByTime(3000);
      });
      await act(async () => {
        switchScenario(rerender, "scenario-2", "Scenario 2");
      });
      await act(async () => {
        switchScenario(rerender, "scenario-1", "Scenario 1");
      });
      await act(async () => {
        result.current.graphEditor.edit(graph => ({
          ...graph,
          nodes: [createReplyActionNode("action-1", "new A")],
          history: "skip",
        }));
      });
      const summaryUpdates = setScenarios.mock.calls.length;
      const { toast } = sonnerMock();
      await act(async () => {
        if (outcome === "resolve")
          finishSave(
            createScenarioDocument({ updatedAt: "2026-01-01T00:01:00.000Z" })
          );
        else
          rejectSave(
            new ScenarioRequestError({
              message: "Conflict",
              status: 409,
              code: "scenario_updated_conflict",
            })
          );
      });
      expect(result.current.nodes[0].data.actionReplyText).toBe("new A");
      expect(result.current.saveStatus).toBe("unsaved");
      expect(setScenarios).toHaveBeenCalledTimes(summaryUpdates);
      expect(toast.error).not.toHaveBeenCalled();
    }
  );

  it("rejects late managed Flow preparation without replacing the next scenario", async () => {
    const editableConfig: WhatsAppFlowConfig = {
      templateId: "lead_generation",
      ctaText: "Continue",
      flowNavigationMode: "linear",
      screens: [{ id: "LEAD_FORM", title: "Lead form", fields: [] }],
    };
    mockFetchScenarioById.mockResolvedValueOnce(
      createScenarioDetailResponse(
        createScenarioDocument({
          nodes: [createWhatsAppFlowActionNode(editableConfig)],
        })
      )
    );
    let finishSave!: (value: ScenarioDocument) => void;
    mockUpdateScenarioRequest.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishSave = resolve;
        })
    );
    const { result, rerender } = await renderScenarioFlowController();
    let preparation!: Promise<unknown>;
    act(() => {
      preparation = result.current.publishManagedWhatsAppFlow({
        nodeId: "flow-action-1",
        sourceId: "source-1",
        editableConfig,
      });
    });
    const rejected = expect(preparation).resolves.toBeNull();
    mockFetchScenarioById.mockResolvedValueOnce(
      createScenarioDetailResponse(
        createScenarioDocument({
          _id: "scenario-2",
          nodes: [createReplyActionNode("action-2", "B graph")],
        })
      )
    );
    await act(async () => {
      switchScenario(rerender, "scenario-2", "Scenario 2");
    });
    await act(async () => {
      finishSave(
        createScenarioDocument({
          nodes: [createWhatsAppFlowActionNode(editableConfig)],
          updatedAt: "2026-01-01T00:01:00.000Z",
        })
      );
      await rejected;
    });
    expect(result.current.nodes[0].id).toBe("action-2");
    expect(result.current.saveStatus).toBe("saved");
  });

  it("flushes every current graph edit before reporting a clean document", async () => {
    const { result } = await renderScenarioFlowController();
    await act(async () => {
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [createReplyActionNode("action-1", "draft")],
        history: "skip",
      }));
    });
    let flushed = false;
    await act(async () => {
      flushed = await result.current.flushScenario();
    });
    expect(flushed).toBe(true);
    expect(mockUpdateScenarioRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        nodes: [createReplyActionNode("action-1", "draft")],
      })
    );
    expect(result.current.saveStatus).toBe("saved");
  });

  it("saves activation with the current graph through the same coordinator", async () => {
    const { result } = await renderScenarioFlowController();
    await act(async () => {
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [createReplyActionNode("action-1", "pending activation edit")],
        history: "skip",
      }));
    });
    await act(async () => {
      await result.current.coordinateActiveScenarioPatch({
        status: "active",
        priority: 7,
      });
    });
    expect(mockUpdateScenarioRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "active",
        priority: 7,
        nodes: [createReplyActionNode("action-1", "pending activation edit")],
      })
    );
  });

  it("serializes active patches without reverting metadata from the previous save", async () => {
    let finishSave!: () => void;
    mockUpdateScenarioRequest.mockImplementationOnce(
      request =>
        new Promise(resolve => {
          finishSave = () =>
            resolve(
              createScenarioDocument({
                ...request,
                _id: request.scenarioId,
                updatedAt: "2026-01-01T00:01:00.000Z",
              })
            );
        })
    );
    const { result } = await renderScenarioFlowController();
    let rename!: Promise<boolean>;
    let priority!: Promise<boolean>;
    act(() => {
      rename = result.current.coordinateActiveScenarioPatch({
        name: "Renamed",
      });
      priority = result.current.coordinateActiveScenarioPatch({ priority: 9 });
    });
    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishSave();
      await Promise.all([rename, priority]);
    });
    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(2);
    expect(mockUpdateScenarioRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: "Renamed",
        priority: 9,
        expectedUpdatedAt: "2026-01-01T00:01:00.000Z",
      })
    );
  });

  it("does not overwrite Flow edits made while waiting for an earlier save", async () => {
    const editableConfig: WhatsAppFlowConfig = {
      templateId: "lead_generation",
      ctaText: "Continue",
      flowNavigationMode: "linear",
      screens: [{ id: "LEAD_FORM", title: "Lead form", fields: [] }],
    };
    mockFetchScenarioById.mockResolvedValueOnce(
      createScenarioDetailResponse(
        createScenarioDocument({
          nodes: [createWhatsAppFlowActionNode(editableConfig)],
        })
      )
    );
    let finishSave!: () => void;
    mockUpdateScenarioRequest.mockImplementationOnce(
      request =>
        new Promise(resolve => {
          finishSave = () =>
            resolve(
              createScenarioDocument({
                ...request,
                _id: request.scenarioId,
                updatedAt: "2026-01-01T00:01:00.000Z",
              })
            );
        })
    );
    const { result } = await renderScenarioFlowController();
    await act(async () => {
      nudgeNodes(result);
    });
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    let preparation!: Promise<unknown>;
    act(() => {
      preparation = result.current.publishManagedWhatsAppFlow({
        nodeId: "flow-action-1",
        sourceId: "source-1",
        editableConfig,
      });
    });
    const rejected = expect(preparation).rejects.toThrow(
      "Flow content changed"
    );
    const changedConfig = { ...editableConfig, ctaText: "Changed during save" };
    await act(async () => {
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [createWhatsAppFlowActionNode(changedConfig)],
        history: "skip",
      }));
    });
    await act(async () => {
      finishSave();
      await rejected;
    });
    expect(result.current.nodes[0].data.actionFlowConfig).toEqual(
      changedConfig
    );
    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(2);
    expect(mockUpdateScenarioRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nodes: [createWhatsAppFlowActionNode(changedConfig)],
      })
    );
  });

  it("allows leaving an unloaded document while rejecting save and activation", async () => {
    mockFetchScenarioById.mockReturnValueOnce(new Promise(() => {}));
    const { result } = await renderScenarioFlowController();
    await expect(result.current.prepareScenarioSelection()).resolves.toBe(true);
    await expect(result.current.flushScenario()).resolves.toBe(false);
    await expect(
      result.current.coordinateActiveScenarioPatch({ status: "active" })
    ).resolves.toBe(false);
    expect(mockUpdateScenarioRequest).not.toHaveBeenCalled();
  });

  it("ignores an old load after A to B to A", async () => {
    let finishLoad!: (
      value: ReturnType<typeof createScenarioDetailResponse>
    ) => void;
    mockFetchScenarioById.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishLoad = resolve;
        })
    );
    const { result, rerender, setScenarios } =
      await renderScenarioFlowController();
    await act(async () => {
      switchScenario(rerender, "scenario-2", "Scenario 2");
    });
    mockFetchScenarioById.mockResolvedValueOnce(
      createScenarioDetailResponse(
        createScenarioDocument({
          nodes: [createReplyActionNode("action-1", "current visit")],
        })
      )
    );
    await act(async () => {
      switchScenario(rerender, "scenario-1", "Scenario 1");
    });
    const summaryUpdates = setScenarios.mock.calls.length;
    await act(async () => {
      finishLoad(
        createScenarioDetailResponse(
          createScenarioDocument({
            nodes: [createReplyActionNode("action-1", "old visit")],
          })
        )
      );
    });
    expect(result.current.nodes[0].data.actionReplyText).toBe("current visit");
    expect(setScenarios).toHaveBeenCalledTimes(summaryUpdates);
    expect(result.current.loadingFlow).toBe(false);
  });

  it("rejects callbacks retained from an earlier scenario visit", async () => {
    const { result, rerender } = await renderScenarioFlowController();
    const oldPatch = result.current.coordinateActiveScenarioPatch;
    const oldFlush = result.current.flushScenario;
    await act(async () => {
      switchScenario(rerender, "scenario-2", "Scenario 2");
    });
    await act(async () => {
      switchScenario(rerender, "scenario-1", "Scenario 1");
    });
    await expect(oldPatch({ status: "active" })).resolves.toBe(false);
    await expect(oldFlush()).resolves.toBe(false);
    expect(mockUpdateScenarioRequest).not.toHaveBeenCalled();
  });

  it("ignores a conflict toast reload retained from an earlier visit", async () => {
    mockUpdateScenarioRequest.mockRejectedValueOnce(
      new ScenarioRequestError({
        message: "Conflict",
        status: 409,
        code: "scenario_updated_conflict",
      })
    );
    const { toast } = sonnerMock();
    const { result, rerender } = await renderScenarioFlowController();
    await act(async () => {
      await result.current.coordinateActiveScenarioPatch({ priority: 2 });
    });
    const reloadOldVisit = toast.error.mock.calls[0][1].action.onClick;
    await act(async () => {
      switchScenario(rerender, "scenario-2", "Scenario 2");
    });
    const loads = mockFetchScenarioById.mock.calls.length;
    await act(async () => {
      reloadOldVisit();
    });
    expect(mockFetchScenarioById).toHaveBeenCalledTimes(loads);
    expect(result.current.loadingFlow).toBe(false);
  });

  it("rejects graph edits while an authoritative document reload is pending", async () => {
    const { result, setScenarios } = await renderScenarioFlowController();
    let finishLoad!: (
      value: ReturnType<typeof createScenarioDetailResponse>
    ) => void;
    mockFetchScenarioById.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishLoad = resolve;
        })
    );
    let refresh!: ReturnType<
      typeof result.current.reconcileGeneratedJobServerUpdate
    >;
    act(() => {
      refresh = result.current.reconcileGeneratedJobServerUpdate({
        generationJobId: "generation-job-1",
        previousScenarioUpdatedAt: "2026-01-01T00:01:00.000Z",
        scenarioUpdatedAt: "2026-01-01T00:02:00.000Z",
        scenarioRevisionConflict: true,
        nodeUpdates: [],
      });
    });
    await act(async () => {
      expect(
        result.current.graphEditor.edit(graph => ({
          ...graph,
          nodes: [createReplyActionNode("action-1", "new local edit")],
          history: "skip",
        }))
      ).toBe(false);
    });
    await act(async () => {
      finishLoad(
        createScenarioDetailResponse(
          createScenarioDocument({
            nodes: [createReplyActionNode("action-1", "older server graph")],
          })
        )
      );
      await expect(refresh).resolves.toEqual({ status: "applied" });
    });
    expect(result.current.nodes[0].data.actionReplyText).toBe(
      "older server graph"
    );
    expect(result.current.saveStatus).toBe("saved");
    expect(setScenarios).toHaveBeenCalledTimes(1);
  });

  it("ignores save completion after the editor unmounts", async () => {
    let finishSave!: (value: ScenarioDocument) => void;
    mockUpdateScenarioRequest.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishSave = resolve;
        })
    );
    const { result, unmount, setScenarios } =
      await renderScenarioFlowController();
    let save!: Promise<boolean>;
    act(() => {
      save = result.current.coordinateActiveScenarioPatch({ priority: 7 });
    });
    unmount();
    await act(async () => {
      finishSave(createScenarioDocument());
      await expect(save).resolves.toBe(false);
    });
    expect(setScenarios).not.toHaveBeenCalled();
  });

  it("keeps save conflict handling unchanged", async () => {
    mockUpdateScenarioRequest.mockRejectedValue(
      new ScenarioRequestError({
        message: "Conflict",
        status: 409,
        code: "scenario_updated_conflict",
      })
    );
    const { toast } = sonnerMock();
    const { result } = await renderScenarioFlowController();

    await act(async () => {
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [createActionNode("action-1", { x: 0, y: 0 })],
        history: "skip",
      }));
    });

    await flushAutosave();

    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      "scenario_updated_conflict",
      expect.objectContaining({
        action: expect.objectContaining({
          label: "reloadScenarioAction",
        }),
      })
    );
  });

  it("commits graph commands synchronously before a save in the same turn", async () => {
    const { result } = await renderScenarioFlowController();
    await act(async () => {
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: [createReplyActionNode("action-1", "first")],
        history: "record",
      }));
      result.current.graphEditor.edit(graph => ({
        ...graph,
        nodes: graph.nodes.map(node => ({
          ...node,
          data: { ...node.data, actionReplyText: "second" },
        })),
        history: "record",
      }));
      expect(await result.current.flushScenario()).toBe(true);
    });
    expect(mockUpdateScenarioRequest).toHaveBeenCalledTimes(1);
    expect(
      mockUpdateScenarioRequest.mock.calls[0][0].nodes[0].data.actionReplyText
    ).toBe("second");
  });

  it("undoes complete graph transactions before an immediate save", async () => {
    const { result } = await renderScenarioFlowController();
    const node = createReplyActionNode("action-1", "first");
    const edge = {
      id: "edge-1",
      source: "action-1",
      target: "action-2",
    } as ScenarioFlowEdge;
    await act(async () => {
      result.current.graphEditor.edit(() => ({
        nodes: [node],
        edges: [edge],
        history: "record",
      }));
      result.current.graphEditor.edit(() => ({
        nodes: [],
        edges: [],
        history: "record",
      }));
      expect(result.current.undoGraphChange()).toBe(true);
      expect(result.current.graphEditor.read()).toMatchObject({
        nodes: [node],
        edges: [edge],
      });
      expect(await result.current.flushScenario()).toBe(true);
    });
    expect(mockUpdateScenarioRequest.mock.calls[0][0]).toMatchObject({
      nodes: [node],
      edges: [edge],
    });
  });

  it("keeps no-op graph commands clean and out of undo history", async () => {
    const { result } = await renderScenarioFlowController();
    act(() => {
      expect(result.current.graphEditor.edit(() => null)).toBe(false);
      expect(
        result.current.graphEditor.edit(graph => ({
          ...graph,
          history: "record",
        }))
      ).toBe(false);
      expect(result.current.undoGraphChange()).toBe(false);
      result.current.finishNodeDrag(null);
    });
    await expect(result.current.flushScenario()).resolves.toBe(true);
    expect(mockUpdateScenarioRequest).not.toHaveBeenCalled();
  });

  it("rejects graph commands retained across A to B to A", async () => {
    const { result, rerender } = await renderScenarioFlowController();
    const oldEditor = result.current.graphEditor;
    const oldFinishDrag = result.current.finishNodeDrag;
    await act(async () => {
      switchScenario(rerender, "scenario-2", "Scenario 2");
    });
    const currentNode = createActionNode("action-1", { x: 9, y: 0 });
    mockFetchScenarioById.mockResolvedValueOnce(
      createScenarioDetailResponse(
        createScenarioDocument({ nodes: [currentNode] })
      )
    );
    await act(async () => {
      switchScenario(rerender, "scenario-1", "Scenario 1");
    });
    const transition = jest.fn(() => ({
      nodes: [createReplyActionNode("action-1", "stale")],
      edges: [],
      history: "record" as const,
    }));
    act(() => {
      expect(oldEditor.edit(transition)).toBe(false);
      oldFinishDrag({ nodeId: "action-1", x: 100, y: null });
    });
    expect(transition).not.toHaveBeenCalled();
    expect(result.current.nodes).toEqual([currentNode]);
    await expect(result.current.flushScenario()).resolves.toBe(true);
    expect(mockUpdateScenarioRequest).not.toHaveBeenCalled();
  });

  it("keeps a completed drag and its alignment snap in one undo step", async () => {
    const node = createActionNode("action-1", { x: 0, y: 0 });
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [node] }
    );
    await act(async () => {
      result.current.onNodesChange([
        {
          id: node.id,
          type: "position",
          position: { x: 37, y: 2 },
          dragging: true,
        },
      ]);
      result.current.onNodesChange([
        {
          id: node.id,
          type: "position",
          position: { x: 37, y: 2 },
          dragging: false,
        },
      ]);
      result.current.finishNodeDrag({ nodeId: node.id, x: 40, y: null });
      expect(await result.current.flushScenario()).toBe(true);
    });
    expect(
      mockUpdateScenarioRequest.mock.calls[0][0].nodes[0].position
    ).toEqual({ x: 40, y: 2 });
    await act(async () => {
      expect(result.current.undoGraphChange()).toBe(true);
      expect(await result.current.flushScenario()).toBe(true);
      expect(result.current.undoGraphChange()).toBe(false);
    });
    expect(
      mockUpdateScenarioRequest.mock.calls[1][0].nodes[0].position
    ).toEqual({ x: 0, y: 0 });
  });

  it("finishes pending drag history without creating a second completion undo", async () => {
    const node = createActionNode("action-1", { x: 0, y: 0 });
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [node] }
    );
    act(() => {
      result.current.onNodesChange([
        {
          id: node.id,
          type: "position",
          position: { x: 40, y: 0 },
          dragging: true,
        },
      ]);
      result.current.finishNodeDrag(null);
      result.current.onNodesChange([
        {
          id: node.id,
          type: "position",
          position: { x: 40, y: 0 },
          dragging: false,
        },
      ]);
      expect(result.current.undoGraphChange()).toBe(true);
      expect(result.current.undoGraphChange()).toBe(false);
    });
    expect(result.current.nodes[0].position).toEqual({ x: 0, y: 0 });
  });

  it("normalizes removed branch edges and saves or undoes the whole graph immediately", async () => {
    const source = createActionNode("action-1", { x: 0, y: 0 });
    const target = {
      ...createActionNode("branch-yes", { x: 100, y: 0 }),
      data: {
        kind: "action" as const,
        actionType: "reply" as const,
        telegramBranchPayload: "yes",
        telegramBranchLabel: "Yes",
      },
    };
    const edge = {
      id: "edge-yes",
      source: source.id,
      target: target.id,
    } as ScenarioFlowEdge;
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [source, target], edges: [edge] }
    );
    await act(async () => {
      result.current.onEdgesChange([{ id: edge.id, type: "remove" }]);
      expect(await result.current.flushScenario()).toBe(true);
    });
    expect(mockUpdateScenarioRequest.mock.calls[0][0].edges).toEqual([]);
    expect(
      mockUpdateScenarioRequest.mock.calls[0][0].nodes[1].data
        .telegramBranchPayload
    ).toBeUndefined();
    await act(async () => {
      expect(result.current.undoGraphChange()).toBe(true);
      expect(await result.current.flushScenario()).toBe(true);
    });
    expect(mockUpdateScenarioRequest.mock.calls[1][0].edges).toHaveLength(1);
    expect(
      mockUpdateScenarioRequest.mock.calls[1][0].nodes[1].data
        .telegramBranchPayload
    ).toBe("yes");
  });

  it("tracks keyboard node selection outside the graph and deletes the selected node", async () => {
    const node = createActionNode("action-1", { x: 0, y: 0 });
    const { result } = await renderScenarioFlowController(
      {},
      { nodes: [node] }
    );
    act(() => {
      result.current.onNodesChange([
        { id: node.id, type: "select", selected: true },
      ]);
    });
    expect(result.current.canvasSelection.nodeIds.has(node.id)).toBe(true);
    expect(result.current.nodes[0].selected).toBeUndefined();
    await expect(result.current.flushScenario()).resolves.toBe(true);
    expect(mockUpdateScenarioRequest).not.toHaveBeenCalled();
    act(() => {
      expect(result.current.undoGraphChange()).toBe(false);
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Delete",
          bubbles: true,
          cancelable: true,
        })
      );
    });
    expect(result.current.nodes).toEqual([]);
    expect(result.current.canvasSelection.nodeIds.size).toBe(0);
    act(() => expect(result.current.undoGraphChange()).toBe(true));
    expect(result.current.nodes).toEqual([node]);
    expect(result.current.canvasSelection.nodeIds.size).toBe(0);
  });

  it("gives selected edges delete priority over a selected node without saving selection", async () => {
    const source = createActionNode("action-1", { x: 0, y: 0 });
    const target = createActionNode("action-2", { x: 100, y: 0 });
    const edge = {
      id: "edge-1",
      source: source.id,
      target: target.id,
    } as ScenarioFlowEdge;
    const { result, rerender } = await renderScenarioFlowController(
      {},
      { nodes: [source, target], edges: [edge] }
    );
    act(() => {
      result.current.onNodesChange([
        { id: source.id, type: "select", selected: true },
      ]);
      result.current.onEdgesChange([
        { id: edge.id, type: "select", selected: true },
      ]);
    });
    expect(result.current.canvasSelection.edgeIds.has(edge.id)).toBe(true);
    expect(result.current.edges[0].selected).toBeUndefined();
    await expect(result.current.flushScenario()).resolves.toBe(true);
    expect(mockUpdateScenarioRequest).not.toHaveBeenCalled();
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Delete",
          bubbles: true,
          cancelable: true,
        })
      )
    );
    expect(result.current.nodes).toEqual([source, target]);
    expect(result.current.edges).toEqual([]);
    expect(result.current.canvasSelection.edgeIds.size).toBe(0);
    await act(async () => {
      switchScenario(rerender, "scenario-2", "Scenario 2");
    });
    expect(result.current.canvasSelection.nodeIds.size).toBe(0);
    expect(result.current.canvasSelection.edgeIds.size).toBe(0);
  });
});
