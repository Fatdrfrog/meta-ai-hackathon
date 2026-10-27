import type { AiriAutoReplyParams } from "@icecore/airi-runtime/auto-reply";
import {
  buildAiriConversationExternalEventWorkflowInput,
  buildAiriConversationTurnSignal,
} from "@/lib/temporal/client";

function createParams(
  overrides: Partial<AiriAutoReplyParams> = {}
): AiriAutoReplyParams {
  return {
    type: "telegram",
    workspaceId: "workspace-1",
    newMessage: {
      _id: "message-1",
      text: "How do I submit an application?",
      date: new Date("2026-03-29T06:00:00.000Z"),
    } as unknown as AiriAutoReplyParams["newMessage"],
    conversation: {
      _id: "conversation-1",
      sourceId: "source-conversation",
    } as unknown as AiriAutoReplyParams["conversation"],
    chatDocument: {
      _id: "chat-1",
      sourceId: "source-chat",
    } as unknown as AiriAutoReplyParams["chatDocument"],
    ...overrides,
  };
}

describe("temporal web client helpers", () => {
  it("builds a conversation turn signal from safe metadata only", () => {
    const signal = buildAiriConversationTurnSignal(createParams(), {
      turnContextId: "turn-context-1",
    });

    expect(signal.workspaceId).toBe("workspace-1");
    expect(signal.conversationId).toBe("conversation-1");
    expect(signal.messageId).toBe("message-1");
    expect(signal.channel).toBe("telegram");
    expect(signal.sourceId).toBe("source-chat");
    expect(signal.textPreview).toBe("How do I submit an application?");
    expect(signal.messageDate).toBe("2026-03-29T06:00:00.000Z");
    expect(signal.turnContextId).toBe("turn-context-1");
    expect(signal.autoReplyPayload).toBeUndefined();
    expect(signal.enqueuedAt).toEqual(expect.any(String));
  });

  it("builds an external-event workflow input without a synthetic turn", () => {
    const input = buildAiriConversationExternalEventWorkflowInput({
      kind: "timer_replan",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      sourceId: "source-1",
      channel: "whatsapp",
      messageId: "timer-replan:scenario-1:message-1",
      messageDate: "2026-07-10T02:00:00.000Z",
      enqueuedAt: "2026-07-10T02:01:00.000Z",
    });

    expect(input).toEqual({
      contractVersion: 3,
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      sourceId: "source-1",
      startedAt: "2026-07-10T02:01:00.000Z",
      timerWaitMode: "condition_timeout",
    });
    expect(input.initialTurn).toBeUndefined();
  });

  it("routes a generative result without adding control-event fields", () => {
    const input = buildAiriConversationExternalEventWorkflowInput({
      kind: "generative_ai_result",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "execution-1",
      executionId: "execution-1",
      scenarioWorkflowId: "scenario-generation:execution-1",
      videoWorkflowId: "video-generation:asset-1",
      assetId: "asset-1",
      terminal: {
        state: "complete",
        code: "generation_complete",
        attemptToken: "attempt-1",
      },
    });

    expect(input.workspaceId).toBe("workspace-1");
    expect(input.conversationId).toBe("conversation-1");
    expect(input.sourceId).toBeNull();
    expect(input.startedAt).toEqual(expect.any(String));
    expect(input.initialTurn).toBeUndefined();
  });
});
