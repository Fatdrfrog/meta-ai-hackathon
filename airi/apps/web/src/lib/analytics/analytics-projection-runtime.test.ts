jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("./service-lifecycle-consumer", () => ({
  ...jest.requireActual("./service-lifecycle-consumer"),
  watchServiceLifecycle: jest.fn(),
}));
jest.mock("./customer-stage-consumer", () => ({
  watchCustomerStageTransitions: jest.fn(),
}));
import {
  ANALYTICS_STOP_DEADLINE_MS,
  createAnalyticsProjectionRunner,
  startAnalyticsProjectionRuntime,
  type AnalyticsProjectionDependencies,
} from "./analytics-projection-runtime";
import type { AnalyticsProviderSourceCounts } from "./acquisition-projector";
import { watchServiceLifecycle } from "./service-lifecycle-consumer";
import { watchCustomerStageTransitions } from "./customer-stage-consumer";

const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
];
function fixture() {
  const checkpoint = {
    cursorId: null as string | null,
    through: null as Date | null,
  };
  const discoveryLease = {
    checkpoint,
    update: jest.fn(async (fields: Record<string, unknown>) => {
      Object.assign(checkpoint, fields);
    }),
    stop: jest.fn(async () => undefined),
    assertOwned: jest.fn(async () => undefined),
  };
  const providerLease = {
    ...discoveryLease,
    checkpoint: {
      cursorId: null as string | null,
      through: null as Date | null,
      providerSources: null as AnalyticsProviderSourceCounts | null,
    },
    update: jest.fn(async (_fields: Record<string, unknown>) => undefined),
    stop: jest.fn(async () => undefined),
    assertOwned: jest.fn(async () => undefined),
  };
  const deps = {
    streams: ["messages", "conversions"] as const,
    discover: jest.fn(async (_afterId: string | null, _limit: number) => ({
      ids,
      lastId: ids[2],
      hasMore: false,
    })),
    acquireDiscovery: jest.fn(
      async (_signal: AbortSignal): Promise<typeof discoveryLease | null> =>
        discoveryLease
    ),
    acquireProvider: jest.fn(
      async (_workspaceId: string, _signal: AbortSignal) => providerLease
    ),
    project: jest.fn(
      async (
        _input: Parameters<AnalyticsProjectionDependencies["project"]>[0]
      ) => ({ status: "idle", processed: 0 })
    ),
    snapshots: jest.fn(
      async (
        _workspaceId: string,
        _signal: AbortSignal
      ): Promise<{ scanned: number; complete: boolean } | void> => undefined
    ),
    syncProvider: jest.fn(
      async (
        _input: Parameters<AnalyticsProjectionDependencies["syncProvider"]>[0]
      ): ReturnType<AnalyticsProjectionDependencies["syncProvider"]> => ({
        hasMore: false,
        nextSourceId: null,
      })
    ),
    logger: { info: jest.fn(), error: jest.fn() },
    now: () => new Date("2026-10-02T12:00:00Z"),
    resetWorkspace: jest.fn(async (_workspaceId: string) => undefined),
  };
  return { deps, discoveryLease, providerLease };
}

test("discovery stays bounded, rotates every workspace and checkpoints only the completed page", async () => {
  const f = fixture();
  await createAnalyticsProjectionRunner(f.deps).runPass(
    new AbortController().signal
  );
  expect(f.deps.discover).toHaveBeenCalledWith(null, 50);
  expect(f.deps.project.mock.calls.map(([input]) => input.workspaceId)).toEqual(
    [ids[0], ids[0], ids[1], ids[1], ids[2], ids[2]]
  );
  expect(f.deps.project).toHaveBeenCalledWith(
    expect.objectContaining({ stream: "conversions", batchSize: 25 })
  );
  expect(f.discoveryLease.update).toHaveBeenLastCalledWith(
    expect.objectContaining({ cursorId: null })
  );
  expect(f.discoveryLease.stop).toHaveBeenCalledTimes(1);
});

