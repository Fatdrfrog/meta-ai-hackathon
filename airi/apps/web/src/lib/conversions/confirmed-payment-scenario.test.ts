const mockFindOne = jest.fn();
const mockFrom = jest.fn();
const mockSignal = jest.fn();
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/models/scenario", () => ({
  Scenario: { findOne: (...args: unknown[]) => mockFindOne(...args) },
}));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: (...args: unknown[]) => mockFrom(...args) },
}));
jest.mock("@/lib/temporal/client", () => ({
  signalWithStartAiriConversationExternalEvent: (...args: unknown[]) =>
    mockSignal(...args),
}));

import {
  buildScenarioActionOutcomeHandleId,
  buildWhatsAppSessionChoiceSourceHandleId,
  getScenarioActionBranchDelayVirtualNodeId,
  getScenarioActionOutcomeVirtualNodeId,
} from "@icecore/scenario-contracts";
import {
  dispatchConfirmedPaymentScenario,
  parseConfirmedPaymentScenarioSnapshot,
  prepareConfirmedPaymentScenarioIntent,
  reconcilePendingConfirmedPayments,
  recordConfirmedPaymentScenarioFailure,
} from "./confirmed-payment-scenario";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const conversionId = "33333333-3333-4333-8333-333333333333";
const conversationId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const scenarioId = "bbbbbbbbbbbbbbbbbbbbbbbb";
const outboundId = "cccccccccccccccccccccccc";
const snapshot = {
  sourceId,
  scenarioId,
  scenarioUpdatedAt: "2026-09-09T09:00:00.000Z",
  pendingConditionNodeId:
    getScenarioActionOutcomeVirtualNodeId("request-payment"),
  pendingSourceActionNodeId: "request-payment",
  pendingStartedAt: "2026-09-09T10:00:00.000Z",
  pendingLastOutboundMessageId: outboundId,
  occurredAt: "2026-09-09T11:00:00.000Z",
};
const conversation = () => ({
  _id: conversationId,
  workspaceId,
  sourceId,
  channel: "whatsapp",
  airi_scenario_state: {
    lockedScenarioId: scenarioId,
    pendingConditionNodeId: snapshot.pendingConditionNodeId,
    pendingSourceActionNodeId: snapshot.pendingSourceActionNodeId,
    pendingStartedAt: new Date(snapshot.pendingStartedAt),
    pendingScenarioUpdatedAt: new Date(snapshot.scenarioUpdatedAt),
    pendingLastOutboundMessageId: outboundId,
  },
});
const scenario = () => ({
  _id: scenarioId,
  updatedAt: new Date(snapshot.scenarioUpdatedAt),
  nodes: [
    {
      id: "request-payment",
      data: {
        kind: "action",
        actionType: "reply",
        actionOutcomes: { version: 1, paymentDetected: { enabled: true } },
      },
    },
    { id: "thank-you", data: { kind: "action", actionType: "reply" } },
  ],
  edges: [
    {
      source: "request-payment",
      sourceHandle: buildScenarioActionOutcomeHandleId("payment_detected"),
      target: "thank-you",
    },
  ],
});
const prepare = (overrides: Record<string, unknown> = {}) =>
  prepareConfirmedPaymentScenarioIntent({
    conversation: conversation(),
    conversionType: "sale",
    value: 100,
    occurredAt: snapshot.occurredAt,
    ...overrides,
  });

