import {
  buildInstagramAiriJobPayload,
  getInstagramGraphApiBases,
  hashInstagramIdToNumber,
  queueInstagramAiriAutoReply,
} from "@/lib/instagram/webhook-shared";

const mockAcceptAiriIngress = jest.fn();
jest.mock("@/lib/temporal/airi-direct-ingress", () => ({
  acceptAiriConversationIngress: (...args: unknown[]) =>
    mockAcceptAiriIngress(...args),
  directIngressAiriConversation: jest.fn().mockResolvedValue(undefined),
}));

describe("Instagram webhook shared helpers", () => {
  it("accepts the persisted message owner with a fallback payload for legacy retries", async () => {
    const message = {
      _id: "message-1",
      conversation: "conversation-1",
      workspaceId: "workspace-1",
      airiIngressIntent: { ingressStatus: "pending" },
    };
    mockAcceptAiriIngress.mockResolvedValueOnce({
      accepted: true,
      status: "pending",
    });
    await expect(
      queueInstagramAiriAutoReply(
        {
          type: "instagram",
          newMessage: message,
          conversation: { _id: "conversation-1", sourceId: "source-1" },
          workspaceId: "workspace-1",
          chatDocument: { _id: "chat-1", sourceId: "source-1" },
        } as never,
        { missingContextError: "missing ids" }
      )
    ).resolves.toBeUndefined();
    expect(mockAcceptAiriIngress).toHaveBeenCalledWith(
      message,
      expect.objectContaining({
        type: "instagram",
        newMessage: expect.objectContaining({ _id: "message-1" }),
      })
    );
  });
  it("uses the correct Graph host fallback order for each auth method", () => {
    expect(getInstagramGraphApiBases("instagram_business_login")).toEqual([
      "https://graph.instagram.com/v25.0",
      "https://graph.facebook.com/v25.0",
    ]);
    expect(getInstagramGraphApiBases("facebook_login")).toEqual([
      "https://graph.facebook.com/v25.0",
      "https://graph.instagram.com/v25.0",
    ]);
  });

  it("hashes Instagram IDs deterministically into safe numeric ids", () => {
    const first = hashInstagramIdToNumber("ig:user:123");
    const second = hashInstagramIdToNumber("ig:user:123");

    expect(first).toBe(second);
    expect(Number.isSafeInteger(first)).toBe(true);
    expect(first).toBeGreaterThanOrEqual(0);
  });

  it("compacts Airi ingress payloads to the fields needed by Temporal", () => {
    const payload = buildInstagramAiriJobPayload({
      type: "instagram",
      instagramInfo: {
        pageId: "page-1",
        accessToken: "token",
        recipientId: "user-1",
      },
      newMessage: {
        _id: "message-1",
        text: "hello",
        ragContext: "ctx",
        date: new Date("2026-01-01T00:00:00.000Z"),
        conversation: "conversation-1",
        direction: "inbound",
        channel: "instagram",
        extra: "drop",
      },
      conversation: {
        _id: "conversation-1",
        sourceId: "source-1",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
        lastMessageAt: new Date("2026-01-03T00:00:00.000Z"),
        extra: "drop",
      },
      workspaceId: "workspace-1",
      chatDocument: {
        _id: "chat-1",
        sourceId: "source-1",
        workspaceId: "workspace-1",
        businessConnectionId: "business-1",
        extra: "drop",
      },
      chatId: 123,
    } as never);

    expect(payload.newMessage).toEqual({
      _id: "message-1",
      text: "hello",
      ragContext: "ctx",
      date: new Date("2026-01-01T00:00:00.000Z"),
      conversation: "conversation-1",
      direction: "inbound",
      channel: "instagram",
    });
    expect(payload.conversation).toEqual({
      _id: "conversation-1",
      sourceId: "source-1",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      lastMessageAt: new Date("2026-01-03T00:00:00.000Z"),
    });
    expect(payload.chatDocument).toEqual({
      _id: "chat-1",
      sourceId: "source-1",
      workspaceId: "workspace-1",
      businessConnectionId: "business-1",
    });
  });
});