test("one failed stream cannot starve another stream or the next workspace", async () => {
  const f = fixture();
  f.deps.project.mockRejectedValueOnce(new Error("unavailable"));
  await createAnalyticsProjectionRunner(f.deps).runPass(
    new AbortController().signal
  );
  expect(f.deps.project).toHaveBeenCalledTimes(6);
  expect(f.deps.logger.error).toHaveBeenCalledWith(
    "analytics.projection_degraded",
    { name: "Error", message: "unavailable" },
    expect.objectContaining({ phase: "messages", workspaceId: ids[0] })
  );
});

test("degradation logs keep the sanitized cause instead of a generic error", async () => {
  const f = fixture();
  f.deps.discover.mockResolvedValueOnce({
    ids: [ids[0]],
    lastId: ids[0],
    hasMore: false,
  });
  f.deps.project.mockRejectedValueOnce(
    Object.assign(
      new Error(
        "connection <monitor> to mongodb://user:secret@db.example:27017 closed"
      ),
      { name: "MongoNetworkError", code: 89, codeName: "NetworkTimeout" }
    )
  );
  f.deps.snapshots.mockRejectedValueOnce(new Error("snapshot cursor lost"));
  await createAnalyticsProjectionRunner(f.deps).runPass(
    new AbortController().signal
  );
  expect(f.deps.logger.error).toHaveBeenCalledWith(
    "analytics.projection_degraded",
    {
      name: "MongoNetworkError",
      code: 89,
      codeName: "NetworkTimeout",
      message: "connection <monitor> to [url] closed",
    },
    { workspaceId: ids[0], phase: "messages" }
  );
  expect(f.deps.logger.error).toHaveBeenCalledWith(
    "analytics.projection_degraded",
    { name: "Error", message: "snapshot cursor lost" },
    { workspaceId: ids[0], phase: "snapshot_recovery" }
  );
  expect(JSON.stringify(f.deps.logger.error.mock.calls)).not.toContain(
    "secret"
  );
});

test("backfilling streams keep paging round-robin inside the visit budget, then the sweep moves on", async () => {
  const f = fixture();
  let clock = Date.parse("2026-10-02T12:00:00Z");
  f.deps.now = () => new Date(clock);
  f.deps.project.mockImplementation(async input => {
    clock += 10_000;
    return {
      status:
        input.workspaceId === ids[0] && input.stream === "messages"
          ? "backfilling"
          : "caught_up",
      processed: 500,
    };
  });
  await createAnalyticsProjectionRunner(f.deps).runPass(
    new AbortController().signal
  );
  // 45 s budget: the first round always runs; extra messages pages stop once it is spent.
  expect(
    f.deps.project.mock.calls.map(([input]) => [
      input.workspaceId,
      input.stream,
    ])
  ).toEqual([
    [ids[0], "messages"],
    [ids[0], "conversions"],
    [ids[0], "messages"],
    [ids[0], "messages"],
    [ids[0], "messages"],
    [ids[1], "messages"],
    [ids[1], "conversions"],
    [ids[2], "messages"],
    [ids[2], "conversions"],
  ]);
  expect(f.discoveryLease.assertOwned).toHaveBeenCalledTimes(6);
  expect(f.discoveryLease.update).toHaveBeenLastCalledWith(
    expect.objectContaining({ cursorId: null })
  );
});

test("a backfilling stream that moved no rows is not re-paged within the visit", async () => {
  const f = fixture();
  let clock = Date.parse("2026-10-02T12:00:00Z");
  f.deps.now = () => new Date(clock);
  f.deps.discover.mockResolvedValue({
    ids: [ids[0]],
    lastId: ids[0],
    hasMore: false,
  });
  // Another owner still holds the outstanding conversion claims.
  f.deps.project.mockImplementation(async input => {
    clock += 800;
    return input.stream === "conversions"
      ? { status: "backfilling", processed: 0 }
      : { status: "caught_up", processed: 3 };
  });
  await createAnalyticsProjectionRunner(f.deps).runPass(
    new AbortController().signal
  );
  expect(f.deps.project.mock.calls.map(([input]) => input.stream)).toEqual([
    "messages",
    "conversions",
  ]);
  expect(f.discoveryLease.assertOwned).toHaveBeenCalledTimes(1);
});

