const mockRead = jest.fn();
const mockWrite = jest.fn();
const mockRecord = jest.fn();
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          lte: () => ({
            order: () => ({ order: () => ({ limit: () => mockRead() }) }),
          }),
        }),
      }),
      update: (value: unknown) => ({
        eq: () => ({ eq: () => ({ eq: () => mockWrite(value) }) }),
      }),
    }),
  },
}));
jest.mock("@/lib/customers/service", () => ({
  recordCustomerConversionEvent: (...args: unknown[]) => mockRecord(...args),
}));
import { reconcileConversionCustomerEvents } from "./customer-event-reconciliation";
beforeEach(() => {
  jest.clearAllMocks();
  mockWrite.mockResolvedValue({ error: null });
});
test("a poisoned projection is deferred without starving the next conversion", async () => {
  mockRead.mockResolvedValue({
    data: ["bad", "good"].map(id => ({
      id,
      workspace_id: "workspace",
      conversation_id: "conversation",
      converted_at: "2026-09-12T00:00:00Z",
    })),
  });
  mockRecord
    .mockRejectedValueOnce(new Error("Mongo unavailable"))
    .mockResolvedValueOnce({ _id: "event" });
  await expect(
    reconcileConversionCustomerEvents({ limit: 25, deadlineAtMs: Infinity })
  ).rejects.toThrow("1 rows");
  expect(mockRecord).toHaveBeenCalledTimes(2);
  expect(mockRecord).toHaveBeenLastCalledWith(
    expect.objectContaining({
      expectedWorkspaceId: "workspace",
      conversionId: "good",
    })
  );
  expect(mockWrite).toHaveBeenCalledTimes(3);
  expect(mockWrite).toHaveBeenLastCalledWith({ customer_event_pending: false });
});
test("missing conversations retain durable intent and expired budgets perform no writes", async () => {
  mockRead.mockResolvedValue({
    data: [{ id: "orphan", converted_at: "2026-09-12T00:00:00Z" }],
  });
  mockRecord.mockResolvedValue(null);
  await expect(
    reconcileConversionCustomerEvents({ limit: 25, deadlineAtMs: Infinity })
  ).rejects.toThrow("1 rows");
  expect(mockWrite).not.toHaveBeenCalledWith({ customer_event_pending: false });
  mockWrite.mockClear();
  await reconcileConversionCustomerEvents({ limit: 25, deadlineAtMs: 0 });
  expect(mockWrite).not.toHaveBeenCalled();
});
