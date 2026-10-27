const mockPrepare = jest.fn();
const mockClaim = jest.fn();
const mockComplete = jest.fn();
const mockFail = jest.fn();
const mockReceipt = jest.fn();
jest.mock("@icecore/airi-runtime", () => ({
  prepareAiriAutoReplyJob: (...args: unknown[]) => mockPrepare(...args),
  isAiriTurnPreparationNotStartedError: (error: {
    preparationNotStarted?: boolean;
  }) => error.preparationNotStarted === true,
}));
jest.mock("@icecore/airi-runtime/logging", () => ({
  airiWorkerLogger: { info: jest.fn(), error: jest.fn() },
}));
jest.mock("@icecore/airi-runtime/module-interop", () => ({
  readDefaultExport: (module: unknown) => module,
}));
jest.mock("@/lib/airi/scenario/timer-runtime-dependencies", () => ({
  airiScenarioTimerDependencies: {},
}));
jest.mock("@/lib/airi/scenario/auto-reply-runtime-dependencies", () => ({
  // The host module re-exports the real provider error helpers.
  AIChatProviderAggregateError: jest.requireActual("@/lib/ai/provider-errors")
    .AIChatProviderAggregateError,
  isRetryableAIProviderError: jest.requireActual("@/lib/ai/provider-errors")
    .isRetryableAIProviderError,
  scenarioRuntimeDependencies: {},
  withWorkspaceRuntimeCapacity: (
    _workspaceId: string,
    _lane: string,
    run: () => Promise<unknown>
  ) => run(),
}));
jest.mock(
  "../../../../temporal-worker/src/creative-asset-read-url-gcs-adapter.js",
  () => ({ configureGcsCreativeAssetReadUrlPort: jest.fn() }),
  { virtual: true }
);
jest.mock(
  "../../../../temporal-worker/src/whatsapp-voice-reply-gcs-adapter.js",
  () => ({ configureGcsWhatsAppVoiceReplyStorage: jest.fn() }),
  { virtual: true }
);

import { prepareAiriConversationTurn } from "../../../../temporal-worker/src/activities/airi-auto-reply";
import { AIChatProviderAggregateError } from "@/lib/ai/provider-errors";
import {
  AIRI_TURN_PREPARATION_NOT_STARTED,
  AIRI_TURN_PREPARATION_OUTCOME_UNKNOWN,
  type AiriConversationTurnSignal,
} from "@icecore/temporal";
const turn = {
  workspaceId: "ws",
  conversationId: "conv",
  messageId: "message",
  turnContextId: "context",
  enqueuedAt: "2026-09-09T00:00:00Z",
} as AiriConversationTurnSignal;
const claim = { status: "claimed", attemptToken: "owner" };
const executionStore = {
  claimAiriTurnPreparation: mockClaim,
  completeAiriTurnPreparation: mockComplete,
  failAiriTurnPreparation: mockFail,
  recordAiriConversationTurnDisposition: mockReceipt,
};

beforeEach(() => {
  jest.resetAllMocks();
  mockClaim.mockResolvedValue(claim);
  mockPrepare.mockResolvedValue({ result: undefined, pendingDelivery: null });
  mockComplete.mockResolvedValue(undefined);
  mockFail.mockResolvedValue(undefined);
});

it("returns the persisted preparation after a lost activity response without executing runtime", async () => {
  const result = {
    messageId: "message",
    completedAt: "saved",
    outcome: { executionStatus: "completed" },
  };
  mockClaim.mockResolvedValueOnce({ status: "prepared", result });
  expect(await prepareAiriConversationTurn(turn, executionStore)).toBe(result);
  expect(mockPrepare).not.toHaveBeenCalled();
});

it("does not execute a preparation whose earlier outcome is unknown", async () => {
  mockClaim.mockResolvedValueOnce({ status: "outcome_unknown" });
  await expect(
    prepareAiriConversationTurn(turn, executionStore)
  ).rejects.toMatchObject({
    type: AIRI_TURN_PREPARATION_OUTCOME_UNKNOWN,
    nonRetryable: true,
  });
  expect(mockPrepare).not.toHaveBeenCalled();
});

it("returns a terminal disposition without runtime execution for superseded work", async () => {
  mockClaim.mockResolvedValueOnce({ status: "terminal" });
  await expect(
    prepareAiriConversationTurn(turn, executionStore)
  ).rejects.toMatchObject({
    type: "AIRI_TURN_PREPARATION_TERMINAL",
    nonRetryable: true,
  });
  expect(mockPrepare).not.toHaveBeenCalled();
  expect(mockComplete).not.toHaveBeenCalled();
  expect(mockFail).not.toHaveBeenCalled();
});

it("stores the complete delivery and effects checkpoint before returning", async () => {
  const delivery = {
    deliveryKey: "key",
    reservedMessageId: "reserved",
    context: {},
  };
  mockPrepare.mockResolvedValueOnce({
    result: undefined,
    pendingDelivery: delivery,
    postDeliveryEffects: [{ kind: "example" }],
  });
  const result = await prepareAiriConversationTurn(turn, executionStore);
  expect(mockComplete).toHaveBeenCalledWith(claim, result);
  expect(result.pendingDelivery).toMatchObject({
    ...delivery,
    postDeliveryEffects: [{ kind: "example" }],
  });
});