type Row = Record<string, unknown>;
let row: Row;
let failUpdate: boolean;
function query() {
  let update: Row | undefined;
  const filters: Array<(item: Row) => boolean> = [];
  const result = () => {
    const matches = filters.every(filter => filter(row));
    if (matches && update) {
      if (failUpdate) return { data: null, error: { message: "unavailable" } };
      Object.assign(row, update);
    }
    return { data: matches ? [{ ...row }] : [], error: null };
  };
  const chain: Record<
    string,
    | jest.Mock
    | ((
        resolve: (value: unknown) => unknown,
        reject: (reason: unknown) => unknown
      ) => Promise<unknown>)
  > = {
    select: jest.fn(() => chain),
    update: jest.fn((value: Row) => {
      update = value;
      return chain;
    }),
    eq: jest.fn((key: string, value: unknown) => {
      filters.push(item => item[key] === value);
      return chain;
    }),
    in: jest.fn((key: string, values: unknown[]) => {
      filters.push(item => values.includes(item[key]));
      return chain;
    }),
    order: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    maybeSingle: jest.fn(async () => {
      const value = result();
      return { ...value, data: value.data?.[0] ?? null };
    }),
    then: (
      resolve: (value: unknown) => unknown,
      reject: (reason: unknown) => unknown
    ) => Promise.resolve(result()).then(resolve, reject),
  };
  return chain;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFindOne.mockReturnValue({
    select: () => ({ lean: async () => scenario() }),
  });
  mockSignal.mockResolvedValue({});
  failUpdate = false;
  row = {
    id: conversionId,
    workspace_id: workspaceId,
    conversation_id: conversationId,
    conversion_type: "sale",
    conversion_value: 100,
    scenario_effect_status: "queued",
    scenario_effect_snapshot: snapshot,
  };
  mockFrom.mockImplementation(query);
});

