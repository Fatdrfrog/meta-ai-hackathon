import "server-only";
import {
  ANALYTICS_GLOBAL_CHECKPOINT,
  isAnalyticsWorkspaceId,
} from "./service-lifecycle-consumer";
import type {
  ACQUISITION_STREAMS,
  AnalyticsProviderSourceCounts,
} from "./acquisition-projector";
import {
  airiWorkerLogger,
  describeLogError,
} from "@icecore/airi-runtime/logging";

type AcquisitionStream = (typeof ACQUISITION_STREAMS)[number];
/** A backfilling tenant keeps paging inside one visit, never past this budget, so every tenant keeps its turn. */
export const ANALYTICS_WORKSPACE_VISIT_BUDGET_MS = 45_000;
/** Leases expire on their own, so worker shutdown never waits on analytics past this bound. */
export const ANALYTICS_STOP_DEADLINE_MS = 2_000;
const PROVIDER_SOURCE_COUNTS = [
  "processed",
  "available",
  "unavailable",
  "activationRequired",
  "permissionRequired",
] as const;
type ProviderSourceCount = (typeof PROVIDER_SOURCE_COUNTS)[number];
export type AnalyticsProjectionLogger = {
  info: (event: string, metadata?: Record<string, unknown>) => void;
  error: (
    event: string,
    error: unknown,
    metadata?: Record<string, unknown>
  ) => void;
};
export type AnalyticsRuntimeLease = {
  checkpoint: {
    cursorId: string | null;
    through: Date | null;
    providerSources?: AnalyticsProviderSourceCounts | null;
  };
  update: (fields: Record<string, unknown>) => Promise<void>;
  assertOwned: () => Promise<void>;
  stop: () => Promise<void>;
};
export type AnalyticsProjectionDependencies = {
  streams: readonly AcquisitionStream[];
  discover: (
    afterId: string | null,
    limit: number
  ) => Promise<{ ids: string[]; lastId: string | null; hasMore: boolean }>;
  acquireDiscovery: (
    signal: AbortSignal
  ) => Promise<AnalyticsRuntimeLease | null>;
  acquireProvider: (
    workspaceId: string,
    signal: AbortSignal
  ) => Promise<AnalyticsRuntimeLease | null>;
  project: (input: {
    workspaceId: string;
    stream: AcquisitionStream;
    batchSize: number;
    signal: AbortSignal;
  }) => Promise<{ status: string; processed: number }>;
  snapshots: (
    workspaceId: string,
    signal: AbortSignal
  ) => Promise<{ scanned: number; complete: boolean } | void>;
  syncProvider: (input: {
    workspaceId: string;
    afterSourceId?: string;
    limit: number;
    signal?: AbortSignal;
  }) => Promise<
    { hasMore: boolean; nextSourceId: string | null } & Partial<
      Record<ProviderSourceCount, number>
    >
  >;
  logger: AnalyticsProjectionLogger;
  now: () => Date;
  resetWorkspace?: (workspaceId: string) => Promise<void>;
  visitBudgetMs?: number;
};

/** Adds one provider page to its sweep; a fresh sweep starts from zero. */
function providerSweepCounts(
  page: Partial<Record<ProviderSourceCount, number>>,
  previous: AnalyticsProviderSourceCounts | null | undefined
): AnalyticsProviderSourceCounts | null {
  if (!PROVIDER_SOURCE_COUNTS.some(key => Number.isFinite(page[key])))
    return null;
  const counts: Partial<Record<ProviderSourceCount, number>> = {};
  for (const key of PROVIDER_SOURCE_COUNTS) {
    const value = page[key];
    if (key === "permissionRequired" && !Number.isFinite(value)) continue;
    counts[key] =
      (previous?.[key] ?? 0) + (Number.isFinite(value) ? Number(value) : 0);
  }
  return counts as AnalyticsProviderSourceCounts;
}

