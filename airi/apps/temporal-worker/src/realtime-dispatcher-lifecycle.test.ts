import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Message, Subscription } from "@google-cloud/pubsub";
import {
  startRealtimeDispatcher,
  type RealtimeDispatcherDependencies,
} from "./realtime-dispatcher.js";
import type { RealtimeValkeyClient } from "./realtime-valkey.js";
import { runTemporalWorkerLifecycle } from "./worker-lifecycle.js";

function fixture() {
  const events: string[] = [];
  const subscription = Object.assign(new EventEmitter(), {
    close: async () => {
      events.push("subscription:close");
    },
  });
  const publisher = Object.assign(new EventEmitter(), {
    isOpen: true,
    eval: async () => [1, 1],
    quit: async () => {
      events.push("valkey:quit");
    },
    destroy: () => {
      events.push("valkey:destroy");
    },
  }) as unknown as RealtimeValkeyClient;
  const dependencies: RealtimeDispatcherDependencies = {
    createPublisher: () => publisher,
    connectPublisher: async (client) => client,
    createSubscription: () => ({
      projectId: "test",
      subscription: subscription as unknown as Subscription,
    }),
    startReplayer: async () => async () => {
      events.push("replayer:stop");
    },
    logger: { info: () => undefined, error: () => undefined },
  };
  return { events, subscription, publisher, dependencies };
}

function message() {
  let ack = 0;
  let nack = 0;
  return {
    id: "test-message",
    data: Buffer.from(
      JSON.stringify({
        channel: "workspace:workspace-1",
        event: {
          eventId: "event-1",
          dedupeKey: "event-1",
          version: 1,
          name: "conversation.message.created",
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          createdAt: "2026-10-02T00:00:00.000Z",
          payload: {},
        },
      }),
    ),
    ack: () => {
      ack += 1;
    },
    nack: () => {
      nack += 1;
    },
    counts: () => ({ ack, nack }),
  };
}

test("managed dispatcher rolls back owned resources when recovery startup fails", async () => {
  const f = fixture();
  const failure = new Error("replayer startup failed");
  f.dependencies.startReplayer = async () => {
    throw failure;
  };
  await assert.rejects(
    startRealtimeDispatcher({ dependencies: f.dependencies }),
    (error) => error === failure,
  );
  assert.equal(f.subscription.listenerCount("message"), 0);
  assert.deepEqual(f.events, ["subscription:close", "valkey:quit"]);
});

test("rollback preserves the startup failure even if subscription cleanup fails", async () => {
  const f = fixture();
  const failure = new Error("replayer startup failed");
  f.dependencies.startReplayer = async () => {
    throw failure;
  };
  f.subscription.close = async () => {
    f.events.push("subscription:close");
    throw new Error("close failed");
  };
  await assert.rejects(
    startRealtimeDispatcher({ dependencies: f.dependencies }),
    (error) => error === failure,
  );
  assert.ok(f.events.includes("valkey:quit"));
});

test("stalled subscription close detaches the fatal handler and contains queued shutdown errors until settlement", async () => {
  const f = fixture();
  let releaseClose!: () => void;
  let fatals = 0;
  const loggedErrors: unknown[] = [];
  f.dependencies.logger.error = (_name, error) => {
    loggedErrors.push(error);
  };
  f.subscription.close = async () => {
    f.events.push("subscription:close");
    await new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
  };
  const stop = await startRealtimeDispatcher({
    dependencies: f.dependencies,
    drainTimeoutMs: 20,
    onFatal: () => {
      fatals += 1;
    },
  });
  const fatalHandler = f.subscription.listeners("error")[0];
  const stopping = stop();
  try {
    assert.equal(f.subscription.listenerCount("message"), 0);
    assert.equal(
      f.subscription.listeners("error").includes(fatalHandler!),
      false,
    );
    const queuedError = new Error("queued streaming pull error during close");
    await Promise.resolve();
    assert.doesNotThrow(() => f.subscription.emit("error", queuedError));
    assert.doesNotThrow(() =>
      f.subscription.emit("error", new Error("repeated shutdown error")),
    );
    assert.equal(fatals, 0);
    assert.deepEqual(loggedErrors, [queuedError]);
    await stopping;
    assert.equal(f.subscription.listenerCount("error"), 1);
    assert.ok(f.events.includes("replayer:stop"));
    assert.ok(f.events.includes("valkey:destroy"));
    releaseClose();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.subscription.listenerCount("error"), 0);
    await stop();
    assert.equal(
      f.events.filter((event) => event === "subscription:close").length,
      1,
    );
  } finally {
    releaseClose();
    await stopping;
  }
});

