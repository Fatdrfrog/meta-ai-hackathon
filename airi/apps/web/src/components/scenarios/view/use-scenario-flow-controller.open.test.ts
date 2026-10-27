/**
 * @jest-environment jsdom
 */

import {
  fetchScenarioById,
  updateScenarioRequest,
} from "@/lib/scenarios/client/crud";
import { prefetchScenarioDetail } from "@/lib/scenarios/client/scenario-detail-sources";
import {
  noteConfirmedScenarioRevision,
  trackScenarioWrite,
} from "@/lib/scenarios/client/scenario-revision-tracker";
import type { InitialScenarioDetail } from "@/lib/scenarios/initial-scenario-detail";
import { migrateLegacyTriggerNodeData } from "@/lib/scenarios/legacy-trigger-adapter";
import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { scenarioEditorChunks } from "../scenario-editor-chunks";
import type { ScenarioDocument, ScenarioFlowNode } from "../types";
import { INITIAL_SCENARIO_DETAIL_WAIT_MS } from "./scenario-flow-detail-source";
import { useScenarioFlowController } from "./use-scenario-flow-controller";
import { scenarioDocument } from "./scenario-controller-test-utils";

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
jest.mock("@/lib/scenarios/legacy-trigger-adapter", () => {
  const actual = jest.requireActual("@/lib/scenarios/legacy-trigger-adapter");
  return {
    ...actual,
    migrateLegacyTriggerNodeData: jest.fn(actual.migrateLegacyTriggerNodeData),
  };
});
jest.mock("../scenario-editor-chunks", () =>
  jest
    .requireActual("./scenario-controller-test-utils")
    .scenarioEditorChunksMock(() => jest.fn(() => new Promise(() => {})))
);

const mockFetchScenarioById = jest.mocked(fetchScenarioById);
const mockUpdateScenarioRequest = jest.mocked(updateScenarioRequest);
const mockMigrateTrigger = jest.mocked(migrateLegacyTriggerNodeData);

const REVISION = "2026-01-01T00:00:00.000Z";

function detailOf(scenario: ScenarioDocument) {
  return { scenario, metadata: { linkedConditionParentCountByNodeId: {} } };
}

function pageRead(
  scenario: ScenarioDocument,
  loadedAt = Date.now()
): InitialScenarioDetail {
  return {
    scenarioId: scenario._id,
    loadedAt,
    response: JSON.parse(JSON.stringify(detailOf(scenario))),
  };
}

type Props = {
  activeScenarioId: string;
  updatedAt: string;
  initialScenarioDetail?: PromiseLike<InitialScenarioDetail | null> | null;
};

// Stable across renders, as the workspace controller's are.
const setEntryPriorityInput = jest.fn();
const setScenarios = jest.fn();
const onScenarioDocumentConfirmed = jest.fn();
const t = (key: string) => key;

function renderController(
  initialProps: Props,
  options: { wrapper?: typeof StrictMode } = {}
) {
  return renderHook(
    (props: Props) =>
      useScenarioFlowController({
        workspaceId: "workspace-1",
        activeScenarioId: props.activeScenarioId,
        activeScenario: {
          _id: props.activeScenarioId,
          name: props.activeScenarioId,
          description: "",
          status: "draft",
          mode: "conversation",
          timezone: null,
          priority: 0,
          matchingRole: "default",
          entryPolicy: "repeatable",
          nodeCount: 0,
          edgeCount: 0,
          createdAt: REVISION,
          updatedAt: props.updatedAt,
        },
        activeScenarioName: props.activeScenarioId,
        activeScenarioDescription: "",
        activeScenarioStatus: "draft",
        entryPriorityInput: "0",
        setEntryPriorityInput,
        setScenarios,
        onScenarioDocumentConfirmed,
        t,
        initialScenarioDetail: props.initialScenarioDetail,
      }),
    { initialProps, ...options }
  );
}

function onlyTrigger(id: string) {
  return [
    {
      id,
      position: { x: 0, y: 0 },
      data: { kind: "trigger", triggerConfig: { enabled: true } },
    },
  ] as ScenarioFlowNode[];
}

/** Scenario writes at a past time stay out of other tests' usable ages. */
function startPastClock() {
  jest.useFakeTimers({ now: new Date("2020-01-01T00:00:00.000Z") });
}

async function settle() {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
}

