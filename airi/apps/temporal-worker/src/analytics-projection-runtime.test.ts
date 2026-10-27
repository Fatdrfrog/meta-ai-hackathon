import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

async function loadBridge() {
  assert.ok(
    existsSync(new URL("./analytics-projection-runtime.ts", import.meta.url)),
    "the worker must provide an analytics runtime bridge",
  );
  return import("./analytics-projection-runtime");
}

test("analytics startup resolves the web owner's CommonJS module namespace", async () => {
  const { startAnalyticsProjectionRuntime } = await loadBridge();
  const signal = new AbortController().signal;
  let starts = 0;
  let stops = 0;
  const stop = await startAnalyticsProjectionRuntime({
    enabled: true,
    signal,
    loadRuntime: async () => ({
      default: {
        startAnalyticsProjectionRuntime: async (input: {
          signal?: AbortSignal;
        }) => {
          assert.strictEqual(input.signal, signal);
          starts += 1;
          return async () => {
            stops += 1;
          };
        },
      },
    }),
  });
  await stop();
  assert.equal(starts, 1);
  assert.equal(stops, 1);
});

test("disabled analytics does not load the web owner", async () => {
  const { startAnalyticsProjectionRuntime } = await loadBridge();
  let imports = 0;
  const stop = await startAnalyticsProjectionRuntime({
    enabled: false,
    signal: new AbortController().signal,
    loadRuntime: async () => {
      imports += 1;
      throw new Error("disabled analytics must not import web persistence");
    },
  });
  await stop();
  assert.equal(imports, 0);
});

test("enabled analytics passes worker cancellation and logging and awaits owner drain", async () => {
  const { startAnalyticsProjectionRuntime } = await loadBridge();
  const signal = new AbortController().signal;
  const logger = { info: () => undefined, error: () => undefined };
  let starts = 0;
  let releaseDrain!: () => void;
  const draining = new Promise<void>((resolve) => {
    releaseDrain = resolve;
  });
  const stop = await startAnalyticsProjectionRuntime({
    enabled: true,
    signal,
    logger,
    loadRuntime: async () => ({
      startAnalyticsProjectionRuntime: async (input) => {
        starts += 1;
        assert.strictEqual(input.signal, signal);
        assert.strictEqual(input.logger, logger);
        assert.equal(input.workspaceId, undefined);
        return () => draining;
      },
    }),
  });
  let stopped = false;
  const stoppedPromise = stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  releaseDrain();
  await stoppedPromise;
  assert.equal(starts, 1);
  assert.equal(stopped, true);
});

test("already cancelled analytics startup does not load the web owner", async () => {
  const { startAnalyticsProjectionRuntime } = await loadBridge();
  const controller = new AbortController();
  controller.abort("worker_shutdown");
  const stop = await startAnalyticsProjectionRuntime({
    enabled: true,
    signal: controller.signal,
    loadRuntime: async () => {
      throw new Error("shutdown must not import analytics");
    },
  });
  await stop();
});

test("cancellation during lazy loading prevents owner startup", async () => {
  const { startAnalyticsProjectionRuntime } = await loadBridge();
  const controller = new AbortController();
  let starts = 0;
  const stop = await startAnalyticsProjectionRuntime({
    enabled: true,
    signal: controller.signal,
    loadRuntime: async () => {
      controller.abort("worker_shutdown");
      return {
        startAnalyticsProjectionRuntime: async () => {
          starts += 1;
          return async () => undefined;
        },
      };
    },
  });
  await stop();
  assert.equal(starts, 0);
});

test("failed analytics prerequisites never fail worker startup and retry with a logged cause", async () => {
  const { startAnalyticsProjectionRuntime } = await loadBridge();
  const controller = new AbortController();
  const errors: Array<{ cause: unknown; context: unknown }> = [];
  let attempts = 0;
  let stops = 0;
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const stop = await startAnalyticsProjectionRuntime({
    enabled: true,
    signal: controller.signal,
    logger: {
      info: () => undefined,
      error: (_event, cause, context) => errors.push({ cause, context }),
    },
    retryInitialMs: 1,
    retryMaxMs: 2,
    loadRuntime: async () => ({
      startAnalyticsProjectionRuntime: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(
            new Error(
              "Analytics SQL projection prerequisites unavailable: mongodb://user:secret@db.example/x",
            ),
            { code: "PGRST202" },
          );
        }
        started();
        return async () => {
          stops += 1;
        };
      },
    }),
  });
  assert.equal(typeof stop, "function");
  await running;
  assert.equal(attempts, 3);
  assert.deepEqual(
    errors.map(({ context }) => context),
    [
      { phase: "runtime_start", retryInMs: 1 },
      { phase: "runtime_start", retryInMs: 2 },
    ],
  );
  assert.deepEqual(errors[0]?.cause, {
    name: "Error",
    code: "PGRST202",
    message: "Analytics SQL projection prerequisites unavailable: [url]",
  });
  controller.abort("worker_shutdown");
  await stop();
  assert.equal(stops, 1);
});

test("shutdown during a prerequisite backoff stops promptly without starting analytics", async () => {
  const { startAnalyticsProjectionRuntime } = await loadBridge();
  const controller = new AbortController();
  let attempts = 0;
  let failed!: () => void;
  const firstFailure = new Promise<void>((resolve) => {
    failed = resolve;
  });
  const stop = await startAnalyticsProjectionRuntime({
    enabled: true,
    signal: controller.signal,
    logger: { info: () => undefined, error: () => failed() },
    loadRuntime: async () => ({
      startAnalyticsProjectionRuntime: async () => {
        attempts += 1;
        throw new Error("supabase unavailable");
      },
    }),
  });
  await firstFailure;
  const startedAt = Date.now();
  controller.abort("worker_shutdown");
  await stop();
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(attempts, 1);
});

test("shutdown never waits on a hung analytics start beyond its deadline", async () => {
  const { startAnalyticsProjectionRuntime } = await loadBridge();
  const controller = new AbortController();
  const stop = await startAnalyticsProjectionRuntime({
    enabled: true,
    signal: controller.signal,
    stopDeadlineMs: 20,
    loadRuntime: async () => ({
      startAnalyticsProjectionRuntime: () => new Promise(() => undefined),
    }),
  });
  controller.abort("worker_shutdown");
  const startedAt = Date.now();
  await stop();
  assert.ok(Date.now() - startedAt < 1_000);
});

test("worker activates analytics separately from Requests and excludes media-only mode", () => {
  const source = readFileSync(new URL("./worker.ts", import.meta.url), "utf8");
  assert.match(source, /if\s*\(!mediaOnly\)\s*\{\s*auxiliaryStarters\.push/);
  assert.match(
    source,
    /enabled:\s*parseBooleanEnv\("ANALYTICS_PROJECTION_ENABLED", false\)/,
  );
  assert.match(
    source,
    /startAnalyticsProjectionRuntime\(\{[^}]*signal,[^}]*logger:\s*airiWorkerLogger/s,
  );
});
