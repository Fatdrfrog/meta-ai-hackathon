import { isTemporalSdkError, loadTemporalClientSdk } from "./sdk";

describe("Temporal SDK runtime loader", () => {
  const {
    QueryNotRegisteredError,
    WorkflowExecutionAlreadyStartedError,
    WorkflowNotFoundError,
  } = loadTemporalClientSdk();

  it("matches the SDK's own error instances", () => {
    expect(
      isTemporalSdkError(
        new WorkflowNotFoundError("gone", "workflow-1", undefined),
        "WorkflowNotFoundError"
      )
    ).toBe(true);
    expect(
      isTemporalSdkError(
        new WorkflowExecutionAlreadyStartedError(
          "already started",
          "workflow-1",
          "workflowType"
        ),
        "WorkflowExecutionAlreadyStartedError"
      )
    ).toBe(true);
    expect(
      isTemporalSdkError(
        new QueryNotRegisteredError("missing query", 3),
        "QueryNotRegisteredError"
      )
    ).toBe(true);
  });

  it("does not match a different SDK error or a look-alike name", () => {
    const spoofed = Object.assign(new Error("connection refused"), {
      name: "WorkflowNotFoundError",
    });

    expect(isTemporalSdkError(spoofed, "WorkflowNotFoundError")).toBe(false);
    expect(
      isTemporalSdkError(
        new WorkflowNotFoundError("gone", "workflow-1", undefined),
        "WorkflowExecutionAlreadyStartedError"
      )
    ).toBe(false);
    expect(
      isTemporalSdkError("WorkflowNotFoundError", "WorkflowNotFoundError")
    ).toBe(false);
  });

  it("loads the client constructors the web client needs", () => {
    const sdk = loadTemporalClientSdk();

    expect(sdk).toBe(loadTemporalClientSdk());
    expect(typeof sdk.Client).toBe("function");
    expect(typeof sdk.Connection.lazy).toBe("function");
  });
});
