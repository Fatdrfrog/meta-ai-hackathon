const mockCheckRateLimit = jest.fn();
const mockConversationFindById = jest.fn();
const mockMessageFind = jest.fn();
const mockResolveAuthorizedWidgetSource = jest.fn();
const mockVerifyVisitorToken = jest.fn();

jest.mock("@/lib/logger", () => ({ widgetLogger: { error: jest.fn() } }));
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
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
  verifyVisitorToken: (...args: unknown[]) => mockVerifyVisitorToken(...args),
}));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => mockConversationFindById(...args),
  },
}));
jest.mock("@/models/message", () => ({
  __esModule: true,
  default: { find: (...args: unknown[]) => mockMessageFind(...args) },
}));
jest.mock("@/models/user", () => ({}));
jest.mock("@icecore/shared/lib/rate-limiter", () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  createRateLimiter: jest.fn(() => ({})),
  rateLimitPresets: { widgetHistory: {} },
}));

import { NextRequest } from "next/server";
import { GET } from "./route";

const CONVERSATION_ID = "507f1f77bcf86cd799439011";
const WIDGET_CONVERSATION = {
  workspaceId: "workspace-1",
  channel: "web_widget",
  sourceId: "source-1",
  visitor_id: "visitor-1",
  user: "visitor-1",
};

function getMessages(headers: Record<string, string> = {}) {
  const request = new NextRequest(
    `https://www.airi.chat/api/widget/conversations/${CONVERSATION_ID}/messages?client_key=key-1`,
    { headers }
  );
  return GET(request, {
    params: Promise.resolve({ id: CONVERSATION_ID }),
  });
}

function mockConversation(conversation: Record<string, unknown> | null) {
  mockConversationFindById.mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(conversation),
    }),
  });
}

describe("GET /api/widget/conversations/[id]/messages", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveAuthorizedWidgetSource.mockResolvedValue({
      ok: true,
      source: { id: "source-1", workspace_id: "workspace-1" },
    });
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 20,
      remaining: 19,
    });
    mockVerifyVisitorToken.mockResolvedValue(null);
    mockConversation(WIDGET_CONVERSATION);
    mockMessageFind.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            {
              _id: "message-1",
              text: "Hello",
              direction: "inbound",
              date: new Date("2026-10-15T10:00:00.000Z"),
            },
          ]),
        }),
      }),
    });
  });

  it("returns history to the visitor that owns the conversation", async () => {
    const response = await getMessages({ "x-visitor-id": "visitor-1" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      messages: [{ id: "message-1", text: "Hello", authorName: "You" }],
    });
  });

  it("still serves older widget clients that only send a valid visitor token", async () => {
    mockVerifyVisitorToken.mockResolvedValue({
      visitorId: "visitor-1",
      workspaceId: "workspace-1",
      sourceId: "source-1",
      scope: "widget",
    });

    const response = await getMessages({ "x-visitor-token": "token" });

    expect(response.status).toBe(200);
  });

  it.each([
    ["another visitor of the same widget", { "x-visitor-id": "visitor-2" }],
    ["a caller with only the public client key", {}],
  ])("hides the conversation from %s", async (_label, headers) => {
    const response = await getMessages(headers);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Conversation not found",
    });
    expect(mockMessageFind).not.toHaveBeenCalled();
  });

  it("never serves a WhatsApp conversation through the widget key", async () => {
    mockConversation({
      ...WIDGET_CONVERSATION,
      channel: "whatsapp",
      visitor_id: null,
      user: "visitor-1",
    });

    const response = await getMessages({ "x-visitor-id": "visitor-1" });

    expect(response.status).toBe(404);
    expect(mockMessageFind).not.toHaveBeenCalled();
  });

  it("answers a missing conversation exactly like a foreign one", async () => {
    mockConversation(null);

    const response = await getMessages({ "x-visitor-id": "visitor-1" });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Conversation not found",
    });
  });

  it("rate limits the caller rather than the probed conversation id", async () => {
    await getMessages({
      "x-visitor-id": "visitor-1",
      "x-forwarded-for": "203.0.113.7, 10.0.0.1",
    });

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "source-1:203.0.113.7",
      20
    );
  });
});
