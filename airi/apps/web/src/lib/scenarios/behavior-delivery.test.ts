const mockRun = jest.fn();
const mockUpdate = jest.fn();
const mockBlock = jest.fn();
const mockTerminal = jest.fn();
const mockReserve = jest.fn();
jest.mock("@/models/scenario-behavior-run", () => ({
  __esModule: true,
  default: {
    findOne: (...args: unknown[]) => mockRun(...args),
    updateOne: (...args: unknown[]) => mockUpdate(...args),
  },
}));
jest.mock("./behavior-runs", () => ({
  behaviorRunBlockReason: (...args: unknown[]) => mockBlock(...args),
  terminalizeBehaviorRun: (...args: unknown[]) => mockTerminal(...args),
}));
jest.mock("@/lib/campaign/customer-contact-policy", () => ({
  reserveCustomerMarketingContact: (...args: unknown[]) => mockReserve(...args),
}));
import {
  findOutboundBehaviorRun,
  guardBehaviorDelivery,
  markBehaviorContactAttempted,
} from "./behavior-delivery";
const run = {
  _id: "a".repeat(24),
  workspaceId: "workspace",
  conversationId: "b".repeat(24),
  scenarioId: "scenario",
} as never;
beforeEach(() => {
  jest.clearAllMocks();
  mockBlock.mockResolvedValue(null);
  mockReserve.mockResolvedValue(null);
  mockRun.mockReturnValue({ lean: async () => run });
});
test("timed reminders use the exact persisted episode, never the latest run for a scenario", async () => {
  const input = {
    workspaceId: "workspace",
    conversationId: "b".repeat(24),
    scenarioId: "scenario",
    sourceMessageId:
      "scenario-timeout:post_action_no_reply_timeout:scenario:2026-09-12T00:00:00Z",
  };
  expect(await findOutboundBehaviorRun(input)).toBeNull();
  expect(mockRun).not.toHaveBeenCalled();
  expect(
    await findOutboundBehaviorRun({ ...input, behaviorRunId: "a".repeat(24) })
  ).toBe(run);
  expect(mockRun).toHaveBeenCalledWith({
    _id: "a".repeat(24),
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    scenarioId: input.scenarioId,
  });
  mockRun.mockReturnValueOnce({ lean: async () => null });
  await expect(
    findOutboundBehaviorRun({ ...input, behaviorRunId: "c".repeat(24) })
  ).rejects.toThrow("authority missing");
});
test("a purchase during reservation prevents dispatch", async () => {
  mockBlock.mockResolvedValueOnce(null).mockResolvedValueOnce("converted");
  expect(await guardBehaviorDelivery(run, "77001234567", "delivery")).toBe(
    "converted"
  );
  expect(mockReserve).toHaveBeenCalledWith(
    expect.objectContaining({ requireConsent: true, deliveryKey: "delivery" })
  );
  expect(mockTerminal).toHaveBeenCalledWith(run, "converted");
});
test("consent and frequency rejection terminate the journey before provider work", async () => {
  mockReserve.mockResolvedValueOnce("marketing_consent_required");
  expect(await guardBehaviorDelivery(run, "77001234567", "delivery")).toBe(
    "marketing_consent_required"
  );
  expect(mockBlock).toHaveBeenCalledTimes(1);
});
test("cancellation winning the final run transition cannot send", async () => {
  mockUpdate.mockResolvedValue({ matchedCount: 0 });
  await expect(markBehaviorContactAttempted(run)).rejects.toThrow("cancelled");
});
