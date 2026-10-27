const mockConversationUpdateOne = jest.fn();
const mockHasHumanOutboundSince = jest.fn();

jest.mock("@/models/conversation", () => ({
  Conversation: {
    updateOne: (...args: unknown[]) => mockConversationUpdateOne(...args),
  },
}));

jest.mock("@/lib/airi/reply/runtime/human-outbound", () => ({
  hasHumanOutboundSince: (...args: unknown[]) =>
    mockHasHumanOutboundSince(...args),
}));

import {
  activateManualHandoff,
  applyClearedHandoffStateToConversation,
  buildManualHandoffStateUpdate,
  canAutoResumeScenarioHandoff,
  maybeAutoResumeScenarioHandoff,
} from "@/lib/airi/reply/runtime/handoff-state";
import { ConversationLifecycleWriteConflictError } from "@/lib/analytics/service-lifecycle";

describe("handoff-state", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("recognizes resumable scenario handoffs", () => {
    expect(
      canAutoResumeScenarioHandoff({
        airi_handoff_active: true,
        airi_handoff_source: "scenario_contains",
        airi_handoff_started_at: "2026-03-25T11:10:47.396Z",
      })
    ).toBe(true);

    expect(
      canAutoResumeScenarioHandoff({
        airi_handoff_active: true,
        airi_handoff_source: "manual",
        airi_handoff_started_at: "2026-03-25T11:10:47.396Z",
      })
    ).toBe(false);
  });

  it("auto-resumes scenario handoff when no human replied yet", async () => {
    mockHasHumanOutboundSince.mockResolvedValue(false);
    mockConversationUpdateOne.mockResolvedValue({ acknowledged: true });

    const result = await maybeAutoResumeScenarioHandoff({
      conversationId: "conv-1",
      snapshot: {
        airi_handoff_active: true,
        airi_handoff_source: "scenario_contains",
        airi_handoff_started_at: "2026-03-25T11:10:47.396Z",
        airi_last_suppressed_reason: "scenario_handoff",
      },
      inboundAt: new Date("2026-03-25T11:27:55.000Z"),
      hasSubstantiveInbound: true,
    });

    expect(result).toEqual({
      resumed: true,
      blockedByHumanReply: false,
    });
    expect(mockHasHumanOutboundSince).toHaveBeenCalledWith({
      conversationId: "conv-1",
      since: new Date("2026-03-25T11:10:47.396Z"),
      until: new Date("2026-03-25T11:27:55.000Z"),
    });
    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      {
        _id: "conv-1",
        airi_handoff_active: true,
        airi_handoff_source: "scenario_contains",
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          airi_bot_enabled: true,
          airi_handoff_active: false,
          airi_handoff_source: null,
          airi_handoff_reason: null,
          status: "open",
          airi_last_suppressed_reason: null,
        }),
      })
    );
  });

  it("restores auto-reply to the pre-handoff value when auto-resuming", async () => {
    mockHasHumanOutboundSince.mockResolvedValue(false);
    mockConversationUpdateOne.mockResolvedValue({ acknowledged: true });

    await maybeAutoResumeScenarioHandoff({
      conversationId: "conv-1",
      snapshot: {
        airi_handoff_active: true,
        airi_handoff_source: "scenario_contains",
        airi_handoff_started_at: "2026-03-25T11:10:47.396Z",
        airi_handoff_restore_bot_enabled: false,
      },
      inboundAt: new Date("2026-03-25T11:27:55.000Z"),
      hasSubstantiveInbound: true,
    });

    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "conv-1" }),
      expect.objectContaining({
        $set: expect.objectContaining({
          airi_bot_enabled: false,
          airi_handoff_restore_bot_enabled: null,
        }),
      })
    );
  });

  it("keeps handoff locked when a human replied after handoff started", async () => {
    mockHasHumanOutboundSince.mockResolvedValue(true);

    const result = await maybeAutoResumeScenarioHandoff({
      conversationId: "conv-1",
      snapshot: {
        airi_handoff_active: true,
        airi_handoff_source: "scenario_timeout",
        airi_handoff_started_at: "2026-03-25T11:10:47.396Z",
      },
      inboundAt: new Date("2026-03-25T11:27:55.000Z"),
      hasSubstantiveInbound: true,
    });

    expect(result).toEqual({
      resumed: false,
      blockedByHumanReply: true,
    });
    expect(mockConversationUpdateOne).not.toHaveBeenCalled();
  });

  it("does not auto-resume manual handoff", async () => {
    const result = await maybeAutoResumeScenarioHandoff({
      conversationId: "conv-1",
      snapshot: {
        airi_handoff_active: true,
        airi_handoff_source: "manual",
        airi_handoff_started_at: "2026-03-25T11:10:47.396Z",
      },
      inboundAt: new Date("2026-03-25T11:27:55.000Z"),
      hasSubstantiveInbound: true,
    });

    expect(result).toEqual({
      resumed: false,
      blockedByHumanReply: false,
    });
    expect(mockHasHumanOutboundSince).not.toHaveBeenCalled();
    expect(mockConversationUpdateOne).not.toHaveBeenCalled();
  });

  it("does not resume when the scenario handoff changed before the write", async () => {
    mockHasHumanOutboundSince.mockResolvedValue(false);
    // A manager took over between the snapshot and the write: nothing matches.
    mockConversationUpdateOne.mockResolvedValue({ matchedCount: 0 });

    const result = await maybeAutoResumeScenarioHandoff({
      conversationId: "conv-1",
      snapshot: {
        airi_handoff_active: true,
        airi_handoff_source: "scenario_timeout",
        airi_handoff_started_at: "2026-03-25T11:10:47.396Z",
      },
      inboundAt: new Date("2026-03-25T11:27:55.000Z"),
      hasSubstantiveInbound: true,
    });

    expect(result).toEqual({ resumed: false, blockedByHumanReply: false });
  });

  it("retries a manual handoff that lost a concurrent lifecycle write", async () => {
    mockConversationUpdateOne
      .mockRejectedValueOnce(new ConversationLifecycleWriteConflictError())
      .mockResolvedValueOnce({ matchedCount: 1 });

    await activateManualHandoff({
      conversationId: "conv-1",
      handoffAt: "2026-04-02T05:08:51.000Z",
    });

    expect(mockConversationUpdateOne).toHaveBeenCalledTimes(2);
    expect(mockConversationUpdateOne).toHaveBeenLastCalledWith(
      { _id: "conv-1" },
      {
        $set: expect.objectContaining({
          airi_handoff_active: true,
          airi_bot_enabled: false,
          status: "in_progress",
        }),
      }
    );
  });

  it("gives up after three lifecycle conflicts and never retries other errors", async () => {
    mockConversationUpdateOne.mockRejectedValue(
      new ConversationLifecycleWriteConflictError()
    );
    await expect(
      activateManualHandoff({ conversationId: "conv-1" })
    ).rejects.toBeInstanceOf(ConversationLifecycleWriteConflictError);
    expect(mockConversationUpdateOne).toHaveBeenCalledTimes(3);

    mockConversationUpdateOne.mockReset();
    mockConversationUpdateOne.mockRejectedValue(new Error("network"));
    await expect(
      activateManualHandoff({ conversationId: "conv-1" })
    ).rejects.toThrow("network");
    expect(mockConversationUpdateOne).toHaveBeenCalledTimes(1);
  });

  it("applies the shared handoff-clear fields to a conversation document", () => {
    const values = new Map<string, unknown>([
      ["airi_last_suppressed_reason", "scenario_handoff"],
    ]);
    const conversation = {
      get: jest.fn((path: string) => values.get(path)),
      set: jest.fn((path: string, value: unknown) => {
        values.set(path, value);
      }),
    };

    applyClearedHandoffStateToConversation(conversation);

    expect(conversation.set).toHaveBeenCalledWith("airi_handoff_active", false);
    expect(conversation.set).toHaveBeenCalledWith(
      "airi_last_suppressed_reason",
      null
    );
    expect(conversation.set).toHaveBeenCalledWith("status", "open");
  });

  it("builds a manual handoff update that disables the bot", () => {
    const handoffAt = new Date("2026-04-02T05:08:51.000Z");

    expect(
      buildManualHandoffStateUpdate({
        handoffAt,
        handoffReason: "manager_reply",
      })
    ).toEqual(
      expect.objectContaining({
        airi_bot_enabled: false,
        airi_handoff_active: true,
        airi_handoff_started_at: handoffAt,
        airi_handoff_source: "manual",
        airi_handoff_reason: "manager_reply",
        status: "in_progress",
      })
    );
  });
});