test("abort stops extra backfill pages and a lost discovery fence stops the visit", async () => {
  const f = fixture(),
    abort = new AbortController();
  let pages = 0;
  f.deps.project.mockImplementation(async () => {
    if (++pages === 3) abort.abort();
    return { status: "backfilling", processed: 500 };
  });
  await createAnalyticsProjectionRunner(f.deps).runPass(abort.signal);
  expect(f.deps.project).toHaveBeenCalledTimes(3);
  expect(f.discoveryLease.update).not.toHaveBeenCalled();

  const lost = fixture();
  lost.deps.project.mockResolvedValue({ status: "backfilling", processed: 1 });
  lost.discoveryLease.assertOwned
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("lease lost"));
  await expect(
    createAnalyticsProjectionRunner(lost.deps).runPass(
      new AbortController().signal
    )
  ).rejects.toThrow("lease lost");
  expect(lost.deps.project).toHaveBeenCalledTimes(2);
});

test("snapshot recovery continues inside the visit budget only while it makes progress", async () => {
  const f = fixture();
  f.deps.discover.mockResolvedValue({
    ids: [ids[0]],
    lastId: ids[0],
    hasMore: false,
  });
  f.deps.snapshots
    .mockResolvedValueOnce({ scanned: 500, complete: false })
    .mockResolvedValueOnce({ scanned: 500, complete: false })
    .mockResolvedValueOnce({ scanned: 20, complete: true });
  const runner = createAnalyticsProjectionRunner(f.deps);
  await runner.runPass(new AbortController().signal);
  expect(f.deps.snapshots).toHaveBeenCalledTimes(3);
  expect(f.deps.snapshots).toHaveBeenCalledWith(
    ids[0],
    expect.any(AbortSignal)
  );

  f.deps.snapshots.mockClear();
  // A busy (lease held elsewhere) batch makes no progress and is not retried in a loop.
  f.deps.snapshots.mockResolvedValue({ scanned: 0, complete: false });
  await runner.runPass(new AbortController().signal);
  expect(f.deps.snapshots).toHaveBeenCalledTimes(1);
});

test("provider sync records why sources were not collected, summed across one sweep", async () => {
  const f = fixture();
  f.deps.discover.mockResolvedValue({
    ids: [ids[0]],
    lastId: ids[0],
    hasMore: false,
  });
  f.providerLease.checkpoint.cursorId = ids[1];
  f.providerLease.checkpoint.providerSources = {
    processed: 5,
    available: 5,
    unavailable: 0,
    activationRequired: 4,
  };
  f.deps.syncProvider.mockResolvedValueOnce({
    hasMore: false,
    nextSourceId: null,
    processed: 4,
    available: 1,
    unavailable: 3,
    activationRequired: 1,
  });
  const runner = createAnalyticsProjectionRunner(f.deps);
  await runner.runPass(new AbortController().signal);
  const totals = {
    processed: 9,
    available: 6,
    unavailable: 3,
    activationRequired: 5,
  };
  expect(f.providerLease.update).toHaveBeenCalledWith({
    cursorId: null,
    through: new Date("2026-10-02T12:00:00Z"),
    lastError: null,
    providerSources: totals,
    providerSourcesAt: new Date("2026-10-02T12:00:00Z"),
  });
  expect(f.deps.logger.info).toHaveBeenCalledWith("analytics.provider_sync", {
    workspaceId: ids[0],
    ...totals,
  });

  // A fresh sweep starts from zero and a continuing page is not logged yet.
  f.providerLease.update.mockClear();
  f.deps.logger.info.mockClear();
  f.providerLease.checkpoint.cursorId = null;
  f.deps.syncProvider.mockResolvedValueOnce({
    hasMore: true,
    nextSourceId: ids[2],
    processed: 5,
    available: 0,
    unavailable: 5,
    activationRequired: 0,
    permissionRequired: 5,
  });
  await runner.runPass(new AbortController().signal);
  expect(f.providerLease.update).toHaveBeenCalledWith(
    expect.objectContaining({
      cursorId: ids[2],
      providerSources: {
        processed: 5,
        available: 0,
        unavailable: 5,
        activationRequired: 0,
        permissionRequired: 5,
      },
    })
  );
  expect(f.deps.logger.info).not.toHaveBeenCalled();
});

