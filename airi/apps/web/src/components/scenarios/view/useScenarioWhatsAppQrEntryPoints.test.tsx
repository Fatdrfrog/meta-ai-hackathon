/**
 * @jest-environment jsdom
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { useScenarioWhatsAppQrEntryPoints } from "./useScenarioWhatsAppQrEntryPoints";

const mockFetchEntryPoints = jest.fn();
const mockFetchSummaries = jest.fn();
const mockPostAssignmentCommand = jest.fn();
const mockOnSelectScenario = jest.fn();
const mockTranslate = (
  key: string,
  values?: Record<string, string | number | Date>
) => (values?.diagnostic ? `${key}: ${values.diagnostic}` : key);

jest.mock("next-intl", () => ({
  useTranslations: () => mockTranslate,
}));

jest.mock("@/lib/whatsapp/qr-entry-points/client", () => ({
  fetchWhatsAppQrEntryPoints: (...args: unknown[]) =>
    mockFetchEntryPoints(...args),
  fetchWhatsAppQrScenarioSummaries: (...args: unknown[]) =>
    mockFetchSummaries(...args),
  postWhatsAppQrAssignmentCommand: (...args: unknown[]) =>
    mockPostAssignmentCommand(...args),
  WhatsAppQrClientError: class WhatsAppQrClientError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code?: string,
      readonly operationId?: string,
      readonly currentAssignment?: unknown
    ) {
      super(message);
    }
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => {
    resolve = next;
  });
  return { promise, resolve };
}

function summary(entryPointId: string, placementName: string) {
  return {
    entryPointId,
    placementName,
    sourceId: "source-1",
    status: "ACTIVE",
    hasCurrentCode: true,
    readiness: "ready" as const,
    reconcilePending: false,
    version: 3,
  };
}

function createAssignmentHost(currentEntryPointId: string | null = null) {
  return {
    readEntryPointId: jest.fn(() => currentEntryPointId),
    readSnapshot: jest.fn(() => ({
      ownershipKey: "scenario-1:node-1:2026-08-10T10:00:00.000Z",
      scenarioId: "scenario-1",
      nodeId: "node-1",
      expectedUpdatedAt: "2026-08-10T10:00:00.000Z",
      currentEntryPointId,
    })),
    adopt: jest.fn(() => true),
  };
}

const sources = [{ id: "source-1", label: "WhatsApp" }];

describe("useScenarioWhatsAppQrEntryPoints", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchEntryPoints.mockResolvedValue({
      ok: true,
      data: { items: [], nextCursor: null },
    });
    mockFetchSummaries.mockResolvedValue({
      ok: true,
      data: { summaries: {} },
    });
  });

  it("does not commit a stale summary response after the Scenario changes", async () => {
    const stale = deferred<unknown>();
    mockFetchSummaries
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({
        ok: true,
        data: {
          summaries: { "node-1": summary("entry-2", "Second") },
        },
      });
    const assignmentHost = createAssignmentHost();
    const { result, rerender } = renderHook(
      ({ scenarioId }) =>
        useScenarioWhatsAppQrEntryPoints({
          workspaceId: "workspace-1",
          scenarioId,
          scenarioName: scenarioId,
          whatsAppSources: sources,
          assignmentHost,
          onSelectScenario: mockOnSelectScenario,
        }),
      { initialProps: { scenarioId: "scenario-1" } }
    );

    await waitFor(() => expect(mockFetchSummaries).toHaveBeenCalledTimes(1));
    rerender({ scenarioId: "scenario-2" });
    await waitFor(() =>
      expect(result.current.summariesByNodeId.get("node-1")?.entryPointId).toBe(
        "entry-2"
      )
    );

    await act(async () => {
      stale.resolve({
        ok: true,
        data: {
          summaries: { "node-1": summary("entry-stale", "Stale") },
        },
      });
      await stale.promise;
    });

    expect(result.current.summariesByNodeId.get("node-1")?.entryPointId).toBe(
      "entry-2"
    );
  });

  it("projects the persisted assignment into the trigger picker", async () => {
    mockFetchSummaries.mockResolvedValue({
      ok: true,
      data: {
        summaries: { "node-1": summary("entry-1", "Front door") },
      },
    });
    const assignmentHost = createAssignmentHost("entry-1");
    const { result } = renderHook(() =>
      useScenarioWhatsAppQrEntryPoints({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        scenarioName: "Welcome",
        whatsAppSources: sources,
        assignmentHost,
        onSelectScenario: mockOnSelectScenario,
      })
    );

    await waitFor(() =>
      expect(result.current.getPickerProps("node-1").selectionResolved).toBe(
        true
      )
    );

    expect(result.current.getPickerProps("node-1")).toMatchObject({
      selected: {
        entryPointId: "entry-1",
        placementName: "Front door",
      },
      selectedEntryPointId: "entry-1",
      targetScenarioId: "scenario-1",
      targetNodeId: "node-1",
      targetScenarioName: "Welcome",
      managerHref: "/panel/w/workspace-1/messengers/whatsapp-qr",
      sourceLabels: { "source-1": "WhatsApp" },
    });
  });

  it("loads Manager options through the current list client", async () => {
    const assignmentHost = createAssignmentHost();
    const { result } = renderHook(() =>
      useScenarioWhatsAppQrEntryPoints({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        scenarioName: "Welcome",
        whatsAppSources: sources,
        assignmentHost,
        onSelectScenario: mockOnSelectScenario,
      })
    );
    await waitFor(() =>
      expect(result.current.getPickerProps("node-1").selectionResolved).toBe(
        true
      )
    );

    await expect(
      result.current.getPickerProps("node-1").loadOptions({
        query: "front",
        cursor: "cursor-1",
      })
    ).resolves.toEqual({ items: [], nextCursor: null });
    expect(mockFetchEntryPoints).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      query: "front",
      cursor: "cursor-1",
      limit: 20,
    });
  });

  it("assigns a ready Manager entry through the transactional host", async () => {
    const assignmentHost = createAssignmentHost();
    mockPostAssignmentCommand.mockResolvedValue({
      ok: true,
      data: {
        entryPointId: "entry-1",
        entryPointVersion: 4,
        assignment: {
          scenarioId: "scenario-1",
          nodeId: "node-1",
          scenarioName: "Welcome",
          scenarioStatus: "draft",
          scenarioUpdatedAt: "2026-08-10T10:00:01.000Z",
        },
        targetScenario: {
          scenarioId: "scenario-1",
          nodeId: "node-1",
          updatedAt: "2026-08-10T10:00:01.000Z",
          previousEntryPointId: null,
        },
      },
    });
    const { result } = renderHook(() =>
      useScenarioWhatsAppQrEntryPoints({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        scenarioName: "Welcome",
        whatsAppSources: sources,
        assignmentHost,
        onSelectScenario: mockOnSelectScenario,
      })
    );
    await waitFor(() =>
      expect(result.current.getPickerProps("node-1").selectionResolved).toBe(
        true
      )
    );

    await act(async () => {
      await result.current.getPickerProps("node-1").onAssign({
        entryPointId: "entry-1",
        placementName: "Front door",
        sourceId: "source-1",
        status: "ACTIVE",
        version: 3,
        updatedAt: "2026-08-10T09:00:00.000Z",
        readiness: "ready",
        currentCode: {
          codeId: "code-1",
          placementBindingState: "CURRENT",
          routingState: "ENABLED",
          providerState: "ACTIVE",
        },
        reconcilePending: false,
        assignment: null,
      });
    });

    expect(mockPostAssignmentCommand).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      body: {
        command: "assign",
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        expectedEntryPointVersion: 3,
        target: {
          scenarioId: "scenario-1",
          nodeId: "node-1",
          expectedUpdatedAt: "2026-08-10T10:00:00.000Z",
          expectedCurrentEntryPointId: null,
        },
        acknowledgeMove: false,
        acknowledgeReplacement: false,
      },
    });
    expect(assignmentHost.adopt).toHaveBeenCalledTimes(1);
  });

  it("reads no assignments while the graph has no QR trigger", async () => {
    const assignmentHost = createAssignmentHost();
    const { result } = renderHook(() =>
      useScenarioWhatsAppQrEntryPoints({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        scenarioName: "Welcome",
        whatsAppSources: sources,
        assignmentHost,
        onSelectScenario: mockOnSelectScenario,
        hasWhatsAppQrTrigger: false,
      })
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockFetchSummaries).not.toHaveBeenCalled();
    expect(result.current.summariesByNodeId.size).toBe(0);
    const picker = result.current.getPickerProps("node-1");
    expect(picker).toMatchObject({ selectionResolved: true, loading: false });
    expect(picker.disabledReason).toBeUndefined();
  });

  it("reads assignments once a QR trigger appears, loading until they arrive", async () => {
    const pending = deferred<unknown>();
    mockFetchSummaries.mockReturnValueOnce(pending.promise);
    const assignmentHost = createAssignmentHost("entry-1");
    const { result, rerender } = renderHook(
      ({ hasWhatsAppQrTrigger }) =>
        useScenarioWhatsAppQrEntryPoints({
          workspaceId: "workspace-1",
          scenarioId: "scenario-1",
          scenarioName: "Welcome",
          whatsAppSources: sources,
          assignmentHost,
          onSelectScenario: mockOnSelectScenario,
          hasWhatsAppQrTrigger,
        }),
      { initialProps: { hasWhatsAppQrTrigger: false } }
    );

    rerender({ hasWhatsAppQrTrigger: true });
    // Loading, never a conflict between the bound entry and no assignment.
    expect(result.current.getPickerProps("node-1")).toMatchObject({
      loading: true,
      selectionResolved: false,
    });
    expect(
      result.current.getPickerProps("node-1").disabledReason
    ).toBeUndefined();
    await waitFor(() => expect(mockFetchSummaries).toHaveBeenCalledTimes(1));

    await act(async () => {
      pending.resolve({
        ok: true,
        data: { summaries: { "node-1": summary("entry-1", "Front door") } },
      });
      await pending.promise;
    });
    expect(result.current.getPickerProps("node-1")).toMatchObject({
      loading: false,
      selectionResolved: true,
      selected: { entryPointId: "entry-1" },
    });
  });
});
