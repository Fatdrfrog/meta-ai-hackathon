const mockFrom = jest.fn();
const mockConversation = jest.fn();
const mockReplan = jest.fn();
const mockChannel = jest.fn();
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: (...args: unknown[]) => mockFrom(...args) },
}));
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    findOne: (...args: unknown[]) => ({
      select: () => ({ lean: () => mockConversation(...args) }),
    }),
  },
}));
jest.mock("@/lib/airi/scenario/scenario-channel-utils", () => ({
  resolveChatDocument: async () => ({
    chatDocument: { _id: "chat" },
    chatId: "chat",
    chatType: "private",
  }),
  buildChannelSpecificParams: (...args: unknown[]) => mockChannel(...args),
}));
jest.mock("@/lib/airi/scenario/timer-runtime-dependencies", () => ({
  airiScenarioTimerDependencies: {},
}));
jest.mock("@icecore/airi-runtime/temporal-scenario-timers", () => ({
  handleAiriConversationExternalEvent: (...args: unknown[]) =>
    mockReplan(...args),
}));
jest.mock("./confirmed-payment-scenario", () => ({
  parseConfirmedPaymentScenarioSnapshot: (value: unknown) => value,
}));

import {
  handleConfirmedPaymentScenarioEvent,
  hydrateConfirmedPaymentTurn,
} from "./confirmed-payment-runtime";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const conversionId = "11111111-1111-4111-8111-111111111111";
const conversationId = "1234567890abcdef12345678";
const sourceId = "33333333-3333-4333-8333-333333333333";
const snapshot = {
  sourceId,
  scenarioId: "abcdefabcdefabcdefabcdef",
  scenarioUpdatedAt: "2026-09-11T10:00:00.000Z",
  pendingConditionNodeId: "payment",
  pendingSourceActionNodeId: "invoice",
  pendingStartedAt: "2026-09-11T11:00:00.000Z",
  pendingLastOutboundMessageId: "1234567890abcdef12345679",
  occurredAt: "2026-09-11T12:00:00.000Z",
};
const event = {
  kind: "payment_confirmed" as const,
  workspaceId,
  conversionId,
  conversationId,
  sourceId,
  channel: "whatsapp" as const,
  messageId: `confirmed-payment:${conversionId}`,
  messageDate: snapshot.occurredAt,
};
let row: Record<string, unknown>;
let dbError: boolean;
let updates: Record<string, unknown>[];
function query() {
  let update: Record<string, unknown> | undefined;
  const filters: Array<(item: Record<string, unknown>) => boolean> = [];
  const result = () => {
    if (dbError) return { data: null, error: { message: "unavailable" } };
    const matches = filters.every(filter => filter(row));
    if (matches && update) {
      Object.assign(row, update);
      updates.push(update);
    }
    return { data: matches ? { ...row } : null, error: null };
  };
  const chain = {
    select: () => chain,
    eq: (key: string, value: unknown) => {
      filters.push(item => item[key] === value);
      return chain;
    },
    in: (key: string, values: unknown[]) => {
      filters.push(item => values.includes(item[key]));
      return chain;
    },
    update: (value: Record<string, unknown>) => {
      update = value;
      return chain;
    },
    maybeSingle: async () => result(),
    then: (
      resolve: (value: unknown) => unknown,
      reject: (reason: unknown) => unknown
    ) => Promise.resolve(result()).then(resolve, reject),
  };
  return chain;
}
beforeEach(() => {
  jest.clearAllMocks();
  dbError = false;
  updates = [];
  row = {
    id: conversionId,
    workspace_id: workspaceId,
    conversation_id: conversationId,
    conversion_type: "sale",
    conversion_value: 1000,
    scenario_effect_status: "queued",
    scenario_effect_snapshot: snapshot,
  };
  mockFrom.mockImplementation(query);
  mockConversation.mockResolvedValue({
    _id: conversationId,
    workspaceId,
    sourceId,
    channel: "whatsapp",
  });
  mockChannel.mockResolvedValue({
    ok: true,
    whatsAppInfo: { contactData: { wa_id: "77001234567" } },
  });
  mockReplan.mockResolvedValue({
    handled: true,
    clearTimer: false,
    timer: { scenarioId: "current-wait" },
  });
});

it("returns a stable direct turn without prematurely checking the changed wait on a retry", async () => {
  const result = await handleConfirmedPaymentScenarioEvent(event);
  expect(result.paymentDisposition).toBe("ready");
  expect(result.paymentTurn).toMatchObject({
    messageId: event.messageId,
    triggerEventKind: "payment_detected",
    scenarioOverrideId: snapshot.scenarioId,
  });
  expect(mockConversation).not.toHaveBeenCalled();
  expect(updates).toEqual([]);
});

