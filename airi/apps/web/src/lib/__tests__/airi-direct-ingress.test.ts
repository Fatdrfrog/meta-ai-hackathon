const mockIsTemporalConfigured = jest.fn();
const mockSignalWithStartAiriConversation = jest.fn();
const mockCreateContext = jest.fn();
const mockMaterialize = jest.fn();
const mockDispatch = jest.fn();

type MockDirectIngressLogger = {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
};

function getOrCreateMockDirectIngressLogger(): MockDirectIngressLogger {
  const globalWithLogger = globalThis as typeof globalThis & {
    __mockDirectIngressLogger?: MockDirectIngressLogger;
  };

  if (!globalWithLogger.__mockDirectIngressLogger) {
    globalWithLogger.__mockDirectIngressLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
  }

  return globalWithLogger.__mockDirectIngressLogger;
}

jest.mock("@/lib/temporal/client", () => ({
  isTemporalConfigured: (...args: unknown[]) =>
    mockIsTemporalConfigured(...args),
  signalWithStartAiriConversation: (...args: unknown[]) =>
    mockSignalWithStartAiriConversation(...args),
}));

jest.mock("@/lib/observability/server-logs", () => ({
  createServerLogger: () => getOrCreateMockDirectIngressLogger(),
}));

jest.mock("@/lib/temporal/airi-turn-context", () => ({
  createAiriConversationTurnContext: (...args: unknown[]) =>
    mockCreateContext(...args),
  buildAiriConversationIngressKey: jest.fn(
    () => "airi-ingress:ws_1:conversation_1:message_1:telegram"
  ),
  hydrateStoredAiriAutoReplyParamsFromTurn: jest.fn(),
}));

jest.mock("@/lib/temporal/airi-conversation-ingress", () => ({
  materializeAiriMessageIngress: (...args: unknown[]) =>
    mockMaterialize(...args),
  dispatchPersistedAiriConversationIngress: (...args: unknown[]) =>
    mockDispatch(...args),
}));

import type { AiriAutoReplyParams } from "@icecore/airi-runtime/auto-reply";
import {
  acceptAiriConversationIngress,
  directIngressAiriConversation,
} from "@/lib/temporal/airi-direct-ingress";

function createPayload(): AiriAutoReplyParams {
  return {
    type: "telegram" as const,
    workspaceId: "ws_1",
    conversation: {
      _id: "conversation_1",
      sourceId: "source_1",
      business_connection_id: null,
      chat: null,
      createdAt: new Date("2026-03-29T06:00:00.000Z"),
      updatedAt: new Date("2026-03-29T06:00:00.000Z"),
      lastMessageAt: new Date("2026-03-29T06:00:00.000Z"),
    },
    newMessage: {
      _id: "message_1",
      conversation: "conversation_1",
      date: new Date("2026-03-29T06:00:00.000Z"),
      direction: "inbound" as const,
      channel: "telegram" as const,
      text: "hello",
      ragContext: "",
    },
    chatDocument: {
      _id: "chat_1",
      sourceId: "source_1",
      workspaceId: "ws_1",
      businessConnectionId: null,
    },
    botToken: "telegram-secret-token",
    whatsAppInfo: {
      phoneNumberId: "phone-1",
      accessToken: "whatsapp-secret-token",
      contactData: {
        waId: "77015551212",
        profile: { name: "Customer" },
        primaryIdType: "wa_id",
      },
    },
    instagramInfo: {
      pageId: "page_1",
      accessToken: "instagram-secret-token",
      recipientId: "recipient_1",
      threadType: "dm",
    },
    chatId: 42,
    chatType: "private",
  } as unknown as AiriAutoReplyParams;
}

