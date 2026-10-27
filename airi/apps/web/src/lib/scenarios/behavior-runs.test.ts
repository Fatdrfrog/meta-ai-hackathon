import { Types } from "mongoose";
const mockScenarios = jest.fn();
const mockScenario = jest.fn();
const mockEvents = jest.fn();
const mockEvent = jest.fn();
const mockEventUpdate = jest.fn();
const mockConversation = jest.fn();
const mockRunUpdate = jest.fn();
const mockCancel = jest.fn();
const mockFacts = jest.fn();
jest.mock("@/models/scenario", () => ({
  Scenario: {
    find: (...a: unknown[]) => mockScenarios(...a),
    findOne: (...a: unknown[]) => mockScenario(...a),
  },
}));
jest.mock("@/models/customer-event", () => ({
  __esModule: true,
  default: {
    find: (...a: unknown[]) => mockEvents(...a),
    findOne: (...a: unknown[]) => mockEvent(...a),
    updateOne: (...a: unknown[]) => mockEventUpdate(...a),
  },
}));
jest.mock("@/models/scenario-behavior-run", () => ({
  __esModule: true,
  default: {
    updateOne: (...a: unknown[]) => mockRunUpdate(...a),
    updateMany: (...a: unknown[]) => mockCancel(...a),
  },
}));
jest.mock("@/models/conversation", () => ({
  Conversation: { findOne: (...a: unknown[]) => mockConversation(...a) },
}));
jest.mock("@/lib/customers/purchase-facts", () => ({
  loadCustomerPurchaseFacts: (...a: unknown[]) => mockFacts(...a),
}));
import {
  admitCustomerBehaviorEvents,
  behaviorRunBlockReason,
  type BehaviorRun,
} from "./behavior-runs";
const id = (last: string) => new Types.ObjectId(last.padStart(24, "0"));
const now = new Date("2026-09-12T10:00:00Z");
const revision = new Date("2026-09-01T10:00:00Z");
const run = (): BehaviorRun => ({
  _id: id("1"),
  workspaceId: "workspace",
  customerId: id("2"),
  conversationId: id("3"),
  sourceId: "source",
  scenarioId: id("4"),
  triggerNodeId: "entry",
  scenarioUpdatedAt: revision,
  eventId: id("5"),
  eventType: "purchase_completed",
  referenceId: "sale",
  occurredAt: new Date("2026-09-10T10:00:00Z"),
  dueAt: now,
  expiresAt: new Date("2026-09-19T10:00:00Z"),
  config: { preset: "second_purchase", delayMinutes: 2880 },
  status: "signaled",
  attempts: 1,
});
function query(data: unknown) {
  return {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    lean: jest.fn(async () => data),
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  mockEventUpdate.mockResolvedValue({ modifiedCount: 1 });
  mockConversation.mockReturnValue(query({ sourceId: "source" }));
  mockScenario.mockReturnValue(
    query({
      updatedAt: revision,
      nodes: [
        {
          id: "entry",
          data: {
            kind: "trigger",
            triggerConfig: { entryPointType: "customer_behavior" },
          },
        },
      ],
    })
  );
  mockEvent.mockReturnValue(query({ payload: { conversionId: "sale" } }));
  mockFacts.mockResolvedValue({
    purchaseCount: 1,
    lastPurchaseAt: "2026-09-10T10:00:00Z",
    netSpend: { KZT: 9000 },
    convertedSince: false,
  });
});
test("a sale recorded after preparation cancels without waiting for the customer projection", async () => {
  expect(await behaviorRunBlockReason(run(), now)).toBeNull();
  mockFacts.mockResolvedValueOnce({ purchaseCount: 2, convertedSince: true });
  expect(await behaviorRunBlockReason(run(), now)).toBe("converted");
  expect(mockFacts).toHaveBeenLastCalledWith(
    expect.objectContaining({
      workspaceId: "workspace",
      customerId: String(id("2")),
      excludeConversionId: "sale",
    })
  );
});
test("pauses, revisions, source changes, handoffs and expired runs stop entry", async () => {
  mockScenario.mockReturnValueOnce(query(null));
  expect(await behaviorRunBlockReason(run(), now)).toBe("scenario_changed");
  mockScenario.mockReturnValueOnce(query({ updatedAt: now, nodes: [] }));
  expect(await behaviorRunBlockReason(run(), now)).toBe("scenario_changed");
  mockConversation.mockReturnValueOnce(query(null));
  expect(await behaviorRunBlockReason(run(), now)).toBe(
    "source_or_customer_changed"
  );
  mockConversation.mockReturnValueOnce(query({ airi_handoff_active: true }));
  expect(await behaviorRunBlockReason(run(), now)).toBe(
    "manual_handoff_active"
  );
  expect(
    await behaviorRunBlockReason({ ...run(), expiresAt: revision }, now)
  ).toBe("journey_expired");
});
test("second-purchase and spending filters are re-evaluated at dispatch", async () => {
  mockFacts.mockResolvedValueOnce({ purchaseCount: 2, convertedSince: false });
  expect(await behaviorRunBlockReason(run(), now)).toBe("not_first_purchase");
  expect(
    await behaviorRunBlockReason(
      {
        ...run(),
        config: {
          ...run().config,
          purchaseSegment: { minNetSpend: 100, currency: "USD" },
        },
      },
      now
    )
  ).toBe("purchase_segment_changed");
});

