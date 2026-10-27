import assert from "node:assert/strict";
import test from "node:test";

import { startAnalyticsProjectionRuntime } from "./analytics-projection-runtime.js";
import { runTemporalWorkerLifecycle } from "./worker-lifecycle.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

test("installs shutdown ownership and starts auxiliaries before polling", async () => {
  const events: string[] = [];
  const polling = deferred();

  await runTemporalWorkerLifecycle({
    workers: [
      {
        run: async () => {
          events.push("polling:start");
          await polling.promise;
        },
        shutdown: () => {
          events.push("worker:shutdown");
          polling.resolve();
        },
      },
    ],
    auxiliaryStarters: [
      async (signal) => {
        assert.equal(signal.aborted, false);
        events.push("auxiliary:first:start");
        return async () => events.push("auxiliary:first:stop");
      },
      async (signal) => {
        assert.equal(signal.aborted, false);
        events.push("auxiliary:second:start");
        return async () => events.push("auxiliary:second:stop");
      },
    ],
    installShutdownHandler: (handler) => {
      events.push("signals:install");
      return () => {
        events.push("signals:remove");
      };
    },
    onReady: () => {
      events.push("ready");
      polling.resolve();
    },
  });

  assert.deepEqual(events, [
    "signals:install",
    "auxiliary:first:start",
    "auxiliary:second:start",
    "polling:start",
    "ready",
    "auxiliary:second:stop",
    "auxiliary:first:stop",
    "worker:shutdown",
    "signals:remove",
  ]);
});

test("aborts and rolls back partial auxiliary startup in reverse sequence", async () => {
  const events: string[] = [];
  let firstSignal: AbortSignal | undefined;
  let pollingCalls = 0;

  await assert.rejects(
    runTemporalWorkerLifecycle({
      workers: [
        {
          run: async () => {
            pollingCalls += 1;
          },
          shutdown: () => events.push("worker:shutdown"),
        },
      ],
      auxiliaryStarters: [
        async (signal) => {
          firstSignal = signal;
          events.push("first:start");
          return async () => {
            events.push(`first:stop:${signal.aborted}`);
          };
        },
        async () => {
          events.push("second:start");
          throw new Error("second failed");
        },
        async () => {
          events.push("third:start");
          return async () => undefined;
        },
      ],
      installShutdownHandler: () => () => events.push("signals:remove"),
    }),
    /second failed/,
  );

  assert.equal(firstSignal?.aborted, true);
  assert.equal(pollingCalls, 0);
  assert.deepEqual(events, [
    "first:start",
    "second:start",
    "first:stop:true",
    "worker:shutdown",
    "signals:remove",
  ]);
});

test("stops auxiliaries before workers and preserves a polling failure", async () => {
  const events: string[] = [];

  await assert.rejects(
    runTemporalWorkerLifecycle({
      workers: [
        {
          run: async () => {
            events.push("polling:start");
            throw new Error("polling failed");
          },
          shutdown: () => events.push("worker:shutdown"),
        },
      ],
      auxiliaryStarters: [
        async (signal) => {
          events.push("first:start");
          return async () => {
            events.push(`first:stop:${signal.aborted}`);
            throw new Error("cleanup failed");
          };
        },
        async (signal) => {
          events.push("second:start");
          return async () => events.push(`second:stop:${signal.aborted}`);
        },
      ],
      installShutdownHandler: () => () => events.push("signals:remove"),
    }),
    /polling failed/,
  );

  assert.deepEqual(events, [
    "first:start",
    "second:start",
    "polling:start",
    "second:stop:true",
    "first:stop:true",
    "worker:shutdown",
    "signals:remove",
  ]);
});

