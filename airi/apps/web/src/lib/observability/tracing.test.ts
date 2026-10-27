import {
  configureTracingAdapter,
  traceableChain,
  traceableEmbedding,
  traceableLlm,
  traceableRetriever,
  traceableTask,
} from "./tracing";

describe("web tracing composition", () => {
  afterEach(() => {
    configureTracingAdapter(null);
  });

  it.each([
    ["chain", traceableChain],
    ["embedding", traceableEmbedding],
    ["llm", traceableLlm],
    ["retriever", traceableRetriever],
    ["task", traceableTask],
  ] as const)(
    "executes %s work immediately and preserves its promise",
    (_name, trace) => {
      const result = Promise.resolve("ok");
      const calls: string[] = [];
      const context = { prefix: "operation" };
      const operation = trace(
        function (this: typeof context, value: string) {
          calls.push(`${this.prefix}:${value}`);
          return result;
        },
        { name: "test.web_trace" }
      );

      expect(operation.call(context, "input")).toBe(result);
      expect(calls).toEqual(["operation:input"]);
    }
  );

  it("preserves the original business rejection", async () => {
    const error = new Error("business operation failed");
    const operation = traceableChain(
      async () => {
        throw error;
      },
      { name: "test.failed_web_trace" }
    );

    await expect(operation()).rejects.toBe(error);
  });
});