export function createAnalyticsProjectionRunner(
  deps: AnalyticsProjectionDependencies
) {
  const isolated = async <T>(
    workspaceId: string,
    phase: string,
    run: () => Promise<T>,
    signal: AbortSignal
  ): Promise<T | undefined> => {
    try {
      return await run();
    } catch (error) {
      if (!signal.aborted)
        deps.logger.error(
          "analytics.projection_degraded",
          describeLogError(error),
          { workspaceId, phase }
        );
      return undefined;
    }
  };
  return {
    async runPass(signal: AbortSignal) {
      if (signal.aborted) return;
      const lease = await deps.acquireDiscovery(signal);
      if (!lease) return;
      try {
        const page = await deps.discover(lease.checkpoint.cursorId, 50);
        // One tenant at a time leaves the worker's Mongo pool available to Temporal activities.
        // Every stream takes one bounded page per visit; only streams still backfilling take
        // further pages, round-robin, inside the visit budget, so no tenant monopolizes a sweep.
        for (const workspaceId of page.ids.slice(0, 50)) {
          if (signal.aborted) return;
          if (!isAnalyticsWorkspaceId(workspaceId)) {
            deps.logger.error(
              "analytics.projection_degraded",
              new Error("Invalid analytics workspace"),
              { phase: "workspace_discovery" }
            );
            continue;
          }
          await lease.assertOwned();
          const visitEndsAt =
            deps.now().getTime() +
            (deps.visitBudgetMs ?? ANALYTICS_WORKSPACE_VISIT_BUDGET_MS);
          const visitOpen = () =>
            !signal.aborted && deps.now().getTime() < visitEndsAt;
          let streams: readonly AcquisitionStream[] = deps.streams;
          while (streams.length) {
            const backfilling: AcquisitionStream[] = [];
            for (const stream of streams) {
              if (signal.aborted) return;
              const projected = await isolated(
                workspaceId,
                stream,
                () =>
                  deps.project({
                    workspaceId,
                    stream,
                    batchSize: stream.includes("conversions") ? 25 : 500,
                    signal,
                  }),
                signal
              );
              // A backfilling page that moved nothing (rows claimed by another
              // owner) waits for the next visit instead of spinning claim calls.
              if (
                projected?.status === "backfilling" &&
                projected.processed > 0
              )
                backfilling.push(stream);
            }
            if (!backfilling.length || !visitOpen()) break;
            await lease.assertOwned();
            streams = backfilling;
          }
          if (signal.aborted) return;
          const recoverSnapshots = () =>
            isolated(
              workspaceId,
              "snapshot_recovery",
              () => deps.snapshots(workspaceId, signal),
              signal
            );
          let snapshot = await recoverSnapshots();
          while (
            snapshot &&
            !snapshot.complete &&
            snapshot.scanned > 0 &&
            visitOpen()
          )
            snapshot = await recoverSnapshots();
          if (signal.aborted) return;
          await isolated(
            workspaceId,
            "provider_sync",
            async () => {
              const provider = await deps.acquireProvider(workspaceId, signal);
              if (!provider) return;
              try {
                const now = deps.now();
                if (
                  !provider.checkpoint.cursorId &&
                  provider.checkpoint.through &&
                  now.getTime() - provider.checkpoint.through.getTime() <
                    300_000
                )
                  return;
                await provider.assertOwned();
                const result = await deps.syncProvider({
                  workspaceId,
                  afterSourceId: provider.checkpoint.cursorId ?? undefined,
                  limit: 5,
                  signal,
                });
                if (signal.aborted) return;
                const sources = providerSweepCounts(
                  result,
                  provider.checkpoint.cursorId
                    ? provider.checkpoint.providerSources
                    : null
                );
                await provider.update({
                  cursorId: result.hasMore ? result.nextSourceId : null,
                  through: result.hasMore ? null : now,
                  lastError: null,
                  ...(sources
                    ? { providerSources: sources, providerSourcesAt: now }
                    : {}),
                });
                // Shows why provider collections stay empty (expired access, activation).
                if (sources?.processed && !result.hasMore)
                  deps.logger.info("analytics.provider_sync", {
                    workspaceId,
                    ...sources,
                  });
              } finally {
                await provider.stop();
              }
            },
            signal
          );
          if (signal.aborted) return;
          await lease.update({ cursorId: workspaceId, lastError: null });
        }
        if (!signal.aborted) {
          const lastId = isAnalyticsWorkspaceId(page.lastId)
            ? page.lastId
            : null;
          await lease.update({
            cursorId: page.hasMore ? lastId : null,
            through: deps.now(),
            lastError: null,
          });
        }
      } finally {
        await lease.stop();
      }
    },
  };
}