it("hydrates only authoritative ledger facts and never caller-supplied text or snapshots", async () => {
  const params = await hydrateConfirmedPaymentTurn({
    ...event,
    textPreview: "I paid",
    autoReplyPayload: { confirmedPaymentScenario: { scenarioId: "forged" } },
  });
  expect(params.confirmedPaymentScenario).toEqual(snapshot);
  expect(params.newMessage.text).toBe("");
  expect(params.suppressGeneralAutoReply).toBe(true);
  expect(mockConversation).toHaveBeenCalledWith({
    _id: conversationId,
    workspaceId,
    sourceId,
    channel: "whatsapp",
  });
});

it.each(["refund", "lead"])(
  "rejects a %s as payment authority",
  async conversionType => {
    row.conversion_type = conversionType;
    await expect(hydrateConfirmedPaymentTurn(event)).rejects.toThrow();
    expect(mockConversation).not.toHaveBeenCalled();
  }
);

it("rejects mismatched conversion/conversation/source identities", async () => {
  await expect(
    hydrateConfirmedPaymentTurn({ ...event, sourceId: workspaceId })
  ).rejects.toThrow();
  await expect(
    hydrateConfirmedPaymentTurn({
      ...event,
      conversationId: "abcdefabcdefabcdefabcdef",
    })
  ).rejects.toThrow();
  await expect(
    handleConfirmedPaymentScenarioEvent({
      ...event,
      messageId: "confirmed-payment:other",
    })
  ).rejects.toThrow();
  expect(updates).toEqual([]);
});

it("acknowledges once and preserves the current timer instead of blindly clearing it", async () => {
  const result = await handleConfirmedPaymentScenarioEvent({
    ...event,
    phase: "complete",
    completionStatus: "processed",
  });
  expect(row.scenario_effect_status).toBe("processed");
  expect(result.timer).toEqual({ scenarioId: "current-wait" });
  expect(result.clearTimer).toBe(false);
  await handleConfirmedPaymentScenarioEvent({
    ...event,
    phase: "complete",
    completionStatus: "failed",
  });
  expect(row.scenario_effect_status).toBe("processed");
  expect(updates).toHaveLength(1);
});

it("terminal rows never produce another turn, even after workflow dedupe retention expires", async () => {
  row.scenario_effect_status = "processed";
  const result = await handleConfirmedPaymentScenarioEvent(event);
  expect(result.paymentTurn).toBeUndefined();
  expect(result.paymentDisposition).toBe("terminal");
});

it("keeps database failure retryable without fabricating success or clearing timers", async () => {
  dbError = true;
  await expect(handleConfirmedPaymentScenarioEvent(event)).rejects.toThrow(
    /lookup/
  );
  expect(mockReplan).not.toHaveBeenCalled();
});

it("distinguishes permanently reassigned conversations from transient reads", async () => {
  mockConversation.mockResolvedValueOnce(null);
  await expect(hydrateConfirmedPaymentTurn(event)).rejects.toMatchObject({
    code: "AIRI_CONFIRMED_PAYMENT_NOT_ELIGIBLE",
  });
  mockConversation.mockRejectedValueOnce(new Error("Mongo unavailable"));
  await expect(hydrateConfirmedPaymentTurn(event)).rejects.not.toHaveProperty(
    "code"
  );
});

it("finishes unavailable channel configuration instead of retrying indefinitely", async () => {
  mockChannel.mockResolvedValueOnce({ ok: false });
  await expect(hydrateConfirmedPaymentTurn(event)).rejects.toMatchObject({
    code: "AIRI_CONFIRMED_PAYMENT_NOT_ELIGIBLE",
  });
});

it("recovers an accepted event after a different outbox attempt exhausted dispatch retries", async () => {
  row.scenario_effect_status = "failed";
  row.scenario_effect_reason = "dispatch_retries_exhausted";
  expect(
    (await handleConfirmedPaymentScenarioEvent(event)).paymentDisposition
  ).toBe("ready");
  expect(row.scenario_effect_status).toBe("queued");
  expect(row.scenario_effect_reason).toBeNull();
});

it("never reopens an ambiguous runtime execution failure as a dispatch retry", async () => {
  row.scenario_effect_status = "failed";
  row.scenario_effect_reason = "payment_prepare_outcome_unknown";
  expect(
    (await handleConfirmedPaymentScenarioEvent(event)).paymentDisposition
  ).toBe("terminal");
  expect(updates).toEqual([]);
});
