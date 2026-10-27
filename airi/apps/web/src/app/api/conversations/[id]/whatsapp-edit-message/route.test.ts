import type { NextRequest } from "next/server";

const mockCheckProfanity = jest.fn();
const mockInvalidateConversationCache = jest.fn();
const mockInvalidateRequestsForWorkspace = jest.fn();
const mockConnectDB = jest.fn();
const mockCreateClient = jest.fn();
const mockResolveWhatsAppSendContext = jest.fn();
const mockVerifyWorkspaceAccess = jest.fn();
const mockConversationFindById = jest.fn();
const mockMessageFindOne = jest.fn();
const mockMessageFindOneAndUpdate = jest.fn();
const mockUserFindById = jest.fn();
const mockEditWhatsappTextMessage = jest.fn();
const mockRealtimeTrigger = jest.fn();
const mockTriggerConversationRealtime = jest.fn();
const mockGetHiddenConversationPlanGateResponse = jest.fn();

jest.mock("@/lib/profanity", () => ({
  checkProfanity: (...args: unknown[]) => mockCheckProfanity(...args),
}));

jest.mock("@/lib/cache", () => ({
  invalidateConversationCache: (...args: unknown[]) =>
    mockInvalidateConversationCache(...args),
  invalidateRequestsForWorkspace: (...args: unknown[]) =>
    mockInvalidateRequestsForWorkspace(...args),
}));

jest.mock("@/lib/limits/company-limits", () => ({
  getHiddenConversationPlanGateResponse: (...args: unknown[]) =>
    mockGetHiddenConversationPlanGateResponse(...args),
}));
jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/observability/server-logs", () => ({
  createRequestLogger: () => ({
    start: jest.fn(),
    success: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock("@/lib/realtime/server", () => ({
  realtime: {
    trigger: (...args: unknown[]) => mockRealtimeTrigger(...args),
  },
}));

jest.mock("@/lib/realtime-updates", () => ({
  triggerConversationRealtime: (...args: unknown[]) =>
    mockTriggerConversationRealtime(...args),
}));

jest.mock("@/lib/sources/utils", () => ({
  verifyWorkspaceAccess: (...args: unknown[]) =>
    mockVerifyWorkspaceAccess(...args),
}));

jest.mock("@/lib/whatsapp/send-context", () => ({
  resolveWhatsAppSendContext: (...args: unknown[]) =>
    mockResolveWhatsAppSendContext(...args),
}));

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/whatsapp", () => ({
  editWhatsappTextMessage: (...args: unknown[]) =>
    mockEditWhatsappTextMessage(...args),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => mockConversationFindById(...args),
  },
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    findOne: (...args: unknown[]) => mockMessageFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) =>
      mockMessageFindOneAndUpdate(...args),
  },
}));

jest.mock("@/models/user", () => ({
  __esModule: true,
  default: {
    findById: (...args: unknown[]) => mockUserFindById(...args),
  },
}));

import { POST } from "./route";

const CONVERSATION_ID = "507f1f77bcf86cd799439011";
const MESSAGE_ID = "507f1f77bcf86cd799439012";

function request() {
  return new Request(
    `http://localhost/api/conversations/${CONVERSATION_ID}/whatsapp-edit-message`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messageId: MESSAGE_ID,
        text: "Edited text",
      }),
    }
  ) as unknown as NextRequest;
}

function editMessage() {
  return POST(request(), { params: Promise.resolve({ id: CONVERSATION_ID }) });
}

function mockStoredMessage(whatsappServiceMessage?: unknown) {
  mockMessageFindOne.mockReturnValue({
    lean: jest.fn(async () => ({
      _id: MESSAGE_ID,
      messageId: "wamid.provider-message",
      text: "Original text",
      date: new Date(),
      ...(whatsappServiceMessage === undefined
        ? {}
        : { whatsappServiceMessage }),
    })),
  });
}