const defaultLogger: AnalyticsProjectionLogger = airiWorkerLogger;
const unavailable = (message: string, cause: unknown) => {
  const summary = describeLogError(cause ?? "invalid response");
  return Object.assign(
    new Error(`${message}: ${summary.message ?? summary.name}`),
    summary.code === undefined ? {} : { code: summary.code }
  );
};
const settleWithin = async (
  tasks: Promise<unknown>[],
  milliseconds: number
) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(tasks),
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, milliseconds);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
};
const wait = (signal: AbortSignal, milliseconds: number) =>
  new Promise<void>(resolve => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });

async function productionDependencies(
  signal: AbortSignal,
  workspaceId: string | undefined,
  logger: AnalyticsProjectionLogger
): Promise<AnalyticsProjectionDependencies> {
  const [
    { default: connectDB },
    { supabaseAdmin },
    acquisition,
    provider,
    lifecycle,
    stages,
  ] = await Promise.all([
    import("@/lib/mongoose"),
    import("@/lib/supabase/admin"),
    import("./acquisition-projector"),
    import("./whatsapp-analytics-service"),
    import("./service-lifecycle-consumer"),
    import("./customer-stage-consumer"),
  ]);
  // Indexes belong to the deploy's ensure:mongo-indexes step, never to worker boot.
  await connectDB();
  // Read-only prerequisite probe, with no real workspace/business identity and no queue claim.
  const prerequisite = await supabaseAdmin
    .rpc("get_analytics_conversion_page", {
      p_workspace_id: "00000000-0000-0000-0000-000000000000",
      p_through: new Date().toISOString(),
      p_limit: 1,
    })
    .abortSignal(AbortSignal.any([signal, AbortSignal.timeout(25_000)]));
  if (prerequisite.error || !Array.isArray(prerequisite.data))
    throw unavailable(
      "Analytics SQL projection prerequisites unavailable",
      prerequisite.error
    );
  return {
    streams: acquisition.ACQUISITION_STREAMS,
    discover: async (afterId, limit) => {
      if (workspaceId)
        return { ids: [workspaceId], lastId: workspaceId, hasMore: false };
      let query = supabaseAdmin
        .from("workspaces")
        .select("id")
        .order("id")
        .limit(limit + 1);
      if (afterId) query = query.gt("id", afterId);
      const { data, error } = await query.abortSignal(
        AbortSignal.any([signal, AbortSignal.timeout(25_000)])
      );
      if (error || !Array.isArray(data))
        throw unavailable("Analytics workspace discovery unavailable", error);
      const page = data.slice(0, limit);
      const ids = page.map(row => row.id).filter(isAnalyticsWorkspaceId);
      if (ids.length !== page.length)
        logger.error(
          "analytics.projection_degraded",
          new Error("Invalid analytics workspace"),
          { phase: "workspace_discovery" }
        );
      return { ids, lastId: ids.at(-1) ?? null, hasMore: data.length > limit };
    },
    acquireDiscovery: signal =>
      acquisition.acquireAnalyticsRuntimeLease({
        workspaceId: workspaceId ?? ANALYTICS_GLOBAL_CHECKPOINT,
        stream: "workspace_discovery",
        signal,
      }),
    acquireProvider: (workspaceId, signal) =>
      acquisition.acquireAnalyticsRuntimeLease({
        workspaceId,
        stream: "provider_sync",
        signal,
      }),
    project: input =>
      acquisition.projectAcquisitionPage({ ...input, supabase: supabaseAdmin }),
    snapshots: async (workspaceId, signal) => {
      const [service, stage] = await Promise.all([
        lifecycle.readServiceLifecycleCoverage(workspaceId),
        stages.readCustomerStageCoverage(workspaceId),
      ]);
      let scanned = 0,
        complete = true;
      for (const [coverage, rebuild] of [
        [service, lifecycle.rebuildServiceLifecycleSnapshots],
        [stage, stages.rebuildCustomerStageSnapshots],
      ] as const) {
        if (coverage.snapshotRecovery === "complete") continue;
        if (signal.aborted) return { scanned, complete: false };
        const batch = await rebuild({ workspaceId, batchSize: 500, signal });
        scanned += batch.scanned;
        complete &&= batch.complete;
      }
      return { scanned, complete };
    },
    syncProvider: provider.syncWhatsAppAnalyticsSources,
    logger,
    now: () => new Date(),
    resetWorkspace: acquisition.resetAcquisitionCheckpoints,
  };
}

