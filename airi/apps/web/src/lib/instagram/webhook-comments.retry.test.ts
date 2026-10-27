const mockConnectDB = jest.fn();
const mockAppendMessage = jest.fn();
const mockMessageFindOne = jest.fn();
const mockConversationFindOne = jest.fn();
const mockUserFindOneAndUpdate = jest.fn();
const mockChatFindOneAndUpdate = jest.fn();
const mockDetectLanguage = jest.fn();
const mockPublishMessage = jest.fn();
const mockQueueAutoReply = jest.fn();
const mockMessageSave = jest.fn();
const mockResolveAccessToken = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: Parameters<typeof mockConnectDB>) =>
    mockConnectDB(...args),
}));
jest.mock("@/lib/conversation-messages", () => ({
  appendMessageToConversationById: (
    ...args: Parameters<typeof mockAppendMessage>
  ) => mockAppendMessage(...args),
}));
jest.mock("@/lib/airi/coach/coach-utils-server", () => ({
  detectAndUpdateConversationLanguage: (
    ...args: Parameters<typeof mockDetectLanguage>
  ) => mockDetectLanguage(...args),
}));
jest.mock("@/lib/airi/workspace-bot-default", () => ({
  getWorkspaceBotDefault: jest.fn().mockResolvedValue(false),
  getWorkspaceCoachDefault: jest.fn().mockResolvedValue(false),
  getWorkspaceScenariosDefault: jest.fn().mockResolvedValue(false),
}));
jest.mock("@/lib/limits/company-limits", () => ({
  COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE: "limit_exceeded",
  ensureCompanyConversationCapacity: jest
    .fn()
    .mockResolvedValue({ allowed: true }),
}));
jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));
jest.mock("@/models/user", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: (...args: Parameters<typeof mockUserFindOneAndUpdate>) =>
      mockUserFindOneAndUpdate(...args),
  },
}));
jest.mock("@/models/chat", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: (...args: Parameters<typeof mockChatFindOneAndUpdate>) =>
      mockChatFindOneAndUpdate(...args),
  },
}));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    findOne: (...args: Parameters<typeof mockConversationFindOne>) =>
      mockConversationFindOne(...args),
  },
}));
jest.mock("@/models/message", () => ({
  __esModule: true,
  default: Object.assign(
    function MockMessage(
      this: Record<string, unknown>,
      payload: Record<string, unknown>
    ) {
      Object.assign(this, payload, { _id: "new-message" });
      this.save = () => mockMessageSave(this);
    },
    {
      findOne: (...args: Parameters<typeof mockMessageFindOne>) =>
        mockMessageFindOne(...args),
    }
  ),
}));
jest.mock("./webhook-shared", () => ({
  INSTAGRAM_USER_PLACEHOLDER: "Instagram User",
  getInstagramGraphApiBases: () => [],
  hashInstagramIdToNumber: (value: string) =>
    value.includes("media") ? 202 : 101,
  publishInstagramConversationMessage: (
    ...args: Parameters<typeof mockPublishMessage>
  ) => mockPublishMessage(...args),
  queueInstagramAiriAutoReply: (
    ...args: Parameters<typeof mockQueueAutoReply>
  ) => mockQueueAutoReply(...args),
  resolveInstagramAccessToken: () => mockResolveAccessToken(),
}));

import { handleInstagramComment } from "./webhook-comments";

describe("Instagram comment retry linkage", () => {
  const conversation = {
    _id: "conversation-1",
    user: 101,
    participants: { from: ["101"], to: ["agent"] },
    external_thread: {
      provider: "instagram",
      threadId: "media-1",
      type: "comment",
    },
  };
  const existingMessage = {
    _id: "message-1",
    conversation: "conversation-1",
    date: new Date("2026-08-10T00:00:00.000Z"),
    direction: "inbound",
    channel: "instagram",
    workspaceId: "workspace-1",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockResolveAccessToken.mockReturnValue("");
    mockMessageSave.mockImplementation(async message => message);
    mockUserFindOneAndUpdate.mockResolvedValue({ _id: 101 });
    mockChatFindOneAndUpdate.mockResolvedValue({ _id: 202 });
    mockConversationFindOne.mockResolvedValue(conversation);
    mockMessageFindOne.mockImplementation((filter: { direction?: string }) =>
      filter.direction === "outbound"
        ? null
        : { exec: jest.fn().mockResolvedValue(existingMessage) }
    );
    mockAppendMessage.mockResolvedValue({
      appended: false,
      classificationRevision: 1,
      requestedRevision: null,
      generation: 1,
      status: "completed",
      requestedAt: null,
    });
    mockDetectLanguage.mockResolvedValue(undefined);
    mockPublishMessage.mockResolvedValue(undefined);
    mockQueueAutoReply.mockResolvedValue(undefined);
  });

  const payload = {
    id: "comment-1",
    text: "Need help",
    timestamp: "2026-08-10T00:00:00.000Z",
    from: { id: "customer-1", username: "customer" },
    media: { id: "media-1" },
  };
  const source = {
    id: "source-1",
    workspace_id: "workspace-1",
    pageAccessToken: "",
    pageId: "page-1",
  };

  it("links the persisted owner before acknowledging an existing comment", async () => {
    await expect(handleInstagramComment(payload, source)).resolves.toEqual({
      status: "ok",
      duplicate: true,
    });

    expect(mockAppendMessage).toHaveBeenCalledWith(
      "conversation-1",
      "message-1",
      expect.objectContaining({ direction: "inbound" })
    );
    expect(mockDetectLanguage).not.toHaveBeenCalled();
  });

  it("keeps an existing comment retryable when canonical append fails", async () => {
    const appendError = new Error("append unavailable");
    mockAppendMessage.mockRejectedValueOnce(appendError);

    await expect(handleInstagramComment(payload, source)).rejects.toBe(
      appendError
    );
  });

  it("accepts a previously linked comment before acknowledging its retry", async () => {
    mockResolveAccessToken.mockReturnValue("token");

    await expect(handleInstagramComment(payload, source)).resolves.toEqual({
      status: "ok",
      duplicate: true,
    });

    expect(mockQueueAutoReply).toHaveBeenCalledWith(
      expect.objectContaining({
        newMessage: existingMessage,
        instagramInfo: expect.objectContaining({
          threadType: "comment",
          commentId: "comment-1",
        }),
      }),
      expect.any(Object)
    );
    expect(mockMessageSave).not.toHaveBeenCalled();
  });

  it("saves comment recovery metadata in the same write before linking", async () => {
    mockResolveAccessToken.mockReturnValue("token");
    mockMessageFindOne.mockImplementation((filter: { direction?: string }) =>
      filter.direction === "outbound"
        ? null
        : { exec: jest.fn().mockResolvedValue(null) }
    );
    mockMessageSave.mockImplementationOnce(async message => {
      expect(message.airiIngressIntent).toEqual(
        expect.objectContaining({
          messageId: "new-message",
          ingressStatus: "pending",
          channelHints: expect.objectContaining({
            instagram: expect.objectContaining({
              threadType: "comment",
              commentId: "comment-1",
              recipientId: "customer-1",
            }),
          }),
        })
      );
      expect(JSON.stringify(message.airiIngressIntent)).not.toContain(
        '"accessToken"'
      );
      return message;
    });
    mockAppendMessage.mockRejectedValueOnce(new Error("append unavailable"));

    await expect(handleInstagramComment(payload, source)).rejects.toThrow(
      "append unavailable"
    );
    expect(mockMessageSave).toHaveBeenCalledTimes(1);
  });
});