describe("confirmed payment scenario intent", () => {
  it("freezes the compiled action-owned payment outcome and tenant-scoped revision", async () => {
    expect(await prepare()).toEqual({
      scenario_effect_status: "pending",
      scenario_effect_snapshot: snapshot,
      scenario_effect_reason: null,
    });
    expect(mockFindOne).toHaveBeenCalledWith({
      _id: scenarioId,
      workspaceId,
      status: "active",
      deletedAt: null,
    });
  });
  it.each([
    { conversionType: "refund" },
    { value: 0 },
    { value: null },
    { value: -1 },
    { value: NaN },
    { conversation: { ...conversation(), channel: "web" } },
    { conversation: { ...conversation(), sourceId: null } },
    { conversation: { ...conversation(), airi_scenario_state: {} } },
  ])("does not enqueue ineligible facts %j", async overrides => {
    expect((await prepare(overrides)).scenario_effect_status).toBe(
      "not_applicable"
    );
    expect(mockFindOne).not.toHaveBeenCalled();
  });
  it.each([
    { occurredAt: "2026-09-09T09:59:59Z" },
    { paymentEvidenceOccurredAt: "2026-09-09T09:59:59Z" },
    { paymentEvidenceOccurredAt: "invalid" },
  ])("rejects evidence predating the current wait %j", async overrides => {
    expect((await prepare(overrides)).scenario_effect_status).toBe(
      "not_applicable"
    );
    expect(mockFindOne).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { ...scenario(), edges: [], updatedAt: new Date("2026-09-09T09:01:00Z") },
    { ...scenario(), updatedAt: null },
  ])(
    "does not freeze missing or disconnected scenario outcomes",
    async loaded => {
      mockFindOne.mockReturnValue({
        select: () => ({ lean: async () => loaded }),
      });
      expect((await prepare()).scenario_effect_status).toBe("not_applicable");
    }
  );
  it("leaves a delayed CTA follow-up waiting: a sale cannot claim that wait", async () => {
    const helpHandle = buildWhatsAppSessionChoiceSourceHandleId(
      "wsc:request-payment:help"
    );
    const base = scenario();
    mockFindOne.mockReturnValue({
      select: () => ({
        lean: async () => ({
          ...base,
          nodes: [
            {
              id: "request-payment",
              data: {
                kind: "action",
                actionType: "reply",
                actionWhatsAppServiceMessage: {
                  version: 1,
                  message: {
                    kind: "reply_buttons",
                    body: { mode: "fixed", text: "Pay now or ask us" },
                    options: [
                      { id: "wsc:request-payment:help", label: "Help" },
                    ],
                  },
                },
                actionOutcomes: {
                  version: 1,
                  paymentDetected: { enabled: true },
                  branchDelays: [
                    { sourceHandle: helpHandle, delayMinutes: 30 },
                  ],
                },
              },
            },
            ...base.nodes.slice(1),
            { id: "help", data: { kind: "action", actionType: "reply" } },
          ],
          edges: [
            ...base.edges,
            {
              source: "request-payment",
              sourceHandle: helpHandle,
              target: "help",
            },
          ],
        }),
      }),
    });
    const pending = conversation();
    pending.airi_scenario_state.pendingConditionNodeId =
      getScenarioActionBranchDelayVirtualNodeId("request-payment", helpHandle);

    expect(await prepare({ conversation: pending })).toEqual({
      scenario_effect_status: "not_applicable",
      scenario_effect_snapshot: null,
      scenario_effect_reason: "payment_outcome_unavailable",
    });
    // The action's own outcome wait still accepts the sale.
    expect((await prepare()).scenario_effect_status).toBe("pending");
  });
  it("rejects an unrelated source action for the pending condition", async () => {
    const pending = conversation();
    pending.airi_scenario_state.pendingSourceActionNodeId = "thank-you";
    expect(
      (await prepare({ conversation: pending })).scenario_effect_status
    ).toBe("not_applicable");
  });
  it("rejects an edited scenario even when its payment branch remains connected", async () => {
    mockFindOne.mockReturnValue({
      select: () => ({
        lean: async () => ({
          ...scenario(),
          updatedAt: new Date("2026-09-09T10:30:00Z"),
        }),
      }),
    });
    expect(await prepare()).toMatchObject({
      scenario_effect_status: "not_applicable",
      scenario_effect_reason: "scenario_revision_changed",
      scenario_effect_snapshot: null,
    });
  });
  it("does not authorize a legacy wait whose original revision is unknown", async () => {
    const pending = conversation();
    Reflect.deleteProperty(
      pending.airi_scenario_state,
      "pendingScenarioUpdatedAt"
    );
    expect(
      (await prepare({ conversation: pending })).scenario_effect_status
    ).toBe("not_applicable");
    expect(mockFindOne).not.toHaveBeenCalled();
  });
  it("propagates a database failure so a sale cannot silently lose an eligible intent", async () => {
    mockFindOne.mockReturnValue({
      select: () => ({
        lean: async () => {
          throw new Error("unavailable");
        },
      }),
    });
    await expect(prepare()).rejects.toThrow("unavailable");
  });
  it.each([
    null,
    {},
    { ...snapshot, sourceId: "invalid" },
    { ...snapshot, pendingLastOutboundMessageId: "" },
    { ...snapshot, occurredAt: "2026-09-08T11:00:00Z" },
  ])("rejects malformed frozen snapshots %j", value => {
    expect(parseConfirmedPaymentScenarioSnapshot(value)).toBeNull();
  });
});

