const mockAppendMessageToConversationById = jest.fn();
const mockAcceptAiriConversationIngress = jest.fn();
const mockCheckRateLimit = jest.fn();
const mockConversationFindById = jest.fn();
const mockMessageCreate = jest.fn();
const mockResolveAuthorizedWidgetSource = jest.fn();
const mockUserFindOneAndUpdate = jest.fn();

jest.mock("@/lib/airi/workspace-bot-default", () => ({
  getWorkspaceCoachDefault: jest.fn(async () => true),
  getWorkspaceScenariosDefault: jest.fn(async () => true),
}));
jest.mock("@/lib/analytics", () => ({ trackWidgetEvent: jest.fn() }));
jest.mock("@/lib/conversation-messages", () => ({
  appendMessageToConversationById: (...args: unknown[]) =>
    mockAppendMessageToConversationById(...args),
}));
jest.mock("@/lib/limits/company-limits", () => ({
  buildCompanyLimitExceededBody: jest.fn(),
  ensureCompanyConversationCapacity: jest.fn(async () => ({ allowed: true })),
}));
jest.mock("@/lib/logger", () => ({
  widgetLogger: {
    error: jest.fn(),
    messageSent: jest.fn(),
    rateLimitExceeded: jest.fn(),
  },
}));
jest.mock("@/lib/media/conversation-media-analysis-jobs", () => ({
  enqueueConversationMediaAnalysis: jest.fn(async () => ({ queued: true })),
}));
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/lib/realtime/server", () => ({
  triggerRealtimeEvent: jest.fn(async () => undefined),
}));
jest.mock("@/lib/realtime-updates", () => ({
  triggerConversationRealtime: jest.fn(async () => undefined),
}));
jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));
jest.mock("@/lib/temporal/airi-direct-ingress", () => ({
  acceptAiriConversationIngress: (...args: unknown[]) =>
    mockAcceptAiriConversationIngress(...args),
}));
jest.mock("@/lib/temporal/airi-turn-context", () => ({
  buildAiriConversationIngressIntent: jest.fn(() => ({ version: 1 })),
}));
jest.mock("@/lib/widget/auto-tagger", () => ({
  generateTagsFromUrl: jest.fn(async () => []),
  inferPriorityFromUrl: jest.fn(),
  suggestCategoryFromUrl: jest.fn(),
}));
jest.mock("@/lib/widget/cors", () => ({
  handleCorsOptions: jest.fn(),
  jsonWithCors: (body: unknown, init?: ResponseInit) =>
    Response.json(body, init),
}));
jest.mock("@/lib/widget/source-context", () => ({
  resolveAuthorizedWidgetSource: (...args: unknown[]) =>
    mockResolveAuthorizedWidgetSource(...args),
}));
jest.mock("@/lib/widget/visitor-auth", () => ({
  generateVisitorToken: jest.fn(async () => "visitor-token"),
  verifyVisitorToken: jest.fn(async () => null),
}));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => mockConversationFindById(...args),
    findOne: jest.fn(),
  },
}));
jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    create: (...args: unknown[]) => mockMessageCreate(...args),
    findById: jest.fn(),
  },
}));
jest.mock("@/models/user", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: (...args: unknown[]) => mockUserFindOneAndUpdate(...args),
  },
}));
jest.mock("@icecore/shared/lib/rate-limiter", () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  createRateLimiter: jest.fn(() => ({})),
  rateLimitPresets: { widgetMessages: {} },
}));

import { POST } from "./route";

const CONVERSATION_ID = "507f1f77bcf86cd799439011";

function widgetConversation(overrides: Record<string, unknown> = {}) {
  return {
    _id: CONVERSATION_ID,
    workspaceId: "workspace-1",
    channel: "web_widget",
    sourceId: "source-1",
    visitor_id: "visitor-1",
    user: "visitor-1",
    status: "open",
    messages: [],
    ...overrides,
  };
}

function send(customerId: string, conversationId?: string) {
  return POST(
    new Request("http://localhost/api/widget/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientKey: "key-1",
        conversationId,
        mediaUrl: "https://example.com/image.jpg",
        mediaType: "image",
        metadata: { customerId, pageUrl: "https://example.com/pricing" },
      }),
    }) as Parameters<typeof POST>[0]
  );
}

describe("POST /api/widget/conversations visitor ownership", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveAuthorizedWidgetSource.mockResolvedValue({
      ok: true,
      source: {
        id: "source-1",
        workspace_id: "workspace-1",
        company_id: "company-1",
      },
      credentials: { settings: { airi_enabled: true } },
    });
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 60_000,
    });
    mockConversationFindById.mockResolvedValue(widgetConversation());
    mockUserFindOneAndUpdate.mockResolvedValue({ _id: "visitor-1" });
    mockMessageCreate.mockImplementation(async payload => ({
      ...payload,
      _id: "message-1",
    }));
    mockAppendMessageToConversationById.mockResolvedValue({ appended: true });
    mockAcceptAiriConversationIngress.mockResolvedValue({ status: "accepted" });
  });

  it("appends to the visitor's own conversation", async () => {
    const response = await send("visitor-1", CONVERSATION_ID);

    expect(response.status).toBe(200);
    expect(mockMessageCreate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["another visitor's widget conversation", widgetConversation()],
    [
      "a WhatsApp conversation in the same workspace",
      widgetConversation({
        channel: "whatsapp",
        visitor_id: null,
        user: "visitor-2",
      }),
    ],
  ])("refuses to append to %s", async (_label, conversation) => {
    mockConversationFindById.mockResolvedValue(conversation);

    const response = await send("visitor-2", CONVERSATION_ID);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Conversation not found",
    });
    expect(mockMessageCreate).not.toHaveBeenCalled();
    expect(mockAppendMessageToConversationById).not.toHaveBeenCalled();
  });

  it("updates only widget visitor profiles in this workspace", async () => {
    await send("visitor-1", CONVERSATION_ID);

    expect(mockUserFindOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: "visitor-1",
        whatsapp: { $exists: false },
        workspaceId: { $in: ["workspace-1", null] },
      },
      expect.objectContaining({ firstName: "Visitor" }),
      { upsert: true, new: true }
    );
  });

  it("leaves another customer's record untouched and still delivers", async () => {
    // The guarded filter misses that record, so the upsert hits its _id.
    mockUserFindOneAndUpdate.mockRejectedValue({ code: 11000 });

    const response = await send("visitor-1", CONVERSATION_ID);

    expect(response.status).toBe(200);
    expect(mockMessageCreate).toHaveBeenCalledTimes(1);
  });
});
