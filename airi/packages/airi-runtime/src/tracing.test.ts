import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  configureTracingAdapter,
  mergeCurrentRunMetadata,
  setCurrentRunUsageMetadata,
  traceableChain,
  traceableEmbedding,
  traceableTask,
  type TraceRequest,
  type TracingAdapter,
} from "./tracing.js";

afterEach(() => {
  configureTracingAdapter(null);
});

test("traceable functions preserve arguments, return values, and this without an adapter", () => {
  const target = {
    prefix: "airi",
    operation(this: { prefix: string }, suffix: string) {
      return `${this.prefix}:${suffix}`;
    },
  };
  target.operation = traceableChain(target.operation, {
    name: "airi.test.operation",
  });

  assert.equal(target.operation("reply"), "airi:reply");
});

test("wrappers resolve the adapter at invocation time", () => {
  const requests: Array<{ operation: string; name: string }> = [];
  const traced = traceableChain((value: number) => value * 2, {
    name: "airi.test.late_configuration",
  });
  const adapter: TracingAdapter = {
    trace(request, execute) {
      requests.push({ operation: request.operation, name: request.name });
      return execute();
    },
    mergeMetadata() {},
    setUsage() {},
  };

  configureTracingAdapter(adapter);

  assert.equal(traced(21), 42);
  assert.deepEqual(requests, [
    { operation: "chain", name: "airi.test.late_configuration" },
  ]);
});

test("session identity resolution is fail-open", () => {
  const requests: TraceRequest[] = [];
  configureTracingAdapter({
    trace(request, execute) {
      requests.push(request);
      return execute();
    },
    mergeMetadata() {},
    setUsage() {},
  });
  const traced = traceableChain(() => "done", {
    name: "airi.test.session_identity_failure",
    getSessionIdentity() {
      throw new Error("private identity lookup failed");
    },
  });

  assert.equal(traced(), "done");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.sessionIdentity, undefined);
});

test("an adapter failure after execution preserves the business result without retrying", () => {
  let executions = 0;
  const adapterError = new Error("adapter failed after execution");
  configureTracingAdapter({
    trace(_request, execute) {
      execute();
      throw adapterError;
    },
    mergeMetadata() {},
    setUsage() {},
  });
  const traced = traceableChain(
    () => {
      executions += 1;
      return "done";
    },
    { name: "airi.test.single_execution" },
  );

  assert.equal(traced(), "done");
  assert.equal(executions, 1);
});

test("an asynchronous adapter failure preserves the original business promise", async () => {
  let executions = 0;
  configureTracingAdapter({
    trace<T>(_request: TraceRequest, execute: () => T): T {
      execute();
      return Promise.reject(new Error("adapter failed asynchronously")) as T;
    },
    mergeMetadata() {},
    setUsage() {},
  });
  const traced = traceableChain(
    async () => {
      executions += 1;
      return "done";
    },
    { name: "airi.test.async_adapter_failure" },
  );

  assert.equal(await traced(), "done");
  assert.equal(executions, 1);
});

test("adapter failures never replace an original business error", async () => {
  const syncError = new Error("sync business failure");
  const asyncError = new Error("async business failure");
  configureTracingAdapter({
    trace<T>(request: TraceRequest, execute: () => T): T {
      if (request.name.endsWith("sync")) {
        try {
          execute();
        } catch {
          throw new Error("adapter replaced sync failure");
        }
      }
      const result = execute();
      return Promise.resolve(result).catch(() => {
        throw new Error("adapter replaced async failure");
      }) as T;
    },
    mergeMetadata() {},
    setUsage() {},
  });
  const syncFailure = traceableChain(
    () => {
      throw syncError;
    },
    { name: "airi.test.sync" },
  );
  const asyncFailure = traceableChain(
    async () => {
      throw asyncError;
    },
    { name: "airi.test.async" },
  );

  assert.throws(syncFailure, (error) => error === syncError);
  await assert.rejects(asyncFailure, (error) => error === asyncError);
});

test("metadata and usage annotations delegate to the active adapter", () => {
  const metadata: Array<Record<string, unknown>> = [];
  const usage: Array<Record<string, unknown> | undefined> = [];
  configureTracingAdapter({
    trace(_request, execute) {
      return execute();
    },
    mergeMetadata(value) {
      metadata.push(value);
    },
    setUsage(value) {
      usage.push(value);
    },
  });

  mergeCurrentRunMetadata({ channel: "whatsapp" });
  setCurrentRunUsageMetadata({
    input_tokens: 11,
    output_tokens: 7,
    total_tokens: 18,
  });

  assert.deepEqual(metadata, [{ channel: "whatsapp" }]);
  assert.deepEqual(usage, [
    { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
  ]);
});

test("task wrappers retain their task operation at the adapter boundary", async () => {
  const operations: string[] = [];
  configureTracingAdapter({
    trace(request, execute) {
      operations.push(request.operation);
      return execute();
    },
    mergeMetadata() {},
    setUsage() {},
  });
  const traced = traceableTask(async () => "complete", {
    name: "airi.temporal.activity",
  });

  assert.equal(await traced(), "complete");
  assert.deepEqual(operations, ["task"]);
});

test("embedding wrappers retain their embedding operation at the adapter boundary", async () => {
  const operations: string[] = [];
  configureTracingAdapter({
    trace(request, execute) {
      operations.push(request.operation);
      return execute();
    },
    mergeMetadata() {},
    setUsage() {},
  });
  const traced = traceableEmbedding(async () => [0.1, 0.2], {
    name: "vertex.embed_content",
  });

  assert.deepEqual(await traced(), [0.1, 0.2]);
  assert.deepEqual(operations, ["embedding"]);
});
