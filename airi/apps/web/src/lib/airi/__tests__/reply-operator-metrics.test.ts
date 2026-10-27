import {
  getReplyOperatorMetricsSnapshotForTest,
  resetReplyOperatorMetricsForTest,
  trackRagOutcomeMetrics,
  trackTurnUnderstandingMetrics,
} from "@/lib/airi/reply/runtime/reply-operator-metrics";

const capture = jest.fn();

jest.mock("@/lib/posthog/server", () => ({
  getPostHogClient: jest.fn(() => ({
    capture: (...args: unknown[]) => capture(...args),
  })),
}));

describe("reply operator metrics", () => {
  beforeEach(() => {
    capture.mockReset();
    resetReplyOperatorMetricsForTest();
  });

  it("tracks safe conversational replies and low-confidence understanding results", () => {
    trackTurnUnderstandingMetrics({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      channel: "whatsapp",
      turnKind: "greeting",
      confidence: "high",
      proceedWithRag: false,
      hasConversationWindow: true,
      safeReplySent: true,
    });
    trackTurnUnderstandingMetrics({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      channel: "whatsapp",
      turnKind: "unknown",
      confidence: "low",
      proceedWithRag: true,
      hasConversationWindow: true,
      safeReplySent: false,
    });

    expect(getReplyOperatorMetricsSnapshotForTest("workspace-1")).toEqual({
      safeConversationalReplies: 1,
      ragTurns: 0,
      groundedRecoveryUsage: 0,
      genericClarificationUsage: 0,
      lowConfidenceUnderstandingResults: 1,
      totalEvents: 2,
    });
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("tracks RAG turns, grounded recovery, and generic clarification outcomes for dashboards", () => {
    trackRagOutcomeMetrics({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      channel: "whatsapp",
      resultType: "ai_reply",
      fallbackAction: "grounded_recovery",
      fallbackReason: "incomplete_generated_reply",
    });
    trackRagOutcomeMetrics({
      workspaceId: "workspace-1",
      conversationId: "conversation-2",
      channel: "telegram",
      resultType: "fallback",
      fallbackAction: "generic_clarification",
      fallbackReason: "generic_ungrounded_turn",
    });

    expect(getReplyOperatorMetricsSnapshotForTest("workspace-1")).toEqual({
      safeConversationalReplies: 0,
      ragTurns: 2,
      groundedRecoveryUsage: 1,
      genericClarificationUsage: 1,
      lowConfidenceUnderstandingResults: 0,
      totalEvents: 4,
    });
    expect(capture).toHaveBeenCalledTimes(4);
  });
});
