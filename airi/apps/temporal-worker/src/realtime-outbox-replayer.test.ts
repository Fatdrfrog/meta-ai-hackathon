import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createRealtimeOutboxReplayer,
  startRealtimeOutboxReplayer,
  startRequestsProjectionRuntime,
} from "./realtime-outbox-replayer";

for (const url of [
  "not-a-url",
  "https://127.0.0.1:16379",
  "redis://example.invalid:16379",
]) {
  test(`Valkey integration skips unsupported configuration: ${url}`, () => {
    const env: NodeJS.ProcessEnv = { ...process.env, REALTIME_VALKEY_URL: url };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--test",
        "--test-reporter=tap",
        fileURLToPath(
          new URL(
            "./realtime-outbox-replayer.integration.test.ts",
            import.meta.url,
          ),
        ),
      ],
      { env, encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /# skipped 1\b/);
  });
}

test("realtime outbox replayer does not overlap slow replay batches", async () => {
  let releaseFirstRun!: () => void;
  let calls = 0;
  const replayer = createRealtimeOutboxReplayer({
    intervalMs: 1000,
    replayBatch: async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstRun = resolve;
        });
      }
      return { claimed: 0, published: 0, failed: 0 };
    },
    logger: {
      error: () => undefined,
      info: () => undefined,
    },
  });

  const firstRun = replayer.runOnce();
  try {
    await replayer.runOnce();
    assert.equal(calls, 1);

    releaseFirstRun();
    await firstRun;
    await replayer.runOnce();

    assert.equal(calls, 2);
  } finally {
    releaseFirstRun();
    await firstRun;
  }
});

test("only the scan lease owner enters Mongo recovery and stopping drains its batch", async () => {
  let scans = 0;
  let owner: string | null = null;
  let releaseBatch!: () => void;
  let releases = 0;
  const make = (id: string) =>
    createRealtimeOutboxReplayer({
      logger: { info: () => undefined, error: () => undefined },
      ownership: {
        acquireOrRenew: async () => {
          if (owner && owner !== id) return false;
          owner = id;
          return true;
        },
        release: async () => {
          if (owner === id) {
            owner = null;
            releases += 1;
          }
        },
      },
      replayBatch: async () => {
        scans += 1;
        if (id === "a")
          await new Promise<void>((resolve) => {
            releaseBatch = resolve;
          });
        return { claimed: 0, published: 0, failed: 0 };
      },
    });
  const a = make("a");
  const b = make("b");
  const stop = a.start();
  await new Promise((resolve) => setImmediate(resolve));
  await b.runOnce();
  try {
    assert.equal(scans, 1);
    let stopped = false;
    const draining = Promise.resolve(stop()).then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    assert.equal(releases, 0);
    releaseBatch();
    await draining;
    assert.equal(releases, 1);
    const next = b.runOnce();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scans, 2);
    await next;
  } finally {
    releaseBatch();
    await stop();
  }
});

test("scan ownership loss prevents further row admission during a slow batch", async () => {
  let renewals = 0;
  let mayContinue!: () => boolean;
  let releaseBatch!: () => void;
  const replayer = createRealtimeOutboxReplayer({
    intervalMs: 5,
    ownership: {
      acquireOrRenew: async () => ++renewals === 1,
      release: async () => undefined,
    },
    logger: { info: () => undefined, error: () => undefined },
    replayBatch: async (input) => {
      mayContinue = input.shouldContinue;
      await new Promise<void>((resolve) => {
        releaseBatch = resolve;
      });
      return { claimed: 0, published: 0, failed: 0 };
    },
  });
  const stop = replayer.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(mayContinue(), false);
  } finally {
    releaseBatch();
    await stop();
  }
});

test("an expired in-flight scan cannot reacquire ownership and resume its old batch", async () => {
  let acquisitions = 0;
  let release!: () => void;
  let mayContinue!: () => boolean;
  const replayer = createRealtimeOutboxReplayer({
    intervalMs: 20,
    ownership: {
      leaseMs: 5,
      acquireOrRenew: async () => {
        acquisitions += 1;
        return true;
      },
      release: async () => undefined,
    },
    logger: { info: () => undefined, error: () => undefined },
    replayBatch: async (input) => {
      mayContinue = input.shouldContinue;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { claimed: 0, published: 0, failed: 0 };
    },
  });
  const stop = replayer.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(acquisitions, 1);
    assert.equal(mayContinue(), false);
  } finally {
    release();
    await stop();
  }
});

test("a wall-clock rollback cannot extend an in-flight Valkey scan lease", async (context) => {
  let acquisitions = 0;
  let release!: () => void;
  let mayContinue!: () => boolean;
  const replayer = createRealtimeOutboxReplayer({
    intervalMs: 20,
    ownership: {
      leaseMs: 5,
      acquireOrRenew: async () => {
        acquisitions += 1;
        return true;
      },
      release: async () => undefined,
    },
    logger: { info: () => undefined, error: () => undefined },
    replayBatch: async (input) => {
      mayContinue = input.shouldContinue;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { claimed: 0, published: 0, failed: 0 };
    },
  });
  const stop = replayer.start();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    context.mock.method(Date, "now", () => 0);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(acquisitions, 1);
    assert.equal(mayContinue(), false);
  } finally {
    release();
    await stop();
  }
});

test("main projection startup forwards its options without starting an outbox replayer", async () => {
  const signal = new AbortController().signal;
  let projectionStarts = 0;
  let replayStarts = 0;
  const stop = await startRequestsProjectionRuntime({
    signal,
    ownerToken: "worker-1",
    realtimeEnabled: true,
    loadRuntime: async () => ({
      replayRealtimeOutboxBatch: async () => {
        replayStarts += 1;
        return { claimed: 0, published: 0, failed: 0 };
      },
      startProductionRequestsProjectionRuntime: async (input) => {
        projectionStarts += 1;
        assert.strictEqual(input.signal, signal);
        assert.equal(input.ownerToken, "worker-1");
        assert.equal(input.realtimeEnabled, true);
        return async () => undefined;
      },
      drainPendingLlmAnalyticsEvents: async () => true,
    }),
  });

  await stop();
  assert.equal(projectionStarts, 1);
  assert.equal(replayStarts, 0);
});

test("dispatcher startup owns the sole replayer", async () => {
  let replayStarts = 0;
  const stop = await startRealtimeOutboxReplayer({
    intervalMs: 60_000,
    loadRuntime: async () => ({
      replayRealtimeOutboxBatch: async () => {
        replayStarts += 1;
        return { claimed: 0, published: 0, failed: 0 };
      },
      startProductionRequestsProjectionRuntime: async () => async () =>
        undefined,
      drainPendingLlmAnalyticsEvents: async () => true,
    }),
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  stop();
  assert.equal(replayStarts, 1);
});
