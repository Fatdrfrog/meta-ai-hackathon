const mockFind = jest.fn();
const mockUpdate = jest.fn();
const mockBlock = jest.fn();
const mockSignal = jest.fn();
const mockTerminal = jest.fn();
const mockFindOne = jest.fn();
const mockComplete = jest.fn();
jest.mock("@/lib/airi/reply/runtime/auto-reply-scenario-state", () => ({
  completeLockedScenarioAndPersist: (...args: unknown[]) =>
    mockComplete(...args),
}));
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/models/conversation", () => ({ Conversation: {} }));
jest.mock("@/models/scenario-behavior-run", () => ({
  __esModule: true,
  default: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
    find: () => mockFind(),
    updateOne: (...args: unknown[]) => mockUpdate(...args),
  },
}));
jest.mock("./behavior-runs", () => ({
  behaviorRunBlockReason: (...args: unknown[]) => mockBlock(...args),
  terminalizeBehaviorRun: (...args: unknown[]) => mockTerminal(...args),
}));
jest.mock("@/lib/temporal/client", () => ({
  signalAiriConversationTurn: (...args: unknown[]) => mockSignal(...args),
}));
import {
  dispatchDueBehaviorRuns,
  revalidateBehaviorScenarioSession,
} from "./behavior-runtime";
const run = {
  _id: "a".repeat(24),
  workspaceId: "workspace",
  conversationId: "conversation",
  scenarioId: "scenario",
  sourceId: "source",
  dueAt: new Date("2026-09-12T00:00:00Z"),
};
beforeEach(() => {
  jest.clearAllMocks();
  mockFind.mockReturnValue({
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: async () => [run, { ...run, _id: "b".repeat(24) }],
  });
  mockUpdate.mockResolvedValue({ modifiedCount: 1 });
  mockBlock.mockResolvedValue(null);
  mockSignal.mockResolvedValue(undefined);
  mockFindOne.mockReturnValue({ lean: async () => run });
  mockComplete.mockResolvedValue({
    persisted: true,
    state: { lockedScenarioId: null, behaviorRunId: null },
  });
});

test("a converted journey releases only its own lock before timer preparation or a new event", async () => {
  const conversation = {
    _id: "conversation",
    workspaceId: "workspace",
    airi_scenario_state: {
      lockedScenarioId: "scenario",
      behaviorRunId: run._id,
    },
  };
  mockBlock.mockResolvedValue("converted");
  expect(await revalidateBehaviorScenarioSession(conversation as never)).toBe(
    "converted"
  );
  expect(mockComplete).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedBehaviorRunId: run._id,
      scenarioId: "scenario",
    })
  );
  expect(conversation.airi_scenario_state.behaviorRunId).toBeNull();
  mockComplete.mockClear();
  expect(
    await revalidateBehaviorScenarioSession(conversation as never)
  ).toBeNull();
  expect(mockComplete).not.toHaveBeenCalled();
});
test("failed signal acceptance rotates retry time and does not starve the next run", async () => {
  mockSignal.mockRejectedValueOnce(new Error("Temporal unavailable"));
  await expect(
    dispatchDueBehaviorRuns({ limit: 25, deadlineAtMs: Infinity })
  ).rejects.toThrow("1 runs");
  expect(mockSignal).toHaveBeenCalledTimes(2);
  expect(
    mockUpdate.mock.calls[0][1].$set.nextAttemptAt.getTime()
  ).toBeGreaterThan(Date.now());
  expect(mockSignal.mock.calls[0][0].messageId).toBe(
    `customer-behavior:${run._id}`
  );
  await dispatchDueBehaviorRuns({ limit: 25, deadlineAtMs: Infinity });
  expect(mockSignal.mock.calls[2][0].messageId).toBe(
    mockSignal.mock.calls[0][0].messageId
  );
});
test("concurrent admission claims and conversions cannot dispatch a journey", async () => {
  mockUpdate.mockResolvedValueOnce({ modifiedCount: 0 });
  mockBlock.mockResolvedValueOnce("converted");
  await dispatchDueBehaviorRuns({ limit: 25, deadlineAtMs: Infinity });
  expect(mockSignal).not.toHaveBeenCalled();
  expect(mockTerminal).toHaveBeenCalledWith(
    expect.objectContaining({ _id: "b".repeat(24) }),
    "converted"
  );
});