test("a completed empty discovery scan resets its cursor but does not stop future passes", async () => {
  const f = fixture();
  f.deps.discover.mockResolvedValueOnce({
    ids: [],
    lastId: "",
    hasMore: false,
  });
  const runner = createAnalyticsProjectionRunner(f.deps);
  await runner.runPass(new AbortController().signal);
  await runner.runPass(new AbortController().signal);
  expect(f.deps.discover).toHaveBeenCalledTimes(2);
  expect(f.deps.project).toHaveBeenCalledTimes(6);
});

test("shutdown drains the current bounded page and does not begin another workspace", async () => {
  const f = fixture(),
    abort = new AbortController();
  f.deps.project.mockImplementationOnce(async () => {
    abort.abort();
    return { status: "idle", processed: 0 };
  });
  await createAnalyticsProjectionRunner(f.deps).runPass(abort.signal);
  expect(f.deps.project).toHaveBeenCalledTimes(1);
  expect(f.discoveryLease.update).not.toHaveBeenCalled();
  expect(f.discoveryLease.stop).toHaveBeenCalled();
});

test("a provider continuation survives restart and is fenced before its next cursor is saved", async () => {
  const f = fixture();
  f.deps.discover.mockResolvedValue({
    ids: [ids[0]],
    lastId: ids[0],
    hasMore: true,
  });
  f.providerLease.checkpoint.cursorId = ids[1];
  f.deps.syncProvider.mockResolvedValue({
    hasMore: true,
    nextSourceId: ids[2],
  });
  await createAnalyticsProjectionRunner(f.deps).runPass(
    new AbortController().signal
  );
  expect(f.deps.syncProvider).toHaveBeenCalledWith({
    workspaceId: ids[0],
    afterSourceId: ids[1],
    limit: 5,
    signal: expect.any(AbortSignal),
  });
  expect(f.providerLease.update).toHaveBeenCalledWith(
    expect.objectContaining({ cursorId: ids[2] })
  );
  expect(f.providerLease.stop).toHaveBeenCalled();
});

test("abort during provider sync drains its lease and preserves both cursors for retry", async () => {
  const f = fixture(),
    abort = new AbortController();
  f.deps.discover.mockResolvedValue({
    ids: [ids[0]],
    lastId: ids[0],
    hasMore: true,
  });
  f.deps.syncProvider.mockImplementationOnce(async () => {
    abort.abort();
    throw new Error("aborted provider request");
  });
  await createAnalyticsProjectionRunner(f.deps).runPass(abort.signal);
  expect(f.providerLease.stop).toHaveBeenCalledTimes(1);
  expect(f.providerLease.update).not.toHaveBeenCalled();
  expect(f.discoveryLease.update).not.toHaveBeenCalled();
  expect(f.discoveryLease.stop).toHaveBeenCalledTimes(1);
  expect(f.deps.logger.error).not.toHaveBeenCalled();
});

test("invalid tenants and a busy discovery lease cannot produce facts or provider requests", async () => {
  const f = fixture();
  f.deps.discover.mockResolvedValueOnce({
    ids: ["malformed"],
    lastId: "malformed",
    hasMore: false,
  });
  const runner = createAnalyticsProjectionRunner(f.deps);
  await runner.runPass(new AbortController().signal);
  f.deps.acquireDiscovery.mockResolvedValueOnce(null);
  await runner.runPass(new AbortController().signal);
  expect(f.deps.project).not.toHaveBeenCalled();
  expect(f.deps.syncProvider).not.toHaveBeenCalled();
});

test("a lost discovery fence stops the sweep before the next tenant and releases only its lease", async () => {
  const f = fixture();
  f.discoveryLease.assertOwned.mockRejectedValueOnce(new Error("lease lost"));
  await expect(
    createAnalyticsProjectionRunner(f.deps).runPass(
      new AbortController().signal
    )
  ).rejects.toThrow("lease lost");
  expect(f.deps.project).not.toHaveBeenCalled();
  expect(f.discoveryLease.update).not.toHaveBeenCalled();
  expect(f.discoveryLease.stop).toHaveBeenCalledTimes(1);
});

