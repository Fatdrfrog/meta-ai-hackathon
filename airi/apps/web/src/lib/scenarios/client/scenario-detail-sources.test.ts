import { INITIAL_SCENARIO_DETAIL_MAX_AGE_MS } from "@/lib/scenarios/initial-scenario-detail";
import { fetchScenarioById } from "./crud";
import {
  claimInitialScenarioDetail,
  forgoInitialScenarioDetail,
  prefetchScenarioDetail,
  SCENARIO_DETAIL_PREFETCH_MAX_AGE_MS,
  takePrefetchedScenarioDetail,
} from "./scenario-detail-sources";
import {
  noteConfirmedScenarioRevision,
  trackScenarioWrite,
} from "./scenario-revision-tracker";

jest.mock("./crud", () => ({ fetchScenarioById: jest.fn() }));

const mockFetchScenarioById = jest.mocked(fetchScenarioById);

function detail(scenarioId: string, updatedAt = "2026-01-01T00:00:00.000Z") {
  return {
    scenario: {
      _id: scenarioId,
      name: "Scenario",
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
      updatedAt,
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    },
    metadata: { linkedConditionParentCountByNodeId: {} },
  };
}

function initial(scenarioId: string, loadedAt: number, updatedAt?: string) {
  return {
    scenarioId,
    loadedAt,
    response: detail(scenarioId, updatedAt),
  } as never;
}

