/**
 * @jest-environment jsdom
 */

import type { ScenarioDocument } from "@/components/scenarios/types";
import { convertLegacyActionRoutingRequest } from "@/lib/scenarios/client";
import { act, renderHook } from "@testing-library/react";
import {
  type ConvertLegacyActionRoutingInput,
  useLegacyRoutingConversion,
} from "./use-legacy-routing-conversion";

jest.mock("@/lib/scenarios/client", () => ({
  convertLegacyActionRoutingRequest: jest.fn(),
}));

const mockConvertLegacyActionRoutingRequest =
  convertLegacyActionRoutingRequest as jest.MockedFunction<
    typeof convertLegacyActionRoutingRequest
  >;

function scenarioDocument(): ScenarioDocument {
  return {
    _id: "scenario-1",
    name: "Scenario",
    description: "",
    status: "draft",
    mode: "conversation",
    timezone: "UTC",
    priority: 0,
    presetId: null,
    presetVersion: null,
    segmentKey: null,
    matchingRole: "default",
    entryPolicy: "repeatable",
    linkedParentScenarioIds: [],
    graphSchemaVersion: 1,
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
  };
}

type ConversionState = {
  scenarioId: string | null;
  expectedUpdatedAt: string | null;
  sessionKey: string;
  ownershipKey: string;
  isDirty: boolean;
  hasConflict: boolean;
};

function createConversionHost(readState: () => ConversionState) {
  return {
    readState: jest.fn(readState),
    cancelPendingAutosave: jest.fn(),
    saveScenario: jest.fn(async () => true),
    applyActionRoutingPatch: jest.fn(() => true),
    adoptConvertedScenario: jest.fn(() => true),
    onConflict: jest.fn(),
    onError: jest.fn(),
    onWarning: jest.fn(),
    onStatusChange: jest.fn(),
    onConversionAbandoned: jest.fn(),
  };
}

function scenarioRequestError(status: number, code: string) {
  return Object.assign(new Error("Conversion failed"), {
    name: "ScenarioRequestError",
    status,
    code,
    codes: [],
    nodeIds: [],
  });
}

function noReplyEdit(timeoutMinutes: number): ConvertLegacyActionRoutingInput {
  return {
    sourceActionNodeId: "action-1",
    sourceNodeId: "condition-1",
    sourceKind: "post_action_condition",
    patch: {
      actionOutcomes: {
        version: 1,
        noReply: { enabled: true, timeoutMinutes },
      },
    },
  };
}