/** Existing worker-owned daemon: two shared streams plus one fair, bounded tenant sweep. */
export async function startAnalyticsProjectionRuntime({
  signal: parentSignal,
  workspaceId,
  logger = defaultLogger,
  once = false,
  replay = false,
  loadDependencies = productionDependencies,
  stopDeadlineMs = ANALYTICS_STOP_DEADLINE_MS,
}: {
  signal?: AbortSignal;
  workspaceId?: string;
  logger?: AnalyticsProjectionLogger;
  once?: boolean;
  replay?: boolean;
  loadDependencies?: typeof productionDependencies;
  stopDeadlineMs?: number;
}): Promise<() => Promise<void>> {
  if (workspaceId !== undefined && !isAnalyticsWorkspaceId(workspaceId))
    throw new Error("Invalid analytics workspace");
  if (replay && !workspaceId) throw new Error("Replay requires a workspace");
  const abort = new AbortController();
  const stopFromParent = () => abort.abort();
  parentSignal?.addEventListener("abort", stopFromParent, { once: true });
  if (parentSignal?.aborted) abort.abort();
  const signal = abort.signal;
  let tasks: Promise<unknown>[] = [];
  try {
    if (signal.aborted) {
      parentSignal?.removeEventListener("abort", stopFromParent);
      return async () => undefined;
    }
    const deps = await loadDependencies(signal, workspaceId, logger);
    if (signal.aborted) {
      parentSignal?.removeEventListener("abort", stopFromParent);
      return async () => undefined;
    }
    if (replay && workspaceId) {
      if (!deps.resetWorkspace)
        throw new Error("Analytics replay owner unavailable");
      // Index/RPC prerequisites are already acknowledged; existing facts remain intact.
      await deps.resetWorkspace(workspaceId);
    }
    const runner = createAnalyticsProjectionRunner(deps);
    if (once) {
      await runner.runPass(signal);
    } else {
      const lifecycle = await import("./service-lifecycle-consumer"),
        stages = await import("./customer-stage-consumer");
      const checkpointId = workspaceId ?? ANALYTICS_GLOBAL_CHECKPOINT;
      const watchSource = async (
        source: string,
        watch: typeof lifecycle.watchServiceLifecycle
      ) => {
        while (!signal.aborted) {
          try {
            await watch({ workspaceId: checkpointId, signal, logger });
          } catch (error) {
            if (!signal.aborted)
              logger.error(
                "analytics.projection_degraded",
                describeLogError(error),
                { phase: source }
              );
          }
          await wait(signal, 10_000);
        }
      };
      tasks = [
        watchSource("service_lifecycle", lifecycle.watchServiceLifecycle),
        watchSource("customer_stage", stages.watchCustomerStageTransitions),
        (async () => {
          while (!signal.aborted) {
            try {
              await runner.runPass(signal);
            } catch (error) {
              if (!signal.aborted)
                logger.error(
                  "analytics.projection_degraded",
                  describeLogError(error),
                  { phase: "workspace_discovery" }
                );
            }
            await wait(signal, 10_000);
          }
        })(),
      ];
      logger.info("analytics.runtime_started", {
        state: "starting",
        sourceStreams: 2,
        workspacePageSize: 50,
        workspaceConcurrency: 1,
        workspaceVisitBudgetMs:
          deps.visitBudgetMs ?? ANALYTICS_WORKSPACE_VISIT_BUDGET_MS,
      });
    }
    return async () => {
      abort.abort();
      await settleWithin(tasks, stopDeadlineMs);
      parentSignal?.removeEventListener("abort", stopFromParent);
    };
  } catch (error) {
    abort.abort();
    await settleWithin(tasks, stopDeadlineMs);
    parentSignal?.removeEventListener("abort", stopFromParent);
    throw error;
  }
}