test("runs afterWorkersStopped once every worker has drained its activities", async () => {
  const events: string[] = [];
  let requestShutdown!: () => void;
  let finishRun!: () => void;

  const lifecycle = runTemporalWorkerLifecycle({
    workers: [
      {
        run: () =>
          new Promise<void>((resolve) => {
            finishRun = () => {
              events.push("worker:drained");
              resolve();
            };
          }),
        shutdown: () => {
          events.push("worker:shutdown");
          setImmediate(() => finishRun());
        },
      },
    ],
    auxiliaryStarters: [],
    installShutdownHandler: (handler) => {
      requestShutdown = handler;
      return () => events.push("signals:remove");
    },
    afterWorkersStopped: async () => {
      events.push("after-workers");
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  requestShutdown();
  await lifecycle;

  assert.deepEqual(events, [
    "worker:shutdown",
    "worker:drained",
    "after-workers",
    "signals:remove",
  ]);
});

test("waits for every worker polling loop to drain after one worker fails", async () => {
  const failure = new Error("first polling loop failed");
  const failFirst = deferred();
  const drainSecond = deferred();
  const secondShutdown = deferred();
  let lifecycleSettled = false;

  const lifecycle = runTemporalWorkerLifecycle({
    workers: [
      {
        run: async () => {
          await failFirst.promise;
          throw failure;
        },
        shutdown: () => undefined,
      },
      {
        run: async () => {
          await drainSecond.promise;
        },
        shutdown: () => {
          secondShutdown.resolve();
        },
      },
    ],
    auxiliaryStarters: [],
    installShutdownHandler: () => () => undefined,
    onReady: () => failFirst.resolve(),
  });
  const observed = lifecycle.then(
    () => {
      lifecycleSettled = true;
      return { status: "resolved" as const };
    },
    (error) => {
      lifecycleSettled = true;
      return { status: "rejected" as const, error };
    },
  );

  await secondShutdown.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  const settledBeforeSecondDrain = lifecycleSettled;
  drainSecond.resolve();
  const result = await observed;

  assert.equal(settledBeforeSecondDrain, false);
  assert.deepEqual(result, { status: "rejected", error: failure });
});

test("preserves a real worker failure that arrives during shutdown drain", async () => {
  const failure = new Error("worker drain failed");
  const drain = deferred();
  let shutdownHandler: (() => void) | undefined;

  await assert.rejects(
    runTemporalWorkerLifecycle({
      workers: [
        {
          run: async () => {
            await drain.promise;
            throw failure;
          },
          shutdown: () => drain.resolve(),
        },
      ],
      auxiliaryStarters: [],
      installShutdownHandler: (handler) => {
        shutdownHandler = handler;
        return () => undefined;
      },
      onReady: () => shutdownHandler?.(),
    }),
    (error: unknown) => error === failure,
  );
});

test("handles repeated process signals with one reverse sequential cleanup", async () => {
  const events: string[] = [];
  const polling = deferred();
  let shutdownHandler: (() => void) | undefined;

  const lifecycle = runTemporalWorkerLifecycle({
    workers: [
      {
        run: async () => {
          events.push("polling:start");
          await polling.promise;
        },
        shutdown: () => {
          events.push("worker:shutdown");
          polling.resolve();
        },
      },
    ],
    auxiliaryStarters: [
      async (signal) => {
        events.push("first:start");
        return async () => events.push(`first:stop:${signal.aborted}`);
      },
      async (signal) => {
        events.push("second:start");
        return async () => events.push(`second:stop:${signal.aborted}`);
      },
    ],
    installShutdownHandler: (handler) => {
      shutdownHandler = handler;
      return () => events.push("signals:remove");
    },
    onReady: () => {
      events.push("ready");
      shutdownHandler?.();
      shutdownHandler?.();
    },
  });

  await lifecycle;

  assert.deepEqual(events, [
    "first:start",
    "second:start",
    "polling:start",
    "ready",
    "second:stop:true",
    "first:stop:true",
    "worker:shutdown",
    "signals:remove",
  ]);
});

test("propagates one auxiliary fatal after readiness and preserves it through cleanup", async () => {
  const events: string[] = [];
  const polling = deferred();
  const failure = new Error("request projection stream failed");
  let reportFatal: ((error: unknown) => void) | undefined;

  await assert.rejects(
    runTemporalWorkerLifecycle({
      workers: [
        {
          run: async () => {
            events.push("polling:start");
            await polling.promise;
          },
          shutdown: () => {
            events.push("worker:shutdown");
            polling.resolve();
          },
        },
      ],
      auxiliaryStarters: [
        async (_signal, fatal) => {
          reportFatal = fatal;
          events.push("first:start");
          return async () => {
            events.push("first:stop");
            throw new Error("secondary cleanup failure");
          };
        },
        async () => {
          events.push("second:start");
          return async () => events.push("second:stop");
        },
      ],
      installShutdownHandler: () => () => events.push("signals:remove"),
      onReady: () => {
        events.push("ready");
        reportFatal?.(failure);
        polling.resolve();
      },
    }),
    (error: unknown) => error === failure,
  );

  assert.deepEqual(events, [
    "first:start",
    "second:start",
    "polling:start",
    "ready",
    "second:stop",
    "first:stop",
    "worker:shutdown",
    "signals:remove",
  ]);
});

test("aborts an in-flight auxiliary bootstrap before polling or later starters", async () => {
  const events: string[] = [];
  const started = deferred();
  const finish = deferred();
  let shutdownHandler: (() => void) | undefined;

  const lifecycle = runTemporalWorkerLifecycle({
    workers: [
      {
        run: async () => {
          events.push("polling:start");
        },
        shutdown: () => events.push("worker:shutdown"),
      },
    ],
    auxiliaryStarters: [
      async (signal) => {
        events.push("first:start");
        started.resolve();
        await finish.promise;
        events.push(`first:acquired:${signal.aborted}`);
        return async () => events.push("first:stop");
      },
      async () => {
        events.push("second:start");
        return async () => undefined;
      },
    ],
    installShutdownHandler: (handler) => {
      shutdownHandler = handler;
      return () => events.push("signals:remove");
    },
    onReady: () => events.push("ready"),
  });

  await started.promise;
  shutdownHandler?.();
  finish.resolve();
  await lifecycle;
  assert.deepEqual(events, [
    "first:start",
    "first:acquired:true",
    "first:stop",
    "worker:shutdown",
    "signals:remove",
  ]);
});

test("treats an abort-aware bootstrap cancellation during shutdown as clean", async () => {
  const events: string[] = [];
  const started = deferred();
  let shutdownHandler: (() => void) | undefined;

  const lifecycle = runTemporalWorkerLifecycle({
    workers: [
      {
        run: async () => {
          events.push("polling:start");
        },
        shutdown: () => events.push("worker:shutdown"),
      },
    ],
    auxiliaryStarters: [
      async (signal) => {
        events.push("first:start");
        started.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              const error = new Error("worker_shutdown");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        });
        return async () => undefined;
      },
    ],
    installShutdownHandler: (handler) => {
      shutdownHandler = handler;
      return () => events.push("signals:remove");
    },
  });

  await started.promise;
  shutdownHandler?.();
  await lifecycle;
  assert.deepEqual(events, [
    "first:start",
    "worker:shutdown",
    "signals:remove",
  ]);
});

test("Temporal polling starts while analytics prerequisites keep failing", async () => {
  const events: string[] = [];
  const polling = deferred();
  const analyticsFailed = deferred();
  let shutdownHandler: (() => void) | undefined;
  let analyticsAttempts = 0;

  await runTemporalWorkerLifecycle({
    workers: [
      {
        run: async () => {
          events.push("polling:start");
          await polling.promise;
        },
        shutdown: () => {
          events.push("worker:shutdown");
          polling.resolve();
        },
      },
    ],
    auxiliaryStarters: [
      async (signal) =>
        startAnalyticsProjectionRuntime({
          enabled: true,
          signal,
          logger: {
            info: () => undefined,
            error: () => {
              events.push("analytics:retry_scheduled");
              analyticsFailed.resolve();
            },
          },
          loadRuntime: async () => ({
            startAnalyticsProjectionRuntime: async () => {
              analyticsAttempts += 1;
              throw new Error(
                "Analytics SQL projection prerequisites unavailable",
              );
            },
          }),
        }),
    ],
    installShutdownHandler: (handler) => {
      shutdownHandler = handler;
      return () => events.push("signals:remove");
    },
    onReady: () => {
      events.push("ready");
      void analyticsFailed.promise.then(() => shutdownHandler?.());
    },
  });

  // The failed start may land before or after polling begins; it never gates it.
  assert.equal(analyticsAttempts, 1);
  assert.ok(events.includes("analytics:retry_scheduled"));
  assert.deepEqual(
    events.filter((event) => event !== "analytics:retry_scheduled"),
    ["polling:start", "ready", "worker:shutdown", "signals:remove"],
  );
});

test("opens the readiness probe after every starter and polling, and closes it first", async () => {
  const events: string[] = [];
  const polling = deferred();
  let requestShutdown!: () => void;

  const lifecycle = runTemporalWorkerLifecycle({
    workers: [
      {
        run: async () => {
          events.push("polling:start");
          await polling.promise;
        },
        shutdown: () => {
          events.push("worker:shutdown");
          polling.resolve();
        },
      },
    ],
    auxiliaryStarters: [
      async () => {
        events.push("consumers:start");
        return async () => events.push("consumers:stop");
      },
      async () => {
        events.push("schedules:start");
        return async () => events.push("schedules:stop");
      },
    ],
    installShutdownHandler: (handler) => {
      requestShutdown = handler;
      return () => undefined;
    },
    onReady: () => events.push("ready"),
    startReadinessProbe: async () => {
      events.push("probe:open");
      return async () => events.push("probe:close");
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  requestShutdown();
  await lifecycle;

  assert.deepEqual(events, [
    "consumers:start",
    "schedules:start",
    "polling:start",
    "ready",
    "probe:open",
    "probe:close",
    "schedules:stop",
    "consumers:stop",
    "worker:shutdown",
  ]);
});

test("never opens the readiness probe when startup fails or shutdown comes first", async () => {
  let opened = 0;
  const startReadinessProbe = async () => {
    opened += 1;
    return async () => undefined;
  };
  const worker = { run: async () => undefined, shutdown: () => undefined };

  await assert.rejects(
    runTemporalWorkerLifecycle({
      workers: [worker],
      auxiliaryStarters: [
        async () => {
          throw new Error("consumers failed");
        },
      ],
      installShutdownHandler: () => () => undefined,
      startReadinessProbe,
    }),
    /consumers failed/,
  );

  let requestShutdown!: () => void;
  await runTemporalWorkerLifecycle({
    workers: [worker],
    auxiliaryStarters: [
      async () => {
        requestShutdown();
        return async () => undefined;
      },
    ],
    installShutdownHandler: (handler) => {
      requestShutdown = handler;
      return () => undefined;
    },
    startReadinessProbe,
  });

  assert.equal(opened, 0);
});

test("a readiness probe that cannot open stops the worker and reports why", async () => {
  const events: string[] = [];
  const polling = deferred();

  await assert.rejects(
    runTemporalWorkerLifecycle({
      workers: [
        {
          run: async () => {
            await polling.promise;
          },
          shutdown: () => {
            events.push("worker:shutdown");
            polling.resolve();
          },
        },
      ],
      auxiliaryStarters: [
        async () => async () => events.push("consumers:stop"),
      ],
      installShutdownHandler: () => () => undefined,
      startReadinessProbe: async () => {
        throw new Error("listen EADDRINUSE");
      },
    }),
    /EADDRINUSE/,
  );

  assert.deepEqual(events, ["consumers:stop", "worker:shutdown"]);
});

test("reports a worker that fails while the readiness probe opens", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await assert.rejects(
      runTemporalWorkerLifecycle({
        workers: [
          {
            run: async () => {
              throw new Error("poller failed");
            },
            shutdown: () => undefined,
          },
        ],
        auxiliaryStarters: [],
        installShutdownHandler: () => () => undefined,
        startReadinessProbe: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return async () => undefined;
        },
      }),
      /poller failed/,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});