describe("opening a scenario", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("shows the page's own read of the opened scenario without asking again", async () => {
    const scenario = scenarioDocument("open-1");
    const { result } = renderController({
      activeScenarioId: "open-1",
      updatedAt: REVISION,
      initialScenarioDetail: Promise.resolve(pageRead(scenario)),
    });
    expect(result.current.loadingFlow).toBe(true);
    await settle();

    expect(mockFetchScenarioById).not.toHaveBeenCalled();
    expect(result.current.loadingFlow).toBe(false);
    expect(result.current.nodes.map(node => node.id)).toEqual([
      "trigger-1",
      "template-1",
    ]);
    expect(result.current.saveStatus).toBe("saved");
  });

  it.each([
    [
      "is too old",
      (scenario: ScenarioDocument) => pageRead(scenario, Date.now() - 61_000),
    ],
    [
      "belongs to another scenario",
      (scenario: ScenarioDocument) =>
        pageRead({ ...scenario, _id: "elsewhere" }),
    ],
    ["is missing", () => null],
  ])("asks the server when the page's read %s", async (_label, read) => {
    const scenario = scenarioDocument("open-2");
    mockFetchScenarioById.mockResolvedValue(detailOf(scenario) as never);
    const { result } = renderController({
      activeScenarioId: "open-2",
      updatedAt: REVISION,
      initialScenarioDetail: Promise.resolve(read(scenario)),
    });
    await settle();

    expect(mockFetchScenarioById).toHaveBeenCalledTimes(1);
    expect(mockFetchScenarioById).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioId: "open-2",
        workspaceId: "workspace-1",
        mediaSigning: "deferred",
      })
    );
    expect(result.current.nodes).toHaveLength(2);
  });

  it("asks the server when the page's read is slow to arrive", async () => {
    jest.useFakeTimers();
    try {
      const scenario = scenarioDocument("open-slow");
      mockFetchScenarioById.mockResolvedValue(detailOf(scenario) as never);
      const { result } = renderController({
        activeScenarioId: "open-slow",
        updatedAt: REVISION,
        initialScenarioDetail: new Promise(() => {}),
      });
      await settle();
      expect(mockFetchScenarioById).not.toHaveBeenCalled();

      await act(async () => {
        jest.advanceTimersByTime(INITIAL_SCENARIO_DETAIL_WAIT_MS);
      });
      await settle();

      expect(mockFetchScenarioById).toHaveBeenCalledTimes(1);
      expect(result.current.loadingFlow).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not show a replayed page read again after the editor remounts", async () => {
    const scenario = scenarioDocument("open-3");
    const replayed = Promise.resolve(pageRead(scenario));
    const first = renderController({
      activeScenarioId: "open-3",
      updatedAt: REVISION,
      initialScenarioDetail: replayed,
    });
    await settle();
    expect(mockFetchScenarioById).not.toHaveBeenCalled();
    first.unmount();

    mockFetchScenarioById.mockResolvedValue(detailOf(scenario) as never);
    renderController({
      activeScenarioId: "open-3",
      updatedAt: REVISION,
      initialScenarioDetail: replayed,
    });
    await settle();
    expect(mockFetchScenarioById).toHaveBeenCalledTimes(1);
  });

  it("does not show a page read older than a revision this tab saved", async () => {
    const scenario = scenarioDocument("open-4");
    noteConfirmedScenarioRevision("open-4", "2026-02-01T00:00:00.000Z");
    mockFetchScenarioById.mockResolvedValue(
      detailOf({ ...scenario, updatedAt: "2026-02-01T00:00:00.000Z" }) as never
    );
    renderController({
      activeScenarioId: "open-4",
      updatedAt: REVISION,
      initialScenarioDetail: Promise.resolve(pageRead(scenario)),
    });
    await settle();
    expect(mockFetchScenarioById).toHaveBeenCalledTimes(1);
  });

  it("starts the editors the loaded cards need, and normalizes the graph once", async () => {
    const scenario = scenarioDocument("open-5");
    mockFetchScenarioById.mockResolvedValue(detailOf(scenario) as never);
    renderController({ activeScenarioId: "open-5", updatedAt: REVISION });
    await settle();

    expect(
      scenarioEditorChunks.whatsAppTemplateSection.preload
    ).toHaveBeenCalled();
    expect(
      scenarioEditorChunks.whatsAppInlineEditor.preload
    ).toHaveBeenCalled();
    expect(scenarioEditorChunks.bulkRootNode.preload).not.toHaveBeenCalled();
    // One trigger node: migrated once per load, not once more for the viewport.
    expect(mockMigrateTrigger).toHaveBeenCalledTimes(1);
  });

  it("opens a scenario read ahead from the sidebar while it matches the list entry", async () => {
    mockFetchScenarioById.mockResolvedValueOnce(
      detailOf(scenarioDocument("ahead-1")) as never
    );
    const { result, rerender } = renderController({
      activeScenarioId: "ahead-1",
      updatedAt: REVISION,
    });
    await settle();

    const next = scenarioDocument("ahead-2", {
      nodes: [
        {
          id: "only-trigger",
          position: { x: 0, y: 0 },
          data: { kind: "trigger", triggerConfig: { enabled: true } },
        },
      ] as ScenarioFlowNode[],
    });
    mockFetchScenarioById.mockResolvedValueOnce(detailOf(next) as never);
    prefetchScenarioDetail({
      workspaceId: "workspace-1",
      scenarioId: "ahead-2",
    });
    expect(mockFetchScenarioById).toHaveBeenCalledTimes(2);

    rerender({ activeScenarioId: "ahead-2", updatedAt: REVISION });
    await settle();

    expect(mockFetchScenarioById).toHaveBeenCalledTimes(2);
    expect(result.current.nodes.map(node => node.id)).toEqual(["only-trigger"]);
  });

  it("asks again when the read-ahead no longer matches the list entry", async () => {
    mockFetchScenarioById.mockResolvedValueOnce(
      detailOf(scenarioDocument("ahead-3")) as never
    );
    const { rerender } = renderController({
      activeScenarioId: "ahead-3",
      updatedAt: REVISION,
    });
    await settle();

    mockFetchScenarioById.mockResolvedValueOnce(
      detailOf(scenarioDocument("ahead-4")) as never
    );
    prefetchScenarioDetail({
      workspaceId: "workspace-1",
      scenarioId: "ahead-4",
    });
    mockFetchScenarioById.mockResolvedValueOnce(
      detailOf(
        scenarioDocument("ahead-4", { updatedAt: "2026-01-02T00:00:00.000Z" })
      ) as never
    );
    rerender({
      activeScenarioId: "ahead-4",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    await settle();

    expect(mockFetchScenarioById).toHaveBeenCalledTimes(3);
    expect(mockUpdateScenarioRequest).not.toHaveBeenCalled();
  });

  it("opens a read-ahead newer than the list entry without asking again", async () => {
    mockFetchScenarioById.mockResolvedValueOnce(
      detailOf(scenarioDocument("ahead-7")) as never
    );
    const { result, rerender } = renderController({
      activeScenarioId: "ahead-7",
      updatedAt: REVISION,
    });
    await settle();

    // Another tab saved the scenario after this tab listed it.
    mockFetchScenarioById.mockResolvedValueOnce(
      detailOf(
        scenarioDocument("ahead-8", {
          updatedAt: "2026-01-03T00:00:00.000Z",
          nodes: onlyTrigger("newer-trigger"),
        })
      ) as never
    );
    prefetchScenarioDetail({
      workspaceId: "workspace-1",
      scenarioId: "ahead-8",
    });
    rerender({ activeScenarioId: "ahead-8", updatedAt: REVISION });
    await settle();

    expect(mockFetchScenarioById).toHaveBeenCalledTimes(2);
    expect(result.current.nodes.map(node => node.id)).toEqual([
      "newer-trigger",
    ]);
  });

  it("asks again when a scenario write overlapped the read-ahead", async () => {
    startPastClock();
    try {
      mockFetchScenarioById.mockResolvedValueOnce(
        detailOf(scenarioDocument("ahead-5")) as never
      );
      const { result, rerender } = renderController({
        activeScenarioId: "ahead-5",
        updatedAt: REVISION,
      });
      await settle();

      let answer!: (value: unknown) => void;
      mockFetchScenarioById.mockReturnValueOnce(
        new Promise(resolve => {
          answer = resolve;
        }) as never
      );
      prefetchScenarioDetail({
        workspaceId: "workspace-1",
        scenarioId: "ahead-6",
      });
      // The departing scenario's save runs while the read-ahead is out.
      await act(async () => {
        await trackScenarioWrite(Promise.resolve());
      });
      answer(
        detailOf(
          scenarioDocument("ahead-6", { nodes: onlyTrigger("before-write") })
        )
      );
      mockFetchScenarioById.mockResolvedValueOnce(
        detailOf(
          scenarioDocument("ahead-6", { nodes: onlyTrigger("after-write") })
        ) as never
      );
      rerender({ activeScenarioId: "ahead-6", updatedAt: REVISION });
      await settle();

      expect(mockFetchScenarioById).toHaveBeenCalledTimes(3);
      expect(result.current.nodes.map(node => node.id)).toEqual([
        "after-write",
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("adopts the page's read under doubled StrictMode effects without asking again", async () => {
    const scenario = scenarioDocument("open-strict");
    const { result } = renderController(
      {
        activeScenarioId: "open-strict",
        updatedAt: REVISION,
        initialScenarioDetail: Promise.resolve(pageRead(scenario)),
      },
      { wrapper: StrictMode }
    );
    await settle();

    expect(mockFetchScenarioById).not.toHaveBeenCalled();
    expect(result.current.loadingFlow).toBe(false);
    expect(result.current.nodes.map(node => node.id)).toEqual([
      "trigger-1",
      "template-1",
    ]);
  });

  it("takes a late page read that arrives while its own read is still out", async () => {
    jest.useFakeTimers();
    try {
      const scenario = scenarioDocument("open-race-1");
      const signals: AbortSignal[] = [];
      mockFetchScenarioById.mockImplementation(({ signal }) => {
        if (signal) signals.push(signal);
        return new Promise(() => {}) as never;
      });
      let deliver!: (value: InitialScenarioDetail) => void;
      const { result } = renderController({
        activeScenarioId: "open-race-1",
        updatedAt: REVISION,
        initialScenarioDetail: new Promise(resolve => {
          deliver = resolve;
        }),
      });
      await settle();
      await act(async () => {
        jest.advanceTimersByTime(INITIAL_SCENARIO_DETAIL_WAIT_MS);
      });
      await settle();
      expect(mockFetchScenarioById).toHaveBeenCalledTimes(1);
      expect(result.current.loadingFlow).toBe(true);

      await act(async () => {
        deliver(pageRead(scenario));
      });
      await settle();

      expect(result.current.loadingFlow).toBe(false);
      expect(result.current.nodes.map(node => node.id)).toEqual([
        "trigger-1",
        "template-1",
      ]);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
    } finally {
      mockFetchScenarioById.mockReset();
      jest.useRealTimers();
    }
  });

  it("keeps its own read when that answers first, and never the late page read", async () => {
    jest.useFakeTimers();
    try {
      const own = scenarioDocument("open-race-2", {
        nodes: onlyTrigger("own-read"),
      });
      mockFetchScenarioById.mockResolvedValue(detailOf(own) as never);
      let deliver!: (value: InitialScenarioDetail) => void;
      const replayed = new Promise<InitialScenarioDetail | null>(resolve => {
        deliver = resolve;
      });
      const first = renderController({
        activeScenarioId: "open-race-2",
        updatedAt: REVISION,
        initialScenarioDetail: replayed,
      });
      await settle();
      await act(async () => {
        jest.advanceTimersByTime(INITIAL_SCENARIO_DETAIL_WAIT_MS);
      });
      await settle();
      expect(first.result.current.nodes.map(node => node.id)).toEqual([
        "own-read",
      ]);

      await act(async () => {
        deliver(pageRead(scenarioDocument("open-race-2")));
      });
      await settle();
      expect(first.result.current.nodes.map(node => node.id)).toEqual([
        "own-read",
      ]);
      first.unmount();

      renderController({
        activeScenarioId: "open-race-2",
        updatedAt: REVISION,
        initialScenarioDetail: replayed,
      });
      await settle();
      expect(mockFetchScenarioById).toHaveBeenCalledTimes(2);
    } finally {
      mockFetchScenarioById.mockReset();
      jest.useRealTimers();
    }
  });

  it("asks the server when this tab wrote a scenario after the page may have read", async () => {
    startPastClock();
    try {
      let finish!: () => void;
      const write = trackScenarioWrite(
        new Promise<void>(resolve => {
          finish = resolve;
        })
      );
      const running = scenarioDocument("open-write-1");
      mockFetchScenarioById.mockResolvedValueOnce(detailOf(running) as never);
      const first = renderController({
        activeScenarioId: "open-write-1",
        updatedAt: REVISION,
        initialScenarioDetail: Promise.resolve(pageRead(running)),
      });
      await settle();
      expect(mockFetchScenarioById).toHaveBeenCalledTimes(1);
      first.unmount();

      await act(async () => {
        finish();
        await write;
      });
      const settled = scenarioDocument("open-write-2");
      mockFetchScenarioById.mockResolvedValueOnce(detailOf(settled) as never);
      renderController({
        activeScenarioId: "open-write-2",
        updatedAt: REVISION,
        initialScenarioDetail: Promise.resolve(pageRead(settled)),
      });
      await settle();
      expect(mockFetchScenarioById).toHaveBeenCalledTimes(2);
      expect(mockFetchScenarioById).toHaveBeenLastCalledWith(
        expect.objectContaining({ scenarioId: "open-write-2" })
      );
    } finally {
      jest.useRealTimers();
    }
  });
});