describe("confirmed payment scenario delivery", () => {
  it("sends a stable control event without making SQL processed before runtime applies it", async () => {
    expect(
      await dispatchConfirmedPaymentScenario({ workspaceId, conversionId })
    ).toEqual({ status: "queued" });
    expect(mockSignal).toHaveBeenCalledWith({
      kind: "payment_confirmed",
      conversionId,
      messageId: `confirmed-payment:${conversionId}`,
      workspaceId,
      conversationId,
      sourceId,
      channel: "whatsapp",
      messageDate: snapshot.occurredAt,
    });
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });
  it("retries an uncertain internal signal with the same identity", async () => {
    mockSignal.mockRejectedValueOnce(new Error("timeout"));
    await expect(
      dispatchConfirmedPaymentScenario({ workspaceId, conversionId })
    ).rejects.toThrow("timeout");
    await dispatchConfirmedPaymentScenario({ workspaceId, conversionId });
    expect(mockSignal).toHaveBeenCalledTimes(2);
    expect(mockSignal.mock.calls[0]).toEqual(mockSignal.mock.calls[1]);
  });
  it.each(["processed", "skipped", "failed", "not_applicable"])(
    "does not redeliver terminal %s rows",
    async status => {
      row.scenario_effect_status = status;
      expect(
        await dispatchConfirmedPaymentScenario({ workspaceId, conversionId })
      ).toEqual({ status });
      expect(mockSignal).not.toHaveBeenCalled();
    }
  );
  it("cannot read another tenant's conversion", async () => {
    expect(
      await dispatchConfirmedPaymentScenario({
        workspaceId: "44444444-4444-4444-8444-444444444444",
        conversionId,
      })
    ).toEqual({ status: "not_applicable" });
    expect(mockSignal).not.toHaveBeenCalled();
  });
  it("marks an invalid frozen snapshot skipped", async () => {
    row.scenario_effect_snapshot = null;
    expect(
      await dispatchConfirmedPaymentScenario({ workspaceId, conversionId })
    ).toEqual({ status: "skipped" });
    expect(row.scenario_effect_reason).toBe("invalid_snapshot");
    expect(mockSignal).not.toHaveBeenCalled();
  });
  it("does not overwrite runtime acknowledgement while the signal returns", async () => {
    row.scenario_effect_status = "pending";
    mockSignal.mockImplementation(async () => {
      row.scenario_effect_status = "processed";
    });
    expect(
      await dispatchConfirmedPaymentScenario({ workspaceId, conversionId })
    ).toEqual({ status: "queued" });
    expect(row.scenario_effect_status).toBe("processed");
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });
  it("does no fallible ledger bookkeeping after Temporal accepts the signal", async () => {
    mockSignal.mockImplementation(async () => {
      failUpdate = true;
    });
    expect(
      await dispatchConfirmedPaymentScenario({ workspaceId, conversionId })
    ).toEqual({ status: "queued" });
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });
  it("reconciles by enqueueing before marking the SQL intent queued", async () => {
    row.scenario_effect_status = "pending";
    const enqueue = jest.fn(async () => {
      expect(row.scenario_effect_status).toBe("pending");
    });
    expect(await reconcilePendingConfirmedPayments({ enqueue })).toBe(1);
    expect(enqueue).toHaveBeenCalledWith({ workspaceId, conversionId });
    expect(row.scenario_effect_status).toBe("queued");
  });
  it("keeps a failed enqueue pending for the existing drain", async () => {
    row.scenario_effect_status = "pending";
    await expect(
      reconcilePendingConfirmedPayments({
        enqueue: async () => {
          throw new Error("mongo unavailable");
        },
      })
    ).rejects.toThrow("mongo unavailable");
    expect(row.scenario_effect_status).toBe("pending");
  });
  it("repeats enqueue safely when SQL acknowledgement failed", async () => {
    row.scenario_effect_status = "pending";
    failUpdate = true;
    const enqueue = jest.fn(async () => undefined);
    await expect(
      reconcilePendingConfirmedPayments({ enqueue })
    ).rejects.toThrow();
    failUpdate = false;
    await reconcilePendingConfirmedPayments({ enqueue });
    expect(enqueue.mock.calls[0]).toEqual(enqueue.mock.calls[1]);
  });
  it("honors the drain deadline before touching the ledger", async () => {
    expect(
      await reconcilePendingConfirmedPayments({
        enqueue: jest.fn(),
        deadlineAtMs: Date.now() - 1,
      })
    ).toBe(0);
    expect(mockFrom).not.toHaveBeenCalled();
  });
  it("records final dispatch failure but preserves runtime acknowledgement", async () => {
    await recordConfirmedPaymentScenarioFailure({
      workspaceId,
      conversionId,
      reason: "dispatch_failed",
    });
    expect(row.scenario_effect_status).toBe("failed");
    row.scenario_effect_status = "processed";
    await recordConfirmedPaymentScenarioFailure({
      workspaceId,
      conversionId,
      reason: "dispatch_failed",
    });
    expect(row.scenario_effect_status).toBe("processed");
  });
});