test("rejected subscription close removes shutdown listeners and preserves its failure while draining other resources", async () => {
  const f = fixture();
  const failure = new Error("subscription close failed");
  f.subscription.close = async () => {
    f.events.push("subscription:close");
    throw failure;
  };
  const stop = await startRealtimeDispatcher({ dependencies: f.dependencies });
  await assert.rejects(stop(), (error) => error === failure);
  assert.equal(f.subscription.listenerCount("message"), 0);
  assert.equal(f.subscription.listenerCount("error"), 0);
  assert.ok(f.events.includes("replayer:stop"));
  assert.ok(f.events.includes("valkey:quit"));
  assert.ok(f.events.includes("valkey:destroy"));
});

test("connection startup failure destroys the created client without starting other resources", async () => {
  const f = fixture();
  Object.assign(f.publisher, { isOpen: false });
  f.dependencies.connectPublisher = async () => {
    throw new Error("connect failed");
  };
  await assert.rejects(
    startRealtimeDispatcher({ dependencies: f.dependencies }),
    /connect failed/,
  );
  assert.deepEqual(f.events, ["valkey:destroy"]);
});

test("startup cancellation destroys a hanging connection and settles without starting subscriptions", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.dependencies.connectPublisher = () => new Promise(() => undefined);
  const startup = startRealtimeDispatcher({
    dependencies: f.dependencies,
    signal: controller.signal,
    drainTimeoutMs: 5,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort("worker_shutdown");
  const result = await Promise.race([
    startup.then(
      () => "started",
      (error) => error.name,
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 100)),
  ]);
  assert.equal(result, "AbortError");
  assert.deepEqual(f.events, ["valkey:destroy"]);
  assert.equal(f.subscription.listenerCount("message"), 0);
});

