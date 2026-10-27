const mockSuggestionCreate = jest.fn();
const mockSuggestionFindOneAndUpdate = jest.fn();
const mockRealtimeTrigger = jest.fn();
const mockPersistAiriReplyTrace = jest.fn();
const mockMessageFindById = jest.fn();
const mockSendWhatsAppLlmHelpfulnessPrompt = jest.fn();
const mockUpsertWhatsAppLlmAnswerReviewItem = jest.fn();
const mockResolveWhatsAppSendContext = jest.fn();
const mockEnqueueWhatsAppLlmHelpfulnessPromptWithOutbox = jest.fn();

jest.mock("@/models/airi-suggestion", () => ({
  __esModule: true,
  default: {
    create: (...args: unknown[]) => mockSuggestionCreate(...args),
    findOneAndUpdate: (...args: unknown[]) =>
      mockSuggestionFindOneAndUpdate(...args),
  },
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    findById: (...args: unknown[]) => mockMessageFindById(...args),
  },
}));

jest.mock("@/lib/realtime/server", () => ({
  realtime: {
    trigger: (...args: unknown[]) => mockRealtimeTrigger(...args),
  },
}));

jest.mock("@/lib/airi/reply/runtime/reply-trace", () => ({
  persistAiriReplyTrace: (...args: unknown[]) =>
    mockPersistAiriReplyTrace(...args),
}));

jest.mock("@/lib/llm-analytics/whatsapp-feedback", () => ({
  sendWhatsAppLlmHelpfulnessPrompt: (...args: unknown[]) =>
    mockSendWhatsAppLlmHelpfulnessPrompt(...args),
  upsertWhatsAppLlmAnswerReviewItem: (...args: unknown[]) =>
    mockUpsertWhatsAppLlmAnswerReviewItem(...args),
}));

jest.mock("@/lib/whatsapp/send-context", () => ({
  resolveWhatsAppSendContext: (params: unknown) =>
    mockResolveWhatsAppSendContext(params),
}));

jest.mock("@/lib/cross-store-outbox", () => ({
  enqueueWhatsAppLlmHelpfulnessPromptWithOutbox: (...args: unknown[]) =>
    mockEnqueueWhatsAppLlmHelpfulnessPromptWithOutbox(...args),
}));

import {
  applyTemporalPostDeliveryEffects,
  captureTemporalDeferredCommand,
  captureTemporalPostDeliveryEffect,
  getTemporalOutboundCapture,
  getTemporalPostDeliveryEffects,
  reserveTemporalOutboundDispatch,
  runWithTemporalOutboundCapture,
} from "@/lib/airi/reply/delivery/temporal-outbound";

