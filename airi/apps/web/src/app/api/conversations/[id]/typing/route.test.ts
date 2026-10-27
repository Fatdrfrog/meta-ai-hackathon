const mockConnectDB = jest.fn(async () => undefined);
const mockConversationFindById = jest.fn() as jest.Mock;
const mockGetHiddenConversationPlanGateResponse = jest.fn(
  async (_supabase: unknown, _workspaceId: string, _conversationId: string) =>
    null
);
const mockGetSupabaseRouteAuth = jest.fn(async (_request: Request) => ({
  supabase: {},
  user: { id: "manager_1" },
}));
const mockIsSupabaseRouteAuthError = jest.fn((_value: unknown) => false);
const mockMessageFindOne = jest.fn() as jest.Mock;
const mockResolveWhatsAppSendContext = jest.fn(async (_params: unknown) => ({
  phoneNumberId: "phone_1",
  accessToken: "token_1",
}));
const mockSendWhatsappTypingIndicator = jest.fn(
  async (_phoneNumberId: string, _accessToken: string, _messageId: string) => ({
    success: true,
  })
);
const mockVerifyWorkspaceAccess = jest.fn(
  async (_supabase: unknown, _userId: string, _workspaceId: string) => true
);

jest.mock("@/lib/limits/company-limits", () => ({
  getHiddenConversationPlanGateResponse: (
    supabase: unknown,
    workspaceId: string,
    conversationId: string
  ) =>
    mockGetHiddenConversationPlanGateResponse(
      supabase,
      workspaceId,
      conversationId
    ),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: () => mockConnectDB(),
}));

jest.mock("@/lib/sources/utils", () => ({
  verifyWorkspaceAccess: (
    supabase: unknown,
    userId: string,
    workspaceId: string
  ) => mockVerifyWorkspaceAccess(supabase, userId, workspaceId),
}));

jest.mock("@/lib/supabase/route-auth", () => ({
  getSupabaseRouteAuth: (request: Request) => mockGetSupabaseRouteAuth(request),
  isSupabaseRouteAuthError: (value: unknown) =>
    mockIsSupabaseRouteAuthError(value),
}));

jest.mock("@/lib/whatsapp", () => ({
  sendWhatsappTypingIndicator: (
    phoneNumberId: string,
    accessToken: string,
    messageId: string
  ) => mockSendWhatsappTypingIndicator(phoneNumberId, accessToken, messageId),
}));

jest.mock("@/lib/whatsapp/send-context", () => ({
  resolveWhatsAppSendContext: (params: unknown) =>
    mockResolveWhatsAppSendContext(params),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (id: string) => mockConversationFindById(id),
  },
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    findOne: (query: unknown) => mockMessageFindOne(query),
  },
}));

import { POST } from "./route";

function mockConversation(conversation: unknown) {
  mockConversationFindById.mockReturnValue({
    select: jest.fn(() => ({
      lean: jest.fn(async () => conversation),
    })),
  });
}

function mockLatestInboundMessage(message: unknown) {
  mockMessageFindOne.mockReturnValue({
    sort: jest.fn(() => ({
      select: jest.fn(() => ({
        lean: jest.fn(async () => message),
      })),
    })),
  });
}

function buildRequest() {
  return new Request("https://app.airi.chat/api/conversations/conv_1/typing", {
    method: "POST",
  });
}

describe("POST /api/conversations/[id]/typing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSupabaseRouteAuth.mockResolvedValue({
      supabase: {},
      user: { id: "manager_1" },
    });
    mockConversation({
      _id: "conv_1",
      workspaceId: "workspace_1",
      channel: "whatsapp",
      sourceId: "source_1",
    });
    mockResolveWhatsAppSendContext.mockResolvedValue({
      phoneNumberId: "phone_1",
      accessToken: "token_1",
    });
    mockLatestInboundMessage({ messageId: "ws_wamid.inbound_1" });
  });

  it("sends a WhatsApp typing indicator for the latest inbound message", async () => {
    const response = await POST(buildRequest(), {
      params: Promise.resolve({ id: "conv_1" }),
    });

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      sent: true,
    });
    expect(mockVerifyWorkspaceAccess).toHaveBeenCalledWith(
      {},
      "manager_1",
      "workspace_1"
    );
    expect(mockResolveWhatsAppSendContext).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      sourceId: "source_1",
    });
    expect(mockSendWhatsappTypingIndicator).toHaveBeenCalledWith(
      "phone_1",
      "token_1",
      "ws_wamid.inbound_1"
    );
  });

  it("does not call Meta when there is no recent inbound WhatsApp message", async () => {
    mockLatestInboundMessage(null);

    const response = await POST(buildRequest(), {
      params: Promise.resolve({ id: "conv_1" }),
    });

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      sent: false,
      reason: "no_recent_inbound_message",
    });
    expect(mockSendWhatsappTypingIndicator).not.toHaveBeenCalled();
  });
});