test("late connection errors after bootstrap cancellation remain contained by the closed owner", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.dependencies.connectPublisher = () => new Promise(() => undefined);
  const startup = startRealtimeDispatcher({
    dependencies: f.dependencies,
    signal: controller.signal,
    drainTimeoutMs: 5,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort("worker_shutdown");
  await assert.rejects(startup, { name: "AbortError" });
  assert.doesNotThrow(() =>
    f.publisher.emit("error", new Error("late connect failure")),
  );
});

test("SIGTERM during dispatcher bootstrap allows the shared worker lifecycle to finish", async () => {
  const f = fixture();
  let shutdown!: () => void;
  let polled = false;
  let workerStopped = false;
  f.dependencies.connectPublisher = () => new Promise(() => undefined);
  const running = runTemporalWorkerLifecycle({
    workers: [
      {
        run: async () => {
          polled = true;
        },
        shutdown: () => {
          workerStopped = true;
        },
      },
    ],
    auxiliaryStarters: [
      (signal, onFatal) =>
        startRealtimeDispatcher({
          dependencies: f.dependencies,
          signal,
          onFatal,
          drainTimeoutMs: 5,
        }),
    ],
    installShutdownHandler: (handler) => {
      shutdown = handler;
      return () => undefined;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  shutdown();
  assert.equal(
    await Promise.race([
      running.then(() => "stopped"),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("blocked"), 100),
      ),
    ]),
    "stopped",
  );
  assert.equal(polled, false);
  assert.equal(workerStopped, true);
  assert.deepEqual(f.events, ["valkey:destroy"]);
});

test("a recovery stopper created after startup cancellation is stopped exactly once", async () => {
  const f = fixture();
  const controller = new AbortController();
  let resolveReplayer!: (value: () => Promise<void>) => void;
  f.dependencies.startReplayer = () =>
    new Promise((resolve) => {
      resolveReplayer = resolve;
    });
  const startup = startRealtimeDispatcher({
    dependencies: f.dependencies,
    signal: controller.signal,
    drainTimeoutMs: 5,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort("worker_shutdown");
  assert.equal(
    await Promise.race([
      startup.then(
        () => "started",
        (error) => error.name,
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("blocked"), 100),
      ),
    ]),
    "AbortError",
  );
  resolveReplayer(async () => {
    f.events.push("replayer:stop");
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.events.filter((event) => event === "replayer:stop").length, 1);
  assert.equal(f.subscription.listenerCount("message"), 0);
});

test("the shutdown deadline destroys an unresponsive generic client while leaving the message unacknowledged", async () => {
  const f = fixture();
  Object.assign(f.publisher, { eval: () => new Promise(() => undefined) });
  const stop = await startRealtimeDispatcher({
    dependencies: f.dependencies,
    drainTimeoutMs: 5,
  });
  const frame = message();
  f.subscription.emit("message", frame as unknown as Message);
  await stop();
  assert.deepEqual(frame.counts(), { ack: 0, nack: 0 });
  assert.ok(f.events.includes("valkey:destroy"));
  assert.ok(!f.events.includes("valkey:quit"));
});

test("managed dispatcher closes intake and drains admitted publish work before Valkey closes", async () => {
  const f = fixture();
  let release!: () => void;
  Object.assign(f.publisher, {
    eval: async () =>
      new Promise((resolve) => {
        release = () => resolve([1, 1]);
      }),
  });
  const stop = await startRealtimeDispatcher({ dependencies: f.dependencies });
  const frame = message();
  f.subscription.emit("message", frame as unknown as Message);
  const stopping = stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.subscription.listenerCount("message"), 0);
  assert.ok(!f.events.includes("valkey:quit"));
  release();
  await stopping;
  await stop();
  assert.deepEqual(frame.counts(), { ack: 1, nack: 0 });
  assert.equal(f.events.filter((event) => event === "valkey:quit").length, 1);
  assert.ok(
    f.events.indexOf("replayer:stop") < f.events.indexOf("valkey:quit"),
  );
});

test("dispatcher participates in the existing SIGTERM lifecycle and reports subscription failure", async () => {
  const f = fixture();
  let shutdown!: () => void;
  let endPolling!: () => void;
  let fatal: unknown;
  const running = runTemporalWorkerLifecycle({
    workers: [
      {
        run: () =>
          new Promise((resolve) => {
            endPolling = resolve;
          }),
        shutdown: () => endPolling(),
      },
    ],
    auxiliaryStarters: [
      (_signal, reportFatal) =>
        startRealtimeDispatcher({
          dependencies: f.dependencies,
          onFatal: (error) => {
            fatal = error;
            reportFatal(error);
          },
        }),
    ],
    installShutdownHandler: (handler) => {
      shutdown = handler;
      return () => undefined;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  shutdown();
  await running;
  assert.equal(fatal, undefined);
  assert.ok(f.events.includes("valkey:quit"));
  const g = fixture();
  const failure = new Error("subscriber unavailable");
  const stop = await startRealtimeDispatcher({
    dependencies: g.dependencies,
    onFatal: (error) => {
      fatal = error;
    },
  });
  g.subscription.emit("error", failure);
  assert.strictEqual(fatal, failure);
  await stop();
});