describe("temporal outbound capture", () => {
  it("freezes server-resolved journey authority for timers and excludes it from customer replies", async () => {
    for (const messageId of [
      "scenario-timeout:post_action_no_reply_timeout:scenario:date",
      "real-inbound",
    ]) {
      const captured = await runWithTemporalOutboundCapture({
        workspaceId: "workspace",
        conversationId: "conversation",
        messageId,
        behaviorRunId: "a".repeat(24),
        run: async () => {
          reserveTemporalOutboundDispatch({
            context: { behaviorRunId: "forged", sourceMessageId: "forged" },
          });
        },
      });
      expect(captured.pendingDelivery?.context.sourceMessageId).toBe(messageId);
      expect(captured.pendingDelivery?.context.behaviorRunId).toBe(
        messageId.startsWith("scenario-timeout:") ? "a".repeat(24) : undefined
      );
    }
  });
  beforeEach(() => {
    jest.clearAllMocks();
    mockSuggestionCreate.mockResolvedValue({ _id: "suggestion-1" });
    mockSuggestionFindOneAndUpdate.mockResolvedValue({
      _id: "suggestion-1",
    });
    mockRealtimeTrigger.mockResolvedValue(undefined);
    mockPersistAiriReplyTrace.mockResolvedValue(undefined);
    mockMessageFindById.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve({ messageId: "wamid.feedback-source" }),
      }),
    });
    mockSendWhatsAppLlmHelpfulnessPrompt.mockResolvedValue({ id: "wamid.fb" });
    mockUpsertWhatsAppLlmAnswerReviewItem.mockResolvedValue({
      item: { _id: "review-1" },
      inserted: true,
    });
    mockEnqueueWhatsAppLlmHelpfulnessPromptWithOutbox.mockResolvedValue({
      queuedToOutbox: true,
    });
    mockResolveWhatsAppSendContext.mockResolvedValue(null);
  });

  it("captures one pending outbound delivery with a reserved message id", async () => {
    const result = await runWithTemporalOutboundCapture({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      run: async () => {
        const capture = reserveTemporalOutboundDispatch({
          context: {
            type: "whatsapp",
            workspaceId: "workspace-1",
            conversation: { _id: "conversation-1" },
            chatDocument: { _id: "chat-1" },
            content: "Airi: hello",
          },
        });

        expect(capture.placeholderMessageId).toHaveLength(24);
        expect(capture.delivery.deliveryKey).toBeTruthy();
        expect(getTemporalOutboundCapture()?.reservedMessageId).toBe(
          capture.delivery.reservedMessageId
        );

        return "ok";
      },
    });

    expect(result.result).toBe("ok");
    expect(result.pendingDelivery).not.toBeNull();
    expect(result.pendingDelivery?.reservedMessageId).toHaveLength(24);
    expect(
      (result.pendingDelivery?.context as { temporalDeliveryKey?: string })
        ?.temporalDeliveryKey
    ).toBe(result.pendingDelivery?.deliveryKey);
  });

  it("captures the requested at-most-once dispatch policy outside the context DTO", async () => {
    const result = await runWithTemporalOutboundCapture({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      run: async () => {
        reserveTemporalOutboundDispatch({
          context: {
            type: "whatsapp",
            workspaceId: "workspace-1",
            conversation: { _id: "conversation-1" },
            chatDocument: { _id: "chat-1" },
            content: "Airi: hello",
          },
          dispatchPolicy: "at_most_once",
        });
      },
    });

    expect(result.pendingDelivery?.dispatchPolicy).toBe("at_most_once");
    expect(result.pendingDelivery?.context).not.toHaveProperty(
      "temporalDispatchPolicy"
    );
  });

  it("carries a deferred command without an outbound delivery", async () => {
    const command = {
      version: 1 as const,
      kind: "start_generative_ai_scenario" as const,
      workflowId: "scenario-generation:execution-1",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      executionId: "execution-1",
      scenarioId: "scenario-1",
      scenarioRevisionFingerprint: "a".repeat(64),
      actionNodeId: "generate-1",
    };
    const result = await runWithTemporalOutboundCapture({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      run: async () => {
        captureTemporalDeferredCommand(command);
      },
    });

    expect(result.deferredCommand).toEqual(command);
    expect(result.pendingDelivery).toBeNull();
    expect(result.postDeliveryEffects).toEqual([]);
  });

  it("scopes a stable execution-derived delivery key and reserved message id to one conversation", async () => {
    const capture = (params: {
      workspaceId: string;
      conversationId: string;
      messageId: string;
    }) =>
      runWithTemporalOutboundCapture({
        ...params,
        run: async () => {
          reserveTemporalOutboundDispatch({
            context: { content: "Creating your video." },
            dispatchPolicy: "at_most_once",
            dispatchIdentity: "generative-ack:execution-1",
          });
        },
      });

    const [first, recovered, otherWorkspace, otherConversation] =
      await Promise.all([
        capture({
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          messageId: "message-1",
        }),
        capture({
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          messageId: "message-2",
        }),
        capture({
          workspaceId: "workspace-2",
          conversationId: "conversation-1",
          messageId: "message-1",
        }),
        capture({
          workspaceId: "workspace-1",
          conversationId: "conversation-2",
          messageId: "message-1",
        }),
      ]);
    expect(recovered.pendingDelivery?.deliveryKey).toBe(
      first.pendingDelivery?.deliveryKey
    );
    expect(recovered.pendingDelivery?.reservedMessageId).toBe(
      first.pendingDelivery?.reservedMessageId
    );
    expect(otherWorkspace.pendingDelivery?.deliveryKey).not.toBe(
      first.pendingDelivery?.deliveryKey
    );
    expect(otherWorkspace.pendingDelivery?.reservedMessageId).not.toBe(
      first.pendingDelivery?.reservedMessageId
    );
    expect(otherConversation.pendingDelivery?.deliveryKey).not.toBe(
      first.pendingDelivery?.deliveryKey
    );
    expect(otherConversation.pendingDelivery?.reservedMessageId).not.toBe(
      first.pendingDelivery?.reservedMessageId
    );
  });

  it("rejects deterministic delivery identity outside strict at-most-once dispatch", async () => {
    await expect(
      runWithTemporalOutboundCapture({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        run: async () => {
          reserveTemporalOutboundDispatch({
            context: { content: "unsafe identity" },
            dispatchIdentity: "generative-ack:execution-1",
          });
        },
      })
    ).rejects.toThrow("at_most_once");
  });

  it("rejects multiple outbound captures in one turn", async () => {
    await expect(
      runWithTemporalOutboundCapture({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        run: async () => {
          reserveTemporalOutboundDispatch({
            context: {
              type: "whatsapp",
              workspaceId: "workspace-1",
              conversation: { _id: "conversation-1" },
              chatDocument: { _id: "chat-1" },
              content: "Airi: first",
            },
          });

          reserveTemporalOutboundDispatch({
            context: {
              type: "whatsapp",
              workspaceId: "workspace-1",
              conversation: { _id: "conversation-1" },
              chatDocument: { _id: "chat-1" },
              content: "Airi: second",
            },
          });
        },
      })
    ).rejects.toThrow("Multiple outbound dispatches were attempted");
  });

  it("captures post-delivery effects only when preparation mode is enabled", async () => {
    const withoutCapture = await runWithTemporalOutboundCapture({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      run: async () => {
        expect(
          captureTemporalPostDeliveryEffect({
            kind: "clear_suppressed_state",
            conversationId: "conversation-1",
          })
        ).toBe(false);

        return "noop";
      },
    });

    expect(withoutCapture.postDeliveryEffects).toEqual([]);

    const withCapture = await runWithTemporalOutboundCapture({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      capturePostDeliveryEffects: true,
      run: async () => {
        expect(
          captureTemporalPostDeliveryEffect({
            kind: "clear_suppressed_state",
            conversationId: "conversation-1",
          })
        ).toBe(true);

        expect(getTemporalPostDeliveryEffects()).toEqual([
          {
            kind: "clear_suppressed_state",
            conversationId: "conversation-1",
          },
        ]);

        return "captured";
      },
    });

    expect(withCapture.result).toBe("captured");
    expect(withCapture.postDeliveryEffects).toEqual([
      {
        kind: "clear_suppressed_state",
        conversationId: "conversation-1",
      },
    ]);
  });

  it("applies retried post-delivery effects with deterministic persistence", async () => {
    await applyTemporalPostDeliveryEffects({
      delivery: {
        deliveryKey: "delivery-1",
        outboundMessageId: "message-out",
        outboundDate: "2026-07-10T10:00:00.000Z",
        classification: "sent",
      },
      effects: [
        {
          kind: "persist_reply_trace",
          payload: {
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
            inboundMessageId: "message-in",
            delivered: true,
          },
        },
        {
          kind: "publish_airi_suggestion",
          payload: {
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
            messageId: "message-in",
            realtimePayload: { messageId: "message-in" },
            score: 0.9,
            approved: true,
            autoSent: true,
          },
        },
      ],
    });

    expect(mockPersistAiriReplyTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        outboundMessageId: "message-out",
        idempotencyKey: "delivery-1:persist_reply_trace:0",
      })
    );
    expect(mockSuggestionCreate).not.toHaveBeenCalled();
    expect(mockSuggestionFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: expect.stringMatching(/^[a-f0-9]{24}$/) },
      { $set: expect.objectContaining({ messageId: "message-in" }) },
      { upsert: true, setDefaultsOnInsert: true }
    );
    expect(
      mockSuggestionFindOneAndUpdate.mock.invocationCallOrder[0]
    ).toBeLessThan(mockRealtimeTrigger.mock.invocationCallOrder[0]);
  });

  it("applies WhatsApp LLM feedback as a post-delivery effect after Meta persist", async () => {
    await applyTemporalPostDeliveryEffects({
      delivery: {
        deliveryKey: "delivery-feedback",
        outboundMessageId: "507f1f77bcf86cd799439011",
        outboundDate: "2026-07-10T10:00:00.000Z",
        classification: "sent",
      },
      effects: [
        {
          kind: "send_whatsapp_llm_feedback",
          payload: {
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
            recipient: { kind: "phone", value: "77473035733" },
            recipientDigits: "77473035733",
          },
        },
      ],
    });

    expect(mockUpsertWhatsAppLlmAnswerReviewItem).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      sourceMessageId: "wamid.feedback-source",
    });
    expect(
      mockEnqueueWhatsAppLlmHelpfulnessPromptWithOutbox
    ).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      sourceId: null,
      recipient: { kind: "phone", value: "77473035733" },
      sourceMessageId: "wamid.feedback-source",
    });
    expect(mockSendWhatsAppLlmHelpfulnessPrompt).not.toHaveBeenCalled();
  });

  it("retries durable prompt enqueue when persistence won but the first enqueue failed", async () => {
    mockUpsertWhatsAppLlmAnswerReviewItem
      .mockResolvedValueOnce({
        item: { _id: "review-1" },
        inserted: true,
      })
      .mockResolvedValueOnce({
        item: { _id: "review-1" },
        inserted: false,
      });
    mockEnqueueWhatsAppLlmHelpfulnessPromptWithOutbox
      .mockRejectedValueOnce(new Error("temporary Mongo queue failure"))
      .mockResolvedValueOnce({ queuedToOutbox: true });
    const input = {
      delivery: {
        deliveryKey: "delivery-feedback-retry",
        outboundMessageId: "507f1f77bcf86cd799439011",
        outboundDate: "2026-07-10T10:00:00.000Z",
        classification: "sent" as const,
      },
      effects: [
        {
          kind: "send_whatsapp_llm_feedback" as const,
          payload: {
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
            recipient: { kind: "phone" as const, value: "77473035733" },
          },
        },
      ],
    };

    await expect(applyTemporalPostDeliveryEffects(input)).rejects.toThrow(
      "temporary Mongo queue failure"
    );
    await applyTemporalPostDeliveryEffects(input);

    expect(mockUpsertWhatsAppLlmAnswerReviewItem).toHaveBeenCalledTimes(1);
    expect(
      mockEnqueueWhatsAppLlmHelpfulnessPromptWithOutbox
    ).toHaveBeenCalledTimes(2);
    expect(mockSendWhatsAppLlmHelpfulnessPrompt).not.toHaveBeenCalled();
  });

  it("queues only source identity and resolves no WhatsApp secret in the effect", async () => {
    mockResolveWhatsAppSendContext.mockResolvedValue({
      phoneNumberId: "phone-number-id",
      accessToken: "access-token",
    });

    await applyTemporalPostDeliveryEffects({
      delivery: {
        deliveryKey: "delivery-feedback-lazy",
        outboundMessageId: "507f1f77bcf86cd799439011",
        outboundDate: "2026-07-10T10:00:00.000Z",
        classification: "sent",
      },
      effects: [
        {
          kind: "send_whatsapp_llm_feedback",
          payload: {
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
            sourceId: "source-1",
            recipient: { kind: "phone", value: "77473035733" },
          },
        },
      ],
    });

    expect(mockResolveWhatsAppSendContext).not.toHaveBeenCalled();
    expect(
      mockEnqueueWhatsAppLlmHelpfulnessPromptWithOutbox
    ).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      sourceId: "source-1",
      recipient: { kind: "phone", value: "77473035733" },
      sourceMessageId: "wamid.feedback-source",
    });
    expect(mockSendWhatsAppLlmHelpfulnessPrompt).not.toHaveBeenCalled();
  });
});