test("one-shot mode awaits its bounded pass and does not create transition streams", async () => {
  const f = fixture();
  const stop = await startAnalyticsProjectionRuntime({
    once: true,
    loadDependencies: async () => f.deps,
  });
  expect(f.deps.project).toHaveBeenCalledTimes(6);
  await stop();
  expect(f.deps.project).toHaveBeenCalledTimes(6);
});

test("an already aborted owner releases the parent listener without loading prerequisites", async () => {
  const parent = new AbortController();
  parent.abort();
  const remove = jest.spyOn(parent.signal, "removeEventListener"),
    loadDependencies = jest.fn();
  const stop = await startAnalyticsProjectionRuntime({
    signal: parent.signal,
    loadDependencies,
  });
  await stop();
  expect(loadDependencies).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
});

test("the daemon passes its logger to transition sources and shutdown never outlasts the stop deadline", async () => {
  const f = fixture();
  const hung = watchServiceLifecycle as jest.Mock;
  const stage = watchCustomerStageTransitions as jest.Mock;
  // A source that ignores cancellation (for example a stalled driver call) cannot hold shutdown.
  hung.mockImplementation(() => new Promise(() => undefined));
  stage.mockImplementation(
    ({ signal }: { signal: AbortSignal }) =>
      new Promise(resolve =>
        signal.addEventListener("abort", resolve, { once: true })
      )
  );
  const stop = await startAnalyticsProjectionRuntime({
    logger: f.deps.logger,
    loadDependencies: async () => f.deps,
    stopDeadlineMs: 50,
  });
  expect(hung).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "__analytics_all_workspaces__",
      logger: f.deps.logger,
    })
  );
  expect(f.deps.logger.info).toHaveBeenCalledWith(
    "analytics.runtime_started",
    expect.objectContaining({ workspaceVisitBudgetMs: 45_000 })
  );
  const startedAt = Date.now();
  await stop();
  expect(Date.now() - startedAt).toBeLessThan(1_000);
  expect(ANALYTICS_STOP_DEADLINE_MS).toBe(2_000);
});

test("failed SQL prerequisites cannot announce a started collector", async () => {
  const f = fixture();
  await expect(
    startAnalyticsProjectionRuntime({
      logger: f.deps.logger,
      loadDependencies: async () => {
        throw new Error("prerequisites unavailable");
      },
    })
  ).rejects.toThrow("prerequisites unavailable");
  expect(f.deps.logger.info).not.toHaveBeenCalled();
});
test("replay cannot reset checkpoints when prerequisites fail", async () => {
  const f = fixture();
  await expect(
    startAnalyticsProjectionRuntime({
      workspaceId: ids[0],
      replay: true,
      once: true,
      loadDependencies: async () => {
        throw new Error("prerequisites unavailable");
      },
    })
  ).rejects.toThrow("prerequisites unavailable");
  expect(f.deps.resetWorkspace).not.toHaveBeenCalled();
});
test("replay owns checkpoints after prerequisites and before any projected page", async () => {
  const f = fixture(),
    order: string[] = [];
  f.deps.resetWorkspace.mockImplementationOnce(async () => {
    order.push("reset");
  });
  f.deps.project.mockImplementation(async () => {
    order.push("page");
    return { status: "idle", processed: 0 };
  });
  const stop = await startAnalyticsProjectionRuntime({
    workspaceId: ids[0],
    replay: true,
    once: true,
    loadDependencies: async () => {
      order.push("prerequisites");
      return f.deps;
    },
  });
  await stop();
  expect(order.slice(0, 3)).toEqual(["prerequisites", "reset", "page"]);
  expect(f.deps.resetWorkspace).toHaveBeenCalledWith(ids[0]);
});
test("shutdown during prerequisites cannot start replay or page work", async () => {
  const f = fixture(),
    parent = new AbortController();
  const stop = await startAnalyticsProjectionRuntime({
    workspaceId: ids[0],
    replay: true,
    once: true,
    signal: parent.signal,
    loadDependencies: async () => {
      parent.abort();
      return f.deps;
    },
  });
  await stop();
  expect(f.deps.resetWorkspace).not.toHaveBeenCalled();
  expect(f.deps.project).not.toHaveBeenCalled();
});