describe("POST /api/conversations/[id]/whatsapp-edit-message", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckProfanity.mockReturnValue({ toxic: false });
    mockConnectDB.mockResolvedValue(undefined);
    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: jest.fn(async () => ({
          data: { user: { id: "manager-1" } },
        })),
      },
    });
    mockConversationFindById.mockReturnValue({
      select: jest.fn(() => ({
        lean: jest.fn(async () => ({
          _id: CONVERSATION_ID,
          workspaceId: "workspace-1",
          channel: "whatsapp",
          sourceId: "source-1",
          user: "customer-1",
        })),
      })),
    });
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockGetHiddenConversationPlanGateResponse.mockResolvedValue(null);
    mockResolveWhatsAppSendContext.mockResolvedValue({
      phoneNumberId: "phone-1",
      accessToken: "token-1",
    });
    mockUserFindById.mockReturnValue({
      select: jest.fn(() => ({
        lean: jest.fn(async () => ({
          _id: "customer-1",
          whatsapp: { waId: "77000000000" },
        })),
      })),
    });
    mockEditWhatsappTextMessage.mockResolvedValue(undefined);
    mockMessageFindOneAndUpdate.mockReturnValue({
      lean: jest.fn(async () => ({
        _id: MESSAGE_ID,
        text: "Edited text",
        editMeta: { kind: "edit", editCount: 1 },
      })),
    });
    mockRealtimeTrigger.mockResolvedValue(undefined);
    mockTriggerConversationRealtime.mockResolvedValue(undefined);
    mockInvalidateConversationCache.mockResolvedValue(undefined);
    mockInvalidateRequestsForWorkspace.mockResolvedValue(undefined);
  });

  it("edits through the conversation's own WhatsApp number", async () => {
    mockStoredMessage();

    const response = await editMessage();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      text: "Edited text",
      editMeta: { kind: "edit", editCount: 1 },
    });
    expect(mockResolveWhatsAppSendContext).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
    });
    expect(mockEditWhatsappTextMessage).toHaveBeenCalledWith(
      "phone-1",
      "token-1",
      expect.objectContaining({ value: "77000000000" }),
      "Edited text",
      "wamid.provider-message"
    );
    expect(mockMessageFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: MESSAGE_ID },
      expect.objectContaining({
        $set: expect.objectContaining({
          text: "Edited text",
          "editMeta.previousText": "Original text",
        }),
        $inc: { "editMeta.editCount": 1 },
      }),
      expect.objectContaining({ new: true })
    );
    expect(mockRealtimeTrigger).toHaveBeenCalledWith(
      `private-conversation-${CONVERSATION_ID}`,
      "message-updated",
      {
        messageId: MESSAGE_ID,
        text: "Edited text",
        editMeta: { kind: "edit", editCount: 1 },
      }
    );
  });

  it("returns the plan gate response for a hidden conversation without editing", async () => {
    const body = {
      code: "company_conversation_limit_exceeded",
      planGate: { hiddenCount: 2, reason: "trial_expired" },
    };
    mockStoredMessage();
    mockGetHiddenConversationPlanGateResponse.mockResolvedValue(
      Response.json(body, { status: 402 })
    );

    const response = await editMessage();

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toEqual(body);
    expect(mockGetHiddenConversationPlanGateResponse).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-1",
      CONVERSATION_ID
    );
    expect(mockEditWhatsappTextMessage).not.toHaveBeenCalled();
    expect(mockMessageFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("does not fall back to another workspace number when the conversation's source is unavailable", async () => {
    mockStoredMessage();
    mockResolveWhatsAppSendContext.mockResolvedValue(null);

    const response = await editMessage();

    expect(response.status).toBe(500);
    expect(mockEditWhatsappTextMessage).not.toHaveBeenCalled();
    expect(mockMessageFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("rejects canonical service-message records before calling Meta", async () => {
    const statuses: number[] = [];

    for (const whatsappServiceMessage of [
      {
        version: 1,
        kind: "media_carousel",
        command: { kind: "media_carousel", cards: [] },
      },
      {},
    ]) {
      mockStoredMessage(whatsappServiceMessage);
      const response = await editMessage();
      statuses.push(response.status);
    }

    expect(statuses).toEqual([400, 400]);
    expect(mockEditWhatsappTextMessage).not.toHaveBeenCalled();
    expect(mockMessageFindOneAndUpdate).not.toHaveBeenCalled();
  });
});
