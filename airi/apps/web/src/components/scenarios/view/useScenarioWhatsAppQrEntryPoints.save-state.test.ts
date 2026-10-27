/**
 * @jest-environment jsdom
 */

import {
  fetchScenarioById,
  updateScenarioRequest,
} from "@/lib/scenarios/client/crud";
import { fetchWhatsAppQrScenarioSummaries } from "@/lib/whatsapp/qr-entry-points/client";
import { act, renderHook } from "@testing-library/react";
import { useMemo } from "react";
import type { ScenarioDocument } from "../types";
import { useScenarioFlowController } from "./use-scenario-flow-controller";
import { useScenarioWhatsAppQrEntryPoints } from "./useScenarioWhatsAppQrEntryPoints";
import { scenarioDocument } from "./scenario-controller-test-utils";

const mockTranslate = (key: string) => key;

jest.mock("next-intl", () => ({ useTranslations: () => mockTranslate }));
jest.mock("sonner", () => ({
  toast: { error: jest.fn(), warning: jest.fn() },
}));
jest.mock("@/lib/scenarios/client/crud", () => ({
  ...jest.requireActual("@/lib/scenarios/client/crud"),
  fetchScenarioById: jest.fn(),
  updateScenarioRequest: jest.fn(),
}));
jest.mock("@/lib/whatsapp/flows/client", () => ({
  attachWhatsAppFlowProviderReference: jest.fn(),
  provisionWhatsAppFlow: jest.fn(),
}));
jest.mock("@/lib/whatsapp/qr-entry-points/client", () => ({
  fetchWhatsAppQrEntryPoints: jest.fn(),
  fetchWhatsAppQrScenarioSummaries: jest.fn(),
  postWhatsAppQrAssignmentCommand: jest.fn(),
  WhatsAppQrClientError: class WhatsAppQrClientError extends Error {},
}));
jest.mock("../scenario-editor-chunks", () =>
  jest
    .requireActual("./scenario-controller-test-utils")
    .scenarioEditorChunksMock()
);

const mockFetchScenarioById = jest.mocked(fetchScenarioById);
const mockUpdateScenarioRequest = jest.mocked(updateScenarioRequest);
const mockFetchSummaries = jest.mocked(fetchWhatsAppQrScenarioSummaries);

const REVISION = "2026-01-01T00:00:00.000Z";
const SAVED_REVISION = "2026-01-01T00:05:00.000Z";

function scenario(updatedAt = REVISION): ScenarioDocument {
  return scenarioDocument("qr-scenario", {
    name: "QR",
    updatedAt,
    nodes: [
      {
        id: "qr-1",
        position: { x: 0, y: 0 },
        data: {
          kind: "trigger",
          triggerConfig: {
            entryPointType: "whatsapp_qr",
            entryPointId: "entry-1",
          },
        },
      },
      {
        id: "reply-1",
        position: { x: 240, y: 0 },
        data: { kind: "action", actionType: "reply", actionReplyText: "Hi" },
      },
    ] as ScenarioDocument["nodes"],
  });
}

const setEntryPriorityInput = jest.fn();
const setScenarios = jest.fn();
const onScenarioDocumentConfirmed = jest.fn();
const onSelectScenario = jest.fn();
const sources = [{ id: "source-1", label: "WhatsApp" }];

/** The editor with a QR picker read while rendering, as the canvas does. */
function useEditorWithQrPicker({ renders }: { renders: number }) {
  const flow = useScenarioFlowController({
    workspaceId: "workspace-1",
    activeScenarioId: "qr-scenario",
    activeScenario: {
      _id: "qr-scenario",
      name: "QR",
      description: "",
      status: "draft",
      mode: "conversation",
      timezone: null,
      priority: 0,
      matchingRole: "default",
      entryPolicy: "repeatable",
      nodeCount: 2,
      edgeCount: 0,
      createdAt: REVISION,
      updatedAt: REVISION,
    },
    activeScenarioName: "QR",
    activeScenarioDescription: "",
    activeScenarioStatus: "draft",
    entryPriorityInput: "0",
    setEntryPriorityInput,
    setScenarios,
    onScenarioDocumentConfirmed,
    t: mockTranslate,
  });
  const qr = useScenarioWhatsAppQrEntryPoints({
    workspaceId: "workspace-1",
    scenarioId: "qr-scenario",
    scenarioName: "QR",
    whatsAppSources: sources,
    assignmentHost: flow.whatsAppQrAssignmentHost,
    onSelectScenario,
  });
  const { getPickerProps } = qr;
  const picker = useMemo(() => getPickerProps("qr-1"), [getPickerProps]);
  return { flow, qr, picker, renders };
}

async function settle() {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
}

describe("QR picker save state", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchScenarioById.mockResolvedValue({
      scenario: scenario(),
      metadata: { linkedConditionParentCountByNodeId: {} },
    } as never);
    mockFetchSummaries.mockResolvedValue({
      ok: true,
      data: {
        summaries: {
          "qr-1": {
            entryPointId: "entry-1",
            placementName: "Front door",
            status: "ACTIVE",
            hasCurrentCode: true,
            readiness: "ready",
            reconcilePending: false,
            version: 1,
          },
        },
      },
    } as never);
  });

  it("keeps the picker's props across renders that change nothing it shows", async () => {
    const { result, rerender } = renderHook(useEditorWithQrPicker, {
      initialProps: { renders: 0 },
    });
    await settle();
    const { getPickerProps } = result.current.qr;
    const host = result.current.flow.whatsAppQrAssignmentHost;

    rerender({ renders: 1 });

    expect(result.current.qr.getPickerProps).toBe(getPickerProps);
    expect(result.current.flow.whatsAppQrAssignmentHost).toBe(host);
  });

  it("follows the save state while the canvas reads it during render", async () => {
    let finishSave!: (value: ScenarioDocument) => void;
    mockUpdateScenarioRequest.mockReturnValue(
      new Promise(resolve => {
        finishSave = resolve;
      }) as never
    );
    const { result } = renderHook(useEditorWithQrPicker, {
      initialProps: { renders: 0 },
    });
    await settle();
    expect(result.current.flow.loadingFlow).toBe(false);
    expect(result.current.picker.selectedEntryPointId).toBe("entry-1");
    expect(result.current.picker.disabledReason).toBeUndefined();

    act(() => {
      result.current.flow.graphEditor.edit(graph => ({
        ...graph,
        nodes: graph.nodes.map(node =>
          node.id === "reply-1"
            ? { ...node, data: { ...node.data, actionReplyText: "Hello" } }
            : node
        ),
        history: "record",
      }));
    });
    expect(result.current.picker.disabledReason).toBe("wait-for-save");

    let flushed!: Promise<boolean>;
    act(() => {
      flushed = result.current.flow.flushScenario();
    });
    expect(result.current.flow.saveStatus).toBe("saving");
    expect(result.current.picker.disabledReason).toBe("wait-for-save");

    await act(async () => {
      finishSave({ ...scenario(SAVED_REVISION) });
      await flushed;
    });
    expect(result.current.flow.saveStatus).toBe("saved");
    expect(result.current.picker.disabledReason).toBeUndefined();
  });
});
