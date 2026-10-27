import { createHash } from "node:crypto";

const mockAuthenticate = jest.fn();
const mockConnectDB = jest.fn();
const mockFindConversation = jest.fn();
const mockSend = jest.fn();
const mockResolveSource = jest.fn();
const mockWindow = jest.fn();
const mockSaveMessage = jest.fn();
const mockAppend = jest.fn();
const mockLedgerCreate = jest.fn();
const mockLedgerUpdate = jest.fn();
const mockLedgerFind = jest.fn();
const mockLegacySource = jest.fn();
const mockPlanGate = jest.fn();
const mockMessageData: Record<string, unknown>[] = [];
const mockOperations = new Map<string, Record<string, unknown>>();

jest.mock("@/lib/api-auth", () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args),
  hasPermission: (
    key: { permissions: Record<string, boolean> },
    permission: string
  ) => key.permissions[permission] === true,
}));
jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => mockFindConversation(...args),
  },
}));
jest.mock("@/lib/whatsapp", () => ({
  sendWhatsappMessage: (...args: unknown[]) => mockSend(...args),
}));
jest.mock("@/lib/whatsapp/send-context", () => ({
  resolveFreshWhatsAppSendContext: (...args: unknown[]) =>
    mockResolveSource(...args),
}));
jest.mock("@/lib/messaging-window", () => ({
  checkMessagingWindowForConversation: (...args: unknown[]) =>
    mockWindow(...args),
  formatWindowMessage: () => "The customer messaging window has closed",
}));
jest.mock("@/lib/conversation-messages", () => ({
  appendMessageToConversationById: (...args: unknown[]) => mockAppend(...args),
}));
jest.mock("@/lib/observability/server-logs", () => ({
  createServerLogger: () => ({ error: jest.fn() }),
}));
jest.mock("@/lib/limits/company-limits", () => ({
  getHiddenConversationPlanGateResponse: (...args: unknown[]) =>
    mockPlanGate(...args),
}));
jest.mock("@/models/user", () => ({
  __esModule: true,
  default: {
    findById: () => ({
      select: () => ({
        lean: () =>
          Promise.resolve({
            _id: "customer-1",
            whatsapp: { waId: "77001234567" },
          }),
      }),
    }),
    findOneAndUpdate: () => Promise.resolve({ _id: "api_bot", isBot: true }),
  },
}));
jest.mock("@/models/message", () => ({
  __esModule: true,
  default: function Message(
    this: Record<string, unknown>,
    data: Record<string, unknown>
  ) {
    Object.assign(this, data);
    this._id = data._id || "507f1f77bcf86cd799439012";
    this.save = mockSaveMessage;
    mockMessageData.push(data);
  },
}));
jest.mock("@/models/api-message-send-operation", () => ({
  __esModule: true,
  default: {
    findById: (...args: unknown[]) => ({ lean: () => mockLedgerFind(...args) }),
    create: (...args: unknown[]) => mockLedgerCreate(...args),
    updateOne: (...args: unknown[]) => mockLedgerUpdate(...args),
  },
}));
// The old route's latest-source lookup deliberately points at a different sender.
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: () => ({ limit: () => ({ maybeSingle: mockLegacySource }) }),
          }),
        }),
      }),
    }),
  },
}));

import { POST } from "./route";

const conversationId = "507f1f77bcf86cd799439011";
const conversation = {
  _id: conversationId,
  workspaceId: "workspace-1",
  sourceId: "original-source",
  channel: "whatsapp",
  user: "customer-1",
  chat: { _id: "whatsapp-chat" },
  last_inbound_at: new Date(),
};

function request(
  body: unknown = { conversationId, text: "Hello" },
  key: string | null = "send-1"
) {
  return new Request("https://airi.chat/api/v1/messages/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer sk_live_customer",
      ...(key === null ? {} : { "Idempotency-Key": key }),
    },
    body: JSON.stringify(body),
  });
}

