export type TemporalWorkerLifecycleRunner = {
  run: () => Promise<void>;
  shutdown: () => void;
};

export type TemporalWorkerAuxiliaryStarter = (
  signal: AbortSignal,
  reportFatal: (error: unknown) => void,
) => Promise<() => Promise<unknown>>;

type InstallShutdownHandler = (handler: () => void) => () => void;

function installProcessShutdownHandler(handler: () => void): () => void {
  const onSignal = () => handler();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return () => {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  };
}

function isShutdownCancellation(error: unknown, signal: AbortSignal): boolean {
  if (signal.reason !== "worker_shutdown" || !(error instanceof Error)) {
    return false;
  }
  return error.name === "AbortError" || error.message === "worker_shutdown";
}

export async function runTemporalWorkerLifecycle(params: {
  workers: readonly TemporalWorkerLifecycleRunner[];
  auxiliaryStarters: readonly TemporalWorkerAuxiliaryStarter[];
  installShutdownHandler?: InstallShutdownHandler;
  onReady?: () => void;
  /** Opened once every starter has run and polling began; closed first. */
  startReadinessProbe?: () => Promise<() => Promise<unknown>>;
  /** Runs last, once every worker has drained its in-flight activities. */
  afterWorkersStopped?: () => Promise<unknown>;
}): Promise<void> {
  const controller = new AbortController();
  let fatalReported = false;
  let fatalError: unknown;
  let resolveFatal!: (error: unknown) => void;
  const fatal = new Promise<unknown>((resolve) => {
    resolveFatal = resolve;
  });
  const reportFatal = (error: unknown) => {
    if (fatalReported || controller.signal.aborted) return;
    fatalReported = true;
    fatalError = error;
    controller.abort("auxiliary_fatal");
    resolveFatal(error);
  };
  let requestShutdown!: () => void;
  const shutdownRequested = new Promise<void>((resolve) => {
    requestShutdown = () => {
      if (controller.signal.aborted) return;
      controller.abort("worker_shutdown");
      resolve();
    };
  });
  const removeShutdownHandler = (
    params.installShutdownHandler || installProcessShutdownHandler
  )(requestShutdown);
  const stops: Array<() => Promise<unknown>> = [];
  let workerRuns: Promise<void>[] = [];
  let polling: Promise<void> | null = null;
  let primaryError: unknown;
  let cleanupError: unknown;
  let pollingStarted = false;

  try {
    for (const starter of params.auxiliaryStarters) {
      if (controller.signal.aborted) break;
      stops.push(await starter(controller.signal, reportFatal));
    }

    if (fatalReported) {
      throw fatalError;
    }
    if (controller.signal.aborted) {
      await shutdownRequested;
    } else {
      pollingStarted = true;
      workerRuns = params.workers.map((worker) => {
        try {
          return Promise.resolve(worker.run());
        } catch (error) {
          return Promise.reject(error);
        }
      });
      polling = Promise.all(workerRuns).then(() => undefined);
      // A worker can fail while the probe opens; the race below reports it.
      polling.catch(() => undefined);
      params.onReady?.();
      if (params.startReadinessProbe) {
        stops.push(await params.startReadinessProbe());
      }
      await Promise.race([polling, shutdownRequested, fatal]);
      if (fatalReported) throw fatalError;
    }
  } catch (error) {
    if (fatalReported) primaryError = fatalError;
    else if (!isShutdownCancellation(error, controller.signal)) {
      primaryError = error;
    }
  } finally {
    if (!controller.signal.aborted) {
      controller.abort("worker_cleanup");
    }
    for (let index = stops.length - 1; index >= 0; index -= 1) {
      try {
        await stops[index]!();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    for (const worker of params.workers) {
      try {
        worker.shutdown();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (pollingStarted) {
      const drainedRuns = await Promise.allSettled(workerRuns);
      if (primaryError === undefined) {
        const failedRun = drainedRuns.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected" &&
            !isShutdownCancellation(result.reason, controller.signal),
        );
        if (failedRun) primaryError = failedRun.reason;
      }
    }
    if (params.afterWorkersStopped) {
      try {
        await params.afterWorkersStopped();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    try {
      removeShutdownHandler();
    } catch (error) {
      cleanupError ??= error;
    }
  }

  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
}
