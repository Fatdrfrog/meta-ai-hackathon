const mockEnsure = jest.fn();
const mockRecord = jest.fn();
const mockConversation = jest.fn();
const mockSaved = jest.fn();
jest.mock("./service", () => ({
  ensureCustomerForConversation: (...a: unknown[]) => mockEnsure(...a),
  recordCustomerEvent: (...a: unknown[]) => mockRecord(...a),
}));
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/models/conversation", () => ({
  Conversation: { findOne: (...a: unknown[]) => mockConversation(...a) },
}));
jest.mock("@/models/customer-event", () => ({
  __esModule: true,
  default: { findOne: (...a: unknown[]) => mockSaved(...a) },
}));
import {
  customerBehaviorEventSchema,
  recordCustomerBehaviorEvent,
} from "./behavior-events";
import { createHash } from "node:crypto";
const event = {
  eventId: "event-1",
  eventType: "checkout_started",
  referenceId: "order-1",
  conversationId: "a".repeat(24),
  occurredAt: "2026-09-01T00:00:00Z",
};
test("manual behavior intake cannot forge a purchase and requires explicit due dates", () => {
  expect(customerBehaviorEventSchema.safeParse(event).success).toBe(true);
  expect(
    customerBehaviorEventSchema.safeParse({
      ...event,
      eventType: "purchase_completed",
    }).success
  ).toBe(false);
  expect(
    customerBehaviorEventSchema.safeParse({
      ...event,
      eventType: "renewal_scheduled",
    }).success
  ).toBe(false);
  expect(
    customerBehaviorEventSchema.safeParse({
      ...event,
      eventType: "renewal_scheduled",
      dueAt: "2026-10-01T00:00:00+05:00",
    }).success
  ).toBe(true);
  expect(
    customerBehaviorEventSchema.safeParse({ ...event, customerId: "forged" })
      .success
  ).toBe(false);
});
test("source and workspace ownership are checked before recording", async () => {
  mockConversation.mockReturnValue({
    select: () => ({ lean: async () => null }),
  });
  await expect(
    recordCustomerBehaviorEvent({
      workspaceId: "workspace",
      sourceId: "source",
      event,
    })
  ).rejects.toMatchObject({ status: 404 });
  expect(mockConversation).toHaveBeenCalledWith(
    expect.objectContaining({
      sourceId: "source",
      workspaceId: "workspace",
      _id: event.conversationId,
    })
  );
  expect(mockEnsure).not.toHaveBeenCalled();
});
test("changed payloads cannot reuse an event ID", async () => {
  mockConversation.mockReturnValue({
    select: () => ({ lean: async () => ({ sourceId: "source" }) }),
  });
  mockEnsure.mockResolvedValue({ _id: "b".repeat(24) });
  mockSaved.mockReturnValue({
    lean: async () => ({
      _id: "c".repeat(24),
      payload: { behavior: { hash: "different" } },
    }),
  });
  await expect(
    recordCustomerBehaviorEvent({ workspaceId: "workspace", event })
  ).rejects.toMatchObject({ status: 409 });
  expect(mockRecord).toHaveBeenCalledWith(
    expect.objectContaining({
      idempotencyKey: "behavior:source:event-1",
      type: "commerce_behavior",
    })
  );
});

test("concurrent duplicate keys reuse the winner only when its facts match", async () => {
  mockConversation.mockReturnValue({
    select: () => ({ lean: async () => ({ sourceId: "source" }) }),
  });
  mockEnsure.mockResolvedValue({ _id: "b".repeat(24) });
  mockRecord.mockRejectedValueOnce({ code: 11000 });
  const hash = createHash("sha256")
    .update(JSON.stringify(customerBehaviorEventSchema.parse(event)))
    .digest("hex");
  mockSaved.mockReturnValue({
    lean: async () => ({
      _id: "c".repeat(24),
      payload: { behavior: { hash } },
    }),
  });
  await expect(
    recordCustomerBehaviorEvent({ workspaceId: "workspace", event })
  ).resolves.toEqual({ success: true, eventId: "c".repeat(24) });
});
