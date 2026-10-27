const mockInfo = jest.fn();
const mockWarn = jest.fn();
jest.mock("@/lib/observability/server-logs", () => ({
  createServerLogger: () => ({
    info: (...args: unknown[]) => mockInfo(...args),
    warn: (...args: unknown[]) => mockWarn(...args),
  }),
}));

import {
  createMetaAdsMcpOperationEvent,
  type MetaAdsMcpSafeOperationFields,
} from "./operation-event";

describe("Meta Ads operation evidence", () => {
  beforeEach(() => jest.clearAllMocks());

  it("records bounded planner outcomes without raw output or arguments", () => {
    const event = createMetaAdsMcpOperationEvent({
      operation: "plan",
      operationId: "plan-1",
      workspaceId: "workspace-1",
    });
    event.add({
      lifecycleStage: "arguments",
      attemptCount: 2,
      retryCount: 1,
      finishReason: "MAX_TOKENS",
      incomplete: true,
      rawOutput: "private payload",
      arguments: { access_token: "secret" },
    } as MetaAdsMcpSafeOperationFields);
    event.finish("failed", "invalid_arguments");
    event.finish("succeeded");
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockInfo).not.toHaveBeenCalled();
    const fields = mockWarn.mock.calls[0][1];
    expect(fields).toMatchObject({
      operation: "plan",
      outcome: "failed",
      errorCode: "invalid_arguments",
      attemptCount: 2,
      retryCount: 1,
      finishReason: "MAX_TOKENS",
      incomplete: true,
    });
    expect(fields).not.toHaveProperty("rawOutput");
    expect(fields).not.toHaveProperty("arguments");
  });

  it("drops unknown model finish text and invalid counters", () => {
    const event = createMetaAdsMcpOperationEvent({
      operation: "turn",
      operationId: "turn-1",
    });
    event.add({
      finishReason: "untrusted provider text",
      attemptCount: -1,
      retryCount: Number.NaN,
      httpStatus: 200,
    });
    event.finish("not_executed");
    expect(mockInfo.mock.calls[0][1]).not.toHaveProperty("finishReason");
    expect(mockInfo.mock.calls[0][1]).not.toHaveProperty("attemptCount");
    expect(mockInfo.mock.calls[0][1]).not.toHaveProperty("retryCount");
    expect(mockInfo.mock.calls[0][1]).not.toHaveProperty("httpStatus");
  });

  it("records safe summary failure categories and HTTP status", () => {
    const event = createMetaAdsMcpOperationEvent({
      operation: "summary",
      operationId: "summary-1",
    });
    event.add({ httpStatus: 429 });
    event.finish("failed", "summary_provider_failed");
    expect(mockWarn.mock.calls[0][1]).toMatchObject({
      operation: "summary",
      httpStatus: 429,
      errorCode: "summary_provider_failed",
    });
  });
});
