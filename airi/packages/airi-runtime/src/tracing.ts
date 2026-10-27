export { previewStringArray, previewText } from "./preview-text";

export type JsonRecord = Record<string, unknown>;
type MaybePromise<T> = T | Promise<T>;

export type UsageMetadata = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_token_details?: Record<string, number>;
  output_token_details?: Record<string, number>;
};

export type TraceSessionIdentity = {
  conversationId?: string;
  workspaceId?: string;
};

type FirstArgument<Args extends readonly unknown[]> = Args extends readonly [
  infer First,
  ...unknown[],
]
  ? First
  : undefined;

type ProcessInputs<Args extends readonly unknown[]> =
  | { args: Args }
  | { input: FirstArgument<Args> }
  | Record<string, unknown>;

type ProcessOutputs<Output> = { outputs: Output } | Record<string, unknown>;

type TraceableFunction = (...args: never[]) => unknown;

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function ignoreAdapterRejection(value: unknown): void {
  if (!isPromiseLike(value)) return;
  void Promise.resolve(value).catch(() => undefined);
}

export type TraceConfig<Func extends TraceableFunction> = {
  name?: string;
  tags?: readonly string[];
  metadata?: JsonRecord;
  processInputs?: (
    inputs: Readonly<ProcessInputs<Parameters<Func>>>,
  ) => JsonRecord | Promise<JsonRecord>;
  processOutputs?: (
    outputs: Readonly<ProcessOutputs<Awaited<ReturnType<Func>>>>,
  ) => JsonRecord | Promise<JsonRecord>;
  getMetadata?: (
    ...args: Parameters<Func>
  ) => MaybePromise<JsonRecord | null | undefined>;
  getSessionIdentity?: (
    ...args: Parameters<Func>
  ) => TraceSessionIdentity | null | undefined;
};

export type TraceOperation =
  | "chain"
  | "embedding"
  | "retriever"
  | "llm"
  | "task";

export type TraceRequest = {
  operation: TraceOperation;
  name: string;
  tags: readonly string[];
  metadata?: JsonRecord;
  getMetadata?: () => MaybePromise<JsonRecord | null | undefined>;
  sessionIdentity?: TraceSessionIdentity;
};

export type TracingAdapter = {
  trace<T>(request: TraceRequest, execute: () => T): T;
  mergeMetadata(metadata: JsonRecord): void;
  setUsage(usageMetadata: UsageMetadata | undefined): void;
};

const GLOBAL_ADAPTER_KEY = "__icecoreTracingAdapter__" as const;

type TracingGlobal = typeof globalThis & {
  [GLOBAL_ADAPTER_KEY]?: TracingAdapter | null;
};

function readTracingAdapter(): TracingAdapter | null {
  return (globalThis as TracingGlobal)[GLOBAL_ADAPTER_KEY] ?? null;
}

export function configureTracingAdapter(adapter: TracingAdapter | null): void {
  // globalThis keeps the composition-root adapter visible across duplicate
  // module graphs in Next.js and the Temporal worker.
  (globalThis as TracingGlobal)[GLOBAL_ADAPTER_KEY] = adapter;
}

export function messagePreview(
  messages: Array<{ role: string; content: string }>,
): Array<{ role: string; content: string }> {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

function traceable<Func extends TraceableFunction>(
  operation: TraceOperation,
  fn: Func,
  config: TraceConfig<Func>,
): Func {
  const wrapped = function (
    this: ThisParameterType<Func>,
    ...args: Parameters<Func>
  ): ReturnType<Func> {
    const execute = (): ReturnType<Func> =>
      Reflect.apply(fn, this, args) as ReturnType<Func>;
    const adapter = readTracingAdapter();
    if (!adapter) return execute();

    type Invocation =
      | { status: "not_started" }
      | { status: "returned"; value: ReturnType<Func> }
      | { status: "threw"; reason: unknown };
    let invocation: Invocation = { status: "not_started" };
    const readInvocation = (): Invocation => invocation;
    const executeOnce = (): ReturnType<Func> => {
      if (invocation.status === "returned") return invocation.value;
      if (invocation.status === "threw") throw invocation.reason;
      try {
        const value = execute();
        invocation = { status: "returned", value };
        return value;
      } catch (reason) {
        invocation = { status: "threw", reason };
        throw reason;
      }
    };
    let sessionIdentity: TraceSessionIdentity | undefined;
    try {
      sessionIdentity = config.getSessionIdentity?.(...args) ?? undefined;
    } catch {
      // Correlation is fail-open and must never block the business operation.
    }

    try {
      const adapterResult = adapter.trace(
        {
          operation,
          name: config.name || fn.name || `airi.${operation}`,
          tags: config.tags || [],
          metadata: config.metadata,
          getMetadata: config.getMetadata
            ? () => config.getMetadata!(...args)
            : undefined,
          sessionIdentity,
        },
        executeOnce,
      );

      const completedInvocation = readInvocation();
      if (completedInvocation.status === "not_started") {
        ignoreAdapterRejection(adapterResult);
        return executeOnce();
      }
      if (completedInvocation.status === "threw") {
        ignoreAdapterRejection(adapterResult);
        throw completedInvocation.reason;
      }
      if (adapterResult !== completedInvocation.value) {
        ignoreAdapterRejection(adapterResult);
      }
      return completedInvocation.value;
    } catch {
      const completedInvocation = readInvocation();
      if (completedInvocation.status === "not_started") return executeOnce();
      if (completedInvocation.status === "threw") {
        throw completedInvocation.reason;
      }
      // Observability failures after execution must not replace a successful
      // business result or trigger a second execution.
      return completedInvocation.value;
    }
  };

  return wrapped as Func;
}

export function traceableChain<Func extends TraceableFunction>(
  fn: Func,
  config: TraceConfig<Func>,
): Func {
  return traceable("chain", fn, config);
}

export function traceableRetriever<Func extends TraceableFunction>(
  fn: Func,
  config: TraceConfig<Func>,
): Func {
  return traceable("retriever", fn, config);
}

export function traceableLlm<Func extends TraceableFunction>(
  fn: Func,
  config: TraceConfig<Func>,
): Func {
  return traceable("llm", fn, config);
}

export function traceableEmbedding<Func extends TraceableFunction>(
  fn: Func,
  config: TraceConfig<Func>,
): Func {
  return traceable("embedding", fn, config);
}

export function traceableTask<Func extends TraceableFunction>(
  fn: Func,
  config: TraceConfig<Func>,
): Func {
  return traceable("task", fn, config);
}

export function mergeCurrentRunMetadata(metadata: JsonRecord): void {
  try {
    readTracingAdapter()?.mergeMetadata(metadata);
  } catch {
    // Observability must never change the business result.
  }
}

export function setCurrentRunUsageMetadata(
  usageMetadata: UsageMetadata | undefined,
): void {
  try {
    readTracingAdapter()?.setUsage(usageMetadata);
  } catch {
    // Observability must never change the business result.
  }
}