describe("customer WhatsApp text send", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOperations.clear();
    mockMessageData.length = 0;
    mockAuthenticate.mockResolvedValue({
      apiKey: {
        id: "key-1",
        workspace_id: "workspace-1",
        permissions: { write: true },
      },
      error: null,
    });
    mockConnectDB.mockResolvedValue(undefined);
    mockPlanGate.mockResolvedValue(null);
    mockFindConversation.mockResolvedValue(conversation);
    mockResolveSource.mockResolvedValue({
      sourceId: "original-source",
      workspaceId: "workspace-1",
      phoneNumberId: "original-phone",
      accessToken: "original-token",
    });
    mockLegacySource.mockResolvedValue({
      data: {
        credentials: {
          phone_number_id: "newest-phone",
          access_token: "newest-token",
        },
      },
    });
    mockWindow.mockResolvedValue({
      isWithinWindow: true,
      hoursRemaining: 12,
      lastCustomerMessageAt: new Date(),
    });
    mockSend.mockResolvedValue({
      messageId: "wamid.sent-1",
      date: 1_800_000_000,
    });
    mockSaveMessage.mockResolvedValue(undefined);
    mockAppend.mockResolvedValue({ appended: true });
    mockLedgerFind.mockImplementation(
      async (id: string) => mockOperations.get(id) || null
    );
    mockLedgerCreate.mockImplementation(
      async ([data]: Record<string, unknown>[]) => {
        const id = String(data._id);
        if (mockOperations.has(id))
          throw Object.assign(new Error("Duplicate key"), { code: 11000 });
        const record = {
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        mockOperations.set(id, record);
        return record;
      }
    );
    mockLedgerUpdate.mockImplementation(
      async (
        filter: Record<string, unknown>,
        update: { $set: Record<string, unknown> }
      ) => {
        const record = mockOperations.get(String(filter._id));
        if (
          !record ||
          Object.entries(filter).some(([key, value]) => record[key] !== value)
        ) {
          return { matchedCount: 0 };
        }
        Object.assign(record, update.$set, { updatedAt: new Date() });
        return { matchedCount: 1 };
      }
    );
  });

  it("does not let a conversation read scope authorize sending", async () => {
    mockAuthenticate.mockResolvedValue({
      apiKey: {
        id: "key-1",
        workspace_id: "workspace-1",
        permissions: { read: true, conversations: true, write: false },
      },
      error: null,
    });
    expect((await POST(request())).status).toBe(403);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("requires an idempotency key before sending", async () => {
    const response = await POST(request(undefined, null));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_REQUIRED",
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("sends through the conversation's own source and saves the existing response contract", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      messageId: expect.any(String),
      sentAt: "2027-01-15T08:00:00.000Z",
    });
    expect(mockResolveSource).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "original-source",
    });
    expect(mockSend).toHaveBeenCalledWith(
      "original-phone",
      "original-token",
      { kind: "phone", value: "77001234567" },
      "Hello"
    );
    expect(mockMessageData[0]).toMatchObject({
      channel: "whatsapp",
      direction: "outbound",
      workspaceId: "workspace-1",
      messageId: "ws_wamid.sent-1",
      origin: {
        kind: "system",
        sentByUserId: "api_bot",
        sourceId: "original-source",
      },
    });
  });

  it("rejects a closed messaging window without reserving or sending", async () => {
    mockWindow.mockResolvedValue({
      isWithinWindow: false,
      hoursRemaining: 0,
      lastCustomerMessageAt: null,
    });
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "WHATSAPP_MESSAGING_WINDOW_CLOSED",
    });
    expect(mockOperations.size).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("does not fall back to a different source for a conversation without a binding", async () => {
    mockFindConversation.mockResolvedValue({ ...conversation, sourceId: null });
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "WHATSAPP_SOURCE_REQUIRED",
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("refuses a conversation from another workspace", async () => {
    mockFindConversation.mockResolvedValue({
      ...conversation,
      workspaceId: "workspace-other",
    });
    expect((await POST(request())).status).toBe(403);
    expect(mockResolveSource).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("preserves the product plan gate before reserving a hidden conversation send", async () => {
    mockPlanGate.mockResolvedValue(
      Response.json({ code: "conversation_limit_exceeded" }, { status: 402 })
    );
    const response = await POST(request());
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      code: "conversation_limit_exceeded",
    });
    expect(mockOperations.size).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    { conversationId, text: {} },
    { conversationId, text: "   " },
    { conversationId: "bad", text: "Hello" },
  ])("rejects invalid message input before provider dispatch", async body => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("fails closed when the canonical plan gate cannot be resolved", async () => {
    mockPlanGate.mockRejectedValueOnce(new Error("Plan lookup unavailable"));
    expect((await POST(request())).status).toBe(503);
    expect(mockOperations.size).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("returns the original result on the same key after the messaging window closes", async () => {
    const first = await POST(request());
    const firstBody = await first.json();
    mockWindow.mockResolvedValue({ isWithinWindow: false });
    const replay = await POST(request());
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSaveMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects changing the payload while reusing a key", async () => {
    await POST(request());
    const response = await POST(
      request({ conversationId, text: "Different text" })
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "IDEMPOTENCY_KEY_CONFLICT",
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("sends only once for concurrent requests with the same key", async () => {
    let finishSend!: (value: { messageId: string; date: number }) => void;
    let dispatchStarted!: () => void;
    const started = new Promise<void>(resolve => {
      dispatchStarted = resolve;
    });
    mockSend.mockImplementationOnce(() => {
      dispatchStarted();
      return new Promise(resolve => {
        finishSend = resolve;
      });
    });
    const first = POST(request());
    await started;
    const concurrent = await POST(request());
    expect(concurrent.status).toBe(409);
    expect(await concurrent.json()).toMatchObject({ code: "SEND_IN_PROGRESS" });
    finishSend({ messageId: "wamid.sent-1", date: 1_800_000_000 });
    expect((await first).status).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("handles a reservation race when both callers initially read no operation", async () => {
    mockLedgerFind.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const responses = await Promise.all([POST(request()), POST(request())]);
    expect(
      responses.every(response => [200, 409].includes(response.status))
    ).toBe(true);
    expect(responses.some(response => response.status === 200)).toBe(true);
    expect(mockLedgerCreate).toHaveBeenCalledTimes(2);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSaveMessage).toHaveBeenCalledTimes(1);
  });

  it("durably claims the operation before Meta dispatch with no raw key or message text in the ledger", async () => {
    expect((await POST(request())).status).toBe(200);
    expect(mockLedgerCreate).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          workspaceId: "workspace-1",
          state: "pending",
        }),
      ],
      { writeConcern: { w: "majority", wtimeout: 5000 } }
    );
    expect(mockLedgerCreate.mock.invocationCallOrder[0]).toBeLessThan(
      mockSend.mock.invocationCallOrder[0]
    );
    expect(JSON.stringify(mockLedgerCreate.mock.calls)).not.toContain("Hello");
    expect(JSON.stringify(mockLedgerCreate.mock.calls)).not.toContain("send-1");
  });

  it("replays the same operation after the workspace rotates its API key", async () => {
    const first = await POST(request());
    const firstBody = await first.json();
    mockAuthenticate.mockResolvedValue({
      apiKey: {
        id: "key-2",
        workspace_id: "workspace-1",
        permissions: { write: true },
      },
      error: null,
    });
    const replay = await POST(request());
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("never repeats an ambiguous provider send after timeout", async () => {
    mockSend.mockRejectedValueOnce(new Error("Provider response timed out"));
    const initial = await POST(request());
    expect(initial.status).toBe(502);
    expect(await initial.json()).toMatchObject({
      code: "SEND_OUTCOME_UNKNOWN",
    });
    const retry = await POST(request());
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ code: "SEND_OUTCOME_UNKNOWN" });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("does not resend a provider-accepted message when local persistence fails", async () => {
    mockSaveMessage.mockRejectedValueOnce(new Error("Mongo write interrupted"));
    expect((await POST(request())).status).toBe(502);
    expect((await POST(request())).status).toBe(409);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("keeps the original pending record as a resend barrier if recording an unknown outcome also fails", async () => {
    mockSend.mockRejectedValueOnce(new Error("Provider response timed out"));
    mockLedgerUpdate.mockRejectedValueOnce(new Error("Mongo unavailable"));
    expect((await POST(request())).status).toBe(502);
    expect((await POST(request())).status).toBe(409);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("does not resend if completion persistence fails after the message was saved", async () => {
    mockLedgerUpdate.mockRejectedValueOnce(
      new Error("Completion write interrupted")
    );
    expect((await POST(request())).status).toBe(502);
    const replay = await POST(request());
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ code: "SEND_OUTCOME_UNKNOWN" });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSaveMessage).toHaveBeenCalledTimes(1);
  });

  it("fails before sending when the durable reservation cannot be written", async () => {
    mockLedgerCreate.mockRejectedValueOnce(new Error("Mongo unavailable"));
    expect((await POST(request())).status).toBe(503);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("does not reclaim an abandoned pending send after time passes", async () => {
    const id = createHash("sha256")
      .update(JSON.stringify(["workspace-1", "messages.send", "send-1"]))
      .digest("hex");
    const payloadDigest = createHash("sha256")
      .update(JSON.stringify([conversationId, "Hello"]))
      .digest("hex");
    mockOperations.set(id, {
      _id: id,
      workspaceId: "workspace-1",
      payloadDigest,
      state: "pending",
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "SEND_OUTCOME_UNKNOWN",
    });
    expect(mockSend).not.toHaveBeenCalled();
  });
});
