import {
  buildAiriReplyOperatorAnalytics,
  type AiriReplyOperatorEventRow,
} from "@/lib/airi/reply/runtime/llm-analytics";

describe("buildAiriReplyOperatorAnalytics", () => {
  it("aggregates totals, rates, trends, and breakdowns from operator events", () => {
    const rows: AiriReplyOperatorEventRow[] = [
      {
        timestamp: "2026-03-30T10:00:00.000Z",
        counterName: "safe_conversational_replies",
        channel: "whatsapp",
        turnKind: "greeting",
        confidence: "high",
      },
      {
        timestamp: "2026-03-30T10:01:00.000Z",
        counterName: "low_confidence_understanding_results",
        channel: "whatsapp",
        turnKind: "unknown",
        confidence: "low",
      },
      {
        timestamp: "2026-03-30T10:02:00.000Z",
        counterName: "rag_turns",
        channel: "whatsapp",
        resultType: "ai_reply",
        fallbackAction: "grounded_recovery",
        fallbackReason: "incomplete_generated_reply",
      },
      {
        timestamp: "2026-03-30T10:02:05.000Z",
        counterName: "grounded_recovery_usage",
        channel: "whatsapp",
      },
      {
        timestamp: "2026-03-31T11:00:00.000Z",
        counterName: "rag_turns",
        channel: "telegram",
        resultType: "fallback",
        fallbackAction: "generic_clarification",
        fallbackReason: "generic_ungrounded_turn",
      },
      {
        timestamp: "2026-03-31T11:00:05.000Z",
        counterName: "generic_clarification_usage",
        channel: "telegram",
      },
    ];

    const analytics = buildAiriReplyOperatorAnalytics({
      rows,
      limited: true,
    });

    expect(analytics.totals).toEqual({
      safeConversationalReplies: 1,
      ragTurns: 2,
      groundedRecoveryUsage: 1,
      genericClarificationUsage: 1,
      lowConfidenceUnderstandingResults: 1,
    });

    expect(analytics.rates).toEqual({
      groundedRecoveryRate: 50,
      genericClarificationRate: 50,
      lowConfidenceRate: 50,
      safeReplyShare: 25,
    });

    expect(analytics.trends).toEqual([
      {
        date: "2026-03-30",
        safeConversationalReplies: 1,
        ragTurns: 1,
        groundedRecoveryUsage: 1,
        genericClarificationUsage: 0,
        lowConfidenceUnderstandingResults: 1,
      },
      {
        date: "2026-03-31",
        safeConversationalReplies: 0,
        ragTurns: 1,
        groundedRecoveryUsage: 0,
        genericClarificationUsage: 1,
        lowConfidenceUnderstandingResults: 0,
      },
    ]);

    expect(analytics.breakdowns.fallbackActions).toEqual([
      { name: "generic_clarification", count: 1 },
      { name: "grounded_recovery", count: 1 },
    ]);
    expect(analytics.breakdowns.fallbackReasons).toEqual([
      { name: "generic_ungrounded_turn", count: 1 },
      { name: "incomplete_generated_reply", count: 1 },
    ]);
    expect(analytics.breakdowns.resultTypes).toEqual([
      { name: "ai_reply", count: 1 },
      { name: "fallback", count: 1 },
    ]);
    expect(analytics.breakdowns.channels).toEqual([
      { name: "whatsapp", count: 4 },
      { name: "telegram", count: 2 },
    ]);
    expect(analytics.breakdowns.safeReplyKinds).toEqual([
      { name: "greeting", count: 1 },
    ]);
    expect(analytics.breakdowns.lowConfidenceKinds).toEqual([
      { name: "unknown", count: 1 },
    ]);

    expect(analytics.sampleInfo).toEqual({
      eventCount: 6,
      limited: true,
    });
  });
});