describe("claimInitialScenarioDetail", () => {
  // Later than any write other tests settle on the real clock.
  const now = 4_000_000_000_000;

  it("hands over the page's read of the opened scenario once", () => {
    const value = initial("init-1", now - 1000);
    const source = Promise.resolve(value);
    expect(
      claimInitialScenarioDetail(source, value, { scenarioId: "init-1", now })
    ).toMatchObject({ scenario: { _id: "init-1" } });
    expect(
      claimInitialScenarioDetail(source, value, { scenarioId: "init-1", now })
    ).toBeNull();
    // A replayed page payload that resolves to the same read is not reused.
    expect(
      claimInitialScenarioDetail(Promise.resolve(value), value, {
        scenarioId: "init-1",
        now,
      })
    ).toBeNull();
  });

  it("ignores a read of another scenario or an old one", () => {
    const other = initial("init-2", now);
    expect(
      claimInitialScenarioDetail(Promise.resolve(other), other, {
        scenarioId: "init-3",
        now,
      })
    ).toBeNull();
    const old = initial("init-4", now - INITIAL_SCENARIO_DETAIL_MAX_AGE_MS - 1);
    expect(
      claimInitialScenarioDetail(Promise.resolve(old), old, {
        scenarioId: "init-4",
        now,
      })
    ).toBeNull();
  });

  it("treats a server clock ahead of the browser's as fresh", () => {
    const ahead = initial("init-5", now + 90_000);
    expect(
      claimInitialScenarioDetail(Promise.resolve(ahead), ahead, {
        scenarioId: "init-5",
        now,
      })
    ).not.toBeNull();
  });

  it("ignores a read older than a revision this tab already confirmed", () => {
    noteConfirmedScenarioRevision("init-6", "2026-02-01T00:00:00.000Z");
    const stale = initial("init-6", now, "2026-01-15T00:00:00.000Z");
    expect(
      claimInitialScenarioDetail(Promise.resolve(stale), stale, {
        scenarioId: "init-6",
        now,
      })
    ).toBeNull();
  });

  it("never hands over a read the editor gave up", () => {
    const value = initial("init-9", now);
    const source = Promise.resolve(value);
    forgoInitialScenarioDetail(source);
    expect(
      claimInitialScenarioDetail(source, value, { scenarioId: "init-9", now })
    ).toBeNull();
  });

  it("ignores the page's read while a scenario write runs or settled within its usable age", async () => {
    jest.useFakeTimers({ now: new Date("2021-01-01T00:00:00.000Z") });
    try {
      const writeTime = Date.now();
      let finish!: () => void;
      const write = trackScenarioWrite(
        new Promise<void>(resolve => {
          finish = resolve;
        })
      );
      const running = initial("init-10", writeTime);
      expect(
        claimInitialScenarioDetail(Promise.resolve(running), running, {
          scenarioId: "init-10",
          now: writeTime,
        })
      ).toBeNull();

      finish();
      await write;
      const usableAgeLater = writeTime + INITIAL_SCENARIO_DETAIL_MAX_AGE_MS;
      const recent = initial("init-11", usableAgeLater);
      expect(
        claimInitialScenarioDetail(Promise.resolve(recent), recent, {
          scenarioId: "init-11",
          now: usableAgeLater,
        })
      ).toBeNull();
      const later = initial("init-12", usableAgeLater + 1);
      expect(
        claimInitialScenarioDetail(Promise.resolve(later), later, {
          scenarioId: "init-12",
          now: usableAgeLater + 1,
        })
      ).not.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it("resolves nothing for a missing or malformed read", () => {
    expect(
      claimInitialScenarioDetail(Promise.resolve(null), null, {
        scenarioId: "init-7",
        now,
      })
    ).toBeNull();
    const malformed = {
      scenarioId: "init-8",
      loadedAt: now,
      response: { scenario: { _id: "init-8" } },
    } as never;
    expect(
      claimInitialScenarioDetail(Promise.resolve(malformed), malformed, {
        scenarioId: "init-8",
        now,
      })
    ).toBeNull();
  });
});

describe("scenario detail prefetch", () => {
  const now = 1_800_000_000_000;

  beforeEach(() => {
    mockFetchScenarioById.mockReset();
  });

  it("reads once with deferred media signing and hands the read to the open", async () => {
    mockFetchScenarioById.mockResolvedValue(detail("pre-1") as never);
    prefetchScenarioDetail({ workspaceId: "w", scenarioId: "pre-1", now });
    prefetchScenarioDetail({ workspaceId: "w", scenarioId: "pre-1", now });
    expect(mockFetchScenarioById).toHaveBeenCalledTimes(1);
    expect(mockFetchScenarioById).toHaveBeenCalledWith({
      workspaceId: "w",
      scenarioId: "pre-1",
      mediaSigning: "deferred",
    });

    await expect(
      takePrefetchedScenarioDetail({
        workspaceId: "w",
        scenarioId: "pre-1",
        now: now + 1000,
      })
    ).resolves.toMatchObject({ scenario: { _id: "pre-1" } });
    // Taken reads are not handed out again.
    await expect(
      takePrefetchedScenarioDetail({
        workspaceId: "w",
        scenarioId: "pre-1",
        now,
      })
    ).resolves.toBeNull();
  });

  it("drops a read older than its usable age", async () => {
    mockFetchScenarioById.mockResolvedValue(detail("pre-2") as never);
    prefetchScenarioDetail({ workspaceId: "w", scenarioId: "pre-2", now });
    await expect(
      takePrefetchedScenarioDetail({
        workspaceId: "w",
        scenarioId: "pre-2",
        now: now + SCENARIO_DETAIL_PREFETCH_MAX_AGE_MS,
      })
    ).resolves.toBeNull();
  });

  it("drops a read when a scenario write started after it began", async () => {
    mockFetchScenarioById.mockResolvedValue(detail("pre-3") as never);
    prefetchScenarioDetail({ workspaceId: "w", scenarioId: "pre-3", now });
    await trackScenarioWrite(Promise.resolve());
    await expect(
      takePrefetchedScenarioDetail({
        workspaceId: "w",
        scenarioId: "pre-3",
        now,
      })
    ).resolves.toBeNull();
  });

  it("drops a read a write overlapped before it answered", async () => {
    let answer!: (value: unknown) => void;
    mockFetchScenarioById.mockReturnValue(
      new Promise(resolve => {
        answer = resolve;
      }) as never
    );
    prefetchScenarioDetail({ workspaceId: "w", scenarioId: "pre-4", now });
    const taken = takePrefetchedScenarioDetail({
      workspaceId: "w",
      scenarioId: "pre-4",
      now,
    });
    await trackScenarioWrite(Promise.resolve());
    answer(detail("pre-4"));
    await expect(taken).resolves.toBeNull();
  });

  it("does not read while a scenario write is in flight", async () => {
    let finish!: () => void;
    const write = trackScenarioWrite(
      new Promise<void>(resolve => {
        finish = resolve;
      })
    );
    prefetchScenarioDetail({ workspaceId: "w", scenarioId: "pre-5", now });
    expect(mockFetchScenarioById).not.toHaveBeenCalled();
    finish();
    await write;
  });

  it("hands over nothing when the read failed", async () => {
    mockFetchScenarioById.mockRejectedValue(new Error("offline"));
    prefetchScenarioDetail({ workspaceId: "w", scenarioId: "pre-6", now });
    await expect(
      takePrefetchedScenarioDetail({
        workspaceId: "w",
        scenarioId: "pre-6",
        now,
      })
    ).resolves.toBeNull();
  });
});