describe("useLegacyRoutingConversion", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ["another scenario", "scenario-2", "flow-2"],
    ["a new visit to the same scenario", "scenario-1", "flow-3"],
  ])(
    "does not start a queued edit in %s",
    async (_label, scenarioId, sessionKey) => {
      const converted = {
        scenario: scenarioDocument(),
        metadata: { linkedConditionParentCountByNodeId: {} },
      };
      let resolveConversion!: (value: typeof converted) => void;
      mockConvertLegacyActionRoutingRequest
        .mockResolvedValue(converted)
        .mockImplementationOnce(
          () =>
            new Promise(resolve => {
              resolveConversion = resolve;
            })
        );
      let state: ConversionState = {
        scenarioId: "scenario-1",
        expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
        sessionKey: "flow-1",
        ownershipKey: "flow-1:graph-0",
        isDirty: false,
        hasConflict: false,
      };
      const host = createConversionHost(() => state);
      const { result } = renderHook(() =>
        useLegacyRoutingConversion({ workspaceId: "workspace-1", host })
      );
      let edits!: Promise<boolean>[];
      await act(async () => {
        edits = [
          result.current(noReplyEdit(1440)),
          result.current(noReplyEdit(2880)),
        ];
        await Promise.resolve();
      });
      expect(mockConvertLegacyActionRoutingRequest).toHaveBeenCalledTimes(1);

      state = {
        ...state,
        scenarioId,
        sessionKey,
        ownershipKey: `${sessionKey}:graph-0`,
      };
      await act(async () => {
        resolveConversion(converted);
        await expect(Promise.all(edits)).resolves.toEqual([false, false]);
      });

      expect(mockConvertLegacyActionRoutingRequest).toHaveBeenCalledTimes(1);
      expect(host.cancelPendingAutosave).toHaveBeenCalledTimes(1);
      expect(host.adoptConvertedScenario).not.toHaveBeenCalled();
      expect(host.applyActionRoutingPatch).not.toHaveBeenCalled();
      expect(host.onConversionAbandoned).toHaveBeenCalledTimes(1);
    }
  );

  it("saves a same-session local edit before converting a queued edit", async () => {
    const converted = {
      scenario: scenarioDocument(),
      metadata: { linkedConditionParentCountByNodeId: {} },
    };
    let resolveConversion!: (value: typeof converted) => void;
    mockConvertLegacyActionRoutingRequest
      .mockResolvedValue(converted)
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveConversion = resolve;
          })
      );
    let state: ConversionState = {
      scenarioId: "scenario-1",
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
      sessionKey: "flow-1",
      ownershipKey: "flow-1:graph-0",
      isDirty: false,
      hasConflict: false,
    };
    const host = createConversionHost(() => state);
    host.saveScenario.mockImplementation(async () => {
      state = {
        ...state,
        expectedUpdatedAt: "2026-01-01T00:02:00.000Z",
        isDirty: false,
      };
      return true;
    });
    const { result } = renderHook(() =>
      useLegacyRoutingConversion({ workspaceId: "workspace-1", host })
    );
    let edits!: Promise<boolean>[];
    await act(async () => {
      edits = [
        result.current(noReplyEdit(1440)),
        result.current(noReplyEdit(2880)),
      ];
      await Promise.resolve();
    });

    state = { ...state, ownershipKey: "flow-1:graph-1", isDirty: true };
    await act(async () => {
      resolveConversion(converted);
      await expect(Promise.all(edits)).resolves.toEqual([false, true]);
    });

    expect(host.onConversionAbandoned).toHaveBeenCalledTimes(1);
    expect(host.saveScenario).toHaveBeenCalledTimes(1);
    expect(mockConvertLegacyActionRoutingRequest).toHaveBeenCalledTimes(2);
    expect(mockConvertLegacyActionRoutingRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedUpdatedAt: "2026-01-01T00:02:00.000Z",
        actionOutcomes: noReplyEdit(2880).patch.actionOutcomes,
      })
    );
    expect(host.saveScenario.mock.invocationCallOrder[0]).toBeLessThan(
      mockConvertLegacyActionRoutingRequest.mock.invocationCallOrder[1] ?? 0
    );
    expect(host.adoptConvertedScenario).toHaveBeenCalledTimes(1);
    expect(host.adoptConvertedScenario).toHaveBeenCalledWith(
      "scenario-1",
      converted.scenario,
      "action-1",
      converted.metadata,
      "flow-1:graph-1"
    );
    expect(host.onError).not.toHaveBeenCalled();
  });

  it("drops a queued edit when the session changes during its pre-conversion save", async () => {
    const converted = {
      scenario: scenarioDocument(),
      metadata: { linkedConditionParentCountByNodeId: {} },
    };
    let resolveConversion!: (value: typeof converted) => void;
    mockConvertLegacyActionRoutingRequest
      .mockResolvedValue(converted)
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveConversion = resolve;
          })
      );
    let state: ConversionState = {
      scenarioId: "scenario-1",
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
      sessionKey: "flow-1",
      ownershipKey: "flow-1:graph-0",
      isDirty: false,
      hasConflict: false,
    };
    const host = createConversionHost(() => state);
    let resolveSave!: (saved: boolean) => void;
    host.saveScenario.mockImplementation(
      () =>
        new Promise<boolean>(resolve => {
          resolveSave = resolve;
        })
    );
    const { result } = renderHook(() =>
      useLegacyRoutingConversion({ workspaceId: "workspace-1", host })
    );
    let edits!: Promise<boolean>[];
    await act(async () => {
      edits = [
        result.current(noReplyEdit(1440)),
        result.current(noReplyEdit(2880)),
      ];
      await Promise.resolve();
    });

    state = { ...state, ownershipKey: "flow-1:graph-1", isDirty: true };
    await act(async () => {
      resolveConversion(converted);
      await expect(edits[0]).resolves.toBe(false);
    });
    expect(host.saveScenario).toHaveBeenCalledTimes(1);

    state = {
      ...state,
      sessionKey: "flow-2",
      ownershipKey: "flow-2:graph-0",
      expectedUpdatedAt: "2026-01-01T00:02:00.000Z",
      isDirty: false,
    };
    await act(async () => {
      resolveSave(true);
      await expect(edits[1]).resolves.toBe(false);
    });

    expect(mockConvertLegacyActionRoutingRequest).toHaveBeenCalledTimes(1);
    expect(host.adoptConvertedScenario).not.toHaveBeenCalled();
    expect(host.onError).not.toHaveBeenCalled();
    expect(host.onConflict).not.toHaveBeenCalled();
  });

  it("applies queued timer edits in order after converting their source once", async () => {
    const converted = {
      scenario: scenarioDocument(),
      metadata: { linkedConditionParentCountByNodeId: {} },
    };
    mockConvertLegacyActionRoutingRequest.mockResolvedValue(converted);
    let state: ConversionState = {
      scenarioId: "scenario-1",
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
      sessionKey: "flow-1",
      ownershipKey: "flow-1:graph-0",
      isDirty: false,
      hasConflict: false,
    };
    let graphVersion = 0;
    const host = createConversionHost(() => state);
    host.adoptConvertedScenario.mockImplementation(() => {
      state = { ...state, expectedUpdatedAt: converted.scenario.updatedAt };
      return true;
    });
    host.applyActionRoutingPatch.mockImplementation(() => {
      state = {
        ...state,
        ownershipKey: `flow-1:graph-${++graphVersion}`,
        isDirty: true,
      };
      return true;
    });
    const { result } = renderHook(() =>
      useLegacyRoutingConversion({ workspaceId: "workspace-1", host })
    );

    await act(async () => {
      await expect(
        Promise.all([
          result.current(noReplyEdit(1440)),
          result.current(noReplyEdit(2880)),
          result.current(noReplyEdit(4320)),
        ])
      ).resolves.toEqual([true, true, true]);
    });

    expect(mockConvertLegacyActionRoutingRequest).toHaveBeenCalledTimes(1);
    expect(mockConvertLegacyActionRoutingRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioId: "scenario-1",
        actionOutcomes: noReplyEdit(1440).patch.actionOutcomes,
      })
    );
    expect(host.applyActionRoutingPatch.mock.calls).toEqual([
      ["action-1", noReplyEdit(2880).patch],
      ["action-1", noReplyEdit(4320).patch],
    ]);
  });

  it("adopts a committed conversion as saved and surfaces its timer warning", async () => {
    const scenario = scenarioDocument();
    const warning = {
      code: "legacy_action_routing_timer_replan_failed" as const,
      message: "Legacy routing committed, but a pending timer needs retry.",
      affectedConversationIds: ["conversation-1"],
    };
    mockConvertLegacyActionRoutingRequest.mockResolvedValue({
      scenario,
      metadata: {
        linkedConditionParentCountByNodeId: {},
        warnings: [warning],
      },
    } as never);
    const onWarning = jest.fn();
    const host = {
      readState: jest.fn(() => ({
        scenarioId: "scenario-1",
        expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
        sessionKey: "flow-1",
        ownershipKey: "flow-1:graph-0",
        isDirty: false,
        hasConflict: false,
      })),
      cancelPendingAutosave: jest.fn(),
      saveScenario: jest.fn(async () => true),
      applyActionRoutingPatch: jest.fn(() => true),
      adoptConvertedScenario: jest.fn(() => true),
      onConflict: jest.fn(),
      onError: jest.fn(),
      onWarning,
      onStatusChange: jest.fn(),
      onConversionAbandoned: jest.fn(),
    };
    const { result } = renderHook(() =>
      useLegacyRoutingConversion({ workspaceId: "workspace-1", host })
    );

    await act(async () => {
      await result.current({
        sourceActionNodeId: "action-1",
        sourceNodeId: "condition-1",
        sourceKind: "post_action_condition",
        patch: {},
      });
    });

    expect(host.adoptConvertedScenario).toHaveBeenCalledWith(
      "scenario-1",
      scenario,
      "action-1",
      expect.objectContaining({ warnings: [warning] }),
      "flow-1:graph-0"
    );
    expect(host.onStatusChange.mock.calls.map(([status]) => status)).toEqual([
      "saving",
      "saved",
    ]);
    expect(onWarning).toHaveBeenCalledWith(warning);
    expect(
      host.adoptConvertedScenario.mock.invocationCallOrder[0]
    ).toBeLessThan(onWarning.mock.invocationCallOrder[0] ?? 0);
    expect(host.onError).not.toHaveBeenCalled();
  });

  it("does not publish a stale conversion result after its scenario loses ownership", async () => {
    const warning = {
      code: "legacy_action_routing_timer_replan_failed" as const,
      message: "Pending timer needs retry.",
      affectedConversationIds: ["conversation-1"],
    };
    let resolveConversion!: (value: {
      scenario: ScenarioDocument;
      metadata: {
        linkedConditionParentCountByNodeId: Record<string, number>;
        warnings: (typeof warning)[];
      };
    }) => void;
    mockConvertLegacyActionRoutingRequest.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveConversion = resolve;
        })
    );
    let activeScenarioId = "scenario-1";
    let expectedUpdatedAt = "2026-01-01T00:00:00.000Z";
    let sessionKey = "flow-1";
    let ownershipKey = "flow-1:graph-0";
    const host = {
      readState: jest.fn(() => ({
        scenarioId: activeScenarioId,
        expectedUpdatedAt,
        sessionKey,
        ownershipKey,
        isDirty: false,
        hasConflict: false,
      })),
      cancelPendingAutosave: jest.fn(),
      saveScenario: jest.fn(async () => true),
      applyActionRoutingPatch: jest.fn(() => true),
      adoptConvertedScenario: jest.fn(
        (scenarioId: string) => scenarioId === activeScenarioId
      ),
      onConflict: jest.fn(),
      onError: jest.fn(),
      onWarning: jest.fn(),
      onStatusChange: jest.fn(),
      onConversionAbandoned: jest.fn(),
    };
    const { result } = renderHook(() =>
      useLegacyRoutingConversion({ workspaceId: "workspace-1", host })
    );

    let firstConversion!: Promise<boolean>;
    act(() => {
      firstConversion = result.current({
        sourceActionNodeId: "action-1",
        sourceNodeId: "condition-1",
        sourceKind: "post_action_condition",
        patch: {},
      });
    });
    await act(async () => {
      await Promise.resolve();
    });
    activeScenarioId = "scenario-2";
    sessionKey = "flow-2";
    ownershipKey = "flow-2:graph-0";
    await act(async () => {
      resolveConversion({
        scenario: scenarioDocument(),
        metadata: {
          linkedConditionParentCountByNodeId: {},
          warnings: [warning],
        },
      });
      await expect(firstConversion).resolves.toBe(false);
    });

    expect(host.onStatusChange.mock.calls.map(([status]) => status)).toEqual([
      "saving",
    ]);
    expect(host.onConversionAbandoned).toHaveBeenCalledTimes(1);
    expect(host.onWarning).not.toHaveBeenCalled();

    activeScenarioId = "scenario-1";
    expectedUpdatedAt = "2026-01-01T00:01:00.000Z";
    sessionKey = "flow-3";
    ownershipKey = "flow-3:graph-0";
    host.adoptConvertedScenario.mockReturnValueOnce(true);
    mockConvertLegacyActionRoutingRequest.mockResolvedValueOnce({
      scenario: scenarioDocument(),
      metadata: { linkedConditionParentCountByNodeId: {} },
    });
    await act(async () => {
      await result.current({
        sourceActionNodeId: "action-1",
        sourceNodeId: "condition-1",
        sourceKind: "post_action_condition",
        patch: {},
      });
    });

    expect(mockConvertLegacyActionRoutingRequest).toHaveBeenCalledTimes(2);
    expect(host.applyActionRoutingPatch).not.toHaveBeenCalled();
  });

  it("rejects an ABA response after the reselected scenario gains local edits", async () => {
    const warning = {
      code: "legacy_action_routing_timer_replan_failed" as const,
      message: "Pending timer needs retry.",
      affectedConversationIds: ["conversation-1"],
    };
    let resolveConversion!: (value: {
      scenario: ScenarioDocument;
      metadata: {
        linkedConditionParentCountByNodeId: Record<string, number>;
        warnings: (typeof warning)[];
      };
    }) => void;
    mockConvertLegacyActionRoutingRequest.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveConversion = resolve;
        })
    );
    let sessionKey = "flow-1";
    let ownershipKey = "flow-1:graph-0";
    let expectedUpdatedAt = "2026-01-01T00:00:00.000Z";
    let isDirty = false;
    const host = {
      readState: jest.fn(() => ({
        scenarioId: "scenario-1",
        expectedUpdatedAt,
        sessionKey,
        ownershipKey,
        isDirty,
        hasConflict: false,
      })),
      cancelPendingAutosave: jest.fn(),
      saveScenario: jest.fn(async () => true),
      applyActionRoutingPatch: jest.fn(() => true),
      adoptConvertedScenario: jest.fn(() => true),
      onConflict: jest.fn(),
      onError: jest.fn(),
      onWarning: jest.fn(),
      onStatusChange: jest.fn(),
      onConversionAbandoned: jest.fn(),
    };
    const { result } = renderHook(() =>
      useLegacyRoutingConversion({ workspaceId: "workspace-1", host })
    );

    let staleConversion!: Promise<boolean>;
    act(() => {
      staleConversion = result.current({
        sourceActionNodeId: "action-1",
        sourceNodeId: "condition-1",
        sourceKind: "post_action_condition",
        patch: {},
      });
    });
    await act(async () => {
      await Promise.resolve();
    });
    sessionKey = "flow-3";
    ownershipKey = "flow-3:graph-1";
    expectedUpdatedAt = "2026-01-01T00:01:00.000Z";
    isDirty = true;
    await act(async () => {
      resolveConversion({
        scenario: scenarioDocument(),
        metadata: {
          linkedConditionParentCountByNodeId: {},
          warnings: [warning],
        },
      });
      await expect(staleConversion).resolves.toBe(false);
    });

    expect(host.adoptConvertedScenario).not.toHaveBeenCalled();
    expect(host.onWarning).not.toHaveBeenCalled();
    expect(host.onStatusChange.mock.calls.map(([status]) => status)).toEqual([
      "saving",
    ]);
    expect(host.onConversionAbandoned).toHaveBeenCalledTimes(1);

    isDirty = false;
    mockConvertLegacyActionRoutingRequest.mockResolvedValueOnce({
      scenario: scenarioDocument(),
      metadata: { linkedConditionParentCountByNodeId: {} },
    });
    await act(async () => {
      await result.current({
        sourceActionNodeId: "action-1",
        sourceNodeId: "condition-1",
        sourceKind: "post_action_condition",
        patch: {},
      });
    });

    expect(mockConvertLegacyActionRoutingRequest).toHaveBeenCalledTimes(2);
    expect(host.applyActionRoutingPatch).not.toHaveBeenCalled();
  });

  it("ignores a rejected conversion after its scenario loses ownership", async () => {
    let rejectConversion!: (reason: unknown) => void;
    mockConvertLegacyActionRoutingRequest.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectConversion = reject;
        })
    );
    let scenarioId = "scenario-1";
    let expectedUpdatedAt = "2026-01-01T00:00:00.000Z";
    let sessionKey = "flow-1";
    let ownershipKey = "flow-1:graph-0";
    const host = createConversionHost(() => ({
      scenarioId,
      expectedUpdatedAt,
      sessionKey,
      ownershipKey,
      isDirty: false,
      hasConflict: false,
    }));
    const { result } = renderHook(() =>
      useLegacyRoutingConversion({ workspaceId: "workspace-1", host })
    );

    let conversion!: Promise<boolean>;
    act(() => {
      conversion = result.current({
        sourceActionNodeId: "action-1",
        sourceNodeId: "condition-1",
        sourceKind: "post_action_condition",
        patch: {},
      });
    });
    await act(async () => {
      await Promise.resolve();
    });
    scenarioId = "scenario-2";
    expectedUpdatedAt = "2026-01-01T00:10:00.000Z";
    sessionKey = "flow-2";
    ownershipKey = "flow-2:graph-0";
    const conflict = Object.assign(new Error("Conflict"), {
      name: "ScenarioRequestError",
      code: "scenario_updated_conflict",
      codes: [],
    });
    await act(async () => {
      rejectConversion(conflict);
      await expect(conversion).resolves.toBe(false);
    });

    expect(host.onConflict).not.toHaveBeenCalled();
    expect(host.onError).not.toHaveBeenCalled();
    expect(host.onStatusChange.mock.calls.map(([status]) => status)).toEqual([
      "saving",
    ]);
    expect(host.onConversionAbandoned).toHaveBeenCalledTimes(1);
  });

  it("ignores a rejected conversion after ABA reselection gains local edits", async () => {
    let rejectConversion!: (reason: unknown) => void;
    mockConvertLegacyActionRoutingRequest.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectConversion = reject;
        })
    );
    let expectedUpdatedAt = "2026-01-01T00:00:00.000Z";
    let sessionKey = "flow-1";
    let ownershipKey = "flow-1:graph-0";
    let isDirty = false;
    const host = createConversionHost(() => ({
      scenarioId: "scenario-1",
      expectedUpdatedAt,
      sessionKey,
      ownershipKey,
      isDirty,
      hasConflict: false,
    }));
    const { result } = renderHook(() =>
      useLegacyRoutingConversion({ workspaceId: "workspace-1", host })
    );

    let conversion!: Promise<boolean>;
    act(() => {
      conversion = result.current({
        sourceActionNodeId: "action-1",
        sourceNodeId: "condition-1",
        sourceKind: "post_action_condition",
        patch: {},
      });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expectedUpdatedAt = "2026-01-01T00:20:00.000Z";
    sessionKey = "flow-3";
    ownershipKey = "flow-3:graph-1";
    isDirty = true;
    await act(async () => {
      rejectConversion(new Error("Request failed"));
      await expect(conversion).resolves.toBe(false);
    });

    expect(host.onConflict).not.toHaveBeenCalled();
    expect(host.onError).not.toHaveBeenCalled();
    expect(host.onStatusChange.mock.calls.map(([status]) => status)).toEqual([
      "saving",
    ]);
    expect(host.onConversionAbandoned).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "a local edit in the same session",
      "flow-1",
      "flow-1:graph-1",
      true,
      true,
    ],
    [
      "a new session of the same scenario",
      "flow-2",
      "flow-2:graph-0",
      false,
      false,
    ],
  ])(
    "settles a rejected conversion after %s",
    async (_label, sessionKey, ownershipKey, isDirty, reportsError) => {
      let rejectConversion!: (reason: unknown) => void;
      mockConvertLegacyActionRoutingRequest.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectConversion = reject;
          })
      );
      let state: ConversionState = {
        scenarioId: "scenario-1",
        expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
        sessionKey: "flow-1",
        ownershipKey: "flow-1:graph-0",
        isDirty: false,
        hasConflict: false,
      };
      const host = createConversionHost(() => state);
      const { result } = renderHook(() =>
        useLegacyRoutingConversion({ workspaceId: "workspace-1", host })
      );
      let conversion!: Promise<boolean>;
      await act(async () => {
        conversion = result.current(noReplyEdit(1440));
        await Promise.resolve();
      });
      expect(mockConvertLegacyActionRoutingRequest).toHaveBeenCalledTimes(1);

      state = { ...state, sessionKey, ownershipKey, isDirty };
      const failure = new Error("Request failed");
      await act(async () => {
        rejectConversion(failure);
        await expect(conversion).resolves.toBe(false);
      });

      expect(host.onConversionAbandoned).toHaveBeenCalledTimes(1);
      expect(host.onConflict).not.toHaveBeenCalled();
      expect(host.onError.mock.calls).toEqual(reportsError ? [[failure]] : []);
      expect(host.onStatusChange.mock.calls.map(([status]) => status)).toEqual([
        "saving",
      ]);
    }
  );

  it.each([
    [
      "a local edit on the request's revision",
      "2026-01-01T00:00:00.000Z",
      "flow-1:graph-1",
      true,
      1,
    ],
    [
      "a save that committed first",
      "2026-01-01T00:05:00.000Z",
      "flow-1:graph-0",
      false,
      0,
    ],
  ])(
    "treats a conversion conflict after %s as a conflict only on its own revision",
    async (_label, expectedUpdatedAt, ownershipKey, isDirty, conflicts) => {
      let rejectConversion!: (reason: unknown) => void;
      mockConvertLegacyActionRoutingRequest.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectConversion = reject;
          })
      );
      let state: ConversionState = {
        scenarioId: "scenario-1",
        expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
        sessionKey: "flow-1",
        ownershipKey: "flow-1:graph-0",
        isDirty: false,
        hasConflict: false,
      };
      const host = createConversionHost(() => state);
      const { result } = renderHook(() =>
        useLegacyRoutingConversion({ workspaceId: "workspace-1", host })
      );
      let conversion!: Promise<boolean>;
      await act(async () => {
        conversion = result.current(noReplyEdit(1440));
        await Promise.resolve();
      });

      state = { ...state, expectedUpdatedAt, ownershipKey, isDirty };
      const conflict = Object.assign(new Error("Conflict"), {
        name: "ScenarioRequestError",
        code: "scenario_updated_conflict",
        codes: [],
      });
      await act(async () => {
        rejectConversion(conflict);
        await expect(conversion).resolves.toBe(false);
      });

      expect(host.onConflict).toHaveBeenCalledTimes(conflicts);
      expect(host.onError).not.toHaveBeenCalled();
      expect(host.onConversionAbandoned).toHaveBeenCalledTimes(1);
      // The status is settled after the conflict is marked, so it can read it.
      const [abandonedAt] = host.onConversionAbandoned.mock.invocationCallOrder;
      expect(
        host.onConflict.mock.invocationCallOrder.every(
          order => order < abandonedAt
        )
      ).toBe(true);
    }
  );

  it("reports a rejected conversion while ownership is unchanged", async () => {
    const failure = new Error("Request failed");
    mockConvertLegacyActionRoutingRequest.mockRejectedValueOnce(failure);
    const host = createConversionHost(() => ({
      scenarioId: "scenario-1",
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
      sessionKey: "flow-1",
      ownershipKey: "flow-1:graph-0",
      isDirty: false,
      hasConflict: false,
    }));
    const { result } = renderHook(() =>
      useLegacyRoutingConversion({ workspaceId: "workspace-1", host })
    );

    await act(async () => {
      await expect(
        result.current({
          sourceActionNodeId: "action-1",
          sourceNodeId: "condition-1",
          sourceKind: "post_action_condition",
          patch: {},
        })
      ).resolves.toBe(false);
    });

    expect(host.onConflict).not.toHaveBeenCalled();
    expect(host.onError).toHaveBeenCalledWith(failure);
    expect(host.onStatusChange.mock.calls.map(([status]) => status)).toEqual([
      "saving",
      "unsaved",
    ]);
    expect(host.onConversionAbandoned).not.toHaveBeenCalled();
  });

  it("reports a rejection again without re-sending edits on the same revision", async () => {
    const failure = scenarioRequestError(
      409,
      "legacy_action_routing_pending_timer_identity_invalid"
    );
    mockConvertLegacyActionRoutingRequest.mockRejectedValue(failure);
    const host = createConversionHost(() => ({
      scenarioId: "scenario-1",
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
      sessionKey: "flow-1",
      ownershipKey: "flow-1:graph-0",
      isDirty: false,
      hasConflict: false,
    }));
    const { result } = renderHook(() =>
      useLegacyRoutingConversion({ workspaceId: "workspace-1", host })
    );

    await act(async () => {
      await expect(
        Promise.all([
          result.current(noReplyEdit(1440)),
          result.current(noReplyEdit(2880)),
        ])
      ).resolves.toEqual([false, false]);
    });

    expect(mockConvertLegacyActionRoutingRequest).toHaveBeenCalledTimes(1);
    expect(host.onError.mock.calls).toEqual([[failure], [failure]]);
    expect(host.onConflict).not.toHaveBeenCalled();
    expect(host.onStatusChange.mock.calls.map(([status]) => status)).toEqual([
      "saving",
      "unsaved",
    ]);
    expect(host.onConversionAbandoned).not.toHaveBeenCalled();
  });

  it("re-sends only a changed edit after its converted graph was rejected", async () => {
    const failure = scenarioRequestError(400, "whatsappTemplateRequired");
    mockConvertLegacyActionRoutingRequest.mockRejectedValue(failure);
    const host = createConversionHost(() => ({
      scenarioId: "scenario-1",
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
      sessionKey: "flow-1",
      ownershipKey: "flow-1:graph-0",
      isDirty: false,
      hasConflict: false,
    }));
    const { result } = renderHook(() =>
      useLegacyRoutingConversion({ workspaceId: "workspace-1", host })
    );

    await act(async () => {
      await expect(
        Promise.all([
          result.current(noReplyEdit(1440)),
          result.current(noReplyEdit(1440)),
          result.current(noReplyEdit(2880)),
        ])
      ).resolves.toEqual([false, false, false]);
    });

    expect(
      mockConvertLegacyActionRoutingRequest.mock.calls.map(
        ([request]) => request.actionOutcomes
      )
    ).toEqual([
      noReplyEdit(1440).patch.actionOutcomes,
      noReplyEdit(2880).patch.actionOutcomes,
    ]);
    expect(host.onError.mock.calls).toEqual([[failure], [failure], [failure]]);
  });

  it.each([
    ["a network error", new Error("Failed to fetch")],
    [
      "unavailable timer recovery",
      scenarioRequestError(
        503,
        "legacy_action_routing_timer_ingress_unavailable"
      ),
    ],
    [
      "a server error",
      scenarioRequestError(500, "legacy_action_routing_transaction_failed"),
    ],
  ])("retries the same edit after %s", async (_label, failure) => {
    mockConvertLegacyActionRoutingRequest.mockRejectedValue(failure);
    const host = createConversionHost(() => ({
      scenarioId: "scenario-1",
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
      sessionKey: "flow-1",
      ownershipKey: "flow-1:graph-0",
      isDirty: false,
      hasConflict: false,
    }));
    const { result } = renderHook(() =>
      useLegacyRoutingConversion({ workspaceId: "workspace-1", host })
    );

    await act(async () => {
      await expect(
        Promise.all([
          result.current(noReplyEdit(1440)),
          result.current(noReplyEdit(1440)),
        ])
      ).resolves.toEqual([false, false]);
    });

    expect(mockConvertLegacyActionRoutingRequest).toHaveBeenCalledTimes(2);
    expect(host.onError.mock.calls).toEqual([[failure], [failure]]);
  });

  it.each([
    ["a new revision", { expectedUpdatedAt: "2026-01-01T00:05:00.000Z" }],
    ["a new session", { sessionKey: "flow-2", ownershipKey: "flow-2:graph-0" }],
    [
      "another scenario",
      {
        scenarioId: "scenario-2",
        sessionKey: "flow-2",
        ownershipKey: "flow-2:graph-0",
      },
    ],
  ])(
    "retries a rejected conversion after %s",
    async (_label, change: Partial<ConversionState>) => {
      const failure = scenarioRequestError(
        409,
        "legacy_action_routing_not_eligible"
      );
      mockConvertLegacyActionRoutingRequest.mockRejectedValue(failure);
      let state: ConversionState = {
        scenarioId: "scenario-1",
        expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
        sessionKey: "flow-1",
        ownershipKey: "flow-1:graph-0",
        isDirty: false,
        hasConflict: false,
      };
      const host = createConversionHost(() => state);
      const { result } = renderHook(() =>
        useLegacyRoutingConversion({ workspaceId: "workspace-1", host })
      );
      await act(async () => {
        await expect(result.current(noReplyEdit(1440))).resolves.toBe(false);
      });

      state = { ...state, ...change };
      await act(async () => {
        await expect(result.current(noReplyEdit(1440))).resolves.toBe(false);
      });

      expect(mockConvertLegacyActionRoutingRequest).toHaveBeenCalledTimes(2);
      expect(mockConvertLegacyActionRoutingRequest).toHaveBeenLastCalledWith(
        expect.objectContaining({
          scenarioId: state.scenarioId,
          expectedUpdatedAt: state.expectedUpdatedAt,
        })
      );
      expect(host.onError.mock.calls).toEqual([[failure], [failure]]);
    }
  );
});
