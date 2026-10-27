/**
 * @jest-environment jsdom
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import type { ScenarioDocument, ScenarioSummary } from "../types";
import type { ScenarioGeneratorCreateInput } from "@icecore/scenario-contracts";
import { useScenarioWorkspaceEntity } from "./use-scenario-workspace-entity";

const mockFetchScenarios = jest.fn();
const mockPatchScenarioSidebarRequest = jest.fn();
const mockCreateScenarioRequest = jest.fn();
const mockCreateScenarioFromGeneratorRequest = jest.fn();
const mockToastError = jest.fn();
const mockToastSuccess = jest.fn();

jest.mock("@/lib/scenarios/client", () => ({
  ScenarioRequestError: jest.requireActual("@/lib/scenarios/client")
    .ScenarioRequestError,
  createScenarioFromGeneratorRequest: (...args: unknown[]) =>
    mockCreateScenarioFromGeneratorRequest(...args),
  createScenarioRequest: (...args: unknown[]) =>
    mockCreateScenarioRequest(...args),
  deleteScenarioRequest: jest.fn(),
  fetchScenarios: (...args: unknown[]) => mockFetchScenarios(...args),
  patchScenarioSidebarRequest: (...args: unknown[]) =>
    mockPatchScenarioSidebarRequest(...args),
}));

jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: (...args: unknown[]) => mockToastSuccess(...args),
  },
}));

function summary(
  name: string,
  updatedAt: string,
  overrides: Partial<ScenarioSummary> = {}
): ScenarioSummary {
  return {
    _id: "scenario-1",
    name,
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
    nodeCount: 0,
    edgeCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    ...overrides,
  };
}

function document(
  name: string,
  updatedAt: string,
  overrides: Partial<ScenarioDocument> = {}
): ScenarioDocument {
  return {
    ...summary(name, updatedAt),
    graphSchemaVersion: 1,
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const translate = (key: string) => key;
const playbookConfig = {
  goal: "unpaid_recovery" as const,
  name: "Payment follow-up",
  openingText: "Please pay using the shared details.",
  reminderText: "Can we help?",
  reminderMinutes: 30,
  successText: "Payment confirmed.",
  handoffText: "Our team will help.",
  triggerKeyword: "invoice",
};
const generatorInput: ScenarioGeneratorCreateInput = {
  workspaceId: "workspace-a",
  prompt: "Follow up on unpaid orders",
  workflowKind: "follow_up_workflow",
  sendMode: "trigger",
  channels: ["whatsapp"],
};

describe("useScenarioWorkspaceEntity sidebar mutations", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchScenarios.mockResolvedValue([
      summary("Original", "2026-01-01T00:00:00.000Z"),
    ]);
  });
  it("persists a playbook as an ordinary draft with its preset and configured messages", async () => {
    mockCreateScenarioRequest.mockResolvedValueOnce(
      document("Payment follow-up", "2026-09-11T10:00:00Z", {
        _id: "created-playbook",
        presetId: "revenue-playbook-unpaid_recovery",
      })
    );
    const { result } = renderHook(() =>
      useScenarioWorkspaceEntity({
        workspaceId: "workspace-a",
        contextOptions: [],
        initialScenarios: [],
        t: translate,
      })
    );
    await act(async () => {
      await result.current.createScenarioFromRevenuePlaybook(playbookConfig);
    });
    expect(mockCreateScenarioRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-a",
        status: "draft",
        presetId: "revenue-playbook-unpaid_recovery",
        presetVersion: "1",
        description: expect.any(String),
        nodes: expect.any(Array),
        edges: expect.any(Array),
      })
    );
    const request = mockCreateScenarioRequest.mock.calls[0][0];
    expect(request.edges.length).toBeGreaterThan(0);
    for (const [id, text] of [
      ["revenue-offer", playbookConfig.openingText],
      ["revenue-reminder", playbookConfig.reminderText],
      ["revenue-success", playbookConfig.successText],
    ]) {
      expect(request.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: expect.stringMatching(new RegExp(`${id}$`)),
            data: expect.objectContaining({
              actionWhatsAppServiceMessage: expect.objectContaining({
                message: expect.objectContaining({
                  body: { mode: "fixed", text },
                }),
              }),
            }),
          }),
        ])
      );
    }
    expect(result.current.scenarios[0]._id).toBe("created-playbook");
  });

  it.each([false, true])(
    "discards old generator responses after a workspace switch (return to original: %s)",
    async returnToOriginal => {
      const old = deferred<{ scenario: ScenarioDocument }>();
      const current = deferred<{ scenario: ScenarioDocument }>();
      mockCreateScenarioFromGeneratorRequest
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(current.promise);
      const { result, rerender } = renderHook(
        ({ workspaceId }) =>
          useScenarioWorkspaceEntity({
            workspaceId,
            contextOptions: [],
            initialScenarios: [],
            t: translate,
          }),
        { initialProps: { workspaceId: "workspace-a" } }
      );
      let oldRequest!: Promise<ScenarioDocument | null>;
      act(() => {
        oldRequest = result.current.createScenarioFromGenerator(generatorInput);
      });
      expect(result.current.isCreatingScenario).toBe(true);
      rerender({ workspaceId: "workspace-b" });
      if (returnToOriginal) rerender({ workspaceId: "workspace-a" });
      expect(result.current.isCreatingScenario).toBe(false);
      let currentRequest!: Promise<ScenarioDocument | null>;
      act(() => {
        currentRequest = result.current.createScenarioFromGenerator({
          ...generatorInput,
          workspaceId: returnToOriginal ? "workspace-a" : "workspace-b",
        });
      });
      await act(async () => {
        old.resolve({
          scenario: document("Old generator", "2026-09-11T10:00:00Z"),
        });
        expect(await oldRequest).toBeNull();
      });
      expect(result.current.scenarios).toEqual([]);
      expect(result.current.isCreatingScenario).toBe(true);
      expect(mockToastSuccess).not.toHaveBeenCalled();
      await act(async () => {
        current.resolve({
          scenario: document("Current generator", "2026-09-11T10:01:00Z"),
        });
        await currentRequest;
      });
      expect(result.current.scenarios.map(scenario => scenario.name)).toEqual([
        "Current generator",
      ]);
      expect(result.current.isCreatingScenario).toBe(false);
      expect(mockToastSuccess).toHaveBeenCalledTimes(1);
    }
  );

  it("does not show an old workspace generator error in the current workspace", async () => {
    const pending = deferred<{ scenario: ScenarioDocument }>();
    mockCreateScenarioFromGeneratorRequest.mockReturnValueOnce(pending.promise);
    const { result, rerender } = renderHook(
      ({ workspaceId }) =>
        useScenarioWorkspaceEntity({
          workspaceId,
          contextOptions: [],
          initialScenarios: [],
          t: translate,
        }),
      { initialProps: { workspaceId: "workspace-a" } }
    );
    let request!: Promise<ScenarioDocument | null>;
    act(() => {
      request = result.current.createScenarioFromGenerator(generatorInput);
    });
    rerender({ workspaceId: "workspace-b" });
    await act(async () => {
      pending.reject(new Error("Old workspace provider failure"));
      expect(await request).toBeNull();
    });
    expect(mockToastError).not.toHaveBeenCalled();
  });
  it("does not leave a new workspace busy or adopt a playbook created for the old workspace", async () => {
    const pending = deferred<ScenarioDocument>();
    mockCreateScenarioRequest.mockReturnValueOnce(pending.promise);
    const { result, rerender } = renderHook(
      ({ workspaceId }) =>
        useScenarioWorkspaceEntity({
          workspaceId,
          contextOptions: [],
          initialScenarios: [],
          t: translate,
        }),
      { initialProps: { workspaceId: "workspace-a" } }
    );
    let create!: Promise<ScenarioDocument | null>;
    act(() => {
      create = result.current.createScenarioFromRevenuePlaybook(playbookConfig);
    });
    expect(result.current.isCreatingScenario).toBe(true);
    rerender({ workspaceId: "workspace-b" });
    expect(result.current.isCreatingScenario).toBe(false);
    await act(async () => {
      pending.resolve(
        document("Old workspace playbook", "2026-09-11T10:00:00Z")
      );
      await create;
    });
    expect(result.current.scenarios).toEqual([]);
    expect(result.current.isCreatingScenario).toBe(false);
  });

  it("hydrates from initial scenarios without fetching", () => {
    const seeded = summary("Seeded", "2026-01-01T00:00:00.000Z", {
      _id: "scenario-seed",
    });

    const { result } = renderHook(() =>
      useScenarioWorkspaceEntity({
        workspaceId: "workspace-1",
        contextOptions: [],
        initialScenarios: [seeded],
        requestedScenarioId: "scenario-seed",
        t: translate,
      })
    );

    expect(mockFetchScenarios).not.toHaveBeenCalled();
    expect(result.current.loadingScenarios).toBe(false);
    expect(result.current.scenarios).toEqual([seeded]);
    expect(result.current.activeScenarioId).toBe("scenario-seed");
  });

  it("creates demo journeys once per conversation by default", async () => {
    mockCreateScenarioRequest.mockResolvedValue(
      document("Demo", "2026-01-01T00:00:01.000Z", {
        entryPolicy: "once_per_conversation",
      })
    );

    const { result } = renderHook(() =>
      useScenarioWorkspaceEntity({
        workspaceId: "workspace-1",
        contextOptions: [],
        t: translate,
      })
    );

    await waitFor(() => {
      expect(result.current.scenarios).toHaveLength(1);
    });

    await act(async () => {
      await result.current.createDemoScenario();
    });

    expect(mockCreateScenarioRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        entryPolicy: "once_per_conversation",
      })
    );
  });

  it("returns the created document without replacing the selected editor document", async () => {
    const original = summary("Original", "2026-01-01T00:00:00.000Z");
    const created = document("Demo", "2026-01-01T00:00:01.000Z", {
      _id: "scenario-2",
    });
    mockCreateScenarioRequest.mockResolvedValue(created);
    const { result } = renderHook(() =>
      useScenarioWorkspaceEntity({
        workspaceId: "workspace-1",
        contextOptions: [],
        initialScenarios: [original],
        t: translate,
      })
    );

    let outcome: ScenarioDocument | null = null;
    await act(async () => {
      outcome = await result.current.createDemoScenario();
    });

    expect(outcome).toEqual(created);
    expect(result.current.scenarios.map(item => item._id)).toEqual([
      "scenario-2",
      "scenario-1",
    ]);
    expect(result.current.activeScenarioId).toBe("scenario-1");
  });

  it("uses a confirmed editor commit as the rollback baseline for a later sidebar failure", async () => {
    const { result } = renderHook(() =>
      useScenarioWorkspaceEntity({
        workspaceId: "workspace-1",
        contextOptions: [],
        initialScenarios: [summary("Original", "2026-01-01T00:00:00.000Z")],
        t: translate,
      })
    );
    act(() => {
      result.current.adoptConfirmedScenarioDocument(
        document("Editor rename", "2026-01-01T00:00:01.000Z")
      );
    });
    mockPatchScenarioSidebarRequest.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      expect(
        await result.current.handleScenarioNameCommit(
          "scenario-1",
          "Failed rename"
        )
      ).toBe(false);
    });
    expect(result.current.scenarios[0]).toMatchObject({
      name: "Editor rename",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
  });

  it("keeps the departing scenario selected until its editor is clean", async () => {
    const save = deferred<boolean>();
    const flush = jest.fn(() => save.promise);
    const { result } = renderHook(() =>
      useScenarioWorkspaceEntity({
        workspaceId: "workspace-1",
        contextOptions: [],
        initialScenarios: [
          summary("A", "2026-01-01T00:00:00.000Z"),
          summary("B", "2026-01-01T00:00:00.000Z", { _id: "scenario-2" }),
        ],
        t: translate,
      })
    );
    let selection!: Promise<boolean>;
    await act(async () => {
      selection = result.current.selectScenario("scenario-2", flush);
    });
    expect(flush).toHaveBeenCalledTimes(1);
    expect(result.current.activeScenarioId).toBe("scenario-1");
    expect(result.current.pendingScenarioId).toBe("scenario-2");
    await act(async () => {
      save.resolve(true);
      expect(await selection).toBe(true);
    });
    expect(result.current.activeScenarioId).toBe("scenario-2");
    expect(result.current.pendingScenarioId).toBeNull();
  });

  it("preserves selection after a failed save and permits an explicit retry", async () => {
    const flush = jest
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const { result } = renderHook(() =>
      useScenarioWorkspaceEntity({
        workspaceId: "workspace-1",
        contextOptions: [],
        initialScenarios: [
          summary("A", "2026-01-01T00:00:00.000Z"),
          summary("B", "2026-01-01T00:00:00.000Z", { _id: "scenario-2" }),
        ],
        t: translate,
      })
    );
    await act(async () => {
      expect(await result.current.selectScenario("scenario-2", flush)).toBe(
        false
      );
    });
    expect(result.current.activeScenarioId).toBe("scenario-1");
    expect(result.current.pendingScenarioId).toBeNull();
    await act(async () => {
      expect(await result.current.selectScenario("scenario-2", flush)).toBe(
        true
      );
    });
    expect(result.current.activeScenarioId).toBe("scenario-2");
  });

  it("cancels pending navigation when the user selects the current scenario again", async () => {
    const save = deferred<boolean>();
    const flush = jest.fn(() => save.promise);
    const { result } = renderHook(() =>
      useScenarioWorkspaceEntity({
        workspaceId: "workspace-1",
        contextOptions: [],
        initialScenarios: [
          summary("A", "2026-01-01T00:00:00.000Z"),
          summary("B", "2026-01-01T00:00:00.000Z", { _id: "scenario-2" }),
        ],
        t: translate,
      })
    );
    let selection!: Promise<boolean>;
    await act(async () => {
      selection = result.current.selectScenario("scenario-2", flush);
    });
    await act(async () => {
      expect(await result.current.selectScenario("scenario-1", flush)).toBe(
        true
      );
      save.resolve(true);
      expect(await selection).toBe(false);
    });
    expect(flush).toHaveBeenCalledTimes(1);
    expect(result.current.activeScenarioId).toBe("scenario-1");
    expect(result.current.pendingScenarioId).toBeNull();
  });

  it("persists entry policy for the requested sidebar scenario", async () => {
    mockPatchScenarioSidebarRequest.mockResolvedValue(
      document("Original", "2026-01-01T00:00:01.000Z", {
        entryPolicy: "once_per_conversation",
      })
    );
    const { result } = renderHook(() =>
      useScenarioWorkspaceEntity({
        workspaceId: "workspace-1",
        contextOptions: [],
        t: translate,
      })
    );
    await waitFor(() => expect(result.current.scenarios).toHaveLength(1));

    let saved = false;
    await act(async () => {
      saved = await result.current.saveScenarioPatch("scenario-1", {
        entryPolicy: "once_per_conversation",
      });
    });

    expect(saved).toBe(true);
    expect(mockPatchScenarioSidebarRequest).toHaveBeenCalledWith({
      scenarioId: "scenario-1",
      workspaceId: "workspace-1",
      patch: {
        entryPolicy: "once_per_conversation",
      },
    });
    expect(result.current.scenarios[0]).toEqual(
      expect.objectContaining({
        updatedAt: "2026-01-01T00:00:01.000Z",
      })
    );
  });

  it("serializes name saves so an older request cannot overwrite the latest edit", async () => {
    let resolveFirst!: (value: ScenarioDocument) => void;
    let resolveSecond!: (value: ScenarioDocument) => void;
    mockPatchScenarioSidebarRequest
      .mockImplementationOnce(
        () =>
          new Promise<ScenarioDocument>(resolve => {
            resolveFirst = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<ScenarioDocument>(resolve => {
            resolveSecond = resolve;
          })
      );

    const { result } = renderHook(() =>
      useScenarioWorkspaceEntity({
        workspaceId: "workspace-1",
        contextOptions: [],
        t: translate,
      })
    );

    await waitFor(() => {
      expect(result.current.scenarios).toHaveLength(1);
    });

    act(() => {
      void result.current.handleScenarioNameCommit("scenario-1", "First");
    });

    act(() => {
      void result.current.handleScenarioNameCommit("scenario-1", "Second");
    });

    await waitFor(() => {
      expect(mockPatchScenarioSidebarRequest).toHaveBeenCalledTimes(1);
    });

    resolveFirst(document("First", "2026-01-01T00:00:01.000Z"));
    await waitFor(() => {
      expect(mockPatchScenarioSidebarRequest).toHaveBeenCalledTimes(2);
      expect(result.current.scenarios[0]?.name).toBe("Second");
    });
    await act(async () => {
      resolveSecond(document("Second", "2026-01-01T00:00:02.000Z"));
      await Promise.resolve();
    });
    expect(result.current.scenarios[0]?.name).toBe("Second");
    expect(mockPatchScenarioSidebarRequest.mock.calls).toEqual([
      [
        {
          scenarioId: "scenario-1",
          workspaceId: "workspace-1",
          patch: { name: "First" },
        },
      ],
      [
        {
          scenarioId: "scenario-1",
          workspaceId: "workspace-1",
          patch: { name: "Second" },
        },
      ],
    ]);
  });

  it("rolls a failed queued rename back to the preceding confirmed success", async () => {
    const first = deferred<ScenarioDocument>();
    const second = deferred<ScenarioDocument>();
    mockPatchScenarioSidebarRequest
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { result } = renderHook(() =>
      useScenarioWorkspaceEntity({
        workspaceId: "workspace-1",
        contextOptions: [],
        t: translate,
      })
    );
    await waitFor(() => expect(result.current.scenarios).toHaveLength(1));

    let firstSave!: Promise<boolean>;
    let secondSave!: Promise<boolean>;
    act(() => {
      firstSave = result.current.handleScenarioNameCommit(
        "scenario-1",
        "First"
      );
      secondSave = result.current.handleScenarioNameCommit(
        "scenario-1",
        "Second"
      );
    });

    await waitFor(() =>
      expect(mockPatchScenarioSidebarRequest).toHaveBeenCalledTimes(1)
    );
    await act(async () => {
      first.resolve(document("First", "2026-01-01T00:00:01.000Z"));
      await firstSave;
    });
    await waitFor(() =>
      expect(mockPatchScenarioSidebarRequest).toHaveBeenCalledTimes(2)
    );
    await act(async () => {
      second.reject(new Error("save failed"));
      await secondSave;
    });

    expect(result.current.scenarios[0]?.name).toBe("First");
  });

  it("reports a superseded rejected save as failed without reconciling stale UI", async () => {
    const first = deferred<ScenarioDocument>();
    const second = deferred<ScenarioDocument>();
    mockPatchScenarioSidebarRequest
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { result } = renderHook(() =>
      useScenarioWorkspaceEntity({
        workspaceId: "workspace-1",
        contextOptions: [],
        t: translate,
      })
    );
    await waitFor(() => expect(result.current.scenarios).toHaveLength(1));

    let firstSave!: Promise<boolean>;
    let secondSave!: Promise<boolean>;
    act(() => {
      firstSave = result.current.handleScenarioNameCommit(
        "scenario-1",
        "First"
      );
      secondSave = result.current.handleScenarioNameCommit(
        "scenario-1",
        "Second"
      );
    });

    await waitFor(() =>
      expect(mockPatchScenarioSidebarRequest).toHaveBeenCalledTimes(1)
    );
    let firstSaved!: boolean;
    await act(async () => {
      first.reject(new Error("first save failed"));
      firstSaved = await firstSave;
    });
    await waitFor(() =>
      expect(mockPatchScenarioSidebarRequest).toHaveBeenCalledTimes(2)
    );

    let secondSaved!: boolean;
    await act(async () => {
      second.resolve(document("Second", "2026-01-01T00:00:02.000Z"));
      secondSaved = await secondSave;
    });

    expect(firstSaved).toBe(false);
    expect(secondSaved).toBe(true);
    expect(result.current.scenarios[0]?.name).toBe("Second");
  });

  it("restores the original confirmed value after two failed same-field mutations", async () => {
    const first = deferred<ScenarioDocument>();
    const second = deferred<ScenarioDocument>();
    mockPatchScenarioSidebarRequest
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { result } = renderHook(() =>
      useScenarioWorkspaceEntity({
        workspaceId: "workspace-1",
        contextOptions: [],
        t: translate,
      })
    );
    await waitFor(() => expect(result.current.scenarios).toHaveLength(1));

    act(() => {
      void result.current.saveScenarioPatch("scenario-1", {
        entryPolicy: "once_per_conversation",
      });
      void result.current.saveScenarioPatch("scenario-1", {
        entryPolicy: "repeatable",
      });
    });

    await waitFor(() =>
      expect(mockPatchScenarioSidebarRequest).toHaveBeenCalledTimes(1)
    );
    await act(async () => {
      first.reject(new Error("first save failed"));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(mockPatchScenarioSidebarRequest).toHaveBeenCalledTimes(2)
    );
    await act(async () => {
      second.reject(new Error("second save failed"));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(result.current.scenarios[0]?.entryPolicy).toBe("repeatable")
    );
  });

  it("does not let an older mixed-field response clobber a newer optimistic value", async () => {
    const first = deferred<ScenarioDocument>();
    const second = deferred<ScenarioDocument>();
    mockPatchScenarioSidebarRequest
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { result } = renderHook(() =>
      useScenarioWorkspaceEntity({
        workspaceId: "workspace-1",
        contextOptions: [],
        t: translate,
      })
    );
    await waitFor(() => expect(result.current.scenarios).toHaveLength(1));

    let renameSave!: Promise<boolean>;
    act(() => {
      renameSave = result.current.handleScenarioNameCommit(
        "scenario-1",
        "First"
      );
      void result.current.saveScenarioPatch("scenario-1", {
        entryPolicy: "once_per_conversation",
      });
    });

    await waitFor(() =>
      expect(mockPatchScenarioSidebarRequest).toHaveBeenCalledTimes(1)
    );
    await act(async () => {
      first.resolve(
        document("First", "2026-01-01T00:00:01.000Z", {
          entryPolicy: "repeatable",
        })
      );
      await renameSave;
    });
    await waitFor(() =>
      expect(mockPatchScenarioSidebarRequest).toHaveBeenCalledTimes(2)
    );
    expect(result.current.scenarios[0]).toMatchObject({
      name: "First",
      entryPolicy: "once_per_conversation",
    });

    await act(async () => {
      second.resolve(
        document("First", "2026-01-01T00:00:02.000Z", {
          entryPolicy: "once_per_conversation",
        })
      );
      await Promise.resolve();
    });
  });

  it("serializes reorder priority behind settings for the same scenario", async () => {
    mockFetchScenarios.mockResolvedValue([
      summary("Alpha", "2026-01-01T00:00:00.000Z", {
        _id: "scenario-1",
        priority: 1,
      }),
      summary("Beta", "2026-01-01T00:00:00.000Z", {
        _id: "scenario-2",
        priority: 1,
      }),
    ]);
    const settings = deferred<ScenarioDocument>();
    const reorder = deferred<ScenarioDocument>();
    mockPatchScenarioSidebarRequest
      .mockReturnValueOnce(settings.promise)
      .mockReturnValueOnce(reorder.promise);

    const { result } = renderHook(() =>
      useScenarioWorkspaceEntity({
        workspaceId: "workspace-1",
        contextOptions: [],
        t: translate,
      })
    );
    await waitFor(() => expect(result.current.scenarios).toHaveLength(2));

    let settingsSave!: Promise<boolean>;
    act(() => {
      settingsSave = result.current.handleScenarioSettingsSave({
        scenarioId: "scenario-2",
        status: "active",
        priority: 1,
      });
    });
    await waitFor(() =>
      expect(mockPatchScenarioSidebarRequest).toHaveBeenCalledTimes(1)
    );

    act(() => {
      result.current.handleScenarioReorderWithSave({
        draggedScenarioId: "scenario-2",
        overScenarioId: "scenario-1",
        placement: "before",
      });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockPatchScenarioSidebarRequest).toHaveBeenCalledTimes(1);

    await act(async () => {
      settings.resolve(
        document("Beta", "2026-01-01T00:00:01.000Z", {
          _id: "scenario-2",
          priority: 1,
          status: "active",
        })
      );
      await settingsSave;
    });
    await waitFor(() =>
      expect(mockPatchScenarioSidebarRequest).toHaveBeenCalledTimes(2)
    );

    await act(async () => {
      reorder.resolve(
        document("Beta", "2026-01-01T00:00:02.000Z", {
          _id: "scenario-2",
          priority: 2,
          status: "active",
        })
      );
      await Promise.resolve();
    });
    expect(mockPatchScenarioSidebarRequest).toHaveBeenNthCalledWith(2, {
      scenarioId: "scenario-2",
      workspaceId: "workspace-1",
      patch: { priority: 2 },
    });
  });

  it("does not let an older failed reorder replace a newer successful order", async () => {
    const initialScenarios = [
      summary("Alpha", "2026-01-01T00:00:00.000Z", {
        _id: "scenario-1",
        priority: 3,
      }),
      summary("Beta", "2026-01-01T00:00:00.000Z", {
        _id: "scenario-2",
        priority: 2,
      }),
      summary("Gamma", "2026-01-01T00:00:00.000Z", {
        _id: "scenario-3",
        priority: 1,
      }),
    ];
    mockFetchScenarios.mockResolvedValue(initialScenarios);
    const requests: Array<{
      input: {
        scenarioId: string;
        patch: { priority?: number };
      };
      pending: ReturnType<typeof deferred<ScenarioDocument>>;
    }> = [];
    mockPatchScenarioSidebarRequest.mockImplementation(
      (input: { scenarioId: string; patch: { priority?: number } }) => {
        const pending = deferred<ScenarioDocument>();
        requests.push({ input, pending });
        return pending.promise;
      }
    );

    const { result } = renderHook(() =>
      useScenarioWorkspaceEntity({
        workspaceId: "workspace-1",
        contextOptions: [],
        t: translate,
      })
    );
    await waitFor(() => expect(result.current.scenarios).toHaveLength(3));

    act(() => {
      result.current.handleScenarioReorderWithSave({
        draggedScenarioId: "scenario-2",
        overScenarioId: "scenario-1",
        placement: "before",
      });
    });
    await waitFor(() =>
      expect(result.current.scenarios.map(scenario => scenario._id)).toEqual([
        "scenario-2",
        "scenario-1",
        "scenario-3",
      ])
    );
    await waitFor(() => expect(requests).toHaveLength(2));

    act(() => {
      result.current.handleScenarioReorderWithSave({
        draggedScenarioId: "scenario-3",
        overScenarioId: "scenario-1",
        placement: "before",
      });
    });
    await waitFor(() =>
      expect(result.current.scenarios.map(scenario => scenario._id)).toEqual([
        "scenario-2",
        "scenario-3",
        "scenario-1",
      ])
    );
    await waitFor(() => expect(requests).toHaveLength(3));

    const firstAlpha = requests.find(
      request =>
        request.input.scenarioId === "scenario-1" &&
        request.input.patch.priority === 2
    );
    expect(firstAlpha).toBeDefined();
    await act(async () => {
      firstAlpha?.pending.resolve(
        document("Alpha", "2026-01-01T00:00:01.000Z", {
          _id: "scenario-1",
          priority: 2,
        })
      );
      await Promise.resolve();
    });
    await waitFor(() => expect(requests).toHaveLength(4));

    const secondAlpha = requests.find(
      request =>
        request.input.scenarioId === "scenario-1" &&
        request.input.patch.priority === 1
    );
    const gamma = requests.find(
      request =>
        request.input.scenarioId === "scenario-3" &&
        request.input.patch.priority === 2
    );
    const beta = requests.find(
      request =>
        request.input.scenarioId === "scenario-2" &&
        request.input.patch.priority === 3
    );
    expect(secondAlpha).toBeDefined();
    expect(gamma).toBeDefined();
    expect(beta).toBeDefined();

    await act(async () => {
      secondAlpha?.pending.resolve(
        document("Alpha", "2026-01-01T00:00:02.000Z", {
          _id: "scenario-1",
          priority: 1,
        })
      );
      gamma?.pending.resolve(
        document("Gamma", "2026-01-01T00:00:02.000Z", {
          _id: "scenario-3",
          priority: 2,
        })
      );
      await Promise.resolve();
    });
    await act(async () => {
      beta?.pending.reject(new Error("older reorder failed"));
      await Promise.resolve();
    });
    await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1));

    expect(mockFetchScenarios).toHaveBeenCalledTimes(1);
    expect(result.current.scenarios.map(scenario => scenario._id)).toEqual([
      "scenario-2",
      "scenario-3",
      "scenario-1",
    ]);
  });

  it("waits for relevant sidebar lanes before reloading a latest failed reorder", async () => {
    const initialScenarios = [
      summary("Alpha", "2026-01-01T00:00:00.000Z", {
        _id: "scenario-1",
        priority: 2,
      }),
      summary("Beta", "2026-01-01T00:00:00.000Z", {
        _id: "scenario-2",
        priority: 1,
      }),
    ];
    mockFetchScenarios
      .mockResolvedValueOnce(initialScenarios)
      .mockResolvedValueOnce([
        initialScenarios[0],
        { ...initialScenarios[1], name: "Beta 2" },
      ]);
    const requests: Array<{
      input: {
        scenarioId: string;
        patch: { name?: string; priority?: number };
      };
      pending: ReturnType<typeof deferred<ScenarioDocument>>;
    }> = [];
    mockPatchScenarioSidebarRequest.mockImplementation(
      (input: {
        scenarioId: string;
        patch: { name?: string; priority?: number };
      }) => {
        const pending = deferred<ScenarioDocument>();
        requests.push({ input, pending });
        return pending.promise;
      }
    );

    const { result } = renderHook(() =>
      useScenarioWorkspaceEntity({
        workspaceId: "workspace-1",
        contextOptions: [],
        t: translate,
      })
    );
    await waitFor(() => expect(result.current.scenarios).toHaveLength(2));

    act(() => {
      result.current.handleScenarioReorderWithSave({
        draggedScenarioId: "scenario-2",
        overScenarioId: "scenario-1",
        placement: "before",
      });
    });
    await waitFor(() => expect(requests).toHaveLength(2));

    let nameSave!: Promise<boolean>;
    act(() => {
      nameSave = result.current.handleScenarioNameCommit(
        "scenario-2",
        "Beta 2"
      );
    });

    const betaPriority = requests.find(
      request =>
        request.input.scenarioId === "scenario-2" &&
        request.input.patch.priority === 2
    );
    const alphaPriority = requests.find(
      request =>
        request.input.scenarioId === "scenario-1" &&
        request.input.patch.priority === 1
    );
    expect(betaPriority).toBeDefined();
    expect(alphaPriority).toBeDefined();

    await act(async () => {
      alphaPriority?.pending.resolve(
        document("Alpha", "2026-01-01T00:00:01.000Z", {
          _id: "scenario-1",
          priority: 1,
        })
      );
      betaPriority?.pending.reject(new Error("reorder failed"));
      await Promise.resolve();
    });
    await waitFor(() => expect(requests).toHaveLength(3));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1));
    expect(mockFetchScenarios).toHaveBeenCalledTimes(1);

    const betaName = requests.find(
      request =>
        request.input.scenarioId === "scenario-2" &&
        request.input.patch.name === "Beta 2"
    );
    expect(betaName).toBeDefined();
    await act(async () => {
      betaName?.pending.resolve(
        document("Beta 2", "2026-01-01T00:00:02.000Z", {
          _id: "scenario-2",
          priority: 1,
        })
      );
      await nameSave;
    });

    await waitFor(() => expect(mockFetchScenarios).toHaveBeenCalledTimes(2));
  });

  it("discards stale reorder recovery after a newer sidebar mutation", async () => {
    const initialScenarios = [
      summary("Alpha", "2026-01-01T00:00:00.000Z", {
        _id: "scenario-1",
        priority: 2,
      }),
      summary("Beta", "2026-01-01T00:00:00.000Z", {
        _id: "scenario-2",
        priority: 1,
      }),
    ];
    const recovery = deferred<ScenarioSummary[]>();
    mockFetchScenarios
      .mockResolvedValueOnce(initialScenarios)
      .mockReturnValueOnce(recovery.promise);
    const requests: Array<{
      input: {
        scenarioId: string;
        patch: { name?: string; priority?: number };
      };
      pending: ReturnType<typeof deferred<ScenarioDocument>>;
    }> = [];
    mockPatchScenarioSidebarRequest.mockImplementation(
      (input: {
        scenarioId: string;
        patch: { name?: string; priority?: number };
      }) => {
        const pending = deferred<ScenarioDocument>();
        requests.push({ input, pending });
        return pending.promise;
      }
    );

    const { result } = renderHook(() =>
      useScenarioWorkspaceEntity({
        workspaceId: "workspace-1",
        contextOptions: [],
        t: translate,
      })
    );
    await waitFor(() => expect(result.current.scenarios).toHaveLength(2));

    act(() => {
      result.current.handleScenarioReorderWithSave({
        draggedScenarioId: "scenario-2",
        overScenarioId: "scenario-1",
        placement: "before",
      });
    });
    await waitFor(() => expect(requests).toHaveLength(2));

    const betaPriority = requests.find(
      request =>
        request.input.scenarioId === "scenario-2" &&
        request.input.patch.priority === 2
    );
    const alphaPriority = requests.find(
      request =>
        request.input.scenarioId === "scenario-1" &&
        request.input.patch.priority === 1
    );
    expect(betaPriority).toBeDefined();
    expect(alphaPriority).toBeDefined();
    await act(async () => {
      alphaPriority?.pending.resolve(
        document("Alpha", "2026-01-01T00:00:01.000Z", {
          _id: "scenario-1",
          priority: 1,
        })
      );
      betaPriority?.pending.reject(new Error("reorder failed"));
      await Promise.resolve();
    });
    await waitFor(() => expect(mockFetchScenarios).toHaveBeenCalledTimes(2));

    let confirmedRename!: Promise<boolean>;
    act(() => {
      confirmedRename = result.current.handleScenarioNameCommit(
        "scenario-2",
        "Beta 2"
      );
    });
    await waitFor(() => expect(requests).toHaveLength(3));
    const betaRename = requests.find(
      request => request.input.patch.name === "Beta 2"
    );
    expect(betaRename).toBeDefined();
    await act(async () => {
      betaRename?.pending.resolve(
        document("Beta 2", "2026-01-01T00:00:02.000Z", {
          _id: "scenario-2",
          priority: 1,
        })
      );
      await confirmedRename;
    });
    expect(
      result.current.scenarios.find(scenario => scenario._id === "scenario-2")
        ?.name
    ).toBe("Beta 2");

    await act(async () => {
      recovery.resolve(initialScenarios);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.loadingScenarios).toBe(false));
    expect(
      result.current.scenarios.find(scenario => scenario._id === "scenario-2")
        ?.name
    ).toBe("Beta 2");

    let failedRename!: Promise<boolean>;
    act(() => {
      failedRename = result.current.handleScenarioNameCommit(
        "scenario-2",
        "Beta 3"
      );
    });
    await waitFor(() => expect(requests).toHaveLength(4));
    const failedBetaRename = requests.find(
      request => request.input.patch.name === "Beta 3"
    );
    expect(failedBetaRename).toBeDefined();
    let failedRenameSaved!: boolean;
    await act(async () => {
      failedBetaRename?.pending.reject(new Error("rename failed"));
      failedRenameSaved = await failedRename;
    });

    expect(failedRenameSaved).toBe(false);
    expect(
      result.current.scenarios.find(scenario => scenario._id === "scenario-2")
        ?.name
    ).toBe("Beta 2");
  });

  it("starts sidebar mutations for different scenario IDs in parallel", async () => {
    mockFetchScenarios.mockResolvedValue([
      summary("Alpha", "2026-01-01T00:00:00.000Z", {
        _id: "scenario-1",
      }),
      summary("Beta", "2026-01-01T00:00:00.000Z", {
        _id: "scenario-2",
      }),
    ]);
    const first = deferred<ScenarioDocument>();
    const second = deferred<ScenarioDocument>();
    mockPatchScenarioSidebarRequest
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { result } = renderHook(() =>
      useScenarioWorkspaceEntity({
        workspaceId: "workspace-1",
        contextOptions: [],
        t: translate,
      })
    );
    await waitFor(() => expect(result.current.scenarios).toHaveLength(2));

    let firstSave!: Promise<boolean>;
    let secondSave!: Promise<boolean>;
    act(() => {
      firstSave = result.current.handleScenarioNameCommit(
        "scenario-1",
        "Alpha 2"
      );
      secondSave = result.current.handleScenarioNameCommit(
        "scenario-2",
        "Beta 2"
      );
    });

    await waitFor(() =>
      expect(mockPatchScenarioSidebarRequest).toHaveBeenCalledTimes(2)
    );

    await act(async () => {
      first.resolve(
        document("Alpha 2", "2026-01-01T00:00:01.000Z", {
          _id: "scenario-1",
        })
      );
      second.resolve(
        document("Beta 2", "2026-01-01T00:00:01.000Z", {
          _id: "scenario-2",
        })
      );
      await Promise.all([firstSave, secondSave]);
    });
    expect(mockPatchScenarioSidebarRequest.mock.calls).toEqual([
      [
        {
          scenarioId: "scenario-1",
          workspaceId: "workspace-1",
          patch: { name: "Alpha 2" },
        },
      ],
      [
        {
          scenarioId: "scenario-2",
          workspaceId: "workspace-1",
          patch: { name: "Beta 2" },
        },
      ],
    ]);
  });

  it("keeps graph-derived summary metadata when reconciling a sidebar response", async () => {
    mockFetchScenarios.mockResolvedValue([
      summary("Original", "2026-01-01T00:00:00.000Z", {
        nodeCount: 7,
        edgeCount: 6,
      }),
    ]);
    mockPatchScenarioSidebarRequest.mockResolvedValue(
      document("Renamed", "2026-01-01T00:00:01.000Z")
    );

    const { result } = renderHook(() =>
      useScenarioWorkspaceEntity({
        workspaceId: "workspace-1",
        contextOptions: [],
        t: translate,
      })
    );
    await waitFor(() => expect(result.current.scenarios).toHaveLength(1));

    await act(async () => {
      await result.current.handleScenarioNameCommit("scenario-1", "Renamed");
    });

    expect(result.current.scenarios[0]).toMatchObject({
      name: "Renamed",
      nodeCount: 7,
      edgeCount: 6,
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
  });
});

describe("scenario selection concurrent writers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  const initialScenarios = [
    summary("A", "2026-01-01T00:00:00.000Z", { _id: "a", priority: 2 }),
    summary("B", "2026-01-01T00:00:00.000Z", { _id: "b", priority: 1 }),
  ];
  it("waits for destination mutations started during departure flush", async () => {
    const departure = deferred<boolean>();
    const secondDeparture = deferred<boolean>();
    const destination = deferred<ScenarioDocument>();
    mockPatchScenarioSidebarRequest.mockReturnValue(destination.promise);
    const flush = jest
      .fn()
      .mockReturnValueOnce(departure.promise)
      .mockReturnValueOnce(secondDeparture.promise);
    const { result } = renderHook(() =>
      useScenarioWorkspaceEntity({
        workspaceId: "w",
        initialScenarios,
        contextOptions: [],
        t: translate,
      })
    );
    let selected!: Promise<boolean>;
    act(() => {
      selected = result.current.selectScenario("b", flush);
    });
    await waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
    let patched!: Promise<boolean>;
    act(() => {
      patched = result.current.saveScenarioPatch("b", { name: "B updated" });
    });
    await waitFor(() =>
      expect(mockPatchScenarioSidebarRequest).toHaveBeenCalledTimes(1)
    );
    await act(async () => {
      departure.resolve(true);
      await Promise.resolve();
    });
    expect(result.current.activeScenarioId).toBe("a");
    await act(async () => {
      destination.resolve(
        document("B updated", "2026-01-01T00:00:01.000Z", { _id: "b" })
      );
      await patched;
    });
    expect(flush).toHaveBeenCalledTimes(2);
    expect(result.current.activeScenarioId).toBe("a");
    await act(async () => {
      secondDeparture.resolve(true);
      expect(await selected).toBe(true);
    });
    expect(result.current.activeScenarioId).toBe("b");
  });
  it("retains confirmed active document after an older reorder recovery resolves", async () => {
    const recovery = deferred<ScenarioSummary[]>();
    mockFetchScenarios.mockReturnValue(recovery.promise);
    const { result } = renderHook(() =>
      useScenarioWorkspaceEntity({
        workspaceId: "w",
        initialScenarios,
        contextOptions: [],
        t: translate,
      })
    );
    act(() =>
      result.current.handleScenarioReorderWithSave(
        { draggedScenarioId: "b", overScenarioId: "a", placement: "before" },
        async () => false
      )
    );
    await waitFor(() => expect(mockFetchScenarios).toHaveBeenCalledTimes(1));
    act(() =>
      result.current.adoptConfirmedScenarioDocument(
        document("A saved", "2026-01-01T00:00:02.000Z", {
          _id: "a",
          priority: 2,
        })
      )
    );
    expect(result.current.scenarios.find(s => s._id === "a")?.name).toBe(
      "A saved"
    );
    await act(async () => {
      recovery.resolve(initialScenarios);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.loadingScenarios).toBe(false));
    expect(result.current.scenarios.find(s => s._id === "a")?.name).toBe(
      "A saved"
    );
  });
});

describe("reorder recovery with concurrent document commits", () => {
  it("preserves a confirmed document received before reorder failure", async () => {
    const pendingWrite = deferred<boolean>();
    const recovery = deferred<ScenarioSummary[]>();
    mockFetchScenarios.mockReturnValue(recovery.promise);
    const initialScenarios = [
      summary("A", "2026-01-01T00:00:00.000Z", { _id: "a", priority: 2 }),
      summary("B", "2026-01-01T00:00:00.000Z", { _id: "b", priority: 1 }),
    ];
    const { result } = renderHook(() =>
      useScenarioWorkspaceEntity({
        workspaceId: "w",
        initialScenarios,
        contextOptions: [],
        t: translate,
      })
    );
    act(() =>
      result.current.handleScenarioReorderWithSave(
        { draggedScenarioId: "b", overScenarioId: "a", placement: "before" },
        () => pendingWrite.promise
      )
    );
    act(() =>
      result.current.adoptConfirmedScenarioDocument(
        document("A saved", "2026-01-01T00:00:02.000Z", {
          _id: "a",
          priority: 2,
        })
      )
    );
    expect(result.current.scenarios.find(s => s._id === "a")?.name).toBe(
      "A saved"
    );
    await act(async () => {
      pendingWrite.resolve(false);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.loadingScenarios).toBe(true));
    expect(result.current.scenarios.find(s => s._id === "a")?.name).toBe(
      "A saved"
    );
  });
});