describe("directIngressAiriConversation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTemporalConfigured.mockReturnValue(true);
    mockSignalWithStartAiriConversation.mockResolvedValue({
      workflowHandle: {
        workflowId: "airi-conversation:conversation_1",
        signaledRunId: "run_1",
      },
      workflowId: "airi-conversation:conversation_1",
      turnContextId: "turn_ctx_test_1",
      taskQueue: "airi-conversation",
      alreadySignaled: false,
    });
  });

  it("signals Temporal directly and returns the workflow handle", async () => {
    const payload = createPayload();
    const result = await directIngressAiriConversation(payload, {
      label: "test-ingress",
    });

    expect(mockSignalWithStartAiriConversation).toHaveBeenCalledWith(payload, {
      ingressKey: "airi-ingress:ws_1:conversation_1:message_1:telegram",
    });
    const forwardedPayload =
      mockSignalWithStartAiriConversation.mock.calls[0]?.[0];
    expect(forwardedPayload).toBe(payload);
    expect(result).toEqual({
      workflowId: "airi-conversation:conversation_1",
      signaledRunId: "run_1",
      alreadySignaled: false,
    });
    expect(getOrCreateMockDirectIngressLogger().info).toHaveBeenCalledWith(
      "Airi direct ingress signaled",
      expect.objectContaining({
        label: "test-ingress",
        workflowId: "airi-conversation:conversation_1",
        turnContextId: "turn_ctx_test_1",
        taskQueue: "airi-conversation",
      })
    );
  });

  it("fails loudly when Temporal is not configured", async () => {
    mockIsTemporalConfigured.mockReturnValue(false);

    await expect(
      directIngressAiriConversation(createPayload())
    ).rejects.toThrow(
      "Temporal is required for Airi ingress, but it is not configured"
    );
    expect(mockSignalWithStartAiriConversation).not.toHaveBeenCalled();
    expect(mockCreateContext).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ ingressKey: expect.any(String) })
    );
  });

  it("uses one durable ingress key and skips a turn already accepted by Temporal", async () => {
    mockSignalWithStartAiriConversation.mockResolvedValue({
      workflowHandle: null,
      workflowId: "airi-conversation:conversation_1",
      turnContextId: "turn_ctx_test_1",
      taskQueue: "airi-conversation",
      alreadySignaled: true,
    });

    const result = await directIngressAiriConversation(createPayload(), {
      idempotent: true,
    });

    expect(mockSignalWithStartAiriConversation).toHaveBeenCalledWith(
      expect.any(Object),
      {
        ingressKey: "airi-ingress:ws_1:conversation_1:message_1:telegram",
      }
    );
    expect(result).toEqual({
      workflowId: "airi-conversation:conversation_1",
      signaledRunId: null,
      alreadySignaled: true,
    });
  });

  it("passes the durable ingress key into signal-with-start", async () => {
    const payload = createPayload();

    await directIngressAiriConversation(payload, { idempotent: true });

    expect(mockSignalWithStartAiriConversation).toHaveBeenCalledWith(payload, {
      ingressKey: "airi-ingress:ws_1:conversation_1:message_1:telegram",
    });
  });
});

describe("accepted inbound ingress", () => {
  const message = {
    _id: "message-1",
    workspaceId: "workspace-1",
    conversation: "conversation-1",
  };
  beforeEach(() => {
    jest.clearAllMocks();
    mockMaterialize.mockResolvedValue({
      ...message,
      conversationId: "conversation-1",
      messageId: "message-1",
      ingressKey: "key-1",
    });
  });
  it("acknowledges durable acceptance while Temporal is unavailable", async () => {
    mockDispatch.mockRejectedValue(new Error("Temporal unavailable"));
    await expect(acceptAiriConversationIngress(message)).resolves.toEqual({
      accepted: true,
      status: "pending",
    });
  });
  it("does not claim durable acceptance if queue persistence failed", async () => {
    mockMaterialize.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(acceptAiriConversationIngress(message)).rejects.toThrow(
      "database unavailable"
    );
    expect(mockDispatch).not.toHaveBeenCalled();
  });
  it("reports successful Temporal handoff separately", async () => {
    mockDispatch.mockResolvedValue({ workflowId: "workflow-1" });
    await expect(acceptAiriConversationIngress(message)).resolves.toEqual({
      accepted: true,
      status: "signaled",
      workflowId: "workflow-1",
    });
  });
});