it("releases only known preflight failures for retry", async () => {
  mockPrepare.mockRejectedValueOnce(
    Object.assign(new Error("read failed"), { preparationNotStarted: true })
  );
  await expect(
    prepareAiriConversationTurn(turn, executionStore)
  ).rejects.toMatchObject({
    type: AIRI_TURN_PREPARATION_NOT_STARTED,
    nonRetryable: false,
  });
  expect(mockFail).toHaveBeenCalledWith(claim, "read failed", true);
});

it("persists generic runtime failures as unknown and prevents automatic retry", async () => {
  mockPrepare.mockRejectedValueOnce(new Error("effect failed"));
  await expect(
    prepareAiriConversationTurn(turn, executionStore)
  ).rejects.toMatchObject({
    type: AIRI_TURN_PREPARATION_OUTCOME_UNKNOWN,
    nonRetryable: true,
  });
  expect(mockFail).toHaveBeenCalledWith(claim, "effect failed", false);
});

it.each([
  {
    httpStatus: 402,
    retryable: false,
    failureType: "ai_chat_provider_failed",
  },
  {
    httpStatus: 503,
    retryable: true,
    failureType: AIRI_TURN_PREPARATION_OUTCOME_UNKNOWN,
  },
])(
  "classifies exhausted provider failure $httpStatus without replaying mutated scenario state",
  async ({ httpStatus, retryable, failureType }) => {
    const error = new AIChatProviderAggregateError([
      {
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        attempt: 1,
        fallbackIndex: 0,
        retryable,
        finishReason: null,
        promptBlockReason: null,
        httpStatus,
      },
    ]);
    mockPrepare.mockRejectedValueOnce(error);

    await expect(
      prepareAiriConversationTurn(turn, executionStore)
    ).rejects.toMatchObject({
      type: failureType,
      nonRetryable: true,
      ...(!retryable
        ? { details: [{ providerErrors: error.providerErrors }] }
        : {}),
    });
    expect(mockComplete).not.toHaveBeenCalled();
    expect(mockFail).toHaveBeenCalledWith(
      claim,
      "AI chat provider attempts failed",
      false
    );
  }
);

it("does not return success if prepared result persistence fails", async () => {
  mockComplete.mockRejectedValueOnce(new Error("checkpoint unavailable"));
  await expect(
    prepareAiriConversationTurn(turn, executionStore)
  ).rejects.toMatchObject({
    type: AIRI_TURN_PREPARATION_OUTCOME_UNKNOWN,
  });
});

it("marks a returned HTTP error as failed instead of completed", async () => {
  mockPrepare.mockResolvedValueOnce({
    result: Response.json({ error: "unavailable" }, { status: 503 }),
    pendingDelivery: null,
  });
  const result = await prepareAiriConversationTurn(turn, executionStore);
  expect(result.outcome.executionStatus).toBe("failed");
  expect(mockComplete).toHaveBeenCalledWith(claim, result);
});

it("does not treat an explicit failed response body as completed", async () => {
  mockPrepare.mockResolvedValueOnce({
    result: Response.json({ status: "failed" }),
    pendingDelivery: null,
  });
  expect(
    (await prepareAiriConversationTurn(turn, executionStore)).outcome
      .executionStatus
  ).toBe("failed");
});

it.each(["skipped_concurrent", "duplicate_processing"])("releases a confirmed payment %s response before it can become a permanent prepared receipt", async marker => {
  mockPrepare.mockResolvedValueOnce({ result: Response.json({ status: "ok", [marker]: true }), pendingDelivery: null });
  await expect(prepareAiriConversationTurn({ ...turn, messageId: "confirmed-payment:11111111-1111-4111-8111-111111111111" }, executionStore)).rejects.toMatchObject({
    type: AIRI_TURN_PREPARATION_NOT_STARTED, nonRetryable: false,
  });
  expect(mockComplete).not.toHaveBeenCalled();
  expect(mockFail).toHaveBeenCalledWith(claim, "Confirmed payment is waiting for the conversation lock", true);
});

it("persists a known unavailable payment context as skipped without invoking it again", async () => {
  mockPrepare.mockRejectedValueOnce(Object.assign(new Error("preflight"), {
    preparationNotStarted: true,
    cause: Object.assign(new Error("conversation was reassigned"), { code: "AIRI_CONFIRMED_PAYMENT_NOT_ELIGIBLE" }),
  }));
  const result = await prepareAiriConversationTurn({ ...turn, messageId: "confirmed-payment:11111111-1111-4111-8111-111111111111" }, executionStore);
  expect(result.outcome.responseBody).toMatchObject({ skipped_confirmed_payment_scenario: true });
  expect(mockComplete).toHaveBeenCalledWith(claim, result);
  expect(mockFail).not.toHaveBeenCalled();
});