test("entry expiry does not cut off an already-started multi-week journey", async () => {
  expect(
    await behaviorRunBlockReason(
      { ...run(), status: "contacted", expiresAt: revision },
      now
    )
  ).toBeNull();
});
test("closing a checkout or changing its due date invalidates its old run", async () => {
  mockEvent
    .mockReturnValueOnce(query({ payload: {} }))
    .mockReturnValueOnce(query({ _id: id("99") }));
  expect(
    await behaviorRunBlockReason(
      {
        ...run(),
        eventType: "checkout_started",
        config: { preset: "abandoned_checkout", delayMinutes: 60 },
      },
      now
    )
  ).toBe("event_superseded");
});
test("event retries use a permanent episode key and only cancel other purchase episodes", async () => {
  const event = {
    _id: id("5"),
    workspaceId: "workspace",
    customerId: id("2"),
    conversationId: id("3"),
    type: "conversion_recorded",
    occurredAt: new Date("2026-09-10T10:00:00Z"),
    payload: {
      conversionId: "sale",
      conversionType: "sale",
      conversionValue: 9000,
      currency: "KZT",
    },
  };
  mockEvents.mockReturnValue(query([event]));
  mockScenarios.mockReturnValue(
    query([
      {
        _id: id("4"),
        updatedAt: revision,
        createdAt: revision,
        nodes: [
          {
            id: "entry",
            data: {
              kind: "trigger",
              triggerConfig: {
                entryPointType: "customer_behavior",
                behavior: run().config,
              },
            },
          },
        ],
      },
    ])
  );
  await admitCustomerBehaviorEvents({ limit: 10, deadlineAtMs: Infinity });
  await admitCustomerBehaviorEvents({ limit: 10, deadlineAtMs: Infinity });
  expect(mockRunUpdate).toHaveBeenCalledTimes(2);
  expect(mockRunUpdate.mock.calls[0][0]).toEqual(
    mockRunUpdate.mock.calls[1][0]
  );
  expect(mockRunUpdate.mock.calls[0][1].$setOnInsert.dueAt).toEqual(now);
  expect(mockCancel).toHaveBeenCalledWith(
    expect.objectContaining({
      eventId: { $ne: event._id },
      customerId: event.customerId,
    }),
    expect.anything()
  );
});
test("AI suggestions and refunds never become purchase entry events", async () => {
  mockEvents.mockReturnValue(
    query([
      {
        _id: id("5"),
        workspaceId: "workspace",
        type: "conversion_recorded",
        occurredAt: now,
        payload: {
          conversionType: "refund",
          conversionValue: 100,
          currency: "KZT",
        },
      },
    ])
  );
  await admitCustomerBehaviorEvents({ limit: 10, deadlineAtMs: Infinity });
  expect(mockRunUpdate).not.toHaveBeenCalled();
  expect(mockCancel).not.toHaveBeenCalled();
});
