import {
  buildDeterministicScoreEventsForRagTurn,
  buildCustomerFeedbackEvent,
  buildHumanEvaluationEvent,
  buildLlmTraceEvent,
  buildPubSubPublishPayloadForLlmProductAnalytics,
  buildRagTurnEventFromWideEvent,
  redactAndExcerptText,
  validateLlmAnalyticsEventBatch,
} from "@icecore/airi-runtime/llm-analytics";
import {
  buildWhatsAppLlmFeedbackPayload,
  parseWhatsAppLlmFeedbackPayload,
} from "@/lib/llm-analytics/whatsapp-feedback-payload";

describe("llm analytics event contracts", () => {
  it("stores redacted excerpts instead of full chat text", () => {
    const excerpt = redactAndExcerptText(
      "Contact me at customer@example.com or +1 (555) 123-4567. ".repeat(12),
      120
    );

    expect(excerpt).not.toBeNull();
    expect(excerpt).not.toContain("customer@example.com");
    expect(excerpt).not.toContain("+1 (555) 123-4567");
    expect(excerpt).toContain("[redacted-email]");
    expect(excerpt).toContain("[redacted-phone]");
    expect(excerpt!.length).toBeLessThanOrEqual(120);
  });

  it("builds stable LLM trace rows with hashes, usage, and excerpts", () => {
    const event = buildLlmTraceEvent({
      eventTs: "2026-04-22T10:00:00.000Z",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      traceId: "trace-1",
      operation: "airi.reply.generate",
      provider: "vertex",
      model: "gemini-3.5-flash",
      status: "ok",
      latencyMs: 321,
      inputText: "Please answer my billing question",
      outputText: "Here is the billing answer",
      usage: {
        prompt_tokens: 100,
        completion_tokens: 40,
        total_tokens: 140,
      },
    });

    const duplicate = buildLlmTraceEvent({
      eventTs: "2026-04-22T10:00:00.000Z",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      traceId: "trace-1",
      operation: "airi.reply.generate",
      provider: "vertex",
      model: "gemini-3.5-flash",
      status: "ok",
      latencyMs: 999,
      inputText: "Please answer my billing question",
      outputText: "Here is the billing answer",
    });

    expect(event.event_kind).toBe("llm_trace");
    expect(event.event_id).toBe(duplicate.event_id);
    expect(event.input_hash).toHaveLength(64);
    expect(event.output_hash).toHaveLength(64);
    expect(event.input_excerpt).toBe("Please answer my billing question");
    expect(event.output_excerpt).toBe("Here is the billing answer");
    expect(event.prompt_tokens).toBe(100);
    expect(event.completion_tokens).toBe(40);
    expect(event.total_tokens).toBe(140);
    expect(event.schema_version).toBe(2);
    expect(event.estimated_cost_usd).toBeCloseTo(0.00051, 5);
    expect(event.pricing_version).toBe("2026-10-meta-muse-spark");
  });

  it("maps RAG wide events into RAG turn and deterministic score events", () => {
    const ragTurn = buildRagTurnEventFromWideEvent({
      eventTs: "2026-04-22T10:01:00.000Z",
      answerMessageId: "outbound-1",
      inputText: "Where is my order?",
      outputText: "Your order is ready.",
      wideEvent: {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        channel: "telegram",
        resultType: "ai_reply",
        outcome: "ok",
        durationMs: 1_200,
        productMode: "answer",
        pipelinePath: "kb_snippet_ai_reply",
        retrievalPath: "kb",
        generationModel: "gemini-3.5-flash",
        generationInferenceMs: 900,
        fallbackAction: "grounded_recovery",
        fallbackReason: "missing_context",
        retrieval: {
          selectedSourceIds: ["kb-1", "kb-2"],
          coverage: {
            asksDetected: ["order status"],
            asksAnswered: ["order status"],
            missingAsks: [],
          },
        },
      },
    });

    const scores = buildDeterministicScoreEventsForRagTurn(ragTurn);

    expect(ragTurn.source_ids).toEqual(["kb-1", "kb-2"]);
    expect(ragTurn.retrieval_context_count).toBe(2);
    expect(ragTurn.fallback_action).toBe("grounded_recovery");
    expect(scores.map(score => score.score_name).sort()).toEqual([
      "answer_completeness",
      "citation_coverage",
      "latency_within_target",
      "rag_answer_without_context",
      "rag_context_present",
      "rag_fallback_without_context",
    ]);
    expect(scores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          score_name: "answer_completeness",
          data_type: "numeric",
          numeric_value: 1,
        }),
        expect.objectContaining({
          score_name: "citation_coverage",
          data_type: "numeric",
          numeric_value: 0,
        }),
        expect.objectContaining({
          score_name: "rag_answer_without_context",
          data_type: "boolean",
          boolean_value: false,
        }),
      ])
    );
  });

  it("flags generated RAG answers emitted without supporting context", () => {
    const ragTurn = buildRagTurnEventFromWideEvent({
      eventTs: "2026-04-22T10:02:00.000Z",
      answerMessageId: "outbound-unsupported",
      inputText: "What is the refund window?",
      outputText: "The refund window is 30 days.",
      wideEvent: {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        channel: "telegram",
        resultType: "ai_reply",
        outcome: "ok",
        retrievalPath: "none",
      },
    });

    const scores = buildDeterministicScoreEventsForRagTurn(ragTurn);

    expect(scores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          score_name: "rag_context_present",
          boolean_value: false,
        }),
        expect.objectContaining({
          score_name: "rag_answer_without_context",
          boolean_value: true,
        }),
        expect.objectContaining({
          score_name: "citation_coverage",
          numeric_value: null,
        }),
      ])
    );
  });

  it("validates batches and publishes them as product facts", () => {
    const trace = buildLlmTraceEvent({
      eventTs: "2026-04-22T10:00:00.000Z",
      workspaceId: "workspace-1",
      operation: "airi.reply.generate",
      provider: "vertex",
      model: "gemini-3.5-flash",
      status: "ok",
    });
    const ragTurn = buildRagTurnEventFromWideEvent({
      eventTs: "2026-04-22T10:01:00.000Z",
      wideEvent: {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        resultType: "fallback",
        outcome: "ok",
      },
    });

    const batch = validateLlmAnalyticsEventBatch({ events: [trace, ragTurn] });
    const payload = buildPubSubPublishPayloadForLlmProductAnalytics(
      batch.events,
      "product-topic"
    );

    expect(payload).toEqual({
      topic: "product-topic",
      messages: [
        expect.objectContaining({ data: expect.any(String) }),
        expect.objectContaining({ data: expect.any(String) }),
      ],
    });
  });

  it("builds customer feedback and human evaluation events", () => {
    const feedback = buildCustomerFeedbackEvent({
      eventTs: "2026-04-22T10:02:00.000Z",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      channel: "whatsapp",
      feedbackStage: "reason",
      feedbackValue: "incorrect",
      helpful: false,
      reasonCode: "incorrect",
      sourceMessageId: "wamid.answer",
      feedbackPromptMessageId: "wamid.prompt",
      customerMessageId: "wamid.customer-click",
      inputText: "Do you deliver to Astana?",
      outputText: "Yes, we deliver to Astana.",
    });

    expect(feedback.event_kind).toBe("customer_feedback");
    expect(feedback.helpful).toBe(false);
    expect(feedback.reason_code).toBe("incorrect");
    expect(feedback.input_hash).toEqual(expect.any(String));
    expect(feedback.output_hash).toEqual(expect.any(String));

    const evaluation = buildHumanEvaluationEvent({
      eventTs: "2026-04-22T10:03:00.000Z",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      evaluatorUserId: "user-1",
      evaluationStatus: "accepted_for_golden",
      datasetDecision: "add_to_golden",
      datasetSplit: "validation",
      relevanceScore: 0.9,
      trustworthinessScore: 0.2,
      concisenessScore: 0.8,
      completenessScore: 0.7,
      safetyScore: 1,
      overallScore: 0.55,
      judgeExplanation:
        "Useful failure: answer claimed delivery without source support.",
      expectedBehavior: "Answer only if delivery zone is supported by KB.",
      expectedSourceIds: ["kb-delivery-zones"],
      linkedFeedbackEventId: feedback.event_id,
    });

    expect(evaluation.event_kind).toBe("human_evaluation");
    expect(evaluation.dataset_decision).toBe("add_to_golden");
    expect(evaluation.trustworthiness_score).toBe(0.2);
    expect(evaluation.expected_source_ids).toEqual(["kb-delivery-zones"]);
  });

  it("round-trips WhatsApp LLM feedback payloads", () => {
    const helpful = buildWhatsAppLlmFeedbackPayload({
      kind: "helpfulness",
      helpful: true,
      sourceMessageId: "wamid.answer",
    });
    const reason = buildWhatsAppLlmFeedbackPayload({
      kind: "reason",
      reasonCode: "did_not_answer",
      sourceMessageId: "wamid.answer",
    });

    expect(parseWhatsAppLlmFeedbackPayload(helpful)).toEqual({
      kind: "helpfulness",
      helpful: true,
      sourceMessageId: "wamid.answer",
    });
    expect(parseWhatsAppLlmFeedbackPayload(reason)).toEqual({
      kind: "reason",
      reasonCode: "did_not_answer",
      sourceMessageId: "wamid.answer",
    });
  });
});
