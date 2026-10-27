const mockConversationFind = jest.fn();
const mockEnsureCustomerForConversation = jest.fn();

jest.mock("@/lib/mongoose", () => jest.fn(async () => undefined));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    find: (...args: unknown[]) => mockConversationFind(...args),
  },
}));

jest.mock("@/lib/customers/service", () => ({
  ensureCustomerForConversation: (...args: unknown[]) =>
    mockEnsureCustomerForConversation(...args),
}));

import { backfillCloudApiWhatsAppContacts } from "@/lib/whatsapp/cloud-api-contact-backfill";
import connectDB from "@/lib/mongoose";

function mockConversationRows(rows: unknown[]) {
  const lean = jest.fn(async () => rows);
  const limit = jest.fn(() => ({ lean }));
  const sort = jest.fn(() => ({ limit }));
  const select = jest.fn(() => ({ sort }));
  mockConversationFind.mockReturnValue({ select });
  return { select, sort, limit, lean };
}

describe("backfillCloudApiWhatsAppContacts", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConversationRows([]);
    mockEnsureCustomerForConversation.mockResolvedValue({ _id: "customer-1" });
  });

  it("links full Cloud API WhatsApp conversations through the customer service", async () => {
    const savedCredentials: Record<string, unknown>[] = [];
    mockConversationRows([
      { _id: "conversation-1" },
      { _id: "conversation-2" },
    ]);

    const result = await backfillCloudApiWhatsAppContacts({
      sourceId: "source-1",
      workspaceId: "workspace-1",
      credentials: {
        waba_id: "waba-1",
        phone_number_id: "phone-1",
        access_token: "token-1",
        embedded_signup_flow: "cloud_api",
      },
      saveCredentials: async credentials => {
        savedCredentials.push(credentials);
      },
    });

    expect(mockConversationFind).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      channel: "whatsapp",
      sourceId: "source-1",
      $or: [{ customerId: null }, { customerId: { $exists: false } }],
    });
    expect(mockEnsureCustomerForConversation).toHaveBeenCalledTimes(2);
    expect(mockEnsureCustomerForConversation).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      linkMethod: "backfill",
      linkConfidence: 0.9,
    });
    expect(result).toEqual(
      expect.objectContaining({
        attempted: true,
        skipped: false,
        queued: false,
        mode: "inline_bounded",
        processedCount: 2,
        linkedCount: 2,
        errorCount: 0,
        hasMore: false,
        completed: true,
      })
    );
    expect(savedCredentials.at(-1)).toEqual(
      expect.objectContaining({
        cloud_contact_backfill: expect.objectContaining({
          status: "completed",
          processed_count: 2,
          linked_count: 2,
          error_count: 0,
          has_more: false,
          batch_limit: 25,
        }),
      })
    );
  });

  it("caps inline backfill to a bounded batch and reports remaining work", async () => {
    const savedCredentials: Record<string, unknown>[] = [];
    mockConversationRows(
      Array.from({ length: 26 }, (_, index) => ({
        _id: `conversation-${index + 1}`,
      }))
    );

    const result = await backfillCloudApiWhatsAppContacts({
      sourceId: "source-1",
      workspaceId: "workspace-1",
      credentials: {
        waba_id: "waba-1",
        phone_number_id: "phone-1",
        access_token: "token-1",
        embedded_signup_flow: "cloud_api",
      },
      saveCredentials: async credentials => {
        savedCredentials.push(credentials);
      },
    });

    expect(mockEnsureCustomerForConversation).toHaveBeenCalledTimes(25);
    expect(result).toEqual(
      expect.objectContaining({
        processedCount: 25,
        linkedCount: 25,
        hasMore: true,
        completed: false,
      })
    );
    expect(savedCredentials.at(-1)).toEqual(
      expect.objectContaining({
        cloud_contact_backfill: expect.objectContaining({
          status: "partial",
          processed_count: 25,
          has_more: true,
          batch_limit: 25,
        }),
      })
    );
  });

  it("skips coexistence credentials so Meta smb_app_state_sync remains the contact path", async () => {
    const saveCredentials = jest.fn();

    const result = await backfillCloudApiWhatsAppContacts({
      sourceId: "source-1",
      workspaceId: "workspace-1",
      credentials: {
        waba_id: "waba-1",
        phone_number_id: "phone-1",
        access_token: "token-1",
        embedded_signup_flow: "coexistence",
        coexistence_mode: true,
      },
      saveCredentials,
    });

    expect(result).toEqual(
      expect.objectContaining({
        attempted: false,
        skipped: true,
        queued: false,
        mode: "inline_bounded",
        reason: "coexistence",
        hasMore: false,
        completed: false,
      })
    );
    expect(mockConversationFind).not.toHaveBeenCalled();
    expect(saveCredentials).not.toHaveBeenCalled();
  });

  it("records an actionable failure instead of leaving an import running when Mongo is unavailable", async () => {
    (connectDB as jest.Mock).mockRejectedValueOnce(
      new Error("Mongo unavailable")
    );
    const saveCredentials = jest.fn();
    const result = await backfillCloudApiWhatsAppContacts({
      sourceId: "source-1",
      workspaceId: "workspace-1",
      credentials: {
        phone_number_id: "phone-1",
        access_token: "token-1",
        embedded_signup_flow: "cloud_api",
      },
      saveCredentials,
    });

    expect(result).toMatchObject({
      attempted: true,
      skipped: false,
      completed: false,
      error: "Mongo unavailable",
      errorCount: 1,
    });
    expect(result.actionable).toContain("retried independently");
    expect(saveCredentials).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cloud_contact_backfill: expect.objectContaining({
          status: "failed",
          last_error: "Mongo unavailable",
        }),
      })
    );
    expect(mockConversationFind).not.toHaveBeenCalled();
  });

  it("returns incomplete work if credential persistence also fails", async () => {
    const saveCredentials = jest
      .fn()
      .mockRejectedValue(new Error("Credential store unavailable"));
    const result = await backfillCloudApiWhatsAppContacts({
      sourceId: "source-1",
      workspaceId: "workspace-1",
      credentials: {},
      saveCredentials,
    });

    expect(result).toMatchObject({
      attempted: true,
      completed: false,
      error: "Credential store unavailable",
    });
    expect(mockConversationFind).not.toHaveBeenCalled();
  });
});
